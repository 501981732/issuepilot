import type {
  HumanReviewChecklistItem,
  TaskNode,
  TaskPlan,
  WorkItem,
  WorkItemEvidenceEntry,
  WorkItemReport,
  WorkItemReportStatus,
  WorkItemTaskSummary,
} from "@issuepilot/shared-contracts";

export interface RenderReportOptions {
  audience: "gitlab" | "markdown";
  evidenceBaseHref?: string;
}

export function renderWorkItemReportMarkdown(
  workItem: WorkItem,
  plan: TaskPlan,
  report: WorkItemReport,
  options: RenderReportOptions,
): string {
  const lines: string[] = [];

  lines.push(
    options.audience === "markdown"
      ? `# Parent Review Packet — ${safeOneLine(workItem.title)}`
      : `## IssuePilot work item handoff — ${safeOneLine(workItem.title)}`,
  );
  lines.push("");
  lines.push(`- Source Issue: ${safeOneLine(workItem.sourceIssue.url)}`);
  lines.push(
    `- Status: ${overallStatusLabel(report.overallStatus)} (${report.overallStatus})`,
  );
  lines.push(`- Plan version: ${plan.version}`);
  lines.push(`- Tasks: ${plan.tasks.length}`);
  lines.push(`- Generated at: ${safeOneLine(report.generatedAt)}`);

  renderChecklist(lines, report.humanReviewChecklist);
  renderTaskSummary(lines, plan, report.taskSummaries);
  renderValidation(lines, report);
  renderRisks(lines, report);
  renderCi(lines, report);
  renderTests(lines, report);
  renderEvidence(lines, plan, report, options);
  renderOpenQuestions(lines, report);
  renderRecommendedNextActions(lines, report);

  lines.push("");
  lines.push(`_Generated at ${safeOneLine(report.generatedAt)}._`);

  return lines.join("\n");
}

function renderChecklist(
  lines: string[],
  checklist: HumanReviewChecklistItem[],
): void {
  if (checklist.length === 0) return;

  lines.push("");
  lines.push("### Human review checklist");
  lines.push("");
  for (const item of [...checklist].sort((a, b) =>
    a.itemId.localeCompare(b.itemId),
  )) {
    const box = item.confirmed ? "[x]" : "[ ]";
    const suffix = item.confirmed
      ? confirmationSuffix(item.confirmedBy, item.confirmedAt)
      : "";
    lines.push(`- ${box} ${safeOneLine(item.label)}${suffix}`);
  }
}

function renderTaskSummary(
  lines: string[],
  plan: TaskPlan,
  summaries: WorkItemTaskSummary[],
): void {
  if (summaries.length === 0) return;

  lines.push("");
  lines.push("### Task summary");
  lines.push("");
  for (const summary of sortTaskSummaries(plan, summaries)) {
    lines.push(
      `- **${safeOneLine(summary.title)}** (${summary.taskId}) — \`${summary.taskStatus}\``,
    );
    if (summary.diffSummary) {
      lines.push(`  - Diff: ${safeOneLine(summary.diffSummary)}`);
    }
    if (summary.mergeRequestUrl) {
      lines.push(`  - MR: ${safeOneLine(summary.mergeRequestUrl)}`);
    }
    if (summary.ciStatus) {
      lines.push(`  - CI: ${safeOneLine(summary.ciStatus)}`);
    }
    if (summary.validation.length > 0) {
      lines.push(
        `  - Validation: ${summary.validation.map(safeOneLine).join("; ")}`,
      );
    }
    if (summary.risks.length > 0) {
      lines.push(
        `  - Risks: ${summary.risks
          .map((r) => `(${r.level}) ${safeOneLine(r.text)}`)
          .join("; ")}`,
      );
    }
    if (summary.followUps.length > 0) {
      lines.push(
        `  - Follow-ups: ${summary.followUps.map(safeOneLine).join("; ")}`,
      );
    }
    if (summary.nextAction) {
      lines.push(`  - Next: ${safeOneLine(summary.nextAction)}`);
    }
  }
}

function renderValidation(lines: string[], report: WorkItemReport): void {
  if (!report.validationSummary) return;

  lines.push("");
  lines.push("### Validation");
  lines.push(safeOneLine(report.validationSummary));
}

function renderRisks(lines: string[], report: WorkItemReport): void {
  if (!report.riskSummary) return;

  lines.push("");
  lines.push("### Risks");
  lines.push(safeOneLine(report.riskSummary));
}

function renderCi(lines: string[], report: WorkItemReport): void {
  if (!report.ciSummary) return;

  lines.push("");
  lines.push("### CI");
  lines.push("");
  lines.push(`- Overall: ${report.ciSummary.overall}`);
  for (const taskId of Object.keys(report.ciSummary.perTask).sort()) {
    const item = report.ciSummary.perTask[taskId];
    if (!item) continue;
    const pipeline = item.pipelineUrl
      ? ` — ${safeOneLine(item.pipelineUrl)}`
      : "";
    lines.push(`- ${taskId}: ${safeOneLine(item.status)}${pipeline}`);
  }
}

function renderTests(lines: string[], report: WorkItemReport): void {
  if (!report.testSummary) return;

  lines.push("");
  lines.push("### Tests");
  lines.push("");
  lines.push(
    `- Total: ${report.testSummary.passed} passed, ${report.testSummary.failed} failed, ${report.testSummary.skipped} skipped, ${report.testSummary.unknown} unknown`,
  );
  for (const taskId of Object.keys(report.testSummary.perTask).sort()) {
    const item = report.testSummary.perTask[taskId];
    if (!item) continue;
    lines.push(
      `- ${taskId}: ${item.passed} passed, ${item.failed} failed, ${item.skipped} skipped, ${item.unknown} unknown`,
    );
  }
}

function renderEvidence(
  lines: string[],
  plan: TaskPlan,
  report: WorkItemReport,
  options: RenderReportOptions,
): void {
  const grouped = groupedEvidence(report);
  const taskIds = stableEvidenceTaskIds(plan, grouped);
  if (taskIds.length === 0) return;

  lines.push("");
  lines.push("### Evidence");
  for (const taskId of taskIds) {
    const entries = [...(grouped.get(taskId)?.values() ?? [])].sort((a, b) =>
      a.evidenceId.localeCompare(b.evidenceId),
    );
    if (entries.length === 0) continue;

    lines.push("");
    lines.push(`#### ${safeOneLine(taskTitle(plan, taskId))} (${taskId})`);
    for (const entry of entries) {
      const rendered = renderEvidenceEntry(entry, options);
      const detail = entry.text ? ` — ${safeOneLine(entry.text)}` : "";
      lines.push(`- ${rendered} (${entry.confidence})${detail}`);
    }
  }
}

function renderOpenQuestions(lines: string[], report: WorkItemReport): void {
  if (report.openQuestions.length === 0) return;

  lines.push("");
  lines.push("### Open questions");
  lines.push("");
  for (const question of report.openQuestions.map(safeOneLine).sort()) {
    lines.push(`- ${question}`);
  }
}

function renderRecommendedNextActions(
  lines: string[],
  report: WorkItemReport,
): void {
  lines.push("");
  lines.push("### Recommended next actions");
  lines.push("");
  const actions = report.recommendedNextActions
    .map(safeOneLine)
    .filter((action) => action.length > 0);
  if (actions.length === 0) {
    lines.push("- Reviewer to inspect the linked MRs and decide next steps.");
    return;
  }
  for (const action of actions) {
    lines.push(`- ${action}`);
  }
}

function sortTaskSummaries(
  plan: TaskPlan,
  summaries: WorkItemTaskSummary[],
): WorkItemTaskSummary[] {
  const taskOrder = new Map(
    plan.tasks.map((task, index) => [task.taskId, index]),
  );
  return [...summaries].sort((a, b) => {
    const orderA = taskOrder.get(a.taskId) ?? Number.MAX_SAFE_INTEGER;
    const orderB = taskOrder.get(b.taskId) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.taskId.localeCompare(b.taskId);
  });
}

function groupedEvidence(
  report: WorkItemReport,
): Map<string, Map<string, WorkItemEvidenceEntry>> {
  const grouped = new Map<string, Map<string, WorkItemEvidenceEntry>>();

  const add = (entry: WorkItemEvidenceEntry): void => {
    const taskEntries = grouped.get(entry.taskId) ?? new Map();
    taskEntries.set(entry.evidenceId, entry);
    grouped.set(entry.taskId, taskEntries);
  };

  for (const taskId of Object.keys(report.evidence.byTask).sort()) {
    for (const entry of report.evidence.byTask[taskId] ?? []) {
      add(entry);
    }
  }
  for (const entry of report.evidence.index) {
    add(entry);
  }

  return grouped;
}

function stableEvidenceTaskIds(
  plan: TaskPlan,
  grouped: Map<string, Map<string, WorkItemEvidenceEntry>>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const task of plan.tasks) {
    if (grouped.has(task.taskId)) {
      seen.add(task.taskId);
      out.push(task.taskId);
    }
  }
  for (const taskId of [...grouped.keys()].sort()) {
    if (!seen.has(taskId)) out.push(taskId);
  }
  return out;
}

function renderEvidenceEntry(
  entry: WorkItemEvidenceEntry,
  options: RenderReportOptions,
): string {
  const label = safeOneLine(entry.label);
  const href =
    entry.source?.relPath && options.evidenceBaseHref
      ? evidenceHref(
          options.evidenceBaseHref,
          entry.source.runId,
          entry.source.relPath,
        )
      : entry.href;
  if (!href) return label;
  return `[${escapeMarkdownLinkText(label)}](${href})`;
}

function evidenceHref(
  baseHref: string,
  runId: string,
  relPath: string,
): string {
  const sep = baseHref.includes("?") ? "&" : "?";
  return `${baseHref}${sep}runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(relPath)}`;
}

function taskTitle(plan: TaskPlan, taskId: string): string {
  return (
    plan.tasks.find((task: TaskNode) => task.taskId === taskId)?.title ?? taskId
  );
}

function confirmationSuffix(
  by: string | undefined,
  at: string | undefined,
): string {
  if (by && at)
    return ` — confirmed by ${safeOneLine(by)} at ${safeOneLine(at)}`;
  if (by) return ` — confirmed by ${safeOneLine(by)}`;
  if (at) return ` — confirmed at ${safeOneLine(at)}`;
  return " — confirmed";
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

function safeOneLine(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ready_to_merge/gi, "human review")
    .replace(/ready\s+to\s+merge/gi, "human review");
}

function escapeMarkdownLinkText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}
