import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewReworkPlan } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { createReviewReworkPlanStore } from "../store.js";

function newPlan(
  planId: string,
  overrides: Partial<ReviewReworkPlan> = {},
): ReviewReworkPlan {
  return {
    planId,
    runId: "run-1",
    issueIid: 1,
    status: "draft",
    generatedAt: "2026-05-21T00:00:00.000Z",
    items: [],
    ...overrides,
  };
}

describe("V4.9 createReviewReworkPlanStore", () => {
  it("atomically writes a plan to <root>/review-rework-plans/<planId>.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-rework-store-"));
    const store = createReviewReworkPlanStore({ rootDir: root });
    await store.save(newPlan("plan-1"));

    const entries = readdirSync(join(root, "review-rework-plans"));
    expect(entries).toContain("plan-1.json");
    const parsed = JSON.parse(
      readFileSync(join(root, "review-rework-plans", "plan-1.json"), "utf8"),
    );
    expect(parsed.planId).toBe("plan-1");
  });

  it("redacts secret-looking content on save", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-rework-store-"));
    const store = createReviewReworkPlanStore({ rootDir: root });
    await store.save(
      newPlan("plan-2", {
        items: [
          {
            itemId: "i1",
            status: "open",
            category: "security",
            priority: "high",
            title: "leaked token",
            summary: "token=glpat-abc123def456789xxxxxxx",
            targetFiles: [],
            suggestedValidation: [],
            sourceRefs: [],
            confidence: 0.8,
          },
        ],
      }),
    );
    const text = readFileSync(
      join(root, "review-rework-plans", "plan-2.json"),
      "utf8",
    );
    expect(text).not.toContain("glpat-abc123def456789xxxxxxx");
  });

  it("get() returns cached value before reading from disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-rework-store-"));
    const store = createReviewReworkPlanStore({ rootDir: root });
    const plan = newPlan("plan-3");
    await store.save(plan);
    const fetched = await store.get("plan-3");
    expect(fetched?.planId).toBe("plan-3");
  });

  it("list() returns plans sorted by generatedAt desc", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-rework-store-"));
    const store = createReviewReworkPlanStore({ rootDir: root });
    await store.save(
      newPlan("p-old", { generatedAt: "2026-05-20T00:00:00.000Z" }),
    );
    await store.save(
      newPlan("p-new", { generatedAt: "2026-05-21T00:00:00.000Z" }),
    );
    const list = await store.list({ runId: "run-1" });
    expect(list.map((p) => p.planId)).toEqual(["p-new", "p-old"]);
  });

  it("supersede() updates both directions of the chain", async () => {
    const root = mkdtempSync(join(tmpdir(), "review-rework-store-"));
    const store = createReviewReworkPlanStore({ rootDir: root });
    await store.save(newPlan("plan-a", { status: "draft" }));
    await store.save(newPlan("plan-b", { status: "draft" }));
    await store.supersede({ oldPlanId: "plan-a", newPlanId: "plan-b" });
    const a = (await store.get("plan-a"))!;
    const b = (await store.get("plan-b"))!;
    expect(a.status).toBe("superseded");
    expect(a.supersededByPlanId).toBe("plan-b");
    expect(b.supersedesPlanId).toBe("plan-a");
  });
});
