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
    const recommendations = buildImprovementRecommendations({
      summary: summary([
        item({ itemId: "task:wi-1:t-1:missing-evidence" }),
        item({ itemId: "task:wi-2:t-2:missing-evidence" }),
      ]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      problemPattern: "missing-evidence",
      target: { kind: "prompt_template" },
      confidence: "medium",
      risk: "low",
      status: "open",
    });
    expect(recommendations[0]?.evidenceRefs).toHaveLength(2);
  });

  it("dedupes against existing open recommendations and appends evidence", () => {
    const [existing] = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const recommendations = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-2:t-2:missing-evidence" })]),
      existing: [existing!],
      now: () => new Date("2026-05-18T02:00:00.000Z"),
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.recommendationId).toBe(existing?.recommendationId);
    expect(recommendations[0]?.evidenceRefs.map((ref) => ref.id)).toEqual([
      "task:wi-1:t-1:missing-evidence",
      "task:wi-2:t-2:missing-evidence",
    ]);
  });
});
