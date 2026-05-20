import { describe, expect, it } from "vitest";

import {
  AGENT_ROLE_VALUES,
  AGENT_REPORT_STATUS_VALUES,
  LAST_ERROR_CODE_VALUES,
  isAgentRole,
  isAgentReportStatus,
  isLastErrorCode,
  isAgentReport,
  isCoderAgentReport,
  isReviewerAgentReport,
  isTestEvidenceAgentReport,
  type AgentReport,
  type CoderAgentReport,
  type ReviewerAgentReport,
  type TestEvidenceAgentReport,
} from "../agent-report.js";

describe("agent-report contracts", () => {
  it("AGENT_ROLE_VALUES 严格按 spec §8.2 三个枚举", () => {
    expect([...AGENT_ROLE_VALUES]).toEqual([
      "coder",
      "reviewer",
      "test_evidence",
    ]);
  });

  it("AGENT_REPORT_STATUS_VALUES 覆盖 running/complete/incomplete/failed/cancelled", () => {
    expect(new Set(AGENT_REPORT_STATUS_VALUES)).toEqual(
      new Set(["running", "complete", "incomplete", "failed", "cancelled"]),
    );
  });

  it("LAST_ERROR_CODE_VALUES 严格按 spec §16.2 的 15 项 truth source", () => {
    expect(new Set(LAST_ERROR_CODE_VALUES)).toEqual(
      new Set([
        "scope_insufficient",
        "prompt_template_missing",
        "prompt_render_failed",
        "reviewer_unavailable",
        "runner_unavailable",
        "parse_failed",
        "sandbox_violation",
        "redaction_failed",
        "storage_full",
        "gitlab_rate_limited",
        "coding_failed",
        "evidence_unavailable",
        "evidence_partial",
        "reviewer_requested_changes",
        "pipeline_cancelled",
      ]),
    );
    expect(LAST_ERROR_CODE_VALUES.length).toBe(15);
  });

  it("isLastErrorCode 接受 scope_insufficient，拒绝 TaskNode roleFailureReason 与未知值", () => {
    expect(isLastErrorCode("scope_insufficient")).toBe(true);
    // reviewer_cannot_review 是 TaskNode roleFailureReason / event key，
    // 不是 lastError.code（spec §16.2）。
    expect(isLastErrorCode("reviewer_cannot_review")).toBe(false);
    expect(isLastErrorCode("totally_unknown")).toBe(false);
    expect(isLastErrorCode(42)).toBe(false);
  });

  it("isAgentRole / isAgentReportStatus 拒绝未知值", () => {
    expect(isAgentRole("coder")).toBe(true);
    expect(isAgentRole("planner")).toBe(false);
    expect(isAgentReportStatus("complete")).toBe(true);
    expect(isAgentReportStatus("succeeded")).toBe(false);
  });

  it("CoderAgentReport 形态可建", () => {
    const r: CoderAgentReport = {
      agentReportId: "ar_coder_1",
      pipelineRunId: "pr_1",
      taskId: "t1",
      role: "coder",
      roleProfileId: "coder@v1",
      status: "complete",
      startedAt: "2026-05-19T00:00:00.000Z",
      completedAt: "2026-05-19T00:00:05.000Z",
      runId: "run_a",
      promptTemplateHash: "abc",
      evidenceLinks: [],
      redactedFields: [],
      coder: {
        diffSummary: "Added LoginForm component",
        branch: "ai/42-task-1",
        buildStatus: "passed",
        testStatus: "passed",
        lintStatus: "passed",
      },
    };
    expect(isAgentReport(r)).toBe(true);
    expect(isCoderAgentReport(r)).toBe(true);
    expect(isReviewerAgentReport(r)).toBe(false);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("ReviewerAgentReport discriminated union by role", () => {
    const r: ReviewerAgentReport = {
      agentReportId: "ar_reviewer_1",
      pipelineRunId: "pr_1",
      taskId: "t1",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      status: "complete",
      startedAt: "2026-05-19T00:00:00.000Z",
      completedAt: "2026-05-19T00:00:10.000Z",
      runId: "run_reviewer_a",
      promptTemplateHash: "rev_abc",
      evidenceLinks: [],
      redactedFields: [],
      reviewer: {
        summary: "LGTM",
        decision: "approve_with_comments",
        confidence: 0.91,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
        mrPublication: { status: "skipped_by_config", noteIds: [] },
      },
    };
    expect(r.role).toBe("reviewer");
    expect(isReviewerAgentReport(r)).toBe(true);
    expect(isCoderAgentReport(r)).toBe(false);
    expect(r.reviewer.decision).toBe("approve_with_comments");
  });

  it("TestEvidenceAgentReport 形态可建，baselineEvidence 可为 null", () => {
    const r: TestEvidenceAgentReport = {
      agentReportId: "ar_te_1",
      pipelineRunId: "pr_1",
      taskId: "t1",
      role: "test_evidence",
      roleProfileId: "test_evidence@v1",
      status: "incomplete",
      startedAt: "2026-05-19T00:00:00.000Z",
      runId: null,
      promptTemplateHash: null,
      evidenceLinks: [],
      redactedFields: [],
      lastError: {
        code: "evidence_partial",
        message: "1 of 3 evidence items failed",
      },
      testEvidence: {
        evidenceItems: [
          {
            kind: "screenshot",
            target: "after-login",
            source: "playwright",
            status: "collected",
            artifactPath: "evidence/t1/after-login.png",
          },
        ],
        baselineEvidence: null,
      },
    };
    expect(isTestEvidenceAgentReport(r)).toBe(true);
    expect(r.testEvidence.baselineEvidence).toBeNull();
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("AgentReport union 在 reviewer 未启动时仍可写 (runId/promptTemplateHash = null)", () => {
    const r: AgentReport = {
      agentReportId: "ar_reviewer_unstarted",
      pipelineRunId: "pr_1",
      taskId: "t1",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      status: "failed",
      startedAt: "2026-05-19T00:00:00.000Z",
      runId: null,
      promptTemplateHash: null,
      evidenceLinks: [],
      redactedFields: [],
      lastError: {
        code: "scope_insufficient",
        message: "Missing notes:create scope",
        hint: "Add api scope to ISSUEPILOT_GITLAB_TOKEN",
      },
      reviewer: {
        summary: "",
        decision: "cannot_review",
        confidence: 0,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
        mrPublication: { status: "skipped_by_config", noteIds: [] },
      },
    };
    expect(isAgentReport(r)).toBe(true);
    expect(r.runId).toBeNull();
  });

  it("isAgentReport 拒绝缺字段对象", () => {
    expect(isAgentReport({ role: "coder" })).toBe(false);
    expect(isAgentReport(null)).toBe(false);
    expect(isAgentReport(undefined)).toBe(false);
  });
});
