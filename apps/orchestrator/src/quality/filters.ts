import {
  isFailurePatternId,
  isQualityStatusFilter,
  type FailurePatternId,
  type QualityStatusFilter,
  type QualitySummaryFilters,
  type QualityWindow,
} from "@issuepilot/shared-contracts";

import type { QualitySourceItem } from "./types.js";

export interface QualityQueryInput {
  workflow?: string;
  taskType?: string;
  status?: string;
  pattern?: string;
  from?: string;
  to?: string;
  window?: string;
  /** Reserved: not supported. The route must reject it before calling parse. */
  project?: string;
}

export interface QualityQueryParseError {
  code:
    | "invalid_status"
    | "invalid_pattern"
    | "invalid_window"
    | "invalid_from"
    | "invalid_to"
    | "project_query_unsupported";
  message: string;
}

export interface QualityQueryParseResult {
  filters?: QualitySummaryFilters;
  error?: QualityQueryParseError;
}

const WINDOW_DAYS: Record<QualityWindow, number> = {
  "7d": 7,
  "30d": 30,
};

function subtractDays(iso: string, days: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid ISO date: ${iso}`);
  }
  return new Date(ms - days * 86_400_000).toISOString();
}

function isValidIso(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Parses an `GET /api/quality/summary` querystring into stable filters used by
 * the aggregator and echoed back in the response. Returns `error` for any
 * malformed input so the route can return 400 with a stable code.
 */
export function parseQualityQuery(
  input: QualityQueryInput,
  opts: { now: string },
): QualityQueryParseResult {
  if (input.project !== undefined) {
    return {
      error: {
        code: "project_query_unsupported",
        message:
          "project query is not supported; team mode uses x-issuepilot-project",
      },
    };
  }

  let window: QualityWindow = "7d";
  if (input.window !== undefined) {
    if (input.window !== "7d" && input.window !== "30d") {
      return {
        error: { code: "invalid_window", message: "window must be 7d or 30d" },
      };
    }
    window = input.window;
  }

  let from: string;
  let to: string;
  if (input.to !== undefined) {
    if (!isValidIso(input.to)) {
      return { error: { code: "invalid_to", message: "to must be ISO string" } };
    }
    to = input.to;
  } else {
    to = opts.now;
  }
  if (input.from !== undefined) {
    if (!isValidIso(input.from)) {
      return {
        error: { code: "invalid_from", message: "from must be ISO string" },
      };
    }
    from = input.from;
  } else {
    from = subtractDays(to, WINDOW_DAYS[window]);
  }

  let status: QualityStatusFilter | undefined;
  if (input.status !== undefined) {
    if (!isQualityStatusFilter(input.status)) {
      return {
        error: {
          code: "invalid_status",
          message: `unsupported status: ${input.status}`,
        },
      };
    }
    status = input.status;
  }

  let pattern: FailurePatternId | undefined;
  if (input.pattern !== undefined) {
    if (!isFailurePatternId(input.pattern)) {
      return {
        error: {
          code: "invalid_pattern",
          message: `unsupported pattern: ${input.pattern}`,
        },
      };
    }
    pattern = input.pattern;
  }

  const filters: QualitySummaryFilters = {
    from,
    to,
    window,
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(status ? { status } : {}),
    ...(pattern ? { pattern } : {}),
  };

  return { filters };
}

function statusMatches(
  item: QualitySourceItem,
  status: QualityStatusFilter,
): boolean {
  switch (status) {
    case "run-completed":
      return item.kind === "run" && item.runStatus === "completed";
    case "run-failed":
      return item.kind === "run" && item.runStatus === "failed";
    case "run-blocked":
      return item.kind === "run" && item.runStatus === "blocked";
    case "task-needs-rework":
      return (
        item.kind === "task" &&
        (item.taskStatus === "needs_rework" ||
          item.needsReworkReason !== undefined)
      );
    case "task-skipped":
      return item.kind === "task" && item.taskStatus === "skipped";
    case "report-incomplete":
      return item.kind === "task" && item.reportStatus === "incomplete";
  }
}

/**
 * Returns the stable cross-aggregator id for a quality source item, used as
 * the key for pattern classification maps and drilldown items.
 */
export function qualityItemId(item: QualitySourceItem): string {
  return item.kind === "run"
    ? `run:${item.runId}`
    : `task:${item.workItemId}:${item.taskId}`;
}

/**
 * Filters source items by date window, workflow, task type, status, and pattern.
 * Pattern filtering is decoupled from classification to avoid circular imports;
 * call sites pass `opts.patternIdsByItemId` after running the pattern classifier.
 */
export function applyQualityFilters(
  items: QualitySourceItem[],
  filters: QualitySummaryFilters,
  opts: { patternIdsByItemId?: Map<string, FailurePatternId[]> } = {},
): QualitySourceItem[] {
  const fromMs = Date.parse(filters.from);
  const toMs = Date.parse(filters.to);

  return items.filter((item) => {
    const updatedMs = Date.parse(item.updatedAt);
    if (Number.isNaN(updatedMs)) return false;
    if (updatedMs < fromMs || updatedMs > toMs) return false;
    if (filters.workflow && item.workflow !== filters.workflow) return false;
    if (filters.taskType && item.taskType !== filters.taskType) return false;
    if (filters.status && !statusMatches(item, filters.status)) return false;
    if (filters.pattern) {
      const patternIds = opts.patternIdsByItemId?.get(qualityItemId(item));
      if (!patternIds || !patternIds.includes(filters.pattern)) return false;
    }
    return true;
  });
}
