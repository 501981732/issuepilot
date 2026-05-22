import { randomUUID } from "node:crypto";

import { redact, type EventBus } from "@issuepilot/observability";
import type {
  IssuePilotInternalEvent,
  ReviewerAgentReport,
  ReviewFeedbackSummary,
  ReviewReworkItem,
  ReviewReworkPlan,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

import { buildReviewReworkPlan } from "./planner.js";
import type {
  ReviewReworkPlanFilters,
  ReviewReworkPlanStore,
} from "./store.js";

export interface ReviewWorkflowGenerateInput {
  runId: string;
  issueIid: number;
  projectId?: string;
  workItemId?: string;
  taskId?: string;
  summary?: ReviewFeedbackSummary;
  reviewerReports: ReviewerAgentReport[];
  reportArtifact?: RunReportArtifact;
}

export interface ReviewWorkflowService {
  generate(input: ReviewWorkflowGenerateInput): Promise<ReviewReworkPlan>;
  acceptPlan(input: {
    planId: string;
    operator: string;
    reason?: string;
  }): Promise<ReviewReworkPlan>;
  dismissPlan(input: {
    planId: string;
    operator: string;
    reason: string;
  }): Promise<ReviewReworkPlan>;
  acceptItem(input: {
    planId: string;
    itemId: string;
    operator: string;
    reason?: string;
  }): Promise<ReviewReworkPlan>;
  dismissItem(input: {
    planId: string;
    itemId: string;
    operator: string;
    reason: string;
  }): Promise<ReviewReworkPlan>;
  resolveItem(input: {
    planId: string;
    itemId: string;
    operator: string;
    reason?: string;
  }): Promise<ReviewReworkPlan>;
  splitItem(input: {
    planId: string;
    itemId: string;
    operator: string;
    splits: Array<
      Pick<ReviewReworkItem, "title" | "summary" | "category" | "priority">
    >;
  }): Promise<ReviewReworkPlan>;
  getLatestAccepted(
    filters: ReviewReworkPlanFilters,
  ): Promise<ReviewReworkPlan | undefined>;
  list(filters: ReviewReworkPlanFilters): Promise<ReviewReworkPlan[]>;
  get(planId: string): Promise<ReviewReworkPlan | undefined>;
}

export function createReviewWorkflowService(deps: {
  store: ReviewReworkPlanStore;
  eventBus: Pick<EventBus<IssuePilotInternalEvent>, "publish">;
  now: () => Date;
  randomId?: () => string;
}): ReviewWorkflowService {
  const now = deps.now;
  const randomId = deps.randomId ?? randomUUID;

  function publish(
    type: IssuePilotInternalEvent["type"],
    plan: ReviewReworkPlan,
    extra: Record<string, unknown> = {},
  ): void {
    const ts = now().toISOString();
    const event: IssuePilotInternalEvent = {
      id: randomUUID(),
      runId: plan.runId,
      type,
      message: `${type}:${plan.planId}`,
      createdAt: ts,
      ts,
      data: redact({
        planId: plan.planId,
        runId: plan.runId,
        issueIid: plan.issueIid,
        projectId: plan.projectId,
        workItemId: plan.workItemId,
        taskId: plan.taskId,
        itemCount: plan.items.length,
        status: plan.status,
        ...extra,
      }),
    };
    deps.eventBus.publish(event);
  }

  async function loadOrFail(planId: string): Promise<ReviewReworkPlan> {
    const plan = await deps.store.get(planId);
    if (!plan) {
      throw Object.assign(new Error(`plan ${planId} not found`), {
        code: "not_found",
      });
    }
    return plan;
  }

  return {
    async generate(input) {
      const prior = await deps.store.list({
        runId: input.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      const newest = prior.find(
        (p) => p.status === "accepted" || p.status === "draft",
      );
      const plan = buildReviewReworkPlan({
        runId: input.runId,
        issueIid: input.issueIid,
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input.workItemId !== undefined
          ? { workItemId: input.workItemId }
          : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        reviewerReports: input.reviewerReports,
        ...(input.reportArtifact !== undefined
          ? { reportArtifact: input.reportArtifact }
          : {}),
        now: deps.now,
        randomId,
      });
      await deps.store.save(plan);
      if (newest) {
        await deps.store.supersede({
          oldPlanId: newest.planId,
          newPlanId: plan.planId,
        });
      }
      publish("review_rework_plan_generated", plan, {
        sourceSummaryId: plan.sourceSummaryId,
        supersedesPlanId: newest?.planId,
      });
      return (await deps.store.get(plan.planId))!;
    },
    async acceptPlan({ planId, operator, reason }) {
      const plan = await loadOrFail(planId);
      const updated: ReviewReworkPlan = {
        ...plan,
        status: "accepted",
        acceptedAt: now().toISOString(),
        items: plan.items.map((i) => ({ ...i, status: "accepted" })),
      };
      await deps.store.save(updated);
      publish("review_rework_plan_accepted", updated, { operator, reason });
      return updated;
    },
    async dismissPlan({ planId, operator, reason }) {
      const plan = await loadOrFail(planId);
      const updated: ReviewReworkPlan = {
        ...plan,
        status: "dismissed",
        dismissedReason: reason,
      };
      await deps.store.save(updated);
      publish("review_rework_plan_dismissed", updated, { operator, reason });
      return updated;
    },
    async acceptItem({ planId, itemId, operator, reason }) {
      const plan = await loadOrFail(planId);
      const items = plan.items.map((i) =>
        i.itemId === itemId ? { ...i, status: "accepted" as const } : i,
      );
      const updated: ReviewReworkPlan = { ...plan, items };
      await deps.store.save(updated);
      publish("review_rework_item_updated", updated, {
        itemId,
        operator,
        reason,
        nextStatus: "accepted",
      });
      return updated;
    },
    async dismissItem({ planId, itemId, operator, reason }) {
      const plan = await loadOrFail(planId);
      const items = plan.items.map((i) =>
        i.itemId === itemId ? { ...i, status: "dismissed" as const } : i,
      );
      const updated: ReviewReworkPlan = { ...plan, items };
      await deps.store.save(updated);
      publish("review_rework_item_updated", updated, {
        itemId,
        operator,
        reason,
        nextStatus: "dismissed",
      });
      return updated;
    },
    async resolveItem({ planId, itemId, operator, reason }) {
      const plan = await loadOrFail(planId);
      const items = plan.items.map((i) =>
        i.itemId === itemId ? { ...i, status: "resolved" as const } : i,
      );
      const updated: ReviewReworkPlan = { ...plan, items };
      await deps.store.save(updated);
      publish("review_rework_item_updated", updated, {
        itemId,
        operator,
        reason,
        nextStatus: "resolved",
      });
      return updated;
    },
    async splitItem({ planId, itemId, operator, splits }) {
      const plan = await loadOrFail(planId);
      const idx = plan.items.findIndex((i) => i.itemId === itemId);
      if (idx < 0) {
        throw Object.assign(new Error(`item ${itemId} not found`), {
          code: "not_found",
        });
      }
      const original = plan.items[idx]!;
      const children: ReviewReworkItem[] = splits.map((s, i) => ({
        ...original,
        itemId: `${original.itemId}-split-${i + 1}`,
        title: s.title,
        summary: s.summary,
        category: s.category,
        priority: s.priority,
      }));
      const items = [
        ...plan.items.slice(0, idx),
        ...children,
        ...plan.items.slice(idx + 1),
      ];
      const updated: ReviewReworkPlan = { ...plan, items };
      await deps.store.save(updated);
      publish("review_rework_item_updated", updated, {
        itemId,
        operator,
        nextStatus: "split",
        children: children.map((c) => c.itemId),
      });
      return updated;
    },
    async getLatestAccepted(filters) {
      const list = await deps.store.list({ ...filters, status: "accepted" });
      return list[0];
    },
    async list(filters) {
      return deps.store.list(filters);
    },
    async get(planId) {
      return deps.store.get(planId);
    },
  };
}
