"use client";

import {
  effectiveTaskStatus,
  type MarkTaskReworkRequest,
  type ReplanTaskRequest,
  type TaskNode,
  type TaskNodeStatus,
  type TaskRunLink,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { MarkReworkDialog } from "./mark-rework-dialog";
import { ReplanTaskDialog } from "./replan-task-dialog";

const STATUS_GROUPS: TaskNodeStatus[] = [
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "needs_rework",
  "blocked_by_dependency",
  "skipped",
  "planned",
];

const STATUS_KEY_MAP: Record<TaskNodeStatus, string> = {
  ready: "groupReady",
  running: "groupRunning",
  running_coding: "groupRunning",
  running_reviewer: "groupRunning",
  running_test_evidence: "groupRunning",
  awaiting_human_review: "groupCompleted",
  completed: "groupCompleted",
  failed: "groupFailed",
  blocked: "groupBlocked",
  needs_rework: "groupNeedsRework",
  blocked_by_dependency: "groupBlockedByDependency",
  skipped: "groupSkipped",
  planned: "groupPlanned",
};

const STATUS_TONE: Record<TaskNodeStatus, string> = {
  ready: "bg-warning-soft text-warning-fg",
  running: "bg-info-soft text-info-fg",
  running_coding: "bg-info-soft text-info-fg",
  running_reviewer: "bg-info-soft text-info-fg",
  running_test_evidence: "bg-info-soft text-info-fg",
  awaiting_human_review: "bg-success-soft text-success-fg",
  completed: "bg-success-soft text-success-fg",
  failed: "bg-danger-soft text-danger-fg",
  blocked: "bg-danger-soft text-danger-fg",
  needs_rework: "bg-warning-soft text-warning-fg",
  blocked_by_dependency: "bg-info-soft text-info-fg",
  skipped: "bg-fg-subtle/20 text-fg-subtle",
  planned: "bg-fg-subtle/20 text-fg-subtle",
};

export interface TaskListProps {
  tasks: TaskNode[];
  runLinks?: TaskRunLink[];
  onSkip?: (taskId: string) => Promise<void> | void;
  onRetry?: (taskId: string) => Promise<void> | void;
  /**
   * V4.2: re-draft a single task via the planner. The callback should
   * call `replanWorkItemTask`; on success the caller is expected to
   * refresh the WorkItem so the new draft plan shows up.
   */
  onReplan?: (taskId: string, body: ReplanTaskRequest) => Promise<void> | void;
  /**
   * V4.2: operator-driven rework. The task transitions to
   * `needs_rework` and reconcileWorkItem catches up the parent Issue
   * label.
   */
  onMarkRework?: (
    taskId: string,
    body: MarkTaskReworkRequest,
  ) => Promise<void> | void;
  /** V4.2: roll back a previous skip; only visible on skipped tasks. */
  onUnskip?: (taskId: string) => Promise<void> | void;
  /** When false, skip / retry buttons are disabled (e.g. plan still in draft). */
  actionsEnabled?: boolean;
}

export function TaskList({
  tasks,
  runLinks = [],
  onSkip,
  onRetry,
  onReplan,
  onMarkRework,
  onUnskip,
  actionsEnabled = true,
}: TaskListProps) {
  const t = useTranslations("workItem.tasks");
  const [busy, setBusy] = useState<{
    taskId: string;
    action: "skip" | "retry" | "unskip";
  } | null>(null);
  const [replanFor, setReplanFor] = useState<TaskNode | null>(null);
  const [reworkFor, setReworkFor] = useState<TaskNode | null>(null);

  const linkByTask = new Map<string, TaskRunLink>();
  for (const link of runLinks) {
    const existing = linkByTask.get(link.taskId);
    if (!existing || link.attempt > existing.attempt) {
      linkByTask.set(link.taskId, link);
    }
  }

  // Group tasks by their (latest) status so operators see "what's
  // blocked / running / done" at a glance.
  const groups = new Map<TaskNodeStatus, TaskNode[]>();
  for (const task of tasks) {
    const link = linkByTask.get(task.taskId);
    // V4.2 review I1: operator-driven `needs_rework` / `skipped` on the
    // TaskNode must win over a historical TaskRunLink so the dashboard
    // groups / renders / picks buttons consistently with the
    // orchestrator's `aggregate.effectiveTaskStatus`. Otherwise an
    // operator who marked a `completed` task for rework would still
    // see it grouped under "Completed" with a Mark-rework button.
    const status = effectiveTaskStatus(task, link);
    const list = groups.get(status) ?? [];
    list.push(task);
    groups.set(status, list);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-4">
          {STATUS_GROUPS.filter((s) => groups.has(s)).map((status) => (
            <li key={status} className="flex flex-col gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                {t(STATUS_KEY_MAP[status])}
              </span>
              <ul className="flex flex-col gap-2">
                {(groups.get(status) ?? []).map((task) => {
                  const link = linkByTask.get(task.taskId);
                  const effectiveStatus = effectiveTaskStatus(task, link);
                  // V4.2 button-visibility table (see design plan §17):
                  //
                  // status                 | Skip | Retry | Mark rework | Replan | Unskip
                  // planned/ready/blocked_by_dependency | ✓ | — | — | ✓ | —
                  // running                            | — | — | — | ✓ | —
                  // completed                           | — | — | ✓ | ✓ | —
                  // failed/blocked                      | — | ✓ | ✓ | ✓ | —
                  // needs_rework                        | — | ✓ | — | ✓ | —
                  // skipped                             | — | — | — | ✓ | ✓
                  const showSkip =
                    effectiveStatus === "planned" ||
                    effectiveStatus === "ready" ||
                    effectiveStatus === "blocked_by_dependency";
                  const showRetry =
                    effectiveStatus === "failed" ||
                    effectiveStatus === "needs_rework" ||
                    effectiveStatus === "blocked";
                  const showMarkRework =
                    effectiveStatus === "completed" ||
                    effectiveStatus === "failed" ||
                    effectiveStatus === "blocked";
                  const showUnskip = effectiveStatus === "skipped";
                  const showReplan = Boolean(onReplan);

                  return (
                    <li
                      key={task.taskId}
                      className="flex flex-col gap-2 rounded-md border border-border/70 bg-surface-1 px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-fg">
                            {task.title}
                          </span>
                          <span className="font-mono text-[11px] text-fg-subtle">
                            {task.taskId} · risk {task.riskLevel}
                          </span>
                        </div>
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                            STATUS_TONE[effectiveStatus],
                          )}
                        >
                          {effectiveStatus}
                        </span>
                      </div>
                      {task.goal ? (
                        <p className="text-xs text-fg-muted">{task.goal}</p>
                      ) : null}
                      {task.statusReason ? (
                        <p className="text-xs text-warning-fg">
                          {task.statusReason}
                        </p>
                      ) : null}
                      {link?.mergeRequest?.url ? (
                        <a
                          href={link.mergeRequest.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] text-info-fg hover:underline"
                        >
                          MR !{link.mergeRequest.iid}
                        </a>
                      ) : null}
                      {(showRetry ||
                        showSkip ||
                        (showMarkRework && onMarkRework) ||
                        (showUnskip && onUnskip) ||
                        showReplan) &&
                      (onSkip ||
                        onRetry ||
                        onReplan ||
                        onMarkRework ||
                        onUnskip) ? (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {showRetry && onRetry ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                !actionsEnabled || busy?.taskId === task.taskId
                              }
                              onClick={async () => {
                                setBusy({ taskId: task.taskId, action: "retry" });
                                try {
                                  await onRetry(task.taskId);
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              {t("actionRetry")}
                            </Button>
                          ) : null}
                          {showSkip && onSkip ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={
                                !actionsEnabled || busy?.taskId === task.taskId
                              }
                              onClick={async () => {
                                setBusy({ taskId: task.taskId, action: "skip" });
                                try {
                                  await onSkip(task.taskId);
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              {t("actionSkip")}
                            </Button>
                          ) : null}
                          {showMarkRework && onMarkRework ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={!actionsEnabled}
                              onClick={() => setReworkFor(task)}
                            >
                              {t("actionMarkRework")}
                            </Button>
                          ) : null}
                          {showReplan && onReplan ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={!actionsEnabled}
                              onClick={() => setReplanFor(task)}
                            >
                              {t("actionReplan")}
                            </Button>
                          ) : null}
                          {showUnskip && onUnskip ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={
                                !actionsEnabled || busy?.taskId === task.taskId
                              }
                              onClick={async () => {
                                setBusy({
                                  taskId: task.taskId,
                                  action: "unskip",
                                });
                                try {
                                  await onUnskip(task.taskId);
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              {t("actionUnskip")}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </CardContent>
      {replanFor && onReplan ? (
        <ReplanTaskDialog
          open
          taskId={replanFor.taskId}
          taskTitle={replanFor.title}
          onClose={() => setReplanFor(null)}
          onSubmit={async (body) => {
            await onReplan(replanFor.taskId, body);
          }}
        />
      ) : null}
      {reworkFor && onMarkRework ? (
        <MarkReworkDialog
          open
          taskId={reworkFor.taskId}
          taskTitle={reworkFor.title}
          onClose={() => setReworkFor(null)}
          onSubmit={async (body) => {
            await onMarkRework(reworkFor.taskId, body);
          }}
        />
      ) : null}
    </Card>
  );
}
