import { describe, it, expect, expectTypeOf } from "vitest";

import {
  REVIEWER_DECISION_VALUES,
  FINDING_SEVERITY_VALUES,
  INLINE_COMMENT_SEVERITY_VALUES,
  MR_PUBLICATION_STATUS_VALUES,
  ReviewerSummaryTooLongError,
  assertReviewerSummaryLength,
  isMrPublicationRevocable,
  isReviewerDecision,
  type MrPublication,
  type ReviewerFinding,
  type ReviewerInlineComment,
  type ReviewComment,
  type ReviewFeedbackSummary,
} from "../review.js";

describe("@issuepilot/shared-contracts/review", () => {
  it("ReviewComment requires the structured note fields used by the prompt injector", () => {
    expectTypeOf<ReviewComment>().toHaveProperty("noteId").toEqualTypeOf<number>();
    expectTypeOf<ReviewComment>().toHaveProperty("author").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>().toHaveProperty("body").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>().toHaveProperty("url").toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("createdAt")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("resolved")
      .toEqualTypeOf<boolean>();
    expectTypeOf<ReviewComment>()
      .toHaveProperty("discussionId")
      .toEqualTypeOf<string | undefined>();
  });

  it("ReviewFeedbackSummary tracks the MR context, ISO cursor and the comment list", () => {
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("mrIid")
      .toEqualTypeOf<number>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("mrUrl")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("generatedAt")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("cursor")
      .toEqualTypeOf<string>();
    expectTypeOf<ReviewFeedbackSummary>()
      .toHaveProperty("comments")
      .toEqualTypeOf<ReviewComment[]>();
  });

  it("ReviewFeedbackSummary literal compiles with no comments and an ISO cursor", () => {
    const summary: ReviewFeedbackSummary = {
      mrIid: 42,
      mrUrl: "https://gitlab.example.com/group/web/-/merge_requests/42",
      generatedAt: "2026-05-16T00:00:00.000Z",
      cursor: "2026-05-16T00:00:00.000Z",
      comments: [],
    };

    expect(summary.comments).toEqual([]);
  });

  it("ReviewFeedbackSummary carries hand-curated reviewer comments", () => {
    const comment: ReviewComment = {
      noteId: 1001,
      author: "alice",
      body: "Please remove the debug log before merging.",
      url: "https://gitlab.example.com/group/web/-/merge_requests/42#note_1001",
      createdAt: "2026-05-16T00:01:00.000Z",
      discussionId: "disc-1",
      resolved: false,
    };

    const summary: ReviewFeedbackSummary = {
      mrIid: 42,
      mrUrl: "https://gitlab.example.com/group/web/-/merge_requests/42",
      generatedAt: "2026-05-16T00:01:00.000Z",
      cursor: "2026-05-16T00:01:00.000Z",
      comments: [comment],
    };

    expect(summary.comments).toHaveLength(1);
    expect(summary.comments[0]?.author).toBe("alice");
    expect(summary.comments[0]?.resolved).toBe(false);
  });

  it("REVIEWER_DECISION_VALUES 严格三态", () => {
    expect([...REVIEWER_DECISION_VALUES]).toEqual([
      "approve_with_comments",
      "request_changes",
      "cannot_review",
    ]);
    expect(isReviewerDecision("approve_with_comments")).toBe(true);
    expect(isReviewerDecision("approved")).toBe(false);
  });

  it("FINDING_SEVERITY_VALUES vs INLINE_COMMENT_SEVERITY_VALUES", () => {
    expect([...FINDING_SEVERITY_VALUES]).toEqual([
      "low",
      "medium",
      "high",
      "critical",
    ]);
    // spec §11：low 永不进 inline，只进主 note
    expect([...INLINE_COMMENT_SEVERITY_VALUES]).toEqual([
      "medium",
      "high",
      "critical",
    ]);
  });

  it("ReviewerFinding 可省 locationHint.lineRange", () => {
    const finding: ReviewerFinding = {
      severity: "high",
      category: "security",
      message: "Token logged at debug level",
      locationHint: { filePath: "src/auth.ts" },
    };
    expect(JSON.parse(JSON.stringify(finding))).toEqual(finding);
  });

  it("ReviewerInlineComment 必填 file+lineRange", () => {
    const ic: ReviewerInlineComment = {
      filePath: "src/auth.ts",
      lineRange: { start: 10, end: 12 },
      severity: "critical",
      category: "security",
      message: "Avoid logging tokens",
      suggestedFix: "Use logger.debug masking",
    };
    expect(JSON.parse(JSON.stringify(ic))).toEqual(ic);
  });

  it("MR_PUBLICATION_STATUS_VALUES 五项 + revocable 仅 published", () => {
    expect(new Set(MR_PUBLICATION_STATUS_VALUES)).toEqual(
      new Set([
        "pending",
        "published",
        "publish_failed",
        "skipped_by_config",
        "revoked",
      ]),
    );
    expect(isMrPublicationRevocable("published")).toBe(true);
    expect(isMrPublicationRevocable("pending")).toBe(false);
    expect(isMrPublicationRevocable("publish_failed")).toBe(false);
    expect(isMrPublicationRevocable("skipped_by_config")).toBe(false);
    expect(isMrPublicationRevocable("revoked")).toBe(false);
  });

  it("MrPublication 持有 noteIds 与可选 publishedAt", () => {
    const pub: MrPublication = {
      status: "published",
      noteIds: ["12345", "12346"],
      publishedAt: "2026-05-19T00:00:10.000Z",
    };
    expect(JSON.parse(JSON.stringify(pub))).toEqual(pub);
  });

  it("assertReviewerSummaryLength 在 4000 字符上限处抛 ReviewerSummaryTooLongError", () => {
    const ok = "x".repeat(4000);
    expect(() => assertReviewerSummaryLength(ok)).not.toThrow();
    const tooLong = "x".repeat(4001);
    expect(() => assertReviewerSummaryLength(tooLong)).toThrow(
      ReviewerSummaryTooLongError,
    );
  });
});
