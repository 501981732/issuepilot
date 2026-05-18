import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ReportEvidence } from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanRunEvidence } from "../evidence-scanner.js";

describe("scanRunEvidence", () => {
  let taskWorktreePath: string;

  beforeEach(async () => {
    taskWorktreePath = await mkdtemp(join(tmpdir(), "issuepilot-evidence-"));
  });

  afterEach(async () => {
    await rm(taskWorktreePath, { recursive: true, force: true });
  });

  const evidenceRoot = (runId = "run-1") =>
    join(taskWorktreePath, ".issuepilot", "evidence", runId);

  const writeEvidenceFile = async (
    relPath: string,
    body = "evidence",
    runId = "run-1",
  ) => {
    const filePath = join(evidenceRoot(runId), relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  };

  it("returns empty when no evidence dir exists", async () => {
    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "missing-run" }),
    ).resolves.toEqual({
      entries: [],
      oversized: [],
      rejected: [],
      manifestUsed: false,
    });
  });

  it("infers screenshot evidence from screenshots/*.png", async () => {
    await writeEvidenceFile("screenshots/login.png");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "screenshot",
          label: "login.png",
          relPath: "screenshots/login.png",
          mediaType: "image/png",
        },
      ],
    });
  });

  it("infers playwright evidence from playwright/*-trace.zip", async () => {
    await writeEvidenceFile("playwright/login-trace.zip");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "playwright",
          label: "login-trace.zip",
          relPath: "playwright/login-trace.zip",
        },
      ],
    });
  });

  it("infers recording evidence from recordings/*.mp4, *.webm, and *.mov", async () => {
    await writeEvidenceFile("recordings/demo.mp4");
    await writeEvidenceFile("recordings/demo.webm");
    await writeEvidenceFile("recordings/demo.mov");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "recording",
          label: "demo.mov",
          relPath: "recordings/demo.mov",
          mediaType: "video/quicktime",
        },
        {
          kind: "recording",
          label: "demo.mp4",
          relPath: "recordings/demo.mp4",
          mediaType: "video/mp4",
        },
        {
          kind: "recording",
          label: "demo.webm",
          relPath: "recordings/demo.webm",
          mediaType: "video/webm",
        },
      ],
    });
  });

  it("infers command_output evidence from commands/*.log", async () => {
    await writeEvidenceFile("commands/pnpm-test.log");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "command_output",
          label: "pnpm-test.log",
          relPath: "commands/pnpm-test.log",
        },
      ],
    });
  });

  it("infers test_result evidence from tests/*.json", async () => {
    await writeEvidenceFile("tests/vitest.json", "{}");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toMatchObject({
      entries: [
        {
          kind: "test_result",
          label: "vitest.json",
          relPath: "tests/vitest.json",
        },
      ],
    });
  });

  it("prefers manifest.json over directory inference", async () => {
    await writeEvidenceFile("screenshots/inferred.png");
    const manifestEntry: ReportEvidence = {
      kind: "recording",
      label: "Manifest video",
      relPath: "recordings/demo.webm",
      mediaType: "video/webm",
    };
    await writeEvidenceFile(
      "manifest.json",
      JSON.stringify({ entries: [manifestEntry] }),
    );

    const result = await scanRunEvidence({ taskWorktreePath, runId: "run-1" });

    expect(result.manifestUsed).toBe(true);
    expect(result.entries).toEqual([manifestEntry]);
  });

  it("flags oversized files instead of returning them", async () => {
    await writeEvidenceFile("screenshots/big.png", "12345");

    await expect(
      scanRunEvidence({
        taskWorktreePath,
        runId: "run-1",
        oversizedLimitBytes: 4,
      }),
    ).resolves.toEqual({
      entries: [],
      oversized: [{ relPath: "screenshots/big.png", sizeBytes: 5 }],
      rejected: [],
      manifestUsed: false,
    });
  });

  it("rejects manifest entries with relPath escaping the evidence dir", async () => {
    await writeEvidenceFile(
      "manifest.json",
      JSON.stringify({
        entries: [
          {
            kind: "screenshot",
            label: "escape",
            relPath: "../escape.png",
          },
          {
            kind: "command_output",
            label: "safe",
            relPath: "commands/safe.log",
          },
        ],
      }),
    );

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toEqual({
      entries: [
        {
          kind: "command_output",
          label: "safe",
          relPath: "commands/safe.log",
        },
      ],
      oversized: [],
      rejected: [{ relPath: "../escape.png", reason: "path-escape" }],
      manifestUsed: true,
    });
  });

  it("uses manifest entries while still scanning directories for oversized files", async () => {
    const manifestEntry: ReportEvidence = {
      kind: "screenshot",
      label: "Manifest screenshot",
      relPath: "screenshots/from-manifest.png",
      mediaType: "image/png",
    };
    await writeEvidenceFile(
      "manifest.json",
      JSON.stringify({ entries: [manifestEntry] }),
    );
    await writeEvidenceFile("screenshots/inferred.png", "ok");
    await writeEvidenceFile("commands/too-large.log", "12345");

    const result = await scanRunEvidence({
      taskWorktreePath,
      runId: "run-1",
      oversizedLimitBytes: 4,
    });

    expect(result).toEqual({
      entries: [manifestEntry],
      oversized: [{ relPath: "commands/too-large.log", sizeBytes: 5 }],
      rejected: [],
      manifestUsed: true,
    });
  });

  it("canonicalizes manifest relPath before returning and oversized filtering", async () => {
    await writeEvidenceFile("commands/safe.log", "ok");
    await writeEvidenceFile("commands/too-large.log", "12345");
    await writeEvidenceFile(
      "manifest.json",
      JSON.stringify({
        entries: [
          {
            kind: "command_output",
            label: "safe",
            relPath: "screenshots/../commands/safe.log",
          },
          {
            kind: "command_output",
            label: "too large",
            relPath: "screenshots/../commands/too-large.log",
          },
        ],
      }),
    );

    await expect(
      scanRunEvidence({
        taskWorktreePath,
        runId: "run-1",
        oversizedLimitBytes: 4,
      }),
    ).resolves.toEqual({
      entries: [
        {
          kind: "command_output",
          label: "safe",
          relPath: "commands/safe.log",
        },
      ],
      oversized: [{ relPath: "commands/too-large.log", sizeBytes: 5 }],
      rejected: [],
      manifestUsed: true,
    });
  });

  it("ignores malformed manifest JSON without crashing", async () => {
    await writeEvidenceFile("manifest.json", "{not valid json");

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toEqual({
      entries: [],
      oversized: [],
      rejected: [],
      manifestUsed: true,
    });
  });

  it("ignores invalid manifest entries without propagating bad data", async () => {
    await writeEvidenceFile(
      "manifest.json",
      JSON.stringify({
        entries: [
          null,
          { kind: "not-real", label: "bad kind", relPath: "x.log" },
          { kind: "screenshot", label: 123, relPath: "screenshots/a.png" },
          { kind: "command_output", label: "bad rel", relPath: 42 },
          {
            kind: "test_result",
            label: "valid",
            relPath: "tests/result.json",
            mediaType: "application/json",
          },
        ],
      }),
    );

    await expect(
      scanRunEvidence({ taskWorktreePath, runId: "run-1" }),
    ).resolves.toEqual({
      entries: [
        {
          kind: "test_result",
          label: "valid",
          relPath: "tests/result.json",
          mediaType: "application/json",
        },
      ],
      oversized: [],
      rejected: [],
      manifestUsed: true,
    });
  });

  it("caps manifest entries at 1000 to avoid OOM and reports overflow", async () => {
    const limit = 1000;
    const entries = Array.from({ length: limit + 5 }, (_, idx) => ({
      kind: "command_output" as const,
      label: `entry-${idx}`,
    }));
    await writeEvidenceFile("manifest.json", JSON.stringify({ entries }));

    const result = await scanRunEvidence({ taskWorktreePath, runId: "run-1" });
    expect(result.manifestUsed).toBe(true);
    expect(result.entries).toHaveLength(limit);
    expect(result.entries[0].label).toBe("entry-0");
    expect(result.entries[result.entries.length - 1].label).toBe(
      `entry-${limit - 1}`,
    );
    expect(result.rejected).toEqual([
      {
        relPath: `manifest.json[${limit}..${limit + 4}]`,
        reason: "manifest-overflow",
      },
    ]);
  });
});
