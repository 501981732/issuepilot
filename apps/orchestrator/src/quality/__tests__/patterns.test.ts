import { describe, expect, it } from "vitest";

import { classifyAgentFailure, classifyQualityPatterns } from "../patterns.js";
import type { QualitySourceItem } from "../types.js";
import type {
  AgentReport,
  ReviewerAgentReport,
  TestEvidenceAgentReport,
  CoderAgentReport,
} from "@issuepilot/shared-contracts";

function runSource(
  over: Partial<Extract<QualitySourceItem, { kind: "run" }>>,
): QualitySourceItem {
  return {
    kind: "run",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    runId: "run-1",
    runStatus: "completed",
    issue: {
      projectId: "proj-a",
      iid: 1,
      title: "Issue",
      url: "https://gitlab.example/1",
      labels: [],
    },
    checks: [],
    risks: [],
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

function taskSource(
  over: Partial<Extract<QualitySourceItem, { kind: "task" }>>,
): QualitySourceItem {
  return {
    kind: "task",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    workItemId: "wi-1",
    workItemTitle: "WI",
    taskId: "t1",
    taskTitle: "Task",
    taskStatus: "completed",
    checklistReasons: [],
    evidenceCount: 1,
    validationEvidenceCount: 1,
    trustedValidationEvidenceCount: 1,
    aiClaimValidationEvidenceCount: 0,
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

describe("classifyQualityPatterns", () => {
  it("classifies permission issues", () => {
    const patterns = classifyQualityPatterns(
      runSource({
        runId: "run-1",
        runStatus: "failed",
        lastError: {
          code: "gitlab_403",
          message: "403 access denied",
          classification: "failed",
        },
      }),
    );
    expect(patterns).toContainEqual(
      expect.objectContaining({
        patternId: "permission-issue",
        reason: expect.stringContaining("403"),
      }),
    );
  });

  it("classifies missing tests when checks are empty", () => {
    expect(
      classifyQualityPatterns(
        runSource({ checks: [], risks: [], runStatus: "completed" }),
      ).map((p) => p.patternId),
    ).toContain("missing-tests");
  });

  it("classifies missing tests when task has no evidence", () => {
    expect(
      classifyQualityPatterns(
        taskSource({
          taskStatus: "completed",
          evidenceCount: 1,
          validationEvidenceCount: 0,
          trustedValidationEvidenceCount: 0,
        }),
      ).map((p) => p.patternId),
    ).toContain("missing-tests");
  });

  it("classifies AI-claim-only validation as missing tests but not missing evidence", () => {
    const ids = classifyQualityPatterns(
      taskSource({
        evidenceCount: 1,
        validationEvidenceCount: 1,
        trustedValidationEvidenceCount: 0,
        aiClaimValidationEvidenceCount: 1,
      }),
    ).map((p) => p.patternId);

    expect(ids).toContain("missing-tests");
    expect(ids).not.toContain("missing-evidence");
  });

  it("classifies review rework", () => {
    expect(
      classifyQualityPatterns(
        taskSource({
          taskStatus: "needs_rework",
          needsReworkReason: "Reviewer requested unit tests",
        }),
      ).map((p) => p.patternId),
    ).toContain("review-rework");
  });

  it("classifies review rework from unresolved feedback on a run", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          reviewFeedback: { unresolvedCount: 2, comments: [] },
        }),
      ).map((p) => p.patternId),
    ).toContain("review-rework");
  });

  it("classifies unclear requirements", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "blocked",
          lastError: {
            code: "blocked",
            message: "missing acceptance criteria",
          },
        }),
      ).map((p) => p.patternId),
    ).toContain("unclear-requirements");
  });

  it("classifies environment issues", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          lastError: {
            code: "setup",
            message: "dependency install timeout",
          },
        }),
      ).map((p) => p.patternId),
    ).toContain("environment-issue");
  });

  it("classifies ci failure", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          ciStatus: "failed",
        }),
      ).map((p) => p.patternId),
    ).toContain("ci-failure");
  });

  it("classifies missing evidence on task checklist", () => {
    expect(
      classifyQualityPatterns(
        taskSource({
          taskStatus: "completed",
          checklistReasons: ["missing-evidence"],
        }),
      ).map((p) => p.patternId),
    ).toContain("missing-evidence");
  });

  it("classifies missing evidence when report is incomplete", () => {
    expect(
      classifyQualityPatterns(taskSource({ reportStatus: "incomplete" })).map(
        (p) => p.patternId,
      ),
    ).toContain("missing-evidence");
  });

  it("can emit multiple patterns for a single item", () => {
    const patterns = classifyQualityPatterns(
      runSource({
        runStatus: "failed",
        ciStatus: "failed",
        lastError: {
          code: "permission",
          message: "401 unauthorized; missing token",
        },
      }),
    );
    const ids = patterns.map((p) => p.patternId);
    expect(ids).toEqual(
      expect.arrayContaining(["permission-issue", "ci-failure"]),
    );
  });

  it("does not classify completed runs with checks as missing-tests", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "completed",
          checks: [{ name: "unit", status: "passed" }],
        }),
      ).map((p) => p.patternId),
    ).not.toContain("missing-tests");
  });
});

function reviewerReport(
  over: Partial<ReviewerAgentReport>,
): ReviewerAgentReport {
  return {
    agentReportId: "ar-1",
    pipelineRunId: "p-1",
    taskId: "t-1",
    role: "reviewer",
    roleProfileId: "reviewer@v1",
    status: "complete",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:10.000Z",
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
    ...over,
  } as ReviewerAgentReport;
}

function testEvidenceReport(
  over: Partial<TestEvidenceAgentReport>,
): TestEvidenceAgentReport {
  return {
    agentReportId: "ar-2",
    pipelineRunId: "p-1",
    taskId: "t-1",
    role: "test_evidence",
    roleProfileId: "test_evidence@v1",
    status: "complete",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:10.000Z",
    evidenceLinks: [],
    redactedFields: [],
    testEvidence: { evidenceItems: [], baselineEvidence: null },
    ...over,
  } as TestEvidenceAgentReport;
}

function coderReport(over: Partial<CoderAgentReport>): CoderAgentReport {
  return {
    agentReportId: "ar-3",
    pipelineRunId: "p-1",
    taskId: "t-1",
    role: "coder",
    roleProfileId: "coder@v1",
    status: "complete",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:10.000Z",
    evidenceLinks: [],
    redactedFields: [],
    coder: { summary: "ok" },
    ...over,
  } as unknown as CoderAgentReport;
}

describe("classifyAgentFailure (V4.6)", () => {
  it("returns null on reviewer approve_with_comments", () => {
    expect(classifyAgentFailure(reviewerReport({}))).toBeNull();
  });

  it("maps reviewer cannot_review to reviewer_cannot_review pattern + configuration bucket", () => {
    const result = classifyAgentFailure(
      reviewerReport({
        reviewer: {
          summary: "scope insufficient",
          decision: "cannot_review",
          confidence: 0,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "skipped_by_config", noteIds: [] },
        },
      }),
    );
    expect(result).toMatchObject({
      patternId: "reviewer_cannot_review",
      bucket: "configuration",
    });
  });

  it("maps reviewer request_changes to reviewer_requested_changes pattern + reviewer bucket", () => {
    const result = classifyAgentFailure(
      reviewerReport({
        reviewer: {
          summary: "needs fix",
          decision: "request_changes",
          confidence: 0.42,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "skipped_by_config", noteIds: [] },
        },
      }),
    );
    expect(result).toMatchObject({
      patternId: "reviewer_requested_changes",
      bucket: "reviewer",
    });
  });

  it("maps lastError.scope_insufficient on reviewer-failed to reviewer_cannot_review", () => {
    const result = classifyAgentFailure(
      reviewerReport({
        status: "failed",
        lastError: {
          code: "scope_insufficient",
          message: "missing GitLab scope api",
        },
      }) as AgentReport,
    );
    expect(result?.patternId).toBe("reviewer_cannot_review");
  });

  it("maps test_evidence incomplete (no lastError) to evidence_partial", () => {
    const result = classifyAgentFailure(
      testEvidenceReport({ status: "incomplete" }),
    );
    expect(result?.patternId).toBe("evidence_partial");
  });

  it("maps sandbox_violation lastError on coder to sandbox_violation pattern + pipeline bucket", () => {
    const result = classifyAgentFailure(
      coderReport({
        status: "failed",
        lastError: {
          code: "sandbox_violation",
          message: "tried to write outside worktree",
        },
      }),
    );
    expect(result).toMatchObject({
      patternId: "sandbox_violation",
      bucket: "pipeline",
    });
  });

  it("maps coding_failed lastError on coder to coding_failed + coder bucket", () => {
    const result = classifyAgentFailure(
      coderReport({
        status: "failed",
        lastError: { code: "coding_failed", message: "patch did not apply" },
      }),
    );
    expect(result).toMatchObject({
      patternId: "coding_failed",
      bucket: "coder",
    });
  });
});
