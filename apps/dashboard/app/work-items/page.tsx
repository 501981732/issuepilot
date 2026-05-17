"use client";

import type { WorkItemsListResponse } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { WorkItemsList } from "../../components/work-items/work-items-list";
import { listWorkItems } from "../../lib/api";

const PROJECT_STORAGE_KEY = "issuepilot.workItems.activeProject";
const PROJECT_CHANGED_EVENT = "issuepilot:project-changed";

/**
 * V4.2 team-mode: the work-items list is now a client component so it
 * can attach the `x-issuepilot-project` header (sourced from
 * `localStorage` via the API client's module-level state) and re-fetch
 * whenever the operator picks a different project via `ProjectSwitcher`.
 *
 * Single-mode keeps the same behaviour — the API client just omits the
 * header and the orchestrator routes to the default WorkItemService.
 */
export default function WorkItemsRoute() {
  const t = useTranslations("workItems");
  const [data, setData] = useState<WorkItemsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      setError(null);
      listWorkItems()
        .then((next) => {
          if (!cancelled) setData(next);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    }
    load();
    function onStorage(e: StorageEvent) {
      if (e.key === PROJECT_STORAGE_KEY) load();
    }
    function onProjectChanged() {
      load();
    }
    window.addEventListener("storage", onStorage);
    window.addEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    };
  }, []);

  if (error) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          {t("errorTitle")}
        </h1>
        <p className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-fg">
          {error}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <p className="text-sm text-fg-subtle">{t("loading")}</p>
      </div>
    );
  }

  return <WorkItemsList workItems={data.workItems} counters={data.counters} />;
}
