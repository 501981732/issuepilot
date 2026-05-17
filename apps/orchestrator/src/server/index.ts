import {
  redact,
  type EventBus,
  type EventRecord,
} from "@issuepilot/observability";
import type {
  AcceptWorkItemPlanRequest,
  IssuePilotInternalEvent,
  ProjectSummary,
  RunReportSummary,
  TaskPlan,
  TeamRuntimeSummary,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemReport,
  WorkItemStatus,
} from "@issuepilot/shared-contracts";
import { WORK_ITEM_STATUS_VALUES } from "@issuepilot/shared-contracts";
import Fastify, { type FastifyInstance } from "fastify";

import type { OperatorActionResult } from "../operations/actions.js";
import type { ReportStore } from "../reports/store.js";
import type { RuntimeState } from "../runtime/state.js";

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
  graph(
    id: string,
  ): Promise<
    | {
        levels: string[][];
        edges: Array<{ from: string; to: string }>;
        criticalPathTaskIds: string[];
      }
    | WorkItemServiceError
  >;
  report(id: string): Promise<WorkItemReport | undefined>;
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
   * V4.1 Workflow Spine: WorkItem orchestration façade. When absent,
   * `/api/issues/:iid/plan` and `/api/work-items/*` routes uniformly
   * return HTTP 503 `work_items_unavailable` so dashboards see a
   * deterministic error instead of a route-level 404.
   */
  workItems?: WorkItemService;
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

  app.get("/api/reports", async () => {
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
    if (code === "invalid_status") return 409;
    if (code === "invalid_iid") return 400;
    if (code === "missing_plan_id") return 400;
    if (code === "validation_failed") return 422;
    if (code === "planner_failed") return 500;
    if (code === "gitlab_failed") return 500;
    return 500;
  }

  app.post<{ Params: { iid: string }; Body?: { regenerate?: boolean } }>(
    "/api/issues/:iid/plan",
    async (request, reply) => {
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const iidNum = Number(request.params.iid);
      if (!Number.isInteger(iidNum) || iidNum <= 0) {
        return reply
          .code(400)
          .send({ ok: false, code: "invalid_iid", message: "iid must be a positive integer" });
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const regenerate = request.body?.regenerate === true;
      const result = await deps.workItems.planFromIssue({
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

  app.get("/api/work-items", async (_request, reply) => {
    if (!deps.workItems) {
      return reply.code(503).send(workItemsUnavailable());
    }
    const workItems = await deps.workItems.list();
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
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const detail = await deps.workItems.detail(request.params.id);
      if (!detail) {
        return reply
          .code(404)
          .send({ ok: false, code: "not_found", message: "work item not found" });
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
    if (!deps.workItems) {
      return reply.code(503).send(workItemsUnavailable());
    }
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
    const result = await deps.workItems.acceptPlan({
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
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await deps.workItems.regeneratePlan(
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
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await deps.workItems.skipTask(
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
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const operator = extractOperator(
        request.headers as Record<string, unknown>,
      );
      const result = await deps.workItems.retryTask(
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

  app.get<{ Params: { id: string } }>(
    "/api/work-items/:id/report",
    async (request, reply) => {
      if (!deps.workItems) {
        return reply.code(503).send(workItemsUnavailable());
      }
      const report = await deps.workItems.report(request.params.id);
      return reply.code(200).send({ report });
    },
  );

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4738;
  await app.listen({ host, port });

  return app;
}
