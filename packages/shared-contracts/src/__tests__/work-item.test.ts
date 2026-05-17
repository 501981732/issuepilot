import { describe, expect, it } from "vitest";

import {
  TASK_NODE_STATUS_VALUES,
  TASK_PLAN_STATUS_VALUES,
  WORK_ITEM_REPORT_STATUS_VALUES,
  WORK_ITEM_STATUS_VALUES,
  isTaskNodeStatus,
  isWorkItemStatus,
  type TaskNode,
  type TaskPlan,
  type TaskPlanEdit,
  type TaskRunLink,
  type WorkItem,
  type WorkItemReport,
} from "../work-item.js";

describe("work-item contracts", () => {
  it("locks the WorkItem status enum", () => {
    expect([...WORK_ITEM_STATUS_VALUES]).toEqual([
      "planning",
      "ready",
      "running",
      "partial",
      "completed",
      "blocked",
    ]);
  });

  it("locks the TaskPlan status enum", () => {
    expect([...TASK_PLAN_STATUS_VALUES]).toEqual([
      "draft",
      "accepted",
      "rejected",
      "superseded",
    ]);
  });

  it("locks the TaskNode status enum", () => {
    expect([...TASK_NODE_STATUS_VALUES]).toEqual([
      "planned",
      "blocked_by_dependency",
      "ready",
      "running",
      "completed",
      "failed",
      "blocked",
      "needs_rework",
      "skipped",
    ]);
  });

  it("locks the WorkItemReport status enum", () => {
    expect([...WORK_ITEM_REPORT_STATUS_VALUES]).toEqual([
      "draft",
      "partial",
      "complete",
      "incomplete",
    ]);
  });

  it("narrows unknown values with isWorkItemStatus", () => {
    expect(isWorkItemStatus("running")).toBe(true);
    expect(isWorkItemStatus("done")).toBe(false);
    expect(isWorkItemStatus(42)).toBe(false);
  });

  it("guards TaskNode status", () => {
    expect(isTaskNodeStatus("blocked_by_dependency")).toBe(true);
    expect(isTaskNodeStatus("queued")).toBe(false);
  });

  it("requires identifier / source / status on WorkItem and JSON round-trips", () => {
    const wi: WorkItem = {
      workItemId: "wi_01",
      sourceIssue: {
        projectId: "g/p",
        iid: 42,
        url: "https://gl/-/issues/42",
        title: "Big",
      },
      title: "Big",
      goal: "Ship",
      acceptanceCriteria: ["AC1", "AC2"],
      status: "ready",
      taskIds: ["t1", "t2"],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:01.000Z",
    };
    const cloned: WorkItem = JSON.parse(JSON.stringify(wi));
    expect(cloned).toEqual(wi);
  });

  it("requires version + accepted timestamp wiring on TaskPlan", () => {
    const plan: TaskPlan = {
      planId: "tp_01",
      workItemId: "wi_01",
      version: 1,
      tasks: [],
      dependencies: [],
      operatorEdits: [],
      status: "accepted",
      acceptedAt: "2026-05-17T00:00:02.000Z",
    };
    expect(plan.status).toBe("accepted");
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("requires canonical TaskRunLink binding", () => {
    const link: TaskRunLink = {
      taskId: "t1",
      runId: "run_aaa",
      attempt: 1,
      status: "completed",
      reportId: "run_aaa",
      branch: "ai/42-task-1",
      startedAt: "2026-05-17T00:00:00.000Z",
      completedAt: "2026-05-17T00:01:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(link))).toEqual(link);
  });

  it("TaskNode carries optional needsReworkReason", () => {
    const t: TaskNode = {
      taskId: "t1",
      title: "T1",
      goal: "g",
      scope: "s",
      dependsOn: [],
      suggestedValidation: [],
      status: "needs_rework",
      runIds: ["run_a"],
      riskLevel: "low",
      needsReworkReason: "Reviewer flagged missing tests",
    };
    expect(JSON.parse(JSON.stringify(t)).needsReworkReason).toBe(
      "Reviewer flagged missing tests",
    );
  });

  it("TaskPlan exposes replanOf provenance", () => {
    const plan: TaskPlan = {
      planId: "tp_02",
      workItemId: "wi_01",
      version: 2,
      tasks: [],
      dependencies: [],
      operatorEdits: [],
      status: "draft",
      replanOf: { planId: "tp_01", taskId: "t2" },
    };
    expect(JSON.parse(JSON.stringify(plan)).replanOf?.taskId).toBe("t2");
  });

  it("TaskPlanEdit.field accepts 'replan'", () => {
    const edit: TaskPlanEdit = {
      taskId: "t2",
      field: "replan",
      before: { title: "Old" },
      after: { title: "New", goal: "Re-do" },
      by: "alice",
      at: "2026-05-17T00:00:00.000Z",
    };
    expect(edit.field).toBe("replan");
  });

  it("requires WorkItemReport summaries plus evidence index", () => {
    const report: WorkItemReport = {
      workItemId: "wi_01",
      overallStatus: "complete",
      taskSummaries: [],
      validationSummary: "All tests green",
      riskSummary: "No high risks",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: ["Reviewer to look at merged tasks"],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
