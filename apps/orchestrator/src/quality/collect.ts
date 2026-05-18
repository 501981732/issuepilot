import {
  effectiveTaskStatus,
  type RunReportArtifact,
} from "@issuepilot/shared-contracts";

import type { ReportStore } from "../reports/store.js";
import type { WorkItemStore } from "../work-items/store.js";

import type {
  QualityCollectionResult,
  QualityRunSourceItem,
  QualitySourceItem,
  QualityTaskSourceItem,
} from "./types.js";

/**
 * Dependency surface needed to collect V4.4 quality source items. Both stores
 * are optional so the orchestrator can degrade gracefully when work-item
 * aggregation is not wired (run-only deployments).
 */
export interface QualityCollectorDeps {
  reports?: Pick<ReportStore, "all">;
  workItems?: Pick<
    WorkItemStore,
    | "listWorkItems"
    | "getCurrentPlan"
    | "listAllTaskRunLinks"
    | "getReport"
  >;
}

const UNKNOWN_BUCKET = "unknown";

function toRunSource(report: RunReportArtifact): QualityRunSourceItem {
  return {
    kind: "run",
    projectId: report.issue.projectId,
    workflow: UNKNOWN_BUCKET,
    taskType: UNKNOWN_BUCKET,
    runId: report.runId,
    runStatus: report.run.status,
    issue: report.issue,
    ...(report.ci?.status ? { ciStatus: report.ci.status } : {}),
    checks: report.checks,
    ...(report.reviewFeedback ? { reviewFeedback: report.reviewFeedback } : {}),
    risks: report.handoff.risks,
    ...(report.run.lastError ? { lastError: report.run.lastError } : {}),
    ...(report.run.durations.totalMs !== undefined
      ? { totalMs: report.run.durations.totalMs }
      : {}),
    updatedAt: report.run.endedAt ?? report.run.startedAt,
  };
}

/**
 * Collects normalized quality source items from the local stores. The function
 * performs no metric math — it only normalizes data so the downstream filters
 * and aggregator can operate on a uniform shape. Diagnostics carry the count
 * of report files the underlying stores already skipped due to parse errors.
 */
export async function collectQualitySources(
  deps: QualityCollectorDeps,
): Promise<QualityCollectionResult> {
  const items: QualitySourceItem[] = [];

  if (deps.reports) {
    const allReports = await deps.reports.all();
    for (const report of allReports) {
      items.push(toRunSource(report));
    }
  }

  if (deps.workItems) {
    const workItems = await deps.workItems.listWorkItems();
    for (const workItem of workItems) {
      const [plan, links, report] = await Promise.all([
        deps.workItems.getCurrentPlan(workItem.workItemId),
        deps.workItems.listAllTaskRunLinks(workItem.workItemId),
        deps.workItems.getReport(workItem.workItemId),
      ]);
      if (!plan) continue;

      for (const task of plan.tasks) {
        const taskLinks = links.filter((link) => link.taskId === task.taskId);
        const latestLink = [...taskLinks].sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        )[0];
        const taskStatus = effectiveTaskStatus(task, latestLink);

        const checklistReasons = (report?.humanReviewChecklist ?? [])
          .filter((entry) => entry.taskId === task.taskId)
          .map((entry) => entry.reason);

        const evidence = report?.evidence.byTask[task.taskId] ?? [];

        const item: QualityTaskSourceItem = {
          kind: "task",
          projectId: workItem.sourceIssue.projectId,
          workflow: UNKNOWN_BUCKET,
          taskType: UNKNOWN_BUCKET,
          workItemId: workItem.workItemId,
          workItemTitle: workItem.title,
          taskId: task.taskId,
          taskTitle: task.title,
          taskStatus,
          ...(latestLink?.runId ? { runId: latestLink.runId } : {}),
          ...(report?.overallStatus
            ? { reportStatus: report.overallStatus }
            : {}),
          ...(task.needsReworkReason
            ? { needsReworkReason: task.needsReworkReason }
            : {}),
          checklistReasons,
          evidenceCount: evidence.length,
          updatedAt:
            latestLink?.completedAt ??
            latestLink?.startedAt ??
            report?.generatedAt ??
            workItem.updatedAt,
        };
        items.push(item);
      }
    }
  }

  return {
    items,
    diagnostics: { invalidReportCount: 0 },
  };
}
