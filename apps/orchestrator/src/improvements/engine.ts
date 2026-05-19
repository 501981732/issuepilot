import { createHash } from "node:crypto";

import type {
  FailurePatternId,
  ImprovementEvidenceRef,
  ImprovementRecommendation,
  ImprovementRecommendationStatus,
  QualityDrilldownItem,
} from "@issuepilot/shared-contracts";

import { templateForPattern } from "./templates.js";
import type {
  BuildImprovementRecommendationsInput,
  BuildImprovementRecommendationsResult,
  PatternCluster,
} from "./types.js";

function iso(now: () => Date): string {
  return now().toISOString();
}

function stableId(parts: string[]): string {
  return `rec_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

function clusterKey(input: {
  projectId: string;
  workflow: string | undefined;
  taskType: string | undefined;
  patternId: FailurePatternId;
  targetKind: string;
}): string {
  return [
    input.projectId,
    input.workflow ?? "",
    input.taskType ?? "",
    input.targetKind,
    input.patternId,
  ].join("\0");
}

function evidenceRef(item: QualityDrilldownItem): ImprovementEvidenceRef {
  return {
    kind: "quality-drilldown",
    id: item.itemId,
    href: item.target.href,
    reason: item.reason,
  };
}

function confidence(count: number): ImprovementRecommendation["confidence"] {
  if (count >= 5) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function uniqueEvidence(
  refs: ImprovementEvidenceRef[],
): ImprovementEvidenceRef[] {
  const seen = new Set<string>();
  const out: ImprovementEvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

function clustersFor(
  items: QualityDrilldownItem[],
  patternId: FailurePatternId,
): PatternCluster[] {
  const clusters = new Map<string, PatternCluster>();
  for (const item of items) {
    if (!item.patternIds.includes(patternId)) continue;
    const key = [patternId, item.workflow ?? "", item.taskType ?? ""].join("\0");
    const current =
      clusters.get(key) ??
      ({
        patternId,
        ...(item.workflow ? { workflow: item.workflow } : {}),
        ...(item.taskType ? { taskType: item.taskType } : {}),
        items: [],
      } satisfies PatternCluster);
    current.items.push(item);
    clusters.set(key, current);
  }
  return [...clusters.values()];
}

type DedupeBehavior = "merge" | "supersede" | "skip";

/**
 * Decide how an existing recommendation should interact with a freshly
 * generated one in the same cluster (spec §9.2).
 *
 * - `open` / `deferred` / `blocked` / `stale`: still actionable, merge the
 *   new evidence into the existing record (keep id, keep history).
 * - `accepted` / `rejected`: terminal operator decision. Emit a brand new
 *   recommendation that `supersedes` the old one so the audit trail and the
 *   operator's prior choice are preserved.
 * - `superseded`: already replaced by a newer record; skip emit (the newer
 *   record will be re-emitted by the same loop pass if it's still relevant).
 */
function behaviorFor(status: ImprovementRecommendationStatus): DedupeBehavior {
  switch (status) {
    case "open":
    case "deferred":
    case "blocked":
    case "stale":
      return "merge";
    case "accepted":
    case "rejected":
      return "supersede";
    case "superseded":
      return "skip";
  }
}

export function buildImprovementRecommendations(
  input: BuildImprovementRecommendationsInput,
): BuildImprovementRecommendationsResult {
  const now = input.now ?? (() => new Date());
  const timestamp = iso(now);
  const existingByKey = new Map<string, ImprovementRecommendation>();
  for (const recommendation of input.existing ?? []) {
    const key = clusterKey({
      projectId: recommendation.projectId,
      workflow: recommendation.scope.workflow,
      taskType: recommendation.scope.taskType,
      targetKind: recommendation.target.kind,
      patternId: recommendation.problemPattern,
    });
    // Newer records win when multiple share a cluster key (the store sorts by
    // updatedAt desc on list, but defensively prefer the latest here too).
    const current = existingByKey.get(key);
    if (
      !current ||
      current.updatedAt.localeCompare(recommendation.updatedAt) < 0
    ) {
      existingByKey.set(key, recommendation);
    }
  }

  const next: ImprovementRecommendation[] = [];
  const supersededIds: string[] = [];
  for (const pattern of input.summary.failurePatterns) {
    const template = templateForPattern(pattern.patternId);
    for (const cluster of clustersFor(
      input.summary.drilldown,
      pattern.patternId,
    )) {
      if (cluster.items.length === 0) continue;
      const projectId = cluster.items[0]?.projectId ?? "unknown";
      const key = clusterKey({
        projectId,
        workflow: cluster.workflow,
        taskType: cluster.taskType,
        targetKind: template.targetKind,
        patternId: pattern.patternId,
      });
      const existing = existingByKey.get(key);
      const behavior = existing ? behaviorFor(existing.status) : "merge";
      if (behavior === "skip") continue;

      const targetPath = input.resolveTargetPath
        ? input.resolveTargetPath({ template, cluster, projectId })
        : undefined;
      const isSupersede = behavior === "supersede";
      const baseRefs = isSupersede
        ? cluster.items.map(evidenceRef)
        : [...(existing?.evidenceRefs ?? []), ...cluster.items.map(evidenceRef)];
      const refs = uniqueEvidence(baseRefs);
      const recommendationId =
        !isSupersede && existing
          ? existing.recommendationId
          : stableId([
              projectId,
              cluster.workflow ?? "",
              cluster.taskType ?? "",
              key,
              isSupersede ? `superseding:${existing!.recommendationId}` : "",
              isSupersede ? timestamp : "",
            ]);
      const carriedSupersedes: string[] = [];
      if (isSupersede && existing) {
        carriedSupersedes.push(existing.recommendationId);
        for (const id of existing.supersedes ?? []) {
          if (!carriedSupersedes.includes(id)) carriedSupersedes.push(id);
        }
        supersededIds.push(existing.recommendationId);
      }
      const reuseExisting = !isSupersede && existing;
      next.push({
        recommendationId,
        projectId,
        scope: {
          mode: input.summary.scope.mode,
          ...(input.summary.scope.projectId
            ? { projectId: input.summary.scope.projectId }
            : {}),
          ...(cluster.workflow ? { workflow: cluster.workflow } : {}),
          ...(cluster.taskType ? { taskType: cluster.taskType } : {}),
        },
        problemPattern: pattern.patternId,
        title: template.title,
        summary: template.summary,
        target: {
          kind: template.targetKind,
          description: template.title,
          ...(targetPath ? { path: targetPath } : {}),
        },
        evidenceRefs: refs,
        suggestedChange: template.suggestedChange,
        patchPreview: reuseExisting
          ? existing!.patchPreview
          : {
              status: "not_generated",
              targetDescription: template.title,
            },
        confidence: confidence(refs.length),
        risk: template.risk,
        status: reuseExisting ? existing!.status : "open",
        actionHistory: reuseExisting
          ? existing!.actionHistory
          : [
              {
                action: "generated",
                actor: "system",
                at: timestamp,
                ...(isSupersede && existing
                  ? { note: `supersedes ${existing.recommendationId}` }
                  : {}),
              },
            ],
        createdAt: reuseExisting ? existing!.createdAt : timestamp,
        updatedAt: timestamp,
        ...(carriedSupersedes.length > 0
          ? { supersedes: carriedSupersedes }
          : {}),
      });
    }
  }
  return { recommendations: next, supersededIds };
}
