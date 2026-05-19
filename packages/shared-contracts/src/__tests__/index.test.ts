import { describe, it, expect } from "vitest";

import * as mod from "../index.js";
import {
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  PACKAGE_NAME,
} from "../index.js";

describe("@issuepilot/shared-contracts", () => {
  it("exports VERSION and PACKAGE_NAME", () => {
    expect(typeof mod.VERSION).toBe("string");
    expect(mod.PACKAGE_NAME).toBe("@issuepilot/shared-contracts");
    expect(PACKAGE_NAME).toBe("@issuepilot/shared-contracts");
    expect(isImprovementTargetKind("prompt_template")).toBe(true);
    expect(isImprovementRecommendationStatus("open")).toBe(true);
  });

  it("re-exports the value-level helpers from every submodule", () => {
    expect(Array.isArray(mod.RUN_STATUS_VALUES)).toBe(true);
    expect(Array.isArray(mod.EVENT_TYPE_VALUES)).toBe(true);
    expect(Array.isArray(mod.SERVICE_STATUS_VALUES)).toBe(true);
    expect(typeof mod.isRunStatus).toBe("function");
    expect(typeof mod.isEventType).toBe("function");
    expect(typeof mod.isServiceStatus).toBe("function");
  });

  it("re-exports review feedback types (V2 Phase 4)", () => {
    const summary: mod.ReviewFeedbackSummary = {
      mrIid: 1,
      mrUrl: "https://gitlab.example.com/x/-/merge_requests/1",
      generatedAt: "2026-05-16T00:00:00.000Z",
      cursor: "2026-05-16T00:00:00.000Z",
      comments: [],
    };

    expect(summary.comments).toEqual([]);
  });

  it("re-exports V4.6 multi-agent contracts from root index", () => {
    expect(Array.isArray(mod.AGENT_ROLE_VALUES)).toBe(true);
    expect(Array.isArray(mod.AGENT_REPORT_STATUS_VALUES)).toBe(true);
    expect(Array.isArray(mod.LAST_ERROR_CODE_VALUES)).toBe(true);
    expect(Array.isArray(mod.PIPELINE_RUN_STATUS_VALUES)).toBe(true);
    expect(Array.isArray(mod.WORKFLOW_RECIPE_VALUES)).toBe(true);
    expect(Array.isArray(mod.WORKFLOW_SANDBOX_VALUES)).toBe(true);
    expect(Array.isArray(mod.EVIDENCE_STATUS_VALUES)).toBe(true);
    expect(Array.isArray(mod.TASK_ROLE_FAILURE_REASON_VALUES)).toBe(true);
    expect(typeof mod.isAgentRole).toBe("function");
    expect(typeof mod.isPipelineRun).toBe("function");
    expect(typeof mod.parseRoleConfig).toBe("function");
    expect(typeof mod.computeOverallStatus).toBe("function");
    // 编译期通过即说明类型可达
    const _r: mod.AgentReport | undefined = undefined;
    const _p: mod.PipelineRun | undefined = undefined;
    const _c: mod.WorkflowRoleConfig | undefined = undefined;
    const _f: mod.ReviewerFinding | undefined = undefined;
    expect([_r, _p, _c, _f]).toBeDefined();
  });
});
