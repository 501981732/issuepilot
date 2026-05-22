import { describe, expect, it } from "vitest";

import {
  MERGE_READINESS_STATUS_VALUES,
  RUN_REPORT_VERSION,
  buildRunReportSummary,
  isMergeReadinessStatus,
  type ReportEvidence,
  type RunReportArtifact,
} from "../report.js";

const baseReport: RunReportArtifact = {
  version: RUN_REPORT_VERSION,
  runId: "run-1",
  issue: {
    projectId: "group/project",
    iid: 42,
    title: "Fix checkout",
    url: "https://gitlab.example.com/group/project/-/issues/42",
    labels: ["human-review"],
  },
  run: {
    status: "completed",
    attempt: 1,
    branch: "ai/42-fix-checkout",
    workspacePath: "/tmp/ws",
    startedAt: "2026-05-16T00:00:00.000Z",
    endedAt: "2026-05-16T00:05:00.000Z",
    durations: { totalMs: 300000, agentMs: 180000 },
  },
  mergeRequest: {
    iid: 7,
    url: "https://gitlab.example.com/group/project/-/merge_requests/7",
    state: "opened",
  },
  handoff: {
    summary: "Updated checkout copy.",
    validation: ["pnpm --filter @issuepilot/dashboard test passed"],
    risks: [{ level: "low", text: "Copy-only change." }],
    followUps: [],
    nextAction: "Review and merge the MR.",
  },
  diff: {
    summary: "1 file changed",
    filesChanged: 1,
    additions: 4,
    deletions: 1,
    notableFiles: ["apps/dashboard/app/page.tsx"],
  },
  checks: [
    {
      name: "dashboard tests",
      status: "passed",
      command: "pnpm --filter @issuepilot/dashboard test",
      durationMs: 12000,
    },
  ],
  mergeReadiness: {
    mode: "dry-run",
    status: "ready",
    reasons: [
      {
        code: "all_checks_satisfied",
        severity: "info",
        message: "CI, approvals, review feedback and risk checks passed.",
      },
    ],
    evaluatedAt: "2026-05-16T00:06:00.000Z",
  },
  notes: { handoffNoteId: 100 },
};

describe("report contracts", () => {
  it("exports the fixed report version", () => {
    expect(RUN_REPORT_VERSION).toBe(1);
  });

  it("recognises merge readiness statuses", () => {
    expect(MERGE_READINESS_STATUS_VALUES).toEqual([
      "ready",
      "not-ready",
      "blocked",
      "unknown",
    ]);
    expect(isMergeReadinessStatus("ready")).toBe(true);
    expect(isMergeReadinessStatus("enabled")).toBe(false);
  });

  it("builds a stable list summary from a full report", () => {
    expect(buildRunReportSummary(baseReport)).toEqual({
      runId: "run-1",
      issueIid: 42,
      issueTitle: "Fix checkout",
      projectId: "group/project",
      status: "completed",
      labels: ["human-review"],
      attempt: 1,
      branch: "ai/42-fix-checkout",
      mergeRequestUrl:
        "https://gitlab.example.com/group/project/-/merge_requests/7",
      ciStatus: undefined,
      mergeReadinessStatus: "ready",
      highestRisk: "low",
      updatedAt: "2026-05-16T00:05:00.000Z",
      totalMs: 300000,
    });
  });

  it("V4.9: RunReportArtifact accepts an optional reviewReworkPlan", () => {
    const artifact: RunReportArtifact = {
      ...baseReport,
      reviewReworkPlan: {
        planId: "plan-1",
        runId: "run-1",
        issueIid: 1,
        status: "accepted",
        generatedAt: "2026-05-21T00:00:00.000Z",
        items: [],
      },
    };
    expect(artifact.reviewReworkPlan?.planId).toBe("plan-1");
    expect(JSON.parse(JSON.stringify(artifact)).reviewReworkPlan?.status).toBe(
      "accepted",
    );
  });

  it("allows run reports to declare V4.3 evidence references", () => {
    const evidence: ReportEvidence = {
      kind: "command_output",
      label: "Shared contracts vitest output",
      relPath: "commands/shared-contracts.log",
      mediaType: "text/plain",
      capturedAt: "2026-05-17T08:00:00.000Z",
      confidence: "system-derived",
    };
    const report: RunReportArtifact = {
      ...baseReport,
      evidence: [evidence],
    };
    expect(report.evidence?.[0]).toMatchObject({
      kind: "command_output",
      relPath: "commands/shared-contracts.log",
    });
  });
});
