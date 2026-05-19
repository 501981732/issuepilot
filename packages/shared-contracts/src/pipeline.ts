/**
 * V4.6 Multi-Agent Collaboration PipelineRun 契约。
 *
 * PipelineRun 把一组 AgentReport（coder / reviewer / test_evidence）串成
 * 一次完整的多角色 pipeline 执行，与 TaskNode 一对多关联。一个 TaskNode
 * 在 retry / replan 时会创建新 PipelineRun，并通过 `supersedes` /
 * `supersededBy` 形成线性历史。
 *
 * 本文件严格按 spec §8.1 / §10 定义枚举与字段；与 V4.2 `RunStatus`
 * 互不复用——PipelineRunStatus 是 V4.6 引入的独立 enum。
 *
 * Source: docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md
 */

import { type AgentRole, isAgentRole } from "./agent-report.js";

/**
 * spec §8.1：PipelineRun.status 8 项 lifecycle。
 *
 * - `running_coding` / `running_reviewer` / `running_test_evidence`：对应 step 在跑。
 * - `awaiting_human_review`：AI pipeline 全部完成（成功或 evidence partial），
 *   等 V4.3 human-review 通道接收。
 * - `awaiting_rework`：reviewer 跑完且 decision = `request_changes`，等
 *   operator 触发 coder retry。
 * - `partial`：test_evidence 部分失败但 pipeline 仍推到 human review。
 * - `failed`：coder 失败 / reviewer 自身崩 / sandbox violation / scope probe 失败。
 * - `cancelled`：operator 主动取消。
 *
 * 历史 `draft` / `running` / `succeeded` **不在** V4.6 PipelineRunStatus 内。
 */
export const PIPELINE_RUN_STATUS_VALUES = [
  "running_coding",
  "running_reviewer",
  "running_test_evidence",
  "awaiting_human_review",
  "awaiting_rework",
  "partial",
  "failed",
  "cancelled",
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUS_VALUES)[number];

export const isPipelineRunStatus = (
  value: unknown,
): value is PipelineRunStatus =>
  typeof value === "string" &&
  (PIPELINE_RUN_STATUS_VALUES as readonly string[]).includes(value);

/** spec §10：默认 / operator 可选 recipe。 */
export const WORKFLOW_RECIPE_VALUES = [
  "full_pipeline",
  "coding_plus_reviewer",
  "coding_only",
] as const;
export type WorkflowRecipe = (typeof WORKFLOW_RECIPE_VALUES)[number];

export const isWorkflowRecipe = (value: unknown): value is WorkflowRecipe =>
  typeof value === "string" &&
  (WORKFLOW_RECIPE_VALUES as readonly string[]).includes(value);

/** spec §8.1：recipe 来源。 */
export const RECIPE_SOURCE_VALUES = [
  "workflow_default",
  "operator_override",
] as const;
export type RecipeSource = (typeof RECIPE_SOURCE_VALUES)[number];

export const isRecipeSource = (value: unknown): value is RecipeSource =>
  typeof value === "string" &&
  (RECIPE_SOURCE_VALUES as readonly string[]).includes(value);

/**
 * spec §8.1：PipelineRun.agentReportIds 按 role 索引，每 role 一个
 * AgentReport id 或 null（角色未跑或被 recipe 跳过）。
 */
export type AgentReportIdMap = Record<AgentRole, string | null>;

/**
 * spec §8.1：PipelineRun 持久化形态。
 */
export interface PipelineRun {
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  recipe: WorkflowRecipe;
  recipeSource: RecipeSource;
  agentReportIds: AgentReportIdMap;
  status: PipelineRunStatus;
  /** 当前正在跑的角色；pipeline 结束（任一终态）后为 null。 */
  currentRole: AgentRole | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** retry / replan 形成的线性历史；prev → next。 */
  supersedes?: string;
  /** 反向链；当本 run 被新 run 替代时填入。 */
  supersededBy?: string;
}

const VALID_AGENT_ROLES = new Set<AgentRole>([
  "coder",
  "reviewer",
  "test_evidence",
]);

const isAgentReportIdMap = (value: unknown): value is AgentReportIdMap => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  for (const role of VALID_AGENT_ROLES) {
    if (!(role in obj)) return false;
    const v = obj[role];
    if (v !== null && typeof v !== "string") return false;
  }
  return true;
};

export const isPipelineRun = (value: unknown): value is PipelineRun => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.pipelineRunId === "string" &&
    typeof obj.workItemId === "string" &&
    typeof obj.taskId === "string" &&
    isWorkflowRecipe(obj.recipe) &&
    isRecipeSource(obj.recipeSource) &&
    isAgentReportIdMap(obj.agentReportIds) &&
    isPipelineRunStatus(obj.status) &&
    (obj.currentRole === null || isAgentRole(obj.currentRole)) &&
    typeof obj.createdAt === "string" &&
    typeof obj.updatedAt === "string"
  );
};

/**
 * 给定一个 recipe，返回 pipeline 应当顺序跑哪些角色（spec §10）。
 */
export const recipeRoles = (recipe: WorkflowRecipe): readonly AgentRole[] => {
  switch (recipe) {
    case "full_pipeline":
      return ["coder", "reviewer", "test_evidence"] as const;
    case "coding_plus_reviewer":
      return ["coder", "reviewer"] as const;
    case "coding_only":
      return ["coder"] as const;
  }
};

/** 给定 recipe，返回末端角色（pipeline 收尾在哪个 role）。 */
export const recipeFinalRole = (recipe: WorkflowRecipe): AgentRole => {
  const roles = recipeRoles(recipe);
  return roles[roles.length - 1] as AgentRole;
};
