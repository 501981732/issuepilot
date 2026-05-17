import type {
  RunReportArtifact,
  TaskNode,
  TaskNodeStatus,
  TaskPlan,
  TaskRunLink,
  WorkItem,
  WorkItemEvidenceEntry,
  WorkItemReport,
  WorkItemReportStatus,
} from "@issuepilot/shared-contracts";

/**
 * V4.1 Workflow Spine aggregator (spec §15 / §12.5).
 *
 * Goal: turn the per-task RunReport artifacts into a single
 * {@link WorkItemReport} that the parent Issue handoff note, the
 * dashboard's Parent Review Packet, and the Markdown export can all
 * read from. The aggregator is intentionally a pure data function:
 * it does not write to GitLab, does not move labels, and does not
 * mutate the work-items store. The daemon orchestrates the I/O — this
 * module just decides _what_ to say.
 *
 * Decision matrix for `overallStatus` (spec §15.2):
 *
 *   - `complete`   — every task in the plan has a `completed`
 *                    TaskRunLink AND a present RunReportArtifact.
 *   - `incomplete` — at least one task is missing a TaskRunLink, or
 *                    a TaskRunLink exists but the RunReport is not
 *                    yet on disk. Aggregation should be re-run later;
 *                    nothing is broken.
 *   - `partial`    — every task has a TaskRunLink + report, but at
 *                    least one task ended in `failed` / `blocked` /
 *                    `needs_rework` / `skipped`.
 *
 * The aggregator NEVER returns a "ready_to_merge" or auto-merge
 * recommendation: V4.1 keeps human-review as the upper bound. This is
 * an explicit invariant per spec §17 acceptance criteria, and the
 * test suite asserts the absence of that string.
 *
 * Evidence index: every task contributes the following kinds when the
 * underlying RunReport supplies the data:
 *
 *   - `diff`            — RunReportArtifact.diff.summary
 *   - `validation`      — each entry of RunReportArtifact.handoff.validation
 *   - `risk`            — each entry of RunReportArtifact.handoff.risks
 *   - `ci`              — RunReportArtifact.ci.status (when present)
 *   - `review_feedback` — each comment in RunReportArtifact.reviewFeedback
 *
 * The index is rendered both flat (`evidence.index`) and grouped by
 * taskId (`evidence.byTask`) so the dashboard can show the same data
 * either as a global timeline or as per-task expandable cards without
 * re-deriving anything.
 */
export interface AggregateDeps {
  getRunReport(runId: string): Promise<RunReportArtifact | undefined>;
  now?(): string;
}

export async function aggregateWorkItem(
  workItem: WorkItem,
  plan: TaskPlan,
  links: TaskRunLink[],
  deps: AggregateDeps,
): Promise<WorkItemReport> {
  const generatedAt = deps.now?.() ?? new Date().toISOString();

  // Pick the latest TaskRunLink per task so retries are reflected.
  const latestLinkByTask = pickLatestLinkByTask(links);

  type TaskEntry = {
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  };

  const entries: TaskEntry[] = [];
  for (const task of plan.tasks) {
    const link = latestLinkByTask.get(task.taskId);
    const report = link ? await deps.getRunReport(link.runId) : undefined;
    entries.push({ task, link, report });
  }

  const overallStatus = decideOverallStatus(entries);

  const evidenceIndex: WorkItemEvidenceEntry[] = [];
  const evidenceByTask: Record<string, WorkItemEvidenceEntry[]> = {};

  const taskSummaries: WorkItemReport["taskSummaries"] = entries.map(
    ({ task, link, report }) => {
      const status: TaskNodeStatus = link?.status ?? task.status;
      const taskEvidence: WorkItemEvidenceEntry[] = [];

      if (report) {
        if (report.diff?.summary) {
          taskEvidence.push({
            taskId: task.taskId,
            kind: "diff",
            label: `Diff: ${report.diff.filesChanged} file(s) changed`,
            text: report.diff.summary,
          });
        }
        for (const v of report.handoff.validation) {
          taskEvidence.push({
            taskId: task.taskId,
            kind: "validation",
            label: "Validation",
            text: v,
          });
        }
        for (const r of report.handoff.risks) {
          taskEvidence.push({
            taskId: task.taskId,
            kind: "risk",
            label: `Risk (${r.level})`,
            text: r.text,
          });
        }
        if (report.ci) {
          taskEvidence.push({
            taskId: task.taskId,
            kind: "ci",
            label: `CI: ${report.ci.status}`,
            ...(report.ci.pipelineUrl ? { href: report.ci.pipelineUrl } : {}),
          });
        }
        if (report.reviewFeedback) {
          for (const c of report.reviewFeedback.comments) {
            taskEvidence.push({
              taskId: task.taskId,
              kind: "review_feedback",
              label: `Reviewer: ${c.author}${c.resolved ? " (resolved)" : ""}`,
              href: c.url,
              text: c.body,
            });
          }
        }
      }

      evidenceByTask[task.taskId] = taskEvidence;
      evidenceIndex.push(...taskEvidence);

      const nextAction = deriveTaskNextAction(status, report);
      return {
        taskId: task.taskId,
        title: task.title,
        taskStatus: status,
        ...(link?.runId ? { runId: link.runId } : {}),
        ...(report?.diff?.summary
          ? { diffSummary: report.diff.summary }
          : {}),
        validation: report?.handoff.validation ?? [],
        risks: report?.handoff.risks ?? [],
        followUps: report?.handoff.followUps ?? [],
        ...(report?.mergeRequest?.url
          ? { mergeRequestUrl: report.mergeRequest.url }
          : {}),
        ...(report?.ci?.status ? { ciStatus: report.ci.status } : {}),
        ...(nextAction !== undefined ? { nextAction } : {}),
      };
    },
  );

  return {
    workItemId: workItem.workItemId,
    overallStatus,
    taskSummaries,
    validationSummary: buildValidationSummary(entries),
    riskSummary: buildRiskSummary(entries),
    evidence: {
      index: evidenceIndex,
      byTask: evidenceByTask,
    },
    openQuestions: buildOpenQuestions(entries),
    recommendedNextActions: buildRecommendedNextActions(
      entries,
      overallStatus,
    ),
    generatedAt,
  };
}

function pickLatestLinkByTask(
  links: TaskRunLink[],
): Map<string, TaskRunLink> {
  const map = new Map<string, TaskRunLink>();
  for (const link of links) {
    const existing = map.get(link.taskId);
    if (!existing) {
      map.set(link.taskId, link);
      continue;
    }
    // Prefer higher attempt; tie-break by latest startedAt.
    if (
      link.attempt > existing.attempt ||
      (link.attempt === existing.attempt &&
        link.startedAt > existing.startedAt)
    ) {
      map.set(link.taskId, link);
    }
  }
  return map;
}

function decideOverallStatus(
  entries: Array<{
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  }>,
): WorkItemReportStatus {
  // V4.1 §15.2: missing data dominates anything else; we cannot
  // promise the parent reviewer that everything is partial / complete
  // until every task has at least produced a TaskRunLink + report.
  for (const e of entries) {
    if (!e.link) return "incomplete";
    if (e.link.status === "completed" && !e.report) return "incomplete";
  }

  const hasNonCompleted = entries.some((e) => {
    const status = e.link?.status ?? e.task.status;
    return (
      status === "failed" ||
      status === "blocked" ||
      status === "needs_rework" ||
      status === "skipped"
    );
  });
  if (hasNonCompleted) return "partial";

  const allCompleted = entries.every((e) => {
    const status = e.link?.status ?? e.task.status;
    return status === "completed";
  });
  if (!allCompleted) return "incomplete";

  return "complete";
}

function buildValidationSummary(
  entries: Array<{
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  }>,
): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.report) continue;
    const v = e.report.handoff.validation.join("; ");
    if (v) lines.push(`- ${e.task.taskId}: ${v}`);
  }
  return lines.length === 0 ? "No validation reported." : lines.join("\n");
}

function buildRiskSummary(
  entries: Array<{
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  }>,
): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.report) continue;
    for (const r of e.report.handoff.risks) {
      lines.push(`- ${e.task.taskId} (${r.level}): ${r.text}`);
    }
  }
  return lines.length === 0 ? "No risks reported." : lines.join("\n");
}

function buildOpenQuestions(
  entries: Array<{
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  }>,
): string[] {
  const questions: string[] = [];
  for (const e of entries) {
    const status = e.link?.status ?? e.task.status;
    if (status === "blocked" || status === "needs_rework") {
      const reason = e.task.statusReason ?? e.report?.run.lastError?.message;
      questions.push(
        `Task ${e.task.taskId} (${e.task.title}) needs operator decision${
          reason ? `: ${reason}` : "."
        }`,
      );
    }
  }
  return questions;
}

function buildRecommendedNextActions(
  entries: Array<{
    task: TaskNode;
    link: TaskRunLink | undefined;
    report: RunReportArtifact | undefined;
  }>,
  overallStatus: WorkItemReportStatus,
): string[] {
  const actions: string[] = [];
  const failedTasks = entries
    .filter((e) => (e.link?.status ?? e.task.status) === "failed")
    .map((e) => e.task.taskId);
  const blockedTasks = entries
    .filter((e) => {
      const s = e.link?.status ?? e.task.status;
      return s === "blocked" || s === "needs_rework";
    })
    .map((e) => e.task.taskId);
  const skippedTasks = entries
    .filter((e) => (e.link?.status ?? e.task.status) === "skipped")
    .map((e) => e.task.taskId);

  switch (overallStatus) {
    case "complete":
      actions.push(
        "All synthetic task runs completed. Move the parent Issue to human-review and ask the reviewer to inspect each MR.",
      );
      break;
    case "partial":
      if (failedTasks.length > 0) {
        actions.push(
          `Retry or skip the failed tasks: ${failedTasks.join(", ")}.`,
        );
      }
      if (blockedTasks.length > 0) {
        actions.push(
          `Resolve the blocking signal for: ${blockedTasks.join(", ")}.`,
        );
      }
      if (skippedTasks.length > 0) {
        actions.push(
          `Confirm the skipped tasks are intentional: ${skippedTasks.join(", ")}.`,
        );
      }
      actions.push(
        "Reviewer can still inspect the completed tasks while operators handle the rest.",
      );
      break;
    case "incomplete":
      actions.push(
        "Wait for in-flight task runs to settle, then re-run aggregation.",
      );
      break;
    case "draft":
      actions.push("Aggregation has not been performed yet.");
      break;
  }
  return actions;
}

function deriveTaskNextAction(
  status: TaskNodeStatus,
  report: RunReportArtifact | undefined,
): string | undefined {
  switch (status) {
    case "completed":
      return report?.handoff.nextAction ?? "Reviewer to inspect MR.";
    case "failed":
      return "Retry the task run or escalate to operator.";
    case "blocked":
    case "needs_rework":
      return "Operator must decide whether to retry, skip, or re-plan.";
    case "skipped":
      return "Skipped by operator.";
    case "running":
      return "In flight; recheck once the run settles.";
    default:
      return undefined;
  }
}
