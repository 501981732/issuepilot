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
  aggregateWorkItem,
  type AggregateDeps,
} from "../work-items/aggregate.js";
import {
  writeParentHandoff,
  type ParentHandoffDeps,
  type ParentHandoffWorkflow,
} from "../work-items/handoff.js";
import {
  tickWorkItem,
  type OrchestrationDeps,
} from "../work-items/orchestration.js";
import { createWorkItemPlanner } from "../work-items/planner.js";
import { createWorkItemService, settleTaskRunFinal } from "../work-items/service.js";
import { createWorkItemStore, type WorkItemStore } from "../work-items/store.js";

/**
 * V4.1 Workflow Spine end-to-end test.
 *
 * Goal: drive a single GitLab Issue through `planFromIssue → acceptPlan
 * → tick (dispatch synthetic task runs) → settle (per-run aggregate +
 * handoff)` using the real WorkItemStore / planner / orchestration /
 * aggregate / handoff modules. The only fakes are:
 *
 *   - LLM (planner returns a deterministic 2-task draft).
 *   - GitLab (in-memory note + label log).
 *   - Run dispatch (returns a synthetic runId; we feed back a fake
 *     RunReportArtifact via a per-runId map).
 *
 * Spec §16.5 / §17 acceptance scripts:
 *  1. POST plan → WorkItem(status="planning") + 2 draft tasks.
 *  2. POST accept → WorkItem(status="ready") + plan accepted.
 *  3. tick → both tasks dispatch in one cycle (concurrency permits).
 *  4. settle both as completed → WorkItemReport(complete) + parent
 *     label transitions to handoffLabel.
 *  5. Failure scenario: one task fails → WorkItem.status === "partial"
 *     and parent label does NOT transition to handoffLabel.
 *  6. Dependency scenario: T1 completes with MR `opened`, T2 dependsOn
 *     T1 — T2 stays `blocked_by_dependency` because upstream isn't
 *     merged.
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
  title: "Migrate auth module",
  description:
    "Acceptance criteria:\n- Migrate token storage\n- Migrate session lookup",
  url: "https://gitlab.example.com/group/project/-/issues/42",
  projectId: "group/project",
  labels: ["ai-ready"],
};

function fakeRunReport(over: {
  runId: string;
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
      title: "Migrate auth module",
      url: ISSUE.url,
      labels: ["ai-running"],
    },
    run: {
      status,
      attempt: 1,
      branch: `ai/wi/group-project/42/${over.runId}/v1`,
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
      summary: "+10/-2 in src/auth",
      filesChanged: 1,
      additions: 10,
      deletions: 2,
      notableFiles: ["src/auth/token.ts"],
    },
    checks: [],
    mergeReadiness: { status: "not_ready", reasons: [] },
    notes: {},
  };
}

/**
 * Build a fully wired in-memory WorkItemService that mimics the daemon
 * for the purposes of this test:
 *   - tick: drives orchestration.tickWorkItem with our fake dispatch.
 *   - reconcileWorkItem: aggregates + writes the parent handoff.
 */
function buildHarness(opts: {
  store: WorkItemStore;
  reportByRunId: Map<string, RunReportArtifact>;
  gitlab: ReturnType<typeof makeFakeGitlab>["adapter"];
  events: Array<{ type: string; runId?: string; detail: Record<string, unknown> }>;
  /**
   * Stub LLM. Returns the deterministic draft used in every test. We
   * still go through the real planner so plan-validation runs end to
   * end (depends_on cycles, riskLevel coercion, etc.).
   */
  draftTasks: Array<Partial<TaskNode> & { taskId: string; title: string }>;
}) {
  const { store, reportByRunId, gitlab, events, draftTasks } = opts;
  let dispatchCounter = 0;
  const taskRunIndex = new Map<string, { workItemId: string; taskId: string }>();
  let availableSlots = 16;

  const planner = createWorkItemPlanner({
    callPlannerLlm: async () => ({ tasks: draftTasks }),
  });

  const emit: ParentHandoffDeps["emit"] = (event) => {
    const detail = event.detail ?? {};
    events.push({
      type: event.type,
      ...(event.runId !== undefined ? { runId: event.runId } : {}),
      detail,
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
    const previousStatus = wi.status;
    const report = await aggregateWorkItem(wi, plan, links, aggregateDeps);
    await store.saveReport(report);
    await writeParentHandoff({
      workItem: wi,
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
    dispatchTask: async (task) => {
      dispatchCounter += 1;
      const runId = `run_${task.taskId}_${dispatchCounter}`;
      // The real daemon defers wiring runId↔workItem until the run lands;
      // for the test we capture it eagerly so settleTaskRunFinal can
      // look it up later.
      taskRunIndex.set(runId, { workItemId: "", taskId: task.taskId });
      return { runId, branch: `ai/${runId}/v1` };
    },
    saveTaskRunLink: (link) => store.saveTaskRunLink(link),
    saveTaskNode: async (taskId, patch) => {
      // Walk every plan in the store; patch the matching task. The real
      // daemon scopes by current plan but for E2E we only have one.
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
    // After dispatch, fix the workItemId on each runId we just produced
    // (we did not have it inside dispatchTask above).
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
    if (!meta) throw new Error(`unknown synthetic runId ${runId}`);
    const report = reportByRunId.get(runId);
    if (!report) throw new Error(`missing fake report for ${runId}`);
    // Use the same settleTaskRunFinal path the daemon's bus listener
    // uses — it does applyTaskRunFinal + aggregate + WorkItem status
    // transition + writeParentHandoff in one call.
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

describe("V4.1 Workflow Spine end-to-end", () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "issuepilot-v4-1-e2e-"));
  });
  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const draftTwoTasks = (
    over?: Partial<{ t2DependsOn: string[] }>,
  ): Array<Partial<TaskNode> & { taskId: string; title: string }> => [
    {
      taskId: "T1",
      title: "Migrate token storage",
      goal: "Move token writes to KV",
      scope: "src/auth/token.ts",
      dependsOn: [],
      suggestedValidation: ["pnpm test"],
      riskLevel: "medium",
    },
    {
      taskId: "T2",
      title: "Migrate session lookup",
      goal: "Update session reader",
      scope: "src/auth/session.ts",
      dependsOn: over?.t2DependsOn ?? [],
      suggestedValidation: ["pnpm test"],
      riskLevel: "low",
    },
  ];

  it("happy path: plan → accept → tick dispatches both tasks → settle complete → parent label flips to human-review", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      draftTasks: draftTwoTasks(),
    });

    // Step 1: plan from issue.
    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error(`plan failed: ${planRes.error.code}`);
    expect(planRes.workItem.status).toBe("planning");
    expect(planRes.plan.tasks).toHaveLength(2);
    const workItemId = planRes.workItem.workItemId;

    // Step 2: accept plan.
    const acceptRes = await harness.service.acceptPlan({
      workItemId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });
    if ("error" in acceptRes) {
      throw new Error(`accept failed: ${acceptRes.error.code}`);
    }
    expect(acceptRes.plan.status).toBe("accepted");
    // status moves to "ready" on accept; tick has not happened yet
    // because acceptPlan uses our injected tick which dispatches but
    // does not flip work item status.
    const wiAfterAccept = await store.getWorkItem(workItemId);
    expect(wiAfterAccept?.status).toBe("ready");

    // Step 3: tick orchestration. The harness already invoked tick once
    // inside acceptPlan; we explicitly run it again to assert idempotency
    // and that no second dispatch happens.
    const wi = (await store.getWorkItem(workItemId)) as WorkItem;
    await harness.tick(wi);
    const linksAfterTick = await store.listAllTaskRunLinks(workItemId);
    expect(linksAfterTick).toHaveLength(2);
    const dispatchedRunIds = linksAfterTick.map((l) => l.runId);
    expect(new Set(dispatchedRunIds).size).toBe(2);

    // Step 4: feed back two completed RunReports + settle.
    for (let i = 0; i < linksAfterTick.length; i++) {
      const runId = linksAfterTick[i]!.runId;
      reportByRunId.set(
        runId,
        fakeRunReport({ runId, mrIid: 7000 + i, mrState: "merged" }),
      );
    }
    // simulate the bus: settle each completed run
    for (const link of linksAfterTick) {
      await harness.settle(link.runId);
    }

    const finalReport = await store.getReport(workItemId);
    expect(finalReport?.overallStatus).toBe("complete");
    expect(finalReport?.taskSummaries).toHaveLength(2);
    expect(finalReport?.evidence.index.length).toBeGreaterThanOrEqual(2);

    // Per spec §17 we never recommend ready_to_merge.
    expect(finalReport?.recommendedNextActions.join(" ")).not.toMatch(
      /ready_to_merge/,
    );

    // Parent label transition: running → completed transitions to
    // handoffLabel. The settle path may have walked through ready →
    // running first; assert the FINAL log entry includes human-review.
    const labelTransitions = gitlabFake.state.labelLog;
    const last = labelTransitions[labelTransitions.length - 1];
    expect(last?.add).toContain("human-review");

    // Parent note carries the work-item marker so we can find/update it.
    const note = gitlabFake.state.notes.find((n) =>
      n.body.includes(`<!-- issuepilot:work-item:${workItemId} -->`),
    );
    expect(note).toBeDefined();
    expect(note?.body).toMatch(/Migrate token storage|Migrate session lookup/);
  });

  it("partial path: one task fails → WorkItem.status partial → parent label NOT moved to human-review", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      draftTasks: draftTwoTasks(),
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const workItemId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });
    const wi = (await store.getWorkItem(workItemId)) as WorkItem;
    await harness.tick(wi);

    const links = await store.listAllTaskRunLinks(workItemId);
    expect(links).toHaveLength(2);

    // First task succeeds, second fails.
    reportByRunId.set(
      links[0]!.runId,
      fakeRunReport({ runId: links[0]!.runId, mrIid: 7100, mrState: "merged" }),
    );
    reportByRunId.set(
      links[1]!.runId,
      fakeRunReport({
        runId: links[1]!.runId,
        mrIid: 7101,
        mrState: "opened",
        status: "failed",
      }),
    );
    for (const link of links) await harness.settle(link.runId);

    const report = await store.getReport(workItemId);
    expect(report?.overallStatus).toBe("partial");

    // No "human-review" transition was logged.
    const flat = gitlabFake.state.labelLog.flatMap((l) => l.add);
    expect(flat).not.toContain("human-review");
  });

  it("dependency path: T2 dependsOn T1; T1's MR opened (not merged) keeps T2 in blocked_by_dependency", async () => {
    const store = createWorkItemStore({ rootDir });
    const reportByRunId = new Map<string, RunReportArtifact>();
    const gitlabFake = makeFakeGitlab();
    const events: Array<{
      type: string;
      runId?: string;
      detail: Record<string, unknown>;
    }> = [];
    const harness = buildHarness({
      store,
      reportByRunId,
      gitlab: gitlabFake.adapter,
      events,
      draftTasks: draftTwoTasks({ t2DependsOn: ["T1"] }),
    });

    const planRes = await harness.service.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    if ("error" in planRes) throw new Error("plan failed");
    const workItemId = planRes.workItem.workItemId;
    await harness.service.acceptPlan({
      workItemId,
      planId: planRes.plan.planId,
      operator: "alice",
      edits: [],
    });

    const wi = (await store.getWorkItem(workItemId)) as WorkItem;
    await harness.tick(wi);

    // Only T1 should be dispatched on the first tick because T2 is
    // gated by T1's MR merging.
    const linksT1 = await store.listTaskRunLinks("T1");
    const linksT2 = await store.listTaskRunLinks("T2");
    expect(linksT1).toHaveLength(1);
    expect(linksT2).toHaveLength(0);

    // T1 completes but its MR stays in `opened` state — downstream
    // must still be blocked.
    reportByRunId.set(
      linksT1[0]!.runId,
      fakeRunReport({
        runId: linksT1[0]!.runId,
        mrIid: 7200,
        mrState: "opened",
      }),
    );
    await harness.settle(linksT1[0]!.runId);

    // Run a fresh tick — T2 should NOT be dispatched.
    const wiAfter = (await store.getWorkItem(workItemId)) as WorkItem;
    await harness.tick(wiAfter);
    const linksT2After = await store.listTaskRunLinks("T2");
    expect(linksT2After).toHaveLength(0);

    // task_run_blocked_by_dependency event should have fired for T2.
    const blockedEvents = events.filter(
      (e) => e.type === "task_run_blocked_by_dependency",
    );
    expect(blockedEvents.length).toBeGreaterThanOrEqual(1);
    expect(blockedEvents.some((e) => e.detail.taskId === "T2")).toBe(true);
  });
});
