import {
  effectiveTaskStatus,
  type TaskNode,
  type RunReportArtifact,
  type WorkItemEvidenceEntry,
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
  reports?: Pick<ReportStore, "all"> & {
    invalidReportCount?: () => number;
  };
  metadata?: {
    workflow?: string;
    taskType?: string;
  };
  workItems?: Pick<
    WorkItemStore,
    "listWorkItems" | "getCurrentPlan" | "listAllTaskRunLinks" | "getReport"
  >;
}

const UNKNOWN_BUCKET = "unknown";
const VALIDATION_EVIDENCE_KINDS = new Set<WorkItemEvidenceEntry["kind"]>([
  "validation",
  "screenshot",
  "playwright",
  "command_output",
  "test_result",
]);

function toRunSource(
  report: RunReportArtifact,
  metadata: QualityCollectorDeps["metadata"] | undefined,
): QualityRunSourceItem {
  return {
    kind: "run",
    projectId: report.issue.projectId,
    workflow: metadata?.workflow ?? UNKNOWN_BUCKET,
    taskType: metadata?.taskType ?? UNKNOWN_BUCKET,
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

function summarizeEvidence(evidence: WorkItemEvidenceEntry[]): {
  evidenceCount: number;
  validationEvidenceCount: number;
  trustedValidationEvidenceCount: number;
  aiClaimValidationEvidenceCount: number;
} {
  let validationEvidenceCount = 0;
  let trustedValidationEvidenceCount = 0;
  let aiClaimValidationEvidenceCount = 0;

  for (const entry of evidence) {
    if (!VALIDATION_EVIDENCE_KINDS.has(entry.kind)) continue;
    validationEvidenceCount += 1;
    if (entry.confidence === "ai-claim") {
      aiClaimValidationEvidenceCount += 1;
    } else {
      trustedValidationEvidenceCount += 1;
    }
  }

  return {
    evidenceCount: evidence.length,
    validationEvidenceCount,
    trustedValidationEvidenceCount,
    aiClaimValidationEvidenceCount,
  };
}

function inferTaskType(task: TaskNode): string {
  if (task.taskType && task.taskType.length > 0) return task.taskType;

  const text = [task.title, task.goal, task.scope, ...task.suggestedValidation]
    .join(" ")
    .toLowerCase();

  if (/\b(readme|doc|docs|markdown|copy|文档)\b/.test(text)) return "docs";
  if (/\b(test|vitest|e2e|playwright|coverage|测试)\b/.test(text)) {
    return "test";
  }
  if (
    /\b(ui|ux|dashboard|page|component|react|next|tailwind|页面)\b/.test(text)
  ) {
    return "frontend";
  }
  if (/\b(api|server|route|daemon|orchestrator|fastify|worker)\b/.test(text)) {
    return "backend";
  }
  if (/\b(ci|build|script|config|workflow|deploy|release|lint)\b/.test(text)) {
    return "infra";
  }
  return UNKNOWN_BUCKET;
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
  let invalidReportCount = 0;

  if (deps.reports) {
    const allReports = await deps.reports.all();
    invalidReportCount = deps.reports.invalidReportCount?.() ?? 0;
    for (const report of allReports) {
      items.push(toRunSource(report, deps.metadata));
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
        const taskType = inferTaskType(task);

        const checklistReasons = (report?.humanReviewChecklist ?? [])
          .filter((entry) => entry.taskId === task.taskId)
          .map((entry) => entry.reason);

        const evidence = report?.evidence.byTask[task.taskId] ?? [];
        const evidenceSummary = summarizeEvidence(evidence);

        const item: QualityTaskSourceItem = {
          kind: "task",
          projectId: workItem.sourceIssue.projectId,
          workflow: deps.metadata?.workflow ?? UNKNOWN_BUCKET,
          taskType:
            taskType !== UNKNOWN_BUCKET
              ? taskType
              : (deps.metadata?.taskType ?? UNKNOWN_BUCKET),
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
          ...evidenceSummary,
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
    diagnostics: { invalidReportCount },
  };
}
