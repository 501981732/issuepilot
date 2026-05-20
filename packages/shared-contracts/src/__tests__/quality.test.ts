import { describe, it, expect } from "vitest";

import {
  FAILURE_PATTERN_ID_VALUES,
  QUALITY_METRIC_ID_VALUES,
  QUALITY_STATUS_FILTER_VALUES,
  isFailurePatternId,
  isQualityMetricId,
  isQualityStatusFilter,
  type QualitySummaryResponse,
} from "../quality.js";

describe("quality analytics contracts", () => {
  it("enumerates metric ids", () => {
    expect(new Set(QUALITY_METRIC_ID_VALUES)).toEqual(
      new Set([
        "success-rate",
        "failure-rate",
        "rework-rate",
        "ci-pass-rate",
        "review-hit-rate",
        "missing-evidence-rate",
        "median-duration",
      ]),
    );
    expect(isQualityMetricId("success-rate")).toBe(true);
    expect(isQualityMetricId("cancelled")).toBe(false);
  });

  it("enumerates normalized status filters", () => {
    expect(new Set(QUALITY_STATUS_FILTER_VALUES)).toEqual(
      new Set([
        "run-completed",
        "run-failed",
        "run-blocked",
        "task-needs-rework",
        "task-skipped",
        "report-incomplete",
      ]),
    );
    expect(isQualityStatusFilter("run-failed")).toBe(true);
    expect(isQualityStatusFilter("failed")).toBe(false);
  });

  it("round-trips the summary response", () => {
    const response: QualitySummaryResponse = {
      scope: { mode: "team-project", projectId: "proj-a" },
      filters: {
        from: "2026-05-12T00:00:00.000Z",
        to: "2026-05-18T23:59:59.999Z",
        window: "7d",
        status: "run-failed",
        pattern: "permission-issue",
      },
      metrics: [],
      trends: [],
      failurePatterns: [],
      drilldown: [],
      dimensions: [],
      diagnostics: { invalidReportCount: 0 },
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it("enumerates failure pattern ids (V4.4 + V4.6 增量)", () => {
    expect(new Set(FAILURE_PATTERN_ID_VALUES)).toEqual(
      new Set([
        "missing-tests",
        "unclear-requirements",
        "permission-issue",
        "environment-issue",
        "review-rework",
        "ci-failure",
        "missing-evidence",
        "reviewer_unavailable",
        "reviewer_requested_changes",
        "reviewer_cannot_review",
        "evidence_unavailable",
        "evidence_partial",
        "pipeline_cancelled",
        "pipeline_init_failed",
        "role_profile_invalid",
        "runner_unavailable",
        "coding_failed",
        "sandbox_violation",
        "redaction_failed",
        "storage_full",
      ]),
    );
    expect(isFailurePatternId("permission-issue")).toBe(true);
    expect(isFailurePatternId("reviewer_cannot_review")).toBe(true);
    expect(isFailurePatternId("sandbox_violation")).toBe(true);
    expect(isFailurePatternId("unknown")).toBe(false);
  });

  it("optionally carries V4.6 byRole slice", () => {
    const response: QualitySummaryResponse = {
      scope: { mode: "single-project" },
      filters: {
        from: "2026-05-12T00:00:00.000Z",
        to: "2026-05-19T23:59:59.999Z",
        window: "7d",
      },
      metrics: [],
      trends: [],
      failurePatterns: [],
      drilldown: [],
      dimensions: [],
      diagnostics: { invalidReportCount: 0 },
      byRole: {
        coderSuccessRate: 80,
        reviewerApproveRate: 60,
        reviewerCannotReviewRate: 20,
        reviewerUnavailableRate: 0,
        testEvidenceCompleteRate: 100,
        testEvidencePartialRate: 0,
        counts: {
          coderComplete: 8,
          coderFailed: 1,
          coderCancelled: 1,
          reviewerApprove: 6,
          reviewerRequestChanges: 2,
          reviewerCannotReview: 2,
          reviewerUnavailable: 0,
          testEvidenceComplete: 10,
          testEvidencePartial: 0,
          testEvidenceUnavailable: 0,
        },
      },
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });
});
