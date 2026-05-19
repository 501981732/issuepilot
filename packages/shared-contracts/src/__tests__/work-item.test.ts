import { describe, expect, it } from "vitest";

import {
  EVIDENCE_STATUS_VALUES,
  TASK_NODE_STATUS_VALUES,
  TASK_PLAN_STATUS_VALUES,
  WORK_ITEM_REPORT_STATUS_VALUES,
  WORK_ITEM_STATUS_VALUES,
  TASK_ROLE_FAILURE_REASON_VALUES,
  computeOverallStatus,
  effectiveEvidenceStatus,
  isEvidenceStatus,
  isTaskNodeStatus,
  isTaskRoleFailureReason,
  isWorkItemStatus,
  legacyRunningStateToV46,
  effectiveTaskStatus,
  type TaskNode,
  type TaskPlan,
  type TaskPlanEdit,
  type TaskRunLink,
  type WorkItem,
  type WorkItemReport,
  type WorkItemTaskSummary,
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

  it("locks the TaskNode status enum (V4.6 扩展)", () => {
    expect([...TASK_NODE_STATUS_VALUES]).toEqual([
      "planned",
      "blocked_by_dependency",
      "ready",
      "running",
      "running_coding",
      "running_reviewer",
      "running_test_evidence",
      "awaiting_human_review",
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

  it("TASK_ROLE_FAILURE_REASON_VALUES 严格按 spec §7.3 / §16.2", () => {
    expect(new Set(TASK_ROLE_FAILURE_REASON_VALUES)).toEqual(
      new Set([
        "coding_failed",
        "reviewer_unavailable",
        "reviewer_cannot_review",
        "reviewer_requested_changes",
        "evidence_unavailable",
        "evidence_partial",
        "sandbox_violation",
        "redaction_failed",
        "storage_full",
        "role_profile_invalid",
      ]),
    );
    expect(isTaskRoleFailureReason("coding_failed")).toBe(true);
    // scope_insufficient 是 lastError.code，不是 TaskNode reason
    expect(isTaskRoleFailureReason("scope_insufficient")).toBe(false);
  });

  it("legacyRunningStateToV46 把 running 映射到 running_coding", () => {
    expect(legacyRunningStateToV46("running")).toBe("running_coding");
    expect(legacyRunningStateToV46("ready")).toBe("ready");
    expect(legacyRunningStateToV46("completed")).toBe("completed");
  });

  it("TaskNode 接收 V4.6 新字段", () => {
    const t: TaskNode = {
      taskId: "t_v46",
      title: "T",
      goal: "g",
      scope: "s",
      dependsOn: [],
      suggestedValidation: [],
      status: "running_reviewer",
      runIds: ["run_a"],
      riskLevel: "low",
      pendingRecipe: "coding_plus_reviewer",
      pendingRecipeSource: "operator_override",
      last_cancelled_at: "2026-05-19T00:00:00.000Z",
      roleFailureReason: "reviewer_unavailable",
      currentPipelineRunId: "pr_42",
    };
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });

  it("effectiveTaskStatus 把 running_* 三态映射到旧 running（向后兼容 UI）", () => {
    expect(
      effectiveTaskStatus({ status: "running_coding" }, undefined),
    ).toBe("running");
    expect(
      effectiveTaskStatus({ status: "running_reviewer" }, undefined),
    ).toBe("running");
    expect(
      effectiveTaskStatus({ status: "running_test_evidence" }, undefined),
    ).toBe("running");
    expect(
      effectiveTaskStatus({ status: "awaiting_human_review" }, undefined),
    ).toBe("awaiting_human_review");
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
      humanReviewChecklist: [],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("EVIDENCE_STATUS_VALUES 严格四项", () => {
    expect([...EVIDENCE_STATUS_VALUES]).toEqual([
      "complete",
      "partial",
      "skipped_by_recipe",
      "unavailable",
    ]);
    expect(isEvidenceStatus("complete")).toBe(true);
    expect(isEvidenceStatus("missing")).toBe(false);
  });

  it("effectiveEvidenceStatus 在缺字段时 fallback 到 unavailable", () => {
    expect(effectiveEvidenceStatus({})).toBe("unavailable");
    expect(effectiveEvidenceStatus({ evidenceStatus: "partial" })).toBe(
      "partial",
    );
  });

  it("computeOverallStatus: approve_with_comments + unavailable → 允许 ready_to_merge", () => {
    const summaries: WorkItemTaskSummary[] = [
      {
        taskId: "t1",
        title: "T1",
        taskStatus: "awaiting_human_review",
        validation: [],
        risks: [],
        followUps: [],
        evidenceStatus: "unavailable",
        reviewerDecision: "approve_with_comments",
      },
    ];
    const result = computeOverallStatus(summaries, "complete");
    expect(result.readyToMerge).toBe(true);
    expect(result.veto).toEqual([]);
  });

  it("computeOverallStatus: cannot_review + unavailable → 否决", () => {
    const summaries: WorkItemTaskSummary[] = [
      {
        taskId: "t1",
        title: "T1",
        taskStatus: "blocked",
        validation: [],
        risks: [],
        followUps: [],
        evidenceStatus: "unavailable",
        reviewerDecision: "cannot_review",
      },
    ];
    const result = computeOverallStatus(summaries, "incomplete");
    expect(result.readyToMerge).toBe(false);
    expect(result.veto[0]?.taskId).toBe("t1");
    expect(result.veto[0]?.reviewerDecision).toBe("cannot_review");
  });

  it("computeOverallStatus: request_changes + unavailable → 否决", () => {
    const summaries: WorkItemTaskSummary[] = [
      {
        taskId: "t1",
        title: "T1",
        taskStatus: "needs_rework",
        validation: [],
        risks: [],
        followUps: [],
        evidenceStatus: "unavailable",
        reviewerDecision: "request_changes",
      },
    ];
    const result = computeOverallStatus(summaries, "partial");
    expect(result.readyToMerge).toBe(false);
  });

  it("computeOverallStatus: evidence partial + approve → 允许", () => {
    const summaries: WorkItemTaskSummary[] = [
      {
        taskId: "t1",
        title: "T1",
        taskStatus: "awaiting_human_review",
        validation: [],
        risks: [],
        followUps: [],
        evidenceStatus: "partial",
        reviewerDecision: "approve_with_comments",
      },
    ];
    expect(computeOverallStatus(summaries, "partial").readyToMerge).toBe(true);
  });
});
