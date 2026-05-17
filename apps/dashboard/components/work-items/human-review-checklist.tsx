"use client";

import type { HumanReviewChecklistItem } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";

type ChecklistReason = HumanReviewChecklistItem["reason"];

const REASON_KEYS: Record<
  ChecklistReason,
  {
    label: string;
    description: string;
  }
> = {
  "ai-risk-medium": {
    label: "reasons.ai-risk-medium.label",
    description: "reasons.ai-risk-medium.description",
  },
  "ai-risk-high": {
    label: "reasons.ai-risk-high.label",
    description: "reasons.ai-risk-high.description",
  },
  "needs-rework": {
    label: "reasons.needs-rework.label",
    description: "reasons.needs-rework.description",
  },
  "partial-overall": {
    label: "reasons.partial-overall.label",
    description: "reasons.partial-overall.description",
  },
  "missing-evidence": {
    label: "reasons.missing-evidence.label",
    description: "reasons.missing-evidence.description",
  },
  "skipped-task": {
    label: "reasons.skipped-task.label",
    description: "reasons.skipped-task.description",
  },
  "ci-failed": {
    label: "reasons.ci-failed.label",
    description: "reasons.ci-failed.description",
  },
};

export interface HumanReviewChecklistProps {
  items: HumanReviewChecklistItem[];
}

export function HumanReviewChecklist({ items }: HumanReviewChecklistProps) {
  const t = useTranslations("workItem.checklist");

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">{t("confirmHint")}</p>
      <ul role="list" className="flex flex-col gap-2">
        {items.map((item) => {
          const reason = REASON_KEYS[item.reason];
          const confirmedSuffix = item.confirmed
            ? t("confirmedSuffix", {
                confirmedBy: item.confirmedBy ?? t("unknownOperator"),
                confirmedAt: item.confirmedAt ?? t("unknownTime"),
              })
            : "";

          return (
            <li
              key={item.itemId}
              className="flex gap-3 rounded-md border border-border-subtle bg-surface-subtle px-3 py-2"
            >
              <span
                role="checkbox"
                aria-checked={item.confirmed}
                aria-label={t(
                  item.confirmed ? "confirmedAria" : "unconfirmedAria",
                  { label: item.label },
                )}
                className={cn(
                  "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-semibold",
                  item.confirmed
                    ? "border-success-fg bg-success-soft text-success-fg"
                    : "border-border-strong bg-surface text-transparent",
                )}
              >
                x
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-medium text-fg">
                    {item.label}
                  </span>
                  {confirmedSuffix ? (
                    <span className="text-xs text-fg-subtle">
                      {confirmedSuffix}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    {t(reason.label)}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {t(reason.description)}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
