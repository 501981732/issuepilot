import { createHash } from "node:crypto";

import type {
  FailurePatternId,
  ImprovementEvidenceRef,
  ImprovementRecommendation,
  QualityDrilldownItem,
} from "@issuepilot/shared-contracts";

import { templateForPattern } from "./templates.js";
import type {
  BuildImprovementRecommendationsInput,
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
  workflow?: string;
  taskType?: string;
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

export function buildImprovementRecommendations(
  input: BuildImprovementRecommendationsInput,
): ImprovementRecommendation[] {
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
    if (
      recommendation.status === "open" ||
      recommendation.status === "deferred"
    ) {
      existingByKey.set(key, recommendation);
    }
  }

  const next: ImprovementRecommendation[] = [];
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
      const refs = uniqueEvidence([
        ...(existing?.evidenceRefs ?? []),
        ...cluster.items.map(evidenceRef),
      ]);
      const recommendationId =
        existing?.recommendationId ??
        stableId([
          projectId,
          cluster.workflow ?? "",
          cluster.taskType ?? "",
          key,
        ]);
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
        },
        evidenceRefs: refs,
        suggestedChange: template.suggestedChange,
        patchPreview: existing?.patchPreview ?? {
          status: "not_generated",
          targetDescription: template.title,
        },
        confidence: confidence(refs.length),
        risk: template.risk,
        status: existing?.status ?? "open",
        actionHistory: existing?.actionHistory ?? [
          { action: "generated", actor: "system", at: timestamp },
        ],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
  }
  return next;
}
