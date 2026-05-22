import { describe, expect, it } from "vitest";

import {
  isReviewReworkCategory,
  isReviewReworkItem,
  isReviewReworkItemStatus,
  isReviewReworkPlan,
  isReviewReworkPlanStatus,
  isReviewReworkPriority,
  isReviewReworkSourceKind,
  isReviewReworkSummary,
  REVIEW_REWORK_CATEGORY_VALUES,
  REVIEW_REWORK_ITEM_STATUS_VALUES,
  REVIEW_REWORK_PLAN_STATUS_VALUES,
  REVIEW_REWORK_PRIORITY_VALUES,
  REVIEW_REWORK_SOURCE_KIND_VALUES,
  type ReviewReworkItem,
  type ReviewReworkPlan,
} from "../review-rework.js";

describe("V4.9 ReviewReworkPlan contract", () => {
  it("freezes plan / item / category / priority / source kind enums", () => {
    expect([...REVIEW_REWORK_PLAN_STATUS_VALUES]).toEqual([
      "draft",
      "accepted",
      "dismissed",
      "resolved",
      "superseded",
    ]);
    expect([...REVIEW_REWORK_ITEM_STATUS_VALUES]).toEqual([
      "open",
      "accepted",
      "dismissed",
      "resolved",
    ]);
    expect([...REVIEW_REWORK_CATEGORY_VALUES]).toEqual([
      "correctness",
      "test_gap",
      "ci_failure",
      "missing_evidence",
      "security",
      "maintainability",
      "docs",
      "scope_clarification",
      "style",
      "question",
    ]);
    expect([...REVIEW_REWORK_PRIORITY_VALUES]).toEqual([
      "low",
      "medium",
      "high",
      "blocking",
    ]);
    expect([...REVIEW_REWORK_SOURCE_KIND_VALUES]).toEqual([
      "human_review_comment",
      "ai_reviewer_finding",
      "ci_feedback",
      "evidence_gap",
      "operator_note",
    ]);
  });

  it("guards detect known values and reject unknown", () => {
    expect(isReviewReworkPlanStatus("accepted")).toBe(true);
    expect(isReviewReworkPlanStatus("merged")).toBe(false);
    expect(isReviewReworkItemStatus("open")).toBe(true);
    expect(isReviewReworkCategory("security")).toBe(true);
    expect(isReviewReworkCategory("typo")).toBe(false);
    expect(isReviewReworkPriority("blocking")).toBe(true);
    expect(isReviewReworkSourceKind("ai_reviewer_finding")).toBe(true);
  });

  it("isReviewReworkItem accepts a fully populated item", () => {
    const item: ReviewReworkItem = {
      itemId: "item-1",
      status: "open",
      category: "correctness",
      priority: "blocking",
      title: "Fix null handling in foo.ts",
      summary: "reviewer flagged null branch missing",
      targetFiles: ["packages/foo/src/foo.ts"],
      taskId: "task-1",
      suggestedValidation: ["pnpm --filter @issuepilot/foo test"],
      sourceRefs: [
        {
          kind: "human_review_comment",
          id: "note-42",
          url: "https://gitlab.example.com/p/-/merge_requests/1#note_42",
          author: "alice",
          createdAt: "2026-05-21T00:00:00.000Z",
        },
      ],
      confidence: 0.92,
    };
    expect(isReviewReworkItem(item)).toBe(true);
  });

  it("isReviewReworkPlan rejects plans whose items[] entries are invalid", () => {
    const plan: ReviewReworkPlan = {
      planId: "plan-1",
      runId: "run-1",
      issueIid: 1,
      status: "draft",
      generatedAt: "2026-05-21T00:00:00.000Z",
      items: [],
    };
    expect(isReviewReworkPlan(plan)).toBe(true);

    const bad = { ...plan, items: [{ itemId: 42 }] };
    expect(isReviewReworkPlan(bad)).toBe(false);
  });

  it("round-trips through JSON without losing literal status", () => {
    const plan: ReviewReworkPlan = {
      planId: "plan-2",
      runId: "run-2",
      issueIid: 7,
      projectId: "p1",
      workItemId: "wi-2",
      taskId: "task-2",
      status: "accepted",
      generatedAt: "2026-05-21T01:00:00.000Z",
      acceptedAt: "2026-05-21T01:05:00.000Z",
      supersedesPlanId: "plan-1",
      sourceSummaryId: "summary-1",
      items: [
        {
          itemId: "item-1",
          status: "accepted",
          category: "test_gap",
          priority: "high",
          title: "Add e2e coverage",
          summary: "human reviewer asked for e2e",
          targetFiles: [],
          suggestedValidation: [],
          sourceRefs: [
            {
              kind: "ai_reviewer_finding",
              id: "finding-1",
              runnerKind: "claude_code",
            },
          ],
          confidence: 0.6,
        },
      ],
    };
    const round = JSON.parse(JSON.stringify(plan));
    expect(isReviewReworkPlan(round)).toBe(true);
    expect(round.items[0].sourceRefs[0].runnerKind).toBe("claude_code");
  });

  it("isReviewReworkSummary accepts a well-formed summary", () => {
    expect(
      isReviewReworkSummary({
        blockingCount: 1,
        acceptedCount: 2,
        resolvedCount: 0,
        perTask: { "task-1": { blocking: 1, accepted: 2, resolved: 0 } },
        latestPlanIds: ["plan-1"],
      }),
    ).toBe(true);
    expect(isReviewReworkSummary({ blockingCount: 1 })).toBe(false);
  });
});
