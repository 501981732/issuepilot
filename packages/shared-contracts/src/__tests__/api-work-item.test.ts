import { describe, expect, it, expectTypeOf } from "vitest";

import type {
  AcceptWorkItemPlanRequest,
  ConfirmEvidenceRequest,
  ConfirmEvidenceResponse,
  MarkTaskReworkRequest,
  PlanWorkItemRequest,
  ReplanTaskRequest,
  UnskipTaskRequest,
  WorkItemDetailResponse,
  WorkItemEvidenceResponse,
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

describe("V4.3 API contracts", () => {
  it("ConfirmEvidenceRequest can omit operator (server uses header)", () => {
    const req: ConfirmEvidenceRequest = {};
    expect(req.operator).toBeUndefined();
    expectTypeOf<ConfirmEvidenceRequest>()
      .toHaveProperty("operator")
      .toEqualTypeOf<string | undefined>();
  });

  it("ConfirmEvidenceResponse echoes evidenceId + report", () => {
    const report: WorkItemReport = {
      workItemId: "wi_01",
      overallStatus: "complete",
      taskSummaries: [],
      validationSummary: "",
      riskSummary: "",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: [],
      humanReviewChecklist: [],
      generatedAt: "2026-05-17T10:00:00.000Z",
    };
    const r: ConfirmEvidenceResponse = {
      evidenceId: "t1:screenshot:run_a:login",
      confirmedAt: "2026-05-17T10:00:00.000Z",
      report,
    };
    expect(r.evidenceId).toBe("t1:screenshot:run_a:login");
    expectTypeOf<ConfirmEvidenceResponse>()
      .toHaveProperty("report")
      .toEqualTypeOf<WorkItemReport>();
  });

  it("WorkItemEvidenceResponse exposes grouped index and missing tasks", () => {
    const r: WorkItemEvidenceResponse = {
      index: [
        {
          taskId: "t1",
          kind: "screenshot",
          evidenceId: "t1:screenshot:run_a:login",
          label: "Login form",
          confidence: "ai-claim",
          source: { runId: "run_a", relPath: "screenshots/login.png" },
        },
      ],
      byTask: {
        t1: [
          {
            taskId: "t1",
            kind: "screenshot",
            evidenceId: "t1:screenshot:run_a:login",
            label: "Login form",
            confidence: "ai-claim",
          },
        ],
      },
      missing: [{ taskId: "t2", reason: "no-run-report" }],
    };
    expect(r.byTask.t1).toHaveLength(1);
    expect(r.missing).toEqual([{ taskId: "t2", reason: "no-run-report" }]);
    expectTypeOf<WorkItemEvidenceResponse>()
      .toHaveProperty("missing")
      .toEqualTypeOf<
        Array<{
          taskId: string;
          reason: "no-run-report" | "no-link" | "incomplete-report";
        }>
      >();
  });

  it("keeps the existing JSON report response separate from report.md", () => {
    expectTypeOf<WorkItemReportResponse>()
      .toHaveProperty("report")
      .toEqualTypeOf<WorkItemReport | undefined>();
  });
});
