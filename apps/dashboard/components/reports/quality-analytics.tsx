"use client";

import type { QualitySummaryResponse } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Card, CardContent } from "../ui/card";

interface QualityAnalyticsProps {
  summary: QualitySummaryResponse;
}

/**
 * V4.4 Quality Analytics section rendered on `/reports`. Task 10 ships a
 * minimal skeleton so the data flow is wired end-to-end; Task 11 replaces
 * the body with the full summary strip, trend panel, failure pattern list
 * and drill-down table.
 */
export function QualityAnalytics({ summary }: QualityAnalyticsProps) {
  const t = useTranslations("reportsPage.quality");
  const hasData = summary.metrics.some(
    (m) => (m.denominator ?? 0) > 0 || m.value > 0,
  );

  return (
    <section
      aria-label={t("aria")}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-fg">
          {t("title")}
        </h2>
        <span className="font-mono text-[11px] text-fg-subtle">
          {summary.filters.window}
        </span>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-2 py-5">
          {hasData ? (
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
              {summary.metrics.map((metric) => (
                <li
                  key={metric.id}
                  className="flex items-baseline gap-2"
                  title={`${metric.numerator ?? 0} / ${metric.denominator ?? 0}`}
                >
                  <span className="font-mono uppercase tracking-[0.12em] text-fg-subtle">
                    {metric.label}
                  </span>
                  <span className="font-mono tabular-nums text-fg">
                    {metric.unit === "duration-ms"
                      ? `${Math.round(metric.value / 1000)}s`
                      : `${metric.value}%`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-subtle">{t("empty")}</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
