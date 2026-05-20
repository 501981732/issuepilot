import type {
  AgentReport,
  AgentRole,
  ReviewerDecision,
} from "./agent-report.js";
import { type IssuePilotEvent } from "./events.js";
import type { PipelineRun, WorkflowRecipe, RecipeSource } from "./pipeline.js";
import { type RunReportArtifact, type RunReportSummary } from "./report.js";
import { type RunRecord, type RunStatus } from "./run.js";
import type {
  TaskNode,
  TaskPlan,
  TaskPlanEdit,
  TaskRunLink,
  WorkItem,
  WorkItemEvidenceEntry,
  WorkItemReport,
  WorkItemStatus,
} from "./work-item.js";

export type {
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendationDetailResponse,
  ImprovementRecommendationFilters,
  ImprovementRecommendationsListResponse,
} from "./improvement.js";
export type { QualitySummaryResponse } from "./quality.js";

/**
 * Wire types for the local orchestrator HTTP surface. Phase 6 (Fastify)
 * implements the routes; the dashboard consumes the same types via
 * `apps/dashboard/lib/api.ts`. Keep these JSON-serialisable — no Dates,
 * no Maps, no class instances.
 */
export interface ListRunsQuery {
  status?: RunStatus | readonly RunStatus[];
  limit?: number;
}

export interface RunsListResponse {
  runs: RunRecord[];
  reports?: RunReportSummary[];
}

export interface RunDetailResponse {
  run: RunRecord;
  events: IssuePilotEvent[];
  /** Last N log lines (already redacted) for quick-look in the UI. */
  logsTail: string[];
  report?: RunReportArtifact;
}

export interface ReportsListResponse {
  reports: RunReportSummary[];
}

export interface EventsQuery {
  runId?: string;
  /** Default 100, server caps at 500 to keep responses small. */
  limit?: number;
  /** Opaque cursor returned in the previous `nextCursor`. */
  cursor?: string;
}

export interface EventsListResponse {
  events: IssuePilotEvent[];
  /** Set when more events exist; undefined when at tail. */
  nextCursor?: string;
}

/**
 * V4.1 Workflow Spine HTTP 契约。dashboard 与 orchestrator 共享，落点
 * 是 `apps/orchestrator/src/server/index.ts` 中新增的 work-item 路由。
 */

/** `GET /api/work-items` 响应。 */
export interface WorkItemsListResponse {
  workItems: WorkItem[];
  /**
   * 每个 `WorkItemStatus` 的计数，dashboard 顶部 counters 直接消费。
   * 不能省略某个 key — 必须覆盖全部状态，否则前端会出现 undefined 计数。
   */
  counters: Record<WorkItemStatus, number>;
}

/** `GET /api/work-items/:id` 响应。 */
export interface WorkItemDetailResponse {
  workItem: WorkItem;
  /**
   * 当前 accepted 或 draft 的 plan，外加历史版本（含 rejected /
   * superseded）。`history` 按 `version` 升序排列。
   */
  plan: { current: TaskPlan; history: TaskPlan[] };
  /** 当前 plan 中的所有 TaskNode（快捷索引，与 `plan.current.tasks` 一致）。 */
  tasks: TaskNode[];
  /** workItem 下所有 task 的 canonical binding 列表。 */
  runLinks: TaskRunLink[];
  /** 仅在 aggregate 已生成 `WorkItemReport` 后存在。 */
  report?: WorkItemReport;
}

/** `POST /api/issues/:iid/plan` 请求体。 */
export interface PlanWorkItemRequest {
  iid: number;
  /**
   * 设为 true 时强制重新生成 plan：若 work item 已存在，旧 plan 标记为
   * `superseded`/`rejected`，新 plan 以新 version 出现在 history。
   */
  regenerate?: boolean;
}

/** `POST /api/work-items/:id/plan/accept` 请求体。 */
export interface AcceptWorkItemPlanRequest {
  planId: string;
  /** Operator 在 UI 上的逐字段修改；后端按字段 patch + 记录 audit 流。 */
  edits: Array<{
    taskId: string;
    field: TaskPlanEdit["field"];
    after: unknown;
  }>;
  operator: string;
}

/** `GET /api/work-items/:id/report` 响应。 */
export interface WorkItemReportResponse {
  report?: WorkItemReport;
}

/**
 * V4.2 Task Graph HTTP 契约。dashboard 通过四条新路由触发 operator
 * actions (replan / mark-rework / unskip) 与 graph 投影，落点是
 * `apps/orchestrator/src/server/index.ts` 中的 V4.2 路由扩展。
 */

/** `POST /api/work-items/:id/tasks/:taskId/replan` 请求体。 */
export interface ReplanTaskRequest {
  /** 人类可读的重规划原因，operator 必填。 */
  reason: string;
  /** 给 planner 的额外提示（拆分粒度、补 AC 等）。 */
  hint?: string;
}

/** `POST /api/work-items/:id/tasks/:taskId/mark-rework` 请求体。 */
export interface MarkTaskReworkRequest {
  /** Reviewer 反馈的返工原因；落到 `TaskNode.needsReworkReason`。 */
  reason: string;
}

/** `POST /api/work-items/:id/tasks/:taskId/unskip` 请求体。 */
export interface UnskipTaskRequest {
  /** 触发 unskip 的 operator；省略时 server 用 `x-issuepilot-operator` header 兜底。 */
  operator?: string;
}

/** `GET /api/work-items/:id/graph` 响应。 */
export interface WorkItemGraphResponse {
  /** 拓扑分层：`levels[i]` 是同一深度（最长祖先距离）的 taskId 列表。 */
  levels: string[][];
  /** `dependsOn` 派生的有向边。 */
  edges: Array<{ from: string; to: string }>;
  /** 当前 plan 的最长（节点数最多）路径上的 taskId；多条等长时取字典序首条。 */
  criticalPathTaskIds: string[];
}

/** `GET /api/work-items/:id/evidence` 响应。 */
export interface WorkItemEvidenceResponse {
  index: WorkItemEvidenceEntry[];
  byTask: Record<string, WorkItemEvidenceEntry[]>;
  missing: Array<{
    taskId: string;
    reason: "no-run-report" | "no-link" | "incomplete-report";
  }>;
}

/** `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` 请求体。 */
export interface ConfirmEvidenceRequest {
  /** 省略时 server 使用 `x-issuepilot-operator` header。 */
  operator?: string;
}

/** `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` 响应。 */
export interface ConfirmEvidenceResponse {
  evidenceId: string;
  confirmedAt: string;
  report: WorkItemReport;
}

/**
 * V4.6 Multi-Agent Collaboration HTTP 契约（spec §18）。
 *
 * 所有 V4.6 route 都尊重 single / team 模式的 `x-issuepilot-project`
 * header 与 active project 校验，沿用 V4.4 / V4.5 模式。错误码使用
 * `PipelineRouteErrorCode` 统一字面量。
 */

/**
 * V4.6 route 统一 error code（spec §18.4）。
 *
 * V4.6 follow-up Important #5：spec §18.4 保留 `service_unavailable` →
 * HTTP 503 用于标记 "agent runner 未装配" 这类暂时性服务异常，例如
 * coordinator 抛出 `CoordinatorError("agent_not_configured")` 时；
 * 不与 400 / `invalid_payload` 合并，便于 dashboard 区分。
 */
export type PipelineRouteErrorCode =
  | "recipe_override_locked"
  | "unknown_recipe"
  | "role_mismatch"
  | "not_revocable"
  | "project_required"
  | "project_query_not_allowed"
  | "task_not_found"
  | "pipeline_run_not_found"
  | "agent_report_not_found"
  | "role_skip_not_allowed"
  | "workflow_not_found"
  | "invalid_payload"
  | "service_unavailable"
  | "pipelines_unavailable";

export interface PipelineRouteError {
  code: PipelineRouteErrorCode;
  message: string;
}

/** AgentReport 摘要，供 PipelineRun 列表 / WorkItemReport 渲染消费。 */
export interface AgentReportSummary {
  agentReportId: string;
  pipelineRunId: string;
  taskId: string;
  role: AgentRole;
  status: AgentReport["status"];
  startedAt: string;
  completedAt?: string;
  /** 仅 reviewer 时填入。 */
  decision?: ReviewerDecision;
  confidence?: number;
  /** lastError.code 字面量（与 `LastErrorCode` 对齐）。 */
  lastErrorCode?: string;
  /** supersede 链：本 report 是否被 supersededBy 引用。 */
  supersededBy?: string;
}

/** PipelineRun + 关联 AgentReport 摘要的 envelope。 */
export interface PipelineRunWithReports {
  pipelineRun: PipelineRun;
  agentReports: AgentReportSummary[];
}

/** `GET /api/work-items/:wid/tasks/:tid/pipeline` 响应。 */
export interface GetPipelineResponse {
  /** 当前 task 上最新的 PipelineRun；尚未创建时为 null。 */
  pipelineRun: PipelineRun | null;
  agentReports: AgentReportSummary[];
  /** spec §8.3：pendingRecipe 与 source。 */
  pendingRecipe?: WorkflowRecipe;
  pendingRecipeSource?: RecipeSource;
}

/** `GET /api/work-items/:wid/tasks/:tid/pipelines` 响应（含 supersede 关系）。 */
export interface ListPipelinesResponse {
  pipelineRuns: PipelineRun[];
}

/**
 * `POST /api/work-items/:wid/tasks/:tid/pipeline/recipe-override` 请求体。
 *
 * 路径含 `/pipeline/` 段（spec §18.1），与 dashboard `setRecipeOverride`
 * client method 严格对应。
 */
export interface SetRecipeOverrideRequest {
  recipe: WorkflowRecipe;
  /** 省略时 server 用 `x-issuepilot-operator` header。 */
  operator?: string;
}

export interface SetRecipeOverrideResponse {
  /** 写到 PipelineRun.recipe 或 TaskNode.pendingRecipe 后的最新值。 */
  recipe: WorkflowRecipe;
  recipeSource: RecipeSource;
  /**
   * 决议来源：
   * - `pipeline_run`：override 已写到 PipelineRun.recipe（task 已 ready 且
   *   PipelineRun 已创建）。
   * - `pending`：override 写到 TaskNode.pendingRecipe，等 PipelineRun 创建时灌入。
   */
  appliedTo: "pipeline_run" | "pending";
  pipelineRunId?: string;
}

/** `GET /api/agent-reports/:id` 响应。 */
export interface GetAgentReportResponse {
  agentReport: AgentReport;
}

/** `GET /api/work-items/:wid/tasks/:tid/agent-reports` 响应。 */
export interface ListTaskAgentReportsResponse {
  agentReports: AgentReportSummary[];
}

/** `GET /api/pipeline-runs/:id/agent-reports` 响应（URL 用复数）。 */
export interface ListPipelineRunAgentReportsResponse {
  agentReports: AgentReport[];
}

/** `POST /api/agent-reports/:id/revoke-ai-review` 响应（无 body 请求）。 */
export interface RevokeAiReviewResponse {
  agentReportId: string;
  /** 撤回后的 mrPublication 状态，固定为 `revoked`。 */
  status: "revoked";
  revokedAt: string;
}

/** `POST /api/agent-reports/:id/retry` 请求体。 */
export interface RetryAgentReportRequest {
  operator?: string;
  /** Operator-supplied retry reason；写入 dashboard timeline。 */
  reason?: string;
}

export interface RetryAgentReportResponse {
  pipelineRunId: string;
  /** 新创建的 AgentReport ID（reviewer / test_evidence retry 时） */
  agentReportId?: string;
  /** 当 coder retry 时，新创建的 PipelineRun ID。 */
  newPipelineRunId?: string;
}

/** `POST /api/agent-reports/:id/skip` 请求体。 */
export interface SkipAgentReportRequest {
  operator?: string;
  reason?: string;
}

export interface SkipAgentReportResponse {
  pipelineRunId: string;
  agentReportId: string;
  /** 跳过后 pipeline 推进到的下一 role 或终态。 */
  nextRole: AgentRole | "awaiting_human_review";
}

/** `GET /api/workflows/:workflowId/roles/validate` 响应。 */
export interface ValidateWorkflowRolesResponse {
  valid: boolean;
  errors: Array<{
    code: string;
    message: string;
    /** 受影响的 role profile。 */
    role?: AgentRole;
  }>;
}
