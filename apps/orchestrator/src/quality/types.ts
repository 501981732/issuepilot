import type {
  PipelineStatus,
  RunReportArtifact,
  RunStatus,
  TaskNodeStatus,
  WorkItemReportStatus,
} from "@issuepilot/shared-contracts";

/**
 * Internal V4.4 source items used by the orchestrator quality aggregator.
 * These are not part of the public wire contract — only `QualitySummaryResponse`
 * (see `@issuepilot/shared-contracts`) is. Keep these types free of HTTP-shape
 * concerns so they stay easy to compute from local stores.
 */
export type QualitySourceItem =
  | QualityRunSourceItem
  | QualityTaskSourceItem;

export interface QualityRunSourceItem {
  kind: "run";
  projectId: string;
  workflow: string;
  taskType: string;
  runId: string;
  runStatus: RunStatus;
  issue: RunReportArtifact["issue"];
  ciStatus?: PipelineStatus;
  checks: RunReportArtifact["checks"];
  reviewFeedback?: RunReportArtifact["reviewFeedback"];
  risks: RunReportArtifact["handoff"]["risks"];
  lastError?: RunReportArtifact["run"]["lastError"];
  totalMs?: number;
  updatedAt: string;
}

export interface QualityTaskSourceItem {
  kind: "task";
  projectId: string;
  workflow: string;
  taskType: string;
  workItemId: string;
  workItemTitle: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskNodeStatus;
  runId?: string;
  reportStatus?: WorkItemReportStatus;
  needsReworkReason?: string;
  /** Reasons drawn from `WorkItemReport.humanReviewChecklist[*].reason`. */
  checklistReasons: string[];
  evidenceCount: number;
  updatedAt: string;
}

export interface QualityCollectionResult {
  items: QualitySourceItem[];
  diagnostics: { invalidReportCount: number };
}
