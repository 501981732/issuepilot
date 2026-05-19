"use client";

import type {
  ImprovementRecommendation,
  QualitySummaryResponse,
  RunReportSummary,
} from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import {
  acceptImprovementRecommendation,
  deferImprovementRecommendation,
  generateImprovementRecommendations,
  previewImprovementPatch,
  rejectImprovementRecommendation,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Donut, MiniBars, Sparkline } from "../ui/charts";
import {
  READINESS_TONES,
  RUN_STATUS_TONES,
  StatusDot,
} from "../ui/status";

import { QualityAnalytics } from "./quality-analytics";
import { Recommendations } from "./recommendations";

interface ReportsPageProps {
  reports: RunReportSummary[];
  quality: QualitySummaryResponse;
  recommendations: ImprovementRecommendation[];
}

type SortKey = "updatedAt" | "runId" | "status" | "readiness" | "duration";
type SortDir = "asc" | "desc";

function formatDuration(ms: number | undefined, dash: string): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return dash;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/**
 * Bucket reports into the last 7 calendar days (based on `updatedAt`)
 * so the trend card has data even without a richer time-series API.
 * Days with no runs render a faded zero-height bar so the layout
 * never collapses (rule §10 `empty-data-state`).
 *
 * Optional `predicate` lets the same routine power per-status sparkline
 * trends (e.g. ready-only / blocked-only counts).
 */
function bucketByDay(
  reports: RunReportSummary[],
  predicate?: (report: RunReportSummary) => boolean,
): { label: string; value: number }[] {
  const today = new Date();
  const buckets: { label: string; value: number }[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate(),
    ).padStart(2, "0")}`;
    const count = reports.filter(
      (r) =>
        typeof r.updatedAt === "string" &&
        r.updatedAt.startsWith(key) &&
        (predicate ? predicate(r) : true),
    ).length;
    buckets.push({ label, value: count });
  }
  return buckets;
}

/**
 * Median duration (in seconds) per day for the last 7 days. Days with
 * no completed runs surface as 0 so the sparkline keeps a stable
 * length without crashing the min/max scaler.
 */
function medianDurationByDay(reports: RunReportSummary[]): number[] {
  const today = new Date();
  const out: number[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const durations = reports
      .filter(
        (r) =>
          typeof r.updatedAt === "string" &&
          r.updatedAt.startsWith(key) &&
          typeof r.totalMs === "number" &&
          Number.isFinite(r.totalMs),
      )
      .map((r) => r.totalMs as number)
      .sort((a, b) => a - b);
    if (durations.length === 0) {
      out.push(0);
      continue;
    }
    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? (durations[mid - 1]! + durations[mid]!) / 2
        : durations[mid]!;
    out.push(Math.round(median / 1000));
  }
  return out;
}

export function ReportsPage({
  reports,
  quality,
  recommendations,
}: ReportsPageProps) {
  const t = useTranslations("reportsPage");
  const tCommon = useTranslations("common");
  const dash = tCommon("dash");
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  async function handleGenerate() {
    await generateImprovementRecommendations({});
    router.refresh();
  }
  async function handleAccept(id: string) {
    await acceptImprovementRecommendation(id);
    router.refresh();
  }
  async function handleReject(id: string) {
    await rejectImprovementRecommendation(id);
    router.refresh();
  }
  async function handleDefer(id: string) {
    await deferImprovementRecommendation(id);
    router.refresh();
  }
  async function handlePreview(id: string) {
    await previewImprovementPatch(id);
    router.refresh();
  }

  const counters = useMemo(() => {
    const total = reports.length;
    const ready = reports.filter(
      (r) => r.mergeReadinessStatus === "ready",
    ).length;
    const blocked = reports.filter(
      (r) => r.mergeReadinessStatus === "blocked",
    ).length;
    const failed = reports.filter(
      (r) => r.status === "failed" || r.status === "blocked",
    ).length;
    const median = (() => {
      const durations = reports
        .map((r) => r.totalMs)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
      if (durations.length === 0) return undefined;
      const mid = Math.floor(durations.length / 2);
      return durations.length % 2 === 0
        ? (durations[mid - 1]! + durations[mid]!) / 2
        : durations[mid];
    })();
    return { total, ready, blocked, failed, median };
  }, [reports]);

  const dailyBuckets = useMemo(() => bucketByDay(reports), [reports]);
  const trendValues = dailyBuckets.map((b) => b.value);
  const readyTrend = useMemo(
    () =>
      bucketByDay(reports, (r) => r.mergeReadinessStatus === "ready").map(
        (b) => b.value,
      ),
    [reports],
  );
  const blockedTrend = useMemo(
    () =>
      bucketByDay(reports, (r) => r.mergeReadinessStatus === "blocked").map(
        (b) => b.value,
      ),
    [reports],
  );
  const medianTrend = useMemo(() => medianDurationByDay(reports), [reports]);

  // Donut segment labels stay as data tokens (ready / blocked / not-ready /
  // unknown) since they're the canonical merge-readiness statuses; the
  // surrounding chrome (title, counters) is localised instead.
  const readinessSegments = useMemo(() => {
    const buckets = {
      ready: 0,
      "not-ready": 0,
      blocked: 0,
      unknown: 0,
    };
    for (const r of reports) {
      buckets[r.mergeReadinessStatus] += 1;
    }
    return [
      {
        label: "ready",
        value: buckets.ready,
        color: "hsl(var(--color-success))",
      },
      {
        label: "not-ready",
        value: buckets["not-ready"],
        color: "hsl(var(--color-warning))",
      },
      {
        label: "blocked",
        value: buckets.blocked,
        color: "hsl(var(--color-danger))",
      },
      {
        label: "unknown",
        value: buckets.unknown,
        color: "hsl(var(--color-border-strong))",
      },
    ];
  }, [reports]);

  const sorted = useMemo(() => {
    const list = [...reports];
    const dir = sortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      switch (sortKey) {
        case "runId":
          return a.runId.localeCompare(b.runId) * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "readiness":
          return (
            a.mergeReadinessStatus.localeCompare(b.mergeReadinessStatus) *
            dir
          );
        case "duration":
          return ((a.totalMs ?? 0) - (b.totalMs ?? 0)) * dir;
        case "updatedAt":
        default:
          return a.updatedAt.localeCompare(b.updatedAt) * dir;
      }
    });
    return list;
  }, [reports, sortKey, sortDir]);

  function applySort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const readyPct = counters.total === 0
    ? 0
    : Math.round((counters.ready / counters.total) * 100);
  const blockedPct = counters.total === 0
    ? 0
    : Math.round((counters.blocked / counters.total) * 100);

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
        aria-label={t("countersAria")}
        className="grid grid-cols-2 gap-3 md:grid-cols-4"
      >
        <Counter
          label={t("totalReports")}
          value={counters.total}
          accent="info"
          trend={trendValues}
          trendLabel={t("trendLabel", { label: t("totalReports") })}
        />
        <Counter
          label={t("readyToMerge")}
          value={counters.ready}
          accent="success"
          sub={t("ofTotal", { percent: readyPct })}
          trend={readyTrend}
          trendLabel={t("trendLabel", { label: t("readyToMerge") })}
        />
        <Counter
          label={t("blocked")}
          value={counters.blocked}
          accent="danger"
          sub={t("ofTotal", { percent: blockedPct })}
          trend={blockedTrend}
          trendLabel={t("trendLabel", { label: t("blocked") })}
        />
        <Counter
          label={t("medianDuration")}
          value={formatDuration(counters.median, dash)}
          accent="warning"
          sub={t("failedCount", { count: counters.failed })}
          trend={medianTrend}
          trendLabel={t("trendLabel", { label: t("medianDuration") })}
        />
      </section>

      <QualityAnalytics summary={quality} />

      <Recommendations
        recommendations={recommendations}
        onGenerate={handleGenerate}
        onAccept={handleAccept}
        onReject={handleReject}
        onDefer={handleDefer}
        onPreview={handlePreview}
      />

      <section className="grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>{t("perDayTitle")}</CardTitle>
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
              {tCommon("utc")}
            </span>
          </CardHeader>
          <CardContent>
            <MiniBars
              values={dailyBuckets}
              height={120}
              ariaLabel={t("perDayAria")}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("mixTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-5">
            <Donut segments={readinessSegments} />
            <ul className="flex flex-col gap-2 text-xs">
              {readinessSegments.map((seg) => (
                <li
                  key={seg.label}
                  className="flex items-center gap-2 text-fg-muted"
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: seg.color }}
                  />
                  <span className="font-mono uppercase tracking-[0.12em]">
                    {seg.label}
                  </span>
                  <span className="ml-auto font-mono tabular-nums text-fg">
                    {seg.value}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-label={t("tableAria")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold tracking-tight text-fg">
            {t("tableHeading")}
          </h2>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("rowCount", { count: sorted.length })}
          </span>
        </div>
        <Card className="overflow-hidden p-0">
          <CardContent className="p-0">
            {sorted.length === 0 ? (
              <p className="px-6 py-16 text-center text-sm text-fg-subtle">
                {t("tableEmpty")}
              </p>
            ) : (
              <div className="w-full overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-surface-2/60 text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    <tr>
                      <SortHeader
                        label={t("headRun")}
                        active={sortKey === "runId"}
                        dir={sortDir}
                        onClick={() => applySort("runId")}
                      />
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("headIssue")}
                      </th>
                      <SortHeader
                        label={t("headStatus")}
                        active={sortKey === "status"}
                        dir={sortDir}
                        onClick={() => applySort("status")}
                      />
                      <SortHeader
                        label={t("headReadiness")}
                        active={sortKey === "readiness"}
                        dir={sortDir}
                        onClick={() => applySort("readiness")}
                      />
                      <th className="px-4 py-2.5 text-left font-semibold">
                        {t("headCi")}
                      </th>
                      <SortHeader
                        label={t("headDuration")}
                        active={sortKey === "duration"}
                        dir={sortDir}
                        onClick={() => applySort("duration")}
                      />
                      <SortHeader
                        label={t("headUpdated")}
                        active={sortKey === "updatedAt"}
                        dir={sortDir}
                        onClick={() => applySort("updatedAt")}
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {sorted.map((report) => {
                      const readinessTone = READINESS_TONES[
                        report.mergeReadinessStatus
                      ];
                      const runTone = RUN_STATUS_TONES[report.status];
                      return (
                        <tr
                          key={report.runId}
                          className="transition-colors hover:bg-surface-2/40"
                        >
                          <td className="px-4 py-2.5 font-mono text-xs text-fg">
                            <Link
                              href={`/runs/${encodeURIComponent(report.runId)}`}
                              className="hover:underline"
                            >
                              {report.runId}
                            </Link>
                          </td>
                          <td className="px-4 py-2.5 text-sm text-fg">
                            <span className="font-mono text-[11px] text-fg-subtle">
                              #{report.issueIid}
                            </span>{" "}
                            {report.issueTitle}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge tone={runTone} className="gap-1.5">
                              <StatusDot tone={runTone} />
                              {report.status}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge tone={readinessTone} className="gap-1.5">
                              <StatusDot tone={readinessTone} />
                              {report.mergeReadinessStatus}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs text-fg-muted">
                            {report.ciStatus ?? dash}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs tabular-nums text-fg">
                            {formatDuration(report.totalMs, dash)}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums text-fg-muted">
                            {report.updatedAt}
                          </td>
                        </tr>
                      );
                    })}
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

interface CounterProps {
  label: string;
  value: number | string;
  accent: "info" | "success" | "danger" | "warning";
  sub?: string;
  trend?: number[];
  trendLabel?: string;
}

function Counter({ label, value, accent, sub, trend, trendLabel }: CounterProps) {
  return (
    <Card className="relative overflow-hidden">
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ backgroundColor: `hsl(var(--color-${accent}))` }}
      />
      <CardContent className="flex flex-col gap-2 pt-5">
        <div className="flex items-center gap-2">
          <StatusDot tone={accent} />
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            {label}
          </span>
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="font-mono text-3xl font-semibold leading-none tabular-nums text-fg">
            {value}
          </span>
          {trend ? (
            <Sparkline
              values={trend}
              width={72}
              height={28}
              stroke={`hsl(var(--color-${accent}))`}
              fill={`hsl(var(--color-${accent}) / 0.12)`}
              label={trendLabel ?? label}
              className="text-fg-subtle"
            />
          ) : null}
        </div>
        {sub ? (
          <span className="font-mono text-[11px] text-fg-subtle">{sub}</span>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      className="px-4 py-2.5 text-left font-semibold"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 rounded px-0 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-fg" : "text-fg-subtle",
        )}
      >
        {label}
        <span aria-hidden="true" className="font-mono text-[8px]">
          {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </button>
    </th>
  );
}
