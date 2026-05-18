import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { serveEvidenceFile } from "../evidence-file-server.js";

describe("serveEvidenceFile", () => {
  let taskWorktreePath: string;

  beforeEach(async () => {
    taskWorktreePath = await mkdtemp(
      path.join(tmpdir(), "issuepilot-evidence-file-"),
    );
  });

  afterEach(async () => {
    await rm(taskWorktreePath, { recursive: true, force: true });
  });

  const evidenceRoot = (runId = "run-1") =>
    path.join(taskWorktreePath, ".issuepilot", "evidence", runId);

  const writeEvidenceFile = async (
    relPath: string,
    body = "evidence",
    runId = "run-1",
  ) => {
    const filePath = path.join(evidenceRoot(runId), relPath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
    return filePath;
  };

  it("returns absPath, mediaType, and sizeBytes for a file inside the run evidence root", async () => {
    const absPath = await writeEvidenceFile("commands/output.log", "abc123");

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "commands/output.log",
      }),
    ).resolves.toEqual({
      ok: true,
      absPath,
      mediaType: "text/plain",
      sizeBytes: 6,
    });
  });

  it("returns forbidden when relPath escapes via ../../", async () => {
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "../../outside.txt",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns forbidden when relPath is an absolute path outside the evidence root", async () => {
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: path.join(tmpdir(), "outside.txt"),
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns forbidden when runId escapes the evidence base", async () => {
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "../outside-run",
        relPath: "screenshots/login.png",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns forbidden when relPath is empty and resolves to the evidence root", async () => {
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns not_found when file does not exist", async () => {
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "screenshots/missing.png",
      }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
  });

  it("returns not_found when relPath points to a directory", async () => {
    await mkdir(path.join(evidenceRoot(), "screenshots"), { recursive: true });

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "screenshots",
      }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
  });

  it("returns forbidden when relPath points to a symlink", async () => {
    const outsidePath = path.join(taskWorktreePath, "secret.txt");
    await writeFile(outsidePath, "secret");
    const linkPath = path.join(evidenceRoot(), "commands", "secret.log");
    await mkdir(path.dirname(linkPath), { recursive: true });
    await symlink(outsidePath, linkPath);

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "commands/secret.log",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
  });

  it("returns forbidden when the runId directory itself is a symlink to outside the worktree", async () => {
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "issuepilot-evidence-outside-"),
    );
    try {
      await writeFile(path.join(outsideDir, "passwd"), "root:x:0:0");
      const evidenceBase = path.join(
        taskWorktreePath,
        ".issuepilot",
        "evidence",
      );
      await mkdir(evidenceBase, { recursive: true });
      await symlink(outsideDir, path.join(evidenceBase, "run-symlink"));

      await expect(
        serveEvidenceFile({
          taskWorktreePath,
          runId: "run-symlink",
          relPath: "passwd",
        }),
      ).resolves.toEqual({ ok: false, error: "forbidden" });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns forbidden when the .issuepilot directory is a symlink to outside the worktree", async () => {
    const outsideDir = await mkdtemp(
      path.join(tmpdir(), "issuepilot-evidence-outside-"),
    );
    try {
      const fakeEvidence = path.join(outsideDir, "evidence", "run-1");
      await mkdir(fakeEvidence, { recursive: true });
      await writeFile(path.join(fakeEvidence, "leak.txt"), "leak");
      await symlink(outsideDir, path.join(taskWorktreePath, ".issuepilot"));

      await expect(
        serveEvidenceFile({
          taskWorktreePath,
          runId: "run-1",
          relPath: "leak.txt",
        }),
      ).resolves.toEqual({ ok: false, error: "forbidden" });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("returns oversized when file size is greater than 50MB", async () => {
    const absPath = await writeEvidenceFile("recordings/big.mp4", "");
    await truncate(absPath, 50 * 1024 * 1024 + 1);

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "recordings/big.mp4",
      }),
    ).resolves.toEqual({ ok: false, error: "oversized" });
  });

  it("infers image/png for .png files", async () => {
    const absPath = await writeEvidenceFile("screenshots/login.png", "png");

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "screenshots/login.png",
      }),
    ).resolves.toEqual({
      ok: true,
      absPath,
      mediaType: "image/png",
      sizeBytes: 3,
    });
  });

  it("infers video/mp4 for .mp4 files", async () => {
    const absPath = await writeEvidenceFile("recordings/demo.mp4", "mp4");

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "recordings/demo.mp4",
      }),
    ).resolves.toEqual({
      ok: true,
      absPath,
      mediaType: "video/mp4",
      sizeBytes: 3,
    });
  });

  it("infers video/quicktime for .mov files", async () => {
    const absPath = await writeEvidenceFile("recordings/demo.mov", "mov");

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "recordings/demo.mov",
      }),
    ).resolves.toEqual({
      ok: true,
      absPath,
      mediaType: "video/quicktime",
      sizeBytes: 3,
    });
  });

  it("treats query strings as part of the filesystem path", async () => {
    await writeEvidenceFile("screenshots/login.png", "png");

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run-1",
        relPath: "screenshots/login.png?download=1",
      }),
    ).resolves.toEqual({ ok: false, error: "not_found" });
  });
});
