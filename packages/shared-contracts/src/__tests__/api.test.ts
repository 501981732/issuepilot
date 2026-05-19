import { describe, it, expect, expectTypeOf } from "vitest";

import {
  type EventsListResponse,
  type GetPipelineResponse,
  type GetAgentReportResponse,
  type ListPipelinesResponse,
  type ListPipelineRunAgentReportsResponse,
  type ListRunsQuery,
  type ListTaskAgentReportsResponse,
  type PipelineRouteError,
  type PipelineRouteErrorCode,
  type RetryAgentReportRequest,
  type RetryAgentReportResponse,
  type RevokeAiReviewResponse,
  type RunDetailResponse,
  type RunsListResponse,
  type SetRecipeOverrideRequest,
  type SetRecipeOverrideResponse,
  type SkipAgentReportRequest,
  type SkipAgentReportResponse,
  type ValidateWorkflowRolesResponse,
} from "../api.js";
import { type IssuePilotEvent } from "../events.js";
import { type RunRecord, type RunStatus } from "../run.js";
import { type AgentReport } from "../agent-report.js";
import { type PipelineRun, type WorkflowRecipe } from "../pipeline.js";

describe("@issuepilot/shared-contracts/api", () => {
  it("ListRunsQuery allows single status or array, optional limit", () => {
    expectTypeOf<ListRunsQuery>()
      .toHaveProperty("status")
      .toEqualTypeOf<RunStatus | readonly RunStatus[] | undefined>();
    expectTypeOf<ListRunsQuery>()
      .toHaveProperty("limit")
      .toEqualTypeOf<number | undefined>();
  });

  it("RunsListResponse wraps an array of RunRecord", () => {
    expectTypeOf<RunsListResponse>()
      .toHaveProperty("runs")
      .toEqualTypeOf<RunRecord[]>();
  });

  it("RunDetailResponse bundles run + events + logsTail", () => {
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("run")
      .toEqualTypeOf<RunRecord>();
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("events")
      .toEqualTypeOf<IssuePilotEvent[]>();
    expectTypeOf<RunDetailResponse>()
      .toHaveProperty("logsTail")
      .toEqualTypeOf<string[]>();
  });

  it("EventsListResponse exposes events + nextCursor", () => {
    expectTypeOf<EventsListResponse>()
      .toHaveProperty("events")
      .toEqualTypeOf<IssuePilotEvent[]>();
    expectTypeOf<EventsListResponse>()
      .toHaveProperty("nextCursor")
      .toEqualTypeOf<string | undefined>();
  });

  it("V4.6 PipelineRouteErrorCode 严格 11 项", () => {
    const codes: PipelineRouteErrorCode[] = [
      "recipe_override_locked",
      "unknown_recipe",
      "role_mismatch",
      "not_revocable",
      "project_required",
      "project_query_not_allowed",
      "task_not_found",
      "pipeline_run_not_found",
      "agent_report_not_found",
      "role_skip_not_allowed",
      "workflow_not_found",
      "invalid_payload",
    ];
    expect(codes.length).toBe(12);
  });

  it("V4.6 GetPipelineResponse 持有 PipelineRun 或 null", () => {
    expectTypeOf<GetPipelineResponse>()
      .toHaveProperty("pipelineRun")
      .toEqualTypeOf<PipelineRun | null>();
  });

  it("V4.6 ListPipelinesResponse 返回 PipelineRun 数组", () => {
    expectTypeOf<ListPipelinesResponse>()
      .toHaveProperty("pipelineRuns")
      .toEqualTypeOf<PipelineRun[]>();
  });

  it("V4.6 SetRecipeOverrideRequest 需要 WorkflowRecipe", () => {
    expectTypeOf<SetRecipeOverrideRequest>()
      .toHaveProperty("recipe")
      .toEqualTypeOf<WorkflowRecipe>();
  });

  it("V4.6 SetRecipeOverrideResponse 标注 appliedTo", () => {
    expectTypeOf<SetRecipeOverrideResponse>()
      .toHaveProperty("appliedTo")
      .toEqualTypeOf<"pipeline_run" | "pending">();
  });

  it("V4.6 GetAgentReportResponse 返回 discriminated union", () => {
    expectTypeOf<GetAgentReportResponse>()
      .toHaveProperty("agentReport")
      .toEqualTypeOf<AgentReport>();
  });

  it("V4.6 ListTaskAgentReportsResponse + ListPipelineRunAgentReportsResponse 类型存在", () => {
    expectTypeOf<ListTaskAgentReportsResponse>()
      .toHaveProperty("agentReports")
      .toMatchTypeOf<readonly { agentReportId: string }[]>();
    expectTypeOf<ListPipelineRunAgentReportsResponse>()
      .toHaveProperty("agentReports")
      .toEqualTypeOf<AgentReport[]>();
  });

  it("V4.6 RevokeAiReviewResponse / Retry / Skip 入参出参", () => {
    expectTypeOf<RevokeAiReviewResponse>()
      .toHaveProperty("status")
      .toEqualTypeOf<"revoked">();
    expectTypeOf<RetryAgentReportRequest>()
      .toHaveProperty("operator")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RetryAgentReportResponse>()
      .toHaveProperty("pipelineRunId")
      .toEqualTypeOf<string>();
    expectTypeOf<SkipAgentReportRequest>()
      .toHaveProperty("operator")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<SkipAgentReportResponse>()
      .toHaveProperty("nextRole")
      .toMatchTypeOf<"awaiting_human_review" | "coder" | "reviewer" | "test_evidence">();
  });

  it("V4.6 ValidateWorkflowRolesResponse 暴露 valid + errors", () => {
    expectTypeOf<ValidateWorkflowRolesResponse>()
      .toHaveProperty("valid")
      .toEqualTypeOf<boolean>();
  });

  it("V4.6 PipelineRouteError 字面值断言", () => {
    const err: PipelineRouteError = {
      code: "recipe_override_locked",
      message: "Pipeline coding step has started; recipe override is locked.",
    };
    expect(err.code).toBe("recipe_override_locked");
  });
});
