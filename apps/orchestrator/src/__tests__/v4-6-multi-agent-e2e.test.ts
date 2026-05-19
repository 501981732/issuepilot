/**
 * V4.6 Multi-Agent Collaboration — end-to-end orchestration suite
 * (plan Task 12.1 / spec §22.7)。
 *
 * 把 Coordinator + PipelineStore + PipelineService 拼成一个最小完整闭环,
 * 用 fake agent runners + fake MR publisher 模拟 9 个场景, 验证：
 *   (1) full_pipeline happy path
 *   (2) reviewer request_changes → operator 重跑 coder → reviewer 第二轮 approve
 *   (3) test_evidence partial → 任务进入 awaiting_human_review (evidence_partial)
 *   (4) reviewer cannot_review (scope_insufficient) → TaskNode blocked
 *   (5) sandbox_violation (reviewer / test_evidence) → TaskNode failed
 *   (6) cancel mid-pipeline + retry 清空 last_cancelled_at
 *   (7) coding_only recipe → 仅 coder + awaiting_human_review
 *   (8) reviewer skip → coordinator 推进到 test_evidence (单元覆盖在 service 层)
 *   (9) test_evidence retry → supersede + evidenceStatus 升级
 *
 * 注意：本 e2e 复用 coordinator.test.ts 中已有的 harness 风格(fakeCoderReport
 * 等), 只重新组合在更高粒度。spec §22.7 第 6/8 场景与 service 层 cancel/skip
 * API 强相关, 已经在 `pipelines/__tests__/service.test.ts` 覆盖完整 happy
 * + error 路径, 本 suite 不重复 mock cancel HTTP 调用, 而是用 coordinator 直
 * 接观察 last_cancelled_at 在 retry 时被清空。
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentReport,
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
  type ReviewerMrPublisher,
  type RoleProfileResolver,
  type TaskWriter,
} from "../pipelines/coordinator.js";
import { createPipelineStore } from "../pipelines/store.js";
import type {
  CoderRoleProfile,
  ReviewerRoleProfile,
  RoleProfile,
  TestEvidenceRoleProfile,
} from "../pipelines/role-profile.js";

const WORK_ITEM: WorkItem = {
  workItemId: "wi_e2e",
  sourceIssue: { projectId: "g/p", iid: 42, url: "u", title: "Demo" },
  title: "Demo",
  goal: "ship a feature",
  acceptanceCriteria: ["AC"],
  status: "ready",
  taskIds: ["t_e2e"],
  createdAt: "2026-05-19T10:00:00.000Z",
  updatedAt: "2026-05-19T10:00:00.000Z",
};

const BASE_TASK: TaskNode = {
  taskId: "t_e2e",
  title: "Demo",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: ["pnpm test"],
  status: "ready",
  runIds: [],
  riskLevel: "low",
};

const coderProfile: CoderRoleProfile = {
  role: "coder",
  roleProfileId: "coder@cafe1234",
  prompt: "do",
  promptTemplateHash: "cafe1234",
  sandbox: "read_write_worktree",
  toolAllow: [],
  timeoutSeconds: undefined,
  tokenScopeRequirements: undefined,
};
const reviewerProfile: ReviewerRoleProfile = {
  role: "reviewer",
  roleProfileId: "reviewer@cafe1234",
  prompt: "review",
  promptTemplateHash: "cafe1234",
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
  roleProfileId: "test_evidence@cafe1234",
  prompt: "te",
  promptTemplateHash: "cafe1234",
  sandbox: "read_only_source_write_evidence",
  toolAllow: [],
  timeoutSeconds: undefined,
  tokenScopeRequirements: undefined,
};

const resolver: RoleProfileResolver = {
  async resolveRoleProfile(role: AgentRole): Promise<RoleProfile | null> {
    if (role === "coder") return coderProfile;
    if (role === "reviewer") return reviewerProfile;
    return teProfile;
  },
};

const fakeCoder = (
  over: Partial<CoderAgentReport> = {},
): CoderAgentReport => ({
  agentReportId: "ar_coder",
  pipelineRunId: "ignored",
  taskId: "t_e2e",
  role: "coder",
  roleProfileId: "coder@cafe1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
  coder: { diffSummary: "ok", branch: "issuepilot/t_e2e" } as unknown as CoderAgentReport["coder"],
  ...over,
});

const fakeReviewer = (
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport => ({
  agentReportId: "ar_rev",
  pipelineRunId: "ignored",
  taskId: "t_e2e",
  role: "reviewer",
  roleProfileId: "reviewer@cafe1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
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

const fakeTe = (
  over: Partial<TestEvidenceAgentReport> = {},
): TestEvidenceAgentReport => ({
  agentReportId: "ar_te",
  pipelineRunId: "ignored",
  taskId: "t_e2e",
  role: "test_evidence",
  roleProfileId: "test_evidence@cafe1234",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
  testEvidence: { evidenceItems: [], baselineEvidence: null },
  ...over,
});

const isoSeq = () => {
  let n = 0;
  return () => `2026-05-19T11:00:${String(n++).padStart(2, "0")}.000Z`;
};

interface E2EHarness {
  coordinator: ReturnType<typeof createCoordinator>;
  store: ReturnType<typeof createPipelineStore>;
  taskPatches: Array<Partial<TaskNode>>;
  events: Array<{ key: string; payload: Record<string, unknown> }>;
  coderRun: ReturnType<typeof vi.fn>;
  reviewerRun: ReturnType<typeof vi.fn>;
  teRun: ReturnType<typeof vi.fn>;
  publishCalls: Array<{ decision: string }>;
}

const buildE2E = async (
  agents: Partial<{
    coder: AgentRunResult | (() => AgentRunResult);
    reviewer: AgentRunResult | (() => AgentRunResult);
    testEvidence: AgentRunResult | (() => AgentRunResult);
  }> = {},
  publisher?: ReviewerMrPublisher,
): Promise<E2EHarness> => {
  const root = await mkdtemp(join(tmpdir(), "ip-v46-e2e-"));
  const store = createPipelineStore({ root });
  const events: E2EHarness["events"] = [];
  const taskPatches: Array<Partial<TaskNode>> = [];
  const taskWriter: TaskWriter = {
    async updateTask({ patch }) {
      taskPatches.push(patch);
    },
  };
  const coderRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.coder === "function") return agents.coder();
    if (agents.coder) return agents.coder;
    return { kind: "report", report: fakeCoder() };
  });
  const reviewerRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.reviewer === "function") return agents.reviewer();
    if (agents.reviewer) return agents.reviewer;
    return { kind: "report", report: fakeReviewer() };
  });
  const teRun = vi.fn(async (): Promise<AgentRunResult> => {
    if (typeof agents.testEvidence === "function") return agents.testEvidence();
    if (agents.testEvidence) return agents.testEvidence;
    return { kind: "report", report: fakeTe() };
  });
  const tick = isoSeq();
  let idCounter = 0;
  const publishCalls: E2EHarness["publishCalls"] = [];
  const wrappedPublisher: ReviewerMrPublisher | undefined = publisher
    ? {
        async publish(input) {
          publishCalls.push({ decision: input.reviewerReport.reviewer.decision });
          return publisher.publish(input);
        },
      }
    : undefined;
  const coordinator = createCoordinator({
    pipelineStore: store,
    agents: {
      coder: { run: coderRun },
      reviewer: { run: reviewerRun },
      testEvidence: { run: teRun },
      ...(wrappedPublisher ? { reviewerPublisher: wrappedPublisher } : {}),
    },
    roleProfileResolver: resolver,
    taskWriter,
    events: { emit: (e) => events.push(e) },
    now: tick,
    newId: () => `pr_e2e_${++idCounter}`,
  });
  return { coordinator, store, taskPatches, events, coderRun, reviewerRun, teRun, publishCalls };
};

describe("V4.6 multi-agent e2e — full_pipeline happy path", () => {
  it("coder + reviewer (approve) + test_evidence (complete) → awaiting_human_review", async () => {
    const h = await buildE2E();
    const res = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("awaiting_human_review");
    expect(res.pipelineRun.agentReportIds.coder).toBe("ar_coder");
    expect(res.pipelineRun.agentReportIds.reviewer).toBe("ar_rev");
    expect(res.pipelineRun.agentReportIds.test_evidence).toBe("ar_te");
    expect(h.coderRun).toHaveBeenCalledTimes(1);
    expect(h.reviewerRun).toHaveBeenCalledTimes(1);
    expect(h.teRun).toHaveBeenCalledTimes(1);
    expect(h.taskPatches.at(-1)?.status).toBe("awaiting_human_review");
  });
});

describe("V4.6 multi-agent e2e — reviewer request_changes loop", () => {
  it("reviewer request_changes → coordinator marks needs_rework, retry coder + reviewer approve closes loop", async () => {
    const h = await buildE2E({
      reviewer: {
        kind: "report",
        report: fakeReviewer({
          reviewer: {
            summary: "logic issue",
            decision: "request_changes",
            confidence: 0.7,
            risks: [],
            evidenceRequest: [],
            findings: [
              { severity: "high", category: "logic-error", message: "off-by-one" },
            ],
            inlineComments: [],
            mrPublication: { status: "pending", noteIds: [] },
          },
        }),
      },
    });
    const first = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(first.finalStatus).toBe("awaiting_rework");
    // operator retries coder
    let idx = 100;
    h.coderRun.mockImplementation(async () => ({
      kind: "report",
      report: fakeCoder({ agentReportId: `ar_coder_retry_${++idx}` }),
    }));
    h.reviewerRun.mockImplementation(async () => ({
      kind: "report",
      report: fakeReviewer({ agentReportId: `ar_rev_retry_${idx}` }),
    }));
    h.teRun.mockImplementation(async () => ({
      kind: "report",
      report: fakeTe({ agentReportId: `ar_te_retry_${idx}` }),
    }));
    const retry = await h.coordinator.retryRole({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      pipelineRunId: first.pipelineRun.pipelineRunId,
      role: "coder",
    });
    // After coder retry, the coordinator should resume the pipeline through
    // reviewer + test_evidence, ending in awaiting_human_review.
    expect(retry.pipelineRun.status).toBe("awaiting_human_review");
    expect(retry.report.role).toBe("coder");
    expect(retry.report.supersedes).toBe(first.pipelineRun.agentReportIds.coder!);
  });
});

describe("V4.6 multi-agent e2e — test_evidence partial → awaiting_human_review", () => {
  it("test_evidence incomplete → PipelineRun partial, TaskNode awaiting_human_review (evidence_partial)", async () => {
    const h = await buildE2E({
      testEvidence: {
        kind: "report",
        report: fakeTe({ status: "incomplete" }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("partial");
    const final = h.taskPatches.at(-1);
    expect(final?.status).toBe("awaiting_human_review");
    expect(final?.roleFailureReason ?? final?.statusReason).toMatch(
      /evidence_partial|partial/,
    );
  });
});

describe("V4.6 multi-agent e2e — reviewer cannot_review (scope_insufficient)", () => {
  it("scope_insufficient promotes reviewer report to failed and blocks TaskNode (reviewer_cannot_review)", async () => {
    const h = await buildE2E(
      {
        reviewer: {
          kind: "report",
          report: fakeReviewer({
            reviewer: {
              summary: "blocked",
              decision: "approve_with_comments",
              confidence: 0.9,
              risks: [],
              evidenceRequest: [],
              findings: [],
              inlineComments: [],
              mrPublication: { status: "pending", noteIds: [] },
            },
          }),
        },
      },
      {
        publish: vi.fn(async () => ({
          mrPublication: {
            status: "publish_failed" as const,
            noteIds: [],
            failureReason: "scope_insufficient",
          },
          redactedFieldsAdded: [],
          scopeInsufficient: { missingScope: "api" } as const,
        })),
      },
    );
    const res = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("failed");
    const reviewerReport = res.reports.find((r) => r.role === "reviewer")!;
    expect(reviewerReport.status).toBe("failed");
    expect(reviewerReport.lastError?.code).toBe("scope_insufficient");
    const final = h.taskPatches.at(-1);
    expect(final?.status).toBe("blocked");
    expect(final?.roleFailureReason).toBe("reviewer_cannot_review");
  });
});

describe("V4.6 multi-agent e2e — sandbox violation", () => {
  it("test_evidence sandbox_violation → PipelineRun failed, TaskNode failed (sandbox_violation)", async () => {
    const h = await buildE2E({
      testEvidence: {
        kind: "report",
        report: fakeTe({
          status: "failed",
          lastError: { code: "sandbox_violation", message: "wrote outside worktree" },
        }),
      },
    });
    const res = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(res.finalStatus).toBe("failed");
    expect(h.taskPatches.at(-1)?.status).toBe("failed");
    expect(h.taskPatches.at(-1)?.roleFailureReason).toBe("sandbox_violation");
  });
});

describe("V4.6 multi-agent e2e — cancel mid-pipeline + last_cancelled_at cleared on next startPipeline", () => {
  it("coder cancelled writes last_cancelled_at; starting a fresh pipeline clears it", async () => {
    const h = await buildE2E({
      coder: { kind: "cancelled", cancelledAt: "2026-05-19T11:05:00.000Z" },
    });
    const first = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(first.finalStatus).toBe("cancelled");
    expect(first.pipelineRun.status).toBe("cancelled");
    const cancelledPatch = h.taskPatches.find((p) => p.last_cancelled_at);
    expect(cancelledPatch).toBeDefined();

    // operator starts a fresh pipeline; coordinator clears last_cancelled_at
    h.coderRun.mockImplementation(async () => ({
      kind: "report",
      report: fakeCoder({ agentReportId: "ar_coder_round2" }),
    }));
    const second = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: { ...BASE_TASK, last_cancelled_at: cancelledPatch?.last_cancelled_at as string },
      workflowDefault: "full_pipeline",
    });
    expect(second.finalStatus).toBe("awaiting_human_review");
    const clearedPatch = h.taskPatches.find(
      (p) => "last_cancelled_at" in p && p.last_cancelled_at === undefined,
    );
    expect(clearedPatch).toBeDefined();
  });
});

describe("V4.6 multi-agent e2e — coding_only recipe", () => {
  it("only coder runs; PipelineRun awaiting_human_review with reviewer/test_evidence ids null", async () => {
    const h = await buildE2E();
    const res = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "coding_only",
    });
    expect(res.finalStatus).toBe("awaiting_human_review");
    expect(res.pipelineRun.agentReportIds.coder).toBe("ar_coder");
    expect(res.pipelineRun.agentReportIds.reviewer).toBeNull();
    expect(res.pipelineRun.agentReportIds.test_evidence).toBeNull();
    expect(h.reviewerRun).not.toHaveBeenCalled();
    expect(h.teRun).not.toHaveBeenCalled();
  });
});

describe("V4.6 multi-agent e2e — test_evidence retry supersede chain", () => {
  it("retry test_evidence after partial → new report supersedes old, pipeline awaiting_human_review", async () => {
    const h = await buildE2E({
      testEvidence: {
        kind: "report",
        report: fakeTe({ status: "incomplete" }),
      },
    });
    const first = await h.coordinator.startPipeline({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      workflowDefault: "full_pipeline",
    });
    expect(first.finalStatus).toBe("partial");
    const firstTeId = first.pipelineRun.agentReportIds.test_evidence!;

    let idx = 200;
    h.teRun.mockImplementation(async () => ({
      kind: "report",
      report: fakeTe({
        agentReportId: `ar_te_retry_${++idx}`,
        status: "complete",
      }),
    }));
    const retry = await h.coordinator.retryRole({
      workItem: WORK_ITEM,
      task: BASE_TASK,
      pipelineRunId: first.pipelineRun.pipelineRunId,
      role: "test_evidence",
    });
    expect(retry.pipelineRun.status).toBe("awaiting_human_review");
    expect(retry.report.supersedes).toBe(firstTeId);
    const list = await h.store.listAgentReportsForRole({
      taskId: BASE_TASK.taskId,
      role: "test_evidence",
    });
    expect(list.index.supersedeChain).toEqual([
      { from: firstTeId, to: retry.report.agentReportId },
    ]);
    expect(list.index.latestAgentReportId).toBe(retry.report.agentReportId);
  });
});

// Notes: scenario 8 (reviewer skip → coordinator 推进到 test_evidence)
// 已经在 `apps/orchestrator/src/pipelines/__tests__/service.test.ts` 的 skip 流程
// 中完整测试 (operator → service.skipRole → coordinator)，本 e2e 不重复 mock
// service 层。
const _suppressUnused: AgentReport[] = [];
void _suppressUnused;
