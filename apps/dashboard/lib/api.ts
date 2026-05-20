import type {
  AcceptWorkItemPlanRequest,
  AgentRole,
  ConfirmEvidenceResponse,
  FailurePatternId,
  GetAgentReportResponse,
  GetPipelineResponse,
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendationDetailResponse,
  ImprovementRecommendationFilters,
  ImprovementRecommendationsListResponse,
  IssuePilotEvent,
  ListPipelineRunAgentReportsResponse,
  ListPipelinesResponse,
  ListTaskAgentReportsResponse,
  MarkTaskReworkRequest,
  OrchestratorStateSnapshot,
  QualityStatusFilter,
  QualitySummaryResponse,
  ReplanTaskRequest,
  ReportsListResponse,
  RetryAgentReportRequest,
  RetryAgentReportResponse,
  RevokeAiReviewResponse,
  RunDetailResponse,
  RunRecord,
  RunReportSummary,
  RunStatus,
  SetRecipeOverrideRequest,
  SetRecipeOverrideResponse,
  SkipAgentReportRequest,
  SkipAgentReportResponse,
  TaskPlan,
  ValidateWorkflowRolesResponse,
  WorkflowRecipe,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemEvidenceResponse,
  WorkItemGraphResponse,
  WorkItemReportResponse,
  WorkItemsListResponse,
} from "@issuepilot/shared-contracts";

/**
 * V2.5 Command Center: each run row in `GET /api/runs` carries an
 * inline `report` summary when the orchestrator's report store knows
 * about it. Legacy runs lack the field; callers should treat it as
 * optional.
 */
export type RunWithReport = RunRecord & { report?: RunReportSummary };

const DEFAULT_API_BASE = "http://127.0.0.1:4738";

/**
 * Resolve the orchestrator HTTP API base URL.
 *
 * Order of precedence:
 *   1. `NEXT_PUBLIC_API_BASE` (exposed to the browser by Next.js)
 *   2. Hard default `http://127.0.0.1:4738` per spec §14
 *
 * Trailing slashes are stripped so callers can safely concatenate paths.
 */
export function resolveApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_BASE;
  const base = raw && raw.length > 0 ? raw : DEFAULT_API_BASE;
  return base.replace(/\/+$/, "");
}

export class ApiError extends Error {
  override name = "ApiError";
  /**
   * The orchestrator `code` field (e.g. `invalid_status`, `cancel_failed`,
   * `actions_unavailable`). Populated when the response body is a JSON
   * object containing a string `code`; otherwise undefined.
   */
  public readonly code: string | undefined;
  /**
   * Secondary discriminator surfaced by the `stop` action when cancel
   * fails (one of `cancel_timeout` / `cancel_threw` / `not_registered`).
   */
  public readonly reason: string | undefined;
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    if (body && typeof body === "object") {
      const data = body as { code?: unknown; reason?: unknown };
      if (typeof data.code === "string") this.code = data.code;
      if (typeof data.reason === "string") this.reason = data.reason;
    }
  }
}

export interface ApiGetOptions {
  signal?: AbortSignal;
  /**
   * V4.2 team-mode: when the orchestrator runs with `workItemsByProject`,
   * every work-item route requires the `x-issuepilot-project` header so
   * the server can route to the correct project namespace. Pass this
   * option to override the module-level active project for a single call,
   * or rely on {@link setActiveWorkItemsProject} for project-wide defaults.
   */
  project?: string;
}

/**
 * V4.2 team-mode: module-level "active" project id consumed by every
 * dashboard API request that talks to work-items routes. ProjectSwitcher
 * writes here when the operator picks a project so subsequent requests
 * automatically carry the header — without this the user would have to
 * thread the project id through every component. `opts.project` on a
 * given call still wins so callers can target a different project ad
 * hoc.
 */
let activeWorkItemsProject: string | null = null;

export function setActiveWorkItemsProject(project: string | null): void {
  activeWorkItemsProject = project && project.length > 0 ? project : null;
}

export function getActiveWorkItemsProject(): string | null {
  return activeWorkItemsProject;
}

/**
 * Pick the project id to attach via `x-issuepilot-project` header. Order:
 *   1. explicit `opts.project`
 *   2. {@link activeWorkItemsProject} (set by ProjectSwitcher)
 *   3. undefined → no header (single-mode daemon behaviour)
 */
function resolveProjectHeader(opts: { project?: string }): string | undefined {
  if (typeof opts.project === "string" && opts.project.length > 0) {
    return opts.project;
  }
  return activeWorkItemsProject ?? undefined;
}

export async function apiGet<T>(
  path: string,
  opts: ApiGetOptions = {},
): Promise<T> {
  const url = `${resolveApiBase()}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  const project = resolveProjectHeader(opts);
  if (project) headers["x-issuepilot-project"] = project;
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: opts.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new ApiError(
      `GET ${path} failed: HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  return (await response.json()) as T;
}

async function apiGetText(
  path: string,
  opts: ApiGetOptions = {},
): Promise<string> {
  const url = `${resolveApiBase()}${path}`;
  const headers: Record<string, string> = { accept: "text/markdown" };
  const project = resolveProjectHeader(opts);
  if (project) headers["x-issuepilot-project"] = project;
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: opts.signal,
    cache: "no-store",
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new ApiError(
      `GET ${path} failed: HTTP ${response.status}`,
      response.status,
      body,
    );
  }

  return response.text();
}

export function getState(
  opts: ApiGetOptions = {},
): Promise<OrchestratorStateSnapshot> {
  return apiGet<OrchestratorStateSnapshot>("/api/state", opts);
}

export interface ListRunsParams {
  status?: RunStatus | readonly RunStatus[];
  limit?: number;
  /**
   * When true, sends `?includeArchived=true` so the orchestrator returns
   * runs whose `archivedAt` field is set. Operator-archived runs are
   * hidden by default in both the orchestrator response and dashboard
   * tables; flip this to true to surface them under "Show archived".
   */
  includeArchived?: boolean;
}

export function listRuns(
  params: ListRunsParams = {},
  opts: ApiGetOptions = {},
): Promise<RunWithReport[]> {
  const search = new URLSearchParams();
  if (params.status) {
    const value = Array.isArray(params.status)
      ? params.status.join(",")
      : (params.status as string);
    if (value.length > 0) search.set("status", value);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(params.limit));
  }
  if (params.includeArchived === true) {
    search.set("includeArchived", "true");
  }
  const query = search.toString();
  return apiGet<RunWithReport[]>(`/api/runs${query ? `?${query}` : ""}`, opts);
}

export function listReports(
  opts: ApiGetOptions = {},
): Promise<ReportsListResponse> {
  return apiGet<ReportsListResponse>("/api/reports", opts);
}

/**
 * V4.4 Quality Analytics: fetch the aggregated quality summary the
 * `/reports` page renders. `params.window` defaults to 7d at the server,
 * so callers can omit it for the standard view. The function forwards the
 * active project header via {@link resolveProjectHeader} so team mode
 * routes the request through `x-issuepilot-project`.
 */
export interface GetQualitySummaryParams {
  workflow?: string;
  taskType?: string;
  from?: string;
  to?: string;
  window?: "7d" | "30d";
  pattern?: FailurePatternId;
  status?: QualityStatusFilter;
}

export function getQualitySummary(
  params: GetQualitySummaryParams = {},
  opts: ApiGetOptions = {},
): Promise<QualitySummaryResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return apiGet<QualitySummaryResponse>(
    `/api/quality/summary${query ? `?${query}` : ""}`,
    opts,
  );
}

export function getRunDetail(
  runId: string,
  opts: ApiGetOptions = {},
): Promise<RunDetailResponse> {
  return apiGet<RunDetailResponse>(
    `/api/runs/${encodeURIComponent(runId)}`,
    opts,
  );
}

export interface ListEventsParams {
  runId: string;
  limit?: number;
  offset?: number;
}

export function listEvents(
  params: ListEventsParams,
  opts: ApiGetOptions = {},
): Promise<IssuePilotEvent[]> {
  const search = new URLSearchParams({ runId: params.runId });
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(params.limit));
  }
  if (typeof params.offset === "number" && Number.isFinite(params.offset)) {
    search.set("offset", String(params.offset));
  }
  return apiGet<IssuePilotEvent[]>(`/api/events?${search.toString()}`, opts);
}

export function eventStreamUrl(runId?: string): string {
  const base = `${resolveApiBase()}/api/events/stream`;
  if (!runId) return base;
  const search = new URLSearchParams({ runId });
  return `${base}?${search.toString()}`;
}

export interface OperatorActionOptions {
  /**
   * Optional operator identity sent as the `x-issuepilot-operator` header.
   * When omitted, the dashboard relies on the orchestrator's default
   * `"system"` so V2 P0 (no auth) and V3+ (real user identity) share the
   * same wire contract.
   */
  operator?: string;
  signal?: AbortSignal;
  /**
   * V4.2 team-mode: route the action at a specific project's
   * WorkItemService. See {@link ApiGetOptions.project}.
   */
  project?: string;
}

async function postRunAction(
  runId: string,
  action: "retry" | "stop" | "archive",
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  const path = `/api/runs/${encodeURIComponent(runId)}/${action}`;
  const url = `${resolveApiBase()}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.operator && opts.operator.length > 0) {
    headers["x-issuepilot-operator"] = opts.operator;
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    cache: "no-store",
  };
  if (opts.signal) init.signal = opts.signal;
  const response = await fetch(url, init);
  if (response.ok) {
    return { ok: true };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => null);
  }
  throw new ApiError(
    `POST ${path} failed: HTTP ${response.status}`,
    response.status,
    body,
  );
}

export function retryRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "retry", opts);
}

export function stopRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "stop", opts);
}

export function archiveRun(
  runId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postRunAction(runId, "archive", opts);
}

/**
 * V4.1 Workflow Spine: Work Item REST client.
 *
 * Mirrors the orchestrator routes added in `apps/orchestrator/src/server/`:
 *
 * - POST /api/issues/:iid/plan
 * - GET  /api/work-items
 * - GET  /api/work-items/:id
 * - POST /api/work-items/:id/plan/accept
 * - POST /api/work-items/:id/plan/regenerate
 * - POST /api/work-items/:id/tasks/:taskId/skip
 * - POST /api/work-items/:id/tasks/:taskId/retry
 * - GET  /api/work-items/:id/report
 *
 * All POSTs forward the optional `x-issuepilot-operator` header so the
 * orchestrator emits operator-attributed events.
 */

async function postWorkItemAction<T>(
  path: string,
  body: unknown,
  opts: OperatorActionOptions = {},
): Promise<T> {
  const url = `${resolveApiBase()}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (opts.operator && opts.operator.length > 0) {
    headers["x-issuepilot-operator"] = opts.operator;
  }
  const project = resolveProjectHeader(opts);
  if (project) headers["x-issuepilot-project"] = project;
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  };
  if (opts.signal) init.signal = opts.signal;
  const response = await fetch(url, init);
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new ApiError(
      `POST ${path} failed: HTTP ${response.status}`,
      response.status,
      body,
    );
  }
  return (await response.json()) as T;
}

export function planWorkItem(
  iid: number,
  params: { regenerate?: boolean } = {},
  opts: OperatorActionOptions = {},
): Promise<{ workItem: WorkItem; plan: TaskPlan }> {
  return postWorkItemAction<{ workItem: WorkItem; plan: TaskPlan }>(
    `/api/issues/${encodeURIComponent(String(iid))}/plan`,
    { iid, regenerate: params.regenerate === true },
    opts,
  );
}

export function listWorkItems(
  opts: ApiGetOptions = {},
): Promise<WorkItemsListResponse> {
  return apiGet<WorkItemsListResponse>("/api/work-items", opts);
}

export function getWorkItem(
  id: string,
  opts: ApiGetOptions = {},
): Promise<WorkItemDetailResponse> {
  return apiGet<WorkItemDetailResponse>(
    `/api/work-items/${encodeURIComponent(id)}`,
    opts,
  );
}

export function acceptWorkItemPlan(
  id: string,
  body: AcceptWorkItemPlanRequest,
  opts: OperatorActionOptions = {},
): Promise<{ workItem: WorkItem; plan: TaskPlan }> {
  return postWorkItemAction<{ workItem: WorkItem; plan: TaskPlan }>(
    `/api/work-items/${encodeURIComponent(id)}/plan/accept`,
    body,
    opts,
  );
}

export function regenerateWorkItemPlan(
  id: string,
  opts: OperatorActionOptions = {},
): Promise<{ workItem: WorkItem; plan: TaskPlan }> {
  return postWorkItemAction<{ workItem: WorkItem; plan: TaskPlan }>(
    `/api/work-items/${encodeURIComponent(id)}/plan/regenerate`,
    {},
    opts,
  );
}

export function skipWorkItemTask(
  id: string,
  taskId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postWorkItemAction<{ ok: true }>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/skip`,
    {},
    opts,
  );
}

export function retryWorkItemTask(
  id: string,
  taskId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postWorkItemAction<{ ok: true }>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/retry`,
    {},
    opts,
  );
}

export function getWorkItemReport(
  id: string,
  opts: ApiGetOptions = {},
): Promise<WorkItemReportResponse> {
  return apiGet<WorkItemReportResponse>(
    `/api/work-items/${encodeURIComponent(id)}/report`,
    opts,
  );
}

export function getWorkItemEvidence(
  id: string,
  opts: ApiGetOptions = {},
): Promise<WorkItemEvidenceResponse> {
  return apiGet<WorkItemEvidenceResponse>(
    `/api/work-items/${encodeURIComponent(id)}/evidence`,
    opts,
  );
}

export function getWorkItemReportMarkdown(
  id: string,
  opts: ApiGetOptions = {},
): Promise<string> {
  return apiGetText(
    `/api/work-items/${encodeURIComponent(id)}/report.md`,
    opts,
  );
}

export function confirmWorkItemTaskEvidence(
  id: string,
  taskId: string,
  evidenceId: string,
  opts: OperatorActionOptions = {},
): Promise<ConfirmEvidenceResponse> {
  return postWorkItemAction<ConfirmEvidenceResponse>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/evidence/${encodeURIComponent(evidenceId)}/confirm`,
    {},
    opts,
  );
}

export function buildEvidenceFileUrl(
  id: string,
  runId: string,
  relPath: string,
  opts: { project?: string } = {},
): string {
  const search = new URLSearchParams({
    runId,
    path: relPath,
  });
  const project = resolveProjectHeader(opts);
  if (project) search.set("project", project);
  return `${resolveApiBase()}/api/work-items/${encodeURIComponent(
    id,
  )}/evidence/file?${search.toString()}`;
}

/**
 * V4.2 Task Graph: re-draft a single task. Returns the new plan version
 * (status `draft`) — operator still has to call {@link acceptWorkItemPlan}
 * afterwards so the replanned task can be dispatched.
 */
export function replanWorkItemTask(
  id: string,
  taskId: string,
  body: ReplanTaskRequest,
  opts: OperatorActionOptions = {},
): Promise<{ workItem: WorkItem; plan: TaskPlan }> {
  return postWorkItemAction<{ workItem: WorkItem; plan: TaskPlan }>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/replan`,
    body,
    opts,
  );
}

/**
 * V4.2 Task Graph: operator-driven rework. Transitions the task to
 * `needs_rework` and runs reconcileWorkItem so the parent Issue handoff
 * label catches up.
 */
export function markWorkItemTaskRework(
  id: string,
  taskId: string,
  body: MarkTaskReworkRequest,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postWorkItemAction<{ ok: true }>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/mark-rework`,
    body,
    opts,
  );
}

/**
 * V4.2 Task Graph: roll back a previous skip. The task returns to
 * `ready` and the next orchestration tick can dispatch it.
 */
export function unskipWorkItemTask(
  id: string,
  taskId: string,
  opts: OperatorActionOptions = {},
): Promise<{ ok: true }> {
  return postWorkItemAction<{ ok: true }>(
    `/api/work-items/${encodeURIComponent(id)}/tasks/${encodeURIComponent(
      taskId,
    )}/unskip`,
    {},
    opts,
  );
}

/**
 * V4.2 Task Graph: layered graph projection (levels + edges + critical
 * path) for the dashboard graph view.
 */
export function getWorkItemGraph(
  id: string,
  opts: ApiGetOptions = {},
): Promise<WorkItemGraphResponse> {
  return apiGet<WorkItemGraphResponse>(
    `/api/work-items/${encodeURIComponent(id)}/graph`,
    opts,
  );
}

/**
 * V4.5 Improvement Loop dashboard client.
 *
 * Wraps the orchestrator routes added in
 * `apps/orchestrator/src/improvements/routes.ts`:
 *
 * - GET  /api/improvements/recommendations
 * - GET  /api/improvements/recommendations/:id
 * - POST /api/improvements/recommendations/generate
 * - POST /api/improvements/recommendations/:id/accept
 * - POST /api/improvements/recommendations/:id/reject
 * - POST /api/improvements/recommendations/:id/defer
 * - POST /api/improvements/recommendations/:id/patch-preview
 *
 * Patch preview is inert by design — the server never writes the target
 * file, the dashboard merely renders the diff for operator review.
 */
function improvementQuery(
  filters: ImprovementRecommendationFilters,
): string {
  const search = new URLSearchParams();
  if (filters.status) search.set("status", filters.status);
  if (filters.pattern) search.set("pattern", filters.pattern);
  if (filters.targetKind) search.set("targetKind", filters.targetKind);
  if (filters.workflow) search.set("workflow", filters.workflow);
  if (filters.taskType) search.set("taskType", filters.taskType);
  return search.toString();
}

export function listImprovementRecommendations(
  filters: ImprovementRecommendationFilters = {},
  opts: ApiGetOptions = {},
): Promise<ImprovementRecommendationsListResponse> {
  const query = improvementQuery(filters);
  return apiGet<ImprovementRecommendationsListResponse>(
    `/api/improvements/recommendations${query ? `?${query}` : ""}`,
    opts,
  );
}

export function getImprovementRecommendation(
  id: string,
  opts: ApiGetOptions = {},
): Promise<ImprovementRecommendationDetailResponse> {
  return apiGet<ImprovementRecommendationDetailResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}`,
    opts,
  );
}

export function generateImprovementRecommendations(
  body: ImprovementGenerateRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementGenerateResponse> {
  return postWorkItemAction<ImprovementGenerateResponse>(
    "/api/improvements/recommendations/generate",
    body,
    opts,
  );
}

export function acceptImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<ImprovementActionResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/accept`,
    body,
    effective,
  );
}

export function rejectImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<ImprovementActionResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/reject`,
    body,
    effective,
  );
}

export function deferImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<ImprovementActionResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/defer`,
    body,
    effective,
  );
}

export function previewImprovementPatch(
  id: string,
  body: ImprovementPatchPreviewRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<ImprovementActionResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/patch-preview`,
    body,
    effective,
  );
}

/**
 * V4.6 Multi-Agent Pipeline dashboard client helpers (spec §18). All URLs
 * are strictly aligned with the Fastify routes registered in
 * `apps/orchestrator/src/pipelines/routes.ts`:
 *
 * - `GET /api/work-items/:wid/tasks/:tid/pipeline`
 * - `GET /api/work-items/:wid/tasks/:tid/pipelines`
 * - `GET /api/agent-reports/:id`
 * - `GET /api/work-items/:wid/tasks/:tid/agent-reports[?role=&include_superseded=]`
 * - `GET /api/pipeline-runs/:id/agent-reports`
 * - `POST /api/work-items/:wid/tasks/:tid/pipeline/recipe-override`
 * - `POST /api/agent-reports/:id/revoke-ai-review`
 * - `POST /api/agent-reports/:id/retry`
 * - `POST /api/agent-reports/:id/skip`
 * - `GET /api/workflows/:workflowId/roles/validate`
 *
 * All helpers honour the module-level active project header
 * (`x-issuepilot-project`) via the existing `apiGet` / `postWorkItemAction`
 * plumbing.
 */
export function getPipeline(
  workItemId: string,
  taskId: string,
  opts: ApiGetOptions = {},
): Promise<GetPipelineResponse> {
  return apiGet<GetPipelineResponse>(
    `/api/work-items/${encodeURIComponent(workItemId)}/tasks/${encodeURIComponent(taskId)}/pipeline`,
    opts,
  );
}

export function listPipelines(
  workItemId: string,
  taskId: string,
  opts: ApiGetOptions = {},
): Promise<ListPipelinesResponse> {
  return apiGet<ListPipelinesResponse>(
    `/api/work-items/${encodeURIComponent(workItemId)}/tasks/${encodeURIComponent(taskId)}/pipelines`,
    opts,
  );
}

export function getAgentReport(
  agentReportId: string,
  opts: ApiGetOptions = {},
): Promise<GetAgentReportResponse> {
  return apiGet<GetAgentReportResponse>(
    `/api/agent-reports/${encodeURIComponent(agentReportId)}`,
    opts,
  );
}

export interface ListTaskAgentReportsParams {
  role?: AgentRole;
  includeSuperseded?: boolean;
}

export function listTaskAgentReports(
  workItemId: string,
  taskId: string,
  params: ListTaskAgentReportsParams = {},
  opts: ApiGetOptions = {},
): Promise<ListTaskAgentReportsResponse> {
  const query = new URLSearchParams();
  if (params.role) query.set("role", params.role);
  if (params.includeSuperseded) query.set("include_superseded", "true");
  const qs = query.toString();
  return apiGet<ListTaskAgentReportsResponse>(
    `/api/work-items/${encodeURIComponent(workItemId)}/tasks/${encodeURIComponent(taskId)}/agent-reports${qs ? `?${qs}` : ""}`,
    opts,
  );
}

export function listPipelineRunAgentReports(
  pipelineRunId: string,
  opts: ApiGetOptions = {},
): Promise<ListPipelineRunAgentReportsResponse> {
  return apiGet<ListPipelineRunAgentReportsResponse>(
    `/api/pipeline-runs/${encodeURIComponent(pipelineRunId)}/agent-reports`,
    opts,
  );
}

export function setRecipeOverride(
  workItemId: string,
  taskId: string,
  recipe: WorkflowRecipe,
  opts: OperatorActionOptions = {},
): Promise<SetRecipeOverrideResponse> {
  const body: SetRecipeOverrideRequest = { recipe };
  if (opts.operator) body.operator = opts.operator;
  return postWorkItemAction<SetRecipeOverrideResponse>(
    `/api/work-items/${encodeURIComponent(workItemId)}/tasks/${encodeURIComponent(taskId)}/pipeline/recipe-override`,
    body,
    opts,
  );
}

export function revokeAiReview(
  agentReportId: string,
  opts: OperatorActionOptions = {},
): Promise<RevokeAiReviewResponse> {
  return postWorkItemAction<RevokeAiReviewResponse>(
    `/api/agent-reports/${encodeURIComponent(agentReportId)}/revoke-ai-review`,
    {},
    opts,
  );
}

export function retryAgentReport(
  agentReportId: string,
  body: RetryAgentReportRequest = {},
  opts: OperatorActionOptions = {},
): Promise<RetryAgentReportResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<RetryAgentReportResponse>(
    `/api/agent-reports/${encodeURIComponent(agentReportId)}/retry`,
    body,
    effective,
  );
}

export function skipAgentReport(
  agentReportId: string,
  body: SkipAgentReportRequest = {},
  opts: OperatorActionOptions = {},
): Promise<SkipAgentReportResponse> {
  const effective: OperatorActionOptions =
    body.operator && !opts.operator ? { ...opts, operator: body.operator } : opts;
  return postWorkItemAction<SkipAgentReportResponse>(
    `/api/agent-reports/${encodeURIComponent(agentReportId)}/skip`,
    body,
    effective,
  );
}

export function validateWorkflowRoles(
  workflowId: string,
  opts: ApiGetOptions = {},
): Promise<ValidateWorkflowRolesResponse> {
  return apiGet<ValidateWorkflowRolesResponse>(
    `/api/workflows/${encodeURIComponent(workflowId)}/roles/validate`,
    opts,
  );
}
