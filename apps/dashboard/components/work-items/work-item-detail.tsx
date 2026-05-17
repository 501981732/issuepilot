"use client";

import type {
  MarkTaskReworkRequest,
  ReplanTaskRequest,
  TaskPlanEdit,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemGraphResponse,
} from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  acceptWorkItemPlan,
  getWorkItem,
  getWorkItemGraph,
  markWorkItemTaskRework,
  regenerateWorkItemPlan,
  replanWorkItemTask,
  retryWorkItemTask,
  skipWorkItemTask,
  unskipWorkItemTask,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { ParentReviewPacket } from "./parent-review-packet";
import { PlanEditor } from "./plan-editor";
import { TaskGraph } from "./task-graph";
import { TaskList } from "./task-list";
import { ViewToggle, type WorkItemView } from "./view-toggle";

const STATUS_TONE: Record<WorkItem["status"], string> = {
  planning: "bg-info-soft text-info-fg",
  ready: "bg-warning-soft text-warning-fg",
  running: "bg-info-soft text-info-fg",
  partial: "bg-warning-soft text-warning-fg",
  completed: "bg-success-soft text-success-fg",
  blocked: "bg-danger-soft text-danger-fg",
};

export interface WorkItemDetailProps {
  initial: WorkItemDetailResponse;
  /** Operator name written into edit/skip/retry headers; defaults to "operator". */
  operator?: string;
  /**
   * V4.2: initial view (list/graph). Persisted by the page in the URL
   * `?view=` so refresh + share-link round-trips work. Defaults to
   * `list` when not provided.
   */
  initialView?: WorkItemView;
}

export function WorkItemDetail({
  initial,
  operator = "operator",
  initialView = "list",
}: WorkItemDetailProps) {
  const t = useTranslations("workItem");
  const [data, setData] = useState<WorkItemDetailResponse>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [view, setView] = useState<WorkItemView>(initialView);
  const [graph, setGraph] = useState<WorkItemGraphResponse | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);

  const refresh = useCallback((next: WorkItemDetailResponse) => {
    setData(next);
  }, []);

  const reload = useCallback(async () => {
    const next = await getWorkItem(data.workItem.workItemId);
    startTransition(() => refresh(next));
  }, [data.workItem.workItemId, refresh]);

  const handleAccept = useCallback(
    async ({
      edits,
    }: {
      edits: Array<Omit<TaskPlanEdit, "at" | "by"> & { by: string }>;
    }) => {
      setBusy(true);
      setError(null);
      try {
        await acceptWorkItemPlan(
          data.workItem.workItemId,
          {
            planId: data.plan.current.planId,
            operator,
            edits: edits.map((e) => ({
              taskId: e.taskId,
              field: e.field,
              after: e.after,
            })),
          },
          { operator },
        );
        await reload();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [
      data.plan.current.planId,
      data.workItem.workItemId,
      operator,
      reload,
    ],
  );

  const handleRegenerate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await regenerateWorkItemPlan(data.workItem.workItemId, { operator });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [data.workItem.workItemId, operator, reload]);

  const handleSkip = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await skipWorkItemTask(data.workItem.workItemId, taskId, { operator });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleRetry = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await retryWorkItemTask(data.workItem.workItemId, taskId, { operator });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleReplan = useCallback(
    async (taskId: string, body: ReplanTaskRequest) => {
      setError(null);
      try {
        await replanWorkItemTask(
          data.workItem.workItemId,
          taskId,
          body,
          { operator },
        );
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleMarkRework = useCallback(
    async (taskId: string, body: MarkTaskReworkRequest) => {
      setError(null);
      try {
        await markWorkItemTaskRework(
          data.workItem.workItemId,
          taskId,
          body,
          { operator },
        );
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleUnskip = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await unskipWorkItemTask(data.workItem.workItemId, taskId, {
          operator,
        });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  // Fetch the graph projection lazily — only when the operator switches
  // to the Graph view. Switching back to List does not invalidate the
  // cached projection so toggling is snappy.
  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    setGraphError(null);
    getWorkItemGraph(data.workItem.workItemId)
      .then((next) => {
        if (!cancelled) setGraph(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setGraphError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, data.workItem.workItemId]);

  const wi = data.workItem;
  const planAccepted = data.plan.current.status === "accepted";

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <header
        aria-label={t("headerAria", { id: wi.workItemId })}
        className="flex flex-col gap-2"
      >
        <Link
          href="/work-items"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle hover:underline"
        >
          {t("backLink")}
        </Link>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-fg">
          {wi.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              STATUS_TONE[wi.status],
            )}
          >
            {wi.status}
          </span>
          <a
            href={wi.sourceIssue.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-fg-subtle hover:underline"
          >
            {t("field.issue")}: #{wi.sourceIssue.iid}
          </a>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("field.updatedAt")}: {wi.updatedAt}
          </span>
        </div>
        {wi.blockedReason ? (
          <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg">
            {wi.blockedReason}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg"
          >
            {error}
          </p>
        ) : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("field.goal")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-fg">
          <p>{wi.goal || "—"}</p>
          {wi.acceptanceCriteria.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                {t("field.acceptance")}
              </span>
              <ul className="list-disc pl-5 text-sm text-fg-muted">
                {wi.acceptanceCriteria.map((ac, i) => (
                  <li key={i}>{ac}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <PlanEditor
        plan={data.plan.current}
        operator={operator}
        busy={busy}
        onAccept={handleAccept}
        onRegenerate={handleRegenerate}
      />

      {planAccepted ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-end">
            <ViewToggle view={view} onChange={setView} />
          </div>
          {view === "list" ? (
            <TaskList
              tasks={data.tasks}
              runLinks={data.runLinks}
              onSkip={handleSkip}
              onRetry={handleRetry}
              onReplan={handleReplan}
              onMarkRework={handleMarkRework}
              onUnskip={handleUnskip}
              actionsEnabled
            />
          ) : graph ? (
            <TaskGraph graph={graph} tasks={data.tasks} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>{t("taskGraph.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-fg-subtle">
                  {graphError ?? t("taskGraph.empty")}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

      {planAccepted ? <ParentReviewPacket report={data.report} /> : null}
    </div>
  );
}
