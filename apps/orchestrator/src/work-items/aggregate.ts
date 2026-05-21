import {
  effectiveTaskStatus,
  type ReviewReworkPlan,
  type ReviewReworkSummary,
  type RunReportArtifact,
  type TaskNode,
  type TaskNodeStatus,
  type TaskPlan,
  type TaskRunLink,
  type WorkItem,
  type WorkItemEvidenceEntry,
  type WorkItemReport,
  type WorkItemReportStatus,
} from "@issuepilot/shared-contracts";

import { deriveEvidenceId } from "./evidence-id.js";

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
  getEvidenceConfirmations?(
    workItemId: string,
  ): Promise<Record<string, { confirmedBy: string; confirmedAt: string }>>;
  /**
   * V4.9 Intelligent Review Workflow: optional accessor returning the
   * latest `ReviewReworkPlan`s known for this WorkItem. The aggregator
   * uses it to populate `WorkItemReport.reviewReworkSummary` so the
   * Parent Review Packet can render counts without re-reading the
   * plan store from the dashboard tier. Callers wire this to
   * `reviewWorkflowService.list({ workItemId })`.
   */
  getReviewReworkPlans?(workItemId: string): Promise<ReviewReworkPlan[]>;
  now?(): string;
}

/**
 * V4.9 §6.2 / §9.2: collapse an array of plans into the
 * per-WorkItem `ReviewReworkSummary` snapshot. Only `accepted` plans
 * contribute to the blocking / accepted / resolved counters because
 * `draft` / `dismissed` / `superseded` plans are not actionable from
 * the agent's perspective. `latestPlanIds` keeps the full pointer
 * list so dashboards can deep-link to historical plans.
 */
export function aggregateReviewRework(
  plans: ReviewReworkPlan[],
): ReviewReworkSummary | undefined {
  if (plans.length === 0) return undefined;
  const summary: ReviewReworkSummary = {
    blockingCount: 0,
    acceptedCount: 0,
    resolvedCount: 0,
    perTask: {},
    latestPlanIds: plans.map((p) => p.planId),
  };
  for (const plan of plans) {
    if (plan.status !== "accepted") continue;
    const taskKey = plan.taskId ?? "_workitem";
    const bucket = summary.perTask[taskKey] ?? {
      blocking: 0,
      accepted: 0,
      resolved: 0,
    };
    for (const item of plan.items) {
      if (item.status === "accepted") {
        summary.acceptedCount += 1;
        bucket.accepted += 1;
        if (item.priority === "blocking") {
          summary.blockingCount += 1;
          bucket.blocking += 1;
        }
      } else if (item.status === "resolved") {
        summary.resolvedCount += 1;
        bucket.resolved += 1;
      }
    }
    summary.perTask[taskKey] = bucket;
  }
  return summary;
}

export interface AggregateResult {
  report: WorkItemReport;
  missing: Array<{
    taskId: string;
    reason: "no-run-report" | "no-link" | "incomplete-report";
  }>;
}

type MissingEvidence = AggregateResult["missing"][number];

type AggregateEntry = {
  task: TaskNode;
  link: TaskRunLink | undefined;
  report: RunReportArtifact | undefined;
};

export async function aggregateWorkItem(
  workItem: WorkItem,
  plan: TaskPlan,
  links: TaskRunLink[],
  deps: AggregateDeps,
): Promise<AggregateResult> {
  const generatedAt = deps.now?.() ?? new Date().toISOString();
  const confirmations =
    (await deps.getEvidenceConfirmations?.(workItem.workItemId)) ?? {};

  // Pick the latest TaskRunLink per task so retries are reflected.
  const latestLinkByTask = pickLatestLinkByTask(links);

  const entries: AggregateEntry[] = [];
  for (const task of plan.tasks) {
    const link = latestLinkByTask.get(task.taskId);
    const report = link ? await deps.getRunReport(link.runId) : undefined;
    entries.push({ task, link, report });
  }

  const missing = deriveMissing(entries);
  const overallStatus = decideOverallStatus(entries);

  const evidenceIndex: WorkItemEvidenceEntry[] = [];
  const evidenceByTask: Record<string, WorkItemEvidenceEntry[]> = {};

  const taskSummaries: WorkItemReport["taskSummaries"] = entries.map(
    ({ task, link, report }) => {
      const status: TaskNodeStatus = effectiveTaskStatus(task, link);
      const taskEvidence: WorkItemEvidenceEntry[] = [];
      const duplicateSeedCounts = new Map<string, number>();
      const stableSeed = (input: {
        kind: WorkItemEvidenceEntry["kind"];
        runId: string;
        parts: string[];
      }): string =>
        stableOccurrenceSeed(duplicateSeedCounts, {
          taskId: task.taskId,
          kind: input.kind,
          runId: input.runId,
          parts: input.parts,
        });

      if (report) {
        if (report.diff?.summary) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: "diff",
                label: `Diff: ${report.diff.filesChanged} file(s) changed`,
                text: report.diff.summary,
                confidence: "ai-claim",
                seed: stableSeed({
                  kind: "diff",
                  runId: report.runId,
                  parts: [
                    String(report.diff.filesChanged),
                    report.diff.summary,
                    ...report.diff.notableFiles,
                  ],
                }),
              }),
              confirmations,
            ),
          );
        }
        for (const v of report.handoff?.validation ?? []) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: "validation",
                label: "Validation",
                text: v,
                confidence: "ai-claim",
                seed: stableSeed({
                  kind: "validation",
                  runId: report.runId,
                  parts: [v],
                }),
              }),
              confirmations,
            ),
          );
        }
        for (const r of report.handoff?.risks ?? []) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: "risk",
                label: `Risk (${r.level})`,
                text: r.text,
                confidence: "ai-claim",
                seed: stableSeed({
                  kind: "risk",
                  runId: report.runId,
                  parts: [r.level, r.text],
                }),
              }),
              confirmations,
            ),
          );
        }
        if (report.ci) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: "ci",
                label: `CI: ${normalizeCiStatus(report.ci.status)}`,
                confidence: "system-derived",
                ...(report.ci.pipelineUrl
                  ? { href: report.ci.pipelineUrl }
                  : {}),
                capturedAt: report.ci.checkedAt,
                seed: stableSeed({
                  kind: "ci",
                  runId: report.runId,
                  parts: [report.ci.pipelineUrl ?? "ci"],
                }),
              }),
              confirmations,
            ),
          );
        }
        if (report.reviewFeedback) {
          for (const c of report.reviewFeedback.comments) {
            taskEvidence.push(
              applyConfirmation(
                buildEvidenceEntry({
                  taskId: task.taskId,
                  runId: report.runId,
                  kind: "review_feedback",
                  label: `Reviewer: ${c.author}${
                    c.resolved ? " (resolved)" : ""
                  }`,
                  href: c.url,
                  text: c.body,
                  confidence: "ai-claim",
                  capturedAt: c.createdAt,
                  seed: stableSeed({
                    kind: "review_feedback",
                    runId: report.runId,
                    parts: [c.url || c.body || c.author],
                  }),
                }),
                confirmations,
              ),
            );
          }
        }
        for (const evidence of report.evidence ?? []) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: evidence.kind,
                label: evidence.label,
                confidence:
                  evidence.confidence === "system-derived"
                    ? "system-derived"
                    : "ai-claim",
                ...(evidence.href ? { href: evidence.href } : {}),
                ...(evidence.mediaType
                  ? { mediaType: evidence.mediaType }
                  : {}),
                ...(evidence.capturedAt
                  ? { capturedAt: evidence.capturedAt }
                  : {}),
                ...(evidence.relPath
                  ? {
                      source: {
                        runId: report.runId,
                        relPath: evidence.relPath,
                      },
                    }
                  : {}),
                seed: stableSeed({
                  kind: evidence.kind,
                  runId: report.runId,
                  parts: [evidence.relPath ?? evidence.href ?? evidence.label],
                }),
              }),
              confirmations,
            ),
          );
        }
        for (const check of Array.isArray(report.checks) ? report.checks : []) {
          taskEvidence.push(
            applyConfirmation(
              buildEvidenceEntry({
                taskId: task.taskId,
                runId: report.runId,
                kind: "test_result",
                label: `Check ${check.status}: ${check.name}`,
                text: formatCheckText(check),
                confidence: "system-derived",
                seed: stableSeed({
                  kind: "test_result",
                  runId: report.runId,
                  parts: [stableCheckIdentity(check)],
                }),
              }),
              confirmations,
            ),
          );
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
        ...(report?.diff?.summary ? { diffSummary: report.diff.summary } : {}),
        validation: report?.handoff?.validation ?? [],
        risks: report?.handoff?.risks ?? [],
        followUps: report?.handoff?.followUps ?? [],
        ...(report?.mergeRequest?.url
          ? { mergeRequestUrl: report.mergeRequest.url }
          : {}),
        ...(report?.ci?.status ? { ciStatus: report.ci.status } : {}),
        ...(nextAction !== undefined ? { nextAction } : {}),
      };
    },
  );

  const ciSummary = buildCiSummary(entries);
  const reviewReworkPlans =
    (await deps.getReviewReworkPlans?.(workItem.workItemId)) ?? [];
  const reviewReworkSummary = aggregateReviewRework(reviewReworkPlans);
  const report: WorkItemReport = {
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
    recommendedNextActions: buildRecommendedNextActions(entries, overallStatus),
    humanReviewChecklist: buildHumanReviewChecklist(
      entries,
      missing,
      overallStatus,
      ciSummary,
    ),
    ...(ciSummary ? { ciSummary } : {}),
    testSummary: buildTestSummary(entries),
    ...(reviewReworkSummary ? { reviewReworkSummary } : {}),
    generatedAt,
  };

  return { report, missing };
}

function buildEvidenceEntry(
  entry: Omit<WorkItemEvidenceEntry, "evidenceId"> & {
    runId: string;
    seed?: string;
  },
): WorkItemEvidenceEntry {
  const { runId, seed, ...rest } = entry;
  return {
    ...rest,
    source: rest.source ?? { runId },
    evidenceId: deriveEvidenceId({
      taskId: rest.taskId,
      kind: rest.kind,
      runId,
      seed:
        seed ??
        legacySeed({
          taskId: rest.taskId,
          kind: rest.kind,
          runId,
          parts: [
            rest.label,
            rest.text ?? "",
            rest.href ?? "",
            rest.mediaType ?? "",
            rest.capturedAt ?? "",
          ],
        }),
    }),
  };
}

function legacySeed(input: {
  taskId: string;
  kind: WorkItemEvidenceEntry["kind"];
  runId: string;
  parts: string[];
}): string {
  return [input.taskId, input.kind, input.runId, ...input.parts].join("\n");
}

function stableOccurrenceSeed(
  counts: Map<string, number>,
  input: {
    taskId: string;
    kind: WorkItemEvidenceEntry["kind"];
    runId: string;
    parts: string[];
  },
): string {
  const base = legacySeed(input);
  const seen = counts.get(base) ?? 0;
  counts.set(base, seen + 1);
  return seen === 0 ? base : `${base}\nduplicate:${seen + 1}`;
}

function stableCheckIdentity(
  check: RunReportArtifact["checks"][number],
): string {
  if (check.name && check.command) return `${check.name}\n${check.command}`;
  return check.name || check.command || check.details || "check";
}

function applyConfirmation(
  entry: WorkItemEvidenceEntry,
  confirmations: Record<string, { confirmedBy: string; confirmedAt: string }>,
): WorkItemEvidenceEntry {
  const confirmation = confirmations[entry.evidenceId];
  if (!confirmation) return entry;
  return {
    ...entry,
    confidence: "human-confirmed",
    confirmedBy: confirmation.confirmedBy,
    confirmedAt: confirmation.confirmedAt,
  };
}

function pickLatestLinkByTask(links: TaskRunLink[]): Map<string, TaskRunLink> {
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
      (link.attempt === existing.attempt && link.startedAt > existing.startedAt)
    ) {
      map.set(link.taskId, link);
    }
  }
  return map;
}

function deriveMissing(entries: AggregateEntry[]): MissingEvidence[] {
  const missing: MissingEvidence[] = [];
  for (const e of entries) {
    if (isOperatorSettled(e.task)) continue;
    if (!e.link) {
      missing.push({ taskId: e.task.taskId, reason: "no-link" });
      continue;
    }
    if (linkShouldHaveRunReport(e.link) && !e.report) {
      missing.push({ taskId: e.task.taskId, reason: "no-run-report" });
      continue;
    }
    if (e.report && !hasRequiredReportStructures(e.report)) {
      missing.push({ taskId: e.task.taskId, reason: "incomplete-report" });
    }
  }
  return missing;
}

function isOperatorSettled(task: TaskNode): boolean {
  return task.status === "skipped" || task.status === "needs_rework";
}

function linkShouldHaveRunReport(link: TaskRunLink): boolean {
  return (
    link.status === "completed" ||
    link.status === "failed" ||
    link.status === "blocked"
  );
}

function hasRequiredReportStructures(report: RunReportArtifact): boolean {
  return Boolean(
    report.diff &&
    report.handoff &&
    Array.isArray(report.handoff.validation) &&
    Array.isArray(report.handoff.risks) &&
    Array.isArray(report.handoff.followUps) &&
    Array.isArray(report.checks),
  );
}

/**
 * Combine TaskNode + TaskRunLink status into the effective status we
 * surface to aggregation / dashboard.
 *
 * Default: trust the latest `TaskRunLink.status` over the node — runs
 * are the source of truth when present.
 *
 * V4.2 carve-out: when the operator has explicitly set
 * `task.status` to `needs_rework` or `skipped`, that intent must
 * override any historical link status. Otherwise `markNeedsRework`
 * called on a completed task would be a silent no-op (the link still
 * says `completed`, aggregate still says `complete`, parent label
 * never moves back). The same applies to operator-driven skip on a
 * task that already has a TaskRunLink (the link is preserved for
 * audit, but the task is now off-plan).
 */
function decideOverallStatus(entries: AggregateEntry[]): WorkItemReportStatus {
  // V4.1 §15.2: missing data dominates anything else; we cannot
  // promise the parent reviewer that everything is partial / complete
  // until every task has at least produced a TaskRunLink + report.
  // V4.2: operator-skipped / needs_rework tasks bypass this check —
  // a skipped task is intentional and should not gate completion.
  // V4.1 §15.2 / V4.2 carve-out:
  //  - Any task that lacks a TaskRunLink and is not operator-driven
  //    (skipped / needs_rework) blocks a partial / complete verdict
  //    — the run has not produced evidence yet.
  //  - Any task whose terminal link should have a run report
  //    (`completed` / `failed` / `blocked`) but has none is missing
  //    evidence; same outcome.
  //  - Operator-driven skip / needs_rework are themselves settled
  //    states and do not block a verdict, even with no link present.
  for (const e of entries) {
    if (isOperatorSettled(e.task)) continue;
    if (!e.link) return "incomplete";
    if (linkShouldHaveRunReport(e.link) && !e.report) return "incomplete";
    if (e.report && !hasRequiredReportStructures(e.report)) {
      return "incomplete";
    }
    // Link still in-flight (running / blocked-by-deps via task.status
    // resolving to a non-settled value) keeps WorkItem in-flight.
    const status = effectiveTaskStatus(e.task, e.link);
    const isInflight =
      status === "running" ||
      status === "ready" ||
      status === "planned" ||
      status === "blocked_by_dependency";
    if (isInflight) return "incomplete";
  }

  const hasNonCompleted = entries.some((e) => {
    const status = effectiveTaskStatus(e.task, e.link);
    return (
      status === "failed" ||
      status === "blocked" ||
      status === "needs_rework" ||
      status === "skipped"
    );
  });
  if (hasNonCompleted) return "partial";

  const allCompleted = entries.every((e) => {
    const status = effectiveTaskStatus(e.task, e.link);
    return status === "completed";
  });
  if (!allCompleted) return "incomplete";

  return "complete";
}

function buildValidationSummary(entries: AggregateEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.report) continue;
    const v = (e.report.handoff?.validation ?? []).join("; ");
    if (v) lines.push(`- ${e.task.taskId}: ${v}`);
  }
  return lines.length === 0 ? "No validation reported." : lines.join("\n");
}

function buildRiskSummary(entries: AggregateEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (!e.report) continue;
    for (const r of e.report.handoff?.risks ?? []) {
      lines.push(`- ${e.task.taskId} (${r.level}): ${r.text}`);
    }
  }
  return lines.length === 0 ? "No risks reported." : lines.join("\n");
}

function buildOpenQuestions(entries: AggregateEntry[]): string[] {
  const questions: string[] = [];
  for (const e of entries) {
    const status = effectiveTaskStatus(e.task, e.link);
    if (status === "blocked" || status === "needs_rework") {
      const reason =
        e.task.needsReworkReason ??
        e.task.statusReason ??
        e.report?.run?.lastError?.message;
      questions.push(
        `Task ${e.task.taskId} (${e.task.title}) needs operator decision${
          reason ? `: ${reason}` : "."
        }`,
      );
    }
    for (const followUp of e.report?.handoff?.followUps ?? []) {
      if (
        followUp.startsWith("evidence oversized:") ||
        followUp.startsWith("evidence rejected:")
      ) {
        questions.push(`Task ${e.task.taskId} evidence issue: ${followUp}`);
      }
    }
  }
  return questions;
}

function buildRecommendedNextActions(
  entries: AggregateEntry[],
  overallStatus: WorkItemReportStatus,
): string[] {
  const actions: string[] = [];
  const failedTasks = entries
    .filter((e) => effectiveTaskStatus(e.task, e.link) === "failed")
    .map((e) => e.task.taskId);
  const blockedTasks = entries
    .filter((e) => {
      const s = effectiveTaskStatus(e.task, e.link);
      return s === "blocked" || s === "needs_rework";
    })
    .map((e) => e.task.taskId);
  const skippedTasks = entries
    .filter((e) => effectiveTaskStatus(e.task, e.link) === "skipped")
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

function buildCiSummary(
  entries: AggregateEntry[],
): WorkItemReport["ciSummary"] | undefined {
  const perTask: NonNullable<WorkItemReport["ciSummary"]>["perTask"] = {};
  const statuses: Array<NonNullable<WorkItemReport["ciSummary"]>["overall"]> =
    [];

  for (const e of entries) {
    const ci = e.report?.ci;
    if (!ci) continue;
    const status = normalizeCiStatus(ci.status);
    statuses.push(status);
    perTask[e.task.taskId] = {
      status,
      ...(ci.pipelineUrl ? { pipelineUrl: ci.pipelineUrl } : {}),
    };
  }

  if (statuses.length === 0) return undefined;
  return {
    overall: deriveWorstCiStatus(statuses),
    perTask,
  };
}

function normalizeCiStatus(
  status: NonNullable<RunReportArtifact["ci"]>["status"],
): NonNullable<WorkItemReport["ciSummary"]>["overall"] {
  switch (status) {
    case "success":
      return "passed";
    case "failed":
    case "canceled":
      return "failed";
    case "running":
    case "pending":
      return "running";
    case "unknown":
      return "unknown";
  }
}

function deriveWorstCiStatus(
  statuses: Array<NonNullable<WorkItemReport["ciSummary"]>["overall"]>,
): NonNullable<WorkItemReport["ciSummary"]>["overall"] {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("passed")) return "passed";
  return "unknown";
}

function buildTestSummary(
  entries: AggregateEntry[],
): NonNullable<WorkItemReport["testSummary"]> {
  const summary: NonNullable<WorkItemReport["testSummary"]> = {
    passed: 0,
    failed: 0,
    skipped: 0,
    unknown: 0,
    perTask: {},
  };

  for (const e of entries) {
    const checks = Array.isArray(e.report?.checks) ? e.report.checks : [];
    const taskCounts = { passed: 0, failed: 0, skipped: 0, unknown: 0 };
    for (const check of checks) {
      taskCounts[check.status] += 1;
      summary[check.status] += 1;
    }
    if (checks.length > 0) {
      summary.perTask[e.task.taskId] = taskCounts;
    }
  }

  return summary;
}

function buildHumanReviewChecklist(
  entries: AggregateEntry[],
  missing: MissingEvidence[],
  overallStatus: WorkItemReportStatus,
  ciSummary: WorkItemReport["ciSummary"] | undefined,
): WorkItemReport["humanReviewChecklist"] {
  const items: WorkItemReport["humanReviewChecklist"] = [];
  const seen = new Set<string>();
  const add = (input: Omit<(typeof items)[number], "confirmed">): void => {
    if (seen.has(input.itemId)) return;
    seen.add(input.itemId);
    items.push({ ...input, confirmed: false });
  };

  for (const e of entries) {
    for (const risk of e.report?.handoff?.risks ?? []) {
      if (risk.level === "medium") {
        add({
          itemId: `ai-risk-medium:${e.task.taskId}`,
          taskId: e.task.taskId,
          label: `Review medium AI risk for ${e.task.taskId}`,
          reason: "ai-risk-medium",
        });
      }
      if (risk.level === "high") {
        add({
          itemId: `ai-risk-high:${e.task.taskId}`,
          taskId: e.task.taskId,
          label: `Review high AI risk for ${e.task.taskId}`,
          reason: "ai-risk-high",
        });
      }
    }

    const status = effectiveTaskStatus(e.task, e.link);
    if (status === "needs_rework") {
      add({
        itemId: `needs-rework:${e.task.taskId}`,
        taskId: e.task.taskId,
        label: `Resolve needs-rework task ${e.task.taskId}`,
        reason: "needs-rework",
      });
    }
    if (status === "skipped") {
      add({
        itemId: `skipped-task:${e.task.taskId}`,
        taskId: e.task.taskId,
        label: `Confirm skipped task ${e.task.taskId}`,
        reason: "skipped-task",
      });
    }
  }

  if (overallStatus === "partial") {
    add({
      itemId: "partial-overall:workItem",
      label: "Review partial work item outcome",
      reason: "partial-overall",
    });
  }

  for (const m of missing) {
    add({
      itemId: `missing-evidence:${m.taskId}`,
      taskId: m.taskId,
      label: `Resolve missing evidence for ${m.taskId}: ${m.reason}`,
      reason: "missing-evidence",
    });
  }

  if (ciSummary?.overall === "failed") {
    add({
      itemId: "ci-failed:workItem",
      label: "Review failed CI before handoff",
      reason: "ci-failed",
    });
  }

  return items;
}

function formatCheckText(check: RunReportArtifact["checks"][number]): string {
  const parts = [`status: ${check.status}`];
  if (check.command) parts.push(`command: ${check.command}`);
  if (check.durationMs !== undefined) {
    parts.push(`durationMs: ${check.durationMs}`);
  }
  if (check.details) parts.push(`details: ${check.details}`);
  return parts.join("\n");
}

function deriveTaskNextAction(
  status: TaskNodeStatus,
  report: RunReportArtifact | undefined,
): string | undefined {
  switch (status) {
    case "completed":
      return report?.handoff?.nextAction ?? "Reviewer to inspect MR.";
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
