import { describe, expect, it } from "vitest";

import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
} from "@issuepilot/shared-contracts";

import {
  applyTaskRunFinal,
  computeReadyTasks,
  tickWorkItem,
  type OrchestrationDeps,
} from "../orchestration.js";

const workItem: WorkItem = {
  workItemId: "wi_01",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "Big",
  },
  title: "Big",
  goal: "g",
  acceptanceCriteria: [],
  status: "ready",
  taskIds: ["t1", "t2"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

function task(over: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode {
  return {
    taskId: over.taskId,
    title: over.title ?? `Task ${over.taskId}`,
    goal: over.goal ?? "g",
    scope: over.scope ?? "s",
    dependsOn: over.dependsOn ?? [],
    suggestedValidation: over.suggestedValidation ?? [],
    status: over.status ?? "ready",
    runIds: over.runIds ?? [],
    riskLevel: over.riskLevel ?? "low",
  };
}

function plan(tasks: TaskNode[]): TaskPlan {
  return {
    planId: "tp_01",
    workItemId: workItem.workItemId,
    version: 1,
    tasks,
    dependencies: tasks.flatMap((t) =>
      t.dependsOn.map((from) => ({ from, to: t.taskId })),
    ),
    operatorEdits: [],
    status: "accepted",
    acceptedAt: "2026-05-17T00:00:00.000Z",
  };
}

function reportFixture(over: {
  runId: string;
  status: RunReportArtifact["run"]["status"];
  mrState?: "opened" | "merged" | "closed" | undefined;
  branch?: string;
  ciStatus?: RunReportArtifact["ci"];
}): RunReportArtifact {
  return {
    version: 1,
    runId: over.runId,
    issue: {
      projectId: "g/p",
      iid: 42,
      title: "T",
      url: "u",
      labels: [],
    },
    run: {
      status: over.status,
      attempt: 1,
      branch: over.branch ?? "ai/42-t",
      workspacePath: "/tmp/wt",
      startedAt: "2026-05-17T00:00:00.000Z",
      endedAt: "2026-05-17T00:01:00.000Z",
      durations: {},
    },
    ...(over.mrState
      ? {
          mergeRequest: {
            iid: 7,
            url: "https://gl/-/mr/7",
            state: over.mrState,
          },
        }
      : {}),
    handoff: {
      summary: "did stuff",
      validation: ["pnpm test"],
      risks: [],
      followUps: [],
      nextAction: "review",
    },
    diff: { summary: "diff", filesChanged: 1, notableFiles: [] },
    checks: [],
    ...(over.ciStatus ? { ci: over.ciStatus } : {}),
    mergeReadiness: {
      mode: "dry-run",
      status: "unknown",
      reasons: [],
      evaluatedAt: "2026-05-17T00:01:00.000Z",
    },
    notes: {},
  };
}

describe("computeReadyTasks", () => {
  it("returns tasks with no dependencies whose status is planned/ready/blocked_by_dependency", () => {
    const p = plan([
      task({ taskId: "t1", status: "ready" }),
      task({ taskId: "t2", status: "planned" }),
      task({ taskId: "t3", status: "completed" }),
    ]);
    const ready = computeReadyTasks(p, [], () => true);
    expect(ready.map((t) => t.taskId).sort()).toEqual(["t1", "t2"]);
  });

  it("returns blocked_by_dependency tasks once their upstream MR is merged", () => {
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({
        taskId: "t2",
        status: "blocked_by_dependency",
        dependsOn: ["t1"],
      }),
    ]);
    const merged = (id: string) => id === "t1";
    const ready = computeReadyTasks(p, [], merged);
    expect(ready.map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("keeps a downstream task blocked when upstream MR is opened (not merged)", () => {
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({
        taskId: "t2",
        status: "blocked_by_dependency",
        dependsOn: ["t1"],
      }),
    ]);
    const ready = computeReadyTasks(p, [], () => false);
    expect(ready).toEqual([]);
  });

  it("does not return a task that already has a running TaskRunLink", () => {
    const p = plan([
      task({ taskId: "t1", status: "ready" }),
      task({ taskId: "t2", status: "ready" }),
    ]);
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "r1",
        attempt: 1,
        status: "running",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
      },
    ];
    const ready = computeReadyTasks(p, links, () => true);
    expect(ready.map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("does not return a task already completed", () => {
    const p = plan([
      task({ taskId: "t1", status: "ready" }),
      task({ taskId: "t2", status: "completed" }),
    ]);
    const ready = computeReadyTasks(p, [], () => true);
    expect(ready.map((t) => t.taskId)).toEqual(["t1"]);
  });

  it("does not return a task in needs_rework even when dependencies are clear", () => {
    const p = plan([
      task({ taskId: "t1", status: "needs_rework" }),
      task({ taskId: "t2", status: "ready" }),
    ]);
    const ready = computeReadyTasks(p, [], () => true);
    expect(ready.map((t) => t.taskId)).toEqual(["t2"]);
  });

  it("does not return a task in skipped state", () => {
    const p = plan([
      task({ taskId: "t1", status: "skipped" }),
      task({ taskId: "t2", status: "ready" }),
    ]);
    const ready = computeReadyTasks(p, [], () => true);
    expect(ready.map((t) => t.taskId)).toEqual(["t2"]);
  });
});

describe("tickWorkItem", () => {
  it("dispatches all independent tasks when slots permit", async () => {
    const dispatched: string[] = [];
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 2,
      getRunReport: async () => undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: `ai/42-${t.taskId}` };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
      now: () => "2026-05-17T00:10:00.000Z",
    };

    const p = plan([
      task({ taskId: "t1", status: "ready" }),
      task({ taskId: "t2", status: "ready" }),
    ]);
    const result = await tickWorkItem(workItem, p, [], deps);
    expect(dispatched.sort()).toEqual(["t1", "t2"]);
    expect(result.dispatched.length).toBe(2);
    expect(events.filter((e) => e.type === "task_run_dispatched").length).toBe(
      2,
    );
  });

  it("respects available slots and leaves the rest for the next tick", async () => {
    const dispatched: string[] = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 1,
      getRunReport: async () => undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: "ai/42-x" };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: () => {},
    };

    const p = plan([
      task({ taskId: "t1", status: "ready" }),
      task({ taskId: "t2", status: "ready" }),
      task({ taskId: "t3", status: "ready" }),
    ]);
    const result = await tickWorkItem(workItem, p, [], deps);
    expect(dispatched.length).toBe(1);
    expect(result.blockedBySlots.length).toBe(2);
  });

  it("keeps downstream task blocked while upstream MR is not merged", async () => {
    const dispatched: string[] = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async (runId) =>
        runId === "run_t1"
          ? reportFixture({ runId, status: "completed", mrState: "opened" })
          : undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: "ai/42-x" };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: () => {},
    };
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_t1",
        attempt: 1,
        status: "completed",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
        completedAt: "2026-05-17T00:01:00.000Z",
        mergeRequest: { iid: 7, url: "https://gl/-/mr/7" },
      },
    ];
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({
        taskId: "t2",
        status: "blocked_by_dependency",
        dependsOn: ["t1"],
      }),
    ]);
    const result = await tickWorkItem(workItem, p, links, deps);
    expect(dispatched).toEqual([]);
    expect(result.blockedByDependency).toEqual(["t2"]);
  });

  it("dispatches downstream task once upstream MR is merged", async () => {
    const dispatched: string[] = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async (runId) =>
        runId === "run_t1"
          ? reportFixture({ runId, status: "completed", mrState: "merged" })
          : undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: "ai/42-x" };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: () => {},
    };
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_t1",
        attempt: 1,
        status: "completed",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
      },
    ];
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({
        taskId: "t2",
        status: "blocked_by_dependency",
        dependsOn: ["t1"],
      }),
    ]);
    await tickWorkItem(workItem, p, links, deps);
    expect(dispatched).toEqual(["t2"]);
  });

  it("does not double-dispatch a task that already has a running TaskRunLink", async () => {
    const dispatched: string[] = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async () => undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: "ai/42-x" };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: () => {},
    };
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_existing",
        attempt: 1,
        status: "running",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
      },
    ];
    const p = plan([task({ taskId: "t1", status: "ready" })]);
    await tickWorkItem(workItem, p, links, deps);
    expect(dispatched).toEqual([]);
  });

  it("dispatches a chained task with baseOverride when upstream MR is opened", async () => {
    const dispatched: Array<{ taskId: string; baseOverride?: string; chainedFrom?: string }> = [];
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async (runId) =>
        runId === "run_t1"
          ? reportFixture({
              runId,
              status: "completed",
              mrState: "opened",
              branch: "ai/42-t1",
            })
          : undefined,
      dispatchTask: async (t, opts) => {
        dispatched.push({
          taskId: t.taskId,
          ...(opts?.baseOverride !== undefined ? { baseOverride: opts.baseOverride } : {}),
          ...(opts?.chainedFrom !== undefined ? { chainedFrom: opts.chainedFrom } : {}),
        });
        return { runId: `run_${t.taskId}`, branch: `ai/42-${t.taskId}` };
      },
      decideEffectiveBase: async ({ task }) => {
        if (task.taskId === "t2") {
          return {
            kind: "chain-from-upstream",
            baseBranch: "origin/ai/42-t1",
            upstreamTaskId: "t1",
          };
        }
        return { kind: "default-base", baseBranch: "main" };
      },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
      now: () => "2026-05-17T00:10:00.000Z",
    };
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_t1",
        attempt: 1,
        status: "completed",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
        completedAt: "2026-05-17T00:00:30.000Z",
      },
    ];
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({
        taskId: "t2",
        status: "blocked_by_dependency",
        dependsOn: ["t1"],
      }),
    ]);
    await tickWorkItem(workItem, p, links, deps);
    expect(dispatched).toEqual([
      { taskId: "t2", baseOverride: "origin/ai/42-t1", chainedFrom: "t1" },
    ]);
    const dispatchedEvent = events.find((e) => e.type === "task_run_dispatched");
    expect(dispatchedEvent?.detail.chainedFrom).toBe("t1");
  });

  it("keeps a downstream task blocked when decideEffectiveBase returns blocked", async () => {
    const dispatched: string[] = [];
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async () => undefined,
      dispatchTask: async (t) => {
        dispatched.push(t.taskId);
        return { runId: `run_${t.taskId}`, branch: `ai/42-${t.taskId}` };
      },
      decideEffectiveBase: async ({ task }) =>
        task.taskId === "t3"
          ? { kind: "blocked", reason: "non-linear" }
          : { kind: "default-base", baseBranch: "main" },
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
    };
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_t1",
        attempt: 1,
        status: "completed",
        branch: "ai/42-t1",
        startedAt: "2026-05-17T00:00:00.000Z",
      },
      {
        taskId: "t2",
        runId: "run_t2",
        attempt: 1,
        status: "completed",
        branch: "ai/42-t2",
        startedAt: "2026-05-17T00:00:00.000Z",
      },
    ];
    const p = plan([
      task({ taskId: "t1", status: "completed" }),
      task({ taskId: "t2", status: "completed" }),
      task({
        taskId: "t3",
        status: "blocked_by_dependency",
        dependsOn: ["t1", "t2"],
      }),
    ]);
    const result = await tickWorkItem(workItem, p, links, deps);
    expect(dispatched).toEqual([]);
    expect(result.blockedByDependency).toContain("t3");
  });

  it("dispatches default-base task without baseOverride in detail", async () => {
    const captured: Array<{ taskId: string; baseOverride?: string; chainedFrom?: string }> = [];
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 5,
      getRunReport: async () => undefined,
      dispatchTask: async (t, opts) => {
        captured.push({
          taskId: t.taskId,
          ...(opts?.baseOverride !== undefined ? { baseOverride: opts.baseOverride } : {}),
          ...(opts?.chainedFrom !== undefined ? { chainedFrom: opts.chainedFrom } : {}),
        });
        return { runId: `run_${t.taskId}`, branch: `ai/42-${t.taskId}` };
      },
      decideEffectiveBase: async () => ({
        kind: "default-base",
        baseBranch: "main",
      }),
      saveTaskRunLink: async () => {},
      saveTaskNode: async () => {},
      emit: (e) => events.push({ type: e.type, detail: e.detail }),
    };
    const p = plan([task({ taskId: "t1", status: "ready" })]);
    await tickWorkItem(workItem, p, [], deps);
    expect(captured).toEqual([{ taskId: "t1" }]);
    const dispatchedEvent = events.find((e) => e.type === "task_run_dispatched");
    expect(dispatchedEvent?.detail.chainedFrom).toBeUndefined();
  });
});

describe("applyTaskRunFinal", () => {
  function recordingDeps() {
    const calls: Array<{ kind: string; payload: unknown }> = [];
    const deps: OrchestrationDeps = {
      availableSlots: () => 0,
      getRunReport: async () => undefined,
      dispatchTask: async () => {
        throw new Error("not used");
      },
      saveTaskRunLink: async (link) => {
        calls.push({ kind: "saveTaskRunLink", payload: link });
      },
      saveTaskNode: async (taskId, patch) => {
        calls.push({ kind: "saveTaskNode", payload: { taskId, patch } });
      },
      emit: (e) => {
        calls.push({ kind: "emit", payload: e });
      },
      now: () => "2026-05-17T00:10:00.000Z",
    };
    return { deps, calls };
  }

  it("maps run.status='completed' to TaskNode.status='completed' and persists TaskRunLink", async () => {
    const { deps, calls } = recordingDeps();
    const out = await applyTaskRunFinal(
      {
        workItemId: "wi_01",
        taskId: "t1",
        runId: "run_a",
        runReport: reportFixture({
          runId: "run_a",
          status: "completed",
          mrState: "opened",
        }),
      },
      deps,
    );
    expect(out.taskStatus).toBe("completed");
    const link = calls.find((c) => c.kind === "saveTaskRunLink")?.payload as TaskRunLink;
    expect(link.status).toBe("completed");
    expect(link.mergeRequest?.iid).toBe(7);
    const emit = calls.find((c) => c.kind === "emit")?.payload as {
      type: string;
    };
    expect(emit.type).toBe("task_run_completed");
  });

  it("maps run.status='failed' to TaskNode.status='failed' (siblings unaffected)", async () => {
    const { deps, calls } = recordingDeps();
    const out = await applyTaskRunFinal(
      {
        workItemId: "wi_01",
        taskId: "t1",
        runId: "run_a",
        runReport: {
          ...reportFixture({ runId: "run_a", status: "failed" }),
          run: {
            ...reportFixture({ runId: "run_a", status: "failed" }).run,
            lastError: { code: "boom", message: "boom!" },
          },
        },
      },
      deps,
    );
    expect(out.taskStatus).toBe("failed");
    const node = calls.find((c) => c.kind === "saveTaskNode")?.payload as {
      taskId: string;
      patch: Partial<TaskNode>;
    };
    expect(node.patch.status).toBe("failed");
    expect(node.patch.statusReason).toContain("boom");
    const emit = calls.find((c) => c.kind === "emit")?.payload as {
      type: string;
    };
    expect(emit.type).toBe("task_run_failed");
  });

  it("maps run.status='blocked' to TaskNode.status='blocked' with reason", async () => {
    const { deps, calls } = recordingDeps();
    const out = await applyTaskRunFinal(
      {
        workItemId: "wi_01",
        taskId: "t1",
        runId: "run_a",
        runReport: {
          ...reportFixture({ runId: "run_a", status: "blocked" }),
          run: {
            ...reportFixture({ runId: "run_a", status: "blocked" }).run,
            lastError: { code: "infra", message: "infra unavailable" },
          },
        },
      },
      deps,
    );
    expect(out.taskStatus).toBe("blocked");
    const node = calls.find((c) => c.kind === "saveTaskNode")?.payload as {
      taskId: string;
      patch: Partial<TaskNode>;
    };
    expect(node.patch.statusReason).toContain("infra unavailable");
  });
});
