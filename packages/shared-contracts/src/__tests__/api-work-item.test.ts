import { describe, expect, it, expectTypeOf } from "vitest";

import type {
  AcceptWorkItemPlanRequest,
  PlanWorkItemRequest,
  WorkItemDetailResponse,
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
