import { type IssuePilotEvent } from "./events.js";
import {
  type RunReportArtifact,
  type RunReportSummary,
} from "./report.js";
import { type RunRecord, type RunStatus } from "./run.js";
import type {
  TaskNode,
  TaskPlan,
  TaskPlanEdit,
  TaskRunLink,
  WorkItem,
  WorkItemReport,
  WorkItemStatus,
} from "./work-item.js";

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
