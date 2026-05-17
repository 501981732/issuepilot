"use client";

import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { setActiveWorkItemsProject } from "../../lib/api";

export const PROJECT_STORAGE_KEY = "issuepilot.workItems.activeProject";
export const PROJECT_CHANGED_EVENT = "issuepilot:project-changed";

export interface ProjectSwitcherProps {
  /**
   * Runtime mode from `/api/state`. The switcher only renders in
   * team-mode — single-mode operators never have to pick a project, the
   * orchestrator routes everything to a single WorkItemService.
   */
  mode: "single" | "team";
  /** Enabled + disabled projects; the switcher filters disabled ones out. */
  projects: ProjectSummary[];
  /** Optional listener invoked whenever the selection changes. */
  onChange?: (projectId: string) => void;
}

/**
 * V4.2 team-mode: top-bar project switcher.
 *
 * Picks which project the dashboard talks to via the
 * `x-issuepilot-project` header on every `/api/work-items/*` request.
 * The selection is persisted to `localStorage` so refresh / new tab
 * keeps the same project; the API client's
 * {@link setActiveWorkItemsProject} module-level state mirrors it for
 * non-React callers (Server Components are fine since they never call
 * work-items routes directly).
 */
export function ProjectSwitcher({
  mode,
  projects,
  onChange,
}: ProjectSwitcherProps) {
  const t = useTranslations("workItem.projectSwitcher");
  const enabled = projects.filter((p) => p.enabled);
  const [value, setValue] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? "";
  });

  useEffect(() => {
    // On hydrate, push the persisted value into the API client too so
    // subsequent fetches carry the header even before a user clicks the
    // dropdown.
    if (mode !== "team") return;
    if (value) setActiveWorkItemsProject(value);
  }, [mode, value]);

  if (mode !== "team") return null;

  return (
    <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
      <span>{t("label")}</span>
      <select
        aria-label={t("label")}
        className="rounded-md border border-border bg-surface-1 px-2 py-1 text-sm normal-case tracking-normal text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (typeof window !== "undefined") {
            if (next) {
              window.localStorage.setItem(PROJECT_STORAGE_KEY, next);
            } else {
              window.localStorage.removeItem(PROJECT_STORAGE_KEY);
            }
          }
          setActiveWorkItemsProject(next || null);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT));
          }
          onChange?.(next);
        }}
      >
        <option value="">{t("all")}</option>
        {enabled.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
