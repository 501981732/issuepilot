/**
 * V4.1 Workflow Spine 数据契约。
 *
 * 这些类型固化 spec §9.0–§9.5 的状态枚举与必填字段，是 dashboard、
 * orchestrator、planner 与 aggregate 模块共享的唯一事实来源。任何 V4.1
 * 实现都必须使用这里的枚举值；不要在 orchestrator 内重新定义。
 *
 * Source: docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md
 */

/** 大 Issue 在 IssuePilot 本地的总生命周期。 */
export const WORK_ITEM_STATUS_VALUES = [
  "planning",
  "ready",
  "running",
  "partial",
  "completed",
  "blocked",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUS_VALUES)[number];

export const isWorkItemStatus = (value: unknown): value is WorkItemStatus =>
  typeof value === "string" &&
  (WORK_ITEM_STATUS_VALUES as readonly string[]).includes(value);

/**
 * TaskPlan 的多版本生命周期。只有 `accepted` 的版本会被 orchestration
 * 执行；`rejected` / `superseded` 仅保留为审计 / 质量分析的历史版本。
 */
export const TASK_PLAN_STATUS_VALUES = [
  "draft",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type TaskPlanStatus = (typeof TASK_PLAN_STATUS_VALUES)[number];

export const isTaskPlanStatus = (value: unknown): value is TaskPlanStatus =>
  typeof value === "string" &&
  (TASK_PLAN_STATUS_VALUES as readonly string[]).includes(value);

/**
 * 单个子任务的状态机。`blocked_by_dependency` 用于上游 task 未完成或
 * upstream MR 未合并 base_branch 的情况（spec §12.4）。`needs_rework`
 * 留给 V4.2 reviewer feedback 入口，V4.1 仅做枚举占位。
 */
export const TASK_NODE_STATUS_VALUES = [
  "planned",
  "blocked_by_dependency",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "needs_rework",
  "skipped",
] as const;
export type TaskNodeStatus = (typeof TASK_NODE_STATUS_VALUES)[number];

export const isTaskNodeStatus = (value: unknown): value is TaskNodeStatus =>
  typeof value === "string" &&
  (TASK_NODE_STATUS_VALUES as readonly string[]).includes(value);

/**
 * WorkItemReport 自身的可读性状态。`incomplete` 表示报告引用的 run /
 * RunReportArtifact 丢失（spec §12.5），UI 必须把它和 `partial`
 * 区分开 — 后者是「跑过但部分失败」，前者是「报告本身不可信」。
 */
export const WORK_ITEM_REPORT_STATUS_VALUES = [
  "draft",
  "partial",
  "complete",
  "incomplete",
] as const;
export type WorkItemReportStatus =
  (typeof WORK_ITEM_REPORT_STATUS_VALUES)[number];

export const isWorkItemReportStatus = (
  value: unknown,
): value is WorkItemReportStatus =>
  typeof value === "string" &&
  (WORK_ITEM_REPORT_STATUS_VALUES as readonly string[]).includes(value);

/**
 * 与现有 `RunReportArtifact` 共享的风险分级口径。
 *
 * 我们重新导出 report.ts 里已经存在的 `RISK_LEVEL_VALUES` 与
 * `RiskLevel`，避免 V4.1 与 V2.5 在两处定义不同的字面量。
 */
import { RISK_LEVEL_VALUES, type RiskLevel } from "./report.js";

export { RISK_LEVEL_VALUES, type RiskLevel };

export const isRiskLevel = (value: unknown): value is RiskLevel =>
  typeof value === "string" &&
  (RISK_LEVEL_VALUES as readonly string[]).includes(value);

/**
 * 大 Issue 的 tracker 来源引用。V4.1 中 GitLab Issue 是唯一 source of
 * truth，所以这里只保留最小必要字段；完整 IssueRef 在 events / runs
 * 上下文里另行携带。
 */
export interface SourceIssueRef {
  projectId: string;
  iid: number;
  url: string;
  title: string;
}

/**
 * Spec §9.1：大 Issue 在 IssuePilot 本地的工作单元视图。`taskIds` 是
 * TaskPlan.tasks 的快捷索引，方便 dashboard 不必每次都 join plan。
 * `summaryReportId` 仅在 WorkItemReport 已生成后填充。
 */
export interface WorkItem {
  workItemId: string;
  sourceIssue: SourceIssueRef;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  status: WorkItemStatus;
  taskIds: string[];
  summaryReportId?: string;
  /** 仅在 status === "blocked" 时填充，供 dashboard / handoff note 复用。 */
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Spec §9.3：一个可由 synthetic task run 执行的子任务。`runIds` 是
 * 按时间顺序 append 的 run id 列表；`TaskRunLink` 才是 canonical
 * binding。`riskLevel` 由 planner 给出，aggregate 时再覆盖到
 * WorkItemReport 的 riskSummary。
 */
export interface TaskNode {
  taskId: string;
  title: string;
  goal: string;
  scope: string;
  nonGoals?: string[];
  dependsOn: string[];
  suggestedValidation: string[];
  status: TaskNodeStatus;
  runIds: string[];
  riskLevel: RiskLevel;
  /** Operator-visible reason when status leaves `ready`（blocked / failed 解释）。 */
  statusReason?: string;
  /**
   * V4.2: human-driven reason when operator pushes a task back to
   * `needs_rework`. Separate from `statusReason` (which records
   * runtime-side failure reasons) so quality analytics in V4.4 can
   * count true review-driven rework without false positives.
   */
  needsReworkReason?: string;
}

/**
 * Operator 在 plan editor 中对单个字段的修改记录。V4.4 质量分析会消费
 * 这条流，看 operator 通常修正哪些字段，推断 planner 哪些维度有偏差。
 */
export interface TaskPlanEdit {
  taskId: string;
  /**
   * V4.2: `"replan"` records a single-task replan where the planner re-drafted
   * exactly one task and produced a new TaskPlan version. The before/after
   * payloads capture the task snapshot pre/post-replan rather than a single
   * field; older field values keep the V4.1 semantics.
   */
  field:
    | "title"
    | "goal"
    | "scope"
    | "dependsOn"
    | "suggestedValidation"
    | "replan";
  before: unknown;
  after: unknown;
  by: string;
  at: string;
}

/**
 * Spec §9.2：TaskPlan 支持多版本，只有 accepted 版本会被执行。
 * `dependencies` 是 `dependsOn` 的扁平化形式（from → to），方便
 * dashboard 渲染图 / 列表时只读一份。
 */
export interface TaskPlan {
  planId: string;
  workItemId: string;
  version: number;
  tasks: TaskNode[];
  dependencies: Array<{ from: string; to: string }>;
  operatorEdits: TaskPlanEdit[];
  status: TaskPlanStatus;
  acceptedAt?: string;
  rejectedReason?: string;
  /**
   * V4.2: when a plan is the result of a *single-task replan* (not a
   * full plan regeneration), records which previous plan + task this
   * plan derives from. The non-replanned tasks inherit status / runIds
   * from the previous plan so an in-flight workflow does not reset.
   */
  replanOf?: { planId: string; taskId: string };
}

/**
 * Spec §9.4：TaskRunLink 是 task ↔ run 的 canonical binding。
 * `mergeRequest.state` 在 V4.1 用于 dependency-by-merge 判定
 * （spec §12.4 / orchestration `computeReadyTasks`）。
 */
export interface TaskRunLink {
  taskId: string;
  runId: string;
  attempt: number;
  status: TaskNodeStatus;
  reportId?: string;
  branch: string;
  mergeRequest?: {
    iid: number;
    url?: string;
    state?: "opened" | "merged" | "closed";
  };
  startedAt: string;
  completedAt?: string;
}

/**
 * Spec §9.5：大 Issue 级别的汇总报告，是 Parent Review Packet、GitLab
 * handoff note、Markdown export 的统一来源（spec §13 / §15）。V4.1 即使
 * 报告完整，也不允许在 recommendedNextActions 输出 `ready_to_merge`，最多
 * 输出「建议进入人工 review」（spec §12.5）。
 */
export interface WorkItemEvidenceEntry {
  taskId: string;
  kind: "diff" | "validation" | "risk" | "ci" | "review_feedback";
  label: string;
  href?: string;
  text?: string;
}

export interface WorkItemTaskSummary {
  taskId: string;
  title: string;
  taskStatus: TaskNodeStatus;
  runId?: string;
  diffSummary?: string;
  validation: string[];
  risks: Array<{ level: RiskLevel; text: string }>;
  followUps: string[];
  mergeRequestUrl?: string;
  /** 简单字符串，避免在 V4.1 引入 `PipelineStatus` 依赖。 */
  ciStatus?: string;
  nextAction?: string;
}

export interface WorkItemReport {
  workItemId: string;
  overallStatus: WorkItemReportStatus;
  taskSummaries: WorkItemTaskSummary[];
  validationSummary: string;
  riskSummary: string;
  evidence: {
    index: WorkItemEvidenceEntry[];
    byTask: Record<string, WorkItemEvidenceEntry[]>;
  };
  openQuestions: string[];
  recommendedNextActions: string[];
  generatedAt: string;
}
