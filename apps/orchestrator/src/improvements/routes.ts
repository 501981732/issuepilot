import {
  isFailurePatternId,
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  type ImprovementActionRequest,
  type ImprovementGenerateRequest,
  type ImprovementPatchPreviewRequest,
  type ImprovementRecommendationFilters,
} from "@issuepilot/shared-contracts";
import type { FastifyInstance } from "fastify";

import type { ImprovementService } from "./service.js";

export type ImprovementRouteContext =
  | { ok: true; service: ImprovementService; projectId?: string }
  | {
      ok: false;
      statusCode: number;
      body: { ok: false; code: string; message?: string };
    };

export function improvementRouteError(code: string, message: string) {
  return { ok: false as const, code, message };
}

function statusFromImprovementCode(code: string): number {
  if (code === "not_found") return 404;
  if (code === "validation_failed") return 400;
  return 500;
}

function filtersFromQuery(
  query: Record<string, unknown>,
): ImprovementRecommendationFilters {
  return {
    ...(isImprovementRecommendationStatus(query["status"])
      ? { status: query["status"] }
      : {}),
    ...(isFailurePatternId(query["pattern"])
      ? { pattern: query["pattern"] }
      : {}),
    ...(isImprovementTargetKind(query["targetKind"])
      ? { targetKind: query["targetKind"] }
      : {}),
    ...(typeof query["workflow"] === "string" && query["workflow"].length > 0
      ? { workflow: query["workflow"] }
      : {}),
    ...(typeof query["taskType"] === "string" && query["taskType"].length > 0
      ? { taskType: query["taskType"] }
      : {}),
  };
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

export function registerImprovementRoutes(
  app: FastifyInstance,
  resolveService: (
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ) => ImprovementRouteContext,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/improvements/recommendations",
    async (request, reply) => {
      if (request.query?.["project"] !== undefined) {
        return reply
          .code(400)
          .send(
            improvementRouteError(
              "project_query_unsupported",
              "project query is not supported; team mode uses x-issuepilot-project",
            ),
          );
      }
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return {
        recommendations: await ctx.service.list(
          filtersFromQuery(request.query ?? {}),
        ),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/improvements/recommendations/:id",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return { recommendation: await ctx.service.detail(request.params.id) };
    },
  );

  app.post<{ Body?: ImprovementGenerateRequest }>(
    "/api/improvements/recommendations/generate",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return ctx.service.generate(request.body ?? {});
    },
  );

  for (const action of ["accept", "reject", "defer"] as const) {
    app.post<{ Params: { id: string }; Body?: ImprovementActionRequest }>(
      `/api/improvements/recommendations/:id/${action}`,
      async (request, reply) => {
        const ctx = resolveService(request.headers as Record<string, unknown>);
        if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
        const body = request.body ?? {};
        const operator = operatorFrom(
          request.headers as Record<string, unknown>,
          body,
        );
        const input: ImprovementActionRequest = {
          ...body,
          ...(operator ? { operator } : {}),
        };
        const result = await ctx.service[action](request.params.id, input);
        if ("error" in result) {
          return reply
            .code(statusFromImprovementCode(result.error.code))
            .send({ ok: false, ...result.error });
        }
        return result;
      },
    );
  }

  app.post<{ Params: { id: string }; Body?: ImprovementPatchPreviewRequest }>(
    "/api/improvements/recommendations/:id/patch-preview",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const body = request.body ?? {};
      const operator = operatorFrom(
        request.headers as Record<string, unknown>,
        body,
      );
      const input: ImprovementPatchPreviewRequest = {
        ...(operator ? { operator } : {}),
      };
      const result = await ctx.service.patchPreview(request.params.id, input);
      if ("error" in result) {
        return reply
          .code(statusFromImprovementCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return result;
    },
  );
}
