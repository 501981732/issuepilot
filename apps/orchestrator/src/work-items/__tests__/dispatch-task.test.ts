import { describe, expect, it } from "vitest";

import type {
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";

import type { DispatchInput } from "../../orchestrator/dispatch.js";
import { createRuntimeState } from "../../runtime/state.js";
import { runTaskOnce, type DispatchTaskWorkflow } from "../dispatch-task.js";

const workItem: WorkItem = {
  workItemId: "wi_01",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "Big issue",
  },
  title: "Big issue",
  goal: "Ship feature X",
  acceptanceCriteria: ["AC1"],
  status: "ready",
  taskIds: ["t1"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

const task: TaskNode = {
  taskId: "t1",
  title: "Add API",
  goal: "POST /x",
  scope: "src/api/x.ts",
  dependsOn: [],
  suggestedValidation: ["pnpm test"],
  status: "ready",
  runIds: [],
  riskLevel: "low",
};

const taskWithDeps: TaskNode = {
  ...task,
  taskId: "t2",
  title: "Wire UI",
  dependsOn: ["t1"],
};

const workflow: DispatchTaskWorkflow = {
  git: {
    repoUrl: "git@gl:g/p.git",
    baseBranch: "main",
    branchPrefix: "ai",
  },
  workspace: {
    root: "/tmp/wt",
    repoCacheRoot: "/tmp/cache",
  },
  tracker: {
    runningLabel: "ai-running",
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
  },
};

describe("runTaskOnce", () => {
  it("creates a synthetic RunRecord with status=claimed and workItem metadata", async () => {
    const state = createRuntimeState();
    let captured: DispatchInput | undefined;
    const result = await runTaskOnce({
      workItem,
      task,
      workflow,
      promptTemplate: "issue.title={{issue.title}} workItem.taskId={{workItem.taskId}}",
      state,
      dispatch: async (input) => {
        captured = input;
      },
      newRunId: () => "run_synthetic_1",
      now: () => "2026-05-17T00:10:00.000Z",
    });

    expect(result.runId).toBe("run_synthetic_1");
    expect(result.branch).toBe("ai/42-add-api");

    const stored = state.getRun("run_synthetic_1");
    expect(stored?.status).toBe("claimed");
    expect(stored?.attempt).toBe(1);
    expect(stored?.branch).toBe("ai/42-add-api");
    expect(stored?.["workItem"]).toEqual({
      workItemId: "wi_01",
      taskId: "t1",
    });

    expect(captured).toBeDefined();
    expect(captured?.runId).toBe("run_synthetic_1");
    expect(captured?.branch).toBe("ai/42-add-api");
    expect(captured?.baseBranch).toBe("main");
    expect(captured?.parentIssueLabelMode).toBe("suppressed");
    expect(captured?.issue.iid).toBe(42);
  });

  it("forwards workItem prompt vars (taskId, taskTitle, scope, dependencies)", async () => {
    let captured: DispatchInput | undefined;
    await runTaskOnce({
      workItem,
      task: taskWithDeps,
      workflow,
      promptTemplate: "{{ workItem.taskId }}",
      state: createRuntimeState(),
      dispatch: async (input) => {
        captured = input;
      },
      newRunId: () => "run_x",
      now: () => "2026-05-17T00:10:00.000Z",
    });

    const wi = (captured?.extraPromptVars as
      | { workItem?: Record<string, unknown> }
      | undefined)?.workItem;

    expect(wi).toMatchObject({
      workItemId: "wi_01",
      taskId: "t2",
      taskTitle: "Wire UI",
      taskGoal: "POST /x",
      taskScope: "src/api/x.ts",
      suggestedValidation: ["pnpm test"],
    });
    expect(wi?.["dependenciesSummary"]).toContain("t1");
  });

  it("invokes dispatch exactly once and returns the generated runId", async () => {
    let calls = 0;
    const result = await runTaskOnce({
      workItem,
      task,
      workflow,
      promptTemplate: "x",
      state: createRuntimeState(),
      dispatch: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(1);
    expect(result.runId).toMatch(/.+/);
  });

  it("propagates errors from the underlying dispatch call", async () => {
    await expect(
      runTaskOnce({
        workItem,
        task,
        workflow,
        promptTemplate: "x",
        state: createRuntimeState(),
        dispatch: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("uses workflow.git.baseBranch by default", async () => {
    let captured: DispatchInput | undefined;
    await runTaskOnce({
      workItem,
      task,
      workflow,
      promptTemplate: "x",
      state: createRuntimeState(),
      dispatch: async (input) => {
        captured = input;
      },
    });
    expect(captured?.baseBranch).toBe("main");
    const wi = (captured?.extraPromptVars as
      | { workItem?: Record<string, unknown> }
      | undefined)?.workItem;
    expect(wi?.["chainedFrom"]).toBeUndefined();
  });

  it("uses baseOverride and propagates chainedFrom to extraPromptVars when provided", async () => {
    let captured: DispatchInput | undefined;
    await runTaskOnce({
      workItem,
      task: taskWithDeps,
      workflow,
      promptTemplate: "{{ workItem.chainedFrom }}",
      state: createRuntimeState(),
      dispatch: async (input) => {
        captured = input;
      },
      baseOverride: "origin/ai/42-up",
      chainedFrom: "t1",
    });
    expect(captured?.baseBranch).toBe("origin/ai/42-up");
    const wi = (captured?.extraPromptVars as
      | { workItem?: Record<string, unknown> }
      | undefined)?.workItem;
    expect(wi).toMatchObject({ chainedFrom: "t1" });
  });
});
