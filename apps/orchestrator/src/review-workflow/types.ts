import type {
  ReviewerAgentReport,
  ReviewFeedbackSummary,
  ReviewReworkCategory,
  ReviewReworkPlan,
  ReviewReworkPriority,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

export interface ClassifiedSignal {
  category: ReviewReworkCategory;
  priority: ReviewReworkPriority;
  /** 0..1; lower bound `0.4` enters `question` per spec §6.1. */
  confidence: number;
}

export interface BuildReviewReworkPlanInput {
  runId: string;
  issueIid: number;
  projectId?: string;
  workItemId?: string;
  taskId?: string;
  summary?: ReviewFeedbackSummary;
  reviewerReports: ReviewerAgentReport[];
  reportArtifact?: RunReportArtifact;
  now: () => Date;
  randomId: () => string;
}

export type BuiltReviewReworkPlan = ReviewReworkPlan;
