/**
 * V4.9 Intelligent Review Workflow.
 *
 * `ReviewReworkPlan` 是 IssuePilot 把 review feedback 从「评论摘要」升级为
 * 可审计的返工计划之后落地的核心契约：
 *
 * - `ReviewFeedbackSummary` 继续负责收集原始人工评论；
 * - `ReviewerAgentReport.reviewer.findings` 继续负责 AI reviewer 结构化产物；
 * - `ReviewReworkPlan` 负责把这些来源 + CI / evidence gap 合并、分类、排序，
 *   并由 operator 在 dashboard accept 后作为下一轮 ai-rework 的主输入。
 *
 * 改动 enum 必须同时在 `__tests__/review-rework.test.ts` 与 spec §6 中对齐。
 * Source: docs/superpowers/specs/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-design.md
 */

import { isRunnerKind, type RunnerKind } from "./runner.js";

export const REVIEW_REWORK_PLAN_STATUS_VALUES = [
  "draft",
  "accepted",
  "dismissed",
  "resolved",
  "superseded",
] as const;
export type ReviewReworkPlanStatus =
  (typeof REVIEW_REWORK_PLAN_STATUS_VALUES)[number];

export const REVIEW_REWORK_ITEM_STATUS_VALUES = [
  "open",
  "accepted",
  "dismissed",
  "resolved",
] as const;
export type ReviewReworkItemStatus =
  (typeof REVIEW_REWORK_ITEM_STATUS_VALUES)[number];

export const REVIEW_REWORK_CATEGORY_VALUES = [
  "correctness",
  "test_gap",
  "ci_failure",
  "missing_evidence",
  "security",
  "maintainability",
  "docs",
  "scope_clarification",
  "style",
  "question",
] as const;
export type ReviewReworkCategory =
  (typeof REVIEW_REWORK_CATEGORY_VALUES)[number];

export const REVIEW_REWORK_PRIORITY_VALUES = [
  "low",
  "medium",
  "high",
  "blocking",
] as const;
export type ReviewReworkPriority =
  (typeof REVIEW_REWORK_PRIORITY_VALUES)[number];

export const REVIEW_REWORK_SOURCE_KIND_VALUES = [
  "human_review_comment",
  "ai_reviewer_finding",
  "ci_feedback",
  "evidence_gap",
  "operator_note",
] as const;
export type ReviewReworkSourceKind =
  (typeof REVIEW_REWORK_SOURCE_KIND_VALUES)[number];

export const isReviewReworkPlanStatus = (
  value: unknown,
): value is ReviewReworkPlanStatus =>
  typeof value === "string" &&
  (REVIEW_REWORK_PLAN_STATUS_VALUES as readonly string[]).includes(value);

export const isReviewReworkItemStatus = (
  value: unknown,
): value is ReviewReworkItemStatus =>
  typeof value === "string" &&
  (REVIEW_REWORK_ITEM_STATUS_VALUES as readonly string[]).includes(value);

export const isReviewReworkCategory = (
  value: unknown,
): value is ReviewReworkCategory =>
  typeof value === "string" &&
  (REVIEW_REWORK_CATEGORY_VALUES as readonly string[]).includes(value);

export const isReviewReworkPriority = (
  value: unknown,
): value is ReviewReworkPriority =>
  typeof value === "string" &&
  (REVIEW_REWORK_PRIORITY_VALUES as readonly string[]).includes(value);

export const isReviewReworkSourceKind = (
  value: unknown,
): value is ReviewReworkSourceKind =>
  typeof value === "string" &&
  (REVIEW_REWORK_SOURCE_KIND_VALUES as readonly string[]).includes(value);

export interface ReviewReworkSourceRef {
  kind: ReviewReworkSourceKind;
  id: string;
  url?: string;
  author?: string;
  createdAt?: string;
  /**
   * V4.8: runner kind that produced this source ref (only meaningful for
   * `ai_reviewer_finding`). Preserves Codex / Claude Code provenance so
   * Quality Analytics can break review workflow facts down by runner.
   */
  runnerKind?: RunnerKind;
  agentReportId?: string;
}

export interface ReviewReworkItem {
  itemId: string;
  status: ReviewReworkItemStatus;
  category: ReviewReworkCategory;
  priority: ReviewReworkPriority;
  title: string;
  summary: string;
  targetFiles: string[];
  taskId?: string;
  suggestedValidation: string[];
  sourceRefs: ReviewReworkSourceRef[];
  /** 0..1 inclusive; classifier confidence (see spec §6.1). */
  confidence: number;
}

export interface ReviewReworkPlan {
  planId: string;
  runId: string;
  issueIid: number;
  projectId?: string;
  workItemId?: string;
  taskId?: string;
  status: ReviewReworkPlanStatus;
  generatedAt: string;
  acceptedAt?: string;
  supersedesPlanId?: string;
  supersededByPlanId?: string;
  /** Pointer to the `ReviewFeedbackSummary` snapshot that seeded this plan. */
  sourceSummaryId?: string;
  items: ReviewReworkItem[];
  dismissedReason?: string;
}

/**
 * V4.9 spec §6.2 / §9.2：aggregated per-WorkItem snapshot. Lives on
 * `WorkItemReport.reviewReworkSummary` so the Parent Review Packet can
 * render counts without re-reading every plan from disk.
 */
export interface ReviewReworkSummary {
  blockingCount: number;
  acceptedCount: number;
  resolvedCount: number;
  perTask: Record<
    string,
    { blocking: number; accepted: number; resolved: number }
  >;
  latestPlanIds: string[];
}

const isSourceRef = (value: unknown): value is ReviewReworkSourceRef => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!isReviewReworkSourceKind(obj["kind"])) return false;
  if (typeof obj["id"] !== "string") return false;
  if (obj["url"] !== undefined && typeof obj["url"] !== "string") return false;
  if (obj["author"] !== undefined && typeof obj["author"] !== "string") {
    return false;
  }
  if (
    obj["createdAt"] !== undefined &&
    typeof obj["createdAt"] !== "string"
  ) {
    return false;
  }
  if (obj["runnerKind"] !== undefined && !isRunnerKind(obj["runnerKind"])) {
    return false;
  }
  if (
    obj["agentReportId"] !== undefined &&
    typeof obj["agentReportId"] !== "string"
  ) {
    return false;
  }
  return true;
};

export const isReviewReworkItem = (
  value: unknown,
): value is ReviewReworkItem => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["itemId"] !== "string") return false;
  if (!isReviewReworkItemStatus(obj["status"])) return false;
  if (!isReviewReworkCategory(obj["category"])) return false;
  if (!isReviewReworkPriority(obj["priority"])) return false;
  if (typeof obj["title"] !== "string") return false;
  if (typeof obj["summary"] !== "string") return false;
  if (
    !Array.isArray(obj["targetFiles"]) ||
    obj["targetFiles"].some((f) => typeof f !== "string")
  ) {
    return false;
  }
  if (obj["taskId"] !== undefined && typeof obj["taskId"] !== "string") {
    return false;
  }
  if (
    !Array.isArray(obj["suggestedValidation"]) ||
    obj["suggestedValidation"].some((f) => typeof f !== "string")
  ) {
    return false;
  }
  if (
    !Array.isArray(obj["sourceRefs"]) ||
    obj["sourceRefs"].some((r) => !isSourceRef(r))
  ) {
    return false;
  }
  if (typeof obj["confidence"] !== "number") return false;
  if (obj["confidence"] < 0 || obj["confidence"] > 1) return false;
  return true;
};

export const isReviewReworkPlan = (
  value: unknown,
): value is ReviewReworkPlan => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["planId"] !== "string") return false;
  if (typeof obj["runId"] !== "string") return false;
  if (typeof obj["issueIid"] !== "number") return false;
  if (!isReviewReworkPlanStatus(obj["status"])) return false;
  if (typeof obj["generatedAt"] !== "string") return false;
  if (
    !Array.isArray(obj["items"]) ||
    obj["items"].some((item) => !isReviewReworkItem(item))
  ) {
    return false;
  }
  return true;
};

export const isReviewReworkSummary = (
  value: unknown,
): value is ReviewReworkSummary => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["blockingCount"] !== "number") return false;
  if (typeof obj["acceptedCount"] !== "number") return false;
  if (typeof obj["resolvedCount"] !== "number") return false;
  if (!obj["perTask"] || typeof obj["perTask"] !== "object") return false;
  if (
    !Array.isArray(obj["latestPlanIds"]) ||
    obj["latestPlanIds"].some((s) => typeof s !== "string")
  ) {
    return false;
  }
  return true;
};
