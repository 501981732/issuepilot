import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  startDaemon,
  startLoop as realStartLoop,
  type LoopDeps,
  type LoopHandle,
} from "@issuepilot/orchestrator";

import { pickFreePort } from "./helpers/net.js";
import {
  createE2EWorkspace,
  E2E_TOKEN,
  type E2EWorkspace,
} from "./helpers/workspace.js";

import type {
  RawMergeRequestRow,
  RawPipelineRow,
} from "./fakes/gitlab/data.js";

type DaemonHandle = Awaited<ReturnType<typeof startDaemon>>;

const FAST_POLL_MS = 250;

function withFastPoll(deps: LoopDeps): LoopHandle {
  return realStartLoop({
    ...deps,
    pollIntervalMs: FAST_POLL_MS,
    loadConfig: () => ({ pollIntervalMs: FAST_POLL_MS }),
  });
}

interface RunSnapshot {
  runId: string;
  status: string;
  branch: string;
  attempt: number;
  latestCiStatus?: string;
}

async function fetchRuns(daemonUrl: string): Promise<RunSnapshot[]> {
  const res = await fetch(`${daemonUrl}/api/runs`);
  if (!res.ok) {
    throw new Error(`GET /api/runs failed: HTTP ${res.status}`);
  }
  return (await res.json()) as RunSnapshot[];
}

async function waitForRun(
  daemonUrl: string,
  predicate: (run: RunSnapshot) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<RunSnapshot> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const interval = opts.intervalMs ?? 100;
  let lastSeen: RunSnapshot[] = [];
  while (Date.now() < deadline) {
    try {
      lastSeen = await fetchRuns(daemonUrl);
      const match = lastSeen.find(predicate);
      if (match) return match;
    } catch {
      // ignore transient fetch errors while the daemon boots
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForRun timed out; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

async function waitForEvent(
  daemonUrl: string,
  runId: string,
  predicate: (event: { type: string; data?: unknown }) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ type: string; data?: unknown }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  const interval = opts.intervalMs ?? 100;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${daemonUrl}/api/events?runId=${encodeURIComponent(runId)}&limit=500`,
      );
      if (res.ok) {
        const events = (await res.json()) as Array<{
          type: string;
          data?: unknown;
        }>;
        const match = events.find(predicate);
        if (match) return match;
      }
    } catch {
      // ignore transient errors
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForEvent: no matching event for run ${runId} within ${opts.timeoutMs ?? 15_000}ms`,
  );
}

function seedPipeline(
  ws: E2EWorkspace,
  branch: string,
  status: RawPipelineRow["status"],
): void {
  const now = new Date().toISOString();
  ws.gitlabState.pipelines.push({
    id: ws.gitlabState.nextId(),
    project_id: ws.gitlabState.projectNumericId,
    ref: branch,
    sha: "deadbeef",
    status,
    created_at: now,
    updated_at: now,
  });
}

function ensureOpenMr(ws: E2EWorkspace, branch: string): RawMergeRequestRow {
  const existing = ws.gitlabState.mergeRequests.get(branch);
  if (existing) return existing;
  const now = new Date().toISOString();
  const iid = ws.gitlabState.nextId();
  const mr: RawMergeRequestRow = {
    id: ws.gitlabState.nextId(),
    iid,
    project_id: ws.gitlabState.projectNumericId,
    title: "CI feedback test",
    description: "",
    source_branch: branch,
    target_branch: "main",
    state: "opened",
    web_url: `${ws.gitlabState.origin}/${ws.gitlabState.projectId}/-/merge_requests/${iid}`,
    created_at: now,
    updated_at: now,
  };
  ws.gitlabState.mergeRequests.set(branch, mr);
  ws.gitlabState.mergeRequestNotes.set(mr.iid, []);
  return mr;
}

describe("ci feedback E2E", () => {
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

  it("success pipeline keeps labels and records latestCiStatus=success", async () => {
    const ISSUE_IID = 81;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI success",
          description: "Issue should stay parked at human-review.",
          labels: ["ai-ready"],
        },
      ],
    });
    const port = await pickFreePort();
    daemon = await startDaemon(
      { workflowPath: ws.workflowPath, port },
      { startLoop: withFastPoll },
    );

    // Wait until the issue is parked at `human-review` so we know the run
    // record has a stable branch we can pipeline-seed against.
    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "success");

    await waitForEvent(daemon.url, handoffRun.runId, (e) => {
      const data = (e.data ?? {}) as { status?: string; action?: string };
      return e.type === "ci_status_observed" && data.status === "success";
    });

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");

    const refreshed = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === handoffRun.runId,
    );
    expect(refreshed?.latestCiStatus).toBe("success");
  }, 35_000);

  it("failed pipeline transitions to ai-rework and writes a marker note", async () => {
    const ISSUE_IID = 82;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI failed → ai-rework",
          description: "Pipeline failure should recycle the issue.",
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
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "failed");

    await ws.gitlabServer.waitFor(
      (s) => {
        const issue = s.issues.get(ISSUE_IID);
        return !!issue && issue.labels.includes("ai-rework");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("ai-rework");
    expect(issue?.labels).not.toContain("human-review");

    await ws.gitlabServer.waitFor(
      (s) =>
        (s.notes.get(ISSUE_IID) ?? []).some((n) =>
          n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
        ),
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const ciFeedbackNote = notes.find((n) =>
      n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
    );
    expect(ciFeedbackNote, "expected a ci-feedback marker note").toBeDefined();
    expect(ciFeedbackNote?.body).toContain("failing CI pipeline");

    await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => e.type === "ci_status_rework_triggered",
    );
  }, 35_000);

  it("failed pipeline keeps labels when ci.on_failure is human-review (scenario D)", async () => {
    const ISSUE_IID = 84;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      ciOnFailure: "human-review",
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI failed → manual review",
          description:
            "Pipeline failed but ci.on_failure=human-review, so labels must stay put.",
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
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "failed");

    // The scanner observes the failure but, under
    // `ci.on_failure: human-review`, must NOT touch labels or write a
    // marker note. We assert on the `noop` audit event instead.
    const observed = await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => {
        const data = (e.data ?? {}) as { status?: string; action?: string };
        return (
          e.type === "ci_status_observed" &&
          data.status === "failed" &&
          data.action === "noop"
        );
      },
    );
    const observedData = (observed.data ?? {}) as { mrUrl?: string };
    expect(observedData.mrUrl).toMatch(/\/-\/merge_requests\//);

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const ciFeedbackNote = notes.find((n) =>
      n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
    );
    expect(ciFeedbackNote, "should not write a marker note on noop").toBeUndefined();

    const refreshed = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === handoffRun.runId,
    );
    expect(refreshed?.latestCiStatus).toBe("failed");
  }, 35_000);

  it("canceled pipeline writes a single manual note across multiple poll cycles (scenario E, C1 dedup)", async () => {
    const ISSUE_IID = 85;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI canceled → manual",
          description: "Pipeline canceled; scanner should prompt once, not spam.",
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
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);
    seedPipeline(ws, handoffRun.branch, "canceled");

    // Wait for the first manual prompt to land …
    await ws.gitlabServer.waitFor(
      (s) => {
        const notes = s.notes.get(ISSUE_IID) ?? [];
        return notes.some((n) =>
          n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
        );
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );

    // … then let the scanner cycle ~6 more times at FAST_POLL_MS=250ms.
    // Without C1's dedup this would create 6 additional notes.
    await new Promise((r) => setTimeout(r, FAST_POLL_MS * 6 + 200));

    const notes = ws.gitlabState.notes.get(ISSUE_IID) ?? [];
    const markerNotes = notes.filter((n) =>
      n.body.includes(`<!-- issuepilot:ci-feedback:${handoffRun.runId} -->`),
    );
    expect(
      markerNotes,
      `expected exactly one marker note, got ${markerNotes.length}: ${markerNotes
        .map((n) => n.body.slice(0, 120))
        .join("\n---\n")}`,
    ).toHaveLength(1);
    expect(markerNotes[0]?.body).toContain("MR: !");

    // Labels must remain at `human-review` (no auto-action on canceled).
    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");

    const refreshed = (await fetchRuns(daemon.url)).find(
      (r) => r.runId === handoffRun.runId,
    );
    expect(refreshed?.latestCiStatus).toBe("canceled");
  }, 35_000);

  it("pipeline lookup failure emits ci_status_lookup_failed and keeps labels", async () => {
    const ISSUE_IID = 83;
    ws = await createE2EWorkspace({
      codexScriptFixture: "codex.happy.json",
      ciEnabled: true,
      issues: [
        {
          iid: ISSUE_IID,
          title: "CI lookup down",
          description: "Pipeline endpoint 500s; labels must stay put.",
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
        return !!issue && issue.labels.includes("human-review");
      },
      { timeoutMs: 20_000, intervalMs: 50 },
    );
    const handoffRun = await waitForRun(
      daemon.url,
      (r) => r.status === "completed",
    );

    ensureOpenMr(ws, handoffRun.branch);

    // Inject 500 faults on `/pipelines` only. The scanner first calls
    // findMergeRequestBySourceBranch (different prefix) and then
    // getPipelineStatus — only the second throws, which is exactly the
    // path that maps to `ci_status_lookup_failed`. `consume: 50` lets the
    // fault survive multiple poll cycles, since the loop runs at 250ms.
    ws.gitlabServer.injectFault({
      pathPrefix: `/api/v4/projects/${encodeURIComponent(ws.projectId)}/pipelines`,
      method: "GET",
      status: 500,
      body: { message: "pipelines unavailable" },
      consume: 50,
    });

    // Tickle the loop a few times: faults only fire when the scanner
    // reaches getPipelineStatus, and findMergeRequestBySourceBranch
    // shares the same path prefix so the fault could intercept that too.
    // Either way we expect a `ci_status_lookup_failed` audit event.
    await waitForEvent(
      daemon.url,
      handoffRun.runId,
      (e) => e.type === "ci_status_lookup_failed",
      { timeoutMs: 20_000 },
    );

    const issue = ws.gitlabState.issues.get(ISSUE_IID);
    expect(issue?.labels).toContain("human-review");
    expect(issue?.labels).not.toContain("ai-rework");
  }, 35_000);
});
