import { describe, expect, it, vi } from "vitest";

import type {
  IssuePilotInternalEvent,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";
import { createEventBus } from "@issuepilot/observability";

import { sweepReviewFeedbackOnce } from "../review-feedback.js";
import { createInitialReport } from "../../reports/lifecycle.js";
import { createRuntimeState, type RunEntry } from "../../runtime/state.js";

function makeIssue(iid: number, labels: string[]): RunEntry["issue"] {
  return {
    id: String(iid),
    iid,
    title: `Issue ${iid}`,
    url: `https://gitlab.example.com/g/p/-/issues/${iid}`,
    projectId: "g/p",
    labels,
  } as RunEntry["issue"];
}

function seedReviewRun(
  state: ReturnType<typeof createRuntimeState>,
  overrides: {
    runId?: string;
    branch?: string;
    iid?: number;
    labels?: string[];
    status?: string;
    archivedAt?: string;
    endedAt?: string;
    lastDiscussionCursor?: string;
  } = {},
): string {
  const runId = overrides.runId ?? "run-1";
  state.setRun(runId, {
    runId,
    status: overrides.status ?? "completed",
    attempt: 1,
    branch: overrides.branch ?? "ai/1-fix",
    workspacePath: "/tmp/run",
    startedAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:01.000Z",
    issue: makeIssue(overrides.iid ?? 1, overrides.labels ?? ["human-review"]),
    ...(overrides.archivedAt ? { archivedAt: overrides.archivedAt } : {}),
    ...(overrides.endedAt ? { endedAt: overrides.endedAt } : {}),
    ...(overrides.lastDiscussionCursor
      ? { lastDiscussionCursor: overrides.lastDiscussionCursor }
      : {}),
  });
  return runId;
}

type MrShape = {
  iid: number;
  webUrl: string;
  state: string;
  sourceBranch: string;
  title: string;
  description: string;
} | null;

type ListedNote = {
  id: number;
  body: string;
  author: string;
  createdAt?: string;
  updatedAt?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
};

function createDeps(
  opts: {
    mr?: MrShape;
    notes?: ListedNote[];
    throwListNotes?: Error;
    botAccountName?: string;
  } = {},
) {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  eventBus.subscribe((e) => events.push(e));
  const state = createRuntimeState();

  const gitlab = {
    findMergeRequestBySourceBranch: vi.fn(
      async (_: string): Promise<MrShape> =>
        opts.mr === undefined
          ? {
              iid: 42,
              webUrl: "https://gitlab.example.com/g/p/-/merge_requests/42",
              state: "opened",
              sourceBranch: "ai/1-fix",
              title: "Fix",
              description: "",
            }
          : opts.mr,
    ),
    listMergeRequestNotes: vi.fn(async (_: number): Promise<ListedNote[]> => {
      if (opts.throwListNotes) throw opts.throwListNotes;
      return opts.notes ?? [];
    }),
  };

  const workflow = {
    tracker: {
      handoffLabel: "human-review",
      ...(opts.botAccountName ? { botAccountName: opts.botAccountName } : {}),
    },
  };

  return {
    events,
    state,
    eventBus,
    gitlab,
    deps: {
      state,
      gitlab,
      workflow,
      eventBus,
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    },
  };
}

describe("sweepReviewFeedbackOnce", () => {
  it("emits started + summary_generated with an empty comments list when no MR is found", async () => {
    const ctx = createDeps({ mr: null });
    const runId = seedReviewRun(ctx.state);

    await sweepReviewFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).toHaveBeenCalledWith(
      "ai/1-fix",
    );
    expect(ctx.gitlab.listMergeRequestNotes).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual([
      "review_feedback_sweep_started",
      "review_feedback_summary_generated",
    ]);
    expect(ctx.events[1]).toMatchObject({
      runId,
      data: {
        reason: "no_mr",
        comments: [],
      },
    });

    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBeUndefined();
    expect(run?.["latestReviewFeedback"]).toBeUndefined();
  });

  it("filters IssuePilot marker notes + GitLab system notes and records the latest cursor", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 100,
          body: "Please add a test for the empty branch path.",
          author: "alice",
          createdAt: "2026-05-16T00:01:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
        },
        {
          id: 101,
          body: "<!-- issuepilot:handoff:run-1 -->\nIssuePilot handoff",
          author: "issuepilot-bot",
          createdAt: "2026-05-16T00:01:30.000Z",
          system: false,
        },
        {
          id: 102,
          body: "Removed label ai-running",
          author: "issuepilot-bot",
          createdAt: "2026-05-16T00:01:45.000Z",
          system: true,
        },
        {
          id: 103,
          body: "Looks good once the test is in.",
          author: "bob",
          createdAt: "2026-05-16T00:02:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
    });
    const runId = seedReviewRun(ctx.state);

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    expect(summaryEvent).toBeDefined();
    const data = summaryEvent?.data as {
      mrIid: number;
      cursor: string;
      comments: Array<{ author: string; noteId: number; url: string }>;
    };
    expect(data.mrIid).toBe(42);
    expect(data.cursor).toBe("2026-05-16T00:02:00.000Z");
    expect(data.comments.map((c) => c.noteId)).toEqual([100, 103]);
    expect(data.comments[0]?.author).toBe("alice");
    expect(data.comments[0]?.url).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/42#note_100",
    );

    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBe("2026-05-16T00:02:00.000Z");
    const stored = run?.["latestReviewFeedback"] as {
      cursor: string;
      comments: Array<{ noteId: number }>;
    };
    expect(stored.cursor).toBe("2026-05-16T00:02:00.000Z");
    expect(stored.comments).toHaveLength(2);
  });

  it("only returns notes newer than lastDiscussionCursor on subsequent sweeps", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 200,
          body: "Old comment already shipped to the agent.",
          author: "alice",
          createdAt: "2026-05-16T00:01:00.000Z",
          system: false,
        },
        {
          id: 201,
          body: "Brand new follow-up after the first attempt.",
          author: "alice",
          createdAt: "2026-05-16T00:05:00.000Z",
          system: false,
        },
      ],
    });
    const runId = seedReviewRun(ctx.state, {
      lastDiscussionCursor: "2026-05-16T00:01:00.000Z",
    });

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    const data = summaryEvent?.data as {
      cursor: string;
      comments: Array<{ noteId: number }>;
    };
    expect(data.comments.map((c) => c.noteId)).toEqual([201]);
    expect(data.cursor).toBe("2026-05-16T00:05:00.000Z");

    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBe("2026-05-16T00:05:00.000Z");
  });

  it("accumulates the full reviewer history on the run record across sweeps", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 410,
          body: "Earlier comment shipped on the first sweep.",
          author: "alice",
          createdAt: "2026-05-16T00:01:00.000Z",
          system: false,
        },
        {
          id: 411,
          body: "Brand new follow-up after the first attempt.",
          author: "bob",
          createdAt: "2026-05-16T00:05:00.000Z",
          system: false,
        },
      ],
    });
    // Simulate the state right after the first sweep: cursor parked at
    // the earlier note, but no latestReviewFeedback stored yet so we
    // can verify the second tick reconstructs the full history.
    const runId = seedReviewRun(ctx.state, {
      lastDiscussionCursor: "2026-05-16T00:01:00.000Z",
    });

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    const data = summaryEvent?.data as {
      cursor: string;
      comments: Array<{ noteId: number }>;
      commentCount: number;
    };
    // Event payload reports the *delta* — only the new note for this tick.
    expect(data.commentCount).toBe(1);
    expect(data.comments.map((c) => c.noteId)).toEqual([411]);

    // Run record persists the *full accumulated history* so the next
    // dispatch can replay every reviewer comment instead of losing the
    // older one that landed on a previous sweep.
    const run = ctx.state.getRun(runId);
    const stored = run?.["latestReviewFeedback"] as {
      cursor: string;
      comments: Array<{ noteId: number }>;
    };
    expect(stored.cursor).toBe("2026-05-16T00:05:00.000Z");
    expect(stored.comments.map((c) => c.noteId)).toEqual([410, 411]);
  });

  it("emits an empty summary without rewinding the cursor when nothing new has landed", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 300,
          body: "Old comment already shipped to the agent.",
          author: "alice",
          createdAt: "2026-05-16T00:01:00.000Z",
          system: false,
        },
      ],
    });
    const runId = seedReviewRun(ctx.state, {
      lastDiscussionCursor: "2026-05-16T00:01:00.000Z",
    });

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    const data = summaryEvent?.data as {
      cursor: string;
      comments: unknown[];
    };
    expect(data.comments).toEqual([]);
    expect(data.cursor).toBe("2026-05-16T00:01:00.000Z");

    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBe("2026-05-16T00:01:00.000Z");
    expect(run?.["latestReviewFeedback"]).toBeUndefined();
  });

  it("emits cursor=null on the first sweep when the MR exists but has no human comments yet", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 350,
          body: "<!-- issuepilot:handoff:run-1 -->\nIssuePilot handoff",
          author: "issuepilot-bot",
          createdAt: "2026-05-16T00:00:30.000Z",
          system: false,
        },
      ],
    });
    // No prior cursor — this is the very first sweep on the run.
    const runId = seedReviewRun(ctx.state);

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    const data = summaryEvent?.data as {
      reason: string;
      cursor: string | null;
      comments: unknown[];
    };
    expect(data.reason).toBe("no_new_comments");
    expect(data.comments).toEqual([]);
    // Event payload's `cursor` must match the persisted cursor: still
    // undefined / null because no human note advanced it.
    expect(data.cursor).toBeNull();

    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBeUndefined();
  });

  it("emits review_feedback_sweep_failed when listMergeRequestNotes throws", async () => {
    const ctx = createDeps({ throwListNotes: new Error("kaboom") });
    const runId = seedReviewRun(ctx.state);

    await sweepReviewFeedbackOnce(ctx.deps);

    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual([
      "review_feedback_sweep_started",
      "review_feedback_sweep_failed",
    ]);
    expect(ctx.events[1]).toMatchObject({
      runId,
      data: { reason: "lookup_failed", message: "kaboom" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["lastDiscussionCursor"]).toBeUndefined();
    expect(run?.["latestReviewFeedback"]).toBeUndefined();
  });

  it("filters notes authored by workflow.tracker.botAccountName even if they lack the marker comment", async () => {
    const ctx = createDeps({
      botAccountName: "issuepilot-bot",
      notes: [
        {
          id: 400,
          body: "Looks good!",
          author: "issuepilot-bot",
          createdAt: "2026-05-16T00:01:00.000Z",
          system: false,
        },
        {
          id: 401,
          body: "Please rename the helper.",
          author: "alice",
          createdAt: "2026-05-16T00:02:00.000Z",
          system: false,
        },
      ],
    });
    seedReviewRun(ctx.state);

    await sweepReviewFeedbackOnce(ctx.deps);

    const summaryEvent = ctx.events.find(
      (e) => e.type === "review_feedback_summary_generated",
    );
    const data = summaryEvent?.data as {
      comments: Array<{ noteId: number }>;
    };
    expect(data.comments.map((c) => c.noteId)).toEqual([401]);
  });

  it("ignores archived / ended runs and runs that have not reached human-review", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, {
      runId: "archived-1",
      archivedAt: "2026-05-15T00:00:00.000Z",
    });
    seedReviewRun(ctx.state, {
      runId: "ended-1",
      endedAt: "2026-05-15T00:01:00.000Z",
    });
    seedReviewRun(ctx.state, { runId: "running-1", status: "running" });

    await sweepReviewFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  // V2.5 review I3: after the review feedback sweep collects human
  // comments from GitLab, the run report must carry an updated
  // `reviewFeedback` block (unresolved count + comment metadata) and a
  // re-evaluated `mergeReadiness` so the dashboard's Review Packet
  // matches what the orchestrator sees.
  it("writes unresolved review comments onto the run report and re-evaluates merge readiness", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 1,
          body: "Please address null handling.",
          author: "alice",
          createdAt: "2026-05-16T10:00:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
        },
        {
          id: 2,
          body: "Looks good.",
          author: "bob",
          createdAt: "2026-05-16T10:05:00.000Z",
          system: false,
          resolvable: true,
          resolved: true,
        },
      ],
    });
    const runId = seedReviewRun(ctx.state);

    const reports = new Map<string, RunReportArtifact>();
    reports.set(
      runId,
      createInitialReport({
        runId,
        issue: {
          iid: 1,
          title: "Issue 1",
          url: "https://gitlab.example.com/g/p/-/issues/1",
          projectId: "g/p",
          labels: ["human-review"],
        },
        status: "completed",
        attempt: 1,
        branch: "ai/1-fix",
        workspacePath: "/tmp/run",
        startedAt: "2026-05-15T00:00:00.000Z",
      }),
    );

    await sweepReviewFeedbackOnce({
      ...ctx.deps,
      reports: {
        save: vi.fn(async (r: RunReportArtifact) => {
          reports.set(r.runId, r);
        }),
        get: vi.fn(async (id: string) => reports.get(id)),
        summary: () => undefined,
        allSummaries: () => [],
        all: async () => [...reports.values()],
        invalidReportCount: () => 0,
      },
    });

    const updated = reports.get(runId);
    expect(updated?.reviewFeedback?.unresolvedCount).toBe(1);
    expect(updated?.reviewFeedback?.comments).toHaveLength(2);
    expect(updated?.reviewFeedback?.comments[0]).toMatchObject({
      author: "alice",
      resolved: false,
    });
    expect(updated?.mergeReadiness.evaluatedAt).toBe(
      "2026-05-16T12:00:00.000Z",
    );
  });

  // V4.9: once the sweep produces a ReviewFeedbackSummary, the
  // ReviewFeedbackReviewWorkflowSlice receives the summary + the latest
  // reviewer agent reports and produces a draft ReviewReworkPlan that
  // is persisted onto RunReportArtifact.reviewReworkPlan.
  it("V4.9: invokes reviewWorkflow.generate() with the summary + reviewer reports and writes the plan onto the report", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 600,
          body: "Please add a test for the empty branch path.",
          author: "alice",
          createdAt: "2026-05-16T11:00:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
    });
    const runId = seedReviewRun(ctx.state);

    const reports = new Map<string, RunReportArtifact>();
    reports.set(
      runId,
      createInitialReport({
        runId,
        issue: {
          iid: 1,
          title: "Issue 1",
          url: "https://gitlab.example.com/g/p/-/issues/1",
          projectId: "g/p",
          labels: ["human-review"],
        },
        status: "completed",
        attempt: 1,
        branch: "ai/1-fix",
        workspacePath: "/tmp/run",
        startedAt: "2026-05-15T00:00:00.000Z",
      }),
    );

    const draftPlan = {
      planId: "plan-1",
      runId,
      issueIid: 1,
      projectId: "g/p",
      status: "draft" as const,
      generatedAt: "2026-05-16T12:00:00.000Z",
      items: [],
    };
    const generate = vi.fn(async () => draftPlan);
    const listLatestReviewerReports = vi.fn(async () => []);

    await sweepReviewFeedbackOnce({
      ...ctx.deps,
      reports: {
        save: vi.fn(async (r: RunReportArtifact) => {
          reports.set(r.runId, r);
        }),
        get: vi.fn(async (id: string) => reports.get(id)),
        summary: () => undefined,
        allSummaries: () => [],
        all: async () => [...reports.values()],
        invalidReportCount: () => 0,
      },
      reviewWorkflow: { generate, listLatestReviewerReports },
    });

    expect(listLatestReviewerReports).toHaveBeenCalledWith({ runId });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        issueIid: 1,
        projectId: "g/p",
        summary: expect.objectContaining({ mrIid: 42 }),
        reviewerReports: [],
      }),
    );

    const updated = reports.get(runId);
    expect(updated?.reviewReworkPlan?.planId).toBe("plan-1");

    const planEvent = ctx.events.find(
      (e) => e.type === "review_rework_plan_generated",
    );
    expect(planEvent).toBeDefined();
    expect(planEvent?.data).toMatchObject({
      planId: "plan-1",
      itemCount: 0,
    });
  });

  // V4.9: planner failures must not blow up the sweep; the existing
  // review_feedback_summary_generated event must still fire so the
  // dashboard reflects the comment delta, and the new
  // review_rework_plan_generation_failed event must record why.
  it("V4.9: planner failure emits review_rework_plan_generation_failed and keeps sweep observable", async () => {
    const ctx = createDeps({
      notes: [
        {
          id: 700,
          body: "Tighten the test.",
          author: "alice",
          createdAt: "2026-05-16T11:30:00.000Z",
          system: false,
          resolvable: true,
          resolved: false,
        },
      ],
    });
    seedReviewRun(ctx.state);

    const generate = vi.fn(async () => {
      throw new Error("classifier_panicked");
    });
    const listLatestReviewerReports = vi.fn(async () => []);

    await sweepReviewFeedbackOnce({
      ...ctx.deps,
      reviewWorkflow: { generate, listLatestReviewerReports },
    });

    const types = ctx.events.map((e) => e.type);
    expect(types).toContain("review_feedback_summary_generated");
    expect(types).toContain("review_rework_plan_generation_failed");
    const failedEvt = ctx.events.find(
      (e) => e.type === "review_rework_plan_generation_failed",
    );
    expect(failedEvt?.data).toMatchObject({
      reason: "planner_failed",
      message: "classifier_panicked",
    });
  });
});
