import { describe, expect, it } from "vitest";

import type {
  FailurePatternId,
  QualitySummaryFilters,
} from "@issuepilot/shared-contracts";

import {
  applyQualityFilters,
  parseQualityQuery,
} from "../filters.js";
import type { QualitySourceItem } from "../types.js";

const NOW = "2026-05-18T12:00:00.000Z";

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
    checks: [],
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
  from: "2026-05-12T00:00:00.000Z",
  to: "2026-05-18T23:59:59.999Z",
  window: "7d",
};

describe("parseQualityQuery", () => {
  it("defaults to a 7d window", () => {
    const parsed = parseQualityQuery({}, { now: NOW });
    expect(parsed.error).toBeUndefined();
    expect(parsed.filters?.window).toBe("7d");
    expect(parsed.filters?.to).toBe(NOW);
    expect(parsed.filters?.from).toBe("2026-05-11T12:00:00.000Z");
  });

  it("supports 30d window", () => {
    const parsed = parseQualityQuery({ window: "30d" }, { now: NOW });
    expect(parsed.error).toBeUndefined();
    expect(parsed.filters?.window).toBe("30d");
    expect(parsed.filters?.from).toBe("2026-04-18T12:00:00.000Z");
  });

  it("accepts explicit from/to ISO strings", () => {
    const parsed = parseQualityQuery(
      {
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-15T00:00:00.000Z",
      },
      { now: NOW },
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.filters?.from).toBe("2026-05-01T00:00:00.000Z");
    expect(parsed.filters?.to).toBe("2026-05-15T00:00:00.000Z");
  });

  it("rejects unsupported status", () => {
    const result = parseQualityQuery({ status: "failed" }, { now: NOW });
    expect(result.error).toMatchObject({ code: "invalid_status" });
  });

  it("rejects unsupported window", () => {
    const result = parseQualityQuery({ window: "90d" }, { now: NOW });
    expect(result.error).toMatchObject({ code: "invalid_window" });
  });

  it("rejects unsupported pattern", () => {
    const result = parseQualityQuery({ pattern: "weird" }, { now: NOW });
    expect(result.error).toMatchObject({ code: "invalid_pattern" });
  });

  it("rejects project query to keep scope unambiguous", () => {
    const result = parseQualityQuery({ project: "proj-a" }, { now: NOW });
    expect(result.error).toMatchObject({ code: "project_query_unsupported" });
  });

  it("echoes workflow / taskType / status / pattern", () => {
    const parsed = parseQualityQuery(
      {
        workflow: "default",
        taskType: "code",
        status: "run-failed",
        pattern: "permission-issue",
      },
      { now: NOW },
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.filters).toMatchObject({
      workflow: "default",
      taskType: "code",
      status: "run-failed",
      pattern: "permission-issue",
    });
  });
});

describe("applyQualityFilters", () => {
  it("filters by date window", () => {
    const items = applyQualityFilters(
      [
        runSource({ runId: "old", updatedAt: "2026-05-01T00:00:00.000Z" }),
        runSource({ runId: "new", updatedAt: "2026-05-15T00:00:00.000Z" }),
      ],
      baseFilters,
    );
    expect(items.map((i) => i.kind === "run" && i.runId)).toEqual(["new"]);
  });

  it("filters workflow / taskType exactly", () => {
    const items = applyQualityFilters(
      [
        runSource({ runId: "a", workflow: "default" }),
        runSource({ runId: "b", workflow: "custom" }),
      ],
      { ...baseFilters, workflow: "default" },
    );
    expect(items).toHaveLength(1);
  });

  it("filters run-failed without treating cancelled as a run status", () => {
    const items = applyQualityFilters(
      [
        runSource({ runId: "a", runStatus: "failed" }),
        runSource({ runId: "b", runStatus: "completed" }),
      ],
      { ...baseFilters, status: "run-failed" },
    );
    expect(items.map((i) => i.kind === "run" && i.runId)).toEqual(["a"]);
  });

  it("filters task-needs-rework", () => {
    const items = applyQualityFilters(
      [
        taskSource({ taskId: "a", taskStatus: "needs_rework" }),
        taskSource({ taskId: "b", taskStatus: "completed" }),
      ],
      { ...baseFilters, status: "task-needs-rework" },
    );
    expect(items).toHaveLength(1);
  });

  it("filters report-incomplete", () => {
    const items = applyQualityFilters(
      [
        taskSource({ taskId: "a", reportStatus: "incomplete" }),
        taskSource({ taskId: "b", reportStatus: "complete" }),
      ],
      { ...baseFilters, status: "report-incomplete" },
    );
    expect(items).toHaveLength(1);
  });

  it("filters by pattern when classification map provided", () => {
    const map = new Map<string, FailurePatternId[]>([
      ["run:a", ["permission-issue"]],
      ["run:b", ["ci-failure"]],
    ]);
    const items = applyQualityFilters(
      [
        runSource({ runId: "a" }),
        runSource({ runId: "b" }),
      ],
      { ...baseFilters, pattern: "permission-issue" },
      { patternIdsByItemId: map },
    );
    expect(items.map((i) => i.kind === "run" && i.runId)).toEqual(["a"]);
  });
});
