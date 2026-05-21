import type { FastifyInstance } from "fastify";
import {
  isReviewReworkCategory,
  isReviewReworkPlanStatus,
  isReviewReworkPriority,
  type ReviewReworkPlanStatus,
} from "@issuepilot/shared-contracts";

import type { ReviewWorkflowService } from "./service.js";

export type ReviewWorkflowRouteContext =
  | { ok: true; service: ReviewWorkflowService; projectId?: string }
  | {
      ok: false;
      statusCode: number;
      body: { ok: false; code: string; message?: string };
    };

function operatorFrom(
  headers: Record<string, unknown>,
  body: { operator?: string } | undefined,
): string {
  if (body?.operator && body.operator.length > 0) return body.operator;
  const raw = headers["x-issuepilot-operator"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerReviewWorkflowRoutes(
  app: FastifyInstance,
  resolveContext: (
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ) => ReviewWorkflowRouteContext,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/review-workflow/plans",
    async (request, reply) => {
      const ctx = resolveContext(
        request.headers as Record<string, unknown>,
        request.query["project"],
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const status = isReviewReworkPlanStatus(request.query["status"])
        ? (request.query["status"] as ReviewReworkPlanStatus)
        : undefined;
      const filters = {
        ...(asString(request.query["runId"])
          ? { runId: asString(request.query["runId"])! }
          : {}),
        ...(asString(request.query["taskId"])
          ? { taskId: asString(request.query["taskId"])! }
          : {}),
        ...(asString(request.query["workItemId"])
          ? { workItemId: asString(request.query["workItemId"])! }
          : {}),
        ...(status ? { status } : {}),
      };
      const plans = await ctx.service.list(filters);
      return reply.send({ plans });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/review-workflow/plans/:id",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const plan = await ctx.service.get(request.params.id);
      if (!plan) return reply.code(404).send({ ok: false, code: "not_found" });
      return reply.send({ plan });
    },
  );

  app.post<{
    Body: {
      runId: string;
      issueIid: number;
      projectId?: string;
      workItemId?: string;
      taskId?: string;
      summary?: unknown;
      reviewerReports?: unknown[];
      reportArtifact?: unknown;
    };
  }>("/api/review-workflow/plans/generate", async (request, reply) => {
    const ctx = resolveContext(request.headers as Record<string, unknown>);
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const plan = await ctx.service.generate({
      runId: request.body.runId,
      issueIid: request.body.issueIid,
      ...(request.body.projectId ? { projectId: request.body.projectId } : {}),
      ...(request.body.workItemId
        ? { workItemId: request.body.workItemId }
        : {}),
      ...(request.body.taskId ? { taskId: request.body.taskId } : {}),
      ...(request.body.summary !== undefined
        ? { summary: request.body.summary as never }
        : {}),
      reviewerReports: (request.body.reviewerReports ?? []) as never,
      ...(request.body.reportArtifact !== undefined
        ? { reportArtifact: request.body.reportArtifact as never }
        : {}),
    });
    return reply.send({ plan });
  });

  app.post<{
    Params: { id: string };
    Body: { operator?: string; reason?: string };
  }>("/api/review-workflow/plans/:id/accept", async (request, reply) => {
    const ctx = resolveContext(request.headers as Record<string, unknown>);
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const plan = await ctx.service.acceptPlan({
      planId: request.params.id,
      operator: operatorFrom(
        request.headers as Record<string, unknown>,
        request.body,
      ),
      ...(request.body.reason ? { reason: request.body.reason } : {}),
    });
    return reply.send({ plan });
  });

  app.post<{
    Params: { id: string };
    Body: { operator?: string; reason: string };
  }>("/api/review-workflow/plans/:id/dismiss", async (request, reply) => {
    const ctx = resolveContext(request.headers as Record<string, unknown>);
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const plan = await ctx.service.dismissPlan({
      planId: request.params.id,
      operator: operatorFrom(
        request.headers as Record<string, unknown>,
        request.body,
      ),
      reason: request.body.reason,
    });
    return reply.send({ plan });
  });

  for (const verb of ["accept", "dismiss", "resolve"] as const) {
    const fnName =
      verb === "accept"
        ? "acceptItem"
        : verb === "dismiss"
          ? "dismissItem"
          : "resolveItem";
    app.post<{
      Params: { id: string; itemId: string };
      Body: { operator?: string; reason?: string };
    }>(
      `/api/review-workflow/plans/:id/items/:itemId/${verb}`,
      async (request, reply) => {
        const ctx = resolveContext(request.headers as Record<string, unknown>);
        if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
        const operator = operatorFrom(
          request.headers as Record<string, unknown>,
          request.body,
        );
        const baseArgs = {
          planId: request.params.id,
          itemId: request.params.itemId,
          operator,
        };
        let plan;
        if (fnName === "acceptItem") {
          plan = await ctx.service.acceptItem({
            ...baseArgs,
            ...(request.body.reason ? { reason: request.body.reason } : {}),
          });
        } else if (fnName === "dismissItem") {
          if (!request.body.reason) {
            return reply
              .code(400)
              .send({ ok: false, code: "validation_failed" });
          }
          plan = await ctx.service.dismissItem({
            ...baseArgs,
            reason: request.body.reason,
          });
        } else {
          plan = await ctx.service.resolveItem({
            ...baseArgs,
            ...(request.body.reason ? { reason: request.body.reason } : {}),
          });
        }
        return reply.send({ plan });
      },
    );
  }

  app.post<{
    Params: { id: string; itemId: string };
    Body: {
      operator?: string;
      splits: Array<{
        title: string;
        summary: string;
        category: string;
        priority: string;
      }>;
    };
  }>(
    "/api/review-workflow/plans/:id/items/:itemId/split",
    async (request, reply) => {
      const ctx = resolveContext(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const splits = (request.body.splits ?? []).filter((s) =>
        isReviewReworkCategory(s.category) && isReviewReworkPriority(s.priority),
      );
      if (splits.length === 0) {
        return reply
          .code(400)
          .send({ ok: false, code: "validation_failed" });
      }
      const plan = await ctx.service.splitItem({
        planId: request.params.id,
        itemId: request.params.itemId,
        operator: operatorFrom(
          request.headers as Record<string, unknown>,
          request.body,
        ),
        splits: splits as never,
      });
      return reply.send({ plan });
    },
  );
}
