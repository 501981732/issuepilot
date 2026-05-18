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

export const isQualityMetricId = (
  value: unknown,
): value is QualityMetricId =>
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
] as const;

export type FailurePatternId = (typeof FAILURE_PATTERN_ID_VALUES)[number];

export const isFailurePatternId = (
  value: unknown,
): value is FailurePatternId =>
  typeof value === "string" &&
  (FAILURE_PATTERN_ID_VALUES as readonly string[]).includes(value);

export const QUALITY_STATUS_FILTER_VALUES = [
  "run-completed",
  "run-failed",
  "run-blocked",
  "task-needs-rework",
  "task-skipped",
  "report-incomplete",
] as const;

export type QualityStatusFilter =
  (typeof QUALITY_STATUS_FILTER_VALUES)[number];

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
  run?: { runId: string; status: string };
  evidenceId?: string;
  updatedAt: string;
  target:
    | { kind: "run"; href: string }
    | { kind: "work-item"; href: string }
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
}
