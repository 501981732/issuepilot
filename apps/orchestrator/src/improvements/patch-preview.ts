import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ImprovementPatchPreview,
  ImprovementRecommendation,
} from "@issuepilot/shared-contracts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appendPreviewDiff(input: {
  targetPath: string;
  targetDescription: string;
  suggestedChange: string;
}): string {
  return [
    `--- ${input.targetPath}`,
    `+++ ${input.targetPath} (preview)`,
    `@@ ${input.targetDescription} @@`,
    `+ ${input.suggestedChange}`,
    "",
  ].join("\n");
}

export async function generatePatchPreview(input: {
  recommendation: ImprovementRecommendation;
  now?: () => Date;
}): Promise<ImprovementPatchPreview> {
  const now = input.now ?? (() => new Date());
  const targetPath = input.recommendation.target.path;
  if (!targetPath) {
    return {
      status: "blocked",
      targetDescription: input.recommendation.target.description,
      blockedReason: "target_path_missing",
    };
  }

  let body: string;
  try {
    body = await readFile(targetPath, "utf8");
  } catch {
    return {
      status: "blocked",
      targetPath,
      targetDescription: input.recommendation.target.description,
      blockedReason: "target_file_unreadable",
    };
  }

  const currentHash = sha256(body);
  const snapshot = input.recommendation.patchPreview.sourceSnapshot;
  if (
    input.recommendation.patchPreview.status === "generated" &&
    snapshot &&
    snapshot.sha256 !== currentHash
  ) {
    return {
      ...input.recommendation.patchPreview,
      status: "stale",
      blockedReason: "source_snapshot_mismatch",
    };
  }

  return {
    status: "generated",
    targetPath,
    targetDescription: input.recommendation.target.description,
    sourceSnapshot: {
      targetPath,
      sha256: currentHash,
      capturedAt: now().toISOString(),
    },
    diff: appendPreviewDiff({
      targetPath,
      targetDescription: input.recommendation.target.description,
      suggestedChange: input.recommendation.suggestedChange,
    }),
    rollbackNotes:
      "Do not apply this preview automatically. If applied manually, remove the added line to roll back.",
  };
}
