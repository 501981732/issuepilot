"use client";

import type { ReviewReworkSummary as ReviewReworkSummaryShape } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

/**
 * V4.9 §6.2 — Parent Review Packet 中的 ReviewRework 汇总卡片。
 * 展示 work item 已 accept 计划的阻塞 / 接受 / 完成计数，以及按
 * task 分桶的明细，方便 reviewer 一眼看到「哪个 task 还有阻塞项」。
 *
 * Empty state：当上游聚合返回 undefined（V4.5 路径 / 未启用 V4.9）
 * 时父组件会跳过渲染；但若传入了 summary 而没有任何条目，仍展示
 * 空状态文案而不是空白卡片。
 */
export function ReviewReworkSummary({
  summary,
}: {
  summary: ReviewReworkSummaryShape;
}) {
  const t = useTranslations("reviewRework");
  const total =
    summary.blockingCount + summary.acceptedCount + summary.resolvedCount;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("summaryTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {total === 0 ? (
          <p className="text-fg-subtle">{t("summaryEmpty")}</p>
        ) : (
          <dl className="grid grid-cols-3 gap-2">
            <Stat
              label={t("blockingItems")}
              value={summary.blockingCount}
              tone="danger"
            />
            <Stat
              label={t("acceptedItems")}
              value={summary.acceptedCount}
              tone="info"
            />
            <Stat
              label={t("resolvedItems")}
              value={summary.resolvedCount}
              tone="success"
            />
          </dl>
        )}
        {Object.keys(summary.perTask).length > 0 ? (
          <div>
            <p className="text-[11px] uppercase tracking-wide text-fg-subtle">
              {t("perTaskLabel")}
            </p>
            <ul role="list" className="mt-1 flex flex-col gap-1.5">
              {Object.entries(summary.perTask).map(([taskKey, bucket]) => (
                <li
                  key={taskKey}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1 text-xs"
                >
                  <span className="font-mono">{taskKey}</span>
                  <Badge tone="danger">
                    {t("blockingItems")} {bucket.blocking}
                  </Badge>
                  <Badge tone="info">
                    {t("acceptedItems")} {bucket.accepted}
                  </Badge>
                  <Badge tone="success">
                    {t("resolvedItems")} {bucket.resolved}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {summary.latestPlanIds.length > 0 ? (
          <p className="text-[11px] text-fg-subtle">
            <span className="mr-1 uppercase tracking-wide">
              {t("latestPlansLabel")}:
            </span>
            <span className="font-mono">{summary.latestPlanIds.join(", ")}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "info" | "success";
}) {
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      <span data-tone={tone} className="font-mono text-base font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}
