/**
 * V4.6 spec §8.1 / §10：把多源（workflow YAML default、TaskNode.pendingRecipe、
 * PipelineRun.recipe）合并成 in-memory 的 effective recipe。
 *
 * 三态语义：
 * - `workflow_default`：没有任何 override，直接用 workflow YAML 的
 *   `default_recipe`。
 * - `task_pending`：operator 已经在 task 层选了 recipe，但 PipelineRun
 *   还未创建（task 状态 ∈ {planned, blocked_by_dependency, ready}），
 *   PipelineRun 创建时把它写成 `operator_override`。
 * - `pipeline_locked`：PipelineRun 已经写盘并锁定 recipe；之后即便
 *   TaskNode 上还有 pendingRecipe，也以 PipelineRun.recipe 为准。
 *
 * 注意：`RecipeSource`（spec §8.1）只有 `workflow_default` / `operator_override`
 * 两个落盘值；本模块的 `EffectiveRecipeSource` 是 in-memory 概念，
 * 用 `toPipelineRunRecipeSource` 才能转换成落盘字段。
 */

import {
  WORKFLOW_RECIPE_VALUES,
  type AgentRole,
  type RecipeSource,
  type WorkflowRecipe,
} from "@issuepilot/shared-contracts";

export type EffectiveRecipeSource =
  | "workflow_default"
  | "task_pending"
  | "pipeline_locked";

export interface ResolveEffectiveRecipeInput {
  workflowDefault: WorkflowRecipe;
  pendingRecipe?: WorkflowRecipe;
  pipelineRecipe?: WorkflowRecipe;
}

export interface EffectiveRecipe {
  recipe: WorkflowRecipe;
  source: EffectiveRecipeSource;
}

export class UnknownRecipeError extends Error {
  override readonly name = "UnknownRecipeError";

  constructor(
    public readonly value: unknown,
    public readonly field:
      | "workflowDefault"
      | "pendingRecipe"
      | "pipelineRecipe",
  ) {
    super(`Unknown recipe value at ${field}: ${String(value)}`);
  }
}

const VALID_RECIPES = new Set<WorkflowRecipe>(WORKFLOW_RECIPE_VALUES);

const assertRecipe = (
  value: WorkflowRecipe | undefined,
  field: UnknownRecipeError["field"],
): WorkflowRecipe | undefined => {
  if (value === undefined) return undefined;
  if (!VALID_RECIPES.has(value)) {
    throw new UnknownRecipeError(value, field);
  }
  return value;
};

/**
 * spec §10：解析 TaskNode 当前生效的 recipe。PipelineRun 已写入 →
 * pipeline_locked；否则 pending > workflow default。
 */
export const resolveEffectiveRecipe = (
  input: ResolveEffectiveRecipeInput,
): EffectiveRecipe => {
  const pipelineRecipe = assertRecipe(input.pipelineRecipe, "pipelineRecipe");
  if (pipelineRecipe) {
    return { recipe: pipelineRecipe, source: "pipeline_locked" };
  }
  const pendingRecipe = assertRecipe(input.pendingRecipe, "pendingRecipe");
  if (pendingRecipe) {
    return { recipe: pendingRecipe, source: "task_pending" };
  }
  const workflowDefault = assertRecipe(
    input.workflowDefault,
    "workflowDefault",
  );
  if (!workflowDefault) {
    throw new UnknownRecipeError(input.workflowDefault, "workflowDefault");
  }
  return { recipe: workflowDefault, source: "workflow_default" };
};

/** spec §10：recipe → 顺序执行的 agent role 列表。 */
export const recipeRoles = (recipe: WorkflowRecipe): readonly AgentRole[] => {
  switch (recipe) {
    case "full_pipeline":
      return ["coder", "reviewer", "test_evidence"] as const;
    case "coding_plus_reviewer":
      return ["coder", "reviewer"] as const;
    case "coding_only":
      return ["coder"] as const;
    default: {
      const _exhaustive: never = recipe;
      throw new UnknownRecipeError(recipe, "workflowDefault");
    }
  }
};

/** 末端角色：pipeline 收尾的 role。 */
export const recipeFinalRole = (recipe: WorkflowRecipe): AgentRole => {
  const roles = recipeRoles(recipe);
  return roles[roles.length - 1]!;
};

/**
 * spec §8.1：把 in-memory 的 EffectiveRecipeSource 折叠成 PipelineRun
 * 落盘的 RecipeSource（只有 workflow_default / operator_override）。
 * `pipeline_locked` 不应该参与 PipelineRun 创建时的落盘（PipelineRun
 * 已存在则不需要再写 source），调用方误用时抛错。
 */
export const toPipelineRunRecipeSource = (
  source: EffectiveRecipeSource,
): RecipeSource => {
  switch (source) {
    case "workflow_default":
      return "workflow_default";
    case "task_pending":
      return "operator_override";
    case "pipeline_locked":
      throw new Error(
        "toPipelineRunRecipeSource: cannot convert pipeline_locked; the PipelineRun's existing recipeSource should be reused",
      );
    default: {
      const _exhaustive: never = source;
      throw new Error(`unknown EffectiveRecipeSource: ${String(source)}`);
    }
  }
};
