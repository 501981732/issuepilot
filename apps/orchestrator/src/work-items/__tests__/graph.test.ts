import { describe, expect, it } from "vitest";

import type { TaskNode, TaskPlan } from "@issuepilot/shared-contracts";

import { computeTaskGraph } from "../graph.js";

const baseTask = (over: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode => ({
  taskId: over.taskId,
  title: over.title ?? `Task ${over.taskId}`,
  goal: over.goal ?? "g",
  scope: over.scope ?? "s",
  dependsOn: over.dependsOn ?? [],
  suggestedValidation: over.suggestedValidation ?? [],
  status: over.status ?? "planned",
  runIds: over.runIds ?? [],
  riskLevel: over.riskLevel ?? "low",
});

const planWith = (tasks: TaskNode[]): TaskPlan => ({
  planId: "tp_01",
  workItemId: "wi_01",
  version: 1,
  tasks,
  dependencies: tasks.flatMap((t) => t.dependsOn.map((from) => ({ from, to: t.taskId }))),
  operatorEdits: [],
  status: "accepted",
});

describe("computeTaskGraph", () => {
  it("layers tasks by topological depth", () => {
    const plan = planWith([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      baseTask({ taskId: "t3", dependsOn: ["t1"] }),
      baseTask({ taskId: "t4", dependsOn: ["t2", "t3"] }),
    ]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.levels).toEqual([
      ["t1"],
      ["t2", "t3"],
      ["t4"],
    ]);
  });

  it("returns edges that match plan.dependencies", () => {
    const plan = planWith([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      baseTask({ taskId: "t3", dependsOn: ["t1"] }),
    ]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { from: "t1", to: "t2" },
        { from: "t1", to: "t3" },
      ]),
    );
    expect(graph.edges).toHaveLength(2);
  });

  it("returns the longest path (by node count) as criticalPathTaskIds", () => {
    const plan = planWith([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      baseTask({ taskId: "t3", dependsOn: ["t2"] }),
      baseTask({ taskId: "t4", dependsOn: ["t1"] }),
    ]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.criticalPathTaskIds).toEqual(["t1", "t2", "t3"]);
  });

  it("returns lexicographically first path when multiple equal-length paths exist", () => {
    const plan = planWith([
      baseTask({ taskId: "tb", dependsOn: ["ta"] }),
      baseTask({ taskId: "ta" }),
      baseTask({ taskId: "tc", dependsOn: ["ta"] }),
    ]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.criticalPathTaskIds).toEqual(["ta", "tb"]);
  });

  it("handles a fully parallel plan (single level, no edges)", () => {
    const plan = planWith([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2" }),
      baseTask({ taskId: "t3" }),
    ]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.levels).toEqual([["t1", "t2", "t3"]]);
    expect(graph.edges).toEqual([]);
    expect(graph.criticalPathTaskIds).toEqual(["t1"]);
  });

  it("returns empty projections for an empty plan", () => {
    const plan = planWith([]);
    const graph = computeTaskGraph(plan, []);
    expect(graph.levels).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.criticalPathTaskIds).toEqual([]);
  });
});
