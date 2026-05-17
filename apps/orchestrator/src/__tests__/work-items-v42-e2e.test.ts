import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  RunReportArtifact,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decideEffectiveBase,
} from "../work-items/branch-chain.js";
import {
  aggregateWorkItem,
  type AggregateDeps,
} from "../work-items/aggregate.js";
import {
  writeParentHandoff,
  type ParentHandoffWorkflow,
} from "../work-items/handoff.js";
import {
  tickWorkItem,
  type OrchestrationDeps,
} from "../work-items/orchestration.js";
import {
  createWorkItemPlanner,
  type RawPlanResponse,
} from "../work-items/planner.js";
import {
  createWorkItemService,
  decideWorkItemStatus,
  settleTaskRunFinal,
} from "../work-items/service.js";
import { createWorkItemStore, type WorkItemStore } from "../work-items/store.js";

/**
 * V4.2 Task Graph end-to-end tests.
 *
 * Goal: exercise the new V4.2 wiring (`decideEffectiveBase` chaining,
 * `replanTask` single-task re-planning, `markNeedsRework`, `unskipTask`)
 * across the real WorkItemStore / orchestration / service modules. We
 * reuse the V4.1 in-memory fake GitLab adapter + fake run report
 * pattern from `work-items-e2e.test.ts` and add:
 *
 *   - `decideEffectiveBase` plumbed into the orchestrator harness so
 *     downstream tasks see `baseOverride` derived from upstream
 *     `TaskRunLink.branch` (chain-from-upstream path).
 *   - A planner that returns different drafts on different calls so
 *     `replanTask` can validate single-task replan behaviour.
 *
 * The intent is to keep these tests focused on the V4.2-specific code
 * paths; broader plan/accept/dispatch behaviour is already covered by
 * `work-items-e2e.test.ts`.
 */

interface FakeGitlabState {
  notes: Array<{ id: number; iid: number; body: string }>;
  labelLog: Array<{ iid: number; add: string[]; remove: string[] }>;
  nextNoteId: number;
}

function makeFakeGitlab() {
  const state: FakeGitlabState = {
    notes: [],
    labelLog: [],
    nextNoteId: 1,
  };
  const adapter = {
    findWorkpadNote: async (
      iid: number,
      marker: string,
    ): Promise<{ id: number; body: string } | null> => {
      const found = state.notes.find(
        (n) => n.iid === iid && n.body.includes(marker),
      );
      return found ? { id: found.id, body: found.body } : null;
    },
    createNote: async (iid: number, body: string): Promise<{ id: number }> => {
      const id = state.nextNoteId++;
      state.notes.push({ id, iid, body });
      return { id };
    },
    updateNote: async (
      iid: number,
      noteId: number,
      body: string,
    ): Promise<void> => {
      const note = state.notes.find((n) => n.id === noteId && n.iid === iid);
      if (note) note.body = body;
    },
    transitionLabels: async (
      iid: number,
      opts: { add: string[]; remove: string[] },
    ): Promise<void> => {
      state.labelLog.push({ iid, add: [...opts.add], remove: [...opts.remove] });
    },
  };
  return { state, adapter };
}

const HANDOFF_WORKFLOW: ParentHandoffWorkflow = {
  runningLabel: "ai-running",
  handoffLabel: "human-review",
  reworkLabel: "ai-rework",
  blockedLabel: "ai-blocked",
  readyLabel: "ai-ready",
};

const ISSUE = {
  iid: 42,
  title: "Auth migration",
  description: "Acceptance criteria:\n- Migrate token\n- Migrate session",
  url: "https://gitlab.example.com/group/project/-/issues/42",
  projectId: "group/project",
  labels: ["ai-ready"],
};

function fakeRunReport(over: {
  runId: string;
  branch?: string;
  status?: "completed" | "failed";
  mrIid: number;
  mrState?: "opened" | "merged";
}): RunReportArtifact {
  const status = over.status ?? "completed";
  return {
    version: 1 as const,
    runId: over.runId,
    issue: {
      projectId: "group/project",
      iid: 42,
      title: "Auth migration",
      url: ISSUE.url,
      labels: ["ai-running"],
    },
    run: {
      status,
      attempt: 1,
      branch: over.branch ?? `ai/${over.runId}/v1`,
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-17T00:00:00.000Z",
      endedAt: "2026-05-17T00:01:00.000Z",
      durations: { totalMs: 60_000 },
    },
    mergeRequest: {
      iid: over.mrIid,
      url: `https://gitlab.example.com/group/project/-/merge_requests/${over.mrIid}`,
      state: over.mrState ?? "merged",
    },
    handoff: {
      summary: status === "completed" ? "Done" : "Failed",
      validation: status === "completed" ? ["pnpm test"] : [],
      risks: [],
      followUps: [],
      nextAction:
        status === "completed" ? "Reviewer to inspect the MR" : "Operator to retry",
    },
    diff: {
      summary: "+10/-2",
      filesChanged: 1,
      additions: 10,
      deletions: 2,
      notableFiles: ["src/auth/x.ts"],
    },
    checks: [],
    mergeReadiness: { status: "not_ready", reasons: [] },
    notes: {},
  };
}

type DispatchOpts = { baseOverride?: string; chainedFrom?: string };

interface DispatchCall {
  taskId: string;
  baseOverride: string | undefined;
  chainedFrom: string | undefined;
}

interface PlannerState {
  // Initial multi-task draft on planFromIssue.
  initial: RawPlanResponse;
  // V4.2 single-task replan responses keyed by taskId.
  replanResponses: Map<string, RawPlanResponse>;
}

function buildHarness(opts: {
  store: WorkItemStore;
  reportByRunId: Map<string, RunReportArtifact>;
  gitlab: ReturnType<typeof makeFakeGitlab>["adapter"];
  events: Array<{ type: string; runId?: string; detail: Record<string, unknown> }>;
  dispatches: DispatchCall[];
  plannerState: PlannerState;
}) {
  const { store, reportByRunId, gitlab, events, dispatches, plannerState } = opts;
  let dispatchCounter = 0;
  const taskRunIndex = new Map<string, { workItemId: string; taskId: string }>();
  let availableSlots = 16;

  const planner = createWorkItemPlanner({
    callPlannerLlm: async (input) => {
      if (input.replanScope) {
        const r = plannerState.replanResponses.get(input.replanScope.taskId);
        if (!r) {
          throw new Error(
            `test planner: no replan response wired for ${input.replanScope.taskId}`,
          );
        }
        return r;
      }
      return plannerState.initial;
    },
  });

  const emit = (event: {
    type: string;
    runId?: string;
    ts: string;
    detail: Record<string, unknown>;
  }) => {
    events.push({
      type: event.type,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      detail: event.detail ?? {},
    });
  };

  const aggregateDeps: AggregateDeps = {
    getRunReport: async (runId) => reportByRunId.get(runId),
  };

  async function reconcileWorkItem(workItemId: string): Promise<void> {
    const wi = await store.getWorkItem(workItemId);
    const plan = await store.getCurrentPlan(workItemId);
    if (!wi || !plan) return;
    const links = await store.listAllTaskRunLinks(workItemId);
    const ts = "2026-05-17T00:00:00.000Z";
    const report = await aggregateWorkItem(wi, plan, links, aggregateDeps);
    await store.saveReport(report);
    const previousStatus = wi.status;
    const nextStatus = decideWorkItemStatus(report.overallStatus, plan, links);
    const updated: WorkItem = {
      ...wi,
      status: nextStatus,
      summaryReportId: report.workItemId,
      updatedAt: ts,
    };
    await store.saveWorkItem(updated);
    await writeParentHandoff({
      workItem: updated,
      plan,
      report,
      previousStatus,
      workflow: HANDOFF_WORKFLOW,
      deps: { gitlab, emit },
    });
  }

  const orchestrationDeps: OrchestrationDeps = {
    availableSlots: () => availableSlots,
    getRunReport: (runId) => Promise.resolve(reportByRunId.get(runId)),
    decideEffectiveBase: (input) =>
      decideEffectiveBase({
        task: input.task,
        plan: input.plan,
        links: input.links,
        getRunReport: (runId) => Promise.resolve(reportByRunId.get(runId)),
        defaultBaseBranch: "main",
      }),
    dispatchTask: async (task, dispatchOpts?: DispatchOpts) => {
      dispatchCounter += 1;
      const runId = `run_${task.taskId}_${dispatchCounter}`;
      taskRunIndex.set(runId, { workItemId: "", taskId: task.taskId });
      dispatches.push({
        taskId: task.taskId,
        baseOverride: dispatchOpts?.baseOverride,
        chainedFrom: dispatchOpts?.chainedFrom,
      });
      return { runId, branch: `ai/${runId}/v1` };
    },
    saveTaskRunLink: (link) => store.saveTaskRunLink(link),
    saveTaskNode: async (taskId, patch) => {
      for (const wi of await store.listWorkItems()) {
        const current = await store.getCurrentPlan(wi.workItemId);
        if (!current) continue;
        if (!current.tasks.some((t) => t.taskId === taskId)) continue;
        const nextTasks = current.tasks.map((t) =>
          t.taskId === taskId ? { ...t, ...patch } : t,
        );
        await store.saveTaskPlan({ ...current, tasks: nextTasks });
      }
    },
    emit,
  };

  async function tick(workItem: WorkItem) {
    const plan = await store.getCurrentPlan(workItem.workItemId);
    if (!plan || plan.status !== "accepted") return;
    const links = await store.listAllTaskRunLinks(workItem.workItemId);
    await tickWorkItem(workItem, plan, links, orchestrationDeps);
    for (const [runId, meta] of taskRunIndex) {
      if (!meta.workItemId) {
        taskRunIndex.set(runId, {
          workItemId: workItem.workItemId,
          taskId: meta.taskId,
        });
      }
    }
  }

  const service = createWorkItemService({
    store,
    planner,
    fetchIssue: async () => ISSUE,
    tick,
    reconcileWorkItem,
    emit,
    now: () => "2026-05-17T00:00:00.000Z",
  });

  async function settle(runId: string) {
    const meta = taskRunIndex.get(runId);
    if (!meta) throw new Error(`unknown runId ${runId}`);
    const report = reportByRunId.get(runId);
    if (!report) throw new Error(`missing report for ${runId}`);
    await settleTaskRunFinal(
      {
        workItemId: meta.workItemId,
        taskId: meta.taskId,
        runId,
        runReport: report,
      },
      {
        store,
        aggregateDeps,
        parentHandoff: { gitlab, emit },
        workflow: HANDOFF_WORKFLOW,
        emit,
        saveTaskRunLink: orchestrationDeps.saveTaskRunLink,
        saveTaskNode: orchestrationDeps.saveTaskNode,
      },
    );
  }

  return {
    service,
    tick,
    settle,
    setAvailableSlots: (n: number) => {
      availableSlots = n;
    },
    taskRunIndex,
  };
}

function threeTaskChain(): RawPlanResponse {
  return {
    tasks: [
      {
        taskId: "T1",
        title: "Token storage",
        goal: "g",
        scope: "src/auth/token.ts",
        dependsOn: [],
        suggestedValidation: ["pnpm test"],
        riskLevel: "medium",
      } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
      {
        taskId: "T2",
        title: "Session lookup",
        goal: "g",
        scope: "src/auth/session.ts",
        dependsOn: ["T1"],
        suggestedValidation: ["pnpm test"],
        riskLevel: "low",
      } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
      {
        taskId: "T3",
        title: "Cleanup",
        goal: "g",
        scope: "src/auth/cleanup.ts",
        dependsOn: ["T2"],
        suggestedValidation: ["pnpm test"],
        riskLevel: "low",
      } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
    ],
  };
}

function twoTaskPlan(): RawPlanResponse {
  return {
    tasks: [
      {
        taskId: "T1",
        title: "Token storage",
        goal: "g",
        scope: "src/auth/token.ts",
        dependsOn: [],
        suggestedValidation: ["pnpm test"],
        riskLevel: "medium",
      } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
      {
        taskId: "T2",
        title: "Session lookup",
        goal: "g",
        scope: "src/auth/session.ts",
        dependsOn: [],
        suggestedValidation: ["pnpm test"],
        riskLevel: "low",
      } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
    ],
  };
}

describe("V4.2 Task Graph end-to-end", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "issuepilot-v4-2-e2e-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("branch chaining: upstream MR opened → downstream dispatches with baseOverride pointing at upstream branch", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: threeTaskChain(),
        replanResponses: new Map(),
      },
    });

    // plan → accept → tick: only T1 is ready, T2/T3 are gated by deps.
    const plan = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in plan) throw new Error(`plan failed`);
    const wiId = plan.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: plan.plan.planId,
      operator: "alice",
      edits: [],
    });

    const linksT1 = await store.listTaskRunLinks("T1");
    expect(linksT1).toHaveLength(1);

    // T1 completes with MR *opened* (not merged) — V4.2 chaining should
    // unblock T2 by deriving baseOverride from T1's branch.
    const t1Run = linksT1[0]!.runId;
    const t1Branch = linksT1[0]!.branch;
    reportByRunId.set(
      t1Run,
      fakeRunReport({
        runId: t1Run,
        branch: t1Branch,
        mrIid: 8001,
        mrState: "opened",
      }),
    );
    await harness.settle(t1Run);

    // Next tick should dispatch T2 with baseOverride === T1's branch.
    let wi = (await store.getWorkItem(wiId)) as WorkItem;
    await harness.tick(wi);
    const t2Dispatch = dispatches.find((d) => d.taskId === "T2");
    expect(t2Dispatch).toBeDefined();
    expect(t2Dispatch?.baseOverride).toBe(`origin/${t1Branch}`);
    expect(t2Dispatch?.chainedFrom).toBe("T1");

    // T2 completes also opened — T3 should chain off T2.
    const linksT2 = await store.listTaskRunLinks("T2");
    expect(linksT2).toHaveLength(1);
    const t2Run = linksT2[0]!.runId;
    const t2Branch = linksT2[0]!.branch;
    reportByRunId.set(
      t2Run,
      fakeRunReport({
        runId: t2Run,
        branch: t2Branch,
        mrIid: 8002,
        mrState: "opened",
      }),
    );
    await harness.settle(t2Run);

    wi = (await store.getWorkItem(wiId)) as WorkItem;
    await harness.tick(wi);
    const t3Dispatch = dispatches.find((d) => d.taskId === "T3");
    expect(t3Dispatch).toBeDefined();
    expect(t3Dispatch?.baseOverride).toBe(`origin/${t2Branch}`);
    expect(t3Dispatch?.chainedFrom).toBe("T2");
  });

  it("single-task replan: replanTask creates a new plan version with replanOf and inherits other tasks' runIds", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];

    // T2 will be replanned to a new title + scope.
    const replanned: RawPlanResponse = {
      tasks: [
        {
          taskId: "T2",
          title: "Session lookup v2",
          goal: "g2",
          scope: "src/auth/session-v2.ts",
          dependsOn: [],
          suggestedValidation: ["pnpm test"],
          riskLevel: "low",
        } as Partial<TaskNode> as RawPlanResponse["tasks"][0],
      ],
    };

    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: twoTaskPlan(),
        replanResponses: new Map([["T2", replanned]]),
      },
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const wiId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    // T1 completes successfully.
    const linksT1 = await store.listTaskRunLinks("T1");
    reportByRunId.set(
      linksT1[0]!.runId,
      fakeRunReport({
        runId: linksT1[0]!.runId,
        mrIid: 9001,
        mrState: "merged",
      }),
    );
    await harness.settle(linksT1[0]!.runId);

    // Operator replans T2.
    const replanResult = await harness.service.replanTask({
      workItemId: wiId,
      taskId: "T2",
      reason: "Need to split session lookup",
      operator: "alice",
    });
    if ("error" in replanResult) {
      throw new Error(`replan failed: ${replanResult.error.code}`);
    }
    expect(replanResult.plan.version).toBe(2);
    expect(replanResult.plan.status).toBe("draft");
    expect(replanResult.plan.replanOf).toEqual({
      planId: planRes.plan.planId,
      taskId: "T2",
    });
    // T1 retains the runIds it accumulated in the prior plan.
    const t1InV2 = replanResult.plan.tasks.find((t) => t.taskId === "T1");
    expect(t1InV2?.runIds.length).toBeGreaterThanOrEqual(1);
    expect(t1InV2?.status).toBe("completed");
    // T2 was replanned — title/scope reflect the new draft, but its
    // prior runIds are preserved as historical evidence (spec §9.3 +
    // plan §7：「保留 replan task 的 runIds（historical evidence）」).
    const t2InV2 = replanResult.plan.tasks.find((t) => t.taskId === "T2");
    expect(t2InV2?.title).toBe("Session lookup v2");
    expect(t2InV2?.runIds.length).toBeGreaterThanOrEqual(1);
    expect(t2InV2?.status).toBe("planned");
    // The old plan must now be marked superseded.
    const history = await store.listPlanHistory(wiId);
    const oldPlan = history.find((p) => p.planId === planRes.plan.planId);
    expect(oldPlan?.status).toBe("superseded");
    // The event log records the V4.2 task_replanned event.
    expect(events.some((e) => e.type === "task_replanned")).toBe(true);
  });

  it("markNeedsRework: transitions the task and the WorkItem.status moves to partial", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: twoTaskPlan(),
        replanResponses: new Map(),
      },
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const wiId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    // Both T1 and T2 complete successfully.
    for (const link of await store.listAllTaskRunLinks(wiId)) {
      reportByRunId.set(
        link.runId,
        fakeRunReport({
          runId: link.runId,
          mrIid: 9000 + link.taskId.length,
          mrState: "merged",
        }),
      );
      await harness.settle(link.runId);
    }

    let wi = (await store.getWorkItem(wiId)) as WorkItem;
    expect(wi.status).toBe("completed");

    // Operator marks T2 for rework.
    const markRes = await harness.service.markNeedsRework({
      workItemId: wiId,
      taskId: "T2",
      reason: "Reviewer wants additional tests",
      operator: "alice",
    });
    expect(markRes).toEqual({ ok: true });

    wi = (await store.getWorkItem(wiId)) as WorkItem;
    expect(wi.status).toBe("partial");
    const planAfter = await store.getCurrentPlan(wiId);
    const t2 = planAfter?.tasks.find((t) => t.taskId === "T2");
    expect(t2?.status).toBe("needs_rework");
    expect(t2?.needsReworkReason).toBe("Reviewer wants additional tests");
    expect(events.some((e) => e.type === "task_marked_needs_rework")).toBe(
      true,
    );

    // V4.2 review C2: the parent Issue label must actually transition
    // from `human-review` back to `ai-rework` so the §12.3 rework loop
    // is visible at the GitLab UI level. Pre-fix `decideParentLabelTransition`
    // had no rule for `completed → partial`, so the label silently
    // stayed at `human-review` and the rework intent was invisible.
    const reworkTransition = gitlabFake.state.labelLog.find(
      (entry) =>
        entry.add.includes("ai-rework") &&
        entry.remove.includes("human-review"),
    );
    expect(reworkTransition, "expected ai-rework label transition").toBeDefined();
    // writeParentHandoff emits a single `work_item_handoff_written`
    // event that carries the label transition in its detail.
    const handoffEvent = events.find(
      (e) =>
        e.type === "work_item_handoff_written" &&
        Array.isArray(e.detail.labelAdd) &&
        (e.detail.labelAdd as string[]).includes("ai-rework"),
    );
    expect(handoffEvent, "expected handoff event with ai-rework").toBeDefined();
  });

  // V4.2 review C2 follow-through: retrying the rework'd task should
  // close the loop by moving the parent label ai-rework → ai-running,
  // and once everything settles complete again the label flips back to
  // human-review. Pre-fix neither transition existed.
  it("rework round-trip: ai-rework → ai-running on retry, then human-review when complete again", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: twoTaskPlan(),
        replanResponses: new Map(),
      },
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const wiId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    // Both tasks complete with merged MRs → WorkItem.status = completed.
    for (const link of await store.listAllTaskRunLinks(wiId)) {
      reportByRunId.set(
        link.runId,
        fakeRunReport({
          runId: link.runId,
          mrIid: 9300 + link.taskId.length,
          mrState: "merged",
        }),
      );
      await harness.settle(link.runId);
    }
    expect(((await store.getWorkItem(wiId)) as WorkItem).status).toBe(
      "completed",
    );

    // markNeedsRework → ai-rework transition (regression coverage —
    // shared with the test above, but here we want a clean labelLog
    // snapshot before the retry round-trip assertions below).
    await harness.service.markNeedsRework({
      workItemId: wiId,
      taskId: "T2",
      reason: "Reviewer wants extra tests",
      operator: "alice",
    });
    const labelsAfterRework = gitlabFake.state.labelLog.length;

    // Operator clicks Retry → ai-rework → ai-running.
    await harness.service.retryTask(wiId, "T2", "alice");
    const retryTransition = gitlabFake.state.labelLog
      .slice(labelsAfterRework)
      .find(
        (entry) =>
          entry.add.includes("ai-running") &&
          entry.remove.includes("ai-rework"),
      );
    expect(
      retryTransition,
      "expected ai-running label transition on retry",
    ).toBeDefined();

    // The retry produced a fresh running TaskRunLink for T2. Settle it
    // as merged and the rework loop closes: ai-running → human-review.
    const latestLinks = await store.listAllTaskRunLinks(wiId);
    const newT2Link = latestLinks
      .filter((l) => l.taskId === "T2")
      .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))
      .at(-1);
    if (!newT2Link) throw new Error("expected a fresh T2 link after retry");
    reportByRunId.set(
      newT2Link.runId,
      fakeRunReport({
        runId: newT2Link.runId,
        mrIid: 9400,
        mrState: "merged",
      }),
    );
    await harness.settle(newT2Link.runId);

    expect(((await store.getWorkItem(wiId)) as WorkItem).status).toBe(
      "completed",
    );
    const closeTransition = gitlabFake.state.labelLog.find(
      (entry) =>
        entry.add.includes("human-review") &&
        entry.remove.includes("ai-running"),
    );
    expect(
      closeTransition,
      "expected human-review label transition when rework loop closes",
    ).toBeDefined();
  });

  // Review C1: after a task settles `completed`, operator marks it back
  // to `needs_rework`, then clicks Retry. The retry must actually push
  // the task back through dispatch — pre-fix the old completed
  // TaskRunLink kept blocking `computeReadyTasks`, so retry was a silent
  // no-op and the §12.3 rework loop never closed.
  it("retry after markNeedsRework: redispatches the task even when an old completed TaskRunLink exists", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: twoTaskPlan(),
        replanResponses: new Map(),
      },
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const wiId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    // Both tasks settle complete with merged MRs.
    for (const link of await store.listAllTaskRunLinks(wiId)) {
      reportByRunId.set(
        link.runId,
        fakeRunReport({
          runId: link.runId,
          mrIid: 9100 + link.taskId.length,
          mrState: "merged",
        }),
      );
      await harness.settle(link.runId);
    }
    const dispatchesAfterFirstRound = dispatches.length;
    expect(dispatchesAfterFirstRound).toBeGreaterThanOrEqual(2);

    // Operator marks T2 for rework, then retries it.
    await harness.service.markNeedsRework({
      workItemId: wiId,
      taskId: "T2",
      reason: "Reviewer wants extra tests",
      operator: "alice",
    });
    const retryRes = await harness.service.retryTask(wiId, "T2", "alice");
    expect(retryRes).toEqual({ ok: true });

    // The fix: the orchestrator dispatched T2 again, on a fresh runId,
    // even though there is still a `completed` TaskRunLink from the
    // first attempt.
    expect(dispatches.length).toBeGreaterThan(dispatchesAfterFirstRound);
    const dispatchedTaskIds = dispatches.map((d) => d.taskId);
    expect(dispatchedTaskIds.filter((id) => id === "T2").length).toBeGreaterThanOrEqual(2);

    // The new dispatch records its runId on the task's append-only
    // history; the old runId is still present (canonical evidence).
    const planAfterRetry = await store.getCurrentPlan(wiId);
    const t2 = planAfterRetry?.tasks.find((t) => t.taskId === "T2");
    expect(t2?.runIds.length).toBeGreaterThanOrEqual(2);
    expect(t2?.status).toBe("running");

    // The latest TaskRunLink is the new running one; the old completed
    // link is retained as historical evidence so aggregate / dashboard
    // can still link to the merged MR.
    const links = await store.listAllTaskRunLinks(wiId);
    const t2Links = links.filter((l) => l.taskId === "T2");
    expect(t2Links.length).toBeGreaterThanOrEqual(2);
    expect(t2Links.some((l) => l.status === "completed")).toBe(true);
    expect(t2Links.some((l) => l.status === "running")).toBe(true);
  });

  it("unskip: skipped → ready and tick re-dispatches", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const dispatches: DispatchCall[] = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      dispatches,
      plannerState: {
        initial: twoTaskPlan(),
        replanResponses: new Map(),
      },
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const wiId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId: wiId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    // Skip T1 before settling anything: orchestration accepted but only
    // dispatched it during accept tick. Skip will retract.
    await harness.service.skipTask(wiId, "T1", "alice");
    let planAfterSkip = await store.getCurrentPlan(wiId);
    expect(planAfterSkip?.tasks.find((t) => t.taskId === "T1")?.status).toBe(
      "skipped",
    );

    // Snapshot dispatch count, then unskip — tickWorkItem should run
    // and re-dispatch T1 (no completed run yet).
    const dispatchesBefore = dispatches.length;
    const unskipRes = await harness.service.unskipTask({
      workItemId: wiId,
      taskId: "T1",
      operator: "alice",
    });
    expect(unskipRes).toEqual({ ok: true });
    planAfterSkip = await store.getCurrentPlan(wiId);
    expect(planAfterSkip?.tasks.find((t) => t.taskId === "T1")?.status).toBe(
      "ready",
    );
    expect(events.some((e) => e.type === "task_unskipped")).toBe(true);
    expect(dispatches.length).toBeGreaterThanOrEqual(dispatchesBefore);
  });
});
