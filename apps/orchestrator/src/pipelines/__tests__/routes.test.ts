/**
 * V4.6 spec §18 routes — Fastify-level integration tests.
 *
 * 通过把 `PipelineService` mock 成可控 stub，把每条 route 的 happy 路径与
 * 400 / 404 / 409 error mapping 完整覆盖一次；service 与 store 的真实
 * 行为已经在 `service.test.ts` / `store.test.ts` 里独立验证，这里只关心
 * Fastify 路径 + body / params / header 解析 + status code 派发。
 */

import {
  type AgentReport,
  type PipelineRun,
  type ReviewerAgentReport,
} from "@issuepilot/shared-contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerPipelineRoutes,
  type PipelineRouteContext,
} from "../routes.js";
import type { PipelineService, PipelineServiceResult } from "../service.js";

function ok<T>(value: T): PipelineServiceResult<T> {
  return { ok: true, value };
}

function fail(
  code:
    | "task_not_found"
    | "pipeline_run_not_found"
    | "agent_report_not_found"
    | "recipe_override_locked"
    | "unknown_recipe"
    | "role_mismatch"
    | "not_revocable"
    | "role_skip_not_allowed"
    | "workflow_not_found"
    | "invalid_payload"
    | "project_required"
    | "project_query_not_allowed"
    | "service_unavailable",
  message: string,
): PipelineServiceResult<never> {
  return { ok: false, error: { code, message } };
}

function buildService(): PipelineService & {
  __calls: {
    getPipelineForTask: ReturnType<typeof vi.fn>;
    listPipelinesForTask: ReturnType<typeof vi.fn>;
    getAgentReport: ReturnType<typeof vi.fn>;
    listTaskAgentReports: ReturnType<typeof vi.fn>;
    listPipelineRunAgentReports: ReturnType<typeof vi.fn>;
    setRecipeOverride: ReturnType<typeof vi.fn>;
    revokeAiReview: ReturnType<typeof vi.fn>;
    retryAgentReport: ReturnType<typeof vi.fn>;
    skipAgentReport: ReturnType<typeof vi.fn>;
    validateWorkflowRoles: ReturnType<typeof vi.fn>;
  };
} {
  const calls = {
    getPipelineForTask: vi.fn(),
    listPipelinesForTask: vi.fn(),
    getAgentReport: vi.fn(),
    listTaskAgentReports: vi.fn(),
    listPipelineRunAgentReports: vi.fn(),
    setRecipeOverride: vi.fn(),
    revokeAiReview: vi.fn(),
    retryAgentReport: vi.fn(),
    skipAgentReport: vi.fn(),
    validateWorkflowRoles: vi.fn(),
  };
  return {
    __calls: calls,
    getPipelineForTask: calls.getPipelineForTask as never,
    listPipelinesForTask: calls.listPipelinesForTask as never,
    getAgentReport: calls.getAgentReport as never,
    listTaskAgentReports: calls.listTaskAgentReports as never,
    listPipelineRunAgentReports: calls.listPipelineRunAgentReports as never,
    setRecipeOverride: calls.setRecipeOverride as never,
    revokeAiReview: calls.revokeAiReview as never,
    retryAgentReport: calls.retryAgentReport as never,
    skipAgentReport: calls.skipAgentReport as never,
    validateWorkflowRoles: calls.validateWorkflowRoles as never,
  };
}

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
    mrPublication: { status: "published", noteIds: ["n1"] },
  },
  ...over,
});

describe("registerPipelineRoutes", () => {
  let app: FastifyInstance;
  let service: ReturnType<typeof buildService>;
  let resolver: (h: Record<string, unknown>) => PipelineRouteContext;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    service = buildService();
    resolver = () => ({ ok: true, service });
    registerPipelineRoutes(app, (h) => resolver(h));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── GET /api/work-items/:wid/tasks/:tid/pipeline ─────────────────────
  it("GET pipeline returns 200 with pipelineRun null", async () => {
    service.__calls.getPipelineForTask.mockResolvedValue(
      ok({ pipelineRun: null, agentReports: [] }),
    );
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/pipeline",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pipelineRun: null, agentReports: [] });
    expect(service.__calls.getPipelineForTask).toHaveBeenCalledWith({
      workItemId: "wi_1",
      taskId: "t_1",
    });
  });

  it("GET pipeline maps task_not_found to 404", async () => {
    service.__calls.getPipelineForTask.mockResolvedValue(
      fail("task_not_found", "no task"),
    );
    const res = await app.inject("/api/work-items/wi_1/tasks/t_1/pipeline");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "task_not_found" });
  });

  // ── GET /api/work-items/:wid/tasks/:tid/pipelines (history) ─────────
  it("GET pipelines returns history list", async () => {
    service.__calls.listPipelinesForTask.mockResolvedValue(
      ok({ pipelineRuns: [buildPipelineRun()] }),
    );
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/pipelines",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().pipelineRuns).toHaveLength(1);
  });

  // ── GET /api/agent-reports/:id ──────────────────────────────────────
  it("GET agent report 200 / 404", async () => {
    const report: AgentReport = buildReviewerReport();
    service.__calls.getAgentReport.mockResolvedValueOnce(
      ok({ agentReport: report }),
    );
    const okRes = await app.inject("/api/agent-reports/ar_reviewer");
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json().agentReport.agentReportId).toBe("ar_reviewer");
    expect(service.__calls.getAgentReport).toHaveBeenCalledWith({
      agentReportId: "ar_reviewer",
    });

    service.__calls.getAgentReport.mockResolvedValueOnce(
      fail("agent_report_not_found", "missing"),
    );
    const missRes = await app.inject("/api/agent-reports/missing");
    expect(missRes.statusCode).toBe(404);
    expect(missRes.json()).toMatchObject({ code: "agent_report_not_found" });
  });

  // ── GET /api/work-items/:wid/tasks/:tid/agent-reports ───────────────
  it("GET task agent reports forwards role + include_superseded query", async () => {
    service.__calls.listTaskAgentReports.mockResolvedValue(ok({ agentReports: [] }));
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/agent-reports?role=reviewer&include_superseded=true",
    );
    expect(res.statusCode).toBe(200);
    expect(service.__calls.listTaskAgentReports).toHaveBeenCalledWith({
      workItemId: "wi_1",
      taskId: "t_1",
      role: "reviewer",
      includeSuperseded: true,
    });
  });

  it("GET task agent reports rejects unknown role query as 400", async () => {
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/agent-reports?role=builder",
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_payload" });
    expect(service.__calls.listTaskAgentReports).not.toHaveBeenCalled();
  });

  // ── GET /api/pipeline-runs/:id/agent-reports ────────────────────────
  it("GET pipeline-runs agent-reports 200 / 404", async () => {
    service.__calls.listPipelineRunAgentReports.mockResolvedValueOnce(
      ok({ agentReports: [] }),
    );
    const okRes = await app.inject("/api/pipeline-runs/pr_1/agent-reports");
    expect(okRes.statusCode).toBe(200);
    expect(service.__calls.listPipelineRunAgentReports).toHaveBeenCalledWith({
      pipelineRunId: "pr_1",
    });

    service.__calls.listPipelineRunAgentReports.mockResolvedValueOnce(
      fail("pipeline_run_not_found", "x"),
    );
    const missRes = await app.inject("/api/pipeline-runs/pr_x/agent-reports");
    expect(missRes.statusCode).toBe(404);
    expect(missRes.json()).toMatchObject({ code: "pipeline_run_not_found" });
  });

  // ── POST /api/work-items/:wid/tasks/:tid/pipeline/recipe-override ────
  it("POST recipe-override 200 on success", async () => {
    service.__calls.setRecipeOverride.mockResolvedValue(
      ok({
        recipe: "coding_plus_reviewer",
        recipeSource: "operator_override",
        appliedTo: "pipeline_run",
        pipelineRunId: "pr_1",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/work-items/wi_1/tasks/t_1/pipeline/recipe-override",
      payload: { recipe: "coding_plus_reviewer" },
      headers: { "x-issuepilot-operator": "alice" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().appliedTo).toBe("pipeline_run");
    expect(service.__calls.setRecipeOverride).toHaveBeenCalledWith({
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "coding_plus_reviewer",
      operator: "alice",
    });
  });

  it("POST recipe-override 409 when running", async () => {
    service.__calls.setRecipeOverride.mockResolvedValue(
      fail("recipe_override_locked", "running_reviewer"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/work-items/wi_1/tasks/t_1/pipeline/recipe-override",
      payload: { recipe: "coding_only" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "recipe_override_locked" });
  });

  it("POST recipe-override 400 when recipe unknown / payload missing", async () => {
    service.__calls.setRecipeOverride.mockResolvedValue(
      fail("unknown_recipe", "nope"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/work-items/wi_1/tasks/t_1/pipeline/recipe-override",
      payload: { recipe: "nope" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "unknown_recipe" });

    const missing = await app.inject({
      method: "POST",
      url: "/api/work-items/wi_1/tasks/t_1/pipeline/recipe-override",
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "invalid_payload" });
  });

  // ── POST /api/agent-reports/:id/revoke-ai-review ─────────────────────
  it("POST revoke-ai-review 200 on success", async () => {
    service.__calls.revokeAiReview.mockResolvedValue(
      ok({
        agentReportId: "ar_r",
        status: "revoked" as const,
        revokedAt: "2026-05-19T13:00:00.000Z",
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_r/revoke-ai-review",
      headers: { "x-issuepilot-operator": "bob" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("revoked");
    expect(service.__calls.revokeAiReview).toHaveBeenCalledWith({
      agentReportId: "ar_r",
      operator: "bob",
    });
  });

  it("POST revoke-ai-review 400 role_mismatch", async () => {
    service.__calls.revokeAiReview.mockResolvedValue(
      fail("role_mismatch", "not reviewer"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_r/revoke-ai-review",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "role_mismatch" });
  });

  it("POST revoke-ai-review 409 not_revocable", async () => {
    service.__calls.revokeAiReview.mockResolvedValue(
      fail("not_revocable", "already revoked"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_r/revoke-ai-review",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "not_revocable" });
  });

  // ── POST /api/agent-reports/:id/retry ────────────────────────────────
  it("POST retry 200 reviewer reuses PipelineRun", async () => {
    service.__calls.retryAgentReport.mockResolvedValue(
      ok({ pipelineRunId: "pr_1", agentReportId: "ar_reviewer_v2" }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_reviewer/retry",
      payload: { reason: "rerun" },
      headers: { "x-issuepilot-operator": "alice" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      pipelineRunId: "pr_1",
      agentReportId: "ar_reviewer_v2",
    });
    expect(service.__calls.retryAgentReport).toHaveBeenCalledWith({
      agentReportId: "ar_reviewer",
      operator: "alice",
      reason: "rerun",
    });
  });

  it("POST retry 200 coder (newPipelineRunId optional)", async () => {
    service.__calls.retryAgentReport.mockResolvedValue(
      ok({ pipelineRunId: "pr_1" }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_coder/retry",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pipelineRunId: "pr_1" });
  });

  it("POST retry 404 when agent report missing", async () => {
    service.__calls.retryAgentReport.mockResolvedValue(
      fail("agent_report_not_found", "x"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/missing/retry",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "agent_report_not_found" });
  });

  // V4.6 follow-up Important #5：spec §18.4 把 service_unavailable 映射
  // 到 HTTP 503，避免 "agent runner 未装配" 这类配置错误被吞成 400
  // invalid_payload 而误导 dashboard。
  it("POST retry 503 when service reports service_unavailable", async () => {
    service.__calls.retryAgentReport.mockResolvedValue(
      fail("service_unavailable", "reviewer agent runner is not wired"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_reviewer/retry",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: "service_unavailable",
      message: "reviewer agent runner is not wired",
    });
  });

  // ── POST /api/agent-reports/:id/skip ────────────────────────────────
  it("POST skip 200 reviewer", async () => {
    service.__calls.skipAgentReport.mockResolvedValue(
      ok({
        pipelineRunId: "pr_1",
        agentReportId: "ar_reviewer",
        nextRole: "test_evidence" as const,
      }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_reviewer/skip",
      payload: { reason: "skip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().nextRole).toBe("test_evidence");
  });

  it("POST skip 400 for coder", async () => {
    service.__calls.skipAgentReport.mockResolvedValue(
      fail("role_skip_not_allowed", "no"),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/agent-reports/ar_coder/skip",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "role_skip_not_allowed" });
  });

  // ── GET /api/workflows/:workflowId/roles/validate ──────────────────
  it("GET workflow roles validate 200", async () => {
    service.__calls.validateWorkflowRoles.mockResolvedValue(
      ok({ valid: true, errors: [] }),
    );
    const res = await app.inject("/api/workflows/default/roles/validate");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, errors: [] });
    expect(service.__calls.validateWorkflowRoles).toHaveBeenCalledWith({
      workflowId: "default",
    });
  });

  // ── Team-mode resolver semantics ────────────────────────────────────
  it("team-mode: missing x-issuepilot-project header returns 400 project_required", async () => {
    resolver = () => ({
      ok: false,
      statusCode: 400,
      body: { ok: false, code: "project_required", message: "missing" },
    });
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/pipeline",
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "project_required" });
  });

  it("team-mode: project query string returns 400 project_query_not_allowed", async () => {
    resolver = () => ({
      ok: false,
      statusCode: 400,
      body: {
        ok: false,
        code: "project_query_not_allowed",
        message: "project must come from header",
      },
    });
    const res = await app.inject(
      "/api/work-items/wi_1/tasks/t_1/pipeline?project=p1",
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "project_query_not_allowed" });
  });
});
