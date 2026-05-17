import { createInitialReport } from "../../reports/lifecycle.js";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { reconcile, type ReconcileInput } from "../reconcile.js";

function createMocks() {
  return {
    git: {
      hasNewCommits: vi.fn(async () => true),
      push: vi.fn(async () => {}),
    },
    gitlab: {
      findMergeRequest: vi.fn(async () => null),
      createMergeRequest: vi.fn(async () => ({
        iid: 100,
        webUrl: "https://gitlab.example.com/group/project/-/merge_requests/100",
      })),
      updateMergeRequest: vi.fn(async () => {}),
      findWorkpadNote: vi.fn(async () => null),
      createNote: vi.fn(async () => ({ id: 1 })),
      updateNote: vi.fn(async () => {}),
      transitionLabels: vi.fn(async () => {}),
    },
    events: [] as Array<{ type: string; [k: string]: unknown }>,
  };
}

function baseInput(mocks: ReturnType<typeof createMocks>): ReconcileInput {
  return {
    runId: "run-1",
    iid: 42,
    branch: "ai/42-fix-bug",
    baseBranch: "main",
    workspacePath: "/tmp/ws",
    attempt: 1,
    issueUrl: "https://gitlab.example.com/issues/42",
    issueIdentifier: "#42",
    runningLabel: "ai-running",
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
    git: mocks.git,
    gitlab: mocks.gitlab,
    onEvent: (e) => mocks.events.push(e),
  };
}

describe("reconcile", () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
  });

  it("pushes, creates MR, creates note, transitions labels on happy path", async () => {
    await reconcile(baseInput(mocks));

    expect(mocks.git.push).toHaveBeenCalledWith("/tmp/ws", "ai/42-fix-bug");
    expect(mocks.gitlab.createMergeRequest).toHaveBeenCalledTimes(1);
    expect(mocks.gitlab.createNote).toHaveBeenCalledTimes(1);
    expect(mocks.gitlab.transitionLabels).toHaveBeenCalledWith(42, {
      add: ["human-review"],
      remove: ["ai-running"],
    });

    const types = mocks.events.map((e) => e.type);
    expect(types).toContain("gitlab_push");
    expect(types).toContain("gitlab_mr_created");
    expect(types).toContain("gitlab_labels_transitioned");
  });

  it("creates a structured handoff note before moving to human-review", async () => {
    const input = baseInput(mocks);
    input.agentSummary = "Fixed the null check";
    input.agentValidation =
      "pnpm --filter @issuepilot/orchestrator test passed";
    input.agentRisks = "None identified";

    await reconcile(input);

    expect(mocks.gitlab.createNote).toHaveBeenCalledWith(
      42,
      expect.stringContaining("## IssuePilot handoff"),
    );
    const note = mocks.gitlab.createNote.mock.calls[0]![1];
    expect(note).toContain("<!-- issuepilot:run:run-1 -->");
    expect(note).toContain("- Status: human-review");
    expect(note).toContain("- Run: `run-1`");
    expect(note).toContain("- Attempt: 1");
    expect(note).toContain("- Branch: `ai/42-fix-bug`");
    expect(note).toContain(
      "- MR: !100 https://gitlab.example.com/group/project/-/merge_requests/100",
    );
    expect(note).toContain("### What changed\nFixed the null check");
    expect(note).toContain(
      "### Validation\npnpm --filter @issuepilot/orchestrator test passed",
    );
    expect(note).toContain("### Risks / follow-ups\nNone identified");
    expect(note).toContain("move this Issue to `ai-rework`");
  });

  it("fails without side effects when no new commits and no explicit no-code-change reason", async () => {
    mocks.git.hasNewCommits.mockResolvedValue(false);

    await expect(reconcile(baseInput(mocks))).rejects.toThrow(
      "Reconcile found no new commits",
    );

    expect(mocks.git.push).not.toHaveBeenCalled();
    expect(mocks.gitlab.findMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.createMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.updateMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.findWorkpadNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.updateNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.transitionLabels).not.toHaveBeenCalled();
    expect(
      mocks.events.find((e) => e.type === "reconcile_no_commits"),
    ).toBeDefined();
  });

  it("writes fallback note and transitions labels when no new commits have explicit no-code-change reason", async () => {
    mocks.git.hasNewCommits.mockResolvedValue(false);
    const input = baseInput(mocks);
    input.agentSummary =
      "Reviewed issue and confirmed config already matches request.";
    input.agentValidation = "Ran inspection; no files required updates.";
    input.agentRisks = "No runtime risk.";
    input.noCodeChangeReason =
      "Existing implementation already satisfies the issue.";

    await reconcile(input);

    expect(mocks.git.push).not.toHaveBeenCalled();
    expect(mocks.gitlab.findMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.createMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.updateMergeRequest).not.toHaveBeenCalled();
    const note = mocks.gitlab.createNote.mock.calls[0]![1];
    expect(note).toContain("## IssuePilot handoff");
    expect(note).toContain("- Branch: `ai/42-fix-bug`");
    expect(note).toContain("- MR: not created");
    expect(note).toContain(
      "### What changed\nReviewed issue and confirmed config already matches request.",
    );
    expect(note).toContain(
      "### Validation\nRan inspection; no files required updates.",
    );
    expect(note).toContain("move this Issue to `ai-rework`");
    expect(mocks.gitlab.transitionLabels).toHaveBeenCalledWith(42, {
      add: ["human-review"],
      remove: ["ai-running"],
    });

    const types = mocks.events.map((e) => e.type);
    expect(types).toEqual([
      "reconcile_no_commits",
      "gitlab_workpad_note_created",
      "gitlab_labels_transitioned",
    ]);
  });

  it("updates existing MR instead of creating", async () => {
    mocks.gitlab.findMergeRequest.mockResolvedValue({
      iid: 99,
      title: "old",
      description: "old",
    });
    await reconcile(baseInput(mocks));

    expect(mocks.gitlab.createMergeRequest).not.toHaveBeenCalled();
    expect(mocks.gitlab.updateMergeRequest).toHaveBeenCalledWith(99, {
      description: expect.stringContaining("Implementation summary"),
    });
    expect(
      mocks.events.find((e) => e.type === "gitlab_mr_updated"),
    ).toBeDefined();
  });

  it("updates existing workpad note instead of creating", async () => {
    mocks.gitlab.findWorkpadNote.mockResolvedValue({
      id: 7,
      body: "old note",
    });
    await reconcile(baseInput(mocks));

    expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
    expect(mocks.gitlab.updateNote).toHaveBeenCalledWith(
      42,
      7,
      expect.stringContaining("## IssuePilot handoff"),
    );
    expect(mocks.gitlab.updateNote).toHaveBeenCalledWith(
      42,
      7,
      expect.stringContaining("issuepilot:run:run-1"),
    );
  });

  it("includes agent summary in MR body", async () => {
    const input = baseInput(mocks);
    input.agentSummary = "Fixed the null check";
    input.agentValidation = "All tests pass";
    input.agentRisks = "None identified";
    await reconcile(input);

    const call = mocks.gitlab.createMergeRequest.mock.calls[0]![0];
    expect(call.description).toContain("Fixed the null check");
    expect(call.description).toContain("All tests pass");
    expect(call.description).toContain("None identified");
  });

  it("uses fallback text when agent provides no summary", async () => {
    await reconcile(baseInput(mocks));

    const call = mocks.gitlab.createMergeRequest.mock.calls[0]![0];
    expect(call.description).toContain("without a structured summary");
    expect(call.description).toContain("(no validation summary)");
    expect(call.description).toContain("(none reported)");
  });

  it("uses workflow-configured handoff labels", async () => {
    const input = baseInput(mocks);
    input.runningLabel = "custom-running";
    input.handoffLabel = "custom-review";

    await reconcile(input);

    expect(mocks.gitlab.transitionLabels).toHaveBeenCalledWith(42, {
      add: ["custom-review"],
      remove: ["custom-running"],
    });
  });

  it("emits events in correct order", async () => {
    await reconcile(baseInput(mocks));

    const types = mocks.events.map((e) => e.type);
    expect(types).toEqual([
      "gitlab_push",
      "gitlab_mr_created",
      "gitlab_labels_transitioned",
    ]);
  });

  // V2.5 review regression (C1/C2): when the daemon hands a freshly-seeded
  // RunReportArtifact to reconcile, the handoff note must still pick up
  // the agent summary / validation / risks / noCodeChangeReason from the
  // ReconcileInput. If we ever revert and pass the seed verbatim, the
  // GitLab note ends up rendering "not reported" placeholders.
  it("merges the agent summary and noCodeChangeReason into the seed report when rendering the handoff note", async () => {
    mocks.git.hasNewCommits.mockResolvedValue(false);
    const input = baseInput(mocks);
    const seedReport = createInitialReport({
      runId: "run-1",
      issue: {
        iid: 42,
        title: "Fix bug",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-bug",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });
    input.report = seedReport;
    input.agentSummary = "Existing config already matches the request.";
    input.agentValidation = "Inspected config; no edits required.";
    input.agentRisks = "No runtime risk.";
    input.noCodeChangeReason =
      "Existing implementation already satisfies the issue.";

    await reconcile(input);

    const note = mocks.gitlab.createNote.mock.calls[0]![1];
    expect(note).toContain("## IssuePilot handoff");
    expect(note).toContain(
      "### What changed\nExisting config already matches the request.",
    );
    expect(note).toContain(
      "### Validation\n- Inspected config; no edits required.",
    );
    expect(note).toContain("medium: No runtime risk.");
    expect(note).toContain("move this Issue to `ai-rework`");
    expect(note).not.toContain("not reported");
  });

  // V4.1 Workflow Spine: synthetic task runs share the dispatch / reconcile
  // path but MUST NOT write the parent Issue's workpad handoff note or
  // transition the parent Issue's workflow label. That responsibility moves
  // to the WorkItem aggregator (handoff.ts in V4.1 task 11). The
  // `parentIssueLabelMode: "suppressed"` flag is the explicit opt-out.
  describe("V4.1 parentIssueLabelMode", () => {
    it("defaults to 'active' so V2.x callers see no behaviour change", async () => {
      await reconcile(baseInput(mocks));
      expect(mocks.gitlab.transitionLabels).toHaveBeenCalledTimes(1);
      expect(mocks.gitlab.findWorkpadNote).toHaveBeenCalledTimes(1);
      expect(mocks.gitlab.createNote).toHaveBeenCalledTimes(1);
    });

    it("suppresses parent issue label transition AND workpad note when set to 'suppressed' (happy path with new commits)", async () => {
      const input = baseInput(mocks);
      input.parentIssueLabelMode = "suppressed";

      const result = await reconcile(input);

      // MR + push side-effects still happen — every task gets its own MR.
      expect(mocks.git.push).toHaveBeenCalledTimes(1);
      expect(mocks.gitlab.createMergeRequest).toHaveBeenCalledTimes(1);

      // Parent Issue label is NOT touched.
      expect(mocks.gitlab.transitionLabels).not.toHaveBeenCalled();

      // Parent Issue workpad note is NOT touched.
      expect(mocks.gitlab.findWorkpadNote).not.toHaveBeenCalled();
      expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
      expect(mocks.gitlab.updateNote).not.toHaveBeenCalled();

      // MR is still returned so the dispatch-task layer can record it on
      // the canonical TaskRunLink.
      expect(result.mergeRequest?.iid).toBe(100);
      expect(result.hadNewCommits).toBe(true);
      // `handoffNoteId` is intentionally absent when suppressed.
      expect(result.handoffNoteId).toBeUndefined();

      const eventTypes = mocks.events.map((e) => e.type);
      expect(eventTypes).toContain("gitlab_push");
      expect(eventTypes).toContain("gitlab_mr_created");
      expect(eventTypes).not.toContain("gitlab_labels_transitioned");
      expect(eventTypes).not.toContain("gitlab_workpad_note_created");
      expect(eventTypes).not.toContain("gitlab_workpad_note_updated");
    });

    it("suppresses note + label even when there are no new commits but a no-code-change reason is supplied", async () => {
      mocks.git.hasNewCommits.mockResolvedValue(false);
      const input = baseInput(mocks);
      input.parentIssueLabelMode = "suppressed";
      input.noCodeChangeReason =
        "Existing implementation already satisfies the task.";

      const result = await reconcile(input);

      expect(mocks.git.push).not.toHaveBeenCalled();
      expect(mocks.gitlab.createMergeRequest).not.toHaveBeenCalled();
      expect(mocks.gitlab.findWorkpadNote).not.toHaveBeenCalled();
      expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
      expect(mocks.gitlab.updateNote).not.toHaveBeenCalled();
      expect(mocks.gitlab.transitionLabels).not.toHaveBeenCalled();

      expect(result.hadNewCommits).toBe(false);

      const eventTypes = mocks.events.map((e) => e.type);
      // reconcile_no_commits still fires so observers see the run finished.
      expect(eventTypes).toContain("reconcile_no_commits");
      expect(eventTypes).not.toContain("gitlab_labels_transitioned");
      expect(eventTypes).not.toContain("gitlab_workpad_note_created");
    });

    it("still updates the MR description when a task run reuses an existing MR", async () => {
      mocks.gitlab.findMergeRequest.mockResolvedValue({
        iid: 99,
        title: "old",
        description: "old",
      });
      const input = baseInput(mocks);
      input.parentIssueLabelMode = "suppressed";
      await reconcile(input);

      expect(mocks.gitlab.createMergeRequest).not.toHaveBeenCalled();
      expect(mocks.gitlab.updateMergeRequest).toHaveBeenCalledWith(99, {
        description: expect.stringContaining("Implementation summary"),
      });
      // Even though we reused an MR, parent-issue side-effects stay
      // suppressed.
      expect(mocks.gitlab.transitionLabels).not.toHaveBeenCalled();
      expect(mocks.gitlab.createNote).not.toHaveBeenCalled();
    });
  });

  it("falls back to the noCodeChangeReason summary when agentSummary is empty and a report is provided", async () => {
    mocks.git.hasNewCommits.mockResolvedValue(false);
    const input = baseInput(mocks);
    const seedReport = createInitialReport({
      runId: "run-1",
      issue: {
        iid: 42,
        title: "Fix bug",
        url: "https://gitlab.example.com/issues/42",
        projectId: "group/project",
        labels: ["ai-running"],
      },
      status: "running",
      attempt: 1,
      branch: "ai/42-fix-bug",
      workspacePath: "/tmp/ws",
      startedAt: "2026-05-16T00:00:00.000Z",
    });
    input.report = seedReport;
    input.noCodeChangeReason =
      "Existing implementation already satisfies the issue.";

    await reconcile(input);

    const note = mocks.gitlab.createNote.mock.calls[0]![1];
    expect(note).toContain(
      "### What changed\nNo code changes: Existing implementation already satisfies the issue.",
    );
    expect(note).toContain(
      "### Validation\n- No validation command was reported for this no-code-change run.",
    );
  });
});
