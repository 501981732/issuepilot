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

function makePlanner(over?: Partial<WorkItemPlanner>): WorkItemPlanner {
  return {
    draft: over?.draft ??
      (async ({ workItemId }) => ({
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
        } as TaskPlan,
      })),
  };
}

describe("createWorkItemService", () => {
  it("planFromIssue creates a WorkItem + draft TaskPlan and returns them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const events: string[] = [];
    const ticked: string[] = [];

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async (wi) => {
        ticked.push(wi.workItemId);
      },
      reconcileWorkItem: async () => {},
      emit: (e) => events.push(e.type),
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const result = await svc.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.workItem.workItemId).toBe("wi_test");
    expect(result.workItem.status).toBe("planning");
    expect(result.plan.tasks).toHaveLength(2);
    expect(events).toContain("work_item_created");
  });

  it("planFromIssue returns planner_failed when planner draft fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner({
        draft: async () => ({
          ok: false as const,
          code: "planner_parse_failed",
          message: "bad json",
        }),
      }),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const result = await svc.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("planner_failed");
    }
  });

  it("acceptPlan flips plan to accepted, work item to ready, and triggers tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    let ticks = 0;

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {
        ticks += 1;
      },
      reconcileWorkItem: async () => {},
      emit: () => {},
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

    expect(accepted.plan.status).toBe("accepted");
    expect(accepted.workItem.status).toBe("ready");
    expect(ticks).toBe(1);
  });

  it("acceptPlan applies edits to TaskNode fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const accepted = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [{ taskId: "t1", field: "title", after: "Renamed" }],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });
    if ("error" in accepted) throw new Error(accepted.error.message);

    const t1 = accepted.plan.tasks.find((t: TaskNode) => t.taskId === "t1");
    expect(t1?.title).toBe("Renamed");
    expect(accepted.plan.operatorEdits).toHaveLength(1);
  });

  it("detail returns plan + tasks + run links + report when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const detail = await svc.detail(planned.workItem.workItemId);
    expect(detail).toBeDefined();
    expect(detail?.plan.current.tasks).toHaveLength(2);
    expect(detail?.runLinks).toEqual([]);
    expect(detail?.report).toBeUndefined();
  });

  it("skipTask flips a task to skipped and emits task_run_skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const events: string[] = [];

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: (e) => events.push(e.type),
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

    const result = await svc.skipTask(
      planned.workItem.workItemId,
      "t1",
      "alice",
    );
    expect(result).toEqual({ ok: true });
    const detail = await svc.detail(planned.workItem.workItemId);
    expect(detail?.plan.current.tasks.find((t: TaskNode) => t.taskId === "t1")?.status).toBe(
      "skipped",
    );
    expect(events).toContain("task_run_skipped");
  });

  it("regeneratePlan calls planFromIssue with regenerate=true and bumps version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    let plannerCalls = 0;

    const svc = createWorkItemService({
      store,
      planner: {
        draft: async ({ workItemId }) => {
          plannerCalls += 1;
          return {
            ok: true as const,
            plan: {
              planId: `tp_${plannerCalls}`,
              workItemId: workItemId ?? "",
              version: 1,
              status: "draft" as const,
              tasks: [
                {
                  taskId: `t${plannerCalls}_1`,
                  title: "T1",
                  goal: "g",
                  scope: "s",
                  dependsOn: [],
                  suggestedValidation: [],
                  status: "planned" as const,
                  runIds: [],
                  riskLevel: "low" as const,
                },
                {
                  taskId: `t${plannerCalls}_2`,
                  title: "T2",
                  goal: "g",
                  scope: "s",
                  dependsOn: [],
                  suggestedValidation: [],
                  status: "planned" as const,
                  runIds: [],
                  riskLevel: "low" as const,
                },
              ],
              dependencies: [],
              operatorEdits: [],
            },
          };
        },
      },
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const first = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in first) throw new Error(first.error.message);
    expect(first.plan.version).toBe(1);

    const second = await svc.regeneratePlan(first.workItem.workItemId, "bob");
    if ("error" in second) throw new Error(second.error.message);
    expect(second.plan.version).toBe(2);
    expect(plannerCalls).toBe(2);
  });
});
