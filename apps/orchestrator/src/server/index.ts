import { createReadStream } from "node:fs";

import {
  redact,
  type EventBus,
  type EventRecord,
} from "@issuepilot/observability";
import type {
  AcceptWorkItemPlanRequest,
  ConfirmEvidenceResponse,
  IssuePilotInternalEvent,
  ProjectSummary,
  RunReportSummary,
  TaskPlan,
  TeamRuntimeSummary,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemEvidenceResponse,
  WorkItemReport,
  WorkItemStatus,
} from "@issuepilot/shared-contracts";
import { WORK_ITEM_STATUS_VALUES } from "@issuepilot/shared-contracts";
import Fastify, { type FastifyInstance } from "fastify";

import {
  improvementRouteError,
  registerImprovementRoutes,
  type ImprovementRouteContext,
} from "../improvements/routes.js";
import type { ImprovementService } from "../improvements/service.js";
import type { OperatorActionResult } from "../operations/actions.js";
import {
  registerPipelineRoutes,
  type PipelineRouteContext,
} from "../pipelines/routes.js";
import type { PipelineService } from "../pipelines/service.js";
import { buildQualitySummary } from "../quality/aggregate.js";
import type { QualityCollectorDeps } from "../quality/collect.js";
import { collectQualitySources } from "../quality/collect.js";
import { parseQualityQuery } from "../quality/filters.js";
import type { ReportStore } from "../reports/store.js";
import type { RuntimeState } from "../runtime/state.js";
import { serveEvidenceFile } from "../work-items/evidence-file-server.js";

/**
 * V4.1 Workflow Spine work item service.
 *
 * Decoupled from any concrete store/orchestration implementation so the
 * single-workflow daemon can wire it (Task 13) while team-mode daemon
 * leaves it absent — in which case the routes return a deterministic
 * 503 `work_items_unavailable` rather than a 5xx.
 */
export type WorkItemServiceError = {
  error: { code: string; message: string };
};

export interface WorkItemService {
  planFromIssue(input: {
    iid: number;
    regenerate?: boolean;
    operator: string;
  }): Promise<{ workItem: WorkItem; plan: TaskPlan } | WorkItemServiceError>;
  list(): Promise<WorkItem[]>;
  detail(id: string): Promise<WorkItemDetailResponse | undefined>;
  acceptPlan(
    input: AcceptWorkItemPlanRequest & { workItemId: string },
  ): Promise<{ workItem: WorkItem; plan: TaskPlan } | WorkItemServiceError>;
  regeneratePlan(
    id: string,
    operator: string,
  ): Promise<{ workItem: WorkItem; plan: TaskPlan } | WorkItemServiceError>;
  skipTask(
    workItemId: string,
    taskId: string,
    operator: string,
  ): Promise<{ ok: true } | WorkItemServiceError>;
  retryTask(
    workItemId: string,
    taskId: string,
    operator: string,
  ): Promise<{ ok: true } | WorkItemServiceError>;
  /**
   * V4.2: re-draft a single task. Produces a new `TaskPlan` version
   * with status `draft`; non-replanned tasks inherit prior status /
   * runIds so an in-flight workflow does not reset.
   */
  replanTask(input: {
    workItemId: string;
    taskId: string;
    reason: string;
    hint?: string;
    operator: string;
  }): Promise<{ workItem: WorkItem; plan: TaskPlan } | WorkItemServiceError>;
  /**
   * V4.2: operator-driven rework. Transitions a completed / failed /
   * blocked task to `needs_rework` with a reviewer-provided reason and
   * triggers `reconcileWorkItem` so the parent handoff state catches up.
   */
  markNeedsRework(input: {
    workItemId: string;
    taskId: string;
    reason: string;
    operator: string;
  }): Promise<{ ok: true } | WorkItemServiceError>;
  /**
   * V4.2: operator can roll back a skip. The skipped task returns to
   * `ready` so the next orchestration tick can dispatch it.
   */
  unskipTask(input: {
    workItemId: string;
    taskId: string;
    operator: string;
  }): Promise<{ ok: true } | WorkItemServiceError>;
  /**
   * V4.2: layered task graph projection (levels + edges + critical path)
   * for the dashboard graph view.
   */
  graph(id: string): Promise<
    | {
        levels: string[][];
        edges: Array<{ from: string; to: string }>;
        criticalPathTaskIds: string[];
      }
    | WorkItemServiceError
  >;
  report(id: string): Promise<WorkItemReport | undefined>;
  getReportMarkdown(id: string): Promise<string | WorkItemServiceError>;
  getEvidence(
    id: string,
  ): Promise<WorkItemEvidenceResponse | WorkItemServiceError>;
  confirmTaskEvidence(
    workItemId: string,
    taskId: string,
    evidenceId: string,
    input: { operator?: string },
  ): Promise<ConfirmEvidenceResponse | WorkItemServiceError>;
}

export interface ServerDeps {
  state: RuntimeState;
  eventBus: EventBus<IssuePilotInternalEvent>;
  readEvents: (
    runId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<EventRecord[]>;
  readLogsTail?: (
    runId: string,
    opts?: { limit?: number },
  ) => Promise<string[]>;
  workflowPath: string;
  gitlabProject: string;
  handoffLabel?: string;
  pollIntervalMs: number;
  concurrency: number;
  /**
   * V2 team runtime rollups, included verbatim in `/api/state`. Accepts a
   * value or a getter; the getter form is evaluated on every request so the
   * snapshot reflects current lease/poll state instead of the initial value
   * captured at daemon start.
   */
  runtime?: TeamRuntimeSummary | (() => TeamRuntimeSummary);
  /** V2 team project rollups; same value-or-getter semantics as `runtime`. */
  projects?: ProjectSummary[] | (() => ProjectSummary[]);
  /**
   * V2 Phase 5 workspace usage (gibibytes). Same value-or-getter
   * semantics as `runtime` so the dashboard can re-read the most
   * recent cleanup plan summary on every `/api/state` poll without
   * coupling the server to the maintenance executor.
   */
  workspaceUsageGb?: number | (() => number | undefined);
  /**
   * V2 Phase 5 ISO-8601 timestamp of the next planned workspace
   * cleanup window. Same value-or-getter semantics as `runtime`.
   */
  nextCleanupAt?: string | (() => string | undefined);
  /**
   * Operator-initiated retry / stop / archive entry points. When absent the
   * POST routes respond with HTTP 503 `actions_unavailable` so dashboards
   * see a deterministic error instead of a 5xx black box. V2 team daemon
   * currently leaves this unwired pending dispatch integration.
   */
  operatorActions?: {
    retry(input: {
      runId: string;
      operator: string;
    }): Promise<OperatorActionResult>;
    stop(input: {
      runId: string;
      operator: string;
      cancelTimeoutMs?: number;
    }): Promise<OperatorActionResult>;
    archive(input: {
      runId: string;
      operator: string;
    }): Promise<OperatorActionResult>;
  };
  /**
   * V2.5 Command Center: report store providing per-run report
   * artifacts and summaries. When absent, the API responds with the
   * legacy shape so older callers and tests remain unaffected.
   */
  reports?: ReportStore;
  /**
   * V4.3 team-mode: per-project report stores keyed by the same project id
   * used by `workItemsByProject`. Evidence file routing must use the selected
   * project's store so identical run ids in another project cannot resolve a
   * foreign workspace.
   */
  reportsByProject?: Map<string, ReportStore>;
  /**
   * V4.1 Workflow Spine: WorkItem orchestration façade. When absent,
   * `/api/issues/:iid/plan` and `/api/work-items/*` routes uniformly
   * return HTTP 503 `work_items_unavailable` so dashboards see a
   * deterministic error instead of a route-level 404.
   */
  workItems?: WorkItemService;
  /**
   * V4.2 team-mode: per-project work-items services keyed by project id.
   * When set, the server reads `x-issuepilot-project` header on every
   * `/api/work-items/*` and `/api/issues/:iid/plan` request and routes
   * to the matching service. Missing header → HTTP 400
   * `project_header_required`; unknown project id → 404
   * `project_not_found`. Single-mode (V1 daemon) leaves this absent and
   * falls back to `workItems` regardless of the header.
   */
  workItemsByProject?: Map<string, WorkItemService>;
  /**
   * V4.4 Quality Analytics: source stores for single-project mode. When
   * absent the server falls back to `deps.reports` (run-only metrics) so
   * legacy callers still get a stable summary.
   */
  quality?: QualityCollectorDeps;
  /**
   * V4.4 Quality Analytics: per-project source stores for team-mode. When
   * set, the route requires `x-issuepilot-project` and rejects the legacy
   * `project` query string with `project_query_unsupported` so dashboards
   * cannot accidentally leak cross-project analytics.
   */
  qualityByProject?: Map<string, QualityCollectorDeps>;
  /**
   * V4.5 Improvement Loop: single-project recommendation service.
   */
  improvements?: ImprovementService;
  /**
   * V4.5 Improvement Loop: team-mode recommendation services keyed by project id.
   */
  improvementsByProject?: Map<string, ImprovementService>;
  /**
   * V4.6 Multi-Agent Pipeline: single-project pipeline service. Wires
   * `getPipelineForTask` / `setRecipeOverride` / retry / skip routes from
   * spec §18 against a single workspace.
   */
  pipelines?: PipelineService;
  /**
   * V4.6 Multi-Agent Pipeline: per-project pipeline services keyed by the
   * same project id used by `workItemsByProject`. When set, V4.6 routes
   * require the `x-issuepilot-project` header and reject the legacy
   * `?project=` query (per spec §18.3 team-mode rules).
   */
  pipelinesByProject?: Map<string, PipelineService>;
}

function resolveSnapshotField<T>(
  value: T | (() => T) | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  return typeof value === "function" ? (value as () => T)() : value;
}

function parseOptionalPositiveInt(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  return Number(value);
}

function parseOptionalNonNegativeInt(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value);
}

function eventCreatedAt(event: EventRecord): string | undefined {
  const value = event["createdAt"] ?? event["ts"];
  return typeof value === "string" ? value : undefined;
}

function compareEventTime(a: EventRecord, b: EventRecord): number {
  const aTime = Date.parse(eventCreatedAt(a) ?? "");
  const bTime = Date.parse(eventCreatedAt(b) ?? "");
  if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
  if (Number.isNaN(aTime)) return -1;
  if (Number.isNaN(bTime)) return 1;
  return aTime - bTime;
}

function summarizeLastEvent(
  events: EventRecord[],
): { type: string; message: string; createdAt?: string } | undefined {
  const last = [...events].sort(compareEventTime).at(-1);
  if (!last) return undefined;
  const createdAt = eventCreatedAt(last);
  return {
    type: last.type,
    message: last.message,
    ...(createdAt ? { createdAt } : {}),
  };
}

function countTurnEvents(events: EventRecord[]): number {
  return events.filter(
    (event) =>
      event.type.startsWith("turn_") || event.type.startsWith("codex_turn_"),
  ).length;
}

function enrichRunForDashboard<T extends Record<string, unknown>>(
  run: T,
  events: EventRecord[],
  reports?: ReportStore,
): T & {
  turnCount: number;
  lastEvent?: { type: string; message: string; createdAt?: string };
  report?: RunReportSummary;
} {
  const lastEvent = summarizeLastEvent(events);
  const runId = typeof run["runId"] === "string" ? run["runId"] : "";
  const report = runId ? reports?.summary(runId) : undefined;
  return {
    ...run,
    turnCount: countTurnEvents(events),
    ...(lastEvent ? { lastEvent } : {}),
    ...(report ? { report } : {}),
  };
}

function buildDashboardSummary(
  runs: Array<Record<string, unknown>>,
  handoffLabel: string,
): Record<string, number> {
  // NOTE: `stopping` is intentionally not bucketed. It's a transient state
  // produced only when `stopRun` fails to cancel (cancel_timeout etc.) and
  // resolves quickly via `turnTimeoutMs` into `failed`. The dashboard summary
  // contract `DASHBOARD_SUMMARY_VALUES` (spec §14) only tracks long-lived
  // states. Surfacing `stopping` would require coordinated changes to
  // `packages/shared-contracts` and the dashboard `SummaryCards` highlight
  // map, which is out of Phase 2 scope.
  const summary = {
    running: 0,
    retrying: 0,
    "human-review": 0,
    failed: 0,
    blocked: 0,
  };

  for (const run of runs) {
    if (run["status"] === "running") summary.running += 1;
    if (run["status"] === "retrying") summary.retrying += 1;
    if (run["status"] === "failed") summary.failed += 1;
    if (run["status"] === "blocked") summary.blocked += 1;
    const issue = run["issue"];
    const labels =
      typeof issue === "object" && issue !== null && "labels" in issue
        ? (issue.labels as unknown)
        : undefined;
    if (Array.isArray(labels) && labels.includes(handoffLabel)) {
      summary["human-review"] += 1;
    }
  }

  return summary;
}

export async function createServer(
  deps: ServerDeps,
  opts: { host?: string; port?: number } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook("onSend", async (_request, reply, payload) => {
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!contentType.includes("application/json")) return payload;

    const text = Buffer.isBuffer(payload) ? payload.toString("utf-8") : payload;
    if (typeof text !== "string" || text.length === 0) return payload;

    try {
      return JSON.stringify(redact(JSON.parse(text)));
    } catch {
      return payload;
    }
  });

  app.get("/api/state", async () => {
    const runtime = resolveSnapshotField(deps.runtime);
    const projects = resolveSnapshotField(deps.projects);
    const workspaceUsageGb = resolveSnapshotField(deps.workspaceUsageGb);
    const nextCleanupAt = resolveSnapshotField(deps.nextCleanupAt);
    return {
      service: {
        status: "ready",
        workflowPath: deps.workflowPath,
        gitlabProject: deps.gitlabProject,
        pollIntervalMs: deps.pollIntervalMs,
        concurrency: deps.concurrency,
        lastConfigReloadAt: deps.state.lastConfigReloadAt,
        lastPollAt: deps.state.lastPollAt,
        ...(typeof workspaceUsageGb === "number" ? { workspaceUsageGb } : {}),
        ...(typeof nextCleanupAt === "string" ? { nextCleanupAt } : {}),
      },
      summary: buildDashboardSummary(
        deps.state.allRuns(),
        deps.handoffLabel ?? "human-review",
      ),
      ...(runtime ? { runtime } : {}),
      ...(projects ? { projects } : {}),
    };
  });

  app.get<{
    Querystring: { status?: string; limit?: string; includeArchived?: string };
  }>("/api/runs", async (request, reply) => {
    const status = request.query.status;
    const limit = parseOptionalPositiveInt(request.query.limit);
    if (request.query.limit !== undefined && limit === undefined) {
      return reply
        .code(400)
        .send({ error: "limit must be a positive integer" });
    }
    const includeArchived = request.query.includeArchived === "true";
    let runs = status ? deps.state.listRuns(status) : deps.state.allRuns();
    if (!includeArchived) {
      runs = runs.filter(
        (run) => !(run as { archivedAt?: unknown }).archivedAt,
      );
    }
    runs = runs.slice(0, limit ?? 50);
    return Promise.all(
      runs.map(async (run) =>
        enrichRunForDashboard(
          run,
          await deps.readEvents(run.runId),
          deps.reports,
        ),
      ),
    );
  });

  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId",
    async (request, reply) => {
      const { runId } = request.params;
      const run = deps.state.getRun(runId);
      if (!run) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const [events, logsTail, report] = await Promise.all([
        deps.readEvents(runId, { limit: 200 }),
        deps.readLogsTail?.(runId, { limit: 200 }) ?? Promise.resolve([]),
        deps.reports?.get(runId) ?? Promise.resolve(undefined),
      ]);
      return {
        run: enrichRunForDashboard(run, events, deps.reports),
        events,
        logsTail,
        ...(report ? { report } : {}),
      };
    },
  );

  app.get("/api/reports", async (request, reply) => {
    if (deps.reportsByProject && deps.reportsByProject.size > 0) {
      const raw = request.headers["x-issuepilot-project"];
      const project = Array.isArray(raw) ? raw[0] : raw;
      if (typeof project !== "string" || project.length === 0) {
        return reply
          .code(400)
          .send(
            routeError(
              "project_required",
              "x-issuepilot-project header is required for reports in team mode",
            ),
          );
      }
      const store = deps.reportsByProject.get(project);
      if (!store) {
        return reply
          .code(404)
          .send(routeError("project_not_found", `Unknown project: ${project}`));
      }
      return { reports: store.allSummaries() };
    }
    return { reports: deps.reports?.allSummaries() ?? [] };
  });

  app.get<{
    Querystring: { runId?: string; limit?: string; offset?: string };
  }>("/api/events", async (request, reply) => {
    const runId = request.query.runId;
    if (!runId) {
      return reply.code(400).send({ error: "runId is required" });
    }

    const limit = parseOptionalPositiveInt(request.query.limit);
    if (request.query.limit !== undefined && limit === undefined) {
      return reply
        .code(400)
        .send({ error: "limit must be a positive integer" });
    }

    const offset = parseOptionalNonNegativeInt(request.query.offset);
    if (request.query.offset !== undefined && offset === undefined) {
      return reply
        .code(400)
        .send({ error: "offset must be a non-negative integer" });
    }

    const opts =
      offset === undefined
        ? { limit: limit ?? 100 }
        : {
            limit: limit ?? 100,
            offset,
          };

    return deps.readEvents(runId, opts);
  });

  app.get("/api/events/stream", (request, reply) => {
    const runIdFilter = (request.query as { runId?: string }).runId;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const keepalive = setInterval(() => {
      reply.raw.write(": keepalive\n\n");
    }, 15_000);

    const unsub = deps.eventBus.subscribe(
      (event) => {
        reply.raw.write(`data: ${JSON.stringify(redact(event))}\n\n`);
      },
      runIdFilter ? (e) => e.runId === runIdFilter : undefined,
    );

    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsub();
    });
    reply.raw.write(": connected\n\n");
  });

  function statusFromCode(code: string): number {
    if (code === "not_found") return 404;
    if (code === "invalid_status" || code === "cancel_failed") return 409;
    if (code === "gitlab_failed" || code === "internal_error") return 500;
    return 500;
  }

  function extractOperator(headers: Record<string, unknown>): string {
    const raw = headers["x-issuepilot-operator"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length === 0) return "system";
    return value;
  }

  app.post<{
    Params: { runId: string };
  }>("/api/runs/:runId/retry", async (request, reply) => {
    if (!deps.operatorActions) {
      return reply.code(503).send({ ok: false, code: "actions_unavailable" });
    }
    const operator = extractOperator(
      request.headers as Record<string, unknown>,
    );
    const result = await deps.operatorActions.retry({
      runId: request.params.runId,
      operator,
    });
    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(statusFromCode(result.code)).send(result);
  });

  app.post<{
    Params: { runId: string };
    Querystring: { cancelTimeoutMs?: string };
  }>("/api/runs/:runId/stop", async (request, reply) => {
    if (!deps.operatorActions) {
      return reply.code(503).send({ ok: false, code: "actions_unavailable" });
    }
    const operator = extractOperator(
      request.headers as Record<string, unknown>,
    );
    const cancelTimeoutMs = parseOptionalPositiveInt(
      request.query.cancelTimeoutMs,
    );
    if (
      request.query.cancelTimeoutMs !== undefined &&
      cancelTimeoutMs === undefined
    ) {
      return reply
        .code(400)
        .send({ error: "cancelTimeoutMs must be a positive integer" });
    }
    const result = await deps.operatorActions.stop({
      runId: request.params.runId,
      operator,
      ...(cancelTimeoutMs !== undefined ? { cancelTimeoutMs } : {}),
    });
    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(statusFromCode(result.code)).send(result);
  });

  app.post<{
    Params: { runId: string };
  }>("/api/runs/:runId/archive", async (request, reply) => {
    if (!deps.operatorActions) {
      return reply.code(503).send({ ok: false, code: "actions_unavailable" });
    }
    const operator = extractOperator(
      request.headers as Record<string, unknown>,
    );
    const result = await deps.operatorActions.archive({
      runId: request.params.runId,
      operator,
    });
    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(statusFromCode(result.code)).send(result);
  });

  function workItemsUnavailable(): {
    ok: false;
    code: "work_items_unavailable";
  } {
    return { ok: false, code: "work_items_unavailable" } as const;
  }

  function statusFromWorkItemCode(code: string): number {
    if (code === "not_found") return 404;
    if (code === "report_not_ready") return 404;
    if (code === "invalid_status") return 409;
    if (code === "invalid_iid") return 400;
    if (code === "missing_plan_id") return 400;
    if (code === "validation_failed") return 422;
    if (code === "planner_failed") return 500;
    if (code === "gitlab_failed") return 500;
    return 500;
  }

  type WorkItemRouteContext =
    | { ok: true; service: WorkItemService; projectId?: string }
    | {
        ok: false;
        statusCode: number;
        body: { ok: false; code: string; message?: string };
      };

  /**
   * Resolve the WorkItemService for a request:
   *  - When `workItemsByProject` is wired (team-mode), require the
   *    `x-issuepilot-project` header and look up by project id.
   *  - Otherwise fall back to the single `workItems` service.
   *  - When neither is wired, return HTTP 503 `work_items_unavailable`.
   */
  function resolveWorkItemService(
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ): WorkItemRouteContext {
    if (deps.workItemsByProject && deps.workItemsByProject.size > 0) {
      const raw = headers["x-issuepilot-project"] ?? queryProject;
      const project = Array.isArray(raw) ? raw[0] : raw;
      if (typeof project !== "string" || project.length === 0) {
        return {
          ok: false,
          statusCode: 400,
          body: {
            ok: false,
            code: "project_header_required",
            message:
              "x-issuepilot-project header is required when the orchestrator runs in team-mode",
          },
        };
      }
      const svc = deps.workItemsByProject.get(project);
      if (!svc) {
        return {
          ok: false,
          statusCode: 404,
          body: {
            ok: false,
            code: "project_not_found",
            message: `Unknown project: ${project}`,
          },
        };
      }
      return { ok: true, service: svc, projectId: project };
    }
    if (!deps.workItems) {
      return {
        ok: false,
        statusCode: 503,
        body: workItemsUnavailable(),
      };
    }
    return { ok: true, service: deps.workItems };
  }

  function resolveReportStore(ctx: {
    projectId?: string;
  }): ReportStore | undefined {
    return ctx.projectId
      ? deps.reportsByProject?.get(ctx.projectId)
      : deps.reports;
  }

  function workItemErrorBody(error: WorkItemServiceError["error"]) {
    return { ok: false, ...error };
  }

  function routeError(code: string, message: string) {
    return { ok: false, code, message };
  }

  function requiredQueryString(value: unknown, name: string) {
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false as const,
        body: routeError(
          "validation_failed",
          `${name} must be a non-empty string`,
        ),
      };
    }
    return { ok: true as const, value };
  }

  function optionalQueryString(value: unknown, name: string) {
    if (value === undefined) return { ok: true as const, value: undefined };
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false as const,
        body: routeError(
          "validation_failed",
          `${name} must be a non-empty string`,
        ),
      };
    }
    return { ok: true as const, value };
  }

  app.post<{ Params: { iid: string }; Body?: { regenerate?: boolean } }>(
    "/api/issues/:iid/plan",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const iidNum = Number(request.params.iid);
      if (!Number.isInteger(iidNum) || iidNum <= 0) {
        return reply
          .code(400)
          .send({
            ok: false,
            code: "invalid_iid",
            message: "iid must be a positive integer",
          });
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const regenerate = request.body?.regenerate === true;
      const result = await ctx.service.planFromIssue({
        iid: iidNum,
        regenerate,
        operator,
      });
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.get("/api/work-items", async (request, reply) => {
    const ctx = resolveWorkItemService(
      request.headers as Record<string, unknown>,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const workItems = await ctx.service.list();
    const counters: Record<WorkItemStatus, number> = Object.fromEntries(
      WORK_ITEM_STATUS_VALUES.map((s) => [s, 0]),
    ) as Record<WorkItemStatus, number>;
    for (const wi of workItems) {
      if (wi.status in counters) counters[wi.status] += 1;
    }
    return reply.code(200).send({ workItems, counters });
  });

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const detail = await ctx.service.detail(request.params.id);
      if (!detail) {
        return reply
          .code(404)
          .send({
            ok: false,
            code: "not_found",
            message: "work item not found",
          });
      }
      return reply.code(200).send(detail);
    },
  );

  app.post<{
    Params: { id: string };
    Body?: {
      planId?: string;
      edits?: AcceptWorkItemPlanRequest["edits"];
    };
  }>("/api/work-items/:id/plan/accept", async (request, reply) => {
    const ctx = resolveWorkItemService(
      request.headers as Record<string, unknown>,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const planId = request.body?.planId;
    if (typeof planId !== "string" || planId.length === 0) {
      return reply.code(400).send({
        ok: false,
        code: "missing_plan_id",
        message: "planId is required",
      });
    }
    const edits = Array.isArray(request.body?.edits) ? request.body.edits : [];
    const operator = extractOperator(
      request.headers as Record<string, unknown>,
    );
    const result = await ctx.service.acceptPlan({
      planId,
      edits,
      operator,
      workItemId: request.params.id,
    });
    if ("error" in result) {
      return reply
        .code(statusFromWorkItemCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result);
  });

  app.post<{ Params: { id: string } }>(
    "/api/work-items/:id/plan/regenerate",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await ctx.service.regeneratePlan(
        request.params.id,
        operator,
      );
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/work-items/:id/tasks/:taskId/skip",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await ctx.service.skipTask(
        request.params.id,
        request.params.taskId,
        operator,
      );
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/work-items/:id/tasks/:taskId/retry",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await ctx.service.retryTask(
        request.params.id,
        request.params.taskId,
        operator,
      );
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.post<{
    Params: { id: string; taskId: string };
    Body?: { reason?: string; hint?: string };
  }>("/api/work-items/:id/tasks/:taskId/replan", async (request, reply) => {
    const ctx = resolveWorkItemService(
      request.headers as Record<string, unknown>,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
    const reason = (request.body?.reason ?? "").trim();
    if (reason.length === 0) {
      return reply.code(422).send({
        ok: false,
        code: "validation_failed",
        message: "reason is required",
      });
    }
    const operator = extractOperator(
      request.headers as Record<string, unknown>,
    );
    const hint =
      typeof request.body?.hint === "string" && request.body.hint.length > 0
        ? request.body.hint
        : undefined;
    const result = await ctx.service.replanTask({
      workItemId: request.params.id,
      taskId: request.params.taskId,
      reason,
      ...(hint !== undefined ? { hint } : {}),
      operator,
    });
    if ("error" in result) {
      return reply
        .code(statusFromWorkItemCode(result.error.code))
        .send({ ok: false, ...result.error });
    }
    return reply.code(200).send(result);
  });

  app.post<{
    Params: { id: string; taskId: string };
    Body?: { reason?: string };
  }>(
    "/api/work-items/:id/tasks/:taskId/mark-rework",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const reason = (request.body?.reason ?? "").trim();
      if (reason.length === 0) {
        return reply.code(422).send({
          ok: false,
          code: "validation_failed",
          message: "reason is required",
        });
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await ctx.service.markNeedsRework({
        workItemId: request.params.id,
        taskId: request.params.taskId,
        reason,
        operator,
      });
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/work-items/:id/tasks/:taskId/unskip",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await ctx.service.unskipTask({
        workItemId: request.params.id,
        taskId: request.params.taskId,
        operator,
      });
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id/graph",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.graph(request.params.id);
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return reply.code(200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id/report.md",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.getReportMarkdown(request.params.id);
      if (typeof result !== "string") {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send(workItemErrorBody(result.error));
      }
      return reply.type("text/markdown; charset=utf-8").code(200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id/evidence",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.getEvidence(request.params.id);
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send(workItemErrorBody(result.error));
      }
      return reply.code(200).send(result);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { runId?: unknown; path?: unknown; project?: unknown };
  }>("/api/work-items/:id/evidence/file", async (request, reply) => {
    const project = optionalQueryString(request.query.project, "project");
    if (!project.ok) return reply.code(400).send(project.body);
    const ctx = resolveWorkItemService(
      request.headers as Record<string, unknown>,
      project.value,
    );
    if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);

    const runId = requiredQueryString(request.query.runId, "runId");
    if (!runId.ok) return reply.code(400).send(runId.body);
    const relPath = requiredQueryString(request.query.path, "path");
    if (!relPath.ok) return reply.code(400).send(relPath.body);

    const detail = await ctx.service.detail(request.params.id);
    const linked =
      detail?.runLinks.some((link) => link.runId === runId.value) ?? false;
    if (!linked) {
      return reply
        .code(404)
        .send(routeError("not_found", "run is not linked to work item"));
    }

    const report = await resolveReportStore(ctx)?.get(runId.value);
    const taskWorktreePath = report?.run.workspacePath;
    if (!taskWorktreePath) {
      return reply
        .code(404)
        .send(routeError("not_found", "run report workspace not found"));
    }

    const result = await serveEvidenceFile({
      taskWorktreePath,
      runId: runId.value,
      relPath: relPath.value,
    });
    if (!result.ok) {
      const status =
        result.error === "forbidden"
          ? 403
          : result.error === "oversized"
            ? 413
            : 404;
      return reply.code(status).send(routeError(result.error, result.error));
    }

    return reply
      .type(result.mediaType)
      .header("content-length", String(result.sizeBytes))
      .code(200)
      .send(createReadStream(result.absPath));
  });

  app.post<{
    Params: { id: string; taskId: string; evidenceId: string };
    Body?: { operator?: string };
  }>(
    "/api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const bodyOperator =
        typeof request.body?.operator === "string" &&
        request.body.operator.length > 0
          ? request.body.operator
          : undefined;
      const operator =
        bodyOperator ??
        extractOperator(request.headers as Record<string, unknown>);
      const result = await ctx.service.confirmTaskEvidence(
        request.params.id,
        request.params.taskId,
        request.params.evidenceId,
        { operator },
      );
      if ("error" in result) {
        return reply
          .code(statusFromWorkItemCode(result.error.code))
          .send(workItemErrorBody(result.error));
      }
      return reply.code(200).send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id/report",
    async (request, reply) => {
      const ctx = resolveWorkItemService(
        request.headers as Record<string, unknown>,
      );
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const report = await ctx.service.report(request.params.id);
      return reply.code(200).send({ report });
    },
  );

  /**
   * Returns the quality summary for the current project scope. Reads:
   *   - `deps.qualityByProject` (team mode) keyed on `x-issuepilot-project`.
   *   - `deps.quality` (single mode).
   *   - `deps.reports` fallback when nothing else is wired so V4.4 still
   *     produces a stable, run-only summary.
   *
   * Rejects the legacy `project=` query so dashboards can never accidentally
   * leak cross-project analytics — team-mode scope flows exclusively through
   * `x-issuepilot-project`.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/quality/summary",
    async (request, reply) => {
      const headers = request.headers as Record<string, unknown>;
      const query = request.query ?? {};

      if (query["project"] !== undefined) {
        return reply
          .code(400)
          .send(
            routeError(
              "project_query_unsupported",
              "project query is not supported; team mode uses x-issuepilot-project",
            ),
          );
      }

      let depsForRequest: QualityCollectorDeps | undefined;
      let scope: {
        mode: "single-project" | "team-project";
        projectId?: string;
      };

      if (deps.qualityByProject && deps.qualityByProject.size > 0) {
        const raw = headers["x-issuepilot-project"];
        const project = Array.isArray(raw) ? raw[0] : raw;
        if (typeof project !== "string" || project.length === 0) {
          return reply
            .code(400)
            .send(
              routeError(
                "project_required",
                "x-issuepilot-project header is required for quality summary in team mode",
              ),
            );
        }
        const projectDeps = deps.qualityByProject.get(project);
        if (!projectDeps) {
          return reply
            .code(404)
            .send(
              routeError("project_not_found", `Unknown project: ${project}`),
            );
        }
        depsForRequest = projectDeps;
        scope = { mode: "team-project", projectId: project };
      } else {
        depsForRequest = deps.quality ?? {
          ...(deps.reports ? { reports: deps.reports } : {}),
        };
        scope = { mode: "single-project" };
      }

      const parseInput = {
        ...(typeof query["workflow"] === "string"
          ? { workflow: query["workflow"] }
          : {}),
        ...(typeof query["taskType"] === "string"
          ? { taskType: query["taskType"] }
          : {}),
        ...(typeof query["status"] === "string"
          ? { status: query["status"] }
          : {}),
        ...(typeof query["pattern"] === "string"
          ? { pattern: query["pattern"] }
          : {}),
        ...(typeof query["from"] === "string" ? { from: query["from"] } : {}),
        ...(typeof query["to"] === "string" ? { to: query["to"] } : {}),
        ...(typeof query["window"] === "string"
          ? { window: query["window"] }
          : {}),
      };
      const parsed = parseQualityQuery(parseInput, {
        now: new Date().toISOString(),
      });
      if (parsed.error || !parsed.filters) {
        return reply
          .code(400)
          .send(
            routeError(
              parsed.error?.code ?? "invalid_query",
              parsed.error?.message ?? "invalid quality query",
            ),
          );
      }

      const collection = await collectQualitySources(depsForRequest ?? {});
      const summary = buildQualitySummary({
        items: collection.items,
        filters: parsed.filters,
        scope,
        diagnostics: collection.diagnostics,
      });
      return reply.code(200).send(summary);
    },
  );

  /**
   * V4.5 Improvement Loop: resolve the per-request service.
   * - Team mode (`improvementsByProject` set): requires `x-issuepilot-project`
   *   header; unknown project → 404; missing header → 400. Mirrors the
   *   quality summary behaviour so dashboards cannot leak cross-project
   *   recommendations.
   * - Single mode: falls back to `improvements`. When not configured the
   *   server returns a deterministic 503 instead of a 5xx.
   */
  function resolveImprovementService(
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ): ImprovementRouteContext {
    if (deps.improvementsByProject && deps.improvementsByProject.size > 0) {
      const raw = headers["x-issuepilot-project"] ?? queryProject;
      const project = Array.isArray(raw) ? raw[0] : raw;
      if (typeof project !== "string" || project.length === 0) {
        return {
          ok: false,
          statusCode: 400,
          body: improvementRouteError(
            "project_required",
            "x-issuepilot-project header is required for improvements in team mode",
          ),
        };
      }
      const service = deps.improvementsByProject.get(project);
      if (!service) {
        return {
          ok: false,
          statusCode: 404,
          body: improvementRouteError(
            "project_not_found",
            `Unknown project: ${project}`,
          ),
        };
      }
      return { ok: true, service, projectId: project };
    }
    if (!deps.improvements) {
      return {
        ok: false,
        statusCode: 503,
        body: improvementRouteError(
          "improvements_unavailable",
          "Improvement recommendation service is not configured",
        ),
      };
    }
    return { ok: true, service: deps.improvements };
  }

  registerImprovementRoutes(app, resolveImprovementService);

  /**
   * V4.6 Multi-Agent Pipeline: resolve the per-request pipeline service.
   * - Team mode (`pipelinesByProject` set): requires `x-issuepilot-project`
   *   header and rejects the legacy `?project=` query string with
   *   `project_query_not_allowed` (spec §18.3).
   * - Single mode: falls back to `pipelines`. When not configured the
   *   server returns 503 `pipelines_unavailable` so dashboards see a
   *   deterministic error instead of a 5xx.
   */
  function resolvePipelineService(
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ): PipelineRouteContext {
    if (deps.pipelinesByProject && deps.pipelinesByProject.size > 0) {
      if (queryProject !== undefined) {
        return {
          ok: false,
          statusCode: 400,
          body: {
            ok: false,
            code: "project_query_not_allowed",
            message:
              "project query is not supported; team mode uses x-issuepilot-project",
          },
        };
      }
      const raw = headers["x-issuepilot-project"];
      const project = Array.isArray(raw) ? raw[0] : raw;
      if (typeof project !== "string" || project.length === 0) {
        return {
          ok: false,
          statusCode: 400,
          body: {
            ok: false,
            code: "project_required",
            message:
              "x-issuepilot-project header is required for pipelines in team mode",
          },
        };
      }
      const service = deps.pipelinesByProject.get(project);
      if (!service) {
        return {
          ok: false,
          statusCode: 404,
          body: {
            ok: false,
            code: "project_not_found",
            message: `Unknown project: ${project}`,
          },
        };
      }
      return { ok: true, service, projectId: project };
    }
    if (!deps.pipelines) {
      return {
        ok: false,
        statusCode: 503,
        body: {
          ok: false,
          // 503 falls outside spec §18.4; we still use a deterministic shape
          // so dashboards can render a clear "service unavailable" hint
          // instead of a 5xx black box.
          code: "agent_report_not_found",
          message: "Pipeline service is not configured on this orchestrator",
        },
      };
    }
    return { ok: true, service: deps.pipelines };
  }

  registerPipelineRoutes(app, resolvePipelineService);

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4738;
  await app.listen({ host, port });

  return app;
}
