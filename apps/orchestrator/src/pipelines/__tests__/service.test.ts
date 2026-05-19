import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentReport,
  CoderAgentReport,
  PipelineRun,
  ReviewerAgentReport,
  TaskNode,
  TestEvidenceAgentReport,
  WorkItem,
  WorkflowRolesConfig,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Coordinator } from "../coordinator.js";
import { createPipelineService, type PipelineService } from "../service.js";
import { createPipelineStore, type PipelineStore } from "../store.js";

const WORK_ITEM: WorkItem = {
  workItemId: "wi_1",
  sourceIssue: { projectId: "g/p", iid: 42, url: "u", title: "t" },
  title: "Demo",
  goal: "g",
  acceptanceCriteria: ["AC"],
  status: "ready",
  taskIds: ["t_1"],
  createdAt: "2026-05-19T10:00:00.000Z",
  updatedAt: "2026-05-19T10:00:00.000Z",
};

const baseTask: TaskNode = {
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

const buildPipelineRun = (over: Partial<PipelineRun> = {}): PipelineRun => ({
  pipelineRunId: "pr_1",
  workItemId: "wi_1",
  taskId: "t_1",
  recipe: "full_pipeline",
  recipeSource: "workflow_default",
  agentReportIds: { coder: null, reviewer: null, test_evidence: null },
  status: "running_coding",
  currentRole: "coder",
  createdAt: "2026-05-19T11:00:00.000Z",
  updatedAt: "2026-05-19T11:00:00.000Z",
  ...over,
});

const buildReviewerReport = (
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport => ({
  agentReportId: "ar_reviewer",
  pipelineRunId: "pr_1",
  taskId: "t_1",
  role: "reviewer",
  roleProfileId: "reviewer@abc",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  completedAt: "2026-05-19T11:00:10.000Z",
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
    mrPublication: { status: "published", noteIds: ["n1", "n2"] },
  },
  ...over,
});

const buildCoderReport = (
  over: Partial<CoderAgentReport> = {},
): CoderAgentReport => ({
  agentReportId: "ar_coder",
  pipelineRunId: "pr_1",
  taskId: "t_1",
  role: "coder",
  roleProfileId: "coder@abc",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  completedAt: "2026-05-19T11:00:05.000Z",
  evidenceLinks: [],
  redactedFields: [],
  coder: { diffSummary: "ok", branch: "issuepilot/t_1" },
  ...over,
});

const buildTestEvidenceReport = (
  over: Partial<TestEvidenceAgentReport> = {},
): TestEvidenceAgentReport => ({
  agentReportId: "ar_te",
  pipelineRunId: "pr_1",
  taskId: "t_1",
  role: "test_evidence",
  roleProfileId: "test_evidence@abc",
  status: "complete",
  startedAt: "2026-05-19T11:00:00.000Z",
  completedAt: "2026-05-19T11:00:20.000Z",
  evidenceLinks: [],
  redactedFields: [],
  testEvidence: { evidenceItems: [], summary: "ok" },
  ...over,
});

const buildRoles = (): WorkflowRolesConfig => ({
  coder: {
    role: "coder",
    promptTemplate: "/tmp/coder.md",
    promptTemplateHash: "deadbeef",
    sandbox: "read_write_worktree",
  },
  reviewer: {
    role: "reviewer",
    promptTemplate: "/tmp/reviewer.md",
    promptTemplateHash: "deadbeef",
    sandbox: "read_only_worktree",
  },
  test_evidence: {
    role: "test_evidence",
    promptTemplate: "/tmp/te.md",
    promptTemplateHash: "deadbeef",
    sandbox: "read_only_source_write_evidence",
  },
});

interface Harness {
  service: PipelineService;
  store: PipelineStore;
  saveTask(patch: Partial<TaskNode>): Promise<void>;
  loadTask(): Promise<TaskNode>;
  coordinator: {
    retryRole: ReturnType<typeof vi.fn>;
    startPipeline: ReturnType<typeof vi.fn>;
  };
  revokeMrComments: ReturnType<typeof vi.fn>;
}

const buildHarness = async (
  opts: {
    task?: Partial<TaskNode>;
    roles?: WorkflowRolesConfig;
    workflowDefault?: "full_pipeline" | "coding_plus_reviewer" | "coding_only";
  } = {},
): Promise<Harness & { tempRoot: string }> => {
  const tempRoot = await mkdtemp(join(tmpdir(), "v46-svc-"));
  const store = createPipelineStore({ root: tempRoot });
  const taskState: { current: TaskNode } = {
    current: { ...baseTask, ...(opts.task ?? {}) },
  };
  const workItemState: { current: WorkItem } = { current: { ...WORK_ITEM } };

  const coordinator: Harness["coordinator"] = {
    retryRole: vi.fn(),
    startPipeline: vi.fn(),
  };
  const revokeMrComments = vi.fn(async () => ({ revokedAt: "2026-05-19T12:00:00.000Z" }));

  const service = createPipelineService({
    pipelineStore: store,
    coordinator: coordinator as unknown as Coordinator,
    workItems: {
      getWorkItem: async (id) =>
        id === workItemState.current.workItemId ? workItemState.current : undefined,
      getTask: async ({ workItemId, taskId }) =>
        workItemId === workItemState.current.workItemId &&
        taskId === taskState.current.taskId
          ? taskState.current
          : undefined,
      updateTask: async (input) => {
        if (
          input.workItemId === workItemState.current.workItemId &&
          input.taskId === taskState.current.taskId
        ) {
          // strip undefined entries to mirror exactOptionalPropertyTypes contract
          const patch = Object.fromEntries(
            Object.entries(input.patch).filter(([, v]) => v !== undefined),
          ) as Partial<TaskNode>;
          taskState.current = { ...taskState.current, ...patch };
        }
      },
    },
    workflow: {
      getDefaultRecipe: () => opts.workflowDefault ?? "full_pipeline",
      getRoles: () => opts.roles ?? buildRoles(),
    },
    revokeReviewerMrComments: revokeMrComments,
    now: () => "2026-05-19T12:00:00.000Z",
  });

  return {
    tempRoot,
    service,
    store,
    coordinator,
    revokeMrComments,
    async saveTask(patch) {
      taskState.current = { ...taskState.current, ...patch };
    },
    async loadTask() {
      return taskState.current;
    },
  };
};

describe("createPipelineService", () => {
  let cleanup: Array<() => Promise<void>> = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    for (const fn of cleanup) await fn();
  });

  it("getPipelineForTask returns null + pendingRecipe when no pipeline yet", async () => {
    const h = await buildHarness({
      task: { status: "ready", pendingRecipe: "coding_plus_reviewer" },
    });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.getPipelineForTask({
      workItemId: "wi_1",
      taskId: "t_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pipelineRun).toBeNull();
    expect(result.value.pendingRecipe).toBe("coding_plus_reviewer");
    expect(result.value.agentReports).toEqual([]);
  });

  it("getPipelineForTask returns latest pipeline + agent report summaries", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    const run = buildPipelineRun({
      status: "awaiting_human_review",
      currentRole: null,
      agentReportIds: {
        coder: "ar_coder",
        reviewer: "ar_reviewer",
        test_evidence: null,
      },
    });
    await h.store.savePipelineRun(run);
    await h.store.saveAgentReport(buildCoderReport());
    await h.store.saveAgentReport(buildReviewerReport());
    await h.saveTask({ currentPipelineRunId: "pr_1" });

    const result = await h.service.getPipelineForTask({
      workItemId: "wi_1",
      taskId: "t_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pipelineRun?.pipelineRunId).toBe("pr_1");
    const roles = result.value.agentReports.map((r) => r.role).sort();
    expect(roles).toEqual(["coder", "reviewer"]);
    const reviewer = result.value.agentReports.find((r) => r.role === "reviewer");
    expect(reviewer?.decision).toBe("approve_with_comments");
  });

  it("setRecipeOverride writes pendingRecipe when task is planned", async () => {
    const h = await buildHarness({ task: { status: "planned" } });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.setRecipeOverride({
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "coding_only",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appliedTo).toBe("pending");
    expect(result.value.recipe).toBe("coding_only");
    const task = await h.loadTask();
    expect(task.pendingRecipe).toBe("coding_only");
    expect(task.pendingRecipeSource).toBe("operator_override");
  });

  it("setRecipeOverride rejects unknown recipe with 400", async () => {
    const h = await buildHarness({ task: { status: "planned" } });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.setRecipeOverride({
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "weird" as unknown as "coding_only",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown_recipe");
  });

  it("setRecipeOverride returns 409 when task is already running_coding", async () => {
    const h = await buildHarness({
      task: { status: "running_coding", currentPipelineRunId: "pr_1" },
    });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.savePipelineRun(buildPipelineRun({ status: "running_coding" }));

    const result = await h.service.setRecipeOverride({
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "coding_only",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("recipe_override_locked");
  });

  it("setRecipeOverride writes pipelineRun.recipe when task is ready with draft PipelineRun", async () => {
    const h = await buildHarness({
      task: { status: "ready", currentPipelineRunId: "pr_1" },
    });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    // A PipelineRun in a non-running state (cancelled after an operator
    // stop) still keeps `currentPipelineRunId` on the TaskNode until the
    // orchestrator starts a fresh one; spec §8.1 allows recipe-override
    // against that draft so operator can pick a different recipe before
    // dispatch retries.
    await h.store.savePipelineRun(
      buildPipelineRun({
        status: "cancelled",
        recipe: "full_pipeline",
        currentRole: null,
        agentReportIds: { coder: null, reviewer: null, test_evidence: null },
      }),
    );

    const result = await h.service.setRecipeOverride({
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "coding_plus_reviewer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.appliedTo).toBe("pipeline_run");
    expect(result.value.recipe).toBe("coding_plus_reviewer");
    const reread = await h.store.getPipelineRunById({
      workItemId: "wi_1",
      taskId: "t_1",
      pipelineRunId: "pr_1",
    });
    expect(reread?.recipe).toBe("coding_plus_reviewer");
    expect(reread?.recipeSource).toBe("operator_override");
  });

  it("revokeAiReview deletes notes and marks mrPublication revoked", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.saveAgentReport(buildReviewerReport());

    const result = await h.service.revokeAiReview({
      agentReportId: "ar_reviewer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("revoked");
    expect(h.revokeMrComments).toHaveBeenCalledWith(
      expect.objectContaining({ noteIds: ["n1", "n2"] }),
    );
    const updated = await h.store.getAgentReport({
      taskId: "t_1",
      role: "reviewer",
      agentReportId: "ar_reviewer",
    });
    expect(
      (updated as ReviewerAgentReport).reviewer.mrPublication.status,
    ).toBe("revoked");
  });

  it("revokeAiReview rejects non-reviewer report with role_mismatch", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.saveAgentReport(buildCoderReport());

    const result = await h.service.revokeAiReview({ agentReportId: "ar_coder" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("role_mismatch");
  });

  it("revokeAiReview rejects non-published publication with not_revocable", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.saveAgentReport(
      buildReviewerReport({
        reviewer: {
          summary: "ok",
          decision: "approve_with_comments",
          confidence: 0.9,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "skipped_by_config", noteIds: [] },
        },
      }),
    );

    const result = await h.service.revokeAiReview({
      agentReportId: "ar_reviewer",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_revocable");
  });

  it("revokeAiReview returns agent_report_not_found for unknown id", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.revokeAiReview({ agentReportId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("agent_report_not_found");
  });

  it("retryAgentReport (reviewer) calls coordinator.retryRole and returns new id", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.savePipelineRun(
      buildPipelineRun({
        status: "awaiting_rework",
        currentRole: null,
        agentReportIds: {
          coder: "ar_coder",
          reviewer: "ar_reviewer",
          test_evidence: null,
        },
      }),
    );
    await h.store.saveAgentReport(
      buildReviewerReport({
        reviewer: {
          summary: "needs changes",
          decision: "request_changes",
          confidence: 0.7,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "skipped_by_config", noteIds: [] },
        },
      }),
    );
    h.coordinator.retryRole.mockResolvedValue({
      supersededReportId: "ar_reviewer",
      report: buildReviewerReport({ agentReportId: "ar_reviewer_2" }),
      pipelineRun: buildPipelineRun({
        status: "awaiting_human_review",
        currentRole: null,
        agentReportIds: {
          coder: "ar_coder",
          reviewer: "ar_reviewer_2",
          test_evidence: null,
        },
      }),
    });

    const result = await h.service.retryAgentReport({
      agentReportId: "ar_reviewer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pipelineRunId).toBe("pr_1");
    expect(result.value.agentReportId).toBe("ar_reviewer_2");
    expect(h.coordinator.retryRole).toHaveBeenCalledWith(
      expect.objectContaining({ pipelineRunId: "pr_1", role: "reviewer" }),
    );
  });

  it("skipAgentReport (reviewer) marks AgentReport cancelled and reports nextRole", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.savePipelineRun(
      buildPipelineRun({
        status: "running_reviewer",
        currentRole: "reviewer",
        agentReportIds: {
          coder: "ar_coder",
          reviewer: "ar_reviewer",
          test_evidence: null,
        },
      }),
    );
    await h.store.saveAgentReport(buildReviewerReport({ status: "running" }));

    const result = await h.service.skipAgentReport({
      agentReportId: "ar_reviewer",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextRole).toBe("test_evidence");
    const updated = await h.store.getAgentReport({
      taskId: "t_1",
      role: "reviewer",
      agentReportId: "ar_reviewer",
    });
    expect(updated?.status).toBe("cancelled");
  });

  it("skipAgentReport (coder) rejects with role_skip_not_allowed", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.saveAgentReport(buildCoderReport());

    const result = await h.service.skipAgentReport({ agentReportId: "ar_coder" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("role_skip_not_allowed");
  });

  it("skipAgentReport on test_evidence reports awaiting_human_review next", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.savePipelineRun(
      buildPipelineRun({
        status: "running_test_evidence",
        currentRole: "test_evidence",
        agentReportIds: {
          coder: "ar_coder",
          reviewer: "ar_reviewer",
          test_evidence: "ar_te",
        },
      }),
    );
    await h.store.saveAgentReport(buildTestEvidenceReport({ status: "running" }));

    const result = await h.service.skipAgentReport({ agentReportId: "ar_te" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextRole).toBe("awaiting_human_review");
  });

  it("validateWorkflowRoles returns valid=true when every role has hashed prompt", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.validateWorkflowRoles({ workflowId: "default" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(true);
    expect(result.value.errors).toEqual([]);
  });

  it("validateWorkflowRoles surfaces missing promptTemplateHash entries", async () => {
    const h = await buildHarness({
      roles: {
        coder: {
          role: "coder",
          promptTemplate: "/tmp/coder.md",
          sandbox: "read_write_worktree",
        },
        reviewer: {
          role: "reviewer",
          promptTemplate: "/tmp/reviewer.md",
          promptTemplateHash: "abc",
          sandbox: "read_only_worktree",
        },
      },
    });
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.validateWorkflowRoles({ workflowId: "default" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.errors.some((e) => e.code === "missing_prompt_template_hash"))
      .toBe(true);
    expect(result.value.errors.some((e) => e.code === "missing_role"))
      .toBe(true);
  });

  it("listPipelineRunAgentReports returns full AgentReport entities", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.savePipelineRun(
      buildPipelineRun({
        agentReportIds: {
          coder: "ar_coder",
          reviewer: "ar_reviewer",
          test_evidence: null,
        },
      }),
    );
    await h.store.saveAgentReport(buildCoderReport());
    await h.store.saveAgentReport(buildReviewerReport());

    const result = await h.service.listPipelineRunAgentReports({
      pipelineRunId: "pr_1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sorted = result.value.agentReports
      .map((r: AgentReport) => r.role)
      .sort();
    expect(sorted).toEqual(["coder", "reviewer"]);
  });

  it("listPipelineRunAgentReports returns 404 for unknown id", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));

    const result = await h.service.listPipelineRunAgentReports({
      pipelineRunId: "nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("pipeline_run_not_found");
  });

  it("listTaskAgentReports honours role filter and include_superseded=false", async () => {
    const h = await buildHarness();
    cleanup.push(() => rm(h.tempRoot, { recursive: true, force: true }));
    await h.store.saveAgentReport(buildReviewerReport());
    await h.store.saveAgentReport(
      buildReviewerReport({
        agentReportId: "ar_reviewer_2",
        reviewer: {
          summary: "v2",
          decision: "approve_with_comments",
          confidence: 0.95,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "published", noteIds: [] },
        },
      }),
    );
    await h.store.supersedeAgentReport({
      taskId: "t_1",
      role: "reviewer",
      prevId: "ar_reviewer",
      nextId: "ar_reviewer_2",
    });

    const onlyLatest = await h.service.listTaskAgentReports({
      workItemId: "wi_1",
      taskId: "t_1",
      role: "reviewer",
      includeSuperseded: false,
    });
    expect(onlyLatest.ok).toBe(true);
    if (!onlyLatest.ok) return;
    expect(onlyLatest.value.agentReports).toHaveLength(1);
    expect(onlyLatest.value.agentReports[0]?.agentReportId).toBe("ar_reviewer_2");

    const all = await h.service.listTaskAgentReports({
      workItemId: "wi_1",
      taskId: "t_1",
      role: "reviewer",
      includeSuperseded: true,
    });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.agentReports.map((r) => r.agentReportId).sort()).toEqual([
      "ar_reviewer",
      "ar_reviewer_2",
    ]);
  });
});
