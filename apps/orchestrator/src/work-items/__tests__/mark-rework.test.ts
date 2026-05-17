import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TaskNode, TaskPlan } from "@issuepilot/shared-contracts";

import type { WorkItemPlanner } from "../planner.js";
import { createWorkItemService } from "../service.js";
import { createWorkItemStore } from "../store.js";

const issue = {
  iid: 42,
  title: "Big",
  description: "Goal: ship X.\n- AC1\n- AC2",
  url: "https://gl/-/issues/42",
  projectId: "g/p",
  labels: ["ai-ready"],
};

function defaultPlanner(): WorkItemPlanner {
  return {
    draft: async ({ workItemId }) => ({
      ok: true as const,
      plan: {
        planId: "tp_01",
        workItemId: workItemId ?? "",
        version: 1,
        status: "draft" as const,
        tasks: [
          {
            taskId: "t1",
            title: "Add API",
            goal: "POST /x",
            scope: "src/api/x.ts",
            dependsOn: [],
            suggestedValidation: ["pnpm test"],
            status: "planned" as const,
            runIds: [],
            riskLevel: "low" as const,
          },
          {
            taskId: "t2",
            title: "Add UI",
            goal: "Render result",
            scope: "src/ui/x.tsx",
            dependsOn: ["t1"],
            suggestedValidation: ["pnpm test"],
            status: "planned" as const,
            runIds: [],
            riskLevel: "low" as const,
          },
        ],
        dependencies: [{ from: "t1", to: "t2" }],
        operatorEdits: [],
      } satisfies TaskPlan,
    }),
  };
}

async function setup(opts: {
  emit?: (e: { type: string; detail: Record<string, unknown> }) => void;
  reconcileWorkItem?: (id: string) => Promise<void>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wi-rework-"));
  const store = createWorkItemStore({ rootDir: dir });
  const svc = createWorkItemService({
    store,
    planner: defaultPlanner(),
    fetchIssue: async () => issue,
    tick: async () => {},
    reconcileWorkItem: opts.reconcileWorkItem ?? (async () => {}),
    emit: opts.emit ?? (() => {}),
    newId: () => "wi_test",
    now: () => "2026-05-17T00:00:00.000Z",
  });
  const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
  if ("error" in planned) throw new Error(planned.error.message);
  const accepted = await svc.acceptPlan({
    planId: planned.plan.planId,
    edits: [],
    operator: "alice",
    workItemId: planned.workItem.workItemId,
  });
  if ("error" in accepted) throw new Error(accepted.error.message);
  return { svc, store, workItem: accepted.workItem };
}

async function setTaskStatus(
  store: ReturnType<typeof createWorkItemStore>,
  workItemId: string,
  taskId: string,
  status: TaskNode["status"],
): Promise<void> {
  const plan = await store.getCurrentPlan(workItemId);
  if (!plan) throw new Error("no plan");
  await store.saveTaskPlan({
    ...plan,
    tasks: plan.tasks.map((t) => (t.taskId === taskId ? { ...t, status } : t)),
  });
}

describe("WorkItemService.markNeedsRework", () => {
  it("sets needsReworkReason and status=needs_rework on a completed task", async () => {
    const { svc, store, workItem } = await setup();
    await setTaskStatus(store, workItem.workItemId, "t1", "completed");
    const result = await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "Reviewer asked for tests",
      operator: "alice",
    });
    expect(result).toEqual({ ok: true });
    const detail = await svc.detail(workItem.workItemId);
    const t1 = detail?.plan.current.tasks.find((t) => t.taskId === "t1");
    expect(t1?.status).toBe("needs_rework");
    expect(t1?.needsReworkReason).toBe("Reviewer asked for tests");
  });

  it("emits task_marked_needs_rework with reason + operator", async () => {
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const { svc, store, workItem } = await setup({
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
    });
    await setTaskStatus(store, workItem.workItemId, "t1", "completed");
    await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "Reviewer asked for tests",
      operator: "alice",
    });
    const evt = events.find((e) => e.type === "task_marked_needs_rework");
    expect(evt?.detail).toMatchObject({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "Reviewer asked for tests",
      operator: "alice",
    });
  });

  it("calls reconcileWorkItem so WorkItem.status leaves 'completed'", async () => {
    const reconciled: string[] = [];
    const { svc, store, workItem } = await setup({
      reconcileWorkItem: async (id) => {
        reconciled.push(id);
      },
    });
    await setTaskStatus(store, workItem.workItemId, "t1", "completed");
    await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "x",
      operator: "alice",
    });
    expect(reconciled).toEqual([workItem.workItemId]);
  });

  it("rejects mark-rework on tasks that are not completed/failed/blocked", async () => {
    const { svc, store, workItem } = await setup();
    await setTaskStatus(store, workItem.workItemId, "t1", "running");
    const result = await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "x",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("invalid_status");
  });

  it("accepts mark-rework on failed status", async () => {
    const { svc, store, workItem } = await setup();
    await setTaskStatus(store, workItem.workItemId, "t1", "failed");
    const result = await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "t1",
      reason: "x",
      operator: "alice",
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns not_found when task does not exist", async () => {
    const { svc, workItem } = await setup();
    const result = await svc.markNeedsRework({
      workItemId: workItem.workItemId,
      taskId: "missing",
      reason: "x",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("not_found");
  });
});
