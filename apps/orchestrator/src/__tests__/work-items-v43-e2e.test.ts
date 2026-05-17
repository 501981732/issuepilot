import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReportEvidence,
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aggregateWorkItem,
  type AggregateDeps,
} from "../work-items/aggregate.js";
import {
  appendOversizedFollowUps,
  mergeReportEvidence,
} from "../work-items/evidence-merge.js";
import { scanRunEvidence } from "../work-items/evidence-scanner.js";
import { serveEvidenceFile } from "../work-items/evidence-file-server.js";
import {
  writeParentHandoff,
  workItemHandoffMarker,
  type ParentHandoffWorkflow,
} from "../work-items/handoff.js";
import { createWorkItemPlanner } from "../work-items/planner.js";
import { renderWorkItemReportMarkdown } from "../work-items/render-report.js";
import {
  createWorkItemService,
  decideWorkItemStatus,
} from "../work-items/service.js";
import { createWorkItemStore, type WorkItemStore } from "../work-items/store.js";

const HANDOFF_WORKFLOW: ParentHandoffWorkflow = {
  runningLabel: "ai-running",
  handoffLabel: "human-review",
  reworkLabel: "ai-rework",
  blockedLabel: "ai-blocked",
  readyLabel: "ai-ready",
};

const ISSUE = {
  iid: 42,
  title: "V4.3 review packet evidence",
  description:
    "Acceptance criteria:\n- Collect task evidence\n- Render parent review packet",
  url: "https://gitlab.example.com/group/project/-/issues/42",
  projectId: "group/project",
  labels: ["ai-ready"],
};

interface FakeGitlabState {
  notes: Array<{ id: number; iid: number; body: string }>;
  labelLog: Array<{ iid: number; add: string[]; remove: string[] }>;
  createIssue: ReturnType<typeof vi.fn>;
  nextNoteId: number;
}

function makeFakeGitlab() {
  const state: FakeGitlabState = {
    notes: [],
    labelLog: [],
    createIssue: vi.fn(),
    nextNoteId: 1,
  };
  const adapter = {
    findWorkpadNote: async (
      iid: number,
      marker: string,
    ): Promise<{ id: number; body: string } | null> => {
      const found = state.notes.find(
        (note) => note.iid === iid && note.body.includes(marker),
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
      const note = state.notes.find((item) => item.id === noteId && item.iid === iid);
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

function draftTasks(): Array<Partial<TaskNode> & { taskId: string; title: string }> {
  return [
    {
      taskId: "T1",
      title: "Collect browser evidence",
      goal: "Capture screenshots, traces, and command logs",
      scope: "apps/dashboard",
      dependsOn: [],
      suggestedValidation: ["pnpm test -- evidence"],
      riskLevel: "medium",
    },
    {
      taskId: "T2",
      title: "Collect API evidence",
      goal: "Capture validation and API test output",
      scope: "apps/orchestrator",
      dependsOn: [],
      suggestedValidation: ["pnpm test -- api"],
      riskLevel: "low",
    },
  ];
}

function fakeRunReport(input: {
  runId: string;
  taskId: "T1" | "T2";
  workspacePath?: string;
  evidence?: ReportEvidence[];
  followUps?: string[];
  risks?: Array<{ level: "low" | "medium" | "high"; text: string }>;
  checks?: RunReportArtifact["checks"];
  ci?: RunReportArtifact["ci"];
  status?: "completed" | "failed";
}): RunReportArtifact {
  const status = input.status ?? "completed";
  return {
    version: 1,
    runId: input.runId,
    issue: {
      projectId: ISSUE.projectId,
      iid: ISSUE.iid,
      title: ISSUE.title,
      url: ISSUE.url,
      labels: ["ai-running"],
    },
    run: {
      status,
      attempt: 1,
      branch: `ai/${input.runId}/v1`,
      workspacePath: input.workspacePath ?? "/tmp/issuepilot-v43-worktree",
      startedAt: "2026-05-17T00:00:00.000Z",
      endedAt: "2026-05-17T00:01:00.000Z",
      durations: { totalMs: 60_000 },
    },
    mergeRequest: {
      iid: input.taskId === "T1" ? 7101 : 7102,
      url: `https://gitlab.example.com/group/project/-/merge_requests/${
        input.taskId === "T1" ? 7101 : 7102
      }`,
      state: "merged",
    },
    handoff: {
      summary: `${input.taskId} done`,
      validation: [`${input.taskId} validation passed`],
      risks:
        input.risks ??
        (input.taskId === "T1"
          ? [{ level: "medium", text: "Browser evidence is AI interpreted" }]
          : []),
      followUps: input.followUps ?? [],
      nextAction: "Reviewer to inspect evidence",
    },
    diff: {
      summary: `${input.taskId} changed 1 file`,
      filesChanged: 1,
      additions: 10,
      deletions: 1,
      notableFiles: [`src/${input.taskId.toLowerCase()}.ts`],
    },
    checks:
      input.checks ??
      [
        {
          name: `${input.taskId} tests`,
          status: "passed",
          command: `pnpm test -- ${input.taskId}`,
          durationMs: 1200,
        },
      ],
    evidence: input.evidence ?? [],
    ...(input.ci ? { ci: input.ci } : {}),
    mergeReadiness: {
      mode: "dry-run",
      status: "not-ready",
      reasons: [],
      evaluatedAt: "2026-05-17T00:01:00.000Z",
    },
    notes: {},
  };
}

type EventRecord = {
  type: string;
  runId?: string;
  detail: Record<string, unknown>;
};

async function buildHarness(rootDir: string) {
  const store = createWorkItemStore({ rootDir });
  const reports = new Map<string, RunReportArtifact>();
  const events: EventRecord[] = [];
  const gitlab = makeFakeGitlab();
  let currentNow = "2026-05-17T00:00:00.000Z";

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

  const aggregateDeps = (): AggregateDeps => ({
    getRunReport: async (runId) => reports.get(runId),
    getEvidenceConfirmations: (workItemId) =>
      store.loadEvidenceConfirmations(workItemId),
    now: () => currentNow,
  });

  async function reconcileWorkItem(workItemId: string): Promise<void> {
    const workItem = await store.getWorkItem(workItemId);
    const plan = await store.getCurrentPlan(workItemId);
    if (!workItem || !plan) return;
    const links = await store.listAllTaskRunLinks(workItemId);
    const result = await aggregateWorkItem(
      workItem,
      plan,
      links,
      aggregateDeps(),
    );
    await store.saveReport(result.report);
    const previousStatus = workItem.status;
    const nextStatus = decideWorkItemStatus(result.report.overallStatus, plan, links);
    const updated: WorkItem = {
      ...workItem,
      status: nextStatus,
      summaryReportId: result.report.workItemId,
      updatedAt: currentNow,
    };
    await store.saveWorkItem(updated);
    await writeParentHandoff({
      workItem: updated,
      plan,
      report: result.report,
      previousStatus,
      workflow: HANDOFF_WORKFLOW,
      deps: { gitlab: gitlab.adapter, emit, now: () => currentNow },
    });
  }

  const service = createWorkItemService({
    store,
    planner: createWorkItemPlanner({
      callPlannerLlm: async () => ({ tasks: draftTasks() }),
    }),
    fetchIssue: async () => ISSUE,
    tick: async () => {},
    reconcileWorkItem,
    aggregateDeps: { getRunReport: async (runId) => reports.get(runId) },
    emit,
    now: () => currentNow,
    newId: () => "wi_v43",
  });

  async function planAndAccept() {
    const planned = await service.planFromIssue({ iid: ISSUE.iid, operator: "alice" });
    if ("error" in planned) throw new Error(planned.error.message);
    const accepted = await service.acceptPlan({
      workItemId: planned.workItem.workItemId,
      planId: planned.plan.planId,
      operator: "alice",
      edits: [],
    });
    if ("error" in accepted) throw new Error(accepted.error.message);
    return accepted;
  }

  async function saveLinks(
    workItemId: string,
    links: Array<{ taskId: "T1" | "T2"; runId: string }>,
  ): Promise<TaskRunLink[]> {
    const saved: TaskRunLink[] = [];
    for (const link of links) {
      const next: TaskRunLink = {
        taskId: link.taskId,
        runId: link.runId,
        attempt: 1,
        status: "completed",
        reportId: link.runId,
        branch: `ai/${link.runId}/v1`,
        mergeRequest: {
          iid: link.taskId === "T1" ? 7101 : 7102,
          url: `https://gitlab.example.com/group/project/-/merge_requests/${
            link.taskId === "T1" ? 7101 : 7102
          }`,
          state: "merged",
        },
        startedAt: "2026-05-17T00:00:00.000Z",
        completedAt: "2026-05-17T00:01:00.000Z",
      };
      await store.saveTaskRunLink(next);
      saved.push(next);
    }
    return saved;
  }

  return {
    store,
    reports,
    events,
    gitlab,
    service,
    aggregateDeps,
    planAndAccept,
    saveLinks,
    reconcileWorkItem,
    setNow: (next: string) => {
      currentNow = next;
    },
  };
}

async function completeTwoTaskWorkItem(rootDir: string) {
  const harness = await buildHarness(rootDir);
  const accepted = await harness.planAndAccept();
  const workItemId = accepted.workItem.workItemId;
  await harness.saveLinks(workItemId, [
    { taskId: "T1", runId: "run_T1" },
    { taskId: "T2", runId: "run_T2" },
  ]);

  await harness.reconcileWorkItem(workItemId);
  expect(harness.gitlab.state.labelLog.at(-1)?.add).toContain("ai-running");

  harness.reports.set(
    "run_T1",
    fakeRunReport({
      runId: "run_T1",
      taskId: "T1",
      evidence: [
        {
          kind: "screenshot",
          label: "Login screenshot",
          relPath: "screenshots/login.png",
          mediaType: "image/png",
        },
        {
          kind: "playwright",
          label: "Checkout trace",
          relPath: "playwright/checkout-trace.zip",
        },
        {
          kind: "command_output",
          label: "pnpm lint",
          relPath: "commands/lint.log",
          confidence: "system-derived",
        },
      ],
      ci: {
        status: "success",
        pipelineUrl: "https://gitlab.example.com/pipelines/1",
        checkedAt: "2026-05-17T00:02:00.000Z",
      },
    }),
  );
  harness.reports.set(
    "run_T2",
    fakeRunReport({
      runId: "run_T2",
      taskId: "T2",
      evidence: [
        {
          kind: "test_result",
          label: "API tests",
          relPath: "tests/api.json",
          confidence: "system-derived",
        },
      ],
    }),
  );

  await harness.reconcileWorkItem(workItemId);
  const report = await harness.store.getReport(workItemId);
  if (!report) throw new Error("expected report");
  return { harness, accepted, report };
}

function noteBodyWithoutMarker(body: string, workItemId: string): string {
  const marker = workItemHandoffMarker(workItemId);
  expect(body.startsWith(`${marker}\n`)).toBe(true);
  return body.slice(marker.length + 1);
}

describe("V4.3 Review Packet + Evidence end-to-end", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "issuepilot-v43-e2e-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("happy path aggregates rich evidence and renders one canonical review packet", async () => {
    const { harness, accepted, report } = await completeTwoTaskWorkItem(rootDir);
    const workItemId = accepted.workItem.workItemId;
    const workItem = (await harness.store.getWorkItem(workItemId)) as WorkItem;
    const plan = (await harness.store.getCurrentPlan(workItemId)) as TaskPlan;
    const links = await harness.store.listAllTaskRunLinks(workItemId);

    expect(links.map((link) => [link.taskId, link.runId])).toEqual([
      ["T1", "run_T1"],
      ["T2", "run_T2"],
    ]);
    expect(report.overallStatus).toBe("complete");
    expect(report.evidence.byTask.T1.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "diff",
        "screenshot",
        "playwright",
        "command_output",
        "test_result",
      ]),
    );
    expect(report.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        taskId: "T1",
        reason: "ai-risk-medium",
        confirmed: false,
      }),
    );
    expect(report.testSummary?.passed).toBeGreaterThanOrEqual(2);

    const lastLabelTransition = harness.gitlab.state.labelLog.at(-1);
    expect(lastLabelTransition?.add).toContain("human-review");
    const note = harness.gitlab.state.notes.at(-1);
    expect(note).toBeDefined();
    expect(noteBodyWithoutMarker(note!.body, workItemId)).toBe(
      renderWorkItemReportMarkdown(workItem, plan, report, {
        audience: "gitlab",
      }),
    );

    const markdown = await harness.service.getReportMarkdown(workItemId);
    expect(typeof markdown).toBe("string");
    expect(markdown).toBe(
      renderWorkItemReportMarkdown(workItem, plan, report, {
        audience: "markdown",
        evidenceBaseHref: `/api/work-items/${workItemId}/evidence/file`,
      }),
    );
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "work_item_report_rendered",
        detail: expect.objectContaining({
          workItemId,
          audience: "markdown",
        }),
      }),
    );
    expect(harness.gitlab.state.createIssue).not.toHaveBeenCalled();
  });

  it("confirm flow stamps evidence, rewrites the handoff note, and emits review events", async () => {
    const { harness, accepted } = await completeTwoTaskWorkItem(rootDir);
    const workItemId = accepted.workItem.workItemId;
    const before = await harness.service.getEvidence(workItemId);
    if ("error" in before) throw new Error(before.error.message);
    const screenshot = before.byTask.T1.find(
      (entry) => entry.kind === "screenshot",
    );
    expect(screenshot).toBeDefined();

    harness.setNow("2026-05-17T03:00:00.000Z");
    const confirmed = await harness.service.confirmTaskEvidence(
      workItemId,
      "T1",
      screenshot!.evidenceId,
      { operator: "alice" },
    );
    if ("error" in confirmed) throw new Error(confirmed.error.message);

    expect(confirmed.report.evidence.byTask.T1).toContainEqual(
      expect.objectContaining({
        evidenceId: screenshot!.evidenceId,
        confidence: "human-confirmed",
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T03:00:00.000Z",
      }),
    );
    const after = await harness.service.getEvidence(workItemId);
    if ("error" in after) throw new Error(after.error.message);
    expect(after.byTask.T1).toContainEqual(
      expect.objectContaining({
        evidenceId: screenshot!.evidenceId,
        confidence: "human-confirmed",
      }),
    );

    await harness.service.getReportMarkdown(workItemId);
    const note = harness.gitlab.state.notes.at(-1);
    expect(note?.body).toContain("Login screenshot (human-confirmed)");
    expect(note?.body).toContain("(human-confirmed)");
    expect(harness.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "work_item_evidence_confirmed",
        "work_item_report_rendered",
      ]),
    );
    expect(harness.gitlab.state.createIssue).not.toHaveBeenCalled();
  });

  it("keeps oversized and path-escaped evidence out of the index and exposes review follow-up", async () => {
    const harness = await buildHarness(rootDir);
    const accepted = await harness.planAndAccept();
    const workItemId = accepted.workItem.workItemId;
    await harness.saveLinks(workItemId, [{ taskId: "T1", runId: "run_big" }]);

    const taskWorktreePath = join(rootDir, "task-worktree");
    const evidenceRoot = join(
      taskWorktreePath,
      ".issuepilot",
      "evidence",
      "run_big",
    );
    await mkdir(join(evidenceRoot, "recordings"), { recursive: true });
    await mkdir(join(evidenceRoot, "commands"), { recursive: true });
    const oversizedRecording = join(evidenceRoot, "recordings", "too-large.webm");
    await writeFile(oversizedRecording, "");
    await truncate(oversizedRecording, 51 * 1024 * 1024);
    await writeFile(join(evidenceRoot, "commands", "ok.log"), "ok\n");
    await writeFile(
      join(evidenceRoot, "manifest.json"),
      JSON.stringify({
        entries: [
          {
            kind: "command_output",
            label: "ok command",
            relPath: "commands/ok.log",
          },
          {
            kind: "recording",
            label: "escape",
            relPath: "../../etc/passwd",
          },
        ],
      }),
    );

    const scan = await scanRunEvidence({ taskWorktreePath, runId: "run_big" });
    const evidence = mergeReportEvidence([], scan);
    const followUps = appendOversizedFollowUps([], scan.oversized, scan.rejected);
    harness.reports.set(
      "run_big",
      fakeRunReport({
        runId: "run_big",
        taskId: "T1",
        workspacePath: taskWorktreePath,
        evidence,
        followUps,
        risks: [],
      }),
    );

    await harness.reconcileWorkItem(workItemId);
    const report = await harness.store.getReport(workItemId);
    expect(scan.oversized).toEqual([
      { relPath: "recordings/too-large.webm", sizeBytes: 51 * 1024 * 1024 },
    ]);
    expect(scan.rejected).toEqual([
      { relPath: "../../etc/passwd", reason: "path-escape" },
    ]);
    expect(report?.evidence.index).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "ok command" }),
      ]),
    );
    expect(report?.evidence.index).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "too-large.webm" }),
        expect.objectContaining({ label: "escape" }),
      ]),
    );
    expect(report?.openQuestions.join("\n")).toContain(
      "evidence oversized: recordings/too-large.webm (51.0MB)",
    );
    expect(report?.openQuestions.join("\n")).toContain(
      "evidence rejected: ../../etc/passwd escapes evidence dir",
    );

    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run_big",
        relPath: "../../etc/passwd",
      }),
    ).resolves.toEqual({ ok: false, error: "forbidden" });
    await expect(
      serveEvidenceFile({
        taskWorktreePath,
        runId: "run_big",
        relPath: "recordings/too-large.webm",
      }),
    ).resolves.toEqual({ ok: false, error: "oversized" });
    expect(harness.gitlab.state.createIssue).not.toHaveBeenCalled();
  });

  it("marks reports incomplete when a terminal TaskRunLink has no run report", async () => {
    const harness = await buildHarness(rootDir);
    const accepted = await harness.planAndAccept();
    const workItemId = accepted.workItem.workItemId;
    await harness.saveLinks(workItemId, [
      { taskId: "T1", runId: "run_T1" },
      { taskId: "T2", runId: "run_T2_missing" },
    ]);
    await harness.reconcileWorkItem(workItemId);

    harness.reports.set(
      "run_T1",
      fakeRunReport({
        runId: "run_T1",
        taskId: "T1",
        evidence: [
          {
            kind: "screenshot",
            label: "T1 screenshot",
            relPath: "screenshots/t1.png",
          },
        ],
      }),
    );
    await harness.reconcileWorkItem(workItemId);

    const report = await harness.store.getReport(workItemId);
    const evidence = await harness.service.getEvidence(workItemId);
    if ("error" in evidence) throw new Error(evidence.error.message);
    expect(report?.overallStatus).toBe("incomplete");
    expect(evidence.missing).toContainEqual({
      taskId: "T2",
      reason: "no-run-report",
    });
    expect(report?.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        taskId: "T2",
        reason: "missing-evidence",
        confirmed: false,
      }),
    );
    expect(report?.evidence.byTask.T1.length).toBeGreaterThan(0);
    const links = await harness.store.listAllTaskRunLinks(workItemId);
    expect(links.map((link) => [link.taskId, link.runId])).toEqual([
      ["T1", "run_T1"],
      ["T2", "run_T2_missing"],
    ]);
    const note = harness.gitlab.state.notes.at(-1);
    expect(note?.body).not.toContain("human-review");
    expect(harness.gitlab.state.labelLog.flatMap((entry) => entry.add)).not.toContain(
      "human-review",
    );
    expect(harness.gitlab.state.createIssue).not.toHaveBeenCalled();
  });
});
