"use client";

import type {
  ReviewReworkItem,
  ReviewReworkItemStatus,
  ReviewReworkPlan,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Badge, type BadgeTone } from "../ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

/**
 * V4.9 Intelligent Review Workflow — operator-facing rework plan panel.
 *
 * Anchored on `ReviewReworkPlan`:
 *  - draft plans are accept/dismiss-able; once accepted the plan goes
 *    into the next ai-rework dispatch and the action footer locks.
 *  - per-item rows expose accept / dismiss / resolve so the operator
 *    can curate the plan after the planner draft lands.
 *
 * Accessibility:
 *  - section is labelled via `aria-labelledby`;
 *  - status / category / priority are conveyed by text + tonal color
 *    (never by color alone — see ui-ux-pro-max §1 `color-not-only`);
 *  - all interactive controls keep visible focus rings via the design
 *    system's existing `focus-visible` ring on `<button>`.
 */
export interface ReviewReworkPlanPanelProps {
  plan: ReviewReworkPlan;
  onAcceptPlan: (planId: string) => void;
  onDismissPlan: (planId: string, reason: string) => void;
  onItemAction: (
    planId: string,
    itemId: string,
    next: ReviewReworkItemStatus,
  ) => void;
}

const PRIORITY_TONES: Record<ReviewReworkItem["priority"], BadgeTone> = {
  blocking: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

const STATUS_TONES: Record<ReviewReworkPlan["status"], BadgeTone> = {
  draft: "neutral",
  accepted: "success",
  dismissed: "warning",
  resolved: "success",
  superseded: "neutral",
};

function pascal(value: string): string {
  return value.replace(/(^|_)(.)/g, (_match, _sep, char: string) =>
    char.toUpperCase(),
  );
}

export function ReviewReworkPlanPanel({
  plan,
  onAcceptPlan,
  onDismissPlan,
  onItemAction,
}: ReviewReworkPlanPanelProps) {
  const t = useTranslations("reviewRework");
  const blocking = plan.items.filter((i) => i.priority === "blocking").length;
  const open = plan.items.filter((i) => i.status === "open").length;
  const accepted = plan.items.filter((i) => i.status === "accepted").length;
  const resolved = plan.items.filter((i) => i.status === "resolved").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle id="review-rework-plan-heading">{t("title")}</CardTitle>
          <Badge tone={STATUS_TONES[plan.status]}>
            {t(`status${pascal(plan.status)}`)}
          </Badge>
        </div>
        <p className="font-mono text-[11px] text-fg-subtle">
          {t("generatedAt", { value: plan.generatedAt })}
        </p>
      </CardHeader>
      <CardContent
        aria-labelledby="review-rework-plan-heading"
        className="flex flex-col gap-4 text-sm"
      >
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("blockingItems")} value={blocking} tone="danger" />
          <Stat label={t("openItems")} value={open} tone="info" />
          <Stat label={t("acceptedItems")} value={accepted} tone="success" />
          <Stat label={t("resolvedItems")} value={resolved} tone="success" />
        </dl>
        {plan.items.length === 0 ? (
          <p className="text-fg-subtle">{t("emptyState")}</p>
        ) : (
          <ul role="list" className="flex flex-col gap-3">
            {plan.items.map((item) => (
              <ReworkItemRow
                key={item.itemId}
                item={item}
                planStatus={plan.status}
                onItemAction={(next) =>
                  onItemAction(plan.planId, item.itemId, next)
                }
              />
            ))}
          </ul>
        )}
        <footer className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onAcceptPlan(plan.planId)}
            disabled={plan.status !== "draft"}
            className={cn(
              "rounded-md border border-success bg-success px-3 py-1.5 text-xs font-semibold text-fg-inverted",
              "transition-colors hover:bg-success/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-success",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {t("acceptPlan")}
          </button>
          <button
            type="button"
            onClick={() =>
              onDismissPlan(plan.planId, "operator dismissed via dashboard")
            }
            disabled={plan.status !== "draft"}
            className={cn(
              "rounded-md border border-border bg-surface-2 px-3 py-1.5 text-xs font-semibold text-fg",
              "transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {t("dismissPlan")}
          </button>
        </footer>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: BadgeTone;
}) {
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface-2 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      <span className="flex items-center gap-2 font-mono text-base font-semibold">
        <span data-tone={tone} className="tabular-nums">
          {value}
        </span>
      </span>
    </div>
  );
}

function ReworkItemRow({
  item,
  planStatus,
  onItemAction,
}: {
  item: ReviewReworkItem;
  planStatus: ReviewReworkPlan["status"];
  onItemAction: (next: ReviewReworkItemStatus) => void;
}) {
  const t = useTranslations("reviewRework");
  const disabled = planStatus === "dismissed" || planStatus === "superseded";
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={PRIORITY_TONES[item.priority]}>{t(item.priority)}</Badge>
        <Badge tone="neutral">{t(`categories.${item.category}`)}</Badge>
        <Badge tone="violet">{t(item.status)}</Badge>
        <span className="font-medium text-fg">{item.title}</span>
      </div>
      {item.summary && item.summary !== item.title ? (
        <p className="text-fg-subtle">{item.summary}</p>
      ) : null}
      {item.targetFiles.length > 0 ? (
        <p className="font-mono text-[11px] text-fg-subtle">
          <span className="mr-1 uppercase tracking-wide">
            {t("targetFilesLabel")}:
          </span>
          {item.targetFiles.join(", ")}
        </p>
      ) : null}
      {item.sourceRefs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-[11px] uppercase tracking-wide text-fg-subtle">
            {t("sourcesLabel")}:
          </span>
          {item.sourceRefs.map((ref) => (
            <a
              key={`${ref.kind}-${ref.id}`}
              className="text-info hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info"
              href={ref.url ?? "#"}
              target={ref.url ? "_blank" : undefined}
              rel={ref.url ? "noreferrer" : undefined}
            >
              {t(`sourceKinds.${ref.kind}`)}
            </a>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <ItemButton
          label={t("accept")}
          tone="success"
          disabled={disabled || item.status === "accepted"}
          onClick={() => onItemAction("accepted")}
        />
        <ItemButton
          label={t("dismiss")}
          tone="warning"
          disabled={disabled || item.status === "dismissed"}
          onClick={() => onItemAction("dismissed")}
        />
        <ItemButton
          label={t("resolve")}
          tone="info"
          disabled={disabled || item.status === "resolved"}
          onClick={() => onItemAction("resolved")}
        />
      </div>
    </li>
  );
}

function ItemButton({
  label,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  tone: "success" | "warning" | "info";
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === "success"
      ? "border-success/40 text-success-fg hover:bg-success-soft focus-visible:outline-success"
      : tone === "warning"
        ? "border-warning/40 text-warning-fg hover:bg-warning-soft focus-visible:outline-warning"
        : "border-info/40 text-info-fg hover:bg-info-soft focus-visible:outline-info";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-md border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        toneClass,
      )}
    >
      {label}
    </button>
  );
}
