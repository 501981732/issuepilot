import { describe, expect, it } from "vitest";

import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
} from "@issuepilot/shared-contracts";

import { decideEffectiveBase } from "../branch-chain.js";

const baseTask = (over: Partial<TaskNode> = {}): TaskNode => ({
  taskId: "t",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "planned",
  runIds: [],
  riskLevel: "low",
  ...over,
});

const completedLink = (over: Partial<TaskRunLink> = {}): TaskRunLink => ({
  taskId: "t1",
  runId: "run_a",
  attempt: 1,
  status: "completed",
  reportId: "run_a",
  branch: "ai/42-add-api",
  startedAt: "2026-05-17T00:00:00.000Z",
  completedAt: "2026-05-17T00:00:05.000Z",
  ...over,
});

const reportFor = (
  runId: string,
  mrState: "opened" | "merged" | "closed" | undefined,
  branch = "ai/42-add-api",
): RunReportArtifact =>
  ({
    workItemId: "wi_01",
    run: {
      runId,
      attempt: 1,
      status: "completed",
      branch,
      startedAt: "2026-05-17T00:00:00.000Z",
      endedAt: "2026-05-17T00:00:05.000Z",
    },
    ...(mrState
      ? {
          mergeRequest: {
            iid: 1,
            url: `https://gl/mr/${runId}`,
            state: mrState,
            branch,
            baseBranch: "main",
          },
        }
      : {}),
  }) as unknown as RunReportArtifact;

const planWith = (tasks: TaskNode[]): TaskPlan => ({
  planId: "tp_01",
  workItemId: "wi_01",
  version: 1,
  tasks,
  dependencies: tasks.flatMap((t) => t.dependsOn.map((from) => ({ from, to: t.taskId }))),
  operatorEdits: [],
  status: "accepted",
});

describe("decideEffectiveBase", () => {
  it("returns default base for tasks with no dependencies", async () => {
    const t = baseTask({ taskId: "t1" });
    const r = await decideEffectiveBase({
      task: t,
      plan: planWith([t]),
      links: [],
      getRunReport: async () => undefined,
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });

  it("uses default base when single upstream is completed AND merged", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed", runIds: ["run_a"] });
    const t2 = baseTask({ taskId: "t2", dependsOn: ["t1"] });
    const r = await decideEffectiveBase({
      task: t2,
      plan: planWith([t1, t2]),
      links: [completedLink({ taskId: "t1", branch: "ai/42-up" })],
      getRunReport: async () => reportFor("run_a", "merged", "ai/42-up"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });

  it("chains from upstream branch when single upstream is completed but MR is opened", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed", runIds: ["run_a"] });
    const t2 = baseTask({ taskId: "t2", dependsOn: ["t1"] });
    const r = await decideEffectiveBase({
      task: t2,
      plan: planWith([t1, t2]),
      links: [completedLink({ taskId: "t1", branch: "ai/42-up" })],
      getRunReport: async () => reportFor("run_a", "opened", "ai/42-up"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({
      kind: "chain-from-upstream",
      baseBranch: "origin/ai/42-up",
      upstreamTaskId: "t1",
    });
  });

  it("chains from upstream when single upstream is completed but MR record is missing", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed", runIds: ["run_a"] });
    const t2 = baseTask({ taskId: "t2", dependsOn: ["t1"] });
    const r = await decideEffectiveBase({
      task: t2,
      plan: planWith([t1, t2]),
      links: [completedLink({ taskId: "t1", branch: "ai/42-up" })],
      getRunReport: async () => reportFor("run_a", undefined, "ai/42-up"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({
      kind: "chain-from-upstream",
      baseBranch: "origin/ai/42-up",
      upstreamTaskId: "t1",
    });
  });

  it("returns blocked when single upstream is not completed", async () => {
    const t1 = baseTask({ taskId: "t1", status: "running" });
    const t2 = baseTask({ taskId: "t2", dependsOn: ["t1"] });
    const r = await decideEffectiveBase({
      task: t2,
      plan: planWith([t1, t2]),
      links: [],
      getRunReport: async () => undefined,
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "blocked", reason: "upstream-not-completed" });
  });

  it("returns non-linear blocked when >= 2 upstreams and at least one is not merged", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed", runIds: ["run_a"] });
    const t2 = baseTask({ taskId: "t2", status: "completed", runIds: ["run_b"] });
    const t3 = baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] });
    const r = await decideEffectiveBase({
      task: t3,
      plan: planWith([t1, t2, t3]),
      links: [
        completedLink({ taskId: "t1", branch: "ai/42-up1", runId: "run_a" }),
        completedLink({ taskId: "t2", branch: "ai/42-up2", runId: "run_b" }),
      ],
      getRunReport: async (id) =>
        id === "run_a"
          ? reportFor("run_a", "merged", "ai/42-up1")
          : reportFor("run_b", "opened", "ai/42-up2"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "blocked", reason: "non-linear" });
  });

  it("returns default base when >= 2 upstreams are all completed + merged", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed", runIds: ["run_a"] });
    const t2 = baseTask({ taskId: "t2", status: "completed", runIds: ["run_b"] });
    const t3 = baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] });
    const r = await decideEffectiveBase({
      task: t3,
      plan: planWith([t1, t2, t3]),
      links: [
        completedLink({ taskId: "t1", branch: "ai/42-a", runId: "run_a" }),
        completedLink({ taskId: "t2", branch: "ai/42-b", runId: "run_b" }),
      ],
      getRunReport: async (id) =>
        id === "run_a"
          ? reportFor("run_a", "merged", "ai/42-a")
          : reportFor("run_b", "merged", "ai/42-b"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });

  it("returns blocked when single upstream is completed but has no completed TaskRunLink", async () => {
    const t1 = baseTask({ taskId: "t1", status: "completed" });
    const t2 = baseTask({ taskId: "t2", dependsOn: ["t1"] });
    const r = await decideEffectiveBase({
      task: t2,
      plan: planWith([t1, t2]),
      links: [],
      getRunReport: async () => undefined,
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "blocked", reason: "upstream-not-completed" });
  });
});
