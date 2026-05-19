import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "@issuepilot/observability";
import type {
  ImprovementRecommendation,
  ImprovementRecommendationFilters,
} from "@issuepilot/shared-contracts";

export interface ImprovementStore {
  save(recommendation: ImprovementRecommendation): Promise<void>;
  get(id: string): Promise<ImprovementRecommendation | undefined>;
  list(
    filters?: ImprovementRecommendationFilters,
  ): Promise<ImprovementRecommendation[]>;
}

export function createImprovementStore(opts: {
  rootDir: string;
}): ImprovementStore {
  const recommendations = new Map<string, ImprovementRecommendation>();
  const dir = join(opts.rootDir, "recommendations");

  async function writeJson(path: string, payload: unknown): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify(redact(payload), null, 2)}\n`,
      "utf8",
    );
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
      if (recommendations.has(id)) continue;
      try {
        const body = await readFile(join(dir, entry), "utf8");
        recommendations.set(id, JSON.parse(body) as ImprovementRecommendation);
      } catch {
        continue;
      }
    }
  }

  function matches(
    recommendation: ImprovementRecommendation,
    filters: ImprovementRecommendationFilters | undefined,
  ): boolean {
    if (!filters) return true;
    if (filters.status && recommendation.status !== filters.status) return false;
    if (filters.pattern && recommendation.problemPattern !== filters.pattern) {
      return false;
    }
    if (filters.targetKind && recommendation.target.kind !== filters.targetKind) {
      return false;
    }
    if (filters.workflow && recommendation.scope.workflow !== filters.workflow) {
      return false;
    }
    if (filters.taskType && recommendation.scope.taskType !== filters.taskType) {
      return false;
    }
    return true;
  }

  return {
    async save(recommendation) {
      recommendations.set(recommendation.recommendationId, recommendation);
      await writeJson(
        join(dir, `${recommendation.recommendationId}.json`),
        recommendation,
      );
    },
    async get(id) {
      const cached = recommendations.get(id);
      if (cached) return cached;
      try {
        const body = await readFile(join(dir, `${id}.json`), "utf8");
        const parsed = JSON.parse(body) as ImprovementRecommendation;
        recommendations.set(id, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    },
    async list(filters) {
      await loadAllFromDisk();
      return [...recommendations.values()]
        .filter((recommendation) => matches(recommendation, filters))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}
