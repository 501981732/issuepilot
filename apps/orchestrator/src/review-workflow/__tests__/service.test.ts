import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  IssuePilotInternalEvent,
  ReviewFeedbackSummary,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { createReviewReworkPlanStore } from "../store.js";
import { createReviewWorkflowService } from "../service.js";

function freshService() {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = {
    publish: (e: IssuePilotInternalEvent) => {
      events.push(e);
    },
  };
  const root = mkdtempSync(join(tmpdir(), "review-workflow-service-"));
  const store = createReviewReworkPlanStore({ rootDir: root });
  let counter = 0;
  const service = createReviewWorkflowService({
    store,
    eventBus,
    now: () => new Date("2026-05-21T00:00:00.000Z"),
    randomId: () => `plan-${++counter}`,
  });
  return { service, store, events };
}

const summary: ReviewFeedbackSummary = {
  mrIid: 1,
  mrUrl: "https://gitlab.example.com/p/-/merge_requests/1",
  generatedAt: "2026-05-21T00:00:00.000Z",
  cursor: "2026-05-21T00:00:00.000Z",
  comments: [
    {
      noteId: 1,
      author: "alice",
      body: "please add unit tests",
      url: "https://gitlab.example.com/p/-/merge_requests/1#note_1",
      createdAt: "2026-05-21T00:00:00.000Z",
      resolved: false,
    },
  ],
};

describe("V4.9 createReviewWorkflowService", () => {
  it("generate() persists a draft plan and emits review_rework_plan_generated", async () => {
    const { service, store, events } = freshService();
    const plan = await service.generate({
      runId: "run-1",
      issueIid: 7,
      projectId: "p1",
      summary,
      reviewerReports: [],
    });
    expect(plan.status).toBe("draft");
    expect((await store.get(plan.planId))?.status).toBe("draft");
    expect(events.map((e) => e.type)).toContain("review_rework_plan_generated");
  });

  it("accept() flips plan + items to accepted and emits the audit event", async () => {
    const { service, events } = freshService();
    const draft = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });

    const accepted = await service.acceptPlan({
      planId: draft.planId,
      operator: "alice",
      reason: "looks right",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.items.every((i) => i.status === "accepted")).toBe(true);
    expect(events.map((e) => e.type)).toContain("review_rework_plan_accepted");
  });

  it("dismiss() flips plan to dismissed with reason", async () => {
    const { service } = freshService();
    const draft = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });
    const dismissed = await service.dismissPlan({
      planId: draft.planId,
      operator: "alice",
      reason: "discussion-only",
    });
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissedReason).toBe("discussion-only");
  });

  it("regenerate() supersedes a prior accepted plan", async () => {
    const { service, store } = freshService();
    const first = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });
    await service.acceptPlan({ planId: first.planId, operator: "alice" });

    const second = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary: { ...summary, cursor: "2026-05-21T01:00:00.000Z" },
      reviewerReports: [],
    });

    const reloadedFirst = (await store.get(first.planId))!;
    const reloadedSecond = (await store.get(second.planId))!;
    expect(reloadedFirst.status).toBe("superseded");
    expect(reloadedFirst.supersededByPlanId).toBe(second.planId);
    expect(reloadedSecond.supersedesPlanId).toBe(first.planId);
  });

  it("itemAccept/Dismiss/Resolve update only the addressed item", async () => {
    const { service } = freshService();
    const draft = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });
    const targetId = draft.items[0]!.itemId;
    const accepted = await service.acceptItem({
      planId: draft.planId,
      itemId: targetId,
      operator: "alice",
    });
    expect(accepted.items.find((i) => i.itemId === targetId)?.status).toBe(
      "accepted",
    );

    const resolved = await service.resolveItem({
      planId: draft.planId,
      itemId: targetId,
      operator: "alice",
      reason: "fixed in run-2",
    });
    expect(resolved.items.find((i) => i.itemId === targetId)?.status).toBe(
      "resolved",
    );
  });

  it("getLatestAccepted() returns the most recent accepted plan", async () => {
    const { service } = freshService();
    const first = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });
    await service.acceptPlan({ planId: first.planId, operator: "alice" });

    const second = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary: { ...summary, cursor: "2026-05-21T02:00:00.000Z" },
      reviewerReports: [],
    });
    await service.acceptPlan({ planId: second.planId, operator: "alice" });

    const latest = await service.getLatestAccepted({ runId: "run-1" });
    expect(latest?.planId).toBe(second.planId);
  });

  it("splitItem replaces one item with multiple children", async () => {
    const { service } = freshService();
    const draft = await service.generate({
      runId: "run-1",
      issueIid: 7,
      summary,
      reviewerReports: [],
    });
    const targetId = draft.items[0]!.itemId;
    const split = await service.splitItem({
      planId: draft.planId,
      itemId: targetId,
      operator: "alice",
      splits: [
        {
          title: "Part A",
          summary: "first half",
          category: "test_gap",
          priority: "high",
        },
        {
          title: "Part B",
          summary: "second half",
          category: "test_gap",
          priority: "medium",
        },
      ],
    });
    expect(split.items.length).toBe(2);
    expect(split.items[0]!.title).toBe("Part A");
    expect(split.items[1]!.title).toBe("Part B");
  });
});
