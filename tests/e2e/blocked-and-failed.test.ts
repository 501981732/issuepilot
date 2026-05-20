import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

import { pickFreePort } from "./helpers/net.js";
import { waitForEvent } from "./helpers/sse.js";
import {
  createE2EWorkspace,
  E2E_TOKEN,
  type E2EWorkspace,
} from "./helpers/workspace.js";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

const FAST_POLL_MS = 250;

function withFastPoll(deps: LoopDeps): LoopHandle {
  return realStartLoop({
    ...deps,
    pollIntervalMs: FAST_POLL_MS,
    loadConfig: () => ({ pollIntervalMs: FAST_POLL_MS }),
  });
}

describe("failure and blocked classifications E2E", () => {
  let ws: E2EWorkspace | undefined;
  let daemon: DaemonHandle | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env["GITLAB_TOKEN"];
    process.env["GITLAB_TOKEN"] = E2E_TOKEN;
  });

  afterEach(async () => {
    try {
      await daemon?.stop();
    } catch {
      // swallow
    }
    daemon = undefined;
    await ws?.cleanup();
    ws = undefined;
    if (originalToken === undefined) {
      delete process.env["GITLAB_TOKEN"];
    } else {
      process.env["GITLAB_TOKEN"] = originalToken;
    }
  });

  it("labels the issue ai-failed and writes a failure note when codex reports turn/failed", async () => {
    const ISSUE_IID = 11;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.turn-failed.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Turn failure scenario",
          description: "Forces the agent into a failure outcome.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        const failureNote = (s.notes.get(ISSUE_IID) ?? []).find((n) =>
          n.body.includes("## IssuePilot run failed"),
        );
        return !!issue && issue.labels.includes("ai-failed") && !!failureNote;
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone after waitFor");
    expect(issue.labels).toContain("ai-failed");
    expect(issue.labels).not.toContain("ai-running");

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const failureNote = notes.find((n) =>
      n.body.includes("## IssuePilot run failed"),
    );
    expect(failureNote).toBeDefined();
    expect(failureNote?.body).toContain("- Status: ai-failed");
    expect(failureNote?.body).toContain("- Run: `");
    expect(failureNote?.body).toContain("- Attempt: 1");
    expect(failureNote?.body).toContain("- Branch: `");
    expect(failureNote?.body).toContain("### Reason");
    expect(failureNote?.body).toContain("### Next action");
    expect(failureNote?.body).toContain("move this Issue back to `ai-ready`");
  }, 30_000);

  it("escalates the issue into ai-blocked when GitLab returns 403 on claim", async () => {
    const ISSUE_IID = 12;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Permission denied scenario",
          description:
            "Claim PUT fails once — orchestrator should push to ai-blocked.",
          labels: ["ai-ready"],
        },
      ],
    });

    // Fail just the FIRST PUT against this issue (the claim transition).
    // The follow-up best-effort PUT into ai-blocked is allowed to succeed,
    // which matches the spec §21.12 expectation that blocked issues land
    // in `ai-blocked` rather than getting silently re-polled.
    ws.gitlabServer.injectFault({
      pathPrefix: `/api/v4/projects/${encodeURIComponent(ws.projectId)}/issues/${ISSUE_IID}`,
      method: "PUT",
      status: 403,
      body: { message: "403 Forbidden" },
      consume: 1,
    });

    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Subscribe to the SSE stream BEFORE the claim tick can run (the
    // orchestrator polls every 100ms via withFastPoll). The SSE channel
    // only delivers events that arrive AFTER the subscribe call, and the
    // synthetic claim runId is an internal detail not exposed via the
    // persisted /api/events endpoint, so we have to race the subscribe
    // ahead of the first claim attempt.
    const claimFailedPromise = waitForEvent(
      daemon.url,
      (e) => {
        const ev = e as { type: string; iid?: number };
        return ev.type === "claim_failed" && ev.iid === ISSUE_IID;
      },
      { timeoutMs: 10_000 },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-blocked");
      },
      { timeoutMs: 10_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone");
    expect(issue.labels).toContain("ai-blocked");
    expect(issue.labels).not.toContain("ai-ready");
    expect(issue.labels).not.toContain("ai-running");
    expect(issue.labels).not.toContain("human-review");

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const blockedNote = notes.find((n) =>
      n.body.includes("## IssuePilot run blocked"),
    );
    expect(blockedNote).toBeDefined();
    expect(blockedNote?.body).toContain("- Status: ai-blocked");
    expect(blockedNote?.body).toContain("### Reason");
    expect(blockedNote?.body).toContain("move this Issue back to `ai-ready`");

    // The orchestrator did not retry the failed claim; no run record was
    // ever created because the claim never acquired a slot.
    const runs = daemon.state.listRuns();
    for (const r of runs) {
      expect(r.attempt).toBeLessThanOrEqual(1);
    }

    const claimFailed = (await claimFailedPromise) as {
      type: string;
      iid?: number;
      kind?: string;
      labelTransitioned?: boolean;
    };
    expect(claimFailed.kind).toBe("blocked");
    expect(claimFailed.labelTransitioned).toBe(true);
  }, 30_000);

  it("emits claim_failed without changing labels when permissions are permanently denied", async () => {
    const ISSUE_IID = 15;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Permanent permission denial",
          description: "Every PUT against the issue is rejected.",
          labels: ["ai-ready"],
        },
      ],
    });

    // Both the claim PUT AND the follow-up ai-blocked PUT will fail. We
    // still want a `claim_failed` event so operators see the attempt.
    ws.gitlabServer.injectFault({
      pathPrefix: `/api/v4/projects/${encodeURIComponent(ws.projectId)}/issues/${ISSUE_IID}`,
      method: "PUT",
      status: 403,
      body: { message: "403 Forbidden" },
      consume: 99,
    });

    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await waitForEvent(daemon.url, (e) => {
      const ev = e as { type: string; iid?: number };
      return ev.type === "claim_failed" && ev.iid === ISSUE_IID;
    });

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone");
    expect(issue.labels).toContain("ai-ready");
    expect(issue.labels).not.toContain("ai-blocked");
    expect(issue.labels).not.toContain("ai-running");

    const runs = daemon.state.listRuns();
    for (const r of runs) {
      expect(r.attempt).toBeLessThanOrEqual(1);
    }
  }, 30_000);

  it("retries once on a retryable failure and finally lands on ai-failed", async () => {
    // Spec §13: a `retryable` outcome (turn/timeout) must drive one retry
    // when `agent.max_attempts > 1`, then surface as `ai-failed` once the
    // retry budget is exhausted. We use turn/timeout (not turn/failed)
    // because spec §13 classifies hard `failed` outcomes as non-retryable;
    // only timeout / transient / rate_limit go through `scheduleRetry`.
    const ISSUE_IID = 14;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.retry-timeout.json",
      maxAttempts: 2,
      issues: [
        {
          iid: ISSUE_IID,
          title: "Retry-then-fail scenario",
          description: "Forces a retry and a final failure.",
          labels: ["ai-ready"],
        },
      ],
    });

    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-failed");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    if (!issue) throw new Error("issue gone after waitFor");
    expect(issue.labels).toContain("ai-failed");
    expect(issue.labels).not.toContain("ai-running");

    // The dispatch loop scheduled exactly one retry (attempt=1 → retrying
    // → dispatch attempt=2 → dispatch_failed). After the second timeout,
    // the run record's attempt counter should sit at 2 with status=failed.
    const runs = daemon.state.listRuns();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.attempt).toBe(2);
    expect(run.status).toBe("failed");

    // The event store must contain at least one `retry_scheduled` event
    // for that run, proving the retry path actually fired.
    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(run.runId)}&limit=200`,
    );
    expect(eventsRes.ok).toBe(true);
    const events = (await eventsRes.json()) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "retry_scheduled").length).toBe(1);
    expect(types.filter((t) => t === "dispatch_failed").length).toBe(1);
  }, 30_000);

  it("auto-approves codex approval requests under approval_policy=never", async () => {
    const ISSUE_IID = 13;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.approval.json",
      issues: [
        {
          iid: ISSUE_IID,
          title: "Approval scenario",
          description: "Codex requests approval; orchestrator auto-approves.",
          labels: ["ai-ready"],
        },
      ],
    });

    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Wait until the run completes and reconcile flips the label.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 15_000, intervalMs: 50 },
    );

    // Find the run and assert events include approval_auto_approved.
    const runs = daemon.state.listRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const firstRun = runs[0];
    if (!firstRun) throw new Error("expected at least one run");

    const eventsRes = await fetch(
      `${daemon.url}/api/events?runId=${encodeURIComponent(firstRun.runId)}&limit=200`,
    );
    expect(eventsRes.ok).toBe(true);
    const eventsBody = (await eventsRes.json()) as Array<{
      type: string;
      data?: { decision?: string };
    }>;
    const types = new Set(eventsBody.map((e) => e.type));
    expect(types.has("codex_approval_auto_approved")).toBe(true);

    // The fake-codex script declared `expectResponse: { kind: "result" }`
    // for the approval request. The script engine now enforces that
    // contract: any error response would have aborted runScript and the
    // run would never have reached `human-review`.
  }, 60_000);
});
