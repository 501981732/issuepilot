import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createInitialReport } from "../lifecycle.js";
import { createReportStore } from "../store.js";

describe("report store", () => {
  it("persists reports as redacted JSON files and lists summaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
    try {
      const store = createReportStore({ rootDir: root });
      const report = createInitialReport({
        runId: "run-1",
        issue: {
          id: "issue-42",
          iid: 42,
          title: "Fix checkout",
          url: "https://gitlab.example.com/issues/42",
          projectId: "group/project",
          labels: ["ai-running"],
        },
        status: "running",
        attempt: 1,
        branch: "ai/42-fix-checkout",
        workspacePath: "/tmp/ws",
        startedAt: "2026-05-16T00:00:00.000Z",
      });

      await store.save(report);

      expect(await store.get("run-1")).toEqual(report);
      expect(store.summary("run-1")?.issueIid).toBe(42);
      expect(store.allSummaries()).toHaveLength(1);

      const body = await readFile(join(root, "reports", "run-1.json"), "utf8");
      expect(JSON.parse(body).runId).toBe("run-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists full report artifacts from memory and disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
    try {
      const store = createReportStore({ rootDir: root });
      const report = createInitialReport({
        runId: "run-3",
        issue: {
          iid: 1,
          title: "Issue",
          url: "https://gitlab.example/1",
          projectId: "proj-a",
          labels: ["human-review"],
        },
        status: "completed",
        attempt: 1,
        branch: "issuepilot/1",
        workspacePath: root,
        startedAt: "2026-05-18T00:00:00.000Z",
      });
      await store.save(report);

      await expect(store.all()).resolves.toEqual([report]);
      const fresh = createReportStore({ rootDir: root });
      await expect(fresh.all()).resolves.toEqual([report]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts invalid report JSON files skipped during full artifact load", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
    try {
      const store = createReportStore({ rootDir: root });
      await mkdir(join(root, "reports"), { recursive: true });
      await writeFile(join(root, "reports", "broken.json"), "{", "utf8");

      await expect(store.all()).resolves.toEqual([]);
      expect(store.invalidReportCount()).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads reports from disk on cache miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
    try {
      const store = createReportStore({ rootDir: root });
      const report = createInitialReport({
        runId: "run-2",
        issue: {
          iid: 7,
          title: "Other",
          url: "https://gitlab.example.com/issues/7",
          projectId: "group/other",
          labels: ["human-review"],
        },
        status: "completed",
        attempt: 1,
        branch: "ai/7-other",
        workspacePath: "/tmp/ws2",
        startedAt: "2026-05-16T00:00:00.000Z",
      });
      await store.save(report);

      const fresh = createReportStore({ rootDir: root });
      expect(await fresh.get("run-2")).toEqual(report);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
