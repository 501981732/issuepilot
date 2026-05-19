import { describe, expect, it } from "vitest";

import {
  PIPELINE_RUN_STATUS_VALUES,
  WORKFLOW_RECIPE_VALUES,
  RECIPE_SOURCE_VALUES,
  isPipelineRunStatus,
  isWorkflowRecipe,
  isRecipeSource,
  isPipelineRun,
  type PipelineRun,
} from "../pipeline.js";

describe("pipeline contracts", () => {
  it("PIPELINE_RUN_STATUS_VALUES 严格按 spec §8.1 的 8 项", () => {
    expect(new Set(PIPELINE_RUN_STATUS_VALUES)).toEqual(
      new Set([
        "running_coding",
        "running_reviewer",
        "running_test_evidence",
        "awaiting_human_review",
        "awaiting_rework",
        "partial",
        "failed",
        "cancelled",
      ]),
    );
    expect(PIPELINE_RUN_STATUS_VALUES.length).toBe(8);
    // 历史 `draft` / `running` / `succeeded` 不在 V4.6 PipelineRunStatus 内。
    expect(isPipelineRunStatus("draft")).toBe(false);
    expect(isPipelineRunStatus("succeeded")).toBe(false);
  });

  it("WORKFLOW_RECIPE_VALUES 严格 full_pipeline / coding_plus_reviewer / coding_only", () => {
    expect([...WORKFLOW_RECIPE_VALUES]).toEqual([
      "full_pipeline",
      "coding_plus_reviewer",
      "coding_only",
    ]);
    expect(isWorkflowRecipe("coding_only")).toBe(true);
    expect(isWorkflowRecipe("unknown")).toBe(false);
  });

  it("RECIPE_SOURCE_VALUES 严格 workflow_default / operator_override", () => {
    expect([...RECIPE_SOURCE_VALUES]).toEqual([
      "workflow_default",
      "operator_override",
    ]);
    expect(isRecipeSource("workflow_default")).toBe(true);
    expect(isRecipeSource("magical")).toBe(false);
  });

  it("PipelineRun by-role agentReportIds 索引", () => {
    const pr: PipelineRun = {
      pipelineRunId: "pr_1",
      workItemId: "wi_1",
      taskId: "t1",
      recipe: "full_pipeline",
      recipeSource: "workflow_default",
      agentReportIds: {
        coder: "ar_coder_1",
        reviewer: "ar_reviewer_1",
        test_evidence: null,
      },
      status: "running_test_evidence",
      currentRole: "test_evidence",
      createdAt: "2026-05-19T00:00:00.000Z",
      updatedAt: "2026-05-19T00:00:05.000Z",
    };
    expect(pr.agentReportIds.reviewer).toBe("ar_reviewer_1");
    expect(pr.agentReportIds.test_evidence).toBeNull();
    expect(isPipelineRun(pr)).toBe(true);
    expect(JSON.parse(JSON.stringify(pr))).toEqual(pr);
  });

  it("PipelineRun 支持 supersede 链", () => {
    const pr: PipelineRun = {
      pipelineRunId: "pr_2",
      workItemId: "wi_1",
      taskId: "t1",
      recipe: "coding_only",
      recipeSource: "operator_override",
      agentReportIds: { coder: null, reviewer: null, test_evidence: null },
      status: "running_coding",
      currentRole: "coder",
      createdAt: "2026-05-19T01:00:00.000Z",
      updatedAt: "2026-05-19T01:00:00.000Z",
      supersedes: "pr_1",
    };
    expect(pr.supersedes).toBe("pr_1");
    expect(JSON.parse(JSON.stringify(pr))).toEqual(pr);
  });

  it("isPipelineRun 拒绝缺字段 / 错枚举", () => {
    expect(isPipelineRun(null)).toBe(false);
    expect(isPipelineRun({})).toBe(false);
    expect(isPipelineRun({ pipelineRunId: "x" })).toBe(false);
    expect(
      isPipelineRun({
        pipelineRunId: "pr_x",
        workItemId: "wi_1",
        taskId: "t1",
        recipe: "unknown_recipe",
        recipeSource: "workflow_default",
        agentReportIds: { coder: null, reviewer: null, test_evidence: null },
        status: "running_coding",
        currentRole: "coder",
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
      }),
    ).toBe(false);
  });
});
