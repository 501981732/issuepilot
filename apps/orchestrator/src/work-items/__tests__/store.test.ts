import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
  WorkItemReport,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWorkItemStore } from "../store.js";

const baseIssue = {
  projectId: "g/p",
  iid: 42,
  url: "https://gl/-/issues/42",
  title: "Big issue",
};

const baseTask: TaskNode = {
  taskId: "t1",
  title: "Add API",
  goal: "Implement POST /x",
  scope: "src/api/x.ts",
  dependsOn: [],
  suggestedValidation: ["pnpm test"],
  status: "planned",
  runIds: [],
  riskLevel: "low",
};

function makeWorkItem(over: Partial<WorkItem> = {}): WorkItem {
  return {
    workItemId: "wi_01",
    sourceIssue: baseIssue,
    title: "Big issue",
    goal: "ship",
    acceptanceCriteria: ["AC1"],
    status: "planning",
    taskIds: [],
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...over,
  };
}

function makePlan(over: Partial<TaskPlan> = {}): TaskPlan {
  return {
    planId: "tp_01",
    workItemId: "wi_01",
    version: 1,
    tasks: [baseTask],
    dependencies: [],
    operatorEdits: [],
    status: "draft",
    ...over,
  };
}

describe("WorkItemStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "issuepilot-work-items-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists WorkItem JSON under work-items/<id>.json", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveWorkItem(makeWorkItem({ workItemId: "wi_01" }));
    const body = await readFile(
      join(root, "work-items", "wi_01.json"),
      "utf8",
    );
    expect(JSON.parse(body).workItemId).toBe("wi_01");
  });

  it("looks up by workItemId after fs round-trip", async () => {
    const a = createWorkItemStore({ rootDir: root });
    await a.saveWorkItem(makeWorkItem({ workItemId: "wi_01", title: "T" }));
    const b = createWorkItemStore({ rootDir: root });
    const loaded = await b.getWorkItem("wi_01");
    expect(loaded?.title).toBe("T");
  });

  it("getWorkItem returns undefined when missing", async () => {
    const store = createWorkItemStore({ rootDir: root });
    expect(await store.getWorkItem("nope")).toBeUndefined();
  });

  it("persists TaskPlan as task-plans/<planId>.json", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveTaskPlan(makePlan({ planId: "tp_01" }));
    const body = await readFile(
      join(root, "task-plans", "tp_01.json"),
      "utf8",
    );
    expect(JSON.parse(body).planId).toBe("tp_01");
  });

  it("returns the latest non-rejected plan as the current plan", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveTaskPlan(
      makePlan({ planId: "tp_01", version: 1, status: "superseded" }),
    );
    await store.saveTaskPlan(
      makePlan({ planId: "tp_02", version: 2, status: "draft" }),
    );
    const current = await store.getCurrentPlan("wi_01");
    expect(current?.planId).toBe("tp_02");
  });

  it("lists plan history ascending by version", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveTaskPlan(
      makePlan({ planId: "tp_02", version: 2, status: "draft" }),
    );
    await store.saveTaskPlan(
      makePlan({ planId: "tp_01", version: 1, status: "superseded" }),
    );
    const history = await store.listPlanHistory("wi_01");
    expect(history.map((p) => p.version)).toEqual([1, 2]);
  });

  it("stores TaskRunLink under task-run-links/<taskId>/<runId>.json", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const link: TaskRunLink = {
      taskId: "t1",
      runId: "run_x",
      attempt: 1,
      status: "running",
      branch: "ai/42-task-1",
      startedAt: "2026-05-17T00:00:00.000Z",
    };
    await store.saveTaskRunLink(link);
    const body = await readFile(
      join(root, "task-run-links", "t1", "run_x.json"),
      "utf8",
    );
    expect(JSON.parse(body).runId).toBe("run_x");
  });

  it("lists all task run links for a task", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const link1: TaskRunLink = {
      taskId: "t1",
      runId: "run_x",
      attempt: 1,
      status: "failed",
      branch: "ai/42-task-1",
      startedAt: "2026-05-17T00:00:00.000Z",
    };
    const link2: TaskRunLink = {
      taskId: "t1",
      runId: "run_y",
      attempt: 2,
      status: "completed",
      branch: "ai/42-task-1",
      startedAt: "2026-05-17T00:01:00.000Z",
    };
    await store.saveTaskRunLink(link1);
    await store.saveTaskRunLink(link2);
    const got = await store.listTaskRunLinks("t1");
    expect(got.map((l) => l.runId).sort()).toEqual(["run_x", "run_y"]);
  });

  it("listAllTaskRunLinks walks every taskId in the workItem", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveWorkItem(
      makeWorkItem({ workItemId: "wi_01", taskIds: ["t1", "t2"] }),
    );
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_x",
      attempt: 1,
      status: "completed",
      branch: "ai/42-task-1",
      startedAt: "t",
    });
    await store.saveTaskRunLink({
      taskId: "t2",
      runId: "run_y",
      attempt: 1,
      status: "completed",
      branch: "ai/42-task-2",
      startedAt: "t",
    });
    const all = await store.listAllTaskRunLinks("wi_01");
    expect(all.map((l) => l.runId).sort()).toEqual(["run_x", "run_y"]);
  });

  it("lists work items by createdAt descending", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveWorkItem(
      makeWorkItem({
        workItemId: "wi_a",
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      }),
    );
    await store.saveWorkItem(
      makeWorkItem({
        workItemId: "wi_b",
        createdAt: "2026-05-17T01:00:00.000Z",
        updatedAt: "2026-05-17T01:00:00.000Z",
        status: "ready",
      }),
    );
    const list = await store.listWorkItems();
    expect(list.map((wi) => wi.workItemId)).toEqual(["wi_b", "wi_a"]);
  });

  it("persists WorkItemReport under work-item-reports/<workItemId>.json", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const report: WorkItemReport = {
      workItemId: "wi_01",
      overallStatus: "complete",
      taskSummaries: [],
      validationSummary: "OK",
      riskSummary: "low",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: ["enter human review"],
      humanReviewChecklist: [],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
    await store.saveReport(report);
    const got = await store.getReport("wi_01");
    expect(got).toEqual(report);

    const body = await readFile(
      join(root, "work-item-reports", "wi_01.json"),
      "utf8",
    );
    expect(JSON.parse(body).overallStatus).toBe("complete");
  });

  it("V4.6 migration：旧 status='running' 读出时升级为 running_coding", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const legacyTask: TaskNode = {
      ...baseTask,
      taskId: "t_legacy",
      status: "running" as TaskNode["status"],
    };
    await store.saveTaskPlan(
      makePlan({ planId: "tp_legacy", version: 5, tasks: [legacyTask] }),
    );
    const fresh = createWorkItemStore({ rootDir: root });
    const plan = await fresh.getCurrentPlan("wi_01");
    expect(plan?.tasks[0]?.status).toBe("running_coding");
  });

  it("V4.6 TaskNode 字段往返不丢（pendingRecipe / last_cancelled_at / currentPipelineRunId / roleFailureReason）", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const taskV46: TaskNode = {
      ...baseTask,
      taskId: "t_v46",
      status: "running_reviewer",
      pendingRecipe: "coding_plus_reviewer",
      pendingRecipeSource: "operator_override",
      last_cancelled_at: "2026-05-19T01:00:00.000Z",
      currentPipelineRunId: "pr_xx",
      roleFailureReason: "reviewer_cannot_review",
    };
    await store.saveTaskPlan(
      makePlan({ planId: "tp_v46", version: 7, tasks: [taskV46] }),
    );
    const fresh = createWorkItemStore({ rootDir: root });
    const plan = await fresh.getCurrentPlan("wi_01");
    const round = plan?.tasks[0];
    expect(round?.status).toBe("running_reviewer");
    expect(round?.pendingRecipe).toBe("coding_plus_reviewer");
    expect(round?.pendingRecipeSource).toBe("operator_override");
    expect(round?.last_cancelled_at).toBe("2026-05-19T01:00:00.000Z");
    expect(round?.currentPipelineRunId).toBe("pr_xx");
    expect(round?.roleFailureReason).toBe("reviewer_cannot_review");
  });

  it("persists evidence confirmations under evidence-confirmations/<workItemId>.json", async () => {
    const store = createWorkItemStore({ rootDir: root });
    const saved = await store.saveEvidenceConfirmation("wi_01", "ev_01", {
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T01:00:00.000Z",
    });
    expect(saved).toEqual({
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T01:00:00.000Z",
    });

    const body = await readFile(
      join(root, "evidence-confirmations", "wi_01.json"),
      "utf8",
    );
    expect(JSON.parse(body)).toEqual({
      ev_01: {
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T01:00:00.000Z",
      },
    });

    const fresh = createWorkItemStore({ rootDir: root });
    await fresh.saveEvidenceConfirmation("wi_01", "ev_02", {
      confirmedBy: "bob",
      confirmedAt: "2026-05-17T02:00:00.000Z",
    });

    await expect(fresh.loadEvidenceConfirmations("wi_01")).resolves.toEqual({
      ev_01: {
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T01:00:00.000Z",
      },
      ev_02: {
        confirmedBy: "bob",
        confirmedAt: "2026-05-17T02:00:00.000Z",
      },
    });
  });

  it("preserves the first evidence confirmation for duplicate writes", async () => {
    const store = createWorkItemStore({ rootDir: root });
    await store.saveEvidenceConfirmation("wi_01", "ev_01", {
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T01:00:00.000Z",
    });

    const saved = await store.saveEvidenceConfirmation("wi_01", "ev_01", {
      confirmedBy: "bob",
      confirmedAt: "2026-05-17T02:00:00.000Z",
    });

    expect(saved).toEqual({
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T01:00:00.000Z",
    });
    await expect(store.loadEvidenceConfirmations("wi_01")).resolves.toEqual({
      ev_01: {
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T01:00:00.000Z",
      },
    });
  });

  it("serializes concurrent evidence confirmation writes for a work item", async () => {
    const store = createWorkItemStore({ rootDir: root });

    await Promise.all([
      store.saveEvidenceConfirmation("wi_01", "ev_01", {
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T01:00:00.000Z",
      }),
      store.saveEvidenceConfirmation("wi_01", "ev_02", {
        confirmedBy: "bob",
        confirmedAt: "2026-05-17T02:00:00.000Z",
      }),
    ]);

    await expect(store.loadEvidenceConfirmations("wi_01")).resolves.toEqual({
      ev_01: {
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T01:00:00.000Z",
      },
      ev_02: {
        confirmedBy: "bob",
        confirmedAt: "2026-05-17T02:00:00.000Z",
      },
    });
  });
});
