import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { createImprovementStore } from "../store.js";

function rec(
  over: Partial<ImprovementRecommendation> = {},
): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: {
      kind: "prompt_template",
      path: "/repo/WORKFLOW.md",
      description: "Prompt template",
    },
    evidenceRefs: [
      {
        kind: "quality-drilldown",
        id: "task:wi:t:missing-evidence",
        reason: "missing evidence",
      },
    ],
    suggestedChange: "Ask for command output evidence.",
    patchPreview: {
      status: "not_generated",
      targetDescription: "Prompt template",
    },
    confidence: "high",
    risk: "low",
    status: "open",
    actionHistory: [
      {
        action: "generated",
        actor: "system",
        at: "2026-05-18T00:00:00.000Z",
      },
    ],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

describe("createImprovementStore", () => {
  it("saves, loads, and lists recommendations from disk", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    await store.save(rec());

    const reloaded = createImprovementStore({ rootDir });
    await expect(reloaded.get("rec_1")).resolves.toMatchObject({
      recommendationId: "rec_1",
      problemPattern: "missing-evidence",
    });
    await expect(reloaded.list()).resolves.toHaveLength(1);
  });

  it("redacts secret-looking values before writing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    const tokenLiteral = `glpat-${"A".repeat(24)}`;
    await store.save(
      rec({
        recommendationId: "rec_secret",
        suggestedChange: `Set token to ${tokenLiteral}`,
      }),
    );

    const body = await readFile(
      join(rootDir, "recommendations", "rec_secret.json"),
      "utf8",
    );
    expect(body).not.toContain(tokenLiteral);
  });

  it("sorts newest recommendations first", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    await store.save(
      rec({ recommendationId: "old", updatedAt: "2026-05-17T00:00:00.000Z" }),
    );
    await store.save(
      rec({ recommendationId: "new", updatedAt: "2026-05-18T00:00:00.000Z" }),
    );

    await expect(store.list()).resolves.toMatchObject([
      { recommendationId: "new" },
      { recommendationId: "old" },
    ]);
  });
});
