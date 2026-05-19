import { describe, expect, it } from "vitest";

import {
  UnknownRecipeError,
  recipeRoles,
  resolveEffectiveRecipe,
  toPipelineRunRecipeSource,
} from "../recipe.js";

describe("resolveEffectiveRecipe", () => {
  it("workflow default + 无 task override → workflow_default", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: undefined,
        pipelineRecipe: undefined,
      }),
    ).toEqual({ recipe: "full_pipeline", source: "workflow_default" });
  });

  it("pendingRecipe 覆盖 workflow default（PipelineRun 未创建）→ task_pending", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: "coding_only",
        pipelineRecipe: undefined,
      }),
    ).toEqual({ recipe: "coding_only", source: "task_pending" });
  });

  it("pipelineRecipe 一旦写入则成为 truth（pipeline_locked）", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: "coding_plus_reviewer",
        pipelineRecipe: "coding_only",
      }),
    ).toEqual({ recipe: "coding_only", source: "pipeline_locked" });
  });

  it("未知 recipe → UnknownRecipeError", () => {
    expect(() =>
      resolveEffectiveRecipe({
        workflowDefault: "weird_recipe" as never,
        pendingRecipe: undefined,
        pipelineRecipe: undefined,
      }),
    ).toThrow(UnknownRecipeError);
    expect(() =>
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: "bogus" as never,
        pipelineRecipe: undefined,
      }),
    ).toThrow(/Unknown recipe/);
  });
});

describe("recipeRoles", () => {
  it("full_pipeline → [coder, reviewer, test_evidence]", () => {
    expect(recipeRoles("full_pipeline")).toEqual([
      "coder",
      "reviewer",
      "test_evidence",
    ]);
  });
  it("coding_plus_reviewer → [coder, reviewer]", () => {
    expect(recipeRoles("coding_plus_reviewer")).toEqual(["coder", "reviewer"]);
  });
  it("coding_only → [coder]", () => {
    expect(recipeRoles("coding_only")).toEqual(["coder"]);
  });
});

describe("toPipelineRunRecipeSource", () => {
  it("workflow_default → workflow_default", () => {
    expect(toPipelineRunRecipeSource("workflow_default")).toBe(
      "workflow_default",
    );
  });
  it("task_pending → operator_override", () => {
    expect(toPipelineRunRecipeSource("task_pending")).toBe(
      "operator_override",
    );
  });
  it("pipeline_locked → 抛错（不允许在 PipelineRun 创建时落盘）", () => {
    expect(() =>
      toPipelineRunRecipeSource("pipeline_locked"),
    ).toThrow(/pipeline_locked/);
  });
});
