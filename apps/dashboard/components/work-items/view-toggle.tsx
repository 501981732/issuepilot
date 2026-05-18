"use client";

import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type WorkItemView = "list" | "graph" | "evidence";

export interface ViewToggleProps {
  view: WorkItemView;
  onChange: (view: WorkItemView) => void;
}

/**
 * V4.3: toggle between the task **List** view (groups by status, used
 * for operator triage), **Graph** view (topology SVG, used for
 * dependency / critical-path inspection), and **Evidence** view (review
 * packet evidence). The view state lives in the
 * parent — usually persisted via the URL `?view=` search param so refresh
 * + share-link survive.
 */
export function ViewToggle({ view, onChange }: ViewToggleProps) {
  const t = useTranslations("workItem.viewToggle");
  return (
    <div
      role="group"
      aria-label={t("list") + " / " + t("graph") + " / " + t("evidence")}
      className="inline-flex rounded-md border border-border bg-surface-1 p-0.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={view === "list"}
        className={cn(view === "list" && "bg-surface-2 text-fg")}
        onClick={() => onChange("list")}
      >
        {t("list")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={view === "graph"}
        className={cn(view === "graph" && "bg-surface-2 text-fg")}
        onClick={() => onChange("graph")}
      >
        {t("graph")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={view === "evidence"}
        className={cn(view === "evidence" && "bg-surface-2 text-fg")}
        onClick={() => onChange("evidence")}
      >
        {t("evidence")}
      </Button>
    </div>
  );
}
