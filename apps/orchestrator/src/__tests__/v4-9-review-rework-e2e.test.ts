/**
 * V4.9 Intelligent Review Workflow — focused happy-path E2E.
 *
 * Spec §15 acceptance gate: GitLab review note → planner generates plan
 * → operator accepts via the workflow service → next dispatch injects
 * the accepted plan as a `## Review rework plan` block ahead of the
 * agent template body, replacing the legacy `## Review feedback` block.
 *
 * Why no daemon harness:
 *  - V4.9 ships its own service/store, but the daemon scaffolding for a
 *    full hermetic boot (GitLab fake, mirror, worktree) already exists
 *    for V4.5+/V4.7/V4.8 and would dwarf the contract under test. We
 *    instead hand-roll the smallest possible orchestration that wires
 *    `createReviewWorkflowService` + `dispatch` together, which is the
 *    same shape that `daemon.ts` produces in production.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, type IssuePilotInternalEvent } from "@issuepilot/observability";
import type { ReviewFeedbackSummary } from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dispatch, type DispatchDeps, type DispatchInput } from "../orchestrator/dispatch.js";
import { createReviewReworkPlanStore } from "../review-workflow/store.js";
import { createReviewWorkflowService } from "../review-workflow/service.js";
import { createRuntimeState } from "../runtime/state.js";

function baseInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    runId: "run-1",
    issue: {
      iid: 11,
      title: "Fix null handling in navbar",
      url: "https://gitlab.example.com/g/p/-/issues/11",
      projectId: "g/p",
    },
    remoteUrl: "git@gitlab.example.com:g/p.git",
    repoCacheRoot: "/tmp/cache",
    worktreeRoot: "/tmp/worktrees",
    branch: "ai/11-fix",
    baseBranch: "main",
    runningLabel: "ai-running",
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
    promptTemplate: "AGENT PROMPT BODY",
    ...overrides,
  };
}

function makeDeps(): DispatchDeps & {
  events: Array<{ type: string; [k: string]: unknown }>;
  renderPrompt: ReturnType<typeof vi.fn>;
  runAgent: ReturnType<typeof vi.fn>;
} {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  const state = createRuntimeState();
  state.setRun("run-1", {
    runId: "run-1",
    status: "claimed",
    attempt: 1,
    branch: "ai/11-fix",
  });
  const renderPrompt = vi.fn((opts: { template: string }) => opts.template);
  const runAgent = vi.fn(async () => ({
    status: "completed",
    summary: "Fixed it",
  }));
  return {
    state,
    maxAttempts: 2,
    retryBackoffMs: 100,
    ensureMirror: vi.fn(async () => ({ mirrorPath: "/tmp/mirror" })),
    ensureWorktree: vi.fn(async () => ({
      worktreePath: "/tmp/wt",
      created: true,
    })),
    runHook: vi.fn(async () => ({ stdout: "", stderr: "" })),
    renderPrompt,
    runAgent,
    reconcile: vi.fn(async () => {}),
    onEvent: vi.fn((e) => events.push(e)),
    onFailure: vi.fn(async () => {}),
    events,
  };
}

describe("V4.9 intelligent review workflow E2E", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "ipilot-v49-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("planner → accept → dispatch injects accepted plan block instead of legacy feedback", async () => {
    const store = createReviewReworkPlanStore({ rootDir: workdir });
    const bus = createEventBus<IssuePilotInternalEvent>();
    const audit: IssuePilotInternalEvent[] = [];
    bus.subscribe((event) => {
      audit.push(event);
    });
    const service = createReviewWorkflowService({ store, eventBus: bus, now: () => new Date("2026-05-21T10:00:00Z") });

    const summary: ReviewFeedbackSummary = {
      generatedAt: "2026-05-21T10:00:00Z",
      pageSize: 20,
      page: 1,
      totalCount: 1,
      comments: [
        {
          noteId: 4242,
          author: "@alice",
          createdAt: "2026-05-21T09:59:00Z",
          updatedAt: "2026-05-21T09:59:00Z",
          body: "Please add a null check before reading `payload.user.id` — it crashes on logout.",
          url: "https://gitlab.example.com/g/p/-/merge_requests/1#note_4242",
          status: "fresh",
        },
      ],
    };

    const draft = await service.generate({
      runId: "run-1",
      issueIid: 11,
      summary,
      reviewerReports: [],
    });
    expect(draft.status).toBe("draft");
    expect(draft.items.length).toBeGreaterThan(0);

    const accepted = await service.acceptPlan({
      planId: draft.planId,
      operator: "alice",
    });
    expect(accepted.status).toBe("accepted");
    expect(audit.some((e) => e.type === "review_rework_plan_accepted")).toBe(
      true,
    );

    const deps = makeDeps();
    deps.reviewWorkflow = {
      getLatestAccepted: vi.fn(async () => accepted),
    };
    deps.state.setRun("run-1", {
      runId: "run-1",
      status: "claimed",
      attempt: 1,
      branch: "ai/11-fix",
      latestReviewFeedback: summary,
    });

    await dispatch(baseInput(), deps);

    const lastAgentCall = deps.runAgent.mock.calls.at(-1)?.[0] as
      | { prompt: string }
      | undefined;
    expect(lastAgentCall).toBeDefined();
    expect(lastAgentCall!.prompt).toContain("## Review rework plan");
    expect(lastAgentCall!.prompt).not.toContain("## Review feedback");
    const injectedEvent = deps.events.find(
      (e) => e.type === "review_rework_plan_injected",
    );
    expect(injectedEvent).toBeDefined();
  });
});
