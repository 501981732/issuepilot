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
    draft: async ({ workItemId, replanScope }) => {
      if (replanScope) {
        return {
          ok: true as const,
          plan: {
            planId: "tp_draft_replan",
            workItemId: workItemId ?? "",
            version: 1,
            status: "draft" as const,
            tasks: [
              {
                taskId: replanScope.taskId,
                title: `Replanned ${replanScope.taskId}`,
                goal: "Re-do task",
                scope: `src/${replanScope.taskId}.ts`,
                dependsOn: [],
                suggestedValidation: ["pnpm test"],
                status: "planned" as const,
                runIds: [],
                riskLevel: "low" as const,
              },
            ],
            dependencies: [],
            operatorEdits: [],
          } satisfies TaskPlan,
        };
      }
      return {
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
      };
    },
  };
}

async function setupReadyForReplan(opts: {
  planner?: WorkItemPlanner;
  emit?: (e: { type: string; detail: Record<string, unknown> }) => void;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wi-replan-"));
  const store = createWorkItemStore({ rootDir: dir });
  const svc = createWorkItemService({
    store,
    planner: opts.planner ?? defaultPlanner(),
    fetchIssue: async () => issue,
    tick: async () => {},
    reconcileWorkItem: async () => {},
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
  // Simulate that t1 has completed run history so we can verify inheritance.
  const planAfterAccept = accepted.plan;
  const t1WithRun: TaskNode = {
    ...planAfterAccept.tasks[0]!,
    status: "completed",
    runIds: ["run_a"],
  };
  const t2WithRun: TaskNode = {
    ...planAfterAccept.tasks[1]!,
    status: "completed",
    runIds: ["run_b"],
  };
  await store.saveTaskPlan({
    ...planAfterAccept,
    tasks: [t1WithRun, t2WithRun],
  });
  return { svc, store, workItem: accepted.workItem, plan: planAfterAccept };
}

describe("WorkItemService.replanTask", () => {
  it("creates a new TaskPlan version 2 with replanOf and inherited statuses", async () => {
    const { svc, workItem } = await setupReadyForReplan();
    const result = await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.plan.version).toBe(2);
    expect(result.plan.status).toBe("draft");
    expect(result.plan.replanOf).toEqual({
      planId: expect.any(String),
      taskId: "t2",
    });
    const t1 = result.plan.tasks.find((t: TaskNode) => t.taskId === "t1");
    const t2 = result.plan.tasks.find((t: TaskNode) => t.taskId === "t2");
    expect(t1?.status).toBe("completed");
    expect(t1?.runIds).toEqual(["run_a"]);
    expect(t2?.status).toBe("planned");
    expect(t2?.title).toContain("Replanned");
    // V4.2: replaced task keeps prior runIds as historical evidence.
    expect(t2?.runIds).toEqual(["run_b"]);
  });

  it("supersedes the previous accepted plan", async () => {
    const { svc, workItem } = await setupReadyForReplan();
    const previousPlanId = (await svc.detail(workItem.workItemId))?.plan.current.planId;
    const result = await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    if ("error" in result) throw new Error(result.error.message);
    const history = (await svc.detail(workItem.workItemId))?.plan.history ?? [];
    const previous = history.find((p) => p.planId === previousPlanId);
    expect(previous?.status).toBe("superseded");
  });

  it("emits task_replanned with workItemId / taskId / previousPlanId", async () => {
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const { svc, workItem } = await setupReadyForReplan({
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
    });
    await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    const replanned = events.find((e) => e.type === "task_replanned");
    expect(replanned).toBeDefined();
    expect(replanned?.detail.workItemId).toBe(workItem.workItemId);
    expect(replanned?.detail.taskId).toBe("t2");
    expect(replanned?.detail.previousPlanId).toBeTruthy();
  });

  it("returns validation_failed when planner returns multiple tasks", async () => {
    const planner: WorkItemPlanner = {
      draft: async ({ workItemId, replanScope }) => {
        if (replanScope) {
          return {
            ok: false as const,
            code: "replan_returned_multi",
            message: "planner returned 3 tasks for single-task replan",
          };
        }
        return defaultPlanner().draft({ issue, workItemId });
      },
    };
    const { svc, workItem } = await setupReadyForReplan({ planner });
    const result = await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("validation_failed");
    }
  });

  it("returns not_found when the task is missing", async () => {
    const { svc, workItem } = await setupReadyForReplan();
    const result = await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "missing-task",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("returns not_found when the work item does not exist", async () => {
    const { svc } = await setupReadyForReplan();
    const result = await svc.replanTask({
      workItemId: "wi_missing",
      taskId: "t2",
      reason: "x",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("not_found");
    }
  });

  it("records a 'replan' operatorEdit pointing at the replaced task", async () => {
    const { svc, workItem } = await setupReadyForReplan();
    const result = await svc.replanTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      reason: "Sub-task too broad",
      operator: "alice",
    });
    if ("error" in result) throw new Error(result.error.message);
    const replanEdit = result.plan.operatorEdits.find(
      (e) => e.field === "replan",
    );
    expect(replanEdit).toBeDefined();
    expect(replanEdit?.taskId).toBe("t2");
    expect(replanEdit?.by).toBe("alice");
  });

  it("requires the current plan to be accepted (rejects drafts)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-replan-"));
    const store = createWorkItemStore({ rootDir: dir });
    const svc = createWorkItemService({
      store,
      planner: defaultPlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });
    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);
    // Do NOT accept the plan; status stays draft.
    const result = await svc.replanTask({
      workItemId: planned.workItem.workItemId,
      taskId: "t2",
      reason: "x",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("invalid_status");
    }
  });
});
