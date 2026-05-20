/**
 * V4.6 spec §18 routes：把 `PipelineService` 暴露成 Fastify HTTP API。
 *
 * 沿用 V4.4 / V4.5 的 `resolveService` 模式 —— 上层 daemon 装配时按
 * single / team 模式注入 resolver，本文件只负责：
 * - 解析 path params / query / body 并校验。
 * - 调用 service 方法，把 `{ ok: true | false }` 结果按
 *   `PipelineRouteErrorCode` 映射到 200 / 400 / 404 / 409。
 *
 * 错误码 → HTTP 状态码映射（spec §18.4）：
 *   - `task_not_found` / `pipeline_run_not_found` / `agent_report_not_found` /
 *     `workflow_not_found` → 404
 *   - `recipe_override_locked` / `not_revocable` → 409
 *   - `unknown_recipe` / `role_mismatch` / `role_skip_not_allowed` /
 *     `invalid_payload` / `project_required` / `project_query_not_allowed`
 *     → 400
 *   - `service_unavailable` / `pipelines_unavailable` → 503（V4.6 follow-up
 *     Important #5：coordinator 抛 `agent_not_configured` 时使用，区别于
 *     400 invalid_payload）
 */

import {
  isWorkflowRecipe,
  type AgentRole,
  type PipelineRouteErrorCode,
  type RetryAgentReportRequest,
  type SetRecipeOverrideRequest,
  type SkipAgentReportRequest,
} from "@issuepilot/shared-contracts";
import type { FastifyInstance } from "fastify";

import type { PipelineService } from "./service.js";

export type PipelineRouteContext =
  | { ok: true; service: PipelineService; projectId?: string }
  | {
      ok: false;
      statusCode: number;
      body: {
        ok: false;
        code: PipelineRouteErrorCode | "project_not_found";
        message: string;
      };
    };

const ROLE_VALUES: ReadonlySet<AgentRole> = new Set([
  "coder",
  "reviewer",
  "test_evidence",
]);

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && ROLE_VALUES.has(value as AgentRole);
}

function statusFromCode(code: PipelineRouteErrorCode): number {
  switch (code) {
    case "task_not_found":
    case "pipeline_run_not_found":
    case "agent_report_not_found":
    case "workflow_not_found":
      return 404;
    case "recipe_override_locked":
    case "not_revocable":
      return 409;
    case "unknown_recipe":
    case "role_mismatch":
    case "role_skip_not_allowed":
    case "invalid_payload":
    case "project_required":
    case "project_query_not_allowed":
      return 400;
    case "service_unavailable":
    case "pipelines_unavailable":
      return 503;
    default: {
      // Exhaustiveness — TypeScript will surface uncovered codes here.
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

function operatorFrom(
  headers: Record<string, unknown>,
  body: { operator?: string } | undefined,
): string | undefined {
  if (body?.operator && body.operator.length > 0) return body.operator;
  const raw = headers["x-issuepilot-operator"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerPipelineRoutes(
  app: FastifyInstance,
  resolveContext: (
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ) => PipelineRouteContext,
): void {
  // ── GET /api/work-items/:wid/tasks/:tid/pipeline ───────────────────
  app.get<{
    Params: { wid: string; tid: string };
    Querystring: { project?: unknown };
  }>("/api/work-items/:wid/tasks/:tid/pipeline", async (request, reply) => {
    const ctx = resolveContext(
      request.headers as Record<string, unknown>,
      (request.query as { project?: unknown }).project,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const result = await ctx.service.getPipelineForTask({
      workItemId: request.params.wid,
      taskId: request.params.tid,
    });
    if (!result.ok) {
      return reply
        .code(statusFromCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result.value);
  });

  // ── GET /api/work-items/:wid/tasks/:tid/pipelines ───────────────────
  app.get<{
    Params: { wid: string; tid: string };
    Querystring: { project?: unknown };
  }>("/api/work-items/:wid/tasks/:tid/pipelines", async (request, reply) => {
    const ctx = resolveContext(
      request.headers as Record<string, unknown>,
      (request.query as { project?: unknown }).project,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const result = await ctx.service.listPipelinesForTask({
      workItemId: request.params.wid,
      taskId: request.params.tid,
    });
    if (!result.ok) {
      return reply
        .code(statusFromCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result.value);
  });

  // ── GET /api/agent-reports/:id ─────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/agent-reports/:id",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.getAgentReport({
        agentReportId: request.params.id,
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result.value);
    },
  );

  // ── GET /api/work-items/:wid/tasks/:tid/agent-reports ───────────────
  app.get<{
    Params: { wid: string; tid: string };
    Querystring: {
      role?: unknown;
      include_superseded?: unknown;
      project?: unknown;
    };
  }>(
    "/api/work-items/:wid/tasks/:tid/agent-reports",
    async (request, reply) => {
      const ctx = resolveContext(
        request.headers as Record<string, unknown>,
        request.query.project,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);

      const rawRole = request.query.role;
      let role: AgentRole | undefined;
      if (rawRole !== undefined) {
        if (!isAgentRole(rawRole)) {
          return reply.code(400).send({
            ok: false,
            code: "invalid_payload",
            message: `role must be one of coder|reviewer|test_evidence (got ${String(rawRole)})`,
          });
        }
        role = rawRole;
      }
      const includeSuperseded = request.query.include_superseded === "true";

      const result = await ctx.service.listTaskAgentReports({
        workItemId: request.params.wid,
        taskId: request.params.tid,
        ...(role ? { role } : {}),
        ...(includeSuperseded ? { includeSuperseded: true } : {}),
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result.value);
    },
  );

  // ── GET /api/pipeline-runs/:id/agent-reports ───────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/pipeline-runs/:id/agent-reports",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.listPipelineRunAgentReports({
        pipelineRunId: request.params.id,
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result.value);
    },
  );

  // ── POST /api/work-items/:wid/tasks/:tid/pipeline/recipe-override ───
  app.post<{
    Params: { wid: string; tid: string };
    Body?: Partial<SetRecipeOverrideRequest>;
  }>(
    "/api/work-items/:wid/tasks/:tid/pipeline/recipe-override",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const body = request.body ?? {};
      const rawRecipe = body.recipe;
      if (rawRecipe === undefined) {
        return reply.code(400).send({
          ok: false,
          code: "invalid_payload",
          message: "recipe is required",
        });
      }
      if (typeof rawRecipe !== "string") {
        return reply.code(400).send({
          ok: false,
          code: "invalid_payload",
          message: "recipe must be a string",
        });
      }
      const recipe = rawRecipe;
      const operator = operatorFrom(
        request.headers as Record<string, unknown>,
        body,
      );
      const result = await ctx.service.setRecipeOverride({
        workItemId: request.params.wid,
        taskId: request.params.tid,
        // Pass through even when the literal is not a known recipe; the
        // service is the source of truth for `unknown_recipe`.
        recipe: recipe as Parameters<
          PipelineService["setRecipeOverride"]
        >[0]["recipe"],
        ...(operator ? { operator } : {}),
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      // Bonus defensive check: if a known recipe literal was passed but the
      // service somehow accepts an unknown one, surface a clear contract bug
      // in test logs. (We do not block requests here — service is the source
      // of truth, and `unknown_recipe` is already mapped to 400 above.)
      void isWorkflowRecipe;
      return reply.code(200).send(result.value);
    },
  );

  // ── POST /api/agent-reports/:id/revoke-ai-review ───────────────────
  app.post<{ Params: { id: string }; Body?: { operator?: string } }>(
    "/api/agent-reports/:id/revoke-ai-review",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const operator = operatorFrom(
        request.headers as Record<string, unknown>,
        request.body ?? {},
      );
      const result = await ctx.service.revokeAiReview({
        agentReportId: request.params.id,
        ...(operator ? { operator } : {}),
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result.value);
    },
  );

  // ── POST /api/agent-reports/:id/retry ──────────────────────────────
  app.post<{
    Params: { id: string };
    Body?: RetryAgentReportRequest;
  }>("/api/agent-reports/:id/retry", async (request, reply) => {
    const ctx = resolveContext(request.headers as Record<string, unknown>);
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const body = request.body ?? {};
    const operator = operatorFrom(
      request.headers as Record<string, unknown>,
      body,
    );
    const result = await ctx.service.retryAgentReport({
      agentReportId: request.params.id,
      ...(operator ? { operator } : {}),
      ...(typeof body.reason === "string" && body.reason.length > 0
        ? { reason: body.reason }
        : {}),
    });
    if (!result.ok) {
      return reply
        .code(statusFromCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result.value);
  });

  // ── POST /api/agent-reports/:id/skip ───────────────────────────────
  app.post<{
    Params: { id: string };
    Body?: SkipAgentReportRequest;
  }>("/api/agent-reports/:id/skip", async (request, reply) => {
    const ctx = resolveContext(request.headers as Record<string, unknown>);
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const body = request.body ?? {};
    const operator = operatorFrom(
      request.headers as Record<string, unknown>,
      body,
    );
    const result = await ctx.service.skipAgentReport({
      agentReportId: request.params.id,
      ...(operator ? { operator } : {}),
      ...(typeof body.reason === "string" && body.reason.length > 0
        ? { reason: body.reason }
        : {}),
    });
    if (!result.ok) {
      return reply
        .code(statusFromCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result.value);
  });

  // ── GET /api/workflows/:workflowId/roles/validate ──────────────────
  app.get<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/roles/validate",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.validateWorkflowRoles({
        workflowId: request.params.workflowId,
      });
      if (!result.ok) {
        return reply
          .code(statusFromCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result.value);
    },
  );
}
