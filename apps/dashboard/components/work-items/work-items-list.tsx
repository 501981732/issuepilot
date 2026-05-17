"use client";

import type { WorkItem, WorkItemStatus } from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const STATUS_COUNTERS: WorkItemStatus[] = [
  "planning",
  "ready",
  "running",
  "partial",
  "completed",
  "blocked",
];

const STATUS_TONE: Record<WorkItemStatus, string> = {
  planning: "bg-info-soft text-info-fg",
  ready: "bg-warning-soft text-warning-fg",
  running: "bg-info-soft text-info-fg",
  partial: "bg-warning-soft text-warning-fg",
  completed: "bg-success-soft text-success-fg",
  blocked: "bg-danger-soft text-danger-fg",
};

export interface WorkItemsListProps {
  workItems: WorkItem[];
  counters: Record<WorkItemStatus, number>;
}

export function WorkItemsList({ workItems, counters }: WorkItemsListProps) {
  const t = useTranslations("workItems");

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <header className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">
          {t("overheadLabel")}
        </span>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-fg">
          {t("title")}
        </h1>
        <p className="max-w-2xl text-sm text-fg-muted">{t("description")}</p>
      </header>

      <section
        aria-label={t("title")}
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6"
      >
        {STATUS_COUNTERS.map((status) => (
          <Card key={status} className="overflow-hidden">
            <CardContent className="flex flex-col gap-2 pt-5">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                {t(`counter.${status}`)}
              </span>
              <span className="font-mono text-3xl font-semibold leading-none tabular-nums text-fg">
                {counters[status] ?? 0}
              </span>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="flex flex-col gap-3" aria-label={t("tableAria")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-fg">
            {t("title")}
          </h2>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("rowCount", { count: workItems.length })}
          </span>
        </div>
        <Card className="overflow-hidden p-0">
          <CardContent className="p-0">
            {workItems.length === 0 ? (
              <p className="px-6 py-16 text-center text-sm text-fg-subtle">
                {t("empty")}
              </p>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-surface-2/60 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    <tr>
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("columns.title")}
                      </th>
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("columns.issue")}
                      </th>
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("columns.status")}
                      </th>
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("columns.tasks")}
                      </th>
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("columns.updated")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {workItems.map((wi) => (
                      <tr
                        key={wi.workItemId}
                        className="transition-colors hover:bg-surface-2/40"
                      >
                        <td className="px-4 py-2.5 text-sm text-fg">
                          <Link
                            href={`/work-items/${encodeURIComponent(wi.workItemId)}`}
                            className="hover:underline"
                          >
                            {wi.title}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-sm">
                          <a
                            href={wi.sourceIssue.url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[11px] text-fg-subtle hover:underline"
                          >
                            #{wi.sourceIssue.iid}
                          </a>
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
                              STATUS_TONE[wi.status],
                            )}
                          >
                            {wi.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs text-fg">
                          {wi.taskIds.length}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums text-fg-muted">
                          {wi.updatedAt}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
