"use client";

import type {
  AgentReport,
  AgentRole,
  CoderAgentReport,
  ReviewerAgentReport,
  TestEvidenceAgentReport,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { cn } from "../../lib/cn";
import { Badge, type BadgeTone } from "../ui/badge";

import { RevokeAiReviewButton } from "./revoke-ai-review-button";

/**
 * V4.6 Agent Report Tabs（spec §17.2 / plan Task 11.3）。
 *
 * 三 tab 静态布局，复用 V4.3 evidence 视图（参见 EvidenceTab；本组件只关心
 * AgentReport 内部字段）。每个 tab 内：
 * - coder：summary + （TODO：patch snapshot 链接 + run metadata）。
 * - reviewer：decision badge + summary + findings 表格 + inline 评论折叠 +
 *   MR publication 状态 + revoke 按钮。
 * - test_evidence：evidenceItems 列表（status 标）。
 */

const ROLES: AgentRole[] = ["coder", "reviewer", "test_evidence"];

function decisionTone(decision: ReviewerAgentReport["reviewer"]["decision"]):
  | BadgeTone {
  switch (decision) {
    case "approve_with_comments":
      return "success";
    case "request_changes":
      return "warning";
    case "cannot_review":
      return "danger";
  }
}

function statusTone(status: AgentReport["status"]): BadgeTone {
  switch (status) {
    case "running":
      return "info";
    case "complete":
      return "success";
    case "incomplete":
      return "warning";
    case "failed":
    case "cancelled":
      return "danger";
  }
}

function severityTone(sev: string): BadgeTone {
  if (sev === "critical") return "danger";
  if (sev === "high") return "danger";
  if (sev === "medium") return "warning";
  return "neutral";
}

export interface AgentReportTabsProps {
  reports: Partial<Record<AgentRole, AgentReport>>;
}

export function AgentReportTabs({ reports }: AgentReportTabsProps) {
  const t = useTranslations("workItem.agentReportTab");
  const firstAvailableRole = ROLES.find((r) => reports[r]) ?? "coder";
  const [activeRole, setActiveRole] = useState<AgentRole>(firstAvailableRole);
  const activeReport = reports[activeRole];

  return (
    <section
      data-component="agent-report-tabs"
      data-active-role={activeRole}
      className="space-y-3 rounded-md border border-border bg-surface px-4 py-3"
      aria-label={t("ariaLabel")}
    >
      <header className="flex items-center gap-2 border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-fg">{t("title")}</h3>
        <div role="tablist" className="flex flex-wrap gap-1">
          {ROLES.map((role) => (
            <button
              key={role}
              type="button"
              role="tab"
              aria-selected={activeRole === role ? "true" : "false"}
              data-testid={`agent-tab-${role}`}
              onClick={() => setActiveRole(role)}
              className={cn(
                "rounded-md px-3 py-1 text-xs",
                activeRole === role
                  ? "bg-info-soft text-info-fg border border-info/40"
                  : "border border-transparent text-fg-muted hover:bg-surface-2",
              )}
            >
              {t(`tab.${role}`)}
            </button>
          ))}
        </div>
      </header>
      <div role="tabpanel" aria-labelledby={`agent-tab-${activeRole}`}>
        {!activeReport ? (
          <p
            className="text-sm text-fg-muted"
            data-testid={`agent-empty-${activeRole}`}
          >
            {t("empty")}
          </p>
        ) : activeRole === "coder" ? (
          <CoderPanel report={activeReport as CoderAgentReport} />
        ) : activeRole === "reviewer" ? (
          <ReviewerPanel report={activeReport as ReviewerAgentReport} />
        ) : (
          <TestEvidencePanel report={activeReport as TestEvidenceAgentReport} />
        )}
      </div>
    </section>
  );
}

function CoderPanel({ report }: { report: CoderAgentReport }) {
  const t = useTranslations("workItem.agentReportTab");
  return (
    <div className="space-y-2" data-testid="coder-panel">
      <header className="flex items-center gap-2">
        <Badge tone={statusTone(report.status)}>{report.status}</Badge>
      </header>
      <p className="whitespace-pre-wrap text-sm text-fg">
        {(report.coder as { summary?: string })?.summary ?? ""}
      </p>
      {report.lastError ? (
        <p className="text-xs text-danger-fg" data-testid="coder-lastError">
          {t("lastError")}: {report.lastError.code}{" "}
          {report.lastError.message ? `· ${report.lastError.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function ReviewerPanel({ report }: { report: ReviewerAgentReport }) {
  const t = useTranslations("workItem.agentReportTab");
  const decisionLabel = t(`decision.${report.reviewer.decision}`);
  return (
    <div className="space-y-3" data-testid="reviewer-panel">
      <header className="flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(report.status)}>{report.status}</Badge>
        <Badge
          tone={decisionTone(report.reviewer.decision)}
          data-testid="reviewer-decision-badge"
        >
          {decisionLabel}
        </Badge>
        <span className="text-xs text-fg-muted">
          confidence {report.reviewer.confidence.toFixed(2)}
        </span>
        <RevokeAiReviewButton
          agentReportId={report.agentReportId}
          role="reviewer"
          agentReportStatus={report.status}
          mrPublicationStatus={report.reviewer.mrPublication.status}
        />
      </header>
      <p className="whitespace-pre-wrap text-sm text-fg">
        {report.reviewer.summary}
      </p>
      <section>
        <h4 className="text-xs font-semibold text-fg-muted">
          {t("findings.title")}
        </h4>
        {report.reviewer.findings.length === 0 ? (
          <p className="text-xs text-fg-muted">{t("findings.empty")}</p>
        ) : (
          <ul className="mt-1 space-y-1" data-testid="reviewer-findings">
            {[...report.reviewer.findings]
              .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
              .map((f, idx) => (
                <li
                  key={`${f.category}-${idx}`}
                  className="flex items-start gap-2 rounded border border-border bg-surface-2 px-2 py-1 text-xs"
                >
                  <Badge tone={severityTone(f.severity)}>
                    {t(`findings.severity.${f.severity}`)}
                  </Badge>
                  <div>
                    <p className="font-medium text-fg">{f.category}</p>
                    <p className="text-fg-muted">{f.message}</p>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="text-xs font-semibold text-fg-muted">
          {t("inlineComments.title")} ({report.reviewer.inlineComments.length})
        </h4>
        {report.reviewer.inlineComments.length === 0 ? (
          <p className="text-xs text-fg-muted">{t("inlineComments.empty")}</p>
        ) : (
          <ul className="mt-1 space-y-1" data-testid="reviewer-inline-comments">
            {report.reviewer.inlineComments.map((c, idx) => (
              <li
                key={idx}
                className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
              >
                <p className="font-mono text-fg-muted">
                  {c.filePath}:{c.lineRange.start}-{c.lineRange.end}
                </p>
                <p className="mt-1 text-fg">{c.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4 className="text-xs font-semibold text-fg-muted">
          {t("mrPublication.title")}
        </h4>
        <Badge tone="neutral" data-testid="mr-publication-status">
          {report.reviewer.mrPublication.status}
        </Badge>
      </section>
    </div>
  );
}

function TestEvidencePanel({ report }: { report: TestEvidenceAgentReport }) {
  const t = useTranslations("workItem.agentReportTab");
  return (
    <div className="space-y-2" data-testid="test-evidence-panel">
      <header className="flex items-center gap-2">
        <Badge tone={statusTone(report.status)}>{report.status}</Badge>
      </header>
      <section>
        <h4 className="text-xs font-semibold text-fg-muted">
          {t("evidenceItems.title")} ({report.testEvidence.evidenceItems.length})
        </h4>
        {report.testEvidence.evidenceItems.length === 0 ? (
          <p className="text-xs text-fg-muted">{t("evidenceItems.empty")}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {report.testEvidence.evidenceItems.map((ev, idx) => (
              <li
                key={`${ev.kind}-${idx}`}
                className="flex items-center gap-2 rounded border border-border bg-surface-2 px-2 py-1 text-xs"
              >
                <Badge
                  tone={
                    ev.status === "collected"
                      ? "success"
                      : ev.status === "skipped"
                        ? "neutral"
                        : "danger"
                  }
                >
                  {ev.status}
                </Badge>
                <span className="font-medium text-fg">{ev.kind}</span>
                <span className="text-fg-muted">{ev.target}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function severityRank(severity: string): number {
  switch (severity) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "medium":
      return 1;
    default:
      return 0;
  }
}
