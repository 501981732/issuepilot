import { describe, expect, it, expectTypeOf } from "vitest";

import type {
  AcceptWorkItemPlanRequest,
  MarkTaskReworkRequest,
  PlanWorkItemRequest,
  ReplanTaskRequest,
  UnskipTaskRequest,
  WorkItemDetailResponse,
  WorkItemGraphResponse,
  WorkItemReportResponse,
  WorkItemsListResponse,
} from "../api.js";
import type {
  TaskNode,
  TaskPlan,
  TaskPlanEdit,
  TaskRunLink,
  WorkItem,
  WorkItemReport,
  WorkItemStatus,
} from "../work-item.js";

describe("V4.1 API contracts", () => {
  it("WorkItemsListResponse exposes work items + counters covering every status", () => {
    const r: WorkItemsListResponse = {
      workItems: [],
      counters: {
        planning: 0,
        ready: 0,
        running: 0,
        partial: 0,
        completed: 0,
        blocked: 0,
      },
    };
    expect(r.counters.planning).toBe(0);
    expectTypeOf<WorkItemsListResponse>()
      .toHaveProperty("workItems")
      .toEqualTypeOf<WorkItem[]>();
    expectTypeOf<WorkItemsListResponse>()
      .toHaveProperty("counters")
      .toEqualTypeOf<Record<WorkItemStatus, number>>();
  });

  it("WorkItemDetailResponse bundles work item, plan history, tasks, run links and optional report", () => {
    expectTypeOf<WorkItemDetailResponse>()
      .toHaveProperty("workItem")
      .toEqualTypeOf<WorkItem>();
    expectTypeOf<WorkItemDetailResponse>()
      .toHaveProperty("plan")
      .toEqualTypeOf<{ current: TaskPlan; history: TaskPlan[] }>();
    expectTypeOf<WorkItemDetailResponse>()
      .toHaveProperty("tasks")
      .toEqualTypeOf<TaskNode[]>();
    expectTypeOf<WorkItemDetailResponse>()
      .toHaveProperty("runLinks")
      .toEqualTypeOf<TaskRunLink[]>();
    expectTypeOf<WorkItemDetailResponse>()
      .toHaveProperty("report")
      .toEqualTypeOf<WorkItemReport | undefined>();
  });

  it("PlanWorkItemRequest carries the source issue iid and optional regenerate flag", () => {
    const req: PlanWorkItemRequest = { iid: 42 };
    expect(req.iid).toBe(42);
    const reqWithRegenerate: PlanWorkItemRequest = {
      iid: 42,
      regenerate: true,
    };
    expect(reqWithRegenerate.regenerate).toBe(true);
  });

  it("AcceptWorkItemPlanRequest carries planId + edits + operator", () => {
    const edit: AcceptWorkItemPlanRequest["edits"][number] = {
      taskId: "t1",
      field: "title",
      after: "new title",
    };
    const req: AcceptWorkItemPlanRequest = {
      planId: "tp_01",
      edits: [edit],
      operator: "user",
    };
    expect(req.operator).toBe("user");
    expect(req.edits[0]?.field).toBe("title");
    expectTypeOf<TaskPlanEdit["field"]>().toEqualTypeOf<
      AcceptWorkItemPlanRequest["edits"][number]["field"]
    >();
  });

  it("WorkItemReportResponse round-trips with optional report", () => {
    const empty: WorkItemReportResponse = { report: undefined };
    expect(empty.report).toBeUndefined();
    expectTypeOf<WorkItemReportResponse>()
      .toHaveProperty("report")
      .toEqualTypeOf<WorkItemReport | undefined>();
  });
});

describe("V4.2 API contracts", () => {
  it("ReplanTaskRequest requires a human-readable reason", () => {
    const req: ReplanTaskRequest = { reason: "Sub-task was too broad" };
    expect(req.reason.length).toBeGreaterThan(0);
    expectTypeOf<ReplanTaskRequest>()
      .toHaveProperty("reason")
      .toEqualTypeOf<string>();
    expectTypeOf<ReplanTaskRequest>()
      .toHaveProperty("hint")
      .toEqualTypeOf<string | undefined>();
  });

  it("MarkTaskReworkRequest mirrors review-driven rework", () => {
    const req: MarkTaskReworkRequest = { reason: "Reviewer asked for tests" };
    expect(req.reason.length).toBeGreaterThan(0);
    expectTypeOf<MarkTaskReworkRequest>()
      .toHaveProperty("reason")
      .toEqualTypeOf<string>();
  });

  it("UnskipTaskRequest may omit operator (server falls back to header)", () => {
    const req: UnskipTaskRequest = {};
    expect(req.operator).toBeUndefined();
    expectTypeOf<UnskipTaskRequest>()
      .toHaveProperty("operator")
      .toEqualTypeOf<string | undefined>();
  });

  it("WorkItemGraphResponse exposes layered DAG + critical path", () => {
    const r: WorkItemGraphResponse = {
      levels: [["t1"], ["t2", "t3"]],
      edges: [
        { from: "t1", to: "t2" },
        { from: "t1", to: "t3" },
      ],
      criticalPathTaskIds: ["t1", "t2"],
    };
    expect(r.levels.length).toBe(2);
    expect(r.edges).toHaveLength(2);
    expect(r.criticalPathTaskIds).toEqual(["t1", "t2"]);
    expectTypeOf<WorkItemGraphResponse>()
      .toHaveProperty("levels")
      .toEqualTypeOf<string[][]>();
    expectTypeOf<WorkItemGraphResponse>()
      .toHaveProperty("edges")
      .toEqualTypeOf<Array<{ from: string; to: string }>>();
    expectTypeOf<WorkItemGraphResponse>()
      .toHaveProperty("criticalPathTaskIds")
      .toEqualTypeOf<string[]>();
  });
});
