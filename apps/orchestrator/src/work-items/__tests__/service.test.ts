import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  WorkItemReport,
} from "@issuepilot/shared-contracts";

import type { WorkItemPlanner } from "../planner.js";
import * as ReportRenderer from "../render-report.js";
import { createWorkItemService } from "../service.js";
import { createWorkItemStore } from "../store.js";

const issue = {
  iid: 42,
  title: "Big",
  description: "Goal: ship X.\n- AC1\n- AC2",
  url: "https://gl/-/issues/42",
  projectId: "g/p",
  labels: ["ai-ready"],
};

function makePlanner(over?: Partial<WorkItemPlanner>): WorkItemPlanner {
  return {
    draft: over?.draft ??
      (async ({ workItemId }) => ({
        ok: true as const,
        plan: {
          planId: "tp_01",
          workItemId: workItemId ?? "",
          version: 1,
          status: "draft" as const,
          tasks: [
            {
              taskId: "t1",
              title: "Add API",
              goal: "POST /x",
              scope: "src/api/x.ts",
              dependsOn: [],
              suggestedValidation: ["pnpm test"],
              status: "planned" as const,
              runIds: [],
              riskLevel: "low" as const,
            },
            {
              taskId: "t2",
              title: "Add UI",
              goal: "Render result",
              scope: "src/ui/x.tsx",
              dependsOn: ["t1"],
              suggestedValidation: ["pnpm test"],
              status: "planned" as const,
              runIds: [],
              riskLevel: "low" as const,
            },
          ],
          dependencies: [{ from: "t1", to: "t2" }],
          operatorEdits: [],
        } as TaskPlan,
      })),
  };
}

function makeRunReport(
  runId: string,
  over: Partial<RunReportArtifact> = {},
): RunReportArtifact {
  return {
    runId,
    issueIid: 42,
    status: "completed",
    run: {
      runId,
      status: "completed",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    },
    diff: {
      filesChanged: 1,
      notableFiles: ["src/api.ts"],
      summary: `diff for ${runId}`,
    },
    handoff: {
      summary: `summary for ${runId}`,
      validation: [`validated ${runId}`],
      risks: [],
      followUps: [],
    },
    checks: [],
    evidence: [
      {
        kind: "screenshot",
        label: `Screenshot ${runId}`,
        relPath: `screenshots/${runId}.png`,
      },
    ],
    ...over,
  };
}

async function makeAcceptedService(input: {
  reports?: Map<string, RunReportArtifact>;
  reconcile?: (workItemId: string) => Promise<void>;
  emit?: Parameters<typeof createWorkItemService>[0]["emit"];
  now?: () => string;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
  const store = createWorkItemStore({ rootDir: dir });
  const svc = createWorkItemService({
    store,
    planner: makePlanner(),
    fetchIssue: async () => issue,
    tick: async () => {},
    reconcileWorkItem: input.reconcile ?? (async () => {}),
    emit: input.emit ?? (() => {}),
    aggregateDeps: {
      getRunReport: async (runId) => input.reports?.get(runId),
    },
    newId: () => "wi_test",
    now: input.now ?? (() => "2026-05-17T00:00:00.000Z"),
  });
  const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
  if ("error" in planned) throw new Error(planned.error.message);
  const accepted = await svc.acceptPlan({
    planId: planned.plan.planId,
    edits: [],
    operator: "alice",
    workItemId: planned.workItem.workItemId,
  });
  if ("error" in accepted) throw new Error(accepted.error.message);
  return { dir, store, svc, workItem: accepted.workItem, plan: accepted.plan };
}

describe("createWorkItemService", () => {
  it("planFromIssue creates a WorkItem + draft TaskPlan and returns them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const events: string[] = [];
    const ticked: string[] = [];

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async (wi) => {
        ticked.push(wi.workItemId);
      },
      reconcileWorkItem: async () => {},
      emit: (e) => events.push(e.type),
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const result = await svc.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(result.workItem.workItemId).toBe("wi_test");
    expect(result.workItem.status).toBe("planning");
    expect(result.plan.tasks).toHaveLength(2);
    expect(events).toContain("work_item_created");
  });

  it("planFromIssue returns planner_failed when planner draft fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner({
        draft: async () => ({
          ok: false as const,
          code: "planner_parse_failed",
          message: "bad json",
        }),
      }),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const result = await svc.planFromIssue({
      iid: 42,
      operator: "alice",
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("planner_failed");
    }
  });

  it("acceptPlan flips plan to accepted, work item to ready, and triggers tick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    let ticks = 0;

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {
        ticks += 1;
      },
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const accepted = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });
    if ("error" in accepted) throw new Error(accepted.error.message);

    expect(accepted.plan.status).toBe("accepted");
    expect(accepted.workItem.status).toBe("ready");
    expect(ticks).toBe(1);
  });

  it("acceptPlan applies edits to TaskNode fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const accepted = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [{ taskId: "t1", field: "title", after: "Renamed" }],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });
    if ("error" in accepted) throw new Error(accepted.error.message);

    const t1 = accepted.plan.tasks.find((t: TaskNode) => t.taskId === "t1");
    expect(t1?.title).toBe("Renamed");
    expect(accepted.plan.operatorEdits).toHaveLength(1);
  });

  // V4.1 review I1: operator edits run through validatePlanDraft.
  // Without this guard a UI bug or hostile request could persist a
  // structurally broken plan (cycles freeze computeReadyTasks, empty
  // titles confuse the dashboard, etc).
  it("acceptPlan rejects operator edits that introduce a dependency cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    // The default planner draft has t1 with no deps and t2 dependsOn
    // t1. Adding t1.dependsOn = ["t2"] introduces a cycle.
    const result = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [
        { taskId: "t1", field: "dependsOn", after: ["t2"] },
      ],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("validation_failed");
      expect(result.error.message).toMatch(/dependency_cycle/);
    }

    // The plan should NOT be marked accepted on failure.
    const detail = await svc.detail(planned.workItem.workItemId);
    expect(detail?.plan.current.status).toBe("draft");
  });

  it("acceptPlan rejects operator edits that empty out a required field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const result = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [{ taskId: "t1", field: "title", after: "   " }],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.code).toBe("validation_failed");
      expect(result.error.message).toMatch(/missing_title/);
    }
  });

  it("detail returns plan + tasks + run links + report when present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const detail = await svc.detail(planned.workItem.workItemId);
    expect(detail).toBeDefined();
    expect(detail?.plan.current.tasks).toHaveLength(2);
    expect(detail?.runLinks).toEqual([]);
    expect(detail?.report).toBeUndefined();
  });

  it("skipTask flips a task to skipped and emits task_run_skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const events: string[] = [];

    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: (e) => events.push(e.type),
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);
    const accepted = await svc.acceptPlan({
      planId: planned.plan.planId,
      edits: [],
      operator: "alice",
      workItemId: planned.workItem.workItemId,
    });
    if ("error" in accepted) throw new Error(accepted.error.message);

    const result = await svc.skipTask(
      planned.workItem.workItemId,
      "t1",
      "alice",
    );
    expect(result).toEqual({ ok: true });
    const detail = await svc.detail(planned.workItem.workItemId);
    expect(detail?.plan.current.tasks.find((t: TaskNode) => t.taskId === "t1")?.status).toBe(
      "skipped",
    );
    expect(events).toContain("task_run_skipped");
  });

  it("graph returns levels + edges + criticalPathTaskIds when plan exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const events: string[] = [];
    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: (e) => events.push(e.type),
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });
    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);
    const result = await svc.graph(planned.workItem.workItemId);
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.levels).toEqual([["t1"], ["t2"]]);
    expect(result.edges).toContainEqual({ from: "t1", to: "t2" });
    expect(result.criticalPathTaskIds).toEqual(["t1", "t2"]);
    expect(events).toContain("task_graph_recomputed");
  });

  it("graph returns not_found when plan does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });
    const result = await svc.graph("missing");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.code).toBe("not_found");
  });

  it("regeneratePlan calls planFromIssue with regenerate=true and bumps version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    let plannerCalls = 0;

    const svc = createWorkItemService({
      store,
      planner: {
        draft: async ({ workItemId }) => {
          plannerCalls += 1;
          return {
            ok: true as const,
            plan: {
              planId: `tp_${plannerCalls}`,
              workItemId: workItemId ?? "",
              version: 1,
              status: "draft" as const,
              tasks: [
                {
                  taskId: `t${plannerCalls}_1`,
                  title: "T1",
                  goal: "g",
                  scope: "s",
                  dependsOn: [],
                  suggestedValidation: [],
                  status: "planned" as const,
                  runIds: [],
                  riskLevel: "low" as const,
                },
                {
                  taskId: `t${plannerCalls}_2`,
                  title: "T2",
                  goal: "g",
                  scope: "s",
                  dependsOn: [],
                  suggestedValidation: [],
                  status: "planned" as const,
                  runIds: [],
                  riskLevel: "low" as const,
                },
              ],
              dependencies: [],
              operatorEdits: [],
            },
          };
        },
      },
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });

    const first = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in first) throw new Error(first.error.message);
    expect(first.plan.version).toBe(1);

    const second = await svc.regeneratePlan(first.workItem.workItemId, "bob");
    if ("error" in second) throw new Error(second.error.message);
    expect(second.plan.version).toBe(2);
    expect(plannerCalls).toBe(2);
  });

  it("getReportMarkdown delegates to renderWorkItemReportMarkdown", async () => {
    const { store, svc, workItem, plan } = await makeAcceptedService();
    const report: WorkItemReport = {
      workItemId: workItem.workItemId,
      overallStatus: "complete",
      taskSummaries: [],
      validationSummary: "OK",
      riskSummary: "low",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: [],
      humanReviewChecklist: [],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
    await store.saveReport(report);
    const spy = vi
      .spyOn(ReportRenderer, "renderWorkItemReportMarkdown")
      .mockReturnValue("markdown body");

    const result = await svc.getReportMarkdown(workItem.workItemId);

    expect(result).toBe("markdown body");
    expect(spy).toHaveBeenCalledWith(workItem, plan, report, {
      audience: "markdown",
      evidenceBaseHref: `/api/work-items/${workItem.workItemId}/evidence/file`,
    });
    spy.mockRestore();
  });

  it("getReportMarkdown returns report_not_ready when no plan accepted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-svc-"));
    const store = createWorkItemStore({ rootDir: dir });
    const svc = createWorkItemService({
      store,
      planner: makePlanner(),
      fetchIssue: async () => issue,
      tick: async () => {},
      reconcileWorkItem: async () => {},
      emit: () => {},
      newId: () => "wi_test",
      now: () => "2026-05-17T00:00:00.000Z",
    });
    const planned = await svc.planFromIssue({ iid: 42, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);

    const result = await svc.getReportMarkdown(planned.workItem.workItemId);

    expect(result).toEqual({
      error: { code: "report_not_ready", message: "report not ready" },
    });
  });

  it("getEvidence exposes missing tasks", async () => {
    const { svc, workItem } = await makeAcceptedService();

    const result = await svc.getEvidence(workItem.workItemId);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.index).toEqual([]);
    expect(result.byTask).toEqual({ t1: [], t2: [] });
    expect(result.missing).toEqual([
      { taskId: "t1", reason: "no-link" },
      { taskId: "t2", reason: "no-link" },
    ]);
  });

  it("confirmTaskEvidence rejects unknown evidenceId", async () => {
    const reports = new Map([["run_t1", makeRunReport("run_t1")]]);
    const { store, svc, workItem } = await makeAcceptedService({ reports });
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_t1",
      attempt: 1,
      status: "completed",
      branch: "ai/t1",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    });

    const result = await svc.confirmTaskEvidence(
      workItem.workItemId,
      "t1",
      "ev_missing",
      { operator: "alice" },
    );

    expect(result).toEqual({
      error: { code: "not_found", message: "evidence not found" },
    });
  });

  it("confirmTaskEvidence rejects an evidenceId that belongs to another task", async () => {
    const reports = new Map([
      ["run_t1", makeRunReport("run_t1")],
      ["run_t2", makeRunReport("run_t2")],
    ]);
    const { store, svc, workItem } = await makeAcceptedService({ reports });
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_t1",
      attempt: 1,
      status: "completed",
      branch: "ai/t1",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    });
    await store.saveTaskRunLink({
      taskId: "t2",
      runId: "run_t2",
      attempt: 1,
      status: "completed",
      branch: "ai/t2",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    });
    const evidence = await svc.getEvidence(workItem.workItemId);
    if ("error" in evidence) throw new Error(evidence.error.message);
    const t2EvidenceId = evidence.byTask.t2[0]!.evidenceId;

    const result = await svc.confirmTaskEvidence(
      workItem.workItemId,
      "t1",
      t2EvidenceId,
      { operator: "alice" },
    );

    expect(result).toEqual({
      error: { code: "not_found", message: "evidence not found" },
    });
  });

  it("confirmTaskEvidence stamps confirmedBy + confirmedAt and emits work_item_evidence_confirmed", async () => {
    const reports = new Map([["run_t1", makeRunReport("run_t1")]]);
    const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
    const { store, svc, workItem } = await makeAcceptedService({
      reports,
      emit: (event) => events.push(event),
      now: () => "2026-05-17T03:00:00.000Z",
    });
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_t1",
      attempt: 1,
      status: "completed",
      branch: "ai/t1",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    });
    const evidence = await svc.getEvidence(workItem.workItemId);
    if ("error" in evidence) throw new Error(evidence.error.message);
    const evidenceId = evidence.byTask.t1[0]!.evidenceId;

    const result = await svc.confirmTaskEvidence(
      workItem.workItemId,
      "t1",
      evidenceId,
      { operator: "alice" },
    );

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.evidenceId).toBe(evidenceId);
    expect(result.confirmedAt).toBe("2026-05-17T03:00:00.000Z");
    expect(result.report.evidence.byTask.t1[0]).toMatchObject({
      evidenceId,
      confidence: "human-confirmed",
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T03:00:00.000Z",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "work_item_evidence_confirmed",
      detail: expect.objectContaining({
        workItemId: workItem.workItemId,
        taskId: "t1",
        evidenceId,
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T03:00:00.000Z",
      }),
    }));
  });

  it("confirmTaskEvidence triggers reconcileWorkItem so handoff note re-renders", async () => {
    const reports = new Map([["run_t1", makeRunReport("run_t1")]]);
    const reconciled: string[] = [];
    const { store, svc, workItem } = await makeAcceptedService({
      reports,
      reconcile: async (id) => {
        reconciled.push(id);
      },
    });
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_t1",
      attempt: 1,
      status: "completed",
      branch: "ai/t1",
      startedAt: "2026-05-17T00:01:00.000Z",
      completedAt: "2026-05-17T00:02:00.000Z",
    });
    const evidence = await svc.getEvidence(workItem.workItemId);
    if ("error" in evidence) throw new Error(evidence.error.message);
    const evidenceId = evidence.byTask.t1[0]!.evidenceId;

    const result = await svc.confirmTaskEvidence(
      workItem.workItemId,
      "t1",
      evidenceId,
      { operator: "alice" },
    );

    expect("error" in result).toBe(false);
    expect(reconciled).toEqual([workItem.workItemId]);
  });
});
