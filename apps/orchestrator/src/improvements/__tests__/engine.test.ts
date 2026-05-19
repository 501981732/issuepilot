import type {
  QualityDrilldownItem,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { buildImprovementRecommendations } from "../engine.js";

function item(over: Partial<QualityDrilldownItem>): QualityDrilldownItem {
  return {
    itemId: "task:wi:t:missing-evidence",
    patternIds: ["missing-evidence"],
    reason: "Task had no validation evidence",
    projectId: "proj-a",
    workflow: "default",
    taskType: "frontend",
    workItem: { workItemId: "wi-1", title: "Build UI" },
    task: { taskId: "t1", title: "Add UI" },
    updatedAt: "2026-05-18T00:00:00.000Z",
    target: { kind: "evidence", href: "/work-items/wi-1?view=evidence" },
    ...over,
  };
}

function summary(items: QualityDrilldownItem[]): QualitySummaryResponse {
  return {
    scope: { mode: "single-project" },
    filters: {
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-18T23:59:59.999Z",
      window: "7d",
    },
    metrics: [],
    trends: [],
    failurePatterns: [
      {
        patternId: "missing-evidence",
        label: "Missing evidence",
        count: items.length,
        rate: 100,
        latestReason: "Task had no validation evidence",
        drilldownCount: items.length,
      },
    ],
    drilldown: items,
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
  };
}

describe("buildImprovementRecommendations", () => {
  it("clusters repeated quality drilldown items into one recommendation", () => {
    const result = buildImprovementRecommendations({
      summary: summary([
        item({ itemId: "task:wi-1:t-1:missing-evidence" }),
        item({ itemId: "task:wi-2:t-2:missing-evidence" }),
      ]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      problemPattern: "missing-evidence",
      target: { kind: "prompt_template" },
      confidence: "medium",
      risk: "low",
      status: "open",
    });
    expect(result.recommendations[0]?.evidenceRefs).toHaveLength(2);
    expect(result.supersededIds).toEqual([]);
  });

  it("dedupes against existing open recommendations and appends evidence", () => {
    const first = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const existing = first.recommendations[0]!;
    const result = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-2:t-2:missing-evidence" })]),
      existing: [existing],
      now: () => new Date("2026-05-18T02:00:00.000Z"),
    });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.recommendationId).toBe(
      existing.recommendationId,
    );
    expect(result.recommendations[0]?.evidenceRefs.map((ref) => ref.id)).toEqual(
      ["task:wi-1:t-1:missing-evidence", "task:wi-2:t-2:missing-evidence"],
    );
    expect(result.supersededIds).toEqual([]);
  });

  it("supersedes accepted recommendations with a new id and supersedes ref", () => {
    const first = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const accepted = {
      ...first.recommendations[0]!,
      status: "accepted" as const,
      actionHistory: [
        ...first.recommendations[0]!.actionHistory,
        {
          action: "accepted" as const,
          actor: "operator" as const,
          at: "2026-05-18T01:05:00.000Z",
        },
      ],
      updatedAt: "2026-05-18T01:05:00.000Z",
    };
    const result = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-2:t-2:missing-evidence" })]),
      existing: [accepted],
      now: () => new Date("2026-05-18T02:00:00.000Z"),
    });

    expect(result.recommendations).toHaveLength(1);
    const fresh = result.recommendations[0]!;
    expect(fresh.recommendationId).not.toBe(accepted.recommendationId);
    expect(fresh.status).toBe("open");
    expect(fresh.supersedes).toEqual([accepted.recommendationId]);
    expect(fresh.evidenceRefs.map((ref) => ref.id)).toEqual([
      "task:wi-2:t-2:missing-evidence",
    ]);
    expect(result.supersededIds).toEqual([accepted.recommendationId]);
  });

  it("skips emit when the existing recommendation is already superseded", () => {
    const first = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const supersededRecord = {
      ...first.recommendations[0]!,
      status: "superseded" as const,
      updatedAt: "2026-05-18T01:05:00.000Z",
    };
    const result = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-2:t-2:missing-evidence" })]),
      existing: [supersededRecord],
      now: () => new Date("2026-05-18T02:00:00.000Z"),
    });

    expect(result.recommendations).toEqual([]);
    expect(result.supersededIds).toEqual([]);
  });

  it("resolves target.path via resolveTargetPath when provided", () => {
    const result = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
      resolveTargetPath: ({ template }) =>
        template.targetKind === "prompt_template"
          ? "/tmp/issuepilot/workflow.md"
          : undefined,
    });

    expect(result.recommendations[0]?.target.path).toBe(
      "/tmp/issuepilot/workflow.md",
    );
  });
});
