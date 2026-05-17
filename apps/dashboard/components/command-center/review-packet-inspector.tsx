"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { planWorkItem, type RunWithReport } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  PIPELINE_TONES,
  READINESS_TONES,
  RUN_STATUS_TONES,
  StatusDot,
  StatusPill,
} from "../ui/status";

type InspectorVariant = "default" | "sheet";

interface ReviewPacketInspectorProps {
  run: RunWithReport | null;
  /**
   * `default` renders inside a Card with a sticky offset (used in the
   * list split-pane). `sheet` renders flush content for use inside the
   * right-side Sheet drawer (the close button lives on the sheet
   * itself, so we drop the duplicate close affordance here).
   */
  variant?: InspectorVariant;
  onClose?: () => void;
}

export function ReviewPacketInspector({
  run,
  variant = "default",
  onClose,
}: ReviewPacketInspectorProps) {
  const t = useTranslations("inspector");
  const tCommon = useTranslations("common");
  const tWorkItem = useTranslations("workItem.action");
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // When a sheet closes, the parent clears the selectedRunId before the
  // slide-out animation finishes. Cache the last non-null run so the
  // panel keeps its content during the 200ms exit transition instead
  // of flashing the empty state.
  const [cachedRun, setCachedRun] = useState<RunWithReport | null>(run);
  useEffect(() => {
    if (run) setCachedRun(run);
  }, [run]);

  const display = run ?? (variant === "sheet" ? cachedRun : null);

  const issueIid = display?.issue?.iid;
  const linkedWorkItemId = display?.workItem?.workItemId;
  const handlePlan = useCallback(async () => {
    if (!issueIid || planning) return;
    setPlanError(null);
    setPlanning(true);
    try {
      const { workItem } = await planWorkItem(issueIid);
      // Hard-navigate so the new /work-items/<id> route renders with a
      // fresh server fetch — the daemon writes WorkItem state to disk
      // and the detail page re-fetches via getWorkItem(id).
      if (typeof window !== "undefined") {
        window.location.href = `/work-items/${encodeURIComponent(
          workItem.workItemId,
        )}`;
      }
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setPlanning(false);
    }
  }, [issueIid, planning]);

  if (!display) {
    return (
      <Card className="sticky top-24">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3 text-sm text-fg-muted">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center rounded-md border border-dashed border-border bg-surface-2 text-fg-subtle"
          >
            <DocIcon />
          </span>
          <p>{t("empty")}</p>
        </CardContent>
      </Card>
    );
  }

  const report = display.report;
  const statusTone = RUN_STATUS_TONES[display.status];
  const readinessTone = report?.mergeReadinessStatus
    ? READINESS_TONES[report.mergeReadinessStatus]
    : undefined;

  const heading = (
    <div className="flex flex-row items-center justify-between gap-3">
      <CardTitle>{t("title")}</CardTitle>
      <div className="flex items-center gap-3">
        <Link
          href={`/runs/${encodeURIComponent(display.runId)}`}
          className="text-[11px] font-medium text-info hover:underline"
        >
          {tCommon("fullDetail")}
        </Link>
        {variant === "default" && onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={tCommon("close")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
    </div>
  );

  const body = (
    <>
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-mono uppercase tracking-[0.16em] text-fg-subtle">
          {display.runId}
        </span>
        <p className="text-[15px] font-medium leading-tight text-fg">
          {display.issue?.title ?? t("noTitle")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={statusTone}>{display.status}</StatusPill>
          {readinessTone ? (
            <Badge tone={readinessTone} className="gap-1.5">
              <StatusDot tone={readinessTone} />
              {report?.mergeReadinessStatus}
            </Badge>
          ) : null}
          {report?.ciStatus ? (
            <Badge
              tone={PIPELINE_TONES[report.ciStatus]}
              className="gap-1.5"
            >
              <StatusDot tone={PIPELINE_TONES[report.ciStatus]} />
              {t("ciTag", { value: report.ciStatus })}
            </Badge>
          ) : null}
        </div>
      </div>

      {report ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 text-xs">
          <Field label={t("branch")} mono>
            {report.branch}
          </Field>
          <Field label={t("attempt")} mono>
            {report.attempt}
          </Field>
          {report.highestRisk ? (
            <Field label={t("highestRisk")}>{report.highestRisk}</Field>
          ) : null}
          {report.mergeRequestUrl ? (
            <Field label={t("mr")}>
              <a
                className="text-info underline-offset-2 hover:underline"
                href={report.mergeRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {tCommon("open")}
              </a>
            </Field>
          ) : null}
        </dl>
      ) : (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning-fg">
          {t("missingReport")}
        </p>
      )}

      {issueIid && !linkedWorkItemId ? (
        <div className="flex flex-col gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePlan}
            disabled={planning}
          >
            {planning ? tWorkItem("planning") : tWorkItem("planWorkItem")}
          </Button>
          {planError ? (
            <span className="text-[11px] text-danger-fg">{planError}</span>
          ) : null}
        </div>
      ) : linkedWorkItemId ? (
        <Link
          href={`/work-items/${encodeURIComponent(linkedWorkItemId)}`}
          className="text-[11px] font-medium text-info hover:underline"
        >
          {linkedWorkItemId}
        </Link>
      ) : null}
    </>
  );

  if (variant === "sheet") {
    return (
      <div className="flex flex-col gap-4 px-5 pb-6 pt-5 text-sm">
        <div className="flex items-center gap-3 pr-10">
          <h3 className="text-base font-semibold tracking-tight text-fg">
            {t("title")}
          </h3>
          <Link
            href={`/runs/${encodeURIComponent(display.runId)}`}
            className="ml-auto text-[11px] font-medium text-info hover:underline"
          >
            {tCommon("fullDetail")}
          </Link>
        </div>
        {body}
      </div>
    );
  }

  return (
    <Card className="sticky top-20">
      <CardHeader>{heading}</CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">{body}</CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
        {label}
      </dt>
      <dd className={`${mono ? "font-mono" : ""} text-xs text-fg`}>
        {children}
      </dd>
    </div>
  );
}

function DocIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16v12H4z" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 6 12 12M6 18 18 6" />
    </svg>
  );
}
