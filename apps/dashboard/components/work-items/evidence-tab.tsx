"use client";

import type {
  WorkItemEvidenceEntry,
  WorkItemEvidenceKind,
  WorkItemEvidenceResponse,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { buildEvidenceFileUrl } from "../../lib/api";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { ConfidencePill } from "./confidence-pill";

const KIND_FILTERS = [
  "all",
  "screenshot",
  "recording",
  "playwright",
  "command_output",
  "test_result",
  "diff",
  "validation",
  "risk",
  "ci",
  "review_feedback",
] as const;

type EvidenceFilter = (typeof KIND_FILTERS)[number];

const KIND_ORDER: WorkItemEvidenceKind[] = [
  "screenshot",
  "recording",
  "playwright",
  "command_output",
  "test_result",
  "diff",
  "validation",
  "risk",
  "ci",
  "review_feedback",
];

interface EvidenceTabProps {
  workItemId: string;
  evidence: WorkItemEvidenceResponse;
  onConfirm: (taskId: string, evidenceId: string) => Promise<void>;
}

export function EvidenceTab({
  workItemId,
  evidence,
  onConfirm,
}: EvidenceTabProps) {
  const t = useTranslations("workItem.evidenceTab");
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(
    () =>
      new Set(
        evidence.index
          .filter((entry) => entry.confidence === "human-confirmed")
          .map((entry) => entry.evidenceId),
      ),
  );
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());

  const visibleEntries = useMemo(
    () =>
      evidence.index.filter((entry) =>
        filter === "all" ? true : entry.kind === filter,
      ),
    [evidence.index, filter],
  );

  const groupedEntries = useMemo(
    () => groupByTask(visibleEntries),
    [visibleEntries],
  );

  async function handleConfirm(entry: WorkItemEvidenceEntry) {
    const previous = confirmedIds;
    setConfirmedIds((current) => new Set(current).add(entry.evidenceId));
    setPendingIds((current) => new Set(current).add(entry.evidenceId));
    try {
      await onConfirm(entry.taskId, entry.evidenceId);
    } catch (error) {
      setConfirmedIds(previous);
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(entry.evidenceId);
        return next;
      });
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label={t("ariaLabel")}>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={t("filterAria")}
      >
        {KIND_FILTERS.map((kind) => {
          const selected = filter === kind;
          return (
            <Button
              key={kind}
              type="button"
              size="sm"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              onClick={() => setFilter(kind)}
            >
              {t(`filters.${kind}`)}
            </Button>
          );
        })}
      </div>

      {groupedEntries.length > 0 ? (
        <div className="flex flex-col gap-4">
          {groupedEntries.map(([taskId, entries]) => (
            <TaskEvidenceCard
              key={taskId}
              taskId={taskId}
              entries={entries}
              workItemId={workItemId}
              confirmedIds={confirmedIds}
              pendingIds={pendingIds}
              onConfirm={handleConfirm}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent>
            <p className="text-sm text-fg-subtle">{t("empty")}</p>
          </CardContent>
        </Card>
      )}

      {evidence.missing.map((missing) => (
        <Card key={missing.taskId} className="border-warning/50">
          <CardHeader>
            <CardTitle>{missing.taskId}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium text-warning-fg">
              {t("missing", { taskId: missing.taskId })}
            </p>
            <p className="mt-1 text-xs text-fg-subtle">
              {t(`missingReasons.${missing.reason}`)}
            </p>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function TaskEvidenceCard({
  taskId,
  entries,
  workItemId,
  confirmedIds,
  pendingIds,
  onConfirm,
}: {
  taskId: string;
  entries: WorkItemEvidenceEntry[];
  workItemId: string;
  confirmedIds: Set<string>;
  pendingIds: Set<string>;
  onConfirm: (entry: WorkItemEvidenceEntry) => Promise<void>;
}) {
  const t = useTranslations("workItem.evidenceTab");
  const entriesByKind = groupByKind(entries);

  return (
    <Card data-testid={`evidence-task-${taskId}`}>
      <CardHeader>
        <CardTitle>{taskId}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {KIND_ORDER.map((kind) => {
          const kindEntries = entriesByKind.get(kind);
          if (!kindEntries || kindEntries.length === 0) return null;
          return (
            <section key={kind} className="flex flex-col gap-3">
              <h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
                {t(`kinds.${kind}`)}
              </h4>
              <ul className="flex flex-col gap-3">
                {kindEntries.map((entry) => (
                  <li
                    key={entry.evidenceId}
                    className="rounded-md border border-border bg-surface-2 p-3"
                  >
                    <EvidenceEntryView
                      entry={entry}
                      workItemId={workItemId}
                      confirmed={confirmedIds.has(entry.evidenceId)}
                      pending={pendingIds.has(entry.evidenceId)}
                      onConfirm={() => onConfirm(entry)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </CardContent>
    </Card>
  );
}

function EvidenceEntryView({
  entry,
  workItemId,
  confirmed,
  pending,
  onConfirm,
}: {
  entry: WorkItemEvidenceEntry;
  workItemId: string;
  confirmed: boolean;
  pending: boolean;
  onConfirm: () => Promise<void>;
}) {
  const t = useTranslations("workItem.evidenceTab");
  const confidence = confirmed ? "human-confirmed" : entry.confidence;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {renderPrimaryEvidence(entry, workItemId, t)}
          {entry.text ? (
            <p className="whitespace-pre-wrap break-words text-sm text-fg-muted">
              {entry.text}
            </p>
          ) : null}
          {entry.capturedAt ? (
            <p className="font-mono text-[11px] text-fg-subtle">
              {t("capturedAt", { capturedAt: entry.capturedAt })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ConfidencePill confidence={confidence} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={confirmed || pending}
            onClick={onConfirm}
          >
            {confirmed
              ? t("confirmed")
              : pending
                ? t("confirming")
                : t("confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function renderPrimaryEvidence(
  entry: WorkItemEvidenceEntry,
  workItemId: string,
  t: ReturnType<typeof useTranslations<"workItem.evidenceTab">>,
) {
  if (entry.kind === "screenshot") {
    const src = evidenceFileUrl(workItemId, entry);
    if (src) {
      return (
        <div className="flex flex-col gap-2">
          <img
            src={src}
            alt={entry.label}
            loading="lazy"
            className="max-h-60 max-w-full rounded-md border border-border object-contain"
          />
          <span className="text-sm font-medium text-fg">{entry.label}</span>
        </div>
      );
    }
  }

  if (entry.kind === "recording") {
    const href = entry.href ?? evidenceFileUrl(workItemId, entry);
    return (
      <EvidenceLinkOrText href={href} label={entry.label} className="text-sm" />
    );
  }

  if (entry.kind === "playwright") {
    const href = entry.href ?? evidenceFileUrl(workItemId, entry);
    return (
      <div className="flex flex-col gap-1">
        <EvidenceLinkOrText
          href={href}
          label={t("openPlaywrightTrace")}
          className="text-sm"
        />
        <p className="text-xs text-fg-subtle">{t("playwrightHint")}</p>
      </div>
    );
  }

  return (
    <EvidenceLinkOrText
      href={entry.href}
      label={entry.label}
      className={cn(
        "text-sm",
        entry.kind === "command_output" || entry.kind === "test_result"
          ? "font-mono"
          : undefined,
      )}
    />
  );
}

function EvidenceLinkOrText({
  href,
  label,
  className,
}: {
  href?: string;
  label: string;
  className?: string;
}) {
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn("font-medium text-info-fg hover:underline", className)}
      >
        {label}
      </a>
    );
  }
  return <span className={cn("font-medium text-fg", className)}>{label}</span>;
}

function evidenceFileUrl(
  workItemId: string,
  entry: WorkItemEvidenceEntry,
): string | undefined {
  if (!entry.source?.runId || !entry.source.relPath) return undefined;
  return buildEvidenceFileUrl(
    workItemId,
    entry.source.runId,
    entry.source.relPath,
  );
}

function groupByTask(
  entries: WorkItemEvidenceEntry[],
): Array<[string, WorkItemEvidenceEntry[]]> {
  const grouped = new Map<string, WorkItemEvidenceEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.taskId);
    if (current) {
      current.push(entry);
    } else {
      grouped.set(entry.taskId, [entry]);
    }
  }
  return Array.from(grouped.entries());
}

function groupByKind(
  entries: WorkItemEvidenceEntry[],
): Map<WorkItemEvidenceKind, WorkItemEvidenceEntry[]> {
  const grouped = new Map<WorkItemEvidenceKind, WorkItemEvidenceEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.kind);
    if (current) {
      current.push(entry);
    } else {
      grouped.set(entry.kind, [entry]);
    }
  }
  return grouped;
}
