"use client";

import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export type WorkItemView = "list" | "graph";

export interface ViewToggleProps {
  view: WorkItemView;
  onChange: (view: WorkItemView) => void;
}

/**
 * V4.2: toggle between the task **List** view (groups by status, used
 * for operator triage) and the **Graph** view (topology SVG, used for
 * dependency / critical-path inspection). The view state lives in the
 * parent — usually persisted via the URL `?view=` search param so refresh
 * + share-link survive.
 */
export function ViewToggle({ view, onChange }: ViewToggleProps) {
  const t = useTranslations("workItem.viewToggle");
  return (
    <div
      role="group"
      aria-label={t("list") + " / " + t("graph")}
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
    </div>
  );
}
