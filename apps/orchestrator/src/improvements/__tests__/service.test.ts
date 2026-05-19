import type {
  ImprovementRecommendation,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import type { ImprovementStore } from "../store.js";
import { createImprovementService } from "../service.js";

function memoryStore(): ImprovementStore {
  const records = new Map<string, ImprovementRecommendation>();
  return {
    async save(recommendation) {
      records.set(recommendation.recommendationId, recommendation);
    },
    async get(id) {
      return records.get(id);
    },
    async list(filters) {
      return [...records.values()]
        .filter((r) => {
          if (filters?.status && r.status !== filters.status) return false;
          return true;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

const quality: QualitySummaryResponse = {
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
      count: 1,
      rate: 100,
      drilldownCount: 1,
    },
  ],
  drilldown: [
    {
      itemId: "task:wi:t:missing-evidence",
      patternIds: ["missing-evidence"],
      reason: "missing evidence",
      projectId: "proj-a",
      workflow: "default",
      taskType: "frontend",
      updatedAt: "2026-05-18T00:00:00.000Z",
      target: { kind: "evidence", href: "/work-items/wi?view=evidence" },
    },
  ],
  dimensions: [],
  diagnostics: { invalidReportCount: 0 },
};

describe("createImprovementService", () => {
  it("generates and persists recommendations", async () => {
    const service = createImprovementService({
      store: memoryStore(),
      buildQualitySummary: async () => quality,
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });

    const result = await service.generate({});
    expect(result.generated).toBe(1);
    await expect(service.list({})).resolves.toHaveLength(1);
  });

  it("records accept/reject/defer action history without patch preview side effects", async () => {
    const service = createImprovementService({
      store: memoryStore(),
      buildQualitySummary: async () => quality,
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const [recommendation] = (await service.generate({})).recommendations;

    const accepted = await service.accept(recommendation!.recommendationId, {
      operator: "alice",
      note: "valid",
    });
    if ("error" in accepted) {
      throw new Error(`unexpected error: ${accepted.error.message}`);
    }
    expect(accepted.recommendation.status).toBe("accepted");
    expect(accepted.recommendation.patchPreview.status).toBe("not_generated");
    expect(accepted.recommendation.actionHistory.at(-1)).toMatchObject({
      action: "accepted",
      actor: "operator",
      note: "valid",
    });
  });

  it("supersedes accepted recommendations on re-generate without clobbering the audit trail", async () => {
    const store = memoryStore();
    let nowValue = new Date("2026-05-18T01:00:00.000Z");
    const service = createImprovementService({
      store,
      buildQualitySummary: async () => quality,
      now: () => nowValue,
    });

    const initial = await service.generate({});
    const original = initial.recommendations[0]!;
    const acceptResult = await service.accept(original.recommendationId, {
      operator: "alice",
    });
    if ("error" in acceptResult) {
      throw new Error(acceptResult.error.message);
    }
    expect(acceptResult.recommendation.status).toBe("accepted");

    nowValue = new Date("2026-05-19T02:00:00.000Z");
    const second = await service.generate({});

    expect(second.generated).toBe(1);
    expect(second.skipped).toBe(1);
    const successor = second.recommendations[0]!;
    expect(successor.recommendationId).not.toBe(original.recommendationId);
    expect(successor.status).toBe("open");
    expect(successor.supersedes).toEqual([original.recommendationId]);

    const previous = await store.get(original.recommendationId);
    expect(previous?.status).toBe("superseded");
    expect(previous?.actionHistory.map((entry) => entry.action)).toContain(
      "accepted",
    );
    expect(previous?.actionHistory.at(-1)?.action).toBe("superseded");
  });
});
