import type {
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendation,
  ImprovementRecommendationFilters,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

import { buildImprovementRecommendations } from "./engine.js";
import { generatePatchPreview } from "./patch-preview.js";
import type { ImprovementStore } from "./store.js";
import type { TargetPathResolver } from "./types.js";

export type ImprovementServiceError = {
  error: { code: string; message: string };
};

export interface ImprovementService {
  list(
    filters: ImprovementRecommendationFilters,
  ): Promise<ImprovementRecommendation[]>;
  detail(id: string): Promise<ImprovementRecommendation | undefined>;
  generate(input: ImprovementGenerateRequest): Promise<ImprovementGenerateResponse>;
  accept(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  reject(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  defer(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  patchPreview(
    id: string,
    input: ImprovementPatchPreviewRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
}

export function createImprovementService(deps: {
  store: ImprovementStore;
  buildQualitySummary: (
    input: ImprovementGenerateRequest,
  ) => Promise<QualitySummaryResponse>;
  now?: () => Date;
  /**
   * Optional hook used by the recommendation engine to materialise the
   * `target.path` for newly emitted recommendations. Returning `undefined`
   * keeps the recommendation patch preview in `blocked: target_path_missing`
   * — the dashboard surfaces that as a hint and patch preview is a no-op.
   */
  resolveTargetPath?: TargetPathResolver;
  /**
   * Whitelist of absolute path prefixes the inert patch preview is allowed to
   * read from disk. Anything outside these prefixes is reported as
   * `blocked: target_outside_sandbox` — preventing operator-influenced
   * `target.path` values (or a manually edited recommendation file) from
   * tricking the orchestrator into reading e.g. `~/.issuepilot/credentials`.
   */
  allowedPathPrefixes?: string[];
}): ImprovementService {
  const now = deps.now ?? (() => new Date());

  async function action(
    id: string,
    status: ImprovementRecommendation["status"],
    actionName: "accepted" | "rejected" | "deferred",
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError> {
    const current = await deps.store.get(id);
    if (!current) {
      return {
        error: { code: "not_found", message: "recommendation not found" },
      };
    }
    const next: ImprovementRecommendation = {
      ...current,
      status,
      updatedAt: now().toISOString(),
      actionHistory: [
        ...current.actionHistory,
        {
          action: actionName,
          actor: "operator",
          at: now().toISOString(),
          ...(input.note ? { note: input.note } : {}),
        },
      ],
    };
    await deps.store.save(next);
    return { recommendation: next };
  }

  return {
    list(filters) {
      return deps.store.list(filters);
    },
    detail(id) {
      return deps.store.get(id);
    },
    async generate(input) {
      const summary = await deps.buildQualitySummary(input);
      const existing = await deps.store.list();
      const result = buildImprovementRecommendations({
        summary,
        existing,
        now,
        ...(deps.resolveTargetPath
          ? { resolveTargetPath: deps.resolveTargetPath }
          : {}),
      });
      const existingIds = new Set(existing.map((r) => r.recommendationId));
      let generated = 0;
      let updated = 0;
      let superseded = 0;
      for (const recommendation of result.recommendations) {
        if (existingIds.has(recommendation.recommendationId)) {
          updated += 1;
        } else {
          generated += 1;
        }
        await deps.store.save(recommendation);
      }
      for (const supersededId of result.supersededIds) {
        const previous = await deps.store.get(supersededId);
        if (!previous || previous.status === "superseded") continue;
        const ts = now().toISOString();
        await deps.store.save({
          ...previous,
          status: "superseded",
          updatedAt: ts,
          actionHistory: [
            ...previous.actionHistory,
            { action: "superseded", actor: "system", at: ts },
          ],
        });
        superseded += 1;
      }
      return {
        recommendations: result.recommendations,
        generated,
        updated,
        skipped: superseded,
      };
    },
    accept(id, input) {
      return action(id, "accepted", "accepted", input);
    },
    reject(id, input) {
      return action(id, "rejected", "rejected", input);
    },
    defer(id, input) {
      return action(id, "deferred", "deferred", input);
    },
    async patchPreview(id, input) {
      const current = await deps.store.get(id);
      if (!current) {
        return {
          error: { code: "not_found", message: "recommendation not found" },
        };
      }
      const preview = await generatePatchPreview({
        recommendation: current,
        now,
        ...(deps.allowedPathPrefixes
          ? { allowedPathPrefixes: deps.allowedPathPrefixes }
          : {}),
      });
      const next: ImprovementRecommendation = {
        ...current,
        patchPreview: preview,
        updatedAt: now().toISOString(),
        actionHistory: [
          ...current.actionHistory,
          {
            action: "patch_preview_generated",
            actor: input.operator ? "operator" : "system",
            at: now().toISOString(),
          },
        ],
      };
      await deps.store.save(next);
      return { recommendation: next };
    },
  };
}
