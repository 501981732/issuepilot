import { describe, expect, it } from "vitest";

import type {
  QualityMetricId,
  QualitySummaryFilters,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

import { buildQualitySummary } from "../aggregate.js";
import type { QualitySourceItem } from "../types.js";

function runSource(over: Partial<Extract<QualitySourceItem, { kind: "run" }>>): QualitySourceItem {
  return {
    kind: "run",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    runId: "run-1",
    runStatus: "completed",
    issue: {
      projectId: "proj-a",
      iid: 1,
      title: "Issue",
      url: "https://gitlab.example/1",
      labels: [],
    },
    checks: [{ name: "unit", status: "passed" }],
    risks: [],
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

function taskSource(over: Partial<Extract<QualitySourceItem, { kind: "task" }>>): QualitySourceItem {
  return {
    kind: "task",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    workItemId: "wi-1",
    workItemTitle: "WI",
    taskId: "t1",
    taskTitle: "Task",
    taskStatus: "completed",
    checklistReasons: [],
    evidenceCount: 1,
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

const baseFilters: QualitySummaryFilters = {
  from: "2026-05-11T00:00:00.000Z",
  to: "2026-05-18T23:59:59.999Z",
  window: "7d",
};

function metric(
  result: QualitySummaryResponse,
  id: QualityMetricId,
) {
  return result.metrics.find((m) => m.id === id);
}

describe("buildQualitySummary", () => {
  it("computes core quality metrics", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ok", runStatus: "completed", ciStatus: "success" }),
        runSource({ runId: "fail", runStatus: "failed", ciStatus: "failed" }),
        runSource({ runId: "blocked", runStatus: "blocked" }),
        taskSource({ taskId: "t1", taskStatus: "needs_rework" }),
        taskSource({
          taskId: "t2",
          taskStatus: "completed",
          checklistReasons: ["missing-evidence"],
          evidenceCount: 0,
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    expect(metric(result, "success-rate")).toMatchObject({
      numerator: 1,
      denominator: 3,
      value: 33,
    });
    expect(metric(result, "failure-rate")).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 67,
    });
    expect(metric(result, "ci-pass-rate")).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 50,
      unknownCount: 1,
    });
    expect(metric(result, "rework-rate")?.numerator).toBe(1);
    expect(metric(result, "missing-evidence-rate")?.numerator).toBeGreaterThan(0);
  });

  it("returns stable empty response when no items", () => {
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    expect(result.metrics.length).toBeGreaterThan(0);
    for (const m of result.metrics) {
      expect(m.direction).toBe("unknown");
      expect(m.value).toBe(0);
    }
    expect(result.trends).toEqual([]);
    expect(result.failurePatterns).toEqual([]);
    expect(result.drilldown).toEqual([]);
  });

  it("produces drilldown targets for run, work item, and evidence", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "run-1", runStatus: "failed", ciStatus: "failed" }),
        taskSource({
          taskId: "t-evi",
          workItemId: "wi-2",
          evidenceCount: 0,
          checklistReasons: ["missing-evidence"],
        }),
        taskSource({
          taskId: "t-rework",
          workItemId: "wi-3",
          taskStatus: "needs_rework",
          needsReworkReason: "review failed",
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    const targets = result.drilldown.map((d) => d.target);
    const kinds = new Set(targets.map((t) => t.kind));
    expect(kinds.has("run")).toBe(true);
    expect(kinds.has("evidence")).toBe(true);
    expect(kinds.has("work-item")).toBe(true);

    const run = result.drilldown.find((d) => d.target.kind === "run");
    expect(run?.target.kind === "run" && run.target.href).toBe("/runs/run-1");
    const evi = result.drilldown.find((d) => d.target.kind === "evidence");
    expect(evi?.target.kind === "evidence" && evi.target.href).toBe(
      "/work-items/wi-2?view=evidence",
    );
  });

  it("sorts failure patterns by count desc then id asc", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "a", runStatus: "failed", ciStatus: "failed" }),
        runSource({ runId: "b", runStatus: "failed", ciStatus: "failed" }),
        runSource({
          runId: "c",
          runStatus: "failed",
          lastError: { code: "auth", message: "401 unauthorized" },
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const ids = result.failurePatterns.map((p) => p.patternId);
    expect(ids[0]).toBe("ci-failure");
  });

  it("includes dimensions for workflow, task-type, status, pattern", () => {
    const result = buildQualitySummary({
      items: [runSource({ runId: "a", runStatus: "completed" })],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const kinds = new Set(result.dimensions.map((d) => d.kind));
    expect(kinds.has("workflow")).toBe(true);
    expect(kinds.has("status")).toBe(true);
  });

  it("applies status filter to drill-down", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ok", runStatus: "completed" }),
        runSource({ runId: "fail", runStatus: "failed", ciStatus: "failed" }),
      ],
      filters: { ...baseFilters, status: "run-failed" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    expect(result.drilldown.map((d) => d.itemId)).toEqual(["run:fail"]);
  });

  it("filters by pattern when provided", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ci", runStatus: "failed", ciStatus: "failed" }),
        runSource({
          runId: "perm",
          runStatus: "failed",
          lastError: { code: "perm", message: "403 access denied" },
        }),
      ],
      filters: { ...baseFilters, pattern: "permission-issue" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    expect(result.drilldown.map((d) => d.itemId)).toEqual(["run:perm"]);
  });

  it("uses duration-ms unit for median-duration", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "a", runStatus: "completed", totalMs: 1000 }),
        runSource({ runId: "b", runStatus: "completed", totalMs: 3000 }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const m = metric(result, "median-duration");
    expect(m?.unit).toBe("duration-ms");
    expect(m?.value).toBe(2000);
  });

  it("propagates diagnostics", () => {
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 3 },
    });
    expect(result.diagnostics.invalidReportCount).toBe(3);
  });
});
