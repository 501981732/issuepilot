import { type IssueRef } from "./issue.js";
import { type ReviewFeedbackSummary } from "./review.js";

/**
 * Lifecycle states reported by the orchestrator for an in-flight or finished
 * run. The state machine lives in `apps/orchestrator`; this is purely the
 * vocabulary shared with consumers (dashboard, tests).
 */
export const RUN_STATUS_VALUES = [
  "claimed",
  "running",
  "retrying",
  "stopping",
  "completed",
  "failed",
  "blocked",
] as const;

export type RunStatus = (typeof RUN_STATUS_VALUES)[number];

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === "string" &&
  (RUN_STATUS_VALUES as readonly string[]).includes(value);

/**
 * Recorded shape of a single orchestrator attempt on an issue.
 *
 * `attempt` starts at 1; retries increment it. `lastError.code` is a stable
 * machine-readable identifier (see Phase 6 classifier) — UIs should display
 * `message` and route on `code`.
 */
export interface RunRecord {
  runId: string;
  issue: IssueRef;
  status: RunStatus;
  attempt: number;
  branch: string;
  workspacePath: string;
  /** Set after Phase 6 reconciliation creates or links the MR. */
  mergeRequestUrl?: string;
  /** ISO-8601 timestamp captured the moment the orchestrator claimed it. */
  startedAt: string;
  /** ISO-8601 timestamp refreshed on every status transition. */
  updatedAt: string;
  /** ISO-8601 timestamp set when the run leaves the active state machine. */
  endedAt?: string;
  /** Count of Codex turn events known to the dashboard snapshot. */
  turnCount?: number;
  /** Most recent event summary known to the dashboard snapshot. */
  lastEvent?: {
    type: string;
    message: string;
    createdAt?: string;
  };
  lastError?: {
    code: string;
    message: string;
  };
  /** V2 team mode: stable project id from `issuepilot.team.yaml`. */
  projectId?: string;
  /** V2 team mode: human-readable project name shown on the dashboard. */
  projectName?: string;
  /**
   * ISO-8601 timestamp set when an operator archives this run via the
   * dashboard. Archived runs are excluded from `/api/runs` by default; pass
   * `?includeArchived=true` to include them.
   */
  archivedAt?: string;
  /**
   * Latest CI pipeline classification observed by the human-review
   * scanner (V2 Phase 3). Maps to {@link PIPELINE_STATUS_VALUES}; absent
   * means no CI status was ever recorded (CI feedback disabled or run
   * never reached `human-review`).
   */
  latestCiStatus?: PipelineStatus;
  /**
   * ISO-8601 timestamp captured at the last CI poll for this run.
   * Always set together with {@link RunRecord.latestCiStatus}.
   */
  latestCiCheckedAt?: string;
  /**
   * V2 Phase 4: ISO-8601 timestamp of the most recent MR note already
   * fed back to the agent. The review sweep skips any note with
   * `createdAt <= lastDiscussionCursor`, which guarantees a single
   * reviewer comment is never re-injected into successive prompts.
   *
   * Absent means no sweep has ever run for this run; the sweep should
   * still emit `review_feedback_summary_generated` even when the result
   * is empty so observers see liveness.
   */
  lastDiscussionCursor?: string;
  /**
   * V2 Phase 4: latest summary produced by `sweepReviewFeedbackOnce`.
   * Surfaced on the dashboard and injected into the next-attempt prompt
   * context. Absent means no sweep produced a summary yet (or the run
   * never reached `human-review`).
   */
  latestReviewFeedback?: ReviewFeedbackSummary;
  /**
   * V4.1 Workflow Spine: synthetic task run metadata. Set by
   * `apps/orchestrator/src/work-items/dispatch-task.ts` so the daemon
   * can recognise dispatch_completed / dispatch_failed events that
   * belong to a WorkItem task and route them through the orchestration
   * `applyTaskRunFinal` + aggregator + handoff path. Absent on the
   * V2.x single-issue runs to keep them legacy-compatible.
   */
  workItem?: { workItemId: string; taskId: string };
}

/**
 * Coarse-grained CI pipeline classification surfaced by
 * `@issuepilot/tracker-gitlab` `getPipelineStatus`. Mirrors the
 * `PipelineStatus` type living in the tracker package, duplicated here
 * to keep the dashboard / shared-contracts consumers free of a tracker
 * dependency. Keep both lists in sync.
 */
export const PIPELINE_STATUS_VALUES = [
  "running",
  "success",
  "failed",
  "pending",
  "canceled",
  "unknown",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUS_VALUES)[number];

export const isPipelineStatus = (value: unknown): value is PipelineStatus =>
  typeof value === "string" &&
  (PIPELINE_STATUS_VALUES as readonly string[]).includes(value);
