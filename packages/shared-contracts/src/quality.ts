/**
 * V4.4 Quality Analytics wire contract. Shared between
 * `apps/orchestrator/src/quality/*` and `apps/dashboard/components/reports/*`.
 *
 * Stable, JSON-serialisable types only — no Dates, Maps, or class instances.
 */

export const QUALITY_METRIC_ID_VALUES = [
  "success-rate",
  "failure-rate",
  "rework-rate",
  "ci-pass-rate",
  "review-hit-rate",
  "missing-evidence-rate",
  "median-duration",
] as const;

export type QualityMetricId = (typeof QUALITY_METRIC_ID_VALUES)[number];

export const isQualityMetricId = (value: unknown): value is QualityMetricId =>
  typeof value === "string" &&
  (QUALITY_METRIC_ID_VALUES as readonly string[]).includes(value);

export const FAILURE_PATTERN_ID_VALUES = [
  "missing-tests",
  "unclear-requirements",
  "permission-issue",
  "environment-issue",
  "review-rework",
  "ci-failure",
  "missing-evidence",
  // V4.6 增量（spec §16.2 / §17.4）：reviewer / test_evidence / pipeline /
  // role profile / sandbox / redaction / runner / coding / storage / cancel。
  // 与 `apps/orchestrator/src/pipelines/failure-mapping.ts` 保持一致。
  "reviewer_unavailable",
  "reviewer_requested_changes",
  "reviewer_cannot_review",
  "evidence_unavailable",
  "evidence_partial",
  "pipeline_cancelled",
  "pipeline_init_failed",
  "role_profile_invalid",
  "runner_unavailable",
  "coding_failed",
  "sandbox_violation",
  "redaction_failed",
  "storage_full",
] as const;

export type FailurePatternId = (typeof FAILURE_PATTERN_ID_VALUES)[number];

export const isFailurePatternId = (value: unknown): value is FailurePatternId =>
  typeof value === "string" &&
  (FAILURE_PATTERN_ID_VALUES as readonly string[]).includes(value);

/**
 * V4.6 by-role 切片（spec §17.4）。每个 role 暴露成功 / 失败 / 跳过率，给
 * dashboard 的 reports 页面 6 个 metric tile 用。`undefined` 表示当前窗口
 * 没有该 role 的任何 AgentReport。
 */
export interface QualityByRoleSlice {
  /** coder 成功率：`complete / (complete + failed + cancelled)` ∈ [0,100]。 */
  coderSuccessRate?: number;
  /** reviewer approve_with_comments 占 reviewer decision 总数。 */
  reviewerApproveRate?: number;
  /** reviewer cannot_review 占 reviewer decision 总数。 */
  reviewerCannotReviewRate?: number;
  /** reviewer runner_unavailable / agent failed 占 reviewer 总数。 */
  reviewerUnavailableRate?: number;
  /** test_evidence evidenceStatus = `complete` 占 test_evidence 总数。 */
  testEvidenceCompleteRate?: number;
  /** test_evidence evidenceStatus = `partial` 占 test_evidence 总数。 */
  testEvidencePartialRate?: number;
  /** 用于显示分子分母（dashboard hover tooltip）。 */
  counts?: {
    coderComplete: number;
    coderFailed: number;
    coderCancelled: number;
    reviewerApprove: number;
    reviewerRequestChanges: number;
    reviewerCannotReview: number;
    reviewerUnavailable: number;
    testEvidenceComplete: number;
    testEvidencePartial: number;
    testEvidenceUnavailable: number;
  };
}

export const QUALITY_STATUS_FILTER_VALUES = [
  "run-completed",
  "run-failed",
  "run-blocked",
  "task-needs-rework",
  "task-skipped",
  "report-incomplete",
] as const;

export type QualityStatusFilter = (typeof QUALITY_STATUS_FILTER_VALUES)[number];

export const isQualityStatusFilter = (
  value: unknown,
): value is QualityStatusFilter =>
  typeof value === "string" &&
  (QUALITY_STATUS_FILTER_VALUES as readonly string[]).includes(value);

export type QualityWindow = "7d" | "30d";
export type QualityDirection = "up" | "down" | "flat" | "unknown";

export interface QualitySummaryFilters {
  workflow?: string;
  taskType?: string;
  status?: QualityStatusFilter;
  pattern?: FailurePatternId;
  from: string;
  to: string;
  window: QualityWindow;
}

export interface QualityMetric {
  id: QualityMetricId;
  label: string;
  value: number;
  unit: "percent" | "count" | "duration-ms";
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
  previousValue?: number;
  delta?: number;
  direction: QualityDirection;
}

export interface QualityTrendPoint {
  metricId: QualityMetricId;
  bucketStart: string;
  bucketEnd: string;
  value: number;
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
}

export interface FailurePatternSummary {
  patternId: FailurePatternId;
  label: string;
  count: number;
  rate: number;
  topProject?: string;
  topWorkflow?: string;
  latestReason?: string;
  drilldownCount: number;
}

export interface QualityDrilldownItem {
  itemId: string;
  patternIds: FailurePatternId[];
  reason: string;
  projectId: string;
  workflow?: string;
  taskType?: string;
  issue?: { iid: number; title: string; url?: string };
  workItem?: { workItemId: string; title: string };
  task?: { taskId: string; title: string };
  agentReport?: { agentReportId: string; role: string; status: string };
  run?: { runId: string; status: string };
  evidenceId?: string;
  updatedAt: string;
  target:
    | { kind: "run"; href: string }
    | { kind: "work-item"; href: string }
    | { kind: "agent-report"; href: string }
    | { kind: "evidence"; href: string };
}

export interface QualityDimension {
  kind: "workflow" | "task-type" | "status" | "pattern";
  value: string;
  label: string;
  count: number;
}

export interface QualitySummaryResponse {
  scope: { mode: "single-project" | "team-project"; projectId?: string };
  filters: QualitySummaryFilters;
  metrics: QualityMetric[];
  trends: QualityTrendPoint[];
  failurePatterns: FailurePatternSummary[];
  drilldown: QualityDrilldownItem[];
  dimensions: QualityDimension[];
  diagnostics: { invalidReportCount: number };
  /**
   * V4.6 by-role 切片（spec §17.4）。可选字段，老 client 视为 undefined 即可。
   */
  byRole?: QualityByRoleSlice;
  /**
   * V4.9 Intelligent Review Workflow 切片（spec §6.2 / §10）。返回最近
   * 窗口内 `ReviewReworkPlan` 的聚合计数 + 分类 / runner 维度的分布。
   * 老 client / 未启用 V4.9 的部署视为 undefined。
   */
  reviewWorkflow?: {
    plansGenerated: number;
    itemsAccepted: number;
    itemsResolved: number;
    topCategories: Array<{ category: string; count: number }>;
    runnerKindBreakdown: Record<string, number>;
  };
}
