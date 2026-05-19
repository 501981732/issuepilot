import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentRole,
  CoderAgentReport,
  ReviewerAgentReport,
  TaskNode,
  TestEvidenceAgentReport,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createCoordinator,
  type AgentRunResult,
  type Coordinator,
  type RoleProfileResolver,
  type TaskWriter,
} from "../coordinator.js";
import { createPipelineStore, type PipelineStore } from "../store.js";
import type {
  CoderRoleProfile,
  ReviewerRoleProfile,
  RoleProfile,
  TestEvidenceRoleProfile,
} from "../role-profile.js";

const isoSeq = () => {
  let n = 0;
  return () => `2026-05-19T11:00:${String(n++).padStart(2, "0")}.000Z`;
};

const TASK: TaskNode = {
  taskId: "t_1",
  title: "Demo",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: ["pnpm test"],
  status: "ready",
  runIds: [],
  riskLevel: "low",
};

const WORKITEM: WorkItem = {
  workItemId: "wi_1",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "u",
    title: "t",
  },
  title: "Demo",
  goal: "g",
  acceptanceCriteria: ["AC"],
  status: "ready",
  taskIds: ["t_1"],
  createdAt: "2026-05-19T10:00:00.000Z",
  updatedAt: "2026-05-19T10:00:00.000Z",
};

const coderProfile: CoderRoleProfile = {
  role: "coder",
  roleProfileId: "coder@abc1234",
  prompt: "do",
  promptTemplateHash: "abc12345",
  sandbox: "read_write_worktree",
  toolAllow: [],
  timeoutSeconds: undefined,
  tokenScopeRequirements: undefined,
};
const reviewerProfile: ReviewerRoleProfile = {
  role: "reviewer",
  roleProfileId: "reviewer@abc1234",
  prompt: "review",
  promptTemplateHash: "abc12345",
  sandbox: "read_only_worktree",
  toolAllow: [],
  timeoutSeconds: undefined,
  tokenScopeRequirements: undefined,
  publishToMr: true,
  severityThreshold: "medium",
  maxInlineComments: 25,
};
const teProfile: TestEvidenceRoleProfile = {
  role: "test_evidence",
  roleProfileId: "test_evidence@abc1234",
  prompt: "evidence",
  promptTemplateHash: "abc12345",
  sandbox: "read_only_source_write_evidence",
  toolAllow: [],
  timeoutSeconds: undefined,
  tokenScopeRequirements: undefined,
};

const buildResolver = (): RoleProfileResolver => ({
  async resolveRoleProfile(role: AgentRole): Promise<RoleProfile | null> {
    if (role === "coder") return coderProfile;
    if (role === "reviewer") return reviewerProfile;
    return teProfile;
  },
});

const fakeCoderReport = (
  over: Partial<CoderAgentReport> = {},
): CoderAgentReport => ({
  agentReportId: "ar_coder",
  pipelineRunId: "ignored",
  taskId: "t_1",
  role: "coder",
  roleProfileId: "coder@abc1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
  coder: { diffSummary: "ok", branch: "issuepilot/t_1" },
  ...over,
});

const fakeReviewerReport = (
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport => ({
  agentReportId: "ar_rev",
  pipelineRunId: "ignored",
  taskId: "t_1",
  role: "reviewer",
  roleProfileId: "reviewer@abc1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
  reviewer: {
    summary: "ok",
    decision: "approve_with_comments",
    confidence: 0.8,
    risks: [],
    evidenceRequest: [],
    findings: [],
    inlineComments: [],
    mrPublication: { status: "pending", noteIds: [] },
  },
  ...over,
});

const fakeTeReport = (
  over: Partial<TestEvidenceAgentReport> = {},
): TestEvidenceAgentReport => ({
  agentReportId: "ar_te",
  pipelineRunId: "ignored",
  taskId: "t_1",
  role: "test_evidence",
  roleProfileId: "test_evidence@abc1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
  testEvidence: { evidenceItems: [], baselineEvidence: null },
  ...over,
});

interface TestHarness {
  coordinator: Coordinator;
  store: PipelineStore;
  taskPatches: Array<Partial<TaskNode>>;
  events: Array<{ key: string; payload: Record<string, unknown> }>;
  coderRun: ReturnType<typeof vi.fn>;
  reviewerRun: ReturnType<typeof vi.fn>;
  teRun: ReturnType<typeof vi.fn>;
}

const harness = async (
  agents: Partial<{
    coder: AgentRunResult | (() => AgentRunResult);
    reviewer: AgentRunResult | (() => AgentRunResult);
    testEvidence: AgentRunResult | (() => AgentRunResult);
  }> = {},
): Promise<TestHarness> => {
  const root = await mkdtemp(join(tmpdir(), "ip-coord-"));
  const store = createPipelineStore({ root });
  const events: Array<{ key: string; payload: Record<string, unknown> }> = [];
  const taskPatches: Array<Partial<TaskNode>> = [];
  const taskWriter: TaskWriter = {
    async updateTask({ patch }) {
      taskPatches.push(patch);
    },
  };
  const coderRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.coder === "function") return agents.coder();
    if (agents.coder) return agents.coder;
    return { kind: "report", report: fakeCoderReport() };
  });
  const reviewerRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.reviewer === "function") return agents.reviewer();
    if (agents.reviewer) return agents.reviewer;
    return { kind: "report", report: fakeReviewerReport() };
  });
  const teRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.testEvidence === "function") return agents.testEvidence();
    if (agents.testEvidence) return agents.testEvidence;
    return { kind: "report", report: fakeTeReport() };
  });
  const tick = isoSeq();
  let idCounter = 0;
  const coordinator = createCoordinator({
    pipelineStore: store,
    agents: {
      coder: { run: coderRun },
      reviewer: { run: reviewerRun },
      testEvidence: { run: teRun },
    },
    roleProfileResolver: buildResolver(),
    taskWriter,
    events: { emit: (e) => events.push(e) },
    now: tick,
    newId: () => `pr_${++idCounter}`,
  });
  return { coordinator, store, taskPatches, events, coderRun, reviewerRun, teRun };
};

describe("coordinator coding_only", () => {
  it("coder success → PipelineRun awaiting_human_review，TaskNode awaiting_human_review", async () => {
    const h = await harness();
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_only",
    });
    expect(res.finalStatus).toBe("awaiting_human_review");
    expect(res.pipelineRun.status).toBe("awaiting_human_review");
    expect(res.pipelineRun.recipe).toBe("coding_only");
    expect(res.pipelineRun.recipeSource).toBe("workflow_default");
    expect(res.pipelineRun.agentReportIds.coder).toBe("ar_coder");
    expect(res.pipelineRun.agentReportIds.reviewer).toBeNull();
    expect(res.pipelineRun.agentReportIds.test_evidence).toBeNull();
    expect(h.taskPatches.at(-1)?.status).toBe("awaiting_human_review");
    expect(h.taskPatches.at(-1)?.currentPipelineRunId).toBeUndefined();
    expect(h.events.map((e) => e.key)).toContain("pipeline_finished");
  });

  it("coder failed (coding_failed) → PipelineRun failed，TaskNode failed reason=coding_failed", async () => {
    const h = await harness({
      coder: {
        kind: "report",
        report: fakeCoderReport({
          status: "failed",
          lastError: { code: "coding_failed", message: "build failed" },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_only",
    });
    expect(res.finalStatus).toBe("failed");
    expect(h.taskPatches.at(-1)?.status).toBe("failed");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe("coding_failed");
    expect(h.events.map((e) => e.key)).toContain("coding_failed");
  });

  it("coder cancelled → PipelineRun cancelled，TaskNode needs_rework + last_cancelled_at", async () => {
    const h = await harness({
      coder: { kind: "cancelled", cancelledAt: "2026-05-19T11:05:00.000Z" },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_only",
    });
    expect(res.finalStatus).toBe("cancelled");
    expect(res.pipelineRun.status).toBe("cancelled");
    expect(h.taskPatches.at(-1)?.status).toBe("needs_rework");
    expect(h.taskPatches.at(-1)?.last_cancelled_at).toBe(
      "2026-05-19T11:05:00.000Z",
    );
    expect(h.events.map((e) => e.key)).toContain("coder_cancelled");
  });

  it("pendingRecipe 把 recipeSource 写成 operator_override", async () => {
    const h = await harness();
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "full_pipeline",
      pendingRecipe: "coding_only",
    });
    expect(res.pipelineRun.recipe).toBe("coding_only");
    expect(res.pipelineRun.recipeSource).toBe("operator_override");
  });
});

describe("coordinator coding_plus_reviewer", () => {
  it("approve → awaiting_human_review", async () => {
    const h = await harness();
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_plus_reviewer",
    });
    expect(res.finalStatus).toBe("awaiting_human_review");
    expect(res.reports.map((r) => r.role)).toEqual(["coder", "reviewer"]);
  });

  it("request_changes → PipelineRun awaiting_rework, TaskNode needs_rework", async () => {
    const h = await harness({
      reviewer: {
        kind: "report",
        report: fakeReviewerReport({
          reviewer: {
            summary: "needs work",
            decision: "request_changes",
            confidence: 0.6,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [],
            mrPublication: { status: "pending", noteIds: [] },
          },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_plus_reviewer",
    });
    expect(res.finalStatus).toBe("awaiting_rework");
    expect(h.taskPatches.at(-1)?.status).toBe("needs_rework");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe(
      "reviewer_requested_changes",
    );
    expect(h.events.map((e) => e.key)).toContain("reviewer_requested_changes");
  });

  it("cannot_review → PipelineRun failed, TaskNode blocked reviewer_cannot_review", async () => {
    const h = await harness({
      reviewer: {
        kind: "report",
        report: fakeReviewerReport({
          reviewer: {
            summary: "no scope",
            decision: "cannot_review",
            confidence: 0.0,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [],
            mrPublication: { status: "pending", noteIds: [] },
          },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_plus_reviewer",
    });
    expect(res.finalStatus).toBe("failed");
    expect(h.taskPatches.at(-1)?.status).toBe("blocked");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe(
      "reviewer_cannot_review",
    );
  });

  it("reviewer agent failed (reviewer_unavailable) → PipelineRun failed, TaskNode failed reviewer_unavailable", async () => {
    const h = await harness({
      reviewer: {
        kind: "report",
        report: fakeReviewerReport({
          status: "failed",
          lastError: { code: "reviewer_unavailable", message: "timeout" },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "coding_plus_reviewer",
    });
    expect(res.finalStatus).toBe("failed");
    expect(h.taskPatches.at(-1)?.status).toBe("failed");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe(
      "reviewer_unavailable",
    );
  });
});

describe("coordinator full_pipeline", () => {
  it("3 steps complete → awaiting_human_review，agentReportIds 三项齐", async () => {
    const h = await harness();
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("awaiting_human_review");
    expect(res.pipelineRun.agentReportIds.coder).toBe("ar_coder");
    expect(res.pipelineRun.agentReportIds.reviewer).toBe("ar_rev");
    expect(res.pipelineRun.agentReportIds.test_evidence).toBe("ar_te");
  });

  it("test_evidence incomplete → PipelineRun partial, TaskNode awaiting_human_review reason=evidence_partial", async () => {
    const h = await harness({
      testEvidence: {
        kind: "report",
        report: fakeTeReport({ status: "incomplete" }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("partial");
    expect(h.taskPatches.at(-1)?.status).toBe("awaiting_human_review");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe("evidence_partial");
  });

  it("test_evidence failed (sandbox_violation) → PipelineRun failed, TaskNode failed sandbox_violation", async () => {
    const h = await harness({
      testEvidence: {
        kind: "report",
        report: fakeTeReport({
          status: "failed",
          lastError: { code: "sandbox_violation", message: "boom" },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORKITEM,
      task: TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("failed");
    expect(h.taskPatches.at(-1)?.status).toBe("failed");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe("sandbox_violation");
  });
});
