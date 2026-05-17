"use client";

import type {
  TaskPlanEdit,
  WorkItem,
  WorkItemDetailResponse,
} from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useState, useTransition } from "react";

import {
  acceptWorkItemPlan,
  getWorkItem,
  regenerateWorkItemPlan,
  retryWorkItemTask,
  skipWorkItemTask,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { ParentReviewPacket } from "./parent-review-packet";
import { PlanEditor } from "./plan-editor";
import { TaskList } from "./task-list";

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
}

export function WorkItemDetail({
  initial,
  operator = "operator",
}: WorkItemDetailProps) {
  const t = useTranslations("workItem");
  const [data, setData] = useState<WorkItemDetailResponse>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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
        <TaskList
          tasks={data.tasks}
          runLinks={data.runLinks}
          onSkip={handleSkip}
          onRetry={handleRetry}
          actionsEnabled
        />
      ) : null}

      {planAccepted ? <ParentReviewPacket report={data.report} /> : null}
    </div>
  );
}
