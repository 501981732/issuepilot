"use client";

import type { QualitySummaryResponse } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

type ReviewWorkflowSlice = NonNullable<
  QualitySummaryResponse["reviewWorkflow"]
>;

/**
 * V4.9 §6.2 / §10 — Reports 页的 ReviewWorkflow 卡片，消费
 * QualitySummaryResponse.reviewWorkflow。负责让 reviewer 一眼看到
 * 当前窗口生成了多少返工计划、接受/解决比，以及高频 category 与
 * runner 维度的分布（V4.8 混合 runner 时仍能保留 provenance）。
 *
 * 设计取舍：
 *  - 不渲染时间序列（quality-analytics 已有 byRole 切片做趋势），
 *    这里专注「当前窗口的人审视角」。
 *  - 顶部三块数字保持等宽 + tabular-nums，避免数字跳动。
 */
export function ReviewWorkflowCard({ data }: { data: ReviewWorkflowSlice }) {
  const t = useTranslations("reviewRework");
  const tCard = useTranslations("reviewRework.card");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{tCard("title")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-3 gap-2">
          <Stat label={tCard("plansGenerated")} value={data.plansGenerated} />
          <Stat
            label={tCard("itemsAccepted")}
            value={data.itemsAccepted}
            tone="info"
          />
          <Stat
            label={tCard("itemsResolved")}
            value={data.itemsResolved}
            tone="success"
          />
        </dl>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-fg-subtle">
            {tCard("topCategories")}
          </p>
          {data.topCategories.length === 0 ? (
            <p className="mt-1 text-fg-subtle">{t("summaryEmpty")}</p>
          ) : (
            <ul role="list" className="mt-1 flex flex-wrap gap-2">
              {data.topCategories.map((entry) => (
                <li key={entry.category}>
                  <Badge tone="neutral">
                    {labelForCategory(t, entry.category)}{" "}
                    <span className="ml-1 font-mono tabular-nums">
                      {entry.count}
                    </span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-fg-subtle">
            {tCard("runnerBreakdown")}
          </p>
          {Object.keys(data.runnerKindBreakdown).length === 0 ? (
            <p className="mt-1 text-fg-subtle">—</p>
          ) : (
            <ul role="list" className="mt-1 flex flex-wrap gap-2">
              {Object.entries(data.runnerKindBreakdown).map(
                ([runnerKind, count]) => (
                  <li key={runnerKind}>
                    <Badge tone="violet">
                      <span className="font-mono">{runnerKind}</span>{" "}
                      <span className="ml-1 font-mono tabular-nums">
                        {count}
                      </span>
                    </Badge>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function labelForCategory(
  t: ReturnType<typeof useTranslations>,
  category: string,
): string {
  try {
    return t(`categories.${category}`);
  } catch {
    return category;
  }
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "info" | "success";
}) {
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      <span
        data-tone={tone}
        className="font-mono text-base font-semibold tabular-nums"
      >
        {value}
      </span>
    </div>
  );
}
