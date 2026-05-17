import { describe, expect, it } from "vitest";

import type {
  TaskPlan,
  WorkItem,
  WorkItemReport,
  WorkItemStatus,
} from "@issuepilot/shared-contracts";

import {
  decideParentLabelTransition,
  renderWorkItemHandoffNoteBody,
  workItemHandoffMarker,
  writeParentHandoff,
  type ParentHandoffDeps,
  type ParentHandoffWorkflow,
} from "../handoff.js";

const workflow: ParentHandoffWorkflow = {
  runningLabel: "ai-running",
  handoffLabel: "human-review",
  reworkLabel: "ai-rework",
  blockedLabel: "ai-blocked",
  readyLabel: "ai-ready",
};

const baseWorkItem: WorkItem = {
  workItemId: "wi_01",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "Big issue",
  },
  title: "Big issue",
  goal: "Ship feature X.",
  acceptanceCriteria: ["AC1", "AC2"],
  status: "running",
  taskIds: ["t1", "t2"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

const basePlan: TaskPlan = {
  planId: "tp_01",
  workItemId: "wi_01",
  version: 1,
  tasks: [
    {
      taskId: "t1",
      title: "Add API",
      goal: "POST /x",
      scope: "src/api/x.ts",
      dependsOn: [],
      suggestedValidation: ["pnpm test"],
      status: "completed",
      runIds: ["run_a"],
      riskLevel: "low",
    },
    {
      taskId: "t2",
      title: "Add UI",
      goal: "Render result",
      scope: "src/ui/x.tsx",
      dependsOn: ["t1"],
      suggestedValidation: ["pnpm test"],
      status: "completed",
      runIds: ["run_b"],
      riskLevel: "low",
    },
  ],
  dependencies: [{ from: "t1", to: "t2" }],
  operatorEdits: [],
  status: "accepted",
  acceptedAt: "2026-05-17T00:01:00.000Z",
};

const completeReport: WorkItemReport = {
  workItemId: "wi_01",
  overallStatus: "complete",
  taskSummaries: [
    {
      taskId: "t1",
      title: "Add API",
      taskStatus: "completed",
      runId: "run_a",
      diffSummary: "Added /x route",
      validation: ["pnpm test passed"],
      risks: [],
      followUps: [],
      mergeRequestUrl: "https://gl/-/mrs/100",
      ciStatus: "success",
      nextAction: "Reviewer to inspect MR.",
    },
    {
      taskId: "t2",
      title: "Add UI",
      taskStatus: "completed",
      runId: "run_b",
      diffSummary: "Added UI",
      validation: ["pnpm test passed"],
      risks: [],
      followUps: [],
      mergeRequestUrl: "https://gl/-/mrs/101",
      ciStatus: "success",
      nextAction: "Reviewer to inspect MR.",
    },
  ],
  validationSummary: "All tests green",
  riskSummary: "No risks reported.",
  evidence: { index: [], byTask: {} },
  openQuestions: [],
  recommendedNextActions: [
    "All synthetic task runs completed. Move the parent Issue to human-review and ask the reviewer to inspect each MR.",
  ],
  humanReviewChecklist: [],
  generatedAt: "2026-05-17T00:10:00.000Z",
};

describe("decideParentLabelTransition", () => {
  it("planning → planning is a no-op", () => {
    const r = decideParentLabelTransition("planning", "planning", workflow);
    expect(r).toEqual({ add: [], remove: [] });
  });

  it("planning → ready does not move labels (operator owns ai-ready)", () => {
    const r = decideParentLabelTransition("planning", "ready", workflow);
    expect(r).toEqual({ add: [], remove: [] });
  });

  it("ready → running adds ai-running and removes ai-ready", () => {
    const r = decideParentLabelTransition("ready", "running", workflow);
    expect(r.add).toEqual(["ai-running"]);
    expect(r.remove).toEqual(["ai-ready"]);
  });

  it("running → completed adds human-review and removes ai-running", () => {
    const r = decideParentLabelTransition("running", "completed", workflow);
    expect(r.add).toEqual(["human-review"]);
    expect(r.remove).toEqual(["ai-running"]);
  });

  it("running → partial does NOT transition labels (operator decides)", () => {
    const r = decideParentLabelTransition("running", "partial", workflow);
    expect(r).toEqual({ add: [], remove: [] });
  });

  it("running → blocked does NOT transition labels (operator decides)", () => {
    const r = decideParentLabelTransition("running", "blocked", workflow);
    expect(r).toEqual({ add: [], remove: [] });
  });

  // V4.2 review C2 — the §12.3 rework loop needs the parent label to
  // actually move back from `human-review` when an operator marks a
  // completed task for rework, and forward again once the rework
  // round-trips through retry + re-completion.
  it("completed → partial swaps human-review for ai-rework (markNeedsRework path)", () => {
    const r = decideParentLabelTransition("completed", "partial", workflow);
    expect(r.add).toEqual(["ai-rework"]);
    expect(r.remove).toEqual(["human-review"]);
  });

  it("partial → running swaps ai-rework for ai-running (retry path)", () => {
    const r = decideParentLabelTransition("partial", "running", workflow);
    expect(r.add).toEqual(["ai-running"]);
    expect(r.remove).toEqual(["ai-rework"]);
  });

  it("partial → completed swaps ai-rework for human-review (rework loop closed)", () => {
    const r = decideParentLabelTransition("partial", "completed", workflow);
    expect(r.add).toEqual(["human-review"]);
    expect(r.remove).toEqual(["ai-rework"]);
  });

  it("completed → running swaps human-review for ai-running (operator retried without rework)", () => {
    const r = decideParentLabelTransition("completed", "running", workflow);
    expect(r.add).toEqual(["ai-running"]);
    expect(r.remove).toEqual(["human-review"]);
  });
});

describe("renderWorkItemHandoffNoteBody", () => {
  it("starts with the canonical work-item marker", () => {
    const body = renderWorkItemHandoffNoteBody(
      baseWorkItem,
      basePlan,
      completeReport,
    );
    expect(body.startsWith(workItemHandoffMarker(baseWorkItem.workItemId))).toBe(
      true,
    );
  });

  it("includes each task title and merge request link", () => {
    const body = renderWorkItemHandoffNoteBody(
      baseWorkItem,
      basePlan,
      completeReport,
    );
    expect(body).toContain("Add API");
    expect(body).toContain("Add UI");
    expect(body).toContain("https://gl/-/mrs/100");
    expect(body).toContain("https://gl/-/mrs/101");
  });

  it("renders recommendedNextActions section", () => {
    const body = renderWorkItemHandoffNoteBody(
      baseWorkItem,
      basePlan,
      completeReport,
    );
    expect(body).toContain("Next action");
    expect(body).toContain("ask the reviewer");
  });

  it("does NOT mention 'ready_to_merge' under any condition", () => {
    const body = renderWorkItemHandoffNoteBody(
      baseWorkItem,
      basePlan,
      completeReport,
    );
    expect(body.toLowerCase()).not.toContain("ready_to_merge");
    expect(body.toLowerCase()).not.toContain("ready to merge");
  });
});

interface FakeGitlabCalls {
  found: boolean;
  noteId?: number;
}

function makeFakeDeps(opts: FakeGitlabCalls = { found: false }): {
  deps: ParentHandoffDeps;
  calls: string[];
  emitted: Array<{ type: string; detail: Record<string, unknown> }>;
} {
  const calls: string[] = [];
  const emitted: Array<{ type: string; detail: Record<string, unknown> }> = [];
  const deps: ParentHandoffDeps = {
    gitlab: {
      findWorkpadNote: async (_iid, _marker) => {
        calls.push("find-note");
        return opts.found ? { id: opts.noteId ?? 5, body: "old" } : null;
      },
      createNote: async (_iid, _body) => {
        calls.push("create-note");
        return { id: 7 };
      },
      updateNote: async (_iid, _noteId, _body) => {
        calls.push("update-note");
      },
      transitionLabels: async (_iid, opts) => {
        calls.push(
          `transition-labels add=${opts.add.join(",")} remove=${opts.remove.join(",")}`,
        );
      },
    },
    emit: (e) => emitted.push({ type: e.type, detail: e.detail }),
    now: () => "2026-05-17T00:11:00.000Z",
  };
  return { deps, calls, emitted };
}

describe("writeParentHandoff", () => {
  it("creates note when marker not found, applies running→completed transition", async () => {
    const { deps, calls, emitted } = makeFakeDeps({ found: false });
    await writeParentHandoff({
      workItem: { ...baseWorkItem, status: "completed" },
      plan: basePlan,
      report: completeReport,
      previousStatus: "running",
      workflow,
      deps,
    });
    expect(calls).toContain("find-note");
    expect(calls).toContain("create-note");
    expect(
      calls.some((c) => c.startsWith("transition-labels add=human-review")),
    ).toBe(true);
    expect(emitted.map((e) => e.type)).toContain("work_item_handoff_written");
  });

  it("updates note when marker is found", async () => {
    const { deps, calls } = makeFakeDeps({ found: true, noteId: 99 });
    await writeParentHandoff({
      workItem: { ...baseWorkItem, status: "completed" },
      plan: basePlan,
      report: completeReport,
      previousStatus: "running",
      workflow,
      deps,
    });
    expect(calls).toContain("update-note");
    expect(calls).not.toContain("create-note");
  });

  it("ready → running transitions labels but does NOT write a note", async () => {
    const { deps, calls } = makeFakeDeps();
    await writeParentHandoff({
      workItem: { ...baseWorkItem, status: "running" },
      plan: basePlan,
      report: undefined,
      previousStatus: "ready",
      workflow,
      deps,
    });
    expect(
      calls.some((c) => c.startsWith("transition-labels add=ai-running")),
    ).toBe(true);
    expect(calls).not.toContain("find-note");
    expect(calls).not.toContain("create-note");
    expect(calls).not.toContain("update-note");
  });

  it("running → partial writes note but does not change labels", async () => {
    const partial: WorkItemReport = {
      ...completeReport,
      overallStatus: "partial",
      recommendedNextActions: ["Retry failed task t1."],
    };
    const { deps, calls, emitted } = makeFakeDeps({ found: false });
    await writeParentHandoff({
      workItem: { ...baseWorkItem, status: "partial" },
      plan: basePlan,
      report: partial,
      previousStatus: "running",
      workflow,
      deps,
    });
    expect(calls).toContain("create-note");
    expect(calls.some((c) => c.startsWith("transition-labels"))).toBe(false);
    expect(emitted.map((e) => e.type)).toContain("work_item_handoff_written");
  });

  it("does nothing when previousStatus equals currentStatus and no report", async () => {
    const { deps, calls, emitted } = makeFakeDeps();
    await writeParentHandoff({
      workItem: { ...baseWorkItem, status: "running" as WorkItemStatus },
      plan: basePlan,
      report: undefined,
      previousStatus: "running",
      workflow,
      deps,
    });
    expect(calls).toEqual([]);
    expect(emitted).toEqual([]);
  });
});
