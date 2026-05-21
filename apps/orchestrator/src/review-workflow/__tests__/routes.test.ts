import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { registerReviewWorkflowRoutes } from "../routes.js";
import type { ReviewWorkflowService } from "../service.js";

function appWith(service: ReviewWorkflowService) {
  const app = Fastify();
  registerReviewWorkflowRoutes(app, () => ({ ok: true, service }));
  return app;
}

describe("V4.9 review workflow routes", () => {
  it("GET /api/review-workflow/plans lists plans", async () => {
    const service = {
      list: vi.fn().mockResolvedValue([
        {
          planId: "p1",
          runId: "r1",
          issueIid: 1,
          status: "draft",
          generatedAt: "2026-05-21T00:00:00.000Z",
          items: [],
        },
      ]),
    } as unknown as ReviewWorkflowService;
    const app = appWith(service);
    const res = await app.inject({
      method: "GET",
      url: "/api/review-workflow/plans?runId=r1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ plans: [{ planId: "p1" }] });
  });

  it("POST /api/review-workflow/plans/generate calls service.generate", async () => {
    const generate = vi.fn().mockResolvedValue({
      planId: "p2",
      runId: "r1",
      issueIid: 1,
      status: "draft",
      generatedAt: "2026-05-21T00:00:00.000Z",
      items: [],
    });
    const service = { generate } as unknown as ReviewWorkflowService;
    const app = appWith(service);
    const res = await app.inject({
      method: "POST",
      url: "/api/review-workflow/plans/generate",
      payload: { runId: "r1", issueIid: 1, reviewerReports: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
  });

  it("POST /api/review-workflow/plans/:id/accept records operator from header", async () => {
    const acceptPlan = vi.fn().mockResolvedValue({
      planId: "p3",
      runId: "r1",
      issueIid: 1,
      status: "accepted",
      generatedAt: "2026-05-21T00:00:00.000Z",
      items: [],
    });
    const service = { acceptPlan } as unknown as ReviewWorkflowService;
    const app = appWith(service);
    const res = await app.inject({
      method: "POST",
      url: "/api/review-workflow/plans/p3/accept",
      headers: { "x-issuepilot-operator": "alice" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(acceptPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: "p3", operator: "alice" }),
    );
  });

  it("returns 503 when service unavailable for project", async () => {
    const app = Fastify();
    registerReviewWorkflowRoutes(app, () => ({
      ok: false,
      statusCode: 503,
      body: { ok: false, code: "review_workflow_unavailable" },
    }));
    const res = await app.inject({
      method: "GET",
      url: "/api/review-workflow/plans",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "review_workflow_unavailable" });
  });

  it("GET /api/review-workflow/plans/:id returns 404 for missing plan", async () => {
    const service = {
      get: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReviewWorkflowService;
    const app = appWith(service);
    const res = await app.inject({
      method: "GET",
      url: "/api/review-workflow/plans/missing",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST split rejects invalid category/priority", async () => {
    const service = {
      splitItem: vi.fn(),
    } as unknown as ReviewWorkflowService;
    const app = appWith(service);
    const res = await app.inject({
      method: "POST",
      url: "/api/review-workflow/plans/p1/items/i1/split",
      payload: {
        splits: [
          {
            title: "x",
            summary: "y",
            category: "INVALID",
            priority: "INVALID",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
