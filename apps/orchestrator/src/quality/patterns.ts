import type {
  AgentReport,
  FailurePatternId,
  LastErrorCode,
  ReviewerDecision,
} from "@issuepilot/shared-contracts";

import { toFailurePatternId } from "../pipelines/failure-mapping.js";
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

/**
 * V4.6 增量分类器（spec §17.4 / plan Task 10.1）。给定一个最新的
 * AgentReport，结合 `pipelines/failure-mapping.ts` 的单一 truth source 表，
 * 输出对应的 V4.6 FailurePatternId。
 *
 * - 输入的 AgentReport 状态可能是 `failed` / `cancelled` / `incomplete` /
 *   `complete`。
 * - reviewer `complete` + `decision = "request_changes"` 单独映射到
 *   `reviewer_requested_changes`（哪怕没有 lastError）。
 * - reviewer / test_evidence `incomplete` + `lastError.code` 与 `failed`
 *   走同一映射；没有 lastError 的 incomplete（如 evidence partial 但 collector
 *   主动写 `incomplete`）映射到 `evidence_partial`。
 * - `complete` 且无 decision/lastError → 没有失败模式，返回 []。
 */
export interface AgentFailureClassification {
  patternId: FailurePatternId;
  bucket:
    | "reviewer"
    | "test_evidence"
    | "coder"
    | "pipeline"
    | "configuration"
    | "infrastructure";
  reason: string;
}

const bucketForPattern: Record<FailurePatternId, AgentFailureClassification["bucket"]> = {
  "missing-tests": "test_evidence",
  "unclear-requirements": "configuration",
  "permission-issue": "configuration",
  "environment-issue": "infrastructure",
  "review-rework": "reviewer",
  "ci-failure": "test_evidence",
  "missing-evidence": "test_evidence",
  reviewer_unavailable: "reviewer",
  reviewer_requested_changes: "reviewer",
  reviewer_cannot_review: "configuration",
  evidence_unavailable: "test_evidence",
  evidence_partial: "test_evidence",
  pipeline_cancelled: "pipeline",
  pipeline_init_failed: "pipeline",
  role_profile_invalid: "configuration",
  runner_unavailable: "infrastructure",
  coding_failed: "coder",
  sandbox_violation: "pipeline",
  redaction_failed: "pipeline",
  storage_full: "infrastructure",
};

export function classifyAgentFailure(
  report: AgentReport,
): AgentFailureClassification | null {
  if (report.role === "reviewer" && report.status === "complete") {
    const decision: ReviewerDecision = report.reviewer.decision;
    if (decision === "request_changes") {
      return {
        patternId: "reviewer_requested_changes",
        bucket: bucketForPattern.reviewer_requested_changes,
        reason: report.reviewer.summary || "reviewer requested changes",
      };
    }
    if (decision === "cannot_review") {
      return {
        patternId: "reviewer_cannot_review",
        bucket: bucketForPattern.reviewer_cannot_review,
        reason: report.reviewer.summary || "reviewer cannot review",
      };
    }
    if (decision === "approve_with_comments") return null;
  }

  if (report.status === "complete") return null;

  const lastError = report.lastError;
  if (!lastError) {
    if (report.role === "test_evidence" && report.status === "incomplete") {
      return {
        patternId: "evidence_partial",
        bucket: bucketForPattern.evidence_partial,
        reason: "evidence collection partial without explicit lastError",
      };
    }
    return null;
  }
  const code: LastErrorCode = lastError.code;
  const patternId = toFailurePatternId(code);
  if (!patternId) return null;
  const id = patternId as FailurePatternId;
  return {
    patternId: id,
    bucket: bucketForPattern[id] ?? "pipeline",
    reason: lastError.message ?? code,
  };
}
