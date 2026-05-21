import { describe, expect, it } from "vitest";

import type {
  QualityMetricId,
  QualitySummaryFilters,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

import { buildByRoleSlice, buildQualitySummary } from "../aggregate.js";
import type { QualitySourceItem } from "../types.js";
import type {
  AgentReport,
  CoderAgentReport,
  ReviewerAgentReport,
  TestEvidenceAgentReport,
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
    checks: [{ name: "unit", status: "passed" }],
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

const baseFilters: QualitySummaryFilters = {
  from: "2026-05-11T00:00:00.000Z",
  to: "2026-05-18T23:59:59.999Z",
  window: "7d",
};

function metric(result: QualitySummaryResponse, id: QualityMetricId) {
  return result.metrics.find((m) => m.id === id);
}

describe("buildQualitySummary", () => {
  it("computes core quality metrics", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ok", runStatus: "completed", ciStatus: "success" }),
        runSource({ runId: "fail", runStatus: "failed", ciStatus: "failed" }),
        runSource({ runId: "blocked", runStatus: "blocked" }),
        taskSource({ taskId: "t1", taskStatus: "needs_rework" }),
        taskSource({
          taskId: "t2",
          taskStatus: "completed",
          checklistReasons: ["missing-evidence"],
          evidenceCount: 0,
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    expect(metric(result, "success-rate")).toMatchObject({
      numerator: 1,
      denominator: 3,
      value: 33,
    });
    expect(metric(result, "failure-rate")).toMatchObject({
      numerator: 2,
      denominator: 3,
      value: 67,
    });
    expect(metric(result, "ci-pass-rate")).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 50,
      unknownCount: 1,
    });
    expect(metric(result, "rework-rate")?.numerator).toBe(1);
    expect(metric(result, "missing-evidence-rate")?.numerator).toBeGreaterThan(
      0,
    );
  });

  it("returns stable empty response when no items", () => {
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    expect(result.metrics.length).toBeGreaterThan(0);
    for (const m of result.metrics) {
      expect(m.direction).toBe("unknown");
      expect(m.value).toBe(0);
    }
    expect(result.trends).toEqual([]);
    expect(result.failurePatterns).toEqual([]);
    expect(result.drilldown).toEqual([]);
  });

  it("produces drilldown targets for run, work item, and evidence", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "run-1", runStatus: "failed", ciStatus: "failed" }),
        taskSource({
          taskId: "t-evi",
          workItemId: "wi-2",
          evidenceCount: 0,
          checklistReasons: ["missing-evidence"],
        }),
        taskSource({
          taskId: "t-rework",
          workItemId: "wi-3",
          taskStatus: "needs_rework",
          needsReworkReason: "review failed",
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    const targets = result.drilldown.map((d) => d.target);
    const kinds = new Set(targets.map((t) => t.kind));
    expect(kinds.has("run")).toBe(true);
    expect(kinds.has("evidence")).toBe(true);
    expect(kinds.has("work-item")).toBe(true);

    const run = result.drilldown.find((d) => d.target.kind === "run");
    expect(run?.target.kind === "run" && run.target.href).toBe("/runs/run-1");
    const evi = result.drilldown.find((d) => d.target.kind === "evidence");
    expect(evi?.target.kind === "evidence" && evi.target.href).toBe(
      "/work-items/wi-2?view=evidence",
    );
  });

  it("sorts failure patterns by count desc then id asc", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "a", runStatus: "failed", ciStatus: "failed" }),
        runSource({ runId: "b", runStatus: "failed", ciStatus: "failed" }),
        runSource({
          runId: "c",
          runStatus: "failed",
          lastError: { code: "auth", message: "401 unauthorized" },
        }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const ids = result.failurePatterns.map((p) => p.patternId);
    expect(ids[0]).toBe("ci-failure");
  });

  it("includes dimensions for workflow, task-type, status, pattern", () => {
    const result = buildQualitySummary({
      items: [runSource({ runId: "a", runStatus: "completed" })],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const kinds = new Set(result.dimensions.map((d) => d.kind));
    expect(kinds.has("workflow")).toBe(true);
    expect(kinds.has("status")).toBe(true);
  });

  it("applies status filter to drill-down", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ok", runStatus: "completed" }),
        runSource({ runId: "fail", runStatus: "failed", ciStatus: "failed" }),
      ],
      filters: { ...baseFilters, status: "run-failed" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    expect(result.drilldown.map((d) => d.itemId)).toEqual(["run:fail"]);
  });

  it("applies the active filters to previous-window deltas", () => {
    const result = buildQualitySummary({
      items: [
        runSource({
          runId: "current",
          workflow: "workflow-a",
          runStatus: "completed",
          updatedAt: "2026-05-18T00:00:00.000Z",
        }),
        runSource({
          runId: "previous-same-workflow",
          workflow: "workflow-a",
          runStatus: "failed",
          updatedAt: "2026-05-10T00:00:00.000Z",
        }),
        runSource({
          runId: "previous-other-workflow",
          workflow: "workflow-b",
          runStatus: "completed",
          updatedAt: "2026-05-10T00:00:00.000Z",
        }),
      ],
      filters: { ...baseFilters, workflow: "workflow-a" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });

    expect(metric(result, "success-rate")).toMatchObject({
      value: 100,
      previousValue: 0,
      delta: 100,
    });
  });

  it("filters by pattern when provided", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "ci", runStatus: "failed", ciStatus: "failed" }),
        runSource({
          runId: "perm",
          runStatus: "failed",
          lastError: { code: "perm", message: "403 access denied" },
        }),
      ],
      filters: { ...baseFilters, pattern: "permission-issue" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    expect(result.drilldown.map((d) => d.itemId)).toEqual(["run:perm"]);
  });

  it("uses duration-ms unit for median-duration", () => {
    const result = buildQualitySummary({
      items: [
        runSource({ runId: "a", runStatus: "completed", totalMs: 1000 }),
        runSource({ runId: "b", runStatus: "completed", totalMs: 3000 }),
      ],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
    });
    const m = metric(result, "median-duration");
    expect(m?.unit).toBe("duration-ms");
    expect(m?.value).toBe(2000);
  });

  it("propagates diagnostics", () => {
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 3 },
    });
    expect(result.diagnostics.invalidReportCount).toBe(3);
  });

  it("V4.6 byRole slice: 5 reviewer reports (3 approve / 1 request_changes / 1 cannot_review)", () => {
    const reviewerBase: ReviewerAgentReport = {
      agentReportId: "r-base",
      pipelineRunId: "p-1",
      taskId: "t-1",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      runnerId: "codex_app_server",
      runnerKind: "codex_app_server",
      runnerRunId: null,
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
    };
    const make = (
      id: string,
      decision: "approve_with_comments" | "request_changes" | "cannot_review",
    ): ReviewerAgentReport => ({
      ...reviewerBase,
      agentReportId: id,
      reviewer: { ...reviewerBase.reviewer, decision },
    });
    const reports: AgentReport[] = [
      make("r1", "approve_with_comments"),
      make("r2", "approve_with_comments"),
      make("r3", "approve_with_comments"),
      make("r4", "request_changes"),
      make("r5", "cannot_review"),
    ];
    const slice = buildByRoleSlice(reports);
    expect(slice.reviewerApproveRate).toBe(60);
    expect(slice.reviewerCannotReviewRate).toBe(20);
    expect(slice.reviewerUnavailableRate).toBe(0);
    expect(slice.counts?.reviewerApprove).toBe(3);
    expect(slice.counts?.reviewerRequestChanges).toBe(1);
    expect(slice.counts?.reviewerCannotReview).toBe(1);
    expect(slice.coderSuccessRate).toBeUndefined();
    expect(slice.testEvidenceCompleteRate).toBeUndefined();
  });

  it("V4.6 byRole slice: coder + test_evidence mixed", () => {
    const coder = (
      id: string,
      status: CoderAgentReport["status"],
    ): CoderAgentReport =>
      ({
        agentReportId: id,
        pipelineRunId: "p-1",
        taskId: "t-1",
        role: "coder",
        roleProfileId: "coder@v1",
        runnerId: "codex_app_server",
        runnerKind: "codex_app_server",
        runnerRunId: null,
        status,
        startedAt: "2026-05-19T00:00:00.000Z",
        completedAt: "2026-05-19T00:00:10.000Z",
        evidenceLinks: [],
        redactedFields: [],
        coder: { summary: "ok" },
      }) as unknown as CoderAgentReport;
    const te = (
      id: string,
      status: TestEvidenceAgentReport["status"],
    ): TestEvidenceAgentReport =>
      ({
        agentReportId: id,
        pipelineRunId: "p-1",
        taskId: "t-1",
        role: "test_evidence",
        roleProfileId: "test_evidence@v1",
        runnerId: "codex_app_server",
        runnerKind: "codex_app_server",
        runnerRunId: null,
        status,
        startedAt: "2026-05-19T00:00:00.000Z",
        completedAt: "2026-05-19T00:00:10.000Z",
        evidenceLinks: [],
        redactedFields: [],
        testEvidence: { evidenceItems: [], baselineEvidence: null },
      }) as TestEvidenceAgentReport;
    const reports: AgentReport[] = [
      coder("c1", "complete"),
      coder("c2", "complete"),
      coder("c3", "failed"),
      te("t1", "complete"),
      te("t2", "incomplete"),
    ];
    const slice = buildByRoleSlice(reports);
    expect(slice.coderSuccessRate).toBe(67);
    expect(slice.testEvidenceCompleteRate).toBe(50);
    expect(slice.testEvidencePartialRate).toBe(50);
  });

  it("V4.6 buildQualitySummary echoes byRole when agentReports is provided", () => {
    const reviewer: ReviewerAgentReport = {
      agentReportId: "r1",
      pipelineRunId: "p-1",
      taskId: "t-1",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      runnerId: "codex_app_server",
      runnerKind: "codex_app_server",
      runnerRunId: null,
      status: "complete",
      startedAt: "2026-05-19T00:00:00.000Z",
      completedAt: "2026-05-19T00:00:10.000Z",
      evidenceLinks: [],
      redactedFields: [],
      reviewer: {
        summary: "ok",
        decision: "approve_with_comments",
        confidence: 0.9,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
        mrPublication: { status: "skipped_by_config", noteIds: [] },
      },
    };
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
      agentReports: [reviewer],
    });
    expect(result.byRole?.reviewerApproveRate).toBe(100);
  });

  it("V4.6 AgentReport failures enter failurePatterns and drilldown", () => {
    const failedReviewer: ReviewerAgentReport = {
      agentReportId: "ar-scope",
      workItemId: "wi-review",
      pipelineRunId: "pr-1",
      taskId: "t-review",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      runnerId: "codex_app_server",
      runnerKind: "codex_app_server",
      runnerRunId: null,
      status: "failed",
      startedAt: "2026-05-18T12:00:00.000Z",
      completedAt: "2026-05-18T12:00:05.000Z",
      evidenceLinks: [],
      redactedFields: [],
      lastError: {
        code: "scope_insufficient",
        message: "GitLab token needs api scope",
      },
      reviewer: {
        summary: "cannot publish",
        decision: "cannot_review",
        confidence: 0,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
        mrPublication: {
          status: "publish_failed",
          noteIds: [],
          lastError: {
            code: "scope_insufficient",
            message: "GitLab token needs api scope",
          },
        },
      },
    };
    const result = buildQualitySummary({
      items: [],
      filters: baseFilters,
      scope: { mode: "team-project", projectId: "proj-a" },
      diagnostics: { invalidReportCount: 0 },
      agentReports: [failedReviewer],
    });
    expect(result.failurePatterns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          patternId: "reviewer_cannot_review",
          count: 1,
          topProject: "proj-a",
        }),
      ]),
    );
    expect(result.drilldown).toEqual([
      expect.objectContaining({
        itemId: "agent-report:ar-scope",
        patternIds: ["reviewer_cannot_review"],
        projectId: "proj-a",
        taskType: "reviewer",
        agentReport: {
          agentReportId: "ar-scope",
          role: "reviewer",
          status: "failed",
        },
        target: {
          kind: "agent-report",
          href: "/work-items/wi-review?agentReport=ar-scope",
        },
      }),
    ]);
  });

  it("V4.6 AgentReport failures remain visible under failure status filters", () => {
    const failedReviewer: ReviewerAgentReport = {
      agentReportId: "ar-status-filter",
      workItemId: "wi-review",
      pipelineRunId: "pr-1",
      taskId: "t-review",
      role: "reviewer",
      roleProfileId: "reviewer@v1",
      runnerId: "codex_app_server",
      runnerKind: "codex_app_server",
      runnerRunId: null,
      status: "failed",
      startedAt: "2026-05-18T12:00:00.000Z",
      completedAt: "2026-05-18T12:00:05.000Z",
      evidenceLinks: [],
      redactedFields: [],
      lastError: {
        code: "scope_insufficient",
        message: "GitLab token needs api scope",
      },
      reviewer: {
        summary: "cannot publish",
        decision: "cannot_review",
        confidence: 0,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
        mrPublication: { status: "publish_failed", noteIds: [] },
      },
    };
    const result = buildQualitySummary({
      items: [],
      filters: { ...baseFilters, status: "run-failed" },
      scope: { mode: "single-project" },
      diagnostics: { invalidReportCount: 0 },
      agentReports: [failedReviewer],
    });

    expect(result.drilldown.map((d) => d.itemId)).toEqual([
      "agent-report:ar-status-filter",
    ]);
  });
});
