import { describe, expect, it } from "vitest";
import type {
  ReviewerAgentReport,
  ReviewFeedbackSummary,
} from "@issuepilot/shared-contracts";

import { buildReviewReworkPlan } from "../planner.js";

const baseSummary: ReviewFeedbackSummary = {
  mrIid: 42,
  mrUrl: "https://gitlab.example.com/p/-/merge_requests/42",
  generatedAt: "2026-05-21T00:00:00.000Z",
  cursor: "2026-05-21T00:00:00.000Z",
  comments: [
    {
      noteId: 1,
      author: "alice",
      body: "please add unit tests for util.ts",
      url: "https://gitlab.example.com/p/-/merge_requests/42#note_1",
      createdAt: "2026-05-21T00:00:00.000Z",
      resolved: false,
    },
    {
      noteId: 2,
      author: "alice",
      body: "ci pipeline failed",
      url: "https://gitlab.example.com/p/-/merge_requests/42#note_2",
      createdAt: "2026-05-21T00:01:00.000Z",
      resolved: false,
    },
  ],
};

describe("V4.9 buildReviewReworkPlan", () => {
  it("generates a draft plan from human review comments", () => {
    const plan = buildReviewReworkPlan({
      runId: "run-1",
      issueIid: 7,
      projectId: "p1",
      summary: baseSummary,
      reviewerReports: [],
      now: () => new Date("2026-05-21T00:05:00.000Z"),
      randomId: () => "plan-1",
    });

    expect(plan.status).toBe("draft");
    expect(plan.items.length).toBeGreaterThanOrEqual(2);
    const categories = plan.items.map((i) => i.category);
    expect(categories).toContain("test_gap");
    expect(categories).toContain("ci_failure");
    expect(plan.sourceSummaryId).toBe(`${baseSummary.mrIid}:${baseSummary.cursor}`);
  });

  it("preserves runnerKind on ai_reviewer_finding source refs", () => {
    const reviewer: ReviewerAgentReport = {
      agentReportId: "ar-1",
      pipelineRunId: "pipe-1",
      taskId: "task-1",
      role: "reviewer",
      roleProfileId: "reviewer",
      runnerId: "claude_reviewer",
      runnerKind: "claude_code",
      runnerRunId: "claude-run-1",
      status: "complete",
      startedAt: "2026-05-21T00:00:00.000Z",
      evidenceLinks: [],
      redactedFields: [],
      reviewer: {
        summary: "needs more tests",
        decision: "request_changes",
        confidence: 0.7,
        risks: [],
        evidenceRequest: [],
        findings: [
          {
            severity: "high",
            category: "test_gap",
            message: "missing e2e for modal close",
            locationHint: { filePath: "src/modal.tsx" },
          },
        ],
        inlineComments: [],
        mrPublication: { status: "pending", noteIds: [] },
      },
    };

    const plan = buildReviewReworkPlan({
      runId: "run-1",
      issueIid: 8,
      reviewerReports: [reviewer],
      now: () => new Date("2026-05-21T00:05:00.000Z"),
      randomId: () => "plan-2",
    });

    expect(plan.items).toHaveLength(1);
    const ref = plan.items[0]!.sourceRefs[0]!;
    expect(ref.kind).toBe("ai_reviewer_finding");
    expect(ref.runnerKind).toBe("claude_code");
    expect(ref.agentReportId).toBe("ar-1");
  });

  it("merges duplicate source refs that target the same file and title", () => {
    const reviewer: ReviewerAgentReport = {
      agentReportId: "ar-2",
      pipelineRunId: "pipe-2",
      taskId: "task-2",
      role: "reviewer",
      roleProfileId: "reviewer",
      runnerId: "codex_app_server",
      runnerKind: "codex_app_server",
      status: "complete",
      startedAt: "2026-05-21T00:00:00.000Z",
      evidenceLinks: [],
      redactedFields: [],
      reviewer: {
        summary: "",
        decision: "request_changes",
        confidence: 0.6,
        risks: [],
        evidenceRequest: [],
        findings: [
          {
            severity: "medium",
            category: "test_gap",
            message: "add unit tests for util.ts",
            locationHint: { filePath: "src/util.ts" },
          },
        ],
        inlineComments: [],
        mrPublication: { status: "pending", noteIds: [] },
      },
    };

    const plan = buildReviewReworkPlan({
      runId: "run-1",
      issueIid: 9,
      summary: baseSummary,
      reviewerReports: [reviewer],
      now: () => new Date("2026-05-21T00:05:00.000Z"),
      randomId: () => "plan-3",
    });

    const testGap = plan.items.filter((i) => i.category === "test_gap");
    expect(testGap.length).toBe(1);
    expect(testGap[0]!.sourceRefs.map((r) => r.kind).sort()).toEqual([
      "ai_reviewer_finding",
      "human_review_comment",
    ]);
  });

  it("emits an empty plan when no source produces any item", () => {
    const plan = buildReviewReworkPlan({
      runId: "run-1",
      issueIid: 10,
      reviewerReports: [],
      now: () => new Date("2026-05-21T00:05:00.000Z"),
      randomId: () => "plan-4",
    });
    expect(plan.status).toBe("draft");
    expect(plan.items).toEqual([]);
  });

  it("classifies low-confidence comments into question category", () => {
    const summary: ReviewFeedbackSummary = {
      ...baseSummary,
      comments: [
        {
          noteId: 9,
          author: "alice",
          body: "wdyt about the naming?",
          url: "https://gitlab.example.com/p/-/merge_requests/42#note_9",
          createdAt: "2026-05-21T00:00:00.000Z",
          resolved: false,
        },
      ],
    };
    const plan = buildReviewReworkPlan({
      runId: "run-1",
      issueIid: 11,
      summary,
      reviewerReports: [],
      now: () => new Date("2026-05-21T00:05:00.000Z"),
      randomId: () => "plan-5",
    });
    expect(plan.items[0]!.category).toBe("question");
    expect(plan.items[0]!.confidence).toBeLessThan(0.5);
  });
});
