"use client";

import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  PROJECT_COOKIE_KEY,
  PROJECT_COOKIE_MAX_AGE_SECONDS,
} from "../../lib/active-project-cookie";
import { setActiveWorkItemsProject } from "../../lib/api";

export const PROJECT_STORAGE_KEY = PROJECT_COOKIE_KEY;
export const PROJECT_CHANGED_EVENT = "issuepilot:project-changed";

/**
 * Mirror the active project selection into a cookie so Server
 * Components (work-items detail page) can read it during SSR and
 * attach `x-issuepilot-project` to the orchestrator request. The
 * cookie is intentionally a perfect mirror of localStorage so both
 * SSR and CSR see the same value. See review §C3.
 */
function writeProjectCookie(value: string): void {
  if (typeof document === "undefined") return;
  const encoded = encodeURIComponent(value);
  document.cookie = `${PROJECT_COOKIE_KEY}=${encoded}; path=/; max-age=${PROJECT_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

function clearProjectCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${PROJECT_COOKIE_KEY}=; path=/; max-age=0; samesite=lax`;
}

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
  // V4.2 review I2: keep the initial render deterministic across SSR
  // and CSR (both start with ""). The persisted selection is read in
  // the post-mount effect below so React does not see a hydration
  // mismatch when the switcher ever ends up inside an SSR'd tree.
  const [value, setValue] = useState<string>("");

  useEffect(() => {
    if (mode !== "team") return;
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? "";
    if (stored) {
      setValue(stored);
      setActiveWorkItemsProject(stored);
      // Mirror into the cookie too — operators may have set
      // localStorage in a previous session before the cookie path
      // existed. Without this the SSR detail page would still 400.
      writeProjectCookie(stored);
    }
  }, [mode]);

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
              writeProjectCookie(next);
            } else {
              window.localStorage.removeItem(PROJECT_STORAGE_KEY);
              clearProjectCookie();
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
