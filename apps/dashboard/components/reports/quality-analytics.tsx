"use client";

import type {
  FailurePatternId,
  FailurePatternSummary,
  QualityDrilldownItem,
  QualityDimension,
  QualityMetric,
  QualityMetricId,
  QualityStatusFilter,
  QualitySummaryResponse,
  QualityWindow,
} from "@issuepilot/shared-contracts";
import { QUALITY_STATUS_FILTER_VALUES } from "@issuepilot/shared-contracts";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { cn } from "../../lib/cn";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent } from "../ui/card";
import { Sparkline } from "../ui/charts";
import { StatusDot } from "../ui/status";

interface QualityAnalyticsProps {
  summary: QualitySummaryResponse;
}

const METRIC_ORDER: QualityMetricId[] = [
  "success-rate",
  "failure-rate",
  "rework-rate",
  "ci-pass-rate",
  "review-hit-rate",
  "missing-evidence-rate",
  "median-duration",
];

const DIRECTION_GLYPH: Record<QualityMetric["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "▬",
  unknown: "—",
};

/**
 * Pick a tone that conveys good/bad for the metric regardless of color, so
 * non-color cues drive meaning (Accessibility §1: color-not-only).
 */
function metricTone(metric: QualityMetric): BadgeTone {
  if (metric.direction === "unknown") return "neutral";
  switch (metric.id) {
    case "success-rate":
    case "ci-pass-rate":
      return metric.direction === "up" ? "success" : "warning";
    case "failure-rate":
    case "rework-rate":
    case "missing-evidence-rate":
    case "review-hit-rate":
      return metric.direction === "down" ? "success" : "warning";
    case "median-duration":
      return "info";
  }
}

function formatMetricValue(metric: QualityMetric): string {
  if (metric.unit === "duration-ms") {
    if (metric.value === 0) return "—";
    const seconds = Math.round(metric.value / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  return `${metric.value}%`;
}

function nextSearch(
  pathname: string,
  updates: Record<string, string | undefined>,
): string | undefined {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value && value.length > 0) {
      url.searchParams.set(key, value);
    } else {
      url.searchParams.delete(key);
    }
  }
  const query = url.searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function writeUrlFilter(key: string, value: string | undefined): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value && value.length > 0) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", url.toString());
}

export function QualityAnalytics({ summary }: QualityAnalyticsProps) {
  const t = useTranslations("reportsPage.quality");
  const router = useRouter();
  const pathname = usePathname() ?? "/reports";
  const [metricId, setMetricId] = useState<QualityMetricId>("success-rate");
  const activePattern = summary.filters.pattern;

  function applyFilters(updates: Record<string, string | undefined>) {
    const next = nextSearch(pathname, updates);
    if (!next) return;
    router.replace(next, { scroll: false });
    router.refresh();
  }

  const orderedMetrics = useMemo(() => {
    const byId = new Map(summary.metrics.map((m) => [m.id, m]));
    return METRIC_ORDER.map((id) => byId.get(id)).filter(
      (m): m is QualityMetric => Boolean(m),
    );
  }, [summary.metrics]);

  const activeTrend = useMemo(
    () => summary.trends.filter((p) => p.metricId === metricId),
    [summary.trends, metricId],
  );

  const filteredDrilldown = useMemo(() => {
    if (!activePattern) return summary.drilldown;
    return summary.drilldown.filter((d) =>
      d.patternIds.includes(activePattern),
    );
  }, [summary.drilldown, activePattern]);

  const hasAnyData = orderedMetrics.some(
    (m) => (m.denominator ?? 0) > 0 || m.value > 0,
  );

  return (
    <section aria-label={t("aria")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-fg">
            {t("title")}
          </h2>
          <span
            aria-label={t("windowAria")}
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-fg-subtle"
          >
            {summary.filters.window}
          </span>
        </div>
        <p className="max-w-2xl text-xs text-fg-muted">{t("description")}</p>
      </div>

      {hasAnyData ? (
        <>
          <SummaryStrip metrics={orderedMetrics} t={t} />

          <FilterBar
            filters={summary.filters}
            dimensions={summary.dimensions}
            patterns={summary.failurePatterns}
            onChange={applyFilters}
            t={t}
          />

          <TrendPanel
            metrics={orderedMetrics}
            activeId={metricId}
            onSelect={setMetricId}
            trend={activeTrend}
            t={t}
          />

          <PatternList
            patterns={summary.failurePatterns}
            activePattern={activePattern}
            onSelect={(p) => {
              const next = activePattern === p ? undefined : p;
              writeUrlFilter("pattern", next);
              applyFilters({ pattern: next });
            }}
            t={t}
          />

          <DrilldownTable items={filteredDrilldown} t={t} />
        </>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-fg-subtle">
            {t("empty")}
          </CardContent>
        </Card>
      )}

      {summary.diagnostics.invalidReportCount > 0 ? (
        <p className="font-mono text-[11px] text-fg-subtle">
          {t("diagnostics", {
            count: summary.diagnostics.invalidReportCount,
          })}
        </p>
      ) : null}
    </section>
  );
}

interface SectionTranslator {
  (key: string, values?: Record<string, string | number>): string;
}

function SummaryStrip({
  metrics,
  t,
}: {
  metrics: QualityMetric[];
  t: SectionTranslator;
}) {
  return (
    <ul
      className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7"
      aria-label={t("strip")}
    >
      {metrics.map((metric) => {
        const tone = metricTone(metric);
        return (
          <li key={metric.id}>
            <Card className="h-full">
              <CardContent className="flex flex-col gap-1.5 py-3">
                <div className="flex items-center gap-1.5">
                  <StatusDot tone={tone} />
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                    {metric.label}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-2xl font-semibold leading-none tabular-nums text-fg">
                    {formatMetricValue(metric)}
                  </span>
                  {metric.delta !== undefined ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        metric.direction === "up"
                          ? "text-success-fg"
                          : metric.direction === "down"
                            ? "text-danger-fg"
                            : "text-fg-subtle",
                      )}
                    >
                      {DIRECTION_GLYPH[metric.direction]}
                      {Math.abs(metric.delta)}
                    </span>
                  ) : null}
                </div>
                <span className="font-mono text-[10px] text-fg-subtle">
                  {metric.unit === "percent" &&
                  metric.denominator !== undefined &&
                  metric.numerator !== undefined
                    ? `${metric.numerator}/${metric.denominator}`
                    : metric.unknownCount && metric.unknownCount > 0
                      ? t("unknownCount", { count: metric.unknownCount })
                      : "\u00A0"}
                </span>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

function dimensionOptions(
  dimensions: QualityDimension[],
  kind: QualityDimension["kind"],
): QualityDimension[] {
  return dimensions
    .filter((d) => d.kind === kind)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function FilterBar({
  filters,
  dimensions,
  patterns,
  onChange,
  t,
}: {
  filters: QualitySummaryResponse["filters"];
  dimensions: QualityDimension[];
  patterns: FailurePatternSummary[];
  onChange: (updates: Record<string, string | undefined>) => void;
  t: SectionTranslator;
}) {
  const workflowOptions = dimensionOptions(dimensions, "workflow");
  const taskTypeOptions = dimensionOptions(dimensions, "task-type");

  return (
    <Card>
      <CardContent className="grid gap-3 py-3 md:grid-cols-5">
        <FilterSelect
          label={t("filterWindow")}
          value={filters.window}
          onChange={(value) =>
            onChange({
              window: value as QualityWindow,
              from: undefined,
              to: undefined,
            })
          }
          options={[
            { value: "7d", label: "7d" },
            { value: "30d", label: "30d" },
          ]}
        />
        <FilterSelect
          label={t("filterWorkflow")}
          value={filters.workflow ?? ""}
          onChange={(value) => onChange({ workflow: value || undefined })}
          options={workflowOptions.map((d) => ({
            value: d.value,
            label: `${d.label} (${d.count})`,
          }))}
          emptyLabel={t("filterAll")}
        />
        <FilterSelect
          label={t("filterTaskType")}
          value={filters.taskType ?? ""}
          onChange={(value) => onChange({ taskType: value || undefined })}
          options={taskTypeOptions.map((d) => ({
            value: d.value,
            label: `${d.label} (${d.count})`,
          }))}
          emptyLabel={t("filterAll")}
        />
        <FilterSelect
          label={t("filterStatus")}
          value={filters.status ?? ""}
          onChange={(value) =>
            onChange({ status: (value as QualityStatusFilter) || undefined })
          }
          options={QUALITY_STATUS_FILTER_VALUES.map((value) => ({
            value,
            label: value,
          }))}
          emptyLabel={t("filterAll")}
        />
        <FilterSelect
          label={t("filterPattern")}
          value={filters.pattern ?? ""}
          onChange={(value) =>
            onChange({ pattern: (value as FailurePatternId) || undefined })
          }
          options={patterns.map((pattern) => ({
            value: pattern.patternId,
            label: `${pattern.label} (${pattern.count})`,
          }))}
          emptyLabel={t("filterAll")}
        />
      </CardContent>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  emptyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  emptyLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-surface px-2 text-sm normal-case tracking-normal text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {emptyLabel ? <option value="">{emptyLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TrendPanel({
  metrics,
  activeId,
  onSelect,
  trend,
  t,
}: {
  metrics: QualityMetric[];
  activeId: QualityMetricId;
  onSelect: (id: QualityMetricId) => void;
  trend: QualitySummaryResponse["trends"];
  t: SectionTranslator;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-fg">
            {t("trendTitle")}
          </h3>
          <div
            role="group"
            aria-label={t("trendSwitcher")}
            className="flex flex-wrap gap-1"
          >
            {metrics.map((metric) => (
              <button
                key={metric.id}
                type="button"
                onClick={() => onSelect(metric.id)}
                aria-pressed={metric.id === activeId}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] font-medium tracking-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  metric.id === activeId
                    ? "border-info bg-info-soft text-info-fg"
                    : "border-border bg-surface text-fg-muted hover:text-fg",
                )}
              >
                {metric.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Sparkline
            values={trend.map((p) => p.value)}
            width={640}
            height={64}
            stroke="hsl(var(--color-info))"
            fill="hsl(var(--color-info) / 0.12)"
            label={t("trendLabel", {
              metric: metrics.find((m) => m.id === activeId)?.label ?? "",
            })}
            className="w-full"
          />
          {trend.length === 0 ? (
            <span className="font-mono text-[11px] text-fg-subtle">
              {t("emptyTrend")}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function PatternList({
  patterns,
  activePattern,
  onSelect,
  t,
}: {
  patterns: FailurePatternSummary[];
  activePattern: string | undefined;
  onSelect: (patternId: string) => void;
  t: SectionTranslator;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-4">
        <h3 className="text-sm font-semibold tracking-tight text-fg">
          {t("patternsTitle")}
        </h3>
        {patterns.length === 0 ? (
          <p className="text-sm text-fg-subtle">{t("noPatterns")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {patterns.map((pattern) => {
              const active = pattern.patternId === activePattern;
              return (
                <li key={pattern.patternId}>
                  <button
                    type="button"
                    onClick={() => onSelect(pattern.patternId)}
                    aria-pressed={active}
                    title={pattern.latestReason ?? pattern.label}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-warning bg-warning-soft text-warning-fg"
                        : "border-border bg-surface hover:bg-surface-2",
                    )}
                  >
                    <Badge
                      tone={active ? "warning" : "neutral"}
                      className="shrink-0"
                    >
                      {pattern.label}
                    </Badge>
                    <span className="font-mono text-xs tabular-nums text-fg-muted">
                      {pattern.count} · {pattern.rate}%
                    </span>
                    <span className="ml-auto line-clamp-1 text-xs text-fg-subtle">
                      {pattern.topProject ?? "—"}
                      {pattern.topWorkflow ? ` · ${pattern.topWorkflow}` : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DrilldownTable({
  items,
  t,
}: {
  items: QualityDrilldownItem[];
  t: SectionTranslator;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-fg">
            {t("drilldownTitle")}
          </h3>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("rowCount", { count: items.length })}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="px-4 pb-6 text-center text-sm text-fg-subtle">
            {t("noDrilldown")}
          </p>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface-2/60 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                <tr>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headProject")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headTarget")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headPattern")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headReason")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headUpdated")}
                  </th>
                  <th className="px-4 py-2.5 text-left font-semibold">
                    {t("headLink")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((item) => (
                  <tr
                    key={item.itemId}
                    className="transition-colors hover:bg-surface-2/40"
                  >
                    <td
                      className="px-4 py-2.5 font-mono text-[11px] text-fg-muted"
                      title={item.projectId}
                    >
                      <span className="line-clamp-1 break-all">
                        {item.projectId}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-sm text-fg">
                      {item.task ? (
                        <span className="line-clamp-1" title={item.task.title}>
                          <span className="font-mono text-[11px] text-fg-subtle">
                            {item.task.taskId}
                          </span>{" "}
                          {item.task.title}
                        </span>
                      ) : item.issue ? (
                        <span className="line-clamp-1" title={item.issue.title}>
                          <span className="font-mono text-[11px] text-fg-subtle">
                            #{item.issue.iid}
                          </span>{" "}
                          {item.issue.title}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {item.patternIds.length === 0 ? (
                          <span className="font-mono text-[11px] text-fg-subtle">
                            —
                          </span>
                        ) : (
                          item.patternIds.map((p) => (
                            <Badge
                              key={p}
                              tone="neutral"
                              className="text-[10px]"
                            >
                              {p}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td
                      className="px-4 py-2.5 text-xs text-fg-muted"
                      title={item.reason}
                    >
                      <span className="line-clamp-2 max-w-[36ch] break-words">
                        {item.reason}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums text-fg-muted">
                      {item.updatedAt}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        href={item.target.href}
                        className="text-info-fg hover:underline"
                      >
                        {t("openSource")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
