import { describe, expect, it } from "vitest";

import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
  WorkItemReport,
} from "@issuepilot/shared-contracts";

import { collectQualitySources } from "../collect.js";

function runReportFixture(over: {
  runId: string;
  projectId: string;
  status: "completed" | "failed" | "blocked" | "running";
  ciStatus?: "success" | "failed" | "running" | "canceled";
}): RunReportArtifact {
  return {
    version: 1,
    runId: over.runId,
    issue: {
      projectId: over.projectId,
      iid: 1,
      title: "Issue",
      url: "https://gitlab.example/1",
      labels: ["human-review"],
    },
    run: {
      status: over.status,
      attempt: 1,
      branch: "issuepilot/1",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-18T00:00:00.000Z",
      endedAt: "2026-05-18T00:05:00.000Z",
      durations: { totalMs: 300_000 },
    },
    handoff: {
      summary: "ok",
      validation: [],
      risks: [],
      followUps: [],
      nextAction: "review",
    },
    diff: { summary: "", filesChanged: 0, notableFiles: [] },
    checks: [],
    mergeReadiness: {
      mode: "dry-run",
      status: "unknown",
      reasons: [],
      evaluatedAt: "2026-05-18T00:05:00.000Z",
    },
    notes: {},
    ...(over.ciStatus
      ? {
          ci: {
            status: over.ciStatus,
            checkedAt: "2026-05-18T00:05:00.000Z",
          },
        }
      : {}),
  };
}

function workItemFixture(over: {
  workItemId: string;
  projectId: string;
}): WorkItem {
  return {
    workItemId: over.workItemId,
    sourceIssue: {
      projectId: over.projectId,
      iid: 1,
      url: "https://gl/-/issues/1",
      title: "Big",
    },
    title: "Big",
    goal: "g",
    acceptanceCriteria: [],
    status: "running",
    taskIds: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:10:00.000Z",
  };
}

function taskFixture(over: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode {
  return {
    taskId: over.taskId,
    title: over.title ?? `Task ${over.taskId}`,
    goal: "g",
    scope: "s",
    dependsOn: [],
    suggestedValidation: [],
    status: over.status ?? "completed",
    runIds: [],
    riskLevel: "low",
    ...(over.needsReworkReason
      ? { needsReworkReason: over.needsReworkReason }
      : {}),
  };
}

function planFixture(over: {
  workItemId: string;
  tasks: TaskNode[];
}): TaskPlan {
  return {
    planId: "tp_1",
    workItemId: over.workItemId,
    version: 1,
    tasks: over.tasks,
    dependencies: [],
    operatorEdits: [],
    status: "accepted",
    acceptedAt: "2026-05-18T00:00:00.000Z",
  };
}

function linkFixture(over: {
  taskId: string;
  runId: string;
  status: TaskRunLink["status"];
}): TaskRunLink {
  return {
    taskId: over.taskId,
    runId: over.runId,
    attempt: 1,
    status: over.status,
    branch: "issuepilot/x",
    startedAt: "2026-05-18T00:00:00.000Z",
    completedAt: "2026-05-18T00:01:00.000Z",
  };
}

function workItemReportFixture(over: {
  workItemId: string;
  overallStatus: WorkItemReport["overallStatus"];
}): WorkItemReport {
  return {
    workItemId: over.workItemId,
    overallStatus: over.overallStatus,
    taskSummaries: [],
    validationSummary: "",
    riskSummary: "",
    evidence: { index: [], byTask: {} },
    openQuestions: [],
    recommendedNextActions: [],
    humanReviewChecklist: [],
    generatedAt: "2026-05-18T00:10:00.000Z",
  };
}

function fakeWorkItemStore(input: {
  workItem: WorkItem;
  plan: TaskPlan;
  links: TaskRunLink[];
  report?: WorkItemReport;
}) {
  return {
    listWorkItems: async () => [input.workItem],
    getCurrentPlan: async (id: string) =>
      id === input.workItem.workItemId ? input.plan : undefined,
    listAllTaskRunLinks: async (id: string) =>
      id === input.workItem.workItemId ? input.links : [],
    getReport: async (id: string) =>
      id === input.workItem.workItemId ? input.report : undefined,
  };
}

describe("collectQualitySources", () => {
  it("collects run report sources", async () => {
    const report = runReportFixture({
      runId: "run-1",
      projectId: "proj-a",
      status: "completed",
      ciStatus: "success",
    });
    const result = await collectQualitySources({
      reports: { all: async () => [report] },
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      kind: "run",
      projectId: "proj-a",
      runId: "run-1",
      runStatus: "completed",
      ciStatus: "success",
    });
  });

  it("collects work item task sources with effective task status", async () => {
    const workItem = workItemFixture({
      workItemId: "wi-1",
      projectId: "proj-a",
    });
    const plan = planFixture({
      workItemId: "wi-1",
      tasks: [
        taskFixture({
          taskId: "t1",
          status: "needs_rework",
          needsReworkReason: "Reviewer requested tests",
        }),
      ],
    });
    const link = linkFixture({ taskId: "t1", runId: "run-1", status: "completed" });
    const report = workItemReportFixture({
      workItemId: "wi-1",
      overallStatus: "partial",
    });
    const result = await collectQualitySources({
      reports: { all: async () => [] },
      workItems: fakeWorkItemStore({ workItem, plan, links: [link], report }),
    });
    expect(result.items).toContainEqual(
      expect.objectContaining({
        kind: "task",
        projectId: "proj-a",
        workItemId: "wi-1",
        taskId: "t1",
        taskStatus: "needs_rework",
        needsReworkReason: "Reviewer requested tests",
      }),
    );
  });

  it("returns empty arrays when stores are absent", async () => {
    const result = await collectQualitySources({});
    expect(result.items).toEqual([]);
    expect(result.diagnostics).toEqual({ invalidReportCount: 0 });
  });
});
