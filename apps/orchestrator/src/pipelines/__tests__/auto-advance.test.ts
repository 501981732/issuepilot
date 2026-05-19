import type {
  CoderAgentReport,
  PipelineRun,
  ReviewerAgentReport,
  TaskNode,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  createAutoAdvance,
  nextPipelineStatusFor,
  shouldAutoAdvance,
} from "../auto-advance.js";

const baseRun = (recipe: PipelineRun["recipe"]): PipelineRun => ({
  pipelineRunId: "pr_1",
  workItemId: "wi_1",
  taskId: "t_1",
  recipe,
  recipeSource: "workflow_default",
  agentReportIds: { coder: "ar_c", reviewer: null, test_evidence: null },
  status: "running_coding",
  currentRole: "coder",
  createdAt: "t0",
  updatedAt: "t0",
});

const coderReport = (over: Partial<CoderAgentReport> = {}): CoderAgentReport => ({
  agentReportId: "ar_c",
  pipelineRunId: "pr_1",
  taskId: "t_1",
  role: "coder",
  roleProfileId: "coder@x",
  status: "complete",
  startedAt: "t0",
  evidenceLinks: [],
  redactedFields: [],
  coder: { diffSummary: "ok", branch: "issuepilot/t_1" },
  ...over,
});

const reviewerReport = (
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport => ({
  agentReportId: "ar_r",
  pipelineRunId: "pr_1",
  taskId: "t_1",
  role: "reviewer",
  roleProfileId: "reviewer@x",
  status: "complete",
  startedAt: "t0",
  evidenceLinks: [],
  redactedFields: [],
  reviewer: {
    summary: "ok",
    decision: "approve_with_comments",
    confidence: 0.9,
    risks: [],
    evidenceRequest: [],
    findings: [],
    inlineComments: [],
    mrPublication: { status: "pending", noteIds: [] },
  },
  ...over,
});

const baseTask: TaskNode = {
  taskId: "t_1",
  title: "T",
  goal: "",
  scope: "",
  dependsOn: [],
  suggestedValidation: [],
  status: "running_coding",
  runIds: [],
  riskLevel: "low",
};

describe("shouldAutoAdvance", () => {
  it("coder.complete + recipe coding_plus_reviewer → advance to reviewer", () => {
    const res = shouldAutoAdvance({
      pipelineRun: baseRun("coding_plus_reviewer"),
      finishedReport: coderReport(),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: true, nextRole: "reviewer" });
  });

  it("coder.complete + recipe coding_only → no advance（已末端）", () => {
    const res = shouldAutoAdvance({
      pipelineRun: { ...baseRun("coding_only"), recipe: "coding_only" },
      finishedReport: coderReport(),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("task.last_cancelled_at 存在 → 抑制 auto-advance", () => {
    const res = shouldAutoAdvance({
      pipelineRun: baseRun("full_pipeline"),
      finishedReport: coderReport(),
      task: { taskId: "t_1", last_cancelled_at: "2026-05-19T11:00:00.000Z" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("AgentReport.status = failed → 不推进", () => {
    const res = shouldAutoAdvance({
      pipelineRun: baseRun("full_pipeline"),
      finishedReport: coderReport({
        status: "failed",
        lastError: { code: "coding_failed", message: "" },
      }),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("AgentReport.status = cancelled → 不推进", () => {
    const res = shouldAutoAdvance({
      pipelineRun: baseRun("full_pipeline"),
      finishedReport: coderReport({ status: "cancelled" }),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("reviewer.request_changes → 不推进", () => {
    const res = shouldAutoAdvance({
      pipelineRun: { ...baseRun("full_pipeline"), currentRole: "reviewer" },
      finishedReport: reviewerReport({
        reviewer: {
          summary: "x",
          decision: "request_changes",
          confidence: 0.5,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "pending", noteIds: [] },
        },
      }),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("reviewer.cannot_review → 不推进", () => {
    const res = shouldAutoAdvance({
      pipelineRun: { ...baseRun("full_pipeline"), currentRole: "reviewer" },
      finishedReport: reviewerReport({
        reviewer: {
          summary: "x",
          decision: "cannot_review",
          confidence: 0,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "pending", noteIds: [] },
        },
      }),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: false });
  });

  it("reviewer.approve_with_comments → advance to test_evidence", () => {
    const res = shouldAutoAdvance({
      pipelineRun: { ...baseRun("full_pipeline"), currentRole: "reviewer" },
      finishedReport: reviewerReport(),
      task: { taskId: "t_1" },
    });
    expect(res).toEqual({ advance: true, nextRole: "test_evidence" });
  });
});

describe("nextPipelineStatusFor", () => {
  it.each([
    ["coder", "running_coding"],
    ["reviewer", "running_reviewer"],
    ["test_evidence", "running_test_evidence"],
  ] as const)("%s → %s", (role, status) => {
    expect(nextPipelineStatusFor(role)).toBe(status);
  });
});

describe("createAutoAdvance", () => {
  it("作为 trigger 包装 shouldAutoAdvance，可被 EventBus 调用", () => {
    const trigger = createAutoAdvance();
    const res = trigger.onAgentReportFinalized({
      pipelineRun: baseRun("full_pipeline"),
      finishedReport: coderReport(),
      task: baseTask,
    });
    expect(res).toEqual({ advance: true, nextRole: "reviewer" });
  });
});
