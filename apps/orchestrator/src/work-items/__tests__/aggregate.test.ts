import { describe, expect, it } from "vitest";

import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
} from "@issuepilot/shared-contracts";

import { aggregateWorkItem } from "../aggregate.js";

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
  acceptanceCriteria: ["AC1"],
  status: "ready",
  taskIds: ["t1", "t2"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

function task(over: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode {
  return {
    taskId: over.taskId,
    title: over.title ?? `Task ${over.taskId}`,
    goal: "g",
    scope: "s",
    dependsOn: over.dependsOn ?? [],
    suggestedValidation: over.suggestedValidation ?? [],
    status: over.status ?? "completed",
    runIds: over.runIds ?? [],
    riskLevel: over.riskLevel ?? "low",
  };
}

const plan: TaskPlan = {
  planId: "tp_01",
  workItemId: workItem.workItemId,
  version: 1,
  tasks: [
    task({ taskId: "t1", title: "Add API", status: "completed" }),
    task({ taskId: "t2", title: "Add UI", status: "completed" }),
  ],
  dependencies: [],
  operatorEdits: [],
  status: "accepted",
  acceptedAt: "2026-05-17T00:00:00.000Z",
};

function link(over: Partial<TaskRunLink> & Pick<TaskRunLink, "taskId" | "runId">): TaskRunLink {
  return {
    taskId: over.taskId,
    runId: over.runId,
    attempt: 1,
    status: over.status ?? "completed",
    branch: over.branch ?? `ai/42-${over.taskId}`,
    startedAt: "2026-05-17T00:00:00.000Z",
    completedAt: "2026-05-17T00:01:00.000Z",
    ...(over.mergeRequest ? { mergeRequest: over.mergeRequest } : {}),
    ...(over.reportId ? { reportId: over.reportId } : {}),
  };
}

function report(over: {
  runId: string;
  status?: RunReportArtifact["run"]["status"];
  mrState?: "opened" | "merged" | "closed";
  validation?: string[];
  risks?: RunReportArtifact["handoff"]["risks"];
  ci?: RunReportArtifact["ci"];
  reviewFeedback?: RunReportArtifact["reviewFeedback"];
  diffSummary?: string;
}): RunReportArtifact {
  return {
    version: 1,
    runId: over.runId,
    issue: {
      projectId: "g/p",
      iid: 42,
      title: "T",
      url: "https://gl/-/issues/42",
      labels: [],
    },
    run: {
      status: over.status ?? "completed",
      attempt: 1,
      branch: `ai/42-${over.runId}`,
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
      summary: `summary for ${over.runId}`,
      validation: over.validation ?? ["pnpm test"],
      risks: over.risks ?? [],
      followUps: [],
      nextAction: "review",
    },
    diff: {
      summary: over.diffSummary ?? "stub diff",
      filesChanged: 1,
      notableFiles: [],
    },
    checks: [],
    ...(over.ci ? { ci: over.ci } : {}),
    ...(over.reviewFeedback ? { reviewFeedback: over.reviewFeedback } : {}),
    mergeReadiness: {
      mode: "dry-run",
      status: "unknown",
      reasons: [],
      evaluatedAt: "2026-05-17T00:01:00.000Z",
    },
    notes: {},
  };
}

describe("aggregateWorkItem", () => {
  it("marks overallStatus='complete' when all tasks completed and reports present", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "completed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      ["run_a", report({ runId: "run_a" })],
      ["run_b", report({ runId: "run_b" })],
    ]);
    const result = await aggregateWorkItem(workItem, plan, links, {
      getRunReport: async (id) => reports.get(id),
      now: () => "2026-05-17T01:00:00.000Z",
    });
    expect(result.overallStatus).toBe("complete");
    expect(result.taskSummaries.length).toBe(2);
    expect(result.workItemId).toBe("wi_01");
  });

  it("marks overallStatus='partial' when one task failed", async () => {
    const failedPlan: TaskPlan = {
      ...plan,
      tasks: [
        task({ taskId: "t1", status: "completed" }),
        task({ taskId: "t2", status: "failed" }),
      ],
    };
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "failed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      ["run_a", report({ runId: "run_a" })],
      ["run_b", report({ runId: "run_b", status: "failed" })],
    ]);
    const result = await aggregateWorkItem(workItem, failedPlan, links, {
      getRunReport: async (id) => reports.get(id),
    });
    expect(result.overallStatus).toBe("partial");
    expect(
      result.taskSummaries.find((t) => t.taskId === "t2")?.taskStatus,
    ).toBe("failed");
  });

  it("marks overallStatus='incomplete' when a task is missing its RunReport", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "completed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      ["run_a", report({ runId: "run_a" })],
    ]);
    const result = await aggregateWorkItem(workItem, plan, links, {
      getRunReport: async (id) => reports.get(id),
    });
    expect(result.overallStatus).toBe("incomplete");
  });

  it("marks overallStatus='incomplete' when a task has no TaskRunLink at all", async () => {
    const result = await aggregateWorkItem(
      workItem,
      plan,
      [link({ taskId: "t1", runId: "run_a", status: "completed" })],
      {
        getRunReport: async () =>
          report({ runId: "run_a" }),
      },
    );
    expect(result.overallStatus).toBe("incomplete");
  });

  it("never recommends ready_to_merge regardless of input", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "completed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      ["run_a", report({ runId: "run_a", mrState: "merged" })],
      ["run_b", report({ runId: "run_b", mrState: "merged" })],
    ]);
    const result = await aggregateWorkItem(workItem, plan, links, {
      getRunReport: async (id) => reports.get(id),
    });
    const text = JSON.stringify(result);
    expect(text.toLowerCase()).not.toContain("ready_to_merge");
    expect(text.toLowerCase()).not.toContain("ready to merge");
  });

  it("indexes evidence by task with diff / validation / risk / ci / review_feedback kinds", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "completed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      [
        "run_a",
        report({
          runId: "run_a",
          validation: ["pnpm -r test"],
          risks: [{ level: "medium", text: "regression risk" }],
          ci: {
            status: "success",
            checkedAt: "2026-05-17T00:30:00.000Z",
          },
        }),
      ],
      [
        "run_b",
        report({
          runId: "run_b",
          reviewFeedback: {
            unresolvedCount: 1,
            comments: [
              {
                author: "reviewer",
                body: "please fix",
                url: "https://gl/-/c/1",
                resolved: false,
                createdAt: "2026-05-17T00:00:00.000Z",
              },
            ],
          },
        }),
      ],
    ]);
    const result = await aggregateWorkItem(workItem, plan, links, {
      getRunReport: async (id) => reports.get(id),
    });

    const kindsT1 = (result.evidence.byTask["t1"] ?? []).map((e) => e.kind);
    expect(kindsT1).toEqual(
      expect.arrayContaining(["diff", "validation", "risk", "ci"]),
    );
    const kindsT2 = (result.evidence.byTask["t2"] ?? []).map((e) => e.kind);
    expect(kindsT2).toEqual(
      expect.arrayContaining(["diff", "validation", "review_feedback"]),
    );

    expect(result.evidence.index.length).toBeGreaterThan(0);
  });

  it("populates recommendedNextActions for the partial case with the failed task ids", async () => {
    const failedPlan: TaskPlan = {
      ...plan,
      tasks: [
        task({ taskId: "t1", title: "Add API", status: "completed" }),
        task({ taskId: "t2", title: "Add UI", status: "failed" }),
      ],
    };
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "failed" }),
    ];
    const reports = new Map<string, RunReportArtifact>([
      ["run_a", report({ runId: "run_a" })],
      ["run_b", report({ runId: "run_b", status: "failed" })],
    ]);
    const result = await aggregateWorkItem(workItem, failedPlan, links, {
      getRunReport: async (id) => reports.get(id),
    });
    expect(result.recommendedNextActions.join(" ")).toContain("t2");
  });
});
