import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TaskPlan, WorkItem } from "@issuepilot/shared-contracts";

import type { WorkItemPlanner } from "../planner.js";
import { createWorkItemService } from "../service.js";
import { createWorkItemStore } from "../store.js";

const issue = {
  iid: 42,
  title: "Big",
  description: "Goal: ship X.",
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
  tick?: (wi: WorkItem) => Promise<void>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wi-unskip-"));
  const store = createWorkItemStore({ rootDir: dir });
  const svc = createWorkItemService({
    store,
    planner: defaultPlanner(),
    fetchIssue: async () => issue,
    tick: opts.tick ?? (async () => {}),
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
  // Skip t1 to exercise unskip.
  await svc.skipTask(accepted.workItem.workItemId, "t1", "alice");
  return { svc, store, workItem: accepted.workItem };
}

describe("WorkItemService.unskipTask", () => {
  it("transitions skipped task back to ready and ticks orchestration", async () => {
    const ticked: string[] = [];
    const { svc, workItem } = await setup({
      tick: async (wi) => {
        ticked.push(wi.workItemId);
      },
    });
    const result = await svc.unskipTask({
      workItemId: workItem.workItemId,
      taskId: "t1",
      operator: "alice",
    });
    expect(result).toEqual({ ok: true });
    const detail = await svc.detail(workItem.workItemId);
    const t1 = detail?.plan.current.tasks.find((t) => t.taskId === "t1");
    expect(t1?.status).toBe("ready");
    expect(ticked).toContain(workItem.workItemId);
  });

  it("emits task_unskipped with operator metadata", async () => {
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const { svc, workItem } = await setup({
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
    });
    await svc.unskipTask({
      workItemId: workItem.workItemId,
      taskId: "t1",
      operator: "alice",
    });
    const evt = events.find((e) => e.type === "task_unskipped");
    expect(evt?.detail).toMatchObject({
      workItemId: workItem.workItemId,
      taskId: "t1",
      operator: "alice",
    });
  });

  it("rejects unskip on a task that is not skipped", async () => {
    const { svc, workItem } = await setup();
    const result = await svc.unskipTask({
      workItemId: workItem.workItemId,
      taskId: "t2",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("invalid_status");
  });

  it("returns not_found when task does not exist", async () => {
    const { svc, workItem } = await setup();
    const result = await svc.unskipTask({
      workItemId: workItem.workItemId,
      taskId: "missing",
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("not_found");
  });

  it("clears statusReason left behind by the prior skip", async () => {
    const { svc, workItem } = await setup();
    await svc.unskipTask({
      workItemId: workItem.workItemId,
      taskId: "t1",
      operator: "alice",
    });
    const detail = await svc.detail(workItem.workItemId);
    const t1 = detail?.plan.current.tasks.find((t) => t.taskId === "t1");
    expect(t1?.statusReason).toBeUndefined();
  });
});
