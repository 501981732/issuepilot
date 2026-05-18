import type { FailurePatternId } from "@issuepilot/shared-contracts";

import type {
  QualityRunSourceItem,
  QualitySourceItem,
  QualityTaskSourceItem,
} from "./types.js";

export interface ClassifiedPattern {
  patternId: FailurePatternId;
  reason: string;
}

const PERMISSION_KEYWORDS = [
  "token",
  "credential",
  "permission",
  "401",
  "403",
  "access denied",
  "unauthorized",
];

const ENVIRONMENT_KEYWORDS = [
  "workspace",
  "mirror",
  "dependency",
  "install",
  "runner",
  "codex app-server",
  "network",
  "timeout",
  "dns",
];

const UNCLEAR_KEYWORDS = [
  "acceptance criteria",
  "insufficient context",
  "scope unclear",
  "需求不清",
  "验收标准",
];

function matchKeyword(haystack: string, needles: string[]): string | undefined {
  const lc = haystack.toLowerCase();
  return needles.find((needle) => lc.includes(needle.toLowerCase()));
}

function runErrorText(item: QualityRunSourceItem): string {
  return [item.lastError?.code, item.lastError?.message]
    .filter((value): value is string => Boolean(value))
    .join(" \n ");
}

function taskReasonText(item: QualityTaskSourceItem): string {
  return [item.needsReworkReason, item.taskTitle, item.workItemTitle]
    .filter((value): value is string => Boolean(value))
    .join(" \n ");
}

function dedupePatterns(patterns: ClassifiedPattern[]): ClassifiedPattern[] {
  const seen = new Map<FailurePatternId, ClassifiedPattern>();
  for (const pattern of patterns) {
    if (!seen.has(pattern.patternId)) {
      seen.set(pattern.patternId, pattern);
    }
  }
  return [...seen.values()];
}

function classifyRun(item: QualityRunSourceItem): ClassifiedPattern[] {
  const patterns: ClassifiedPattern[] = [];
  const errorText = runErrorText(item);

  if (errorText) {
    const permissionHit = matchKeyword(errorText, PERMISSION_KEYWORDS);
    if (permissionHit) {
      patterns.push({
        patternId: "permission-issue",
        reason:
          item.lastError?.message ?? `permission keyword: ${permissionHit}`,
      });
    }
    const environmentHit = matchKeyword(errorText, ENVIRONMENT_KEYWORDS);
    if (environmentHit) {
      patterns.push({
        patternId: "environment-issue",
        reason:
          item.lastError?.message ?? `environment keyword: ${environmentHit}`,
      });
    }
    const unclearHit = matchKeyword(errorText, UNCLEAR_KEYWORDS);
    if (unclearHit) {
      patterns.push({
        patternId: "unclear-requirements",
        reason: item.lastError?.message ?? `requirement keyword: ${unclearHit}`,
      });
    }
  }

  const checks = item.checks ?? [];
  const allUnknownOrSkipped =
    checks.length > 0 &&
    checks.every(
      (check) => check.status === "unknown" || check.status === "skipped",
    );
  if (checks.length === 0 || allUnknownOrSkipped) {
    patterns.push({
      patternId: "missing-tests",
      reason:
        checks.length === 0
          ? "no checks reported"
          : "all checks are unknown or skipped",
    });
  }

  if (item.ciStatus === "failed" || item.ciStatus === "canceled") {
    patterns.push({
      patternId: "ci-failure",
      reason: `CI ${item.ciStatus}`,
    });
  }

  if ((item.reviewFeedback?.unresolvedCount ?? 0) > 0) {
    patterns.push({
      patternId: "review-rework",
      reason: `${item.reviewFeedback?.unresolvedCount} unresolved review comments`,
    });
  }

  return patterns;
}

function classifyTask(item: QualityTaskSourceItem): ClassifiedPattern[] {
  const patterns: ClassifiedPattern[] = [];
  const reasonText = taskReasonText(item);

  if (item.needsReworkReason) {
    const unclearHit = matchKeyword(item.needsReworkReason, UNCLEAR_KEYWORDS);
    if (unclearHit) {
      patterns.push({
        patternId: "unclear-requirements",
        reason: item.needsReworkReason,
      });
    }
    const permissionHit = matchKeyword(
      item.needsReworkReason,
      PERMISSION_KEYWORDS,
    );
    if (permissionHit) {
      patterns.push({
        patternId: "permission-issue",
        reason: item.needsReworkReason,
      });
    }
    const environmentHit = matchKeyword(
      item.needsReworkReason,
      ENVIRONMENT_KEYWORDS,
    );
    if (environmentHit) {
      patterns.push({
        patternId: "environment-issue",
        reason: item.needsReworkReason,
      });
    }
  }

  if (
    item.taskStatus === "needs_rework" ||
    item.needsReworkReason !== undefined
  ) {
    patterns.push({
      patternId: "review-rework",
      reason: item.needsReworkReason ?? "task marked needs_rework",
    });
  }

  if (item.trustedValidationEvidenceCount === 0) {
    patterns.push({
      patternId: "missing-tests",
      reason:
        item.aiClaimValidationEvidenceCount > 0
          ? "validation evidence is only AI-claimed"
          : "no trusted validation/test/screenshot/command evidence",
    });
  }

  if (
    item.checklistReasons.includes("missing-evidence") ||
    item.reportStatus === "incomplete" ||
    item.validationEvidenceCount === 0
  ) {
    patterns.push({
      patternId: "missing-evidence",
      reason: item.checklistReasons.includes("missing-evidence")
        ? "human review checklist: missing-evidence"
        : item.reportStatus === "incomplete"
          ? "work item report incomplete"
          : "no validation/test/screenshot/command evidence recorded for task",
    });
  }

  // unclear-requirements may also come from non-error reason text
  if (!item.needsReworkReason) {
    const unclearHit = matchKeyword(reasonText, UNCLEAR_KEYWORDS);
    if (unclearHit) {
      patterns.push({
        patternId: "unclear-requirements",
        reason: `requirement keyword: ${unclearHit}`,
      });
    }
  }

  return patterns;
}

/**
 * Deterministic V4.4 failure pattern classifier. The classifier never calls an
 * LLM and uses stable string matching so dashboards and audits get repeatable
 * results across runs of the orchestrator on the same inputs.
 */
export function classifyQualityPatterns(
  item: QualitySourceItem,
): ClassifiedPattern[] {
  const patterns = item.kind === "run" ? classifyRun(item) : classifyTask(item);
  return dedupePatterns(patterns);
}
