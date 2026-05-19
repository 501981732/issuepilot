import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as pathResolve, sep } from "node:path";

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

/**
 * Returns true if `candidate` lives under any of the configured allowed
 * prefixes. A prefix matches when the resolved candidate path equals the
 * prefix or begins with `<prefix><path.sep>`, which avoids false positives
 * like `/var/foo/.issuepilot-other` matching prefix `/var/foo/.issuepilot`.
 */
function isInsideAllowedPrefix(
  candidate: string,
  allowedPrefixes: string[],
): boolean {
  const resolvedCandidate = pathResolve(candidate);
  for (const prefix of allowedPrefixes) {
    const resolvedPrefix = pathResolve(prefix);
    if (resolvedCandidate === resolvedPrefix) return true;
    if (resolvedCandidate.startsWith(resolvedPrefix + sep)) return true;
  }
  return false;
}

export async function generatePatchPreview(input: {
  recommendation: ImprovementRecommendation;
  now?: () => Date;
  /**
   * When provided, the inert patch preview will only read files whose
   * resolved absolute path falls inside one of these prefixes. Anything
   * outside surfaces as `blocked: target_outside_sandbox` so that a
   * tampered recommendation file (or a future code path that lets the
   * operator influence `target.path`) cannot trick the orchestrator into
   * reading credentials or arbitrary files. Pass `undefined` only for
   * tests / one-off scripts where the caller already controls the path.
   */
  allowedPathPrefixes?: string[];
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

  if (
    input.allowedPathPrefixes &&
    !isInsideAllowedPrefix(targetPath, input.allowedPathPrefixes)
  ) {
    return {
      status: "blocked",
      targetPath,
      targetDescription: input.recommendation.target.description,
      blockedReason: "target_outside_sandbox",
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
