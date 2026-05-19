import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { generatePatchPreview } from "../patch-preview.js";

function rec(
  over: Partial<ImprovementRecommendation> = {},
): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: {
      kind: "prompt_template",
      path: "/tmp/WORKFLOW.md",
      description: "Prompt template",
    },
    evidenceRefs: [],
    suggestedChange: "Require command output or screenshot evidence.",
    patchPreview: {
      status: "not_generated",
      targetDescription: "Prompt template",
    },
    confidence: "high",
    risk: "low",
    status: "accepted",
    actionHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

describe("generatePatchPreview", () => {
  it("generates a diff and source snapshot without writing the target file", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const targetPath = join(root, "WORKFLOW.md");
    const original = "---\nagent:\n  max_attempts: 2\n---\nRun the task.\n";
    await writeFile(targetPath, original, "utf8");

    const preview = await generatePatchPreview({
      recommendation: rec({
        target: {
          kind: "prompt_template",
          path: targetPath,
          description: "Prompt template",
        },
      }),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(preview.status).toBe("generated");
    expect(preview.targetPath).toBe(targetPath);
    expect(preview.sourceSnapshot?.sha256).toHaveLength(64);
    expect(preview.diff).toContain("+ Require command output or screenshot evidence.");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(original);
  });

  it("blocks when the target path is missing", async () => {
    const preview = await generatePatchPreview({
      recommendation: rec({
        target: { kind: "prompt_template", description: "Prompt template" },
      }),
    });

    expect(preview).toMatchObject({
      status: "blocked",
      blockedReason: "target_path_missing",
    });
  });

  it("blocks when the target path falls outside the allowed sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const outside = await mkdtemp(join(tmpdir(), "issuepilot-other-"));
    const targetPath = join(outside, "ESCAPE.md");
    await writeFile(targetPath, "noop\n", "utf8");

    const preview = await generatePatchPreview({
      recommendation: rec({
        target: {
          kind: "prompt_template",
          path: targetPath,
          description: "Outside sandbox",
        },
      }),
      allowedPathPrefixes: [root],
    });

    expect(preview).toMatchObject({
      status: "blocked",
      blockedReason: "target_outside_sandbox",
      targetPath,
    });
  });

  it("allows reads inside the sandbox when prefixes are configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const targetPath = join(root, "AGENTS.md");
    await writeFile(targetPath, "rules\n", "utf8");

    const preview = await generatePatchPreview({
      recommendation: rec({
        target: {
          kind: "project_rules",
          path: targetPath,
          description: "Project rules",
        },
      }),
      allowedPathPrefixes: [root],
    });

    expect(preview.status).toBe("generated");
    expect(preview.targetPath).toBe(targetPath);
  });

  it("marks existing generated previews stale when the source hash changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const targetPath = join(root, "WORKFLOW.md");
    await writeFile(targetPath, "first\n", "utf8");
    const generated = await generatePatchPreview({
      recommendation: rec({
        target: {
          kind: "prompt_template",
          path: targetPath,
          description: "Prompt template",
        },
      }),
    });
    await writeFile(targetPath, "second\n", "utf8");

    const stale = await generatePatchPreview({
      recommendation: rec({
        target: {
          kind: "prompt_template",
          path: targetPath,
          description: "Prompt template",
        },
        patchPreview: generated,
      }),
    });

    expect(stale.status).toBe("stale");
    expect(stale.blockedReason).toBe("source_snapshot_mismatch");
  });
});
