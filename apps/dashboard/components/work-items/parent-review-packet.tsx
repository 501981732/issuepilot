"use client";

import type {
  WorkItemEvidenceEntry,
  WorkItemReport,
  WorkItemReportStatus,
  WorkItemTaskSummary,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

import { getWorkItemReportMarkdown } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { ConfidencePill } from "./confidence-pill";
import { HumanReviewChecklist } from "./human-review-checklist";
import { ReviewReworkSummary } from "./review-rework-summary";

const STATUS_TONE: Record<WorkItemReportStatus, string> = {
  draft: "bg-fg-subtle/20 text-fg-subtle",
  partial: "bg-warning-soft text-warning-fg",
  complete: "bg-success-soft text-success-fg",
  incomplete: "bg-danger-soft text-danger-fg",
};

const EVIDENCE_KIND_KEY: Record<WorkItemEvidenceEntry["kind"], string> = {
  diff: "evidenceDiff",
  validation: "evidenceValidation",
  risk: "evidenceRisk",
  ci: "evidenceCi",
  review_feedback: "evidenceReview",
  screenshot: "evidence",
  recording: "evidence",
  playwright: "evidence",
  command_output: "evidence",
  test_result: "evidence",
};

export interface ParentReviewPacketProps {
  report?: WorkItemReport;
  project?: string;
}

export function ParentReviewPacket({ report, project }: ParentReviewPacketProps) {
  const t = useTranslations("workItem.parentReviewPacket");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!report) return;
    try {
      const md = await getWorkItemReportMarkdown(
        report.workItemId,
        project ? { project } : {},
      );
      // navigator.clipboard may not exist in jsdom; fall back to document.execCommand
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(md);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = md;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best-effort copy; ignore failures
    }
  }, [project, report]);

  if (!report) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-fg-subtle">{t("empty")}</p>
        </CardContent>
      </Card>
    );
  }

  const overallStatusLabel = (() => {
    switch (report.overallStatus) {
      case "complete":
        return t("statusComplete");
      case "partial":
        return t("statusPartial");
      case "incomplete":
        return t("statusIncomplete");
      case "draft":
        return t("statusIncomplete");
    }
  })();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{t("title")}</CardTitle>
          <span className="font-mono text-[11px] text-fg-subtle">
            {report.generatedAt}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              STATUS_TONE[report.overallStatus],
            )}
          >
            {overallStatusLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
          >
            {copied ? t("copied") : t("copyMarkdown")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {report.humanReviewChecklist.length > 0 ? (
          <HumanReviewChecklist items={report.humanReviewChecklist} />
        ) : null}

        <Section title={t("validation")}>
          <p className="whitespace-pre-line text-sm text-fg">
            {report.validationSummary || "—"}
          </p>
        </Section>
        <Section title={t("risks")}>
          <p className="whitespace-pre-line text-sm text-fg">
            {report.riskSummary || "—"}
          </p>
        </Section>

        {report.taskSummaries.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {report.taskSummaries.map((task) => (
              <TaskCard key={task.taskId} task={task} t={t} />
            ))}
          </ul>
        ) : null}

        {report.openQuestions.length > 0 ? (
          <Section title={t("openQuestions")}>
            <ul className="list-disc pl-5 text-sm text-fg-muted">
              {report.openQuestions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title={t("nextActions")}>
          {report.recommendedNextActions.length > 0 ? (
            <ul className="list-disc pl-5 text-sm text-fg">
              {report.recommendedNextActions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">{t("noNextActions")}</p>
          )}
        </Section>

        {report.reviewReworkSummary ? (
          <ReviewReworkSummary summary={report.reviewReworkSummary} />
        ) : null}

        {report.evidence.index.length > 0 ? (
          <Section title={t("evidence")}>
            <ul className="flex flex-col gap-1 text-sm">
              {report.evidence.index.map((entry, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    {t(EVIDENCE_KIND_KEY[entry.kind])}
                  </span>
                  <span className="font-mono text-[11px] text-fg-subtle">
                    {entry.taskId}
                  </span>
                  {entry.href ? (
                    <a
                      href={entry.href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-info-fg hover:underline"
                    >
                      {entry.label}
                    </a>
                  ) : (
                    <span className="text-fg">{entry.label}</span>
                  )}
                  {entry.text ? (
                    <span className="text-xs text-fg-muted">
                      — {entry.text}
                    </span>
                  ) : null}
                  <ConfidencePill confidence={entry.confidence} />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
        {title}
      </span>
      {children}
    </div>
  );
}

function TaskCard({
  task,
  t,
}: {
  task: WorkItemTaskSummary;
  t: (k: string) => string;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border/70 bg-surface-1 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-fg">{task.title}</span>
          <span className="font-mono text-[11px] text-fg-subtle">
            {task.taskId} · {task.taskStatus}
            {task.runId ? ` · ${task.runId}` : ""}
          </span>
        </div>
        {task.mergeRequestUrl ? (
          <a
            href={task.mergeRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-info-fg hover:underline"
          >
            MR ↗
          </a>
        ) : null}
      </div>
      {task.diffSummary ? (
        <p className="text-xs text-fg-muted">{task.diffSummary}</p>
      ) : null}
      {task.validation.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            {t("evidenceValidation")}
          </span>
          <ul className="list-disc pl-5 text-xs text-fg-muted">
            {task.validation.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.risks.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            {t("evidenceRisk")}
          </span>
          <ul className="list-disc pl-5 text-xs text-warning-fg">
            {task.risks.map((r, i) => (
              <li key={i}>
                [{r.level}] {r.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.followUps.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
            follow-ups
          </span>
          <ul className="list-disc pl-5 text-xs text-fg-muted">
            {task.followUps.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {task.ciStatus ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
          ci · {task.ciStatus}
        </span>
      ) : null}
      {task.nextAction ? (
        <p className="text-xs text-fg">→ {task.nextAction}</p>
      ) : null}
    </li>
  );
}
