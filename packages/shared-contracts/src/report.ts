import type { PipelineStatus, RunStatus } from "./run.js";

export const RUN_REPORT_VERSION = 1 as const;

export const RISK_LEVEL_VALUES = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVEL_VALUES)[number];

export const MERGE_READINESS_STATUS_VALUES = [
  "ready",
  "not-ready",
  "blocked",
  "unknown",
] as const;
export type MergeReadinessStatus =
  (typeof MERGE_READINESS_STATUS_VALUES)[number];

export const isMergeReadinessStatus = (
  value: unknown,
): value is MergeReadinessStatus =>
  typeof value === "string" &&
  (MERGE_READINESS_STATUS_VALUES as readonly string[]).includes(value);

export interface MergeReadinessReason {
  code: string;
  severity: "info" | "warning" | "blocking";
  message: string;
}

export interface MergeReadinessResult {
  mode: "dry-run";
  status: MergeReadinessStatus;
  reasons: MergeReadinessReason[];
  evaluatedAt: string;
}

export interface ReportEvidence {
  kind:
    | "screenshot"
    | "recording"
    | "playwright"
    | "command_output"
    | "test_result";
  label: string;
  relPath?: string;
  href?: string;
  mediaType?: string;
  capturedAt?: string;
  confidence?: "ai-claim" | "system-derived";
}

export interface RunReportArtifact {
  version: typeof RUN_REPORT_VERSION;
  runId: string;
  issue: {
    projectId: string;
    iid: number;
    title: string;
    url: string;
    labels: string[];
  };
  run: {
    status: RunStatus;
    attempt: number;
    branch: string;
    workspacePath: string;
    startedAt: string;
    endedAt?: string;
    durations: {
      totalMs?: number;
      queueMs?: number;
      workspaceMs?: number;
      agentMs?: number;
      reconcileMs?: number;
      reviewWaitMs?: number;
    };
    lastError?: {
      code: string;
      message: string;
      classification?: "failed" | "blocked" | "cancelled" | "unknown";
    };
  };
  mergeRequest?: {
    iid: number;
    url: string;
    state: "opened" | "merged" | "closed";
    approvals?: {
      required?: number;
      approvedBy: string[];
      satisfied: boolean;
    };
  };
  handoff: {
    summary: string;
    validation: string[];
    risks: Array<{ level: RiskLevel; text: string }>;
    followUps: string[];
    nextAction: string;
  };
  diff: {
    summary: string;
    filesChanged: number;
    additions?: number;
    deletions?: number;
    notableFiles: string[];
  };
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped" | "unknown";
    command?: string;
    durationMs?: number;
    details?: string;
  }>;
  evidence?: ReportEvidence[];
  ci?: {
    status: PipelineStatus;
    pipelineUrl?: string;
    checkedAt: string;
  };
  reviewFeedback?: {
    latestCursor?: string;
    unresolvedCount: number;
    comments: Array<{
      author: string;
      body: string;
      url: string;
      resolved: boolean;
      createdAt: string;
    }>;
  };
  mergeReadiness: MergeReadinessResult;
  notes: {
    handoffNoteId?: number;
    failureNoteId?: number;
    closingNoteId?: number;
  };
}

export interface RunReportSummary {
  runId: string;
  issueIid: number;
  issueTitle: string;
  projectId: string;
  status: RunStatus;
  labels: string[];
  attempt: number;
  branch: string;
  mergeRequestUrl?: string;
  ciStatus?: PipelineStatus;
  mergeReadinessStatus: MergeReadinessStatus;
  highestRisk?: RiskLevel;
  updatedAt: string;
  totalMs?: number;
}

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export function buildRunReportSummary(
  report: RunReportArtifact,
): RunReportSummary {
  const highestRisk = report.handoff.risks
    .map((risk) => risk.level)
    .sort((a, b) => riskRank[b] - riskRank[a])[0];
  return {
    runId: report.runId,
    issueIid: report.issue.iid,
    issueTitle: report.issue.title,
    projectId: report.issue.projectId,
    status: report.run.status,
    labels: [...report.issue.labels],
    attempt: report.run.attempt,
    branch: report.run.branch,
    ...(report.mergeRequest?.url
      ? { mergeRequestUrl: report.mergeRequest.url }
      : {}),
    ...(report.ci?.status ? { ciStatus: report.ci.status } : {}),
    mergeReadinessStatus: report.mergeReadiness.status,
    ...(highestRisk ? { highestRisk } : {}),
    updatedAt: report.run.endedAt ?? report.run.startedAt,
    ...(report.run.durations.totalMs !== undefined
      ? { totalMs: report.run.durations.totalMs }
      : {}),
  };
}
