import {
  LAST_ERROR_CODE_VALUES,
  type AgentRole,
  type LastErrorCode,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  UnsupportedFailureMappingError,
  toEventKey,
  toFailurePatternId,
  toTaskNodeReason,
} from "../failure-mapping.js";

describe("LAST_ERROR_CODE_VALUES 编译期断言", () => {
  it("严格 15 项；新增 code 必须先扩 failure-mapping 才能编译过", () => {
    expect(LAST_ERROR_CODE_VALUES.length).toBe(15);
  });
});

describe("failure-mapping.toTaskNodeReason", () => {
  it.each<
    [LastErrorCode, AgentRole, string | "skip"]
  >([
    ["scope_insufficient", "reviewer", "reviewer_cannot_review"],
    ["reviewer_unavailable", "reviewer", "reviewer_unavailable"],
    ["parse_failed", "reviewer", "reviewer_unavailable"],
    ["sandbox_violation", "coder", "sandbox_violation"],
    ["sandbox_violation", "reviewer", "sandbox_violation"],
    ["sandbox_violation", "test_evidence", "sandbox_violation"],
    ["redaction_failed", "reviewer", "reviewer_cannot_review"],
    ["storage_full", "coder", "storage_full"],
    ["coding_failed", "coder", "coding_failed"],
    ["evidence_unavailable", "test_evidence", "evidence_unavailable"],
    ["evidence_partial", "test_evidence", "evidence_partial"],
    ["reviewer_requested_changes", "reviewer", "reviewer_requested_changes"],
    ["gitlab_rate_limited", "reviewer", "skip"],
  ])("(%s, %s) → %s", (code, role, expected) => {
    if (expected === "skip") {
      expect(toTaskNodeReason(code, role)).toBeNull();
      return;
    }
    expect(toTaskNodeReason(code, role)).toBe(expected);
  });

  it("runner_unavailable 按 role 拆分", () => {
    expect(toTaskNodeReason("runner_unavailable", "coder")).toBe("coding_failed");
    expect(toTaskNodeReason("runner_unavailable", "reviewer")).toBe(
      "reviewer_unavailable",
    );
    expect(toTaskNodeReason("runner_unavailable", "test_evidence")).toBe(
      "evidence_unavailable",
    );
  });

  it("prompt_template_missing 按 phase 拆分（spec §16.2 表脚注）", () => {
    expect(
      toTaskNodeReason("prompt_template_missing", "reviewer", {
        phase: "role_profile_init",
      }),
    ).toBe("role_profile_invalid");
    expect(
      toTaskNodeReason("prompt_template_missing", "reviewer", {
        phase: "agent_start",
      }),
    ).toBe("reviewer_cannot_review");
  });

  it("prompt_render_failed 仅在 reviewer 上下文映射为 reviewer_cannot_review（spec §16.2 行）", () => {
    expect(toTaskNodeReason("prompt_render_failed", "reviewer")).toBe(
      "reviewer_cannot_review",
    );
  });

  it("pipeline_cancelled 按 PipelineRun 阶段拆分", () => {
    expect(
      toTaskNodeReason("pipeline_cancelled", "coder", {
        pipelineStatus: "running_coding",
      }),
    ).toBe("coding_failed");
    expect(
      toTaskNodeReason("pipeline_cancelled", "reviewer", {
        pipelineStatus: "running_reviewer",
      }),
    ).toBe("reviewer_unavailable");
    expect(
      toTaskNodeReason("pipeline_cancelled", "test_evidence", {
        pipelineStatus: "running_test_evidence",
      }),
    ).toBe("evidence_unavailable");
    expect(
      toTaskNodeReason("pipeline_cancelled", "coder", {
        pipelineStatus: "draft" as never,
      }),
    ).toBeNull();
  });
});

describe("failure-mapping.toEventKey", () => {
  it.each<[LastErrorCode, string]>([
    ["scope_insufficient", "reviewer_cannot_review"],
    ["prompt_template_missing", "role_profile_invalid"],
    ["prompt_render_failed", "role_profile_invalid"],
    ["reviewer_unavailable", "reviewer_unavailable"],
    ["runner_unavailable", "runner_unavailable"],
    ["parse_failed", "reviewer_unavailable"],
    ["sandbox_violation", "sandbox_violation"],
    ["redaction_failed", "redaction_failed"],
    ["storage_full", "storage_full"],
    ["coding_failed", "coding_failed"],
    ["evidence_unavailable", "evidence_unavailable"],
    ["evidence_partial", "evidence_partial"],
    ["reviewer_requested_changes", "reviewer_requested_changes"],
  ])("%s → %s", (code, expected) => {
    expect(toEventKey(code, "reviewer")).toBe(expected);
  });

  it("pipeline_cancelled 按 PipelineRun 阶段拆分 event key", () => {
    expect(
      toEventKey("pipeline_cancelled", "coder", {
        pipelineStatus: "running_coding",
      }),
    ).toBe("coder_cancelled");
    expect(
      toEventKey("pipeline_cancelled", "reviewer", {
        pipelineStatus: "running_reviewer",
      }),
    ).toBe("reviewer_cancelled");
    expect(
      toEventKey("pipeline_cancelled", "test_evidence", {
        pipelineStatus: "running_test_evidence",
      }),
    ).toBe("test_evidence_cancelled");
  });

  it("gitlab_rate_limited → null（fail-soft）", () => {
    expect(toEventKey("gitlab_rate_limited", "reviewer")).toBeNull();
  });
});

describe("failure-mapping.toFailurePatternId", () => {
  it.each<[LastErrorCode, string | null]>([
    ["scope_insufficient", "reviewer_cannot_review"],
    ["prompt_template_missing", "role_profile_invalid"],
    ["prompt_render_failed", "role_profile_invalid"],
    ["reviewer_unavailable", "reviewer_unavailable"],
    ["runner_unavailable", "runner_unavailable"],
    ["parse_failed", "reviewer_unavailable"],
    ["sandbox_violation", "sandbox_violation"],
    ["redaction_failed", "redaction_failed"],
    ["storage_full", "storage_full"],
    ["coding_failed", "coding_failed"],
    ["evidence_unavailable", "evidence_unavailable"],
    ["evidence_partial", "evidence_partial"],
    ["reviewer_requested_changes", "reviewer_requested_changes"],
    ["pipeline_cancelled", "pipeline_cancelled"],
    ["gitlab_rate_limited", null],
  ])("%s → %s", (code, expected) => {
    expect(toFailurePatternId(code)).toBe(expected);
  });
});

describe("UnsupportedFailureMappingError", () => {
  it("传入未声明的 code → 抛错（exhaustive guard）", () => {
    expect(() =>
      toTaskNodeReason("nonexistent" as LastErrorCode, "coder"),
    ).toThrow(UnsupportedFailureMappingError);
  });
});
