import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "@issuepilot/observability";
import type { ReviewReworkPlan } from "@issuepilot/shared-contracts";

export interface ReviewReworkPlanFilters {
  runId?: string;
  issueIid?: number;
  workItemId?: string;
  taskId?: string;
  projectId?: string;
  status?: ReviewReworkPlan["status"];
}

export interface ReviewReworkPlanStore {
  save(plan: ReviewReworkPlan): Promise<void>;
  get(planId: string): Promise<ReviewReworkPlan | undefined>;
  list(filters?: ReviewReworkPlanFilters): Promise<ReviewReworkPlan[]>;
  supersede(input: { oldPlanId: string; newPlanId: string }): Promise<void>;
}

export function createReviewReworkPlanStore(opts: {
  rootDir: string;
}): ReviewReworkPlanStore {
  const cache = new Map<string, ReviewReworkPlan>();
  const dir = join(opts.rootDir, "review-rework-plans");

  async function writeJsonAtomic(
    path: string,
    payload: ReviewReworkPlan,
  ): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const body = JSON.stringify(redact(payload), null, 2);
    await writeFile(tmp, `${body}\n`, "utf8");
    await rename(tmp, path);
  }

  async function loadAllFromDisk(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (cache.has(id)) continue;
      try {
        const body = await readFile(join(dir, entry), "utf8");
        cache.set(id, JSON.parse(body) as ReviewReworkPlan);
      } catch {
        continue;
      }
    }
  }

  function matches(
    plan: ReviewReworkPlan,
    filters?: ReviewReworkPlanFilters,
  ): boolean {
    if (!filters) return true;
    if (filters.runId && plan.runId !== filters.runId) return false;
    if (filters.issueIid !== undefined && plan.issueIid !== filters.issueIid) {
      return false;
    }
    if (filters.workItemId && plan.workItemId !== filters.workItemId) {
      return false;
    }
    if (filters.taskId && plan.taskId !== filters.taskId) return false;
    if (filters.projectId && plan.projectId !== filters.projectId) return false;
    if (filters.status && plan.status !== filters.status) return false;
    return true;
  }

  const api: ReviewReworkPlanStore = {
    async save(plan) {
      cache.set(plan.planId, plan);
      await writeJsonAtomic(join(dir, `${plan.planId}.json`), plan);
    },
    async get(planId) {
      const cached = cache.get(planId);
      if (cached) return cached;
      try {
        const body = await readFile(join(dir, `${planId}.json`), "utf8");
        const parsed = JSON.parse(body) as ReviewReworkPlan;
        cache.set(planId, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    },
    async list(filters) {
      await loadAllFromDisk();
      return [...cache.values()]
        .filter((plan) => matches(plan, filters))
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    },
    async supersede({ oldPlanId, newPlanId }) {
      const oldPlan = await api.get(oldPlanId);
      const newPlan = await api.get(newPlanId);
      if (!oldPlan || !newPlan) return;
      await api.save({
        ...oldPlan,
        status: "superseded",
        supersededByPlanId: newPlanId,
      });
      await api.save({
        ...newPlan,
        supersedesPlanId: oldPlanId,
      });
    },
  };
  return api;
}
