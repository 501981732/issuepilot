import {
  RUN_REPORT_VERSION,
  type AgentReport,
  type CoderAgentReport,
  type PipelineRun,
  type PipelineRunStatus,
  type RunReportArtifact,
  type RunStatus,
  type TaskNodeStatus,
  type TestEvidenceAgentReport,
  type WorkItem,
} from "@issuepilot/shared-contracts";

const isCoderReport = (report: AgentReport): report is CoderAgentReport =>
  report.role === "coder";

const isTestEvidenceReport = (
  report: AgentReport,
): report is TestEvidenceAgentReport => report.role === "test_evidence";

export function taskStatusFromPipelineStatus(
  status: PipelineRunStatus,
): TaskNodeStatus {
  switch (status) {
    case "awaiting_human_review":
    case "partial":
      return "completed";
    case "awaiting_rework":
      return "needs_rework";
    case "failed":
      return "failed";
    case "cancelled":
      return "needs_rework";
    case "running_coding":
      return "running_coding";
    case "running_reviewer":
      return "running_reviewer";
    case "running_test_evidence":
      return "running_test_evidence";
  }
}

function runStatusFromPipelineStatus(status: PipelineRunStatus): RunStatus {
  switch (status) {
    case "awaiting_human_review":
    case "partial":
      return "completed";
    case "failed":
    case "awaiting_rework":
    case "cancelled":
      return "failed";
    case "running_coding":
    case "running_reviewer":
    case "running_test_evidence":
      return "running";
  }
}

function elapsedMs(startedAt: string, endedAt: string | undefined): number | undefined {
  if (!endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

export function buildPipelineRunReport(input: {
  workItem: WorkItem;
  pipelineRun: PipelineRun;
  finalStatus: PipelineRunStatus;
  reports: AgentReport[];
}): RunReportArtifact {
  const coder = input.reports.find(isCoderReport);
  const testEvidence = input.reports.find(isTestEvidenceReport);
  const firstFailed = input.reports.find((report) => report.status === "failed");
  const endedAt = input.pipelineRun.completedAt ?? input.pipelineRun.updatedAt;
  const totalMs = elapsedMs(input.pipelineRun.createdAt, endedAt);
  const evidenceItems = testEvidence?.testEvidence.evidenceItems ?? [];

  return {
    version: RUN_REPORT_VERSION,
    runId: input.pipelineRun.pipelineRunId,
    issue: {
      projectId: input.workItem.sourceIssue.projectId,
      iid: input.workItem.sourceIssue.iid,
      title: input.workItem.sourceIssue.title,
      url: input.workItem.sourceIssue.url,
      labels: [],
    },
    run: {
      status: runStatusFromPipelineStatus(input.finalStatus),
      attempt: 1,
      // V4.7 review H1:`branch` 在 V4.7 之前永远不会是 `null/undefined`,
      // 现在 adapter 失败 / git 读不到时会落空字符串。改用 `||` 让空串也
      // 走 fallback,避免 dashboard / handoff / review-feedback 链路看到
      // 空 branch。
      branch:
        coder?.coder.branch && coder.coder.branch.length > 0
          ? coder.coder.branch
          : `pipeline:${input.pipelineRun.pipelineRunId}`,
      workspacePath: "",
      startedAt: input.pipelineRun.createdAt,
      ...(endedAt ? { endedAt } : {}),
      durations: {
        ...(totalMs !== undefined ? { totalMs } : {}),
      },
      ...(firstFailed?.lastError
        ? {
            lastError: {
              code: firstFailed.lastError.code,
              message: firstFailed.lastError.message,
              classification: "failed",
            },
          }
        : {}),
    },
    ...(coder?.coder.mergeRequest
      ? {
          mergeRequest: {
            iid: coder.coder.mergeRequest.iid,
            url: coder.coder.mergeRequest.url,
            state: coder.coder.mergeRequest.state,
          },
        }
      : {}),
    handoff: {
      summary: coder?.coder.diffSummary || "V4.6 pipeline completed.",
      validation:
        evidenceItems.length === 0
          ? []
          : evidenceItems.map(
              (item) => `${item.kind}:${item.target} ${item.status}`,
            ),
      risks: [],
      followUps:
        input.finalStatus === "partial"
          ? ["Review partial test evidence before merging."]
          : [],
      nextAction: "Review the linked MR and V4.6 AgentReports.",
    },
    diff: {
      // V4.7 review H2:同 branch,改用 `||` 让空字符串也走 fallback。
      summary:
        coder?.coder.diffSummary && coder.coder.diffSummary.length > 0
          ? coder.coder.diffSummary
          : "not available",
      filesChanged: 0,
      notableFiles: [],
    },
    checks: evidenceItems.map((item) => ({
      name: `${item.kind}:${item.target}`,
      status:
        item.status === "collected"
          ? "passed"
          : item.status === "failed"
            ? "failed"
            : "skipped",
      ...(item.artifactPath ? { details: item.artifactPath } : {}),
    })),
    mergeReadiness: {
      mode: "dry-run",
      status: input.finalStatus === "awaiting_human_review" ? "ready" : "unknown",
      reasons: [],
      evaluatedAt: endedAt ?? input.pipelineRun.updatedAt,
    },
    notes: {},
  };
}
