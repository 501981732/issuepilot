import { describe, expect, it, vi } from "vitest";

import type {
  IssuePilotInternalEvent,
  PipelineStatus,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";
import { createEventBus } from "@issuepilot/observability";

import { scanCiFeedbackOnce } from "../ci-feedback.js";
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
  });
  return runId;
}

function createDeps(opts: {
  status?: PipelineStatus;
  throwLookup?: Error;
  mr?: {
    iid: number;
    webUrl: string;
    state: string;
    sourceBranch: string;
    title: string;
    description: string;
  } | null;
  pipelineWebUrl?: string;
  ci?: {
    enabled?: boolean;
    onFailure?: "ai-rework" | "human-review";
    waitForPipeline?: boolean;
  };
}) {
  const events: IssuePilotInternalEvent[] = [];
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  eventBus.subscribe((e) => events.push(e));
  const state = createRuntimeState();

  const gitlab = {
    findMergeRequestBySourceBranch: vi.fn(async (_: string) =>
      opts.mr === undefined
        ? {
            iid: 17,
            webUrl: "https://gitlab.example.com/g/p/-/merge_requests/17",
            state: "opened",
            sourceBranch: "ai/1-fix",
            title: "Fix",
            description: "",
          }
        : opts.mr,
    ),
    getPipelineStatus: vi.fn(async (_: string) => {
      if (opts.throwLookup) throw opts.throwLookup;
      return opts.status ?? "success";
    }),
    transitionLabels: vi.fn(async () => ({ labels: ["ai-rework"] })),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    // Default: no prior marker note exists. Individual tests override
    // this to simulate the "second scan with marker already on disk"
    // dedup scenario.
    findWorkpadNote: vi.fn(
      async (_: number, __: string) =>
        null as { id: number; body: string } | null,
    ),
  };

  const workflow = {
    tracker: {
      handoffLabel: "human-review",
      reworkLabel: "ai-rework",
    },
    ci: {
      enabled: opts.ci?.enabled ?? true,
      onFailure: opts.ci?.onFailure ?? "ai-rework",
      waitForPipeline: opts.ci?.waitForPipeline ?? true,
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
      now: () => new Date("2026-05-15T12:00:00.000Z"),
    },
  };
}

describe("scanCiFeedbackOnce", () => {
  it("emits ci_status_observed (no_mr) when the run has no associated MR", async () => {
    const ctx = createDeps({ mr: null });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).toHaveBeenCalledWith(
      "ai/1-fix",
    );
    expect(ctx.gitlab.getPipelineStatus).not.toHaveBeenCalled();
    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      type: "ci_status_observed",
      data: { reason: "no_mr" },
    });
  });

  it("emits ci_status_observed (success) and keeps labels unchanged", async () => {
    const ctx = createDeps({ status: "success" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "success", action: "noop" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBe("success");
    expect(run?.["latestCiCheckedAt"]).toBe("2026-05-15T12:00:00.000Z");
  });

  it("emits ci_status_rework_triggered, transitions labels, and writes a marker note on failure", async () => {
    const ctx = createDeps({ status: "failed" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).toHaveBeenCalledWith(1, {
      add: ["ai-rework"],
      remove: ["human-review"],
      requireCurrent: ["human-review"],
    });
    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledWith(
      1,
      expect.stringContaining(`<!-- issuepilot:ci-feedback:${runId} -->`),
    );
    expect(ctx.gitlab.createIssueNote.mock.calls[0]?.[1]).toContain(
      "MR: !17 https://gitlab.example.com/g/p/-/merge_requests/17",
    );
    const types = ctx.events.map((e) => e.type);
    expect(types).toEqual(["ci_status_rework_triggered"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "failed", action: "rework" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBe("failed");
  });

  it("emits ci_status_observed (failed/no_action) when on_failure is human-review", async () => {
    const ctx = createDeps({
      status: "failed",
      ci: { onFailure: "human-review" },
    });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "failed", action: "noop" },
    });
  });

  it("does nothing besides ci_status_observed when pipeline is running/pending/unknown", async () => {
    // `unknown` is treated as a wait state too: in practice it means
    // either the pipeline has not been created yet (race with the MR
    // landing) or the upstream returned a status string we have not
    // mapped yet. Either way, prompting a reviewer immediately would
    // spam the issue thread and — worse — would burn the per-run
    // marker note slot, which then blocks the rework path from
    // writing its "failing CI pipeline" note on the next tick. See the
    // ci-feedback e2e "failed pipeline transitions to ai-rework"
    // regression for the actual failure mode.
    for (const status of ["running", "pending", "unknown"] as const) {
      const ctx = createDeps({ status });
      const runId = seedReviewRun(ctx.state);

      await scanCiFeedbackOnce(ctx.deps);

      expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
      expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
      expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
      expect(ctx.events[0]).toMatchObject({
        runId,
        data: { status, action: "wait" },
      });
    }
  });

  it("lets the rework note land even if an earlier 'unknown' tick already wrote a marker note (regression)", async () => {
    // Reproduces the e2e race: the scanner's first tick observed an
    // empty pipelines table (pipeline still being created), so without
    // the unknown→wait fix it would have written a manual-prompt note
    // under `<!-- issuepilot:ci-feedback:<runId> -->`. The C1 dedup
    // then prevented the next tick — which sees `failed` — from
    // writing the "failing CI pipeline" rework note. Pinning the
    // wait-only behaviour for `unknown` lets the rework note survive.
    const ctx = createDeps({ status: "unknown" });
    seedReviewRun(ctx.state);
    await scanCiFeedbackOnce(ctx.deps);
    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();

    // Second tick: pipeline now resolves to failed.
    ctx.gitlab.getPipelineStatus.mockResolvedValueOnce("failed");
    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);
    expect(ctx.gitlab.createIssueNote.mock.calls[0]?.[1]).toContain(
      "failing CI pipeline",
    );
  });

  it("emits ci_status_observed (canceled) and prompts manual review without changing labels", async () => {
    const ctx = createDeps({ status: "canceled" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledWith(
      1,
      expect.stringContaining(`<!-- issuepilot:ci-feedback:${runId} -->`),
    );
    expect(ctx.gitlab.createIssueNote.mock.calls[0]?.[1]).toContain(
      "MR: !17 https://gitlab.example.com/g/p/-/merge_requests/17",
    );
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "canceled", action: "manual" },
    });
  });

  it("does not re-create the manual note when a marker is already on the issue (canceled status)", async () => {
    const ctx = createDeps({ status: "canceled" });
    const runId = seedReviewRun(ctx.state);
    ctx.gitlab.findWorkpadNote.mockImplementationOnce(async () => ({
      id: 9001,
      body: `<!-- issuepilot:ci-feedback:${runId} -->\nprior note`,
    }));

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
    // Audit event still fires so the dashboard / event log can show
    // that we observed the pipeline again — just no duplicate note.
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "canceled", action: "manual" },
    });
  });

  it("does not re-create the rework note across consecutive failed scans", async () => {
    const ctx = createDeps({ status: "failed" });
    seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);
    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);

    // Second scan: simulate GitLab now returning the marker note we
    // wrote in the first scan. transitionLabels would still be a no-op
    // (requireCurrent fails because labels already flipped), but we
    // also explicitly skip the createIssueNote call.
    ctx.gitlab.transitionLabels.mockRejectedValueOnce(
      new Error("conflict: label not in required state"),
    );
    ctx.gitlab.findWorkpadNote.mockImplementationOnce(async () => ({
      id: 9002,
      body: `<!-- issuepilot:ci-feedback:run-1 -->\nprior note`,
    }));

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);
  });

  it("emits ci_status_lookup_failed when getPipelineStatus throws", async () => {
    const ctx = createDeps({ throwLookup: new Error("kaboom") });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_lookup_failed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { reason: "lookup_failed", message: "kaboom" },
    });
    const run = ctx.state.getRun(runId);
    expect(run?.["latestCiStatus"]).toBeUndefined();
  });

  it("skips disabled (ci.enabled=false) without touching GitLab", async () => {
    const ctx = createDeps({ ci: { enabled: false } });
    seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("ignores runs that have not reached the completed (human-review) state", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, { status: "running" });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("ignores archived runs", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, {
      archivedAt: "2026-05-14T00:00:00.000Z",
    });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("ignores runs whose human-review reconciliation already set endedAt", async () => {
    const ctx = createDeps({});
    seedReviewRun(ctx.state, {
      endedAt: "2026-05-14T00:00:00.000Z",
    });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.findMergeRequestBySourceBranch).not.toHaveBeenCalled();
    expect(ctx.events).toEqual([]);
  });

  it("emits ci_status_observed (failed/stale) and does not write a note when the issue is no longer in human-review", async () => {
    const ctx = createDeps({ status: "failed" });
    ctx.gitlab.transitionLabels.mockRejectedValueOnce(
      new Error("conflict: label not in required state"),
    );
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.transitionLabels).toHaveBeenCalledTimes(1);
    expect(ctx.gitlab.createIssueNote).not.toHaveBeenCalled();
    expect(ctx.events.map((e) => e.type)).toEqual(["ci_status_observed"]);
    expect(ctx.events[0]).toMatchObject({
      runId,
      data: { status: "failed", action: "stale" },
    });
  });

  it("does not re-trigger rework after the run leaves the review-stage candidate set", async () => {
    const ctx = createDeps({ status: "failed" });
    const runId = seedReviewRun(ctx.state);

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);

    // After a fail → rework, V1 dispatch re-claims the same issue under
    // a *new* runId (the old run record stays at `status: "completed"`
    // but the daemon stamps `endedAt` on it via the human-review
    // reconciler observing the MR landing or getting recycled). The
    // scanner therefore skips the old run on the next tick.
    const existing = ctx.state.getRun(runId);
    if (!existing) throw new Error("expected run to exist");
    ctx.state.setRun(runId, {
      ...existing,
      endedAt: "2026-05-15T12:30:00.000Z",
    });

    await scanCiFeedbackOnce(ctx.deps);

    expect(ctx.gitlab.createIssueNote).toHaveBeenCalledTimes(1);
    expect(ctx.gitlab.transitionLabels).toHaveBeenCalledTimes(1);
  });

  // V2.5 review I3: the CI sweep must write the latest pipeline status
  // back into the report artifact and re-run the merge-readiness
  // evaluator so the dashboard's Reports page and the Review Packet on
  // the run detail screen agree with the GitLab note.
  it("writes the latest CI status onto the run report and re-evaluates merge readiness", async () => {
    const ctx = createDeps({ status: "success" });
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

    await scanCiFeedbackOnce({
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
    expect(updated?.ci).toMatchObject({
      status: "success",
      checkedAt: "2026-05-15T12:00:00.000Z",
    });
    expect(updated?.mergeReadiness.evaluatedAt).toBe(
      "2026-05-15T12:00:00.000Z",
    );
  });
});
