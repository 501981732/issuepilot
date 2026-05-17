import { type IssueRef } from "./issue.js";

/**
 * Canonical list of every event type the orchestrator + runner + tracker
 * may emit. Sourced from spec §10 and plan Phase 1 §1.4. Keep alphabetical
 * groupings (lifecycle / turns / tools / approvals / runtime / git / run /
 * retry) to make grep easier.
 *
 * Adding a new event type is a breaking change for downstream consumers
 * (dashboard, observability JSONL readers) — bump the package version and
 * call it out in CHANGELOG.
 */
export const EVENT_TYPE_VALUES = [
  // Run lifecycle (claim → completion)
  "run_started",
  "claim_succeeded",
  "claim_failed",
  "run_completed",
  "run_failed",
  "run_blocked",
  // Dispatch pipeline
  "dispatch_start",
  "mirror_ready",
  "worktree_ready",
  "hook_afterCreate_done",
  "hook_beforeRun_done",
  "hook_afterRun_done",
  "agent_completed",
  "dispatch_completed",
  "dispatch_failed",
  // Workspace bootstrap
  "workspace_ready",
  "workspace_failed",
  // Codex session + turns
  "session_started",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "turn_cancelled",
  "turn_timeout",
  // Tools
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "unsupported_tool_call",
  // Approvals & input
  "approval_required",
  "approval_auto_approved",
  "turn_input_required",
  // Codex runner events after daemon namespacing
  "codex_session_started",
  "codex_turn_started",
  "codex_turn_completed",
  "codex_turn_failed",
  "codex_turn_cancelled",
  "codex_turn_timeout",
  "codex_tool_call_started",
  "codex_tool_call_completed",
  "codex_tool_call_failed",
  "codex_unsupported_tool_call",
  "codex_approval_required",
  "codex_approval_auto_approved",
  "codex_turn_input_required",
  "codex_notification",
  "codex_malformed_message",
  // Runner runtime
  "notification",
  "malformed_message",
  "port_exit",
  // GitLab side-effects
  "gitlab_push",
  "gitlab_mr_created",
  "gitlab_mr_updated",
  "gitlab_note_created",
  "gitlab_note_updated",
  "gitlab_workpad_note_created",
  "gitlab_workpad_note_updated",
  "gitlab_labels_transitioned",
  // Reconciliation + retry
  "reconciliation_started",
  "reconciliation_completed",
  "reconcile_no_commits",
  "retry_scheduled",
  // Human review reconciliation
  "human_review_scan_started",
  "human_review_mr_found",
  "human_review_mr_missing",
  "human_review_mr_still_open",
  "human_review_mr_merged",
  "human_review_issue_closed",
  "human_review_mr_closed_unmerged",
  "human_review_rework_requested",
  "human_review_reconcile_failed",
  // Operator dashboard actions (V2 Phase 2)
  "operator_action_requested",
  "operator_action_succeeded",
  "operator_action_failed",
  // CI feedback loop (V2 Phase 3)
  "ci_status_observed",
  "ci_status_rework_triggered",
  "ci_status_lookup_failed",
  // Review feedback sweep (V2 Phase 4)
  "review_feedback_sweep_started",
  "review_feedback_summary_generated",
  "review_feedback_sweep_failed",
  // Workspace retention sweep (V2 Phase 5)
  "workspace_cleanup_planned",
  "workspace_cleanup_completed",
  "workspace_cleanup_failed",
  // V4.1 work item lifecycle
  "work_item_created",
  "work_item_plan_drafted",
  "work_item_plan_accepted",
  "work_item_plan_rejected",
  "work_item_plan_regenerated",
  "work_item_planning_failed",
  // V4.1 synthetic task runs
  "task_run_dispatched",
  "task_run_completed",
  "task_run_failed",
  "task_run_skipped",
  "task_run_blocked_by_dependency",
  // V4.1 aggregation + parent handoff
  "work_item_aggregated",
  "work_item_handoff_written",
  // V4.3 review packet + evidence
  "work_item_evidence_indexed",
  "work_item_evidence_confirmed",
  "work_item_report_rendered",
  // V4.2 task graph + operator actions
  "task_marked_needs_rework",
  "task_replanned",
  "task_unskipped",
  "task_graph_recomputed",
] as const;

export type EventType = (typeof EVENT_TYPE_VALUES)[number];

export const isEventType = (value: unknown): value is EventType =>
  typeof value === "string" &&
  (EVENT_TYPE_VALUES as readonly string[]).includes(value);

/** Subset of {@link IssueRef} that travels with every event payload. */
export type EventIssueRef = Pick<
  IssueRef,
  "id" | "iid" | "title" | "url" | "projectId"
>;

/**
 * Wire-level event published by the orchestrator over SSE and persisted to
 * the JSONL event store. `data` is intentionally `unknown` — concrete event
 * payload schemas live next to the producer.
 */
export interface IssuePilotEvent {
  /** UUID v4 string assigned at publish time. */
  id: string;
  runId: string;
  issue: EventIssueRef;
  type: EventType;
  /** Human-readable summary; never includes secrets. */
  message: string;
  /** Codex thread id, when the event originates inside a runner session. */
  threadId?: string;
  /** Codex turn id, when applicable. */
  turnId?: string;
  /** Free-form structured payload — always run through redact() first. */
  data?: unknown;
  /** ISO-8601 timestamp captured at publish time. */
  createdAt: string;
}

/**
 * Internal event envelope used by the orchestrator daemon (V1 `--workflow`
 * and V2 `--config` modes) and the SSE `/api/events` server before being
 * narrowed to {@link IssuePilotEvent} for public consumers.
 *
 * Compared to the wire-level {@link IssuePilotEvent}:
 *
 *  - `type` is `string` rather than `EventType` because the daemon emits a
 *    superset of types (including system-level signals like `heartbeat`)
 *    that are filtered before publishing to the dashboard.
 *  - `ts` is preserved alongside `createdAt` because the legacy SSE client
 *    keys ordering off `ts`; new consumers must prefer `createdAt`.
 *  - `issue` is optional — V2 team-mode lifecycle events (e.g. scheduler
 *    startup) do not have an issue context.
 *  - An index signature is allowed so producers can attach run-mode
 *    specific keys without forcing a contract change.
 *
 * V1 (`apps/orchestrator/src/daemon.ts`) and V2
 * (`apps/orchestrator/src/team/daemon.ts`) both flow events through this
 * interface so the Fastify server and dashboard hydrate a single shape
 * regardless of which entrypoint produced them (review M9).
 */
export interface IssuePilotInternalEvent {
  id: string;
  runId: string;
  issue?: EventIssueRef;
  type: string;
  message: string;
  data?: unknown;
  createdAt: string;
  ts: string;
  [key: string]: unknown;
}
