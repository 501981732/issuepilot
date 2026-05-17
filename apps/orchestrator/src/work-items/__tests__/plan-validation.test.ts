import type { TaskNode } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { validatePlanDraft } from "../plan-validation.js";

function baseTask(over: Partial<TaskNode> = {}): TaskNode {
  return {
    taskId: "t1",
    title: "Do thing",
    goal: "Make X work",
    scope: "Touch a.ts",
    dependsOn: [],
    suggestedValidation: ["pnpm test"],
    status: "planned",
    runIds: [],
    riskLevel: "low",
    ...over,
  };
}

describe("validatePlanDraft", () => {
  it("accepts a clean two-task plan with a dependency", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts the maximum five-task plan", () => {
    const tasks = [1, 2, 3, 4, 5].map((i) => baseTask({ taskId: `t${i}` }));
    expect(validatePlanDraft(tasks).ok).toBe(true);
  });

  it("rejects fewer than 2 tasks with code=too_few_tasks", () => {
    const result = validatePlanDraft([baseTask({ taskId: "t1" })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_few_tasks");
  });

  it("rejects more than 5 tasks with code=too_many_tasks", () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      baseTask({ taskId: `t${i + 1}` }),
    );
    const result = validatePlanDraft(tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_many_tasks");
  });

  it("rejects duplicate taskId", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t1", title: "Other" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("duplicate_task_id");
  });

  it("rejects empty taskId", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "" }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_task_id");
  });

  it("rejects empty title", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", title: "   " }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_title");
  });

  it("rejects invalid riskLevel", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", riskLevel: "extreme" as unknown as "low" }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_risk_level");
  });

  it("rejects dependency referencing missing task", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t99"] }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("dependency_unknown");
  });

  it("rejects self-dependency", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t1"] }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("dependency_cycle");
  });

  it("rejects two-task cycle (t1 <-> t2)", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t2"] }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("dependency_cycle");
  });

  it("rejects three-task cycle (t1 -> t2 -> t3 -> t1)", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t3"] }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      baseTask({ taskId: "t3", dependsOn: ["t2"] }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("dependency_cycle");
  });

  it("rejects empty goal", () => {
    const result = validatePlanDraft([
      baseTask({ taskId: "t1", goal: "" }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_goal");
  });
});
