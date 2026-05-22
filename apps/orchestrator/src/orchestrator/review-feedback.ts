import { randomUUID } from "node:crypto";

import { redact, type EventBus } from "@issuepilot/observability";
import type {
  IssuePilotInternalEvent,
  ReviewComment,
  ReviewerAgentReport,
  ReviewFeedbackSummary,
  ReviewReworkPlan,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

import { evaluateMergeReadiness } from "../reports/merge-readiness.js";
import type { ReportStore } from "../reports/store.js";
import type { RuntimeState } from "../runtime/state.js";

/**
 * Marker prefix every IssuePilot-authored note shares (handoff, ci
 * feedback, closing, workpad, etc.). We only need to match the prefix
 * — the actual marker variant carries the run id and is not relevant
 * for review-feedback filtering.
 */
const ISSUEPILOT_MARKER_PREFIX = "<!-- issuepilot:";

/**
 * GitLab adapter slice consumed by the review feedback sweep. The
 * orchestrator wires the real `@issuepilot/tracker-gitlab` adapter;
 * tests can plug in a hand-rolled mock that only implements these two
 * methods.
 */
export interface ReviewFeedbackGitLabSlice {
  findMergeRequestBySourceBranch(sourceBranch: string): Promise<{
    iid: number;
    webUrl: string;
    state: string;
    sourceBranch: string;
    title: string;
    description: string;
    updatedAt?: string;
  } | null>;
  listMergeRequestNotes(mrIid: number): Promise<
    Array<{
      id: number;
      body: string;
      author: string;
      system: boolean;
      createdAt?: string;
      updatedAt?: string;
      resolvable?: boolean;
      resolved?: boolean;
    }>
  >;
}

/**
 * Workflow slice the sweep needs. Keeping it minimal lets tests build
 * a literal without standing up the entire team workflow loader.
 *
 * Note on `handoffLabel`: it is accepted here for symmetry with the
 * other orchestrator slices and is reserved for a future refactor that
 * refreshes `RunRecord.issue.labels` from GitLab at handoff time so the
 * sweep can validate the issue is still parked at the human-review
 * stage. The current implementation deliberately does **not** consult
 * the field — `RunRecord.issue.labels` is the claim-time snapshot and
 * is never refreshed (see the analogous note in `ci-feedback.ts`), so
 * cross-checking it would reject every valid candidate. The safety net
 * the sweep actually relies on is `RunRecord.status === "completed"`
 * with both `endedAt` and `archivedAt` empty — the dispatch pipeline
 * only parks a run in that exact shape after handoff to human-review.
 *
 * `botAccountName` lets deployments suppress reviewer notes written by
 * a service account whose body does not happen to carry our marker.
 */
export interface ReviewFeedbackWorkflowSlice {
  tracker: {
    handoffLabel: string;
    botAccountName?: string;
  };
}

/**
 * V4.9: 当 sweep 完成一轮新评论收集后，会把 summary 与最新 reviewer
 * findings 一起交给这个 slice 生成 `ReviewReworkPlan` 草稿，然后落到
 * `RunReportArtifact.reviewReworkPlan` 里。slice 故意做得很小：把
 * `ReviewWorkflowService` 全量接口（带 store / planner / 事件）和
 * sweep 的关注点（拿 reviewer report、生成 plan）解耦，方便在 daemon
 * 适配层把 pipelineStore + reviewWorkflowService 组合成这个接口，也
 * 让单测可以直接传 `vi.fn()`。
 */
export interface ReviewFeedbackReviewWorkflowSlice {
  generate(input: {
    runId: string;
    issueIid: number;
    projectId?: string;
    summary?: ReviewFeedbackSummary;
    reviewerReports: ReviewerAgentReport[];
    reportArtifact?: RunReportArtifact;
  }): Promise<ReviewReworkPlan>;
  listLatestReviewerReports(input: {
    runId: string;
  }): Promise<ReviewerAgentReport[]>;
}

export interface SweepReviewFeedbackInput {
  state: RuntimeState;
  gitlab: ReviewFeedbackGitLabSlice;
  workflow: ReviewFeedbackWorkflowSlice;
  eventBus: EventBus<IssuePilotInternalEvent>;
  /**
   * V2.5 Command Center: when present, every sweep that observes a new
   * batch of human comments updates the run report's `reviewFeedback`
   * and recomputes merge readiness. Tests that do not exercise the
   * report subsystem can leave it undefined.
   */
  reports?: ReportStore;
  /**
   * V4.9: optional slice that, when provided, will receive the freshly
   * generated `ReviewFeedbackSummary` + reviewer findings and persist a
   * draft `ReviewReworkPlan` snapshot on the report artifact. Sweep
   * tests that do not exercise the planner can leave it undefined.
   */
  reviewWorkflow?: ReviewFeedbackReviewWorkflowSlice;
  /** Injectable clock so tests can pin `generatedAt`. */
  now?: () => Date;
}

interface ReviewRun {
  runId: string;
  branch: string;
  issueIid: number;
  issue: {
    id: string;
    iid: number;
    title: string;
    url: string;
    projectId: string;
    labels: readonly string[];
  };
  lastDiscussionCursor?: string;
}

interface IssueLike {
  id?: string;
  iid?: unknown;
  title?: string;
  url?: string;
  projectId?: string;
  labels?: unknown;
}

function asReviewRun(record: Record<string, unknown>): ReviewRun | null {
  const runId = record["runId"];
  if (typeof runId !== "string") return null;
  const branch = record["branch"];
  if (typeof branch !== "string" || branch.length === 0) return null;
  const issue = record["issue"] as IssueLike | undefined;
  if (!issue) return null;
  const iid = typeof issue.iid === "number" ? issue.iid : Number(issue.iid);
  if (!Number.isFinite(iid)) return null;
  const labels = Array.isArray(issue.labels)
    ? (issue.labels as string[])
    : [];

  const out: ReviewRun = {
    runId,
    branch,
    issueIid: iid,
    issue: {
      id: issue.id ?? String(iid),
      iid,
      title: issue.title ?? "",
      url: issue.url ?? "",
      projectId: issue.projectId ?? "",
      labels,
    },
  };
  if (typeof record["lastDiscussionCursor"] === "string") {
    out.lastDiscussionCursor = record["lastDiscussionCursor"];
  }
  return out;
}

function nowIso(input: SweepReviewFeedbackInput): string {
  return (input.now?.() ?? new Date()).toISOString();
}

function emit(
  input: SweepReviewFeedbackInput,
  run: ReviewRun,
  type:
    | "review_feedback_sweep_started"
    | "review_feedback_summary_generated"
    | "review_feedback_sweep_failed"
    | "review_rework_plan_generated"
    | "review_rework_plan_generation_failed",
  data: Record<string, unknown>,
): void {
  const ts = nowIso(input);
  // The sweeper publishes directly to the event bus rather than going
  // through daemon.ts's `publishEvent` wrapper (which centralises
  // redaction). Running the redactor here keeps reviewer note bodies
  // safe in case a comment ever quotes a token-shaped string.
  const redactedData = redact(data);
  const safeData =
    redactedData &&
    typeof redactedData === "object" &&
    !Array.isArray(redactedData)
      ? (redactedData as Record<string, unknown>)
      : data;
  const summary = (() => {
    switch (type) {
      case "review_feedback_sweep_started":
        return `review:start:${run.runId}`;
      case "review_feedback_summary_generated": {
        const count =
          typeof safeData["commentCount"] === "number"
            ? (safeData["commentCount"] as number)
            : Array.isArray(safeData["comments"])
              ? (safeData["comments"] as unknown[]).length
              : 0;
        return `review:summary:${run.runId}:${count}`;
      }
      case "review_feedback_sweep_failed":
        return `review:failed:${run.runId}:${
          safeData["reason"] ?? "unknown"
        }`;
      case "review_rework_plan_generated":
        return `rework:plan:${run.runId}:${safeData["planId"] ?? "?"}`;
      case "review_rework_plan_generation_failed":
        return `rework:plan:failed:${run.runId}:${
          safeData["reason"] ?? "unknown"
        }`;
    }
  })();
  const event: IssuePilotInternalEvent = {
    id: randomUUID(),
    runId: run.runId,
    type,
    message: summary,
    data: safeData,
    createdAt: ts,
    ts,
    issue: {
      id: run.issue.id,
      iid: run.issue.iid,
      title: run.issue.title,
      url: run.issue.url,
      projectId: run.issue.projectId,
    },
  };
  input.eventBus.publish(event);
}

/**
 * Run statuses considered "parked at human-review" for the purpose of
 * review feedback scanning. Mirrors the CI feedback scanner: V1 dispatch
 * parks a run at `status: "completed"` once reconciliation finishes,
 * which is the moment we want to start polling reviewer comments. We
 * additionally require both `endedAt` and `archivedAt` to be empty —
 * `syncHumanReviewFinalLabels` sets `endedAt` the moment the issue
 * leaves human-review (either to `ai-rework` or by closing), so this
 * guarantees we stop sweeping a stale MR. See the workflow slice
 * `handoffLabel` doc for why we deliberately do not also cross-check
 * `RunRecord.issue.labels`.
 */
const REVIEW_RUN_STATUSES = new Set<string>(["completed"]);

function isReviewCandidate(record: Record<string, unknown>): boolean {
  if (record["archivedAt"]) return false;
  if (
    typeof record["endedAt"] === "string" &&
    (record["endedAt"] as string).length > 0
  ) {
    return false;
  }
  const status = record["status"];
  if (typeof status !== "string" || !REVIEW_RUN_STATUSES.has(status)) {
    return false;
  }
  return true;
}

function isLikelyHumanNote(
  note: {
    body: string;
    author: string;
    system: boolean;
  },
  workflow: ReviewFeedbackWorkflowSlice,
): boolean {
  if (note.system === true) return false;
  // I2: IssuePilot-authored marker notes share the same HTML comment
  // prefix on the very first line; trimming guards against minor
  // formatting drift introduced by upstream MR description rewrites.
  if (note.body.trimStart().startsWith(ISSUEPILOT_MARKER_PREFIX)) {
    return false;
  }
  const bot = workflow.tracker.botAccountName;
  if (bot && note.author === bot) return false;
  return true;
}

/**
 * Sweep reviewer notes on the MR linked to every run currently parked
 * at the human-review stage, persist a structured summary on the run
 * record and emit lifecycle events for the dashboard / event log.
 *
 * Per-run flow:
 *
 *  1. Emit `review_feedback_sweep_started` so observers know the sweep
 *     touched this run on this tick.
 *  2. Resolve the MR via `findMergeRequestBySourceBranch`. Missing MR
 *     emits `review_feedback_summary_generated { reason: "no_mr",
 *     comments: [] }` so the dashboard can show "sweep ran, nothing to
 *     report" instead of going silent.
 *  3. List the MR notes; any throw becomes `review_feedback_sweep_failed
 *     { reason: "lookup_failed", message }`. State is intentionally
 *     left untouched so the next sweep retries from the last known cursor.
 *  4. Filter system notes, IssuePilot marker notes and (optionally)
 *     bot-account notes, then drop anything with `createdAt <=
 *     lastDiscussionCursor` so the same reviewer comment is never
 *     re-injected.
 *  5. When the filtered list is non-empty, store a `ReviewFeedbackSummary`
 *     on the run and advance `lastDiscussionCursor` to the max
 *     `createdAt`. When the list is empty we still emit
 *     `review_feedback_summary_generated { comments: [] }` so the audit
 *     log records liveness, but leave the cursor unchanged so we do not
 *     skip notes whose `createdAt` we have not yet observed.
 */
export async function sweepReviewFeedbackOnce(
  input: SweepReviewFeedbackInput,
): Promise<void> {
  const candidates: ReviewRun[] = [];
  for (const record of input.state.allRuns()) {
    if (!isReviewCandidate(record as Record<string, unknown>)) continue;
    const review = asReviewRun(record as Record<string, unknown>);
    if (!review) continue;
    candidates.push(review);
  }

  for (const run of candidates) {
    emit(input, run, "review_feedback_sweep_started", {
      branch: run.branch,
    });

    const mr = await input.gitlab.findMergeRequestBySourceBranch(run.branch);
    if (!mr) {
      emit(input, run, "review_feedback_summary_generated", {
        reason: "no_mr",
        branch: run.branch,
        comments: [],
        cursor: run.lastDiscussionCursor ?? null,
      });
      continue;
    }

    let notes;
    try {
      notes = await input.gitlab.listMergeRequestNotes(mr.iid);
    } catch (err) {
      emit(input, run, "review_feedback_sweep_failed", {
        reason: "lookup_failed",
        branch: run.branch,
        mrIid: mr.iid,
        mrUrl: mr.webUrl,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const cursorIso = run.lastDiscussionCursor;
    const generatedAt = nowIso(input);

    // Collect every human note + flag which ones are new relative to
    // the cursor. The summary persists the *accumulated* history so a
    // reviewer can post a comment, walk away for a while, post another
    // one, and the agent still sees both on the next ai-rework cycle.
    // Without this we'd happily overwrite the prior summary on every
    // sweep tick — meaning whatever comment landed first gets dropped
    // before the agent ever reads it (verified in the Phase 4 e2e
    // before this accumulator landed).
    const allHumanComments: ReviewComment[] = [];
    const fresh: ReviewComment[] = [];
    for (const raw of notes) {
      if (!isLikelyHumanNote(raw, input.workflow)) continue;
      // Skip notes whose API payload omits `createdAt`. Without a
      // timestamp we cannot honour the cursor invariant and would risk
      // re-injecting the same comment on every tick.
      if (typeof raw.createdAt !== "string") continue;

      const comment: ReviewComment = {
        noteId: raw.id,
        author: raw.author,
        body: raw.body,
        url: `${mr.webUrl}#note_${raw.id}`,
        createdAt: raw.createdAt,
        resolved: raw.resolved === true,
      };
      allHumanComments.push(comment);
      if (!cursorIso || raw.createdAt > cursorIso) {
        fresh.push(comment);
      }
    }

    allHumanComments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    fresh.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    if (fresh.length === 0) {
      // Keep the event payload's `cursor` field aligned with the
      // persisted `lastDiscussionCursor`: when we have no cursor yet
      // (first sweep with zero fresh comments), report `null` instead
      // of a synthetic `generatedAt`, so downstream consumers can tell
      // "we have not advanced the cursor" from "we advanced it to T".
      emit(input, run, "review_feedback_summary_generated", {
        reason: "no_new_comments",
        branch: run.branch,
        mrIid: mr.iid,
        mrUrl: mr.webUrl,
        comments: [],
        cursor: cursorIso ?? null,
      });
      continue;
    }

    const newCursor = fresh[fresh.length - 1]!.createdAt;
    const summary: ReviewFeedbackSummary = {
      mrIid: mr.iid,
      mrUrl: mr.webUrl,
      generatedAt,
      cursor: newCursor,
      // Persist the full history; on the next ai-rework cycle the
      // prompt will replay every reviewer comment, not just whichever
      // ones happened to arrive in the latest sweep window.
      comments: allHumanComments,
    };

    const stored = input.state.getRun(run.runId);
    if (stored) {
      input.state.setRun(run.runId, {
        ...stored,
        latestReviewFeedback: summary,
        lastDiscussionCursor: newCursor,
      });
    }

    if (input.reports) {
      const current = await input.reports.get(run.runId);
      if (current) {
        const unresolved = allHumanComments.filter((c) => !c.resolved).length;
        const next: RunReportArtifact = {
          ...current,
          reviewFeedback: {
            latestCursor: newCursor,
            unresolvedCount: unresolved,
            comments: allHumanComments.map((c) => ({
              author: c.author,
              body: c.body,
              url: c.url,
              resolved: c.resolved,
              createdAt: c.createdAt,
            })),
          },
        };
        await input.reports.save({
          ...next,
          mergeReadiness: evaluateMergeReadiness(next, {
            evaluatedAt: generatedAt,
          }),
        });
      }
    }

    if (input.reviewWorkflow) {
      try {
        const reviewerReports =
          await input.reviewWorkflow.listLatestReviewerReports({
            runId: run.runId,
          });
        const reportArtifact = input.reports
          ? await input.reports.get(run.runId)
          : undefined;
        const plan = await input.reviewWorkflow.generate({
          runId: run.runId,
          issueIid: run.issueIid,
          projectId: run.issue.projectId,
          summary,
          reviewerReports,
          ...(reportArtifact ? { reportArtifact } : {}),
        });
        if (input.reports) {
          const refreshed = await input.reports.get(run.runId);
          if (refreshed) {
            await input.reports.save({
              ...refreshed,
              reviewReworkPlan: plan,
            });
          }
        }
        emit(input, run, "review_rework_plan_generated", {
          planId: plan.planId,
          itemCount: plan.items.length,
          status: plan.status,
        });
      } catch (err) {
        emit(input, run, "review_rework_plan_generation_failed", {
          reason: "planner_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    emit(input, run, "review_feedback_summary_generated", {
      branch: run.branch,
      mrIid: mr.iid,
      mrUrl: mr.webUrl,
      generatedAt,
      cursor: newCursor,
      // The event payload reports only the *delta* that this tick
      // observed — the dashboard separately renders the accumulated
      // summary from the RunRecord, so reporting fresh-only here keeps
      // the audit log honest about what each tick actually did.
      commentCount: fresh.length,
      comments: fresh,
    });
  }
}
