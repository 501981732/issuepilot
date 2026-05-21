"use client";

import type {
  IssuePilotEvent,
  PipelineStatus,
  ReviewFeedbackSummary,
  RunRecord,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";

import {
  acceptReviewReworkPlan,
  ApiError,
  archiveRun,
  dismissReviewReworkPlan,
  retryRun,
  stopRun,
  updateReviewReworkItem,
} from "../../lib/api";
import { useEventStream } from "../../lib/use-event-stream";
import { RunActions } from "../overview/run-actions";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { RUN_STATUS_TONES, StatusDot, StatusPill } from "../ui/status";

import { EventTimeline } from "./event-timeline";
import { LogTail } from "./log-tail";
import { ReviewPacket } from "./review-packet";
import { ReviewReworkPlanPanel } from "./review-rework-plan-panel";
import { ToolCallList } from "./tool-call-list";

const CI_TONES: Record<PipelineStatus, BadgeTone> = {
  running: "info",
  success: "success",
  failed: "danger",
  pending: "info",
  canceled: "warning",
  unknown: "neutral",
};

interface RunDetailPageProps {
  run: RunRecord;
  initialEvents: IssuePilotEvent[];
  logsTail: string[];
  /**
   * V2.5 Command Center: when present, the page promotes the Review
   * Packet (handoff summary, validation, risks, merge readiness) above
   * the Timeline. Legacy runs without a stored report fall back to the
   * Timeline-first layout.
   */
  report?: RunReportArtifact;
  /**
   * Optional operator-action callbacks. When supplied, RunActions surfaces
   * Retry / Stop / Archive in the page header. The parent owns the API call
   * + refresh, keeping this component declarative.
   */
  onRetry?: (runId: string) => void;
  onStop?: (runId: string) => void;
  onArchive?: (runId: string) => void;
  /** Disable header buttons while a request is in flight. */
  actionsPending?: boolean;
}

export function RunDetailPage({
  run,
  initialEvents,
  logsTail,
  report,
  onRetry,
  onStop,
  onArchive,
  actionsPending,
}: RunDetailPageProps) {
  const router = useRouter();
  const t = useTranslations();
  const actionLabels = useTranslations("actions.labels");
  const [events, setEvents] = useState<IssuePilotEvent[]>(initialEvents);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startAction] = useTransition();

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  const performAction = useCallback(
    (
      runId: string,
      action: (id: string) => Promise<{ ok: true }>,
      label: string,
    ): void => {
      startAction(async () => {
        try {
          await action(runId);
          setActionError(null);
          router.refresh();
        } catch (err) {
          if (err instanceof ApiError) {
            const detail = err.reason
              ? `${err.code ?? "error"}:${err.reason}`
              : (err.code ?? `HTTP ${err.status}`);
            setActionError(t("runDetail.actionFailedDetail", { label, detail }));
          } else {
            setActionError(
              err instanceof Error
                ? t("runDetail.actionFailedMessage", { label, message: err.message })
                : t("runDetail.actionFailed", { label }),
            );
          }
        }
      });
    },
    [router, t],
  );

  const handleRetry =
    onRetry ?? ((id: string) => performAction(id, retryRun, actionLabels("retry")));
  const handleStop =
    onStop ?? ((id: string) => performAction(id, stopRun, actionLabels("stop")));
  const handleArchive =
    onArchive ?? ((id: string) => performAction(id, archiveRun, actionLabels("archive")));
  const buttonsDisabled = actionsPending ?? pending;

  useEventStream<IssuePilotEvent>({
    runId: run.runId,
    bufferSize: 500,
    onEvent: (event) => {
      setEvents((prev) => {
        if (prev.some((e) => e.id === event.id)) return prev;
        return [...prev, event];
      });
    },
  });

  const toolCalls = useMemo(
    () => events.filter((e) => e.type.startsWith("tool_call_")),
    [events],
  );

  const statusTone = RUN_STATUS_TONES[run.status];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <nav className="flex items-center gap-2 text-xs text-fg-muted">
        <Link href="/" className="hover:text-fg">
          {t("runDetail.backLink")}
        </Link>
        <span aria-hidden="true" className="text-fg-subtle">
          /
        </span>
        <span className="font-mono text-fg-subtle">{t("runDetail.runsCrumb")}</span>
        <span aria-hidden="true" className="text-fg-subtle">
          /
        </span>
        <span className="font-mono text-fg">{run.runId}</span>
      </nav>

      {actionError ? (
        <p
          role="alert"
          className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg"
        >
          {actionError}
        </p>
      ) : null}

      <section
        aria-label={t("runDetail.runHeaderAria", { runId: run.runId })}
        className="sticky top-16 z-20 rounded-lg border border-border bg-surface/95 shadow-2 backdrop-blur lg:top-0"
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <StatusPill tone={statusTone}>{run.status}</StatusPill>
              <div className="flex flex-col leading-tight">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle">
                  {t("runDetail.runAttempt", { attempt: run.attempt })}
                </span>
                <span className="font-mono text-sm text-fg">{run.runId}</span>
              </div>
            </div>
            <RunActions
              run={{
                runId: run.runId,
                status: run.status,
                ...(run.archivedAt ? { archivedAt: run.archivedAt } : {}),
              }}
              onRetry={handleRetry}
              onStop={handleStop}
              onArchive={handleArchive}
              pending={buttonsDisabled}
            />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-3 lg:grid-cols-5">
            <Field label={t("runDetail.field.issue")}>
              <a
                href={run.issue.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-info underline-offset-2 hover:underline"
              >
                #{run.issue.iid}
              </a>{" "}
              <span className="text-fg">{run.issue.title}</span>
            </Field>
            <Field label={t("runDetail.field.branch")} mono>
              {run.branch}
            </Field>
            <Field label={t("runDetail.field.mergeRequest")}>
              {run.mergeRequestUrl ? (
                <a
                  href={run.mergeRequestUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-info underline-offset-2 hover:underline"
                  aria-label={t("runDetail.openMrAria")}
                >
                  {t("runDetail.openMr")}
                </a>
              ) : (
                <span className="text-fg-subtle">{t("common.dash")}</span>
              )}
            </Field>
            <Field label={t("runDetail.field.workspace")} mono className="sm:col-span-2 lg:col-span-2">
              <span className="break-all">{run.workspacePath}</span>
            </Field>
            <Field label={t("runDetail.field.labels")}>
              <div className="flex flex-wrap gap-1">
                {run.issue.labels.map((label) => (
                  <Badge key={label} tone="neutral">
                    {label}
                  </Badge>
                ))}
              </div>
            </Field>
            {run.latestCiStatus ? (
              <Field label={t("runDetail.field.latestCi")}>
                <div className="flex items-center gap-2">
                  <Badge
                    tone={CI_TONES[run.latestCiStatus]}
                    aria-label={t("runsTable.latestCiAria", { value: run.latestCiStatus })}
                    className="gap-1.5"
                  >
                    <StatusDot tone={CI_TONES[run.latestCiStatus]} />
                    {t("runDetail.ciTag", { value: run.latestCiStatus })}
                  </Badge>
                  {run.latestCiCheckedAt ? (
                    <time
                      dateTime={run.latestCiCheckedAt}
                      className="font-mono text-[11px] text-fg-subtle"
                    >
                      {run.latestCiCheckedAt}
                    </time>
                  ) : null}
                </div>
              </Field>
            ) : null}
            {run.lastError ? (
              <Field label={t("runDetail.field.failure")} className="sm:col-span-2 lg:col-span-2">
                <span className="font-mono text-xs text-danger-fg">
                  {run.lastError.code}
                </span>{" "}
                <span className="text-fg">{run.lastError.message}</span>
              </Field>
            ) : null}
          </dl>
        </div>
      </section>

      {report ? (
        <section className="flex flex-col gap-3">
          <SectionHeader
            title={t("runDetail.reviewPacketSection")}
            caption={t("runDetail.reviewPacketCaption")}
          />
          <ReviewPacket report={report} />
        </section>
      ) : (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning-fg">
          {t("runDetail.legacyNote")}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t("runDetail.timeline")}
          caption={t("runDetail.timelineCaption")}
        />
        <EventTimeline events={events} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t("runDetail.toolCalls")}
          caption={t("runDetail.toolCallsCaption")}
        />
        <ToolCallList events={toolCalls} />
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeader
          title={t("runDetail.logTail")}
          caption={t("runDetail.logTailCaption")}
        />
        <LogTail lines={logsTail} />
      </section>

      {run.latestReviewFeedback ? (
        <ReviewFeedbackPanel summary={run.latestReviewFeedback} />
      ) : null}

      {report?.reviewReworkPlan ? (
        <section className="flex flex-col gap-3">
          <ReviewReworkPlanPanel
            plan={report.reviewReworkPlan}
            onAcceptPlan={(planId) => {
              startAction(async () => {
                try {
                  await acceptReviewReworkPlan(planId);
                  setActionError(null);
                  router.refresh();
                } catch (err) {
                  setActionError(reviewReworkActionErrorMessage(err, "accept"));
                }
              });
            }}
            onDismissPlan={(planId, reason) => {
              startAction(async () => {
                try {
                  await dismissReviewReworkPlan(planId, reason);
                  setActionError(null);
                  router.refresh();
                } catch (err) {
                  setActionError(
                    reviewReworkActionErrorMessage(err, "dismiss"),
                  );
                }
              });
            }}
            onItemAction={(planId, itemId, next, reason) => {
              if (next === "open") return;
              startAction(async () => {
                try {
                  await updateReviewReworkItem(planId, itemId, next, reason);
                  setActionError(null);
                  router.refresh();
                } catch (err) {
                  setActionError(
                    reviewReworkActionErrorMessage(err, `item-${next}`),
                  );
                }
              });
            }}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * V4.9: shared error formatter for review rework operator actions.
 * Mirrors {@link performAction} above — surfaces `ApiError.reason` when
 * the orchestrator returned a structured `{ code }` body and falls back
 * to the message for transport-level failures.
 */
function reviewReworkActionErrorMessage(err: unknown, action: string): string {
  if (err instanceof ApiError) {
    return `review rework ${action} failed: ${
      err.reason ?? `HTTP ${err.status ?? "?"}`
    }`;
  }
  if (err instanceof Error) return `review rework ${action} failed: ${err.message}`;
  return `review rework ${action} failed: unknown error`;
}

function SectionHeader({ title, caption }: { title: string; caption: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="text-base font-semibold tracking-tight text-fg">{title}</h2>
      <p className="text-xs text-fg-muted">{caption}</p>
    </div>
  );
}

const REVIEW_BODY_TRUNCATE_LIMIT = 200;

function truncateBody(body: string): string {
  if (body.length <= REVIEW_BODY_TRUNCATE_LIMIT) return body;
  return `${body.slice(0, REVIEW_BODY_TRUNCATE_LIMIT)}…`;
}

function ReviewFeedbackPanel({
  summary,
}: {
  summary: ReviewFeedbackSummary;
}) {
  const t = useTranslations("runDetail");
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="review-feedback-heading"
    >
      <h2
        id="review-feedback-heading"
        className="text-base font-semibold tracking-tight text-fg"
      >
        {t("reviewFeedback")}
      </h2>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle className="text-sm">
            {t("openMrLabel", { id: summary.mrIid })}{" "}
            <a
              href={summary.mrUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-xs text-info hover:underline"
            >
              {t("openMr")}
            </a>
          </CardTitle>
          <div className="flex flex-col items-end gap-1 font-mono text-[11px] text-fg-subtle">
            <span>
              {t("reviewSwept")}{" "}
              <time dateTime={summary.generatedAt}>{summary.generatedAt}</time>
            </span>
            <span>
              {t("reviewCursor")} <time dateTime={summary.cursor}>{summary.cursor}</time>
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {summary.comments.length === 0 ? (
            <p className="text-fg-subtle">{t("reviewEmpty")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {summary.comments.map((comment) => (
                <li
                  key={comment.noteId}
                  className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-fg">
                        @{comment.author}
                      </span>
                      <time
                        dateTime={comment.createdAt}
                        className="font-mono text-fg-subtle"
                      >
                        {comment.createdAt}
                      </time>
                      {comment.resolved ? (
                        <Badge
                          tone="success"
                          aria-label={t("noteResolvedAria", { id: comment.noteId })}
                        >
                          {t("resolved")}
                        </Badge>
                      ) : null}
                    </div>
                    <a
                      href={comment.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-xs text-info hover:underline"
                      aria-label={t("viewNoteAria", { id: comment.noteId })}
                    >
                      {t("viewNote")}
                    </a>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-fg">
                    {truncateBody(comment.body)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function Field({
  label,
  children,
  mono,
  className,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-0.5 ${className ?? ""}`}>
      <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
        {label}
      </dt>
      <dd className={`${mono ? "font-mono" : ""} text-sm text-fg`}>
        {children}
      </dd>
    </div>
  );
}
