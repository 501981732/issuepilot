import {
  FAILURE_PATTERN_ID_VALUES,
  QUALITY_METRIC_ID_VALUES,
  QUALITY_STATUS_FILTER_VALUES,
  type FailurePatternId,
  type FailurePatternSummary,
  type QualityDimension,
  type QualityDirection,
  type QualityDrilldownItem,
  type QualityMetric,
  type QualityMetricId,
  type QualityStatusFilter,
  type QualitySummaryFilters,
  type QualitySummaryResponse,
  type QualityTrendPoint,
} from "@issuepilot/shared-contracts";

import {
  applyQualityFilters,
  qualityItemId,
} from "./filters.js";
import { classifyQualityPatterns, type ClassifiedPattern } from "./patterns.js";
import type {
  QualityRunSourceItem,
  QualitySourceItem,
  QualityTaskSourceItem,
} from "./types.js";

export interface BuildQualitySummaryInput {
  items: QualitySourceItem[];
  filters: QualitySummaryFilters;
  scope: QualitySummaryResponse["scope"];
  diagnostics: QualitySummaryResponse["diagnostics"];
}

const METRIC_LABELS: Record<QualityMetricId, string> = {
  "success-rate": "Success rate",
  "failure-rate": "Failure rate",
  "rework-rate": "Rework rate",
  "ci-pass-rate": "CI pass rate",
  "review-hit-rate": "Review hit rate",
  "missing-evidence-rate": "Missing evidence rate",
  "median-duration": "Median duration",
};

const PATTERN_LABELS: Record<FailurePatternId, string> = {
  "missing-tests": "Missing tests",
  "unclear-requirements": "Unclear requirements",
  "permission-issue": "Permission issue",
  "environment-issue": "Environment issue",
  "review-rework": "Review rework",
  "ci-failure": "CI failure",
  "missing-evidence": "Missing evidence",
};

const STATUS_LABELS: Record<QualityStatusFilter, string> = {
  "run-completed": "Run completed",
  "run-failed": "Run failed",
  "run-blocked": "Run blocked",
  "task-needs-rework": "Task needs rework",
  "task-skipped": "Task skipped",
  "report-incomplete": "Report incomplete",
};

function isRunTerminal(item: QualitySourceItem): item is QualityRunSourceItem {
  return (
    item.kind === "run" &&
    (item.runStatus === "completed" ||
      item.runStatus === "failed" ||
      item.runStatus === "blocked")
  );
}

function isTaskKind(
  item: QualitySourceItem,
): item is QualityTaskSourceItem {
  return item.kind === "task";
}

function round(value: number): number {
  return Math.round(value);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function buildMetric(
  id: QualityMetricId,
  current: { numerator: number; denominator: number; unknownCount?: number },
  previous: { numerator: number; denominator: number } | undefined,
  unit: QualityMetric["unit"] = "percent",
): QualityMetric {
  const value =
    current.denominator > 0
      ? round((current.numerator / current.denominator) * 100)
      : 0;
  let direction: QualityDirection = "unknown";
  let previousValue: number | undefined;
  let delta: number | undefined;
  if (previous && previous.denominator > 0 && current.denominator > 0) {
    previousValue = round((previous.numerator / previous.denominator) * 100);
    delta = value - previousValue;
    direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  }

  return {
    id,
    label: METRIC_LABELS[id],
    value,
    unit,
    numerator: current.numerator,
    denominator: current.denominator,
    ...(current.unknownCount !== undefined
      ? { unknownCount: current.unknownCount }
      : {}),
    ...(previousValue !== undefined ? { previousValue } : {}),
    ...(delta !== undefined ? { delta } : {}),
    direction,
  };
}

function buildDurationMetric(values: number[]): QualityMetric {
  const value = median(values);
  return {
    id: "median-duration",
    label: METRIC_LABELS["median-duration"],
    value,
    unit: "duration-ms",
    direction: "unknown",
  };
}

interface MetricSlice {
  successRate: { numerator: number; denominator: number };
  failureRate: { numerator: number; denominator: number };
  reworkRate: { numerator: number; denominator: number };
  ciPassRate: {
    numerator: number;
    denominator: number;
    unknownCount: number;
  };
  reviewHitRate: { numerator: number; denominator: number };
  missingEvidenceRate: { numerator: number; denominator: number };
  durations: number[];
}

function emptySlice(): MetricSlice {
  return {
    successRate: { numerator: 0, denominator: 0 },
    failureRate: { numerator: 0, denominator: 0 },
    reworkRate: { numerator: 0, denominator: 0 },
    ciPassRate: { numerator: 0, denominator: 0, unknownCount: 0 },
    reviewHitRate: { numerator: 0, denominator: 0 },
    missingEvidenceRate: { numerator: 0, denominator: 0 },
    durations: [],
  };
}

function computeSlice(items: QualitySourceItem[]): MetricSlice {
  const slice = emptySlice();
  for (const item of items) {
    if (isRunTerminal(item)) {
      slice.successRate.denominator += 1;
      slice.failureRate.denominator += 1;
      if (item.runStatus === "completed") slice.successRate.numerator += 1;
      if (item.runStatus === "failed" || item.runStatus === "blocked") {
        slice.failureRate.numerator += 1;
      }

      if (item.ciStatus === undefined) {
        slice.ciPassRate.unknownCount += 1;
      } else {
        slice.ciPassRate.denominator += 1;
        if (item.ciStatus === "success") slice.ciPassRate.numerator += 1;
      }

      slice.reviewHitRate.denominator += 1;
      if ((item.reviewFeedback?.unresolvedCount ?? 0) > 0) {
        slice.reviewHitRate.numerator += 1;
      }

      if (item.totalMs !== undefined) {
        slice.durations.push(item.totalMs);
      }
    } else if (isTaskKind(item)) {
      slice.reworkRate.denominator += 1;
      if (
        item.taskStatus === "needs_rework" ||
        item.needsReworkReason !== undefined
      ) {
        slice.reworkRate.numerator += 1;
      }

      slice.missingEvidenceRate.denominator += 1;
      if (
        item.checklistReasons.includes("missing-evidence") ||
        item.reportStatus === "incomplete" ||
        item.evidenceCount === 0
      ) {
        slice.missingEvidenceRate.numerator += 1;
      }
    }
  }
  return slice;
}

function buildMetrics(
  current: MetricSlice,
  previous: MetricSlice,
): QualityMetric[] {
  return [
    buildMetric("success-rate", current.successRate, previous.successRate),
    buildMetric("failure-rate", current.failureRate, previous.failureRate),
    buildMetric("rework-rate", current.reworkRate, previous.reworkRate),
    buildMetric(
      "ci-pass-rate",
      {
        numerator: current.ciPassRate.numerator,
        denominator: current.ciPassRate.denominator,
        unknownCount: current.ciPassRate.unknownCount,
      },
      previous.ciPassRate,
    ),
    buildMetric("review-hit-rate", current.reviewHitRate, previous.reviewHitRate),
    buildMetric(
      "missing-evidence-rate",
      current.missingEvidenceRate,
      previous.missingEvidenceRate,
    ),
    buildDurationMetric(current.durations),
  ];
}

function previousWindow(filters: QualitySummaryFilters): {
  fromMs: number;
  toMs: number;
} {
  const fromMs = Date.parse(filters.from);
  const toMs = Date.parse(filters.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return { fromMs: NaN, toMs: NaN };
  }
  const windowSize = toMs - fromMs;
  return {
    fromMs: fromMs - windowSize,
    toMs: fromMs - 1,
  };
}

function bucketsForWindow(
  filters: QualitySummaryFilters,
): Array<{ start: string; end: string }> {
  const fromMs = Date.parse(filters.from);
  const toMs = Date.parse(filters.to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return [];
  const days = filters.window === "30d" ? 30 : 7;
  const totalMs = toMs - fromMs;
  const bucketMs = Math.max(1, Math.floor(totalMs / days));
  const buckets: Array<{ start: string; end: string }> = [];
  for (let i = 0; i < days; i += 1) {
    const startMs = fromMs + i * bucketMs;
    const endMs = i === days - 1 ? toMs : fromMs + (i + 1) * bucketMs - 1;
    buckets.push({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
  }
  return buckets;
}

function buildTrend(
  items: QualitySourceItem[],
  filters: QualitySummaryFilters,
): QualityTrendPoint[] {
  if (items.length === 0) return [];
  const buckets = bucketsForWindow(filters);
  const trends: QualityTrendPoint[] = [];

  for (const bucket of buckets) {
    const startMs = Date.parse(bucket.start);
    const endMs = Date.parse(bucket.end);
    const slice = items.filter((item) => {
      const ms = Date.parse(item.updatedAt);
      return ms >= startMs && ms <= endMs;
    });
    const m = computeSlice(slice);
    for (const id of QUALITY_METRIC_ID_VALUES) {
      let numerator = 0;
      let denominator = 0;
      let unknownCount: number | undefined;
      let value = 0;
      switch (id) {
        case "success-rate":
          numerator = m.successRate.numerator;
          denominator = m.successRate.denominator;
          break;
        case "failure-rate":
          numerator = m.failureRate.numerator;
          denominator = m.failureRate.denominator;
          break;
        case "rework-rate":
          numerator = m.reworkRate.numerator;
          denominator = m.reworkRate.denominator;
          break;
        case "ci-pass-rate":
          numerator = m.ciPassRate.numerator;
          denominator = m.ciPassRate.denominator;
          unknownCount = m.ciPassRate.unknownCount;
          break;
        case "review-hit-rate":
          numerator = m.reviewHitRate.numerator;
          denominator = m.reviewHitRate.denominator;
          break;
        case "missing-evidence-rate":
          numerator = m.missingEvidenceRate.numerator;
          denominator = m.missingEvidenceRate.denominator;
          break;
        case "median-duration":
          value = median(m.durations);
          break;
      }
      if (id !== "median-duration" && denominator > 0) {
        value = round((numerator / denominator) * 100);
      }
      trends.push({
        metricId: id,
        bucketStart: bucket.start,
        bucketEnd: bucket.end,
        value,
        ...(id !== "median-duration" ? { numerator, denominator } : {}),
        ...(unknownCount !== undefined ? { unknownCount } : {}),
      });
    }
  }
  return trends;
}

function buildPatternSummaries(
  items: QualitySourceItem[],
  itemPatterns: Map<string, ClassifiedPattern[]>,
): FailurePatternSummary[] {
  const summaries = new Map<
    FailurePatternId,
    {
      count: number;
      drilldownCount: number;
      topProject: Map<string, number>;
      topWorkflow: Map<string, number>;
      latestReason?: string;
      latestUpdatedAt?: string;
    }
  >();

  for (const item of items) {
    const id = qualityItemId(item);
    const patterns = itemPatterns.get(id) ?? [];
    for (const pattern of patterns) {
      const entry = summaries.get(pattern.patternId) ?? {
        count: 0,
        drilldownCount: 0,
        topProject: new Map<string, number>(),
        topWorkflow: new Map<string, number>(),
      };
      entry.count += 1;
      entry.drilldownCount += 1;
      entry.topProject.set(
        item.projectId,
        (entry.topProject.get(item.projectId) ?? 0) + 1,
      );
      entry.topWorkflow.set(
        item.workflow,
        (entry.topWorkflow.get(item.workflow) ?? 0) + 1,
      );
      if (!entry.latestUpdatedAt || item.updatedAt > entry.latestUpdatedAt) {
        entry.latestUpdatedAt = item.updatedAt;
        entry.latestReason = pattern.reason;
      }
      summaries.set(pattern.patternId, entry);
    }
  }

  const totalItems = items.length;
  const out: FailurePatternSummary[] = [];
  for (const [patternId, entry] of summaries) {
    const topProject = [...entry.topProject.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    const topWorkflow = [...entry.topWorkflow.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    out.push({
      patternId,
      label: PATTERN_LABELS[patternId],
      count: entry.count,
      rate: totalItems > 0 ? round((entry.count / totalItems) * 100) : 0,
      ...(topProject ? { topProject } : {}),
      ...(topWorkflow ? { topWorkflow } : {}),
      ...(entry.latestReason ? { latestReason: entry.latestReason } : {}),
      drilldownCount: entry.drilldownCount,
    });
  }
  out.sort(
    (a, b) => b.count - a.count || a.patternId.localeCompare(b.patternId),
  );
  return out;
}

function targetFor(
  item: QualitySourceItem,
  patternIds: FailurePatternId[],
): QualityDrilldownItem["target"] {
  if (item.kind === "run") {
    return { kind: "run", href: `/runs/${item.runId}` };
  }
  if (patternIds.includes("missing-evidence")) {
    return {
      kind: "evidence",
      href: `/work-items/${item.workItemId}?view=evidence`,
    };
  }
  return { kind: "work-item", href: `/work-items/${item.workItemId}` };
}

function reasonFor(item: QualitySourceItem, patterns: ClassifiedPattern[]): string {
  if (patterns.length > 0) {
    return patterns.map((p) => p.reason).join(" | ");
  }
  if (item.kind === "run") {
    return item.lastError?.message ?? `run ${item.runStatus}`;
  }
  return item.needsReworkReason ?? `task ${item.taskStatus}`;
}

function buildDrilldown(
  items: QualitySourceItem[],
  itemPatterns: Map<string, ClassifiedPattern[]>,
): QualityDrilldownItem[] {
  const out: QualityDrilldownItem[] = [];
  for (const item of items) {
    const id = qualityItemId(item);
    const patterns = itemPatterns.get(id) ?? [];
    const patternIds = patterns.map((p) => p.patternId);
    const reason = reasonFor(item, patterns);

    if (item.kind === "run") {
      out.push({
        itemId: id,
        patternIds,
        reason,
        projectId: item.projectId,
        workflow: item.workflow,
        taskType: item.taskType,
        issue: {
          iid: item.issue.iid,
          title: item.issue.title,
          ...(item.issue.url ? { url: item.issue.url } : {}),
        },
        run: { runId: item.runId, status: item.runStatus },
        updatedAt: item.updatedAt,
        target: targetFor(item, patternIds),
      });
    } else {
      out.push({
        itemId: id,
        patternIds,
        reason,
        projectId: item.projectId,
        workflow: item.workflow,
        taskType: item.taskType,
        workItem: {
          workItemId: item.workItemId,
          title: item.workItemTitle,
        },
        task: { taskId: item.taskId, title: item.taskTitle },
        ...(item.runId ? { run: { runId: item.runId, status: item.taskStatus } } : {}),
        updatedAt: item.updatedAt,
        target: targetFor(item, patternIds),
      });
    }
  }
  out.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.itemId.localeCompare(b.itemId),
  );
  return out;
}

function buildDimensions(items: QualitySourceItem[]): QualityDimension[] {
  const dims: QualityDimension[] = [];
  const workflowCounts = new Map<string, number>();
  const taskTypeCounts = new Map<string, number>();
  const statusCounts = new Map<QualityStatusFilter, number>();
  const patternCounts = new Map<FailurePatternId, number>();

  for (const item of items) {
    workflowCounts.set(item.workflow, (workflowCounts.get(item.workflow) ?? 0) + 1);
    taskTypeCounts.set(item.taskType, (taskTypeCounts.get(item.taskType) ?? 0) + 1);
  }

  for (const status of QUALITY_STATUS_FILTER_VALUES) {
    let count = 0;
    for (const item of items) {
      switch (status) {
        case "run-completed":
          if (item.kind === "run" && item.runStatus === "completed") count += 1;
          break;
        case "run-failed":
          if (item.kind === "run" && item.runStatus === "failed") count += 1;
          break;
        case "run-blocked":
          if (item.kind === "run" && item.runStatus === "blocked") count += 1;
          break;
        case "task-needs-rework":
          if (
            item.kind === "task" &&
            (item.taskStatus === "needs_rework" ||
              item.needsReworkReason !== undefined)
          ) {
            count += 1;
          }
          break;
        case "task-skipped":
          if (item.kind === "task" && item.taskStatus === "skipped") count += 1;
          break;
        case "report-incomplete":
          if (item.kind === "task" && item.reportStatus === "incomplete") {
            count += 1;
          }
          break;
      }
    }
    if (count > 0) statusCounts.set(status, count);
  }

  for (const pattern of FAILURE_PATTERN_ID_VALUES) {
    let count = 0;
    for (const item of items) {
      const classified = classifyQualityPatterns(item).map((p) => p.patternId);
      if (classified.includes(pattern)) count += 1;
    }
    if (count > 0) patternCounts.set(pattern, count);
  }

  for (const [value, count] of workflowCounts) {
    dims.push({ kind: "workflow", value, label: value, count });
  }
  for (const [value, count] of taskTypeCounts) {
    dims.push({ kind: "task-type", value, label: value, count });
  }
  for (const [value, count] of statusCounts) {
    dims.push({ kind: "status", value, label: STATUS_LABELS[value], count });
  }
  for (const [value, count] of patternCounts) {
    dims.push({ kind: "pattern", value, label: PATTERN_LABELS[value], count });
  }
  return dims;
}

/**
 * Builds the full V4.4 quality summary response from already-collected source
 * items. Classification happens once and is shared across filters, pattern
 * summaries, and drill-down. Source order is `filters → trend → metrics →
 * patterns → drilldown → dimensions` so callers can read the function top to
 * bottom and follow data flow.
 */
export function buildQualitySummary(
  input: BuildQualitySummaryInput,
): QualitySummaryResponse {
  const { filters, scope, diagnostics } = input;

  const allClassified = new Map<string, ClassifiedPattern[]>();
  for (const item of input.items) {
    allClassified.set(qualityItemId(item), classifyQualityPatterns(item));
  }

  const inWindow = applyQualityFilters(input.items, filters, {
    patternIdsByItemId: new Map(
      [...allClassified.entries()].map(([k, v]) => [k, v.map((p) => p.patternId)]),
    ),
  });

  const previous = previousWindow(filters);
  const previousItems = !Number.isNaN(previous.fromMs)
    ? input.items.filter((item) => {
        const ms = Date.parse(item.updatedAt);
        return ms >= previous.fromMs && ms <= previous.toMs;
      })
    : [];

  const currentSlice = computeSlice(inWindow);
  const previousSlice = computeSlice(previousItems);

  const metrics = buildMetrics(currentSlice, previousSlice);
  const trends = buildTrend(inWindow, filters);
  const failurePatterns = buildPatternSummaries(inWindow, allClassified);
  const drilldown = buildDrilldown(inWindow, allClassified);
  const dimensions = buildDimensions(inWindow);

  return {
    scope,
    filters,
    metrics,
    trends,
    failurePatterns,
    drilldown,
    dimensions,
    diagnostics,
  };
}
