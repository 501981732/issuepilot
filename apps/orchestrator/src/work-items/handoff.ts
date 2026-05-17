import type {
  TaskPlan,
  WorkItem,
  WorkItemReport,
  WorkItemReportStatus,
  WorkItemStatus,
} from "@issuepilot/shared-contracts";

/**
 * V4.1 Workflow Spine parent handoff (spec §9.0 / §11.6 / §14).
 *
 * The aggregator (`work-items/aggregate.ts`) decides _what_ the parent
 * Issue should hear; this module decides _how_ that information lands
 * back on GitLab as a single workpad note plus an optional label
 * transition. It is the only place in V4.1 allowed to transition the
 * parent Issue label — `reconcile.ts` is hard-gated by
 * `parentIssueLabelMode: "suppressed"` for synthetic task runs (see
 * Task 7).
 *
 * Parent Issue label state machine (spec §9.0):
 *
 *   | prevStatus → currentStatus | label transition                                | note? |
 *   | ---                        | ---                                              | ---   |
 *   | (none) → planning          | none                                             | no    |
 *   | planning → ready           | none (operator owns ai-ready)                    | no    |
 *   | ready → running            | add: [ai-running], remove: [ai-ready]            | no    |
 *   | running → running/partial  | none                                             | yes (write current state) |
 *   | running → completed        | add: [human-review], remove: [ai-running]        | yes (final summary)       |
 *   | * → blocked                | none (operator decides whether to relabel)       | yes (write blocked state) |
 *
 * The note body is rendered with a single fixed marker
 * `<!-- issuepilot:work-item:<id> -->` so we can reliably find /
 * update one note per WorkItem instead of stacking new notes on every
 * tick.
 */

export interface ParentHandoffWorkflow {
  /** Label applied while at least one synthetic task run is in flight. */
  runningLabel: string;
  /** Label applied when every required task is `completed` and the report is ready. */
  handoffLabel: string;
  /** Label operators flip on to request rework on a task. */
  reworkLabel: string;
  /** Optional; many workflows do not declare a dedicated `ai-blocked` label. */
  blockedLabel?: string;
  /** The pre-running label (typically `ai-ready`). */
  readyLabel: string;
}

export interface ParentHandoffGitlab {
  findWorkpadNote(
    issueIid: number,
    marker: string,
  ): Promise<{ id: number; body: string } | null>;
  createNote(issueIid: number, body: string): Promise<{ id: number }>;
  updateNote(issueIid: number, noteId: number, body: string): Promise<void>;
  transitionLabels(
    iid: number,
    opts: { add: string[]; remove: string[] },
  ): Promise<void>;
}

export interface ParentHandoffDeps {
  gitlab: ParentHandoffGitlab;
  emit(event: {
    type: string;
    runId?: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void;
  now?(): string;
}

export interface WriteParentHandoffInput {
  workItem: WorkItem;
  plan: TaskPlan;
  report: WorkItemReport | undefined;
  /**
   * The previous {@link WorkItem.status} before this transition. Used
   * to drive the label state machine without the daemon having to
   * re-derive transitions from scratch.
   */
  previousStatus: WorkItemStatus | undefined;
  workflow: ParentHandoffWorkflow;
  deps: ParentHandoffDeps;
}

export function workItemHandoffMarker(workItemId: string): string {
  return `<!-- issuepilot:work-item:${workItemId} -->`;
}

export function decideParentLabelTransition(
  previousStatus: WorkItemStatus | undefined,
  currentStatus: WorkItemStatus,
  workflow: ParentHandoffWorkflow,
): { add: string[]; remove: string[] } {
  if (previousStatus === currentStatus) return { add: [], remove: [] };

  // ready → running: claim the parent Issue as in-flight.
  if (previousStatus === "ready" && currentStatus === "running") {
    return {
      add: [workflow.runningLabel],
      remove: [workflow.readyLabel],
    };
  }

  // running → completed: hand off to human review.
  if (previousStatus === "running" && currentStatus === "completed") {
    return {
      add: [workflow.handoffLabel],
      remove: [workflow.runningLabel],
    };
  }

  // Every other transition is intentionally a no-op so operators stay
  // in control of the parent Issue label during ambiguous outcomes
  // (partial / blocked / re-plan).
  return { add: [], remove: [] };
}

/**
 * Decide whether the current state warrants a workpad note write. We
 * only write notes when there is a {@link WorkItemReport} to render —
 * a planning / ready transition has nothing for the parent reviewer
 * to read yet.
 */
function shouldWriteNote(
  previousStatus: WorkItemStatus | undefined,
  currentStatus: WorkItemStatus,
  report: WorkItemReport | undefined,
): boolean {
  if (!report) return false;
  if (currentStatus === "planning") return false;
  if (currentStatus === "ready") return false;
  // ready → running is a label-only transition; avoid noise on every
  // task dispatch tick.
  if (previousStatus === "ready" && currentStatus === "running") return false;
  return true;
}

export function renderWorkItemHandoffNoteBody(
  workItem: WorkItem,
  plan: TaskPlan,
  report: WorkItemReport,
): string {
  const lines: string[] = [];
  lines.push(workItemHandoffMarker(workItem.workItemId));
  lines.push(`## IssuePilot work item handoff — ${workItem.title}`);
  lines.push("");
  lines.push(`- Source Issue: ${workItem.sourceIssue.url}`);
  lines.push(
    `- Status: ${overallStatusLabel(report.overallStatus)} (${report.overallStatus})`,
  );
  lines.push(`- Plan version: ${plan.version}`);
  lines.push(`- Tasks: ${plan.tasks.length}`);
  lines.push("");
  lines.push("### Task summary");
  lines.push("");
  for (const summary of report.taskSummaries) {
    const titleLine = `- **${summary.title}** (${summary.taskId}) — \`${summary.taskStatus}\``;
    lines.push(titleLine);
    if (summary.diffSummary) {
      lines.push(`  - Diff: ${oneLine(summary.diffSummary)}`);
    }
    if (summary.mergeRequestUrl) {
      lines.push(`  - MR: ${summary.mergeRequestUrl}`);
    }
    if (summary.ciStatus) {
      lines.push(`  - CI: ${summary.ciStatus}`);
    }
    if (summary.validation.length > 0) {
      lines.push(
        `  - Validation: ${summary.validation.map(oneLine).join("; ")}`,
      );
    }
    if (summary.risks.length > 0) {
      lines.push(
        `  - Risks: ${summary.risks
          .map((r) => `(${r.level}) ${oneLine(r.text)}`)
          .join("; ")}`,
      );
    }
    if (summary.followUps.length > 0) {
      lines.push(`  - Follow-ups: ${summary.followUps.map(oneLine).join("; ")}`);
    }
    if (summary.nextAction) {
      lines.push(`  - Next: ${oneLine(summary.nextAction)}`);
    }
  }

  lines.push("");
  lines.push("### Validation");
  lines.push(report.validationSummary || "_(no validation reported)_");

  lines.push("");
  lines.push("### Risks");
  lines.push(report.riskSummary || "_(no risks reported)_");

  if (report.openQuestions.length > 0) {
    lines.push("");
    lines.push("### Open questions");
    for (const q of report.openQuestions) {
      lines.push(`- ${oneLine(q)}`);
    }
  }

  lines.push("");
  lines.push("### Next action");
  if (report.recommendedNextActions.length === 0) {
    lines.push("Reviewer to inspect the linked MRs and decide next steps.");
  } else {
    for (const a of report.recommendedNextActions) {
      lines.push(`- ${oneLine(a)}`);
    }
  }

  lines.push("");
  lines.push(`_Generated at ${report.generatedAt}._`);

  return lines.join("\n");
}

function overallStatusLabel(status: WorkItemReportStatus): string {
  switch (status) {
    case "complete":
      return "All tasks completed";
    case "partial":
      return "Partial — operator action required";
    case "incomplete":
      return "Awaiting more task runs";
    case "draft":
      return "Aggregation pending";
    default:
      return status;
  }
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function writeParentHandoff(
  input: WriteParentHandoffInput,
): Promise<{ noteId?: number; transitioned: boolean }> {
  const ts = input.deps.now?.() ?? new Date().toISOString();
  const transition = decideParentLabelTransition(
    input.previousStatus,
    input.workItem.status,
    input.workflow,
  );
  const writeNote = shouldWriteNote(
    input.previousStatus,
    input.workItem.status,
    input.report,
  );

  let transitioned = false;
  if (transition.add.length > 0 || transition.remove.length > 0) {
    await input.deps.gitlab.transitionLabels(input.workItem.sourceIssue.iid, {
      add: transition.add,
      remove: transition.remove,
    });
    transitioned = true;
  }

  let noteId: number | undefined;
  if (writeNote && input.report) {
    const marker = workItemHandoffMarker(input.workItem.workItemId);
    const existing = await input.deps.gitlab.findWorkpadNote(
      input.workItem.sourceIssue.iid,
      marker,
    );
    const body = renderWorkItemHandoffNoteBody(
      input.workItem,
      input.plan,
      input.report,
    );
    if (existing) {
      await input.deps.gitlab.updateNote(
        input.workItem.sourceIssue.iid,
        existing.id,
        body,
      );
      noteId = existing.id;
    } else {
      const created = await input.deps.gitlab.createNote(
        input.workItem.sourceIssue.iid,
        body,
      );
      noteId = created.id;
    }
  }

  if (transitioned || noteId !== undefined) {
    input.deps.emit({
      type: "work_item_handoff_written",
      ts,
      detail: {
        workItemId: input.workItem.workItemId,
        previousStatus: input.previousStatus,
        currentStatus: input.workItem.status,
        labelAdd: transition.add,
        labelRemove: transition.remove,
        ...(noteId !== undefined ? { noteId } : {}),
      },
    });
  }

  return { ...(noteId !== undefined ? { noteId } : {}), transitioned };
}
