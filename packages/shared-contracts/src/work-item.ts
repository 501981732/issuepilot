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
 *
 * V4.6 扩展（spec §8.0）：把 `running` 拆细为 `running_coding` /
 * `running_reviewer` / `running_test_evidence` 三态，并新增
 * `awaiting_human_review` 终态。旧 `running` 仍保留作为兼容值，
 * 旧 task store 读出时由 `legacyRunningStateToV46` 升级到 V4.6 字面值。
 */
export const TASK_NODE_STATUS_VALUES = [
  "planned",
  "blocked_by_dependency",
  "ready",
  /** @deprecated V4.6+ 使用 `running_coding` / `running_reviewer` / `running_test_evidence`；仅保留作为读路径兼容。 */
  "running",
  "running_coding",
  "running_reviewer",
  "running_test_evidence",
  "awaiting_human_review",
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
 * V4.6 spec §8.0：旧 task store 里写的是 `running`，本 helper 在读路径
 * 把它升级成 V4.6 默认的 `running_coding`，其他状态原值返回。
 */
export const legacyRunningStateToV46 = (
  status: TaskNodeStatus,
): TaskNodeStatus => (status === "running" ? "running_coding" : status);

/**
 * V4.6 spec §7.3 / §16.2：`TaskNode.roleFailureReason` 字段的字面量集合。
 *
 * 与 `LastErrorCode` 不同：lastError.code 是 agent 内部失败原因，
 * roleFailureReason 是 orchestrator 投射到 TaskNode 上的"运维级根因"，
 * 用于 dashboard 提示与 V4.4 quality 失败模式分桶。两表映射规则
 * 由 `failure-mapping.ts`（orchestrator）维护。
 */
export const TASK_ROLE_FAILURE_REASON_VALUES = [
  "coding_failed",
  "reviewer_unavailable",
  "reviewer_cannot_review",
  "reviewer_requested_changes",
  "evidence_unavailable",
  "evidence_partial",
  "sandbox_violation",
  "redaction_failed",
  "storage_full",
  "role_profile_invalid",
] as const;
export type TaskRoleFailureReason =
  (typeof TASK_ROLE_FAILURE_REASON_VALUES)[number];

export const isTaskRoleFailureReason = (
  value: unknown,
): value is TaskRoleFailureReason =>
  typeof value === "string" &&
  (TASK_ROLE_FAILURE_REASON_VALUES as readonly string[]).includes(value);

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
 * V4.6 spec §8.4：WorkItemReport.taskSummaries[].evidenceStatus。
 *
 * - `complete`：test_evidence 全部 collected。
 * - `partial`：test_evidence 部分 collected。
 * - `skipped_by_recipe`：recipe 不含 test_evidence step（coding_only /
 *   coding_plus_reviewer）。
 * - `unavailable`：旧 task（pre-V4.6）或 test_evidence agent 未启动；
 *   parser 在缺字段时 fallback 到此值。
 */
export const EVIDENCE_STATUS_VALUES = [
  "complete",
  "partial",
  "skipped_by_recipe",
  "unavailable",
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUS_VALUES)[number];

export const isEvidenceStatus = (value: unknown): value is EvidenceStatus =>
  typeof value === "string" &&
  (EVIDENCE_STATUS_VALUES as readonly string[]).includes(value);

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
  /**
   * Optional V4.4 quality analytics grouping. Older plans omit it and are
   * bucketed as `unknown`.
   */
  taskType?: string;
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
  /**
   * V4.6 spec §8.3：当前关联的 PipelineRun ID。仅在 TaskNode 进入
   * `ready` 后由 orchestrator 创建 PipelineRun 时写入；进入
   * `running_coding` 之后不再变化（除 retry / replan 时切换）。
   */
  currentPipelineRunId?: string;
  /**
   * V4.6 spec §8.3：在 `planned` / `blocked_by_dependency` 阶段
   * （PipelineRun 尚未创建）调用 recipe-override 时写入；orchestrator
   * 在 PipelineRun 创建时灌进 draft 并清空。
   *
   * 类型故意写成 string 而不是 import WorkflowRecipe，以避免 work-item
   * → pipeline 的双向依赖；运行时 `isWorkflowRecipe` 校验由
   * `pipelines/recipe.ts` 负责。
   */
  pendingRecipe?: string;
  pendingRecipeSource?: string;
  /**
   * V4.6 spec §8.3：PipelineRun cancel 把 TaskNode 拉回 `ready` 时写入。
   * orchestrator auto_advance 检查该标记并跳过，直到 operator 在
   * dashboard 显式触发新一轮 pipeline 时清空。
   */
  last_cancelled_at?: string;
  /**
   * V4.6 spec §7.3 / §8.3：运维级根因码，取自
   * `TASK_ROLE_FAILURE_REASON_VALUES`。dashboard 据此渲染失败提示。
   */
  roleFailureReason?: TaskRoleFailureReason;
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
 * V4.2 review I1：操作员驱动状态优先于历史 TaskRunLink。
 *
 * - `needs_rework` / `skipped` 是操作员对 task 的显式状态，应该胜过
 *   旧 TaskRunLink 的 `completed` / `failed` / `blocked` —— 否则
 *   dashboard 仍然把 task 渲染为 `completed`，按钮可见性、Mark
 *   rework / Retry 都会错位。
 * - 其他情况下沿用历史规则：TaskRunLink.status 是 task 的 canonical
 *   状态（completed / failed / blocked / running），仅当没有 link 时
 *   才回落到 task.status（planned / ready / blocked_by_dependency）。
 *
 * orchestrator 端的 aggregate.effectiveTaskStatus 与 dashboard 端的
 * task-list rendering 共用这个函数，保证 spec §9.x 状态枚举对调度
 * （orchestration）、聚合（aggregate）和 UI 渲染三处统一。
 */
export function effectiveTaskStatus(
  task: Pick<TaskNode, "status">,
  link: Pick<TaskRunLink, "status"> | undefined,
): TaskNodeStatus {
  if (task.status === "needs_rework" || task.status === "skipped") {
    return task.status;
  }
  const resolved: TaskNodeStatus = link?.status ?? task.status;
  // V4.6 兼容：`running_coding` / `running_reviewer` / `running_test_evidence`
  // 在旧 UI 路径上仍按"在跑"展示。spec §8.0 要求把三细态对外折叠成
  // legacy `running`，让 V4.5 之前的 dashboard / aggregate 行为保持不变；
  // 真正的细化状态由 V4.6 dashboard 经 PipelineRun / AgentReport 自取。
  if (
    resolved === "running_coding" ||
    resolved === "running_reviewer" ||
    resolved === "running_test_evidence"
  ) {
    return "running";
  }
  return resolved;
}

/**
 * Spec §9.5：大 Issue 级别的汇总报告，是 Parent Review Packet、GitLab
 * handoff note、Markdown export 的统一来源（spec §13 / §15）。V4.1 即使
 * 报告完整，也不允许在 recommendedNextActions 输出 `ready_to_merge`，最多
 * 输出「建议进入人工 review」（spec §12.5）。
 */
export interface WorkItemEvidenceEntry {
  taskId: string;
  kind: WorkItemEvidenceKind;
  /**
   * V4.3: stable id derived by orchestrator evidence-id helpers. It must not
   * be an array index, because human confirmations are stored against it.
   */
  evidenceId: string;
  label: string;
  /** How trustworthy the evidence is for reviewer-facing UI. */
  confidence: WorkItemEvidenceConfidence;
  href?: string;
  text?: string;
  mediaType?: string;
  thumbnailHref?: string;
  capturedAt?: string;
  source?: { runId: string; relPath?: string };
  confirmedBy?: string;
  confirmedAt?: string;
}

export type WorkItemEvidenceKind =
  | "diff"
  | "validation"
  | "risk"
  | "ci"
  | "review_feedback"
  | "screenshot"
  | "recording"
  | "playwright"
  | "command_output"
  | "test_result";

export type WorkItemEvidenceConfidence =
  | "ai-claim"
  | "system-derived"
  | "human-confirmed";

export interface HumanReviewChecklistItem {
  itemId: string;
  taskId?: string;
  label: string;
  /** Codified reason for dashboard grouping and markdown rendering. */
  reason:
    | "ai-risk-medium"
    | "ai-risk-high"
    | "needs-rework"
    | "partial-overall"
    | "missing-evidence"
    | "skipped-task"
    | "ci-failed";
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface WorkItemCiSummary {
  /** Worst CI status across the constituent task reports. */
  overall: "passed" | "failed" | "running" | "unknown";
  perTask: Record<
    string,
    {
      status: string;
      pipelineUrl?: string;
    }
  >;
}

export interface WorkItemTestSummary {
  passed: number;
  failed: number;
  skipped: number;
  unknown: number;
  perTask: Record<
    string,
    {
      passed: number;
      failed: number;
      skipped: number;
      unknown: number;
    }
  >;
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
  /**
   * V4.6 spec §8.4：本 task 最新一次 PipelineRun 与三角色 AgentReport
   * 的索引。dashboard / Parent Review Packet 据此跳转到 AgentReport tab。
   *
   * `evidenceStatus` 缺省时（pre-V4.6 任务）必须 fallback 到 `unavailable`，
   * 而不是 `skipped_by_recipe`（后者要求 PipelineRun 明确 coding-only 配置）。
   */
  pipelineRunId?: string;
  coderReportId?: string;
  reviewerReportId?: string;
  testEvidenceReportId?: string;
  /** 字符串以避免 work-item.ts → agent-report.ts 双向 import；运行时由调用方校验。 */
  reviewerDecision?: string;
  reviewerConfidence?: number;
  /**
   * V4.6 spec §8.4：本字段在新 task summary 中由 aggregator 显式写入；
   * 旧 task summary（V4.5 之前 aggregate 出的）缺字段时 reader 必须
   * fallback 到 `unavailable`（spec §8.4），用 `effectiveEvidenceStatus`
   * helper 取值。
   */
  evidenceStatus?: EvidenceStatus;
  /**
   * V4.6 spec §11 / §17.2：reviewer.summary 摘要，dashboard 在 Parent
   * Review Packet 与 task summary card 中渲染。
   */
  reviewerSummary?: string;
  /**
   * V4.6：本 task 的 reviewer agent report 在 MR 上的推送状态摘要，
   * dashboard 用于在 task list 渲染 banner（pending / published /
   * publish_failed / skipped_by_config / revoked）。
   * 字符串以避免双向 import。
   */
  mrPublicationStatus?: string;
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
  humanReviewChecklist: HumanReviewChecklistItem[];
  ciSummary?: WorkItemCiSummary;
  testSummary?: WorkItemTestSummary;
  generatedAt: string;
}

/**
 * V4.6 spec §8.4：判定 WorkItemReport 是否可推 `ready_to_merge`
 * recommended next action。
 *
 * 规则：如果任一 task 的 `evidenceStatus = unavailable` 且 reviewer
 * decision 不是 `approve_with_comments`（白名单），则不可推
 * `ready_to_merge`。decision 为 `cannot_review` / `request_changes` /
 * 未知（undefined）都视为未点头。
 *
 * 兼容 V4.1：本 helper 仅在 V4.6 dashboard / aggregate 引入 evidence
 * status 后启用；V4.1 aggregate 路径在 spec §17 早就规定不允许返回
 * `ready_to_merge`，本规则与之叠加而不是替换。
 */
export interface ComputeOverallStatusResult {
  overallStatus: WorkItemReportStatus;
  readyToMerge: boolean;
  veto: Array<{
    taskId: string;
    evidenceStatus: EvidenceStatus;
    reviewerDecision?: string;
    reason: "evidence_unavailable_without_reviewer_approval";
  }>;
}

/** spec §8.4：缺字段时 fallback 到 `unavailable`。 */
export const effectiveEvidenceStatus = (
  summary: Pick<WorkItemTaskSummary, "evidenceStatus">,
): EvidenceStatus => summary.evidenceStatus ?? "unavailable";

export const computeOverallStatus = (
  summaries: ReadonlyArray<
    Pick<
      WorkItemTaskSummary,
      "taskId" | "taskStatus" | "evidenceStatus" | "reviewerDecision"
    >
  >,
  current: WorkItemReportStatus,
): ComputeOverallStatusResult => {
  const veto: ComputeOverallStatusResult["veto"] = [];
  for (const s of summaries) {
    const status = effectiveEvidenceStatus(s);
    if (
      status === "unavailable" &&
      s.reviewerDecision !== "approve_with_comments"
    ) {
      veto.push({
        taskId: s.taskId,
        evidenceStatus: status,
        ...(s.reviewerDecision ? { reviewerDecision: s.reviewerDecision } : {}),
        reason: "evidence_unavailable_without_reviewer_approval",
      });
    }
  }
  return {
    overallStatus: current,
    readyToMerge: veto.length === 0,
    veto,
  };
};
