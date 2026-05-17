import { describe, expect, it } from "vitest";

import { createWorkItemPlanner, type RawPlanResponse } from "../planner.js";

const baseIssue = {
  iid: 42,
  title: "Big",
  description: "Goal: ship feature X. Acceptance: AC1, AC2.",
  url: "https://gl/-/issues/42",
  projectId: "g/p",
  labels: ["ai-ready"],
};

describe("createWorkItemPlanner", () => {
  it("parses LLM JSON into a valid plan draft and inflates defaults", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () =>
        ({
          tasks: [
            {
              taskId: "t1",
              title: "Add API",
              goal: "POST /x",
              scope: "src/api/x.ts",
              dependsOn: [],
              suggestedValidation: ["pnpm test"],
              riskLevel: "low",
            },
            {
              taskId: "t2",
              title: "Add UI",
              goal: "Render result",
              scope: "src/ui/x.tsx",
              dependsOn: ["t1"],
              suggestedValidation: ["pnpm test"],
              riskLevel: "medium",
            },
          ],
        }) satisfies RawPlanResponse,
    });
    const result = await planner.draft({
      issue: baseIssue,
      workItemId: "wi_01",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.tasks.length).toBe(2);
      expect(result.plan.workItemId).toBe("wi_01");
      expect(result.plan.version).toBe(1);
      expect(result.plan.status).toBe("draft");
      expect(result.plan.dependencies).toEqual([{ from: "t1", to: "t2" }]);
      expect(result.plan.tasks[0]?.status).toBe("planned");
      expect(result.plan.tasks[0]?.runIds).toEqual([]);
    }
  });

  it("accepts a JSON string response and parses it", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () =>
        JSON.stringify({
          tasks: [
            {
              taskId: "t1",
              title: "Task 1",
              goal: "g",
              scope: "s",
              dependsOn: [],
              suggestedValidation: [],
              riskLevel: "low",
            },
            {
              taskId: "t2",
              title: "Task 2",
              goal: "g",
              scope: "s",
              dependsOn: [],
              suggestedValidation: [],
              riskLevel: "low",
            },
          ],
        }),
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(true);
  });

  it("emits planner_parse_failed when LLM returns non-JSON", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => "this is not json",
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("planner_parse_failed");
  });

  it("emits planner_parse_failed when LLM returns a JSON without tasks[]", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => ({}) as unknown as RawPlanResponse,
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("planner_parse_failed");
  });

  // Regression guard: LLM output is untrusted. A `tasks` array whose
  // entries are `null` (a frequent malformation right after a re-prompt)
  // used to crash with an uncaught TypeError in `tasks.map`, escaping the
  // documented stable-error-code contract (see planner.ts header). Both
  // null entries and primitive entries must surface as `planner_parse_failed`.
  it("emits planner_parse_failed when tasks contains a null entry", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () =>
        ({ tasks: [null] }) as unknown as RawPlanResponse,
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("planner_parse_failed");
  });

  it("emits planner_parse_failed when tasks contains a primitive entry", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () =>
        ({ tasks: ["t1" as unknown] }) as unknown as RawPlanResponse,
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("planner_parse_failed");
  });

  it("forwards the validator error code (too_few_tasks)", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => ({ tasks: [] }),
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_few_tasks");
  });

  it("emits planner_call_failed when callPlannerLlm throws", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => {
        throw new Error("LLM timeout");
      },
    });
    const result = await planner.draft({ issue: baseIssue });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("planner_call_failed");
      expect(result.message).toContain("LLM timeout");
    }
  });

  it("passes title / description / labels into the LLM call", async () => {
    let captured: unknown;
    const planner = createWorkItemPlanner({
      callPlannerLlm: async (input) => {
        captured = input;
        return {
          tasks: [
            {
              taskId: "t1",
              title: "A",
              goal: "g",
              scope: "s",
              dependsOn: [],
              suggestedValidation: [],
              riskLevel: "low",
            },
            {
              taskId: "t2",
              title: "B",
              goal: "g",
              scope: "s",
              dependsOn: [],
              suggestedValidation: [],
              riskLevel: "low",
            },
          ],
        };
      },
    });
    await planner.draft({ issue: baseIssue });
    expect(captured).toEqual({
      issue: {
        title: baseIssue.title,
        description: baseIssue.description,
        labels: baseIssue.labels,
      },
    });
  });
});
