import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEventType } from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  hostnameFromBaseUrl,
  splitCommand,
  syncHumanReviewFinalLabels,
} from "../daemon.js";
import { startDaemon } from "../daemon.js";
import type { LoopDeps } from "../orchestrator/loop.js";
import type { ServerDeps } from "../server/index.js";
import { createRuntimeState } from "../runtime/state.js";

function createWorkflow(root: string): WorkflowConfig {
  return {
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      activeLabels: ["ai-ready", "ai-rework"],
      runningLabel: "ai-running",
      handoffLabel: "human-review",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
      reworkLabel: "ai-rework",
      mergingLabel: "ai-merging",
    },
    workspace: {
      root,
      strategy: "worktree",
      repoCacheRoot: path.join(root, "repo-cache"),
    },
    git: {
      repoUrl: "git@gitlab.example.com:group/project.git",
      baseBranch: "main",
      branchPrefix: "issuepilot/",
    },
    agent: {
      runner: "codex-app-server",
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxAttempts: 1,
      retryBackoffMs: 1000,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnTimeoutMs: 1000,
      turnSandboxPolicy: { type: "workspaceWrite" },
    },
    hooks: {},
    ci: {
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    },
    retention: {
      successfulRunDays: 7,
      failedRunDays: 30,
      maxWorkspaceGb: 50,
      cleanupIntervalMs: 3_600_000,
    },
    pollIntervalMs: 10_000,
    promptTemplate: "Fix issue {{issue.iid}}",
    source: {
      path: path.join(root, "workflow.md"),
      sha256: "test",
      loadedAt: "2026-05-14T00:00:00.000Z",
    },
  };
}

function createGitLabForHumanReviewScanPollution(): GitLabAdapter {
  let listCount = 0;
  return {
    listCandidateIssues: vi.fn(async () => {
      listCount += 1;
      if (listCount === 1) {
        return [
          {
            id: "7",
            iid: 7,
            title: "Needs review",
            url: "https://gitlab.example.com/group/project/-/issues/7",
            projectId: "group/project",
            labels: ["human-review"],
          },
        ];
      }
      return [];
    }),
    getIssue: vi.fn(async (iid: number) => ({
      id: String(iid),
      iid,
      title: "Needs review",
      url: `https://gitlab.example.com/group/project/-/issues/${iid}`,
      projectId: "group/project",
      labels: ["human-review"],
      description: "",
      state: "opened",
    })),
    findLatestIssuePilotWorkpadNote: vi.fn(async () => null),
    findMergeRequestBySourceBranch: vi.fn(async () => null),
    listMergeRequestsBySourceBranch: vi.fn(async () => []),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    closeIssue: vi.fn(async () => ({
      labels: [],
      state: "closed",
    })),
    transitionLabels: vi.fn(async () => ({
      labels: ["ai-rework"],
    })),
    updateIssueNote: vi.fn(async () => {}),
    findWorkpadNote: vi.fn(async () => null),
    createMergeRequest: vi.fn(async () => ({
      id: 1,
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
    })),
    updateMergeRequest: vi.fn(async () => {}),
    getMergeRequest: vi.fn(async () => ({
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
      state: "opened",
    })),
    listMergeRequestNotes: vi.fn(async () => []),
    getPipelineStatus: vi.fn(async () => "unknown"),
  };
}

function createGitLabForClosedUnmergedReview(): GitLabAdapter {
  return {
    listCandidateIssues: vi.fn(async () => [
      {
        id: "7",
        iid: 7,
        title: "Needs review",
        url: "https://gitlab.example.com/group/project/-/issues/7",
        projectId: "group/project",
        labels: ["human-review"],
      },
    ]),
    getIssue: vi.fn(async (iid: number) => ({
      id: String(iid),
      iid,
      title: "Needs review",
      url: `https://gitlab.example.com/group/project/-/issues/${iid}`,
      projectId: "group/project",
      labels: ["human-review"],
      description: "",
      state: "opened",
    })),
    findLatestIssuePilotWorkpadNote: vi.fn(async () => ({
      id: 101,
      body: [
        "<!-- issuepilot:run:run-7 -->",
        "- Branch: `issuepilot/7-needs-review`",
      ].join("\n"),
    })),
    findMergeRequestBySourceBranch: vi.fn(async () => null),
    listMergeRequestsBySourceBranch: vi.fn(async () => [
      {
        iid: 3,
        webUrl: "https://gitlab.example.com/group/project/-/merge_requests/3",
        state: "closed",
        sourceBranch: "issuepilot/7-needs-review",
        updatedAt: "2026-05-14T00:00:00.000Z",
      },
    ]),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    closeIssue: vi.fn(async () => ({
      labels: [],
      state: "closed",
    })),
    transitionLabels: vi.fn(async () => ({
      labels: ["needs-agent-rework"],
    })),
    updateIssueNote: vi.fn(async () => {}),
    findWorkpadNote: vi.fn(async () => null),
    createMergeRequest: vi.fn(async () => ({
      id: 1,
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
    })),
    updateMergeRequest: vi.fn(async () => {}),
    getMergeRequest: vi.fn(async () => ({
      iid: 1,
      webUrl: "https://gitlab.example.com/group/project/-/merge_requests/1",
      state: "opened",
    })),
    listMergeRequestNotes: vi.fn(async () => []),
    getPipelineStatus: vi.fn(async () => "unknown"),
  };
}

function createFakeServer(): FastifyInstance {
  return {
    close: vi.fn(async () => {}),
  } as unknown as FastifyInstance;
}

describe("hostnameFromBaseUrl", () => {
  it("returns the bare hostname for an https URL", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });

  it("strips a trailing path", () => {
    expect(hostnameFromBaseUrl("https://gitlab.example.com/")).toBe(
      "gitlab.example.com",
    );
    expect(hostnameFromBaseUrl("http://gitlab.local:8080/api/v4")).toBe(
      "gitlab.local",
    );
  });

  it("returns the input verbatim when it is not a URL", () => {
    expect(hostnameFromBaseUrl("gitlab.example.com")).toBe(
      "gitlab.example.com",
    );
  });
});

describe("splitCommand", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("codex app-server")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside double quotes", () => {
    expect(
      splitCommand('"/Users/User Name/.local/bin/codex" app-server'),
    ).toEqual({
      command: "/Users/User Name/.local/bin/codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside single quotes", () => {
    expect(
      splitCommand("'/var/data with space/codex' app-server --foo bar"),
    ).toEqual({
      command: "/var/data with space/codex",
      args: ["app-server", "--foo", "bar"],
    });
  });

  it("supports mixed quoted + unquoted arguments", () => {
    expect(
      splitCommand("tsx '/tmp/My Folder/main.ts' /tmp/script.json"),
    ).toEqual({
      command: "tsx",
      args: ["/tmp/My Folder/main.ts", "/tmp/script.json"],
    });
  });

  it("collapses adjacent whitespace", () => {
    expect(splitCommand("  codex   app-server   ")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("rejects an empty string", () => {
    expect(() => splitCommand("   ")).toThrow(/must not be empty/);
  });

  it("rejects an unbalanced quote", () => {
    expect(() => splitCommand('codex "app-server')).toThrow(/unbalanced/);
  });
});

describe("syncHumanReviewFinalLabels", () => {
  function seedRun(
    state: ReturnType<typeof createRuntimeState>,
    overrides: { runId?: string; iid?: number; endedAt?: string } = {},
  ): string {
    const runId = overrides.runId ?? "run-a";
    state.setRun(runId, {
      runId,
      status: "completed",
      attempt: 1,
      branch: "ai/1-fix",
      workspacePath: "/tmp/run",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
      issue: {
        id: String(overrides.iid ?? 1),
        iid: overrides.iid ?? 1,
        title: "Issue",
        url: "https://gitlab.example.com/g/p/-/issues/1",
        projectId: "g/p",
        labels: ["human-review"],
      },
      ...(overrides.endedAt ? { endedAt: overrides.endedAt } : {}),
    });
    return runId;
  }

  it("stamps endedAt + final labels on human_review_issue_closed", () => {
    const state = createRuntimeState();
    const runId = seedRun(state);

    syncHumanReviewFinalLabels(state, {
      type: "human_review_issue_closed",
      issueIid: 1,
      runId,
      ts: "2026-05-15T12:00:00.000Z",
      detail: { labels: [] },
    });

    const run = state.getRun(runId);
    expect(run?.["endedAt"]).toBe("2026-05-15T12:00:00.000Z");
    expect((run?.["issue"] as { labels: string[] }).labels).toEqual([]);
  });

  it("stamps endedAt + ai-rework labels on human_review_rework_requested", () => {
    const state = createRuntimeState();
    const runId = seedRun(state);

    syncHumanReviewFinalLabels(state, {
      type: "human_review_rework_requested",
      issueIid: 1,
      runId,
      ts: "2026-05-15T13:00:00.000Z",
      detail: { labels: ["ai-rework"] },
    });

    const run = state.getRun(runId);
    expect(run?.["endedAt"]).toBe("2026-05-15T13:00:00.000Z");
    expect((run?.["issue"] as { labels: string[] }).labels).toEqual([
      "ai-rework",
    ]);
  });

  it("preserves the earliest endedAt across repeated terminal events", () => {
    const state = createRuntimeState();
    const runId = seedRun(state, { endedAt: "2026-05-15T11:00:00.000Z" });

    syncHumanReviewFinalLabels(state, {
      type: "human_review_issue_closed",
      issueIid: 1,
      runId,
      ts: "2026-05-15T12:00:00.000Z",
      detail: { labels: [] },
    });

    expect(state.getRun(runId)?.["endedAt"]).toBe("2026-05-15T11:00:00.000Z");
  });

  it("ignores non-terminal human-review events", () => {
    const state = createRuntimeState();
    const runId = seedRun(state);

    syncHumanReviewFinalLabels(state, {
      type: "human_review_mr_still_open",
      issueIid: 1,
      runId,
      ts: "2026-05-15T14:00:00.000Z",
      detail: {},
    });

    expect(state.getRun(runId)?.["endedAt"]).toBeUndefined();
  });
});

describe("startDaemon human-review event publishing", () => {
  it("does not persist scan-level events under a previous issue-specific scan run", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-events-"),
    );
    const workflow = createWorkflow(root);
    let loopDeps: LoopDeps | undefined;
    const issueEventFile = path.join(
      root,
      ".issuepilot",
      "events",
      "group-project-7.jsonl",
    );

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () =>
          createGitLabForHumanReviewScanPollution(),
        ),
        createServer: vi.fn(async () => createFakeServer()),
        startLoop: vi.fn((deps) => {
          loopDeps = deps;
          return {
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        }),
        state: createRuntimeState(),
      },
    );

    try {
      await loopDeps?.reconcileRunning();
      await vi.waitFor(async () => {
        const content = await fs.readFile(issueEventFile, "utf-8");
        expect(content).toContain("human_review_mr_missing");
      });

      await loopDeps?.reconcileRunning();

      await new Promise((resolve) => setTimeout(resolve, 20));
      const content = await fs.readFile(issueEventFile, "utf-8");
      const eventTypes = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type);
      expect(eventTypes).toEqual(["human_review_mr_missing"]);
      const [event] = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(event).toMatchObject({
        type: "human_review_mr_missing",
        issue: {
          id: "7",
          iid: 7,
          title: "Issue #7",
          url: "",
          projectId: "group/project",
        },
        createdAt: expect.any(String),
        ts: expect.any(String),
        data: expect.objectContaining({ issueIid: 7 }),
      });
      expect(isEventType(event?.["type"])).toBe(true);
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("wires operatorActions (retry/stop/archive) into createServer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-operator-actions-"),
    );
    const workflow = createWorkflow(root);
    let serverDeps: ServerDeps | undefined;
    const createServer = vi.fn(async (deps: ServerDeps) => {
      serverDeps = deps;
      return createFakeServer();
    });

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () =>
          createGitLabForHumanReviewScanPollution(),
        ),
        createServer,
        startLoop: vi.fn(() => ({
          tick: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        })),
        state: createRuntimeState(),
      },
    );

    try {
      expect(serverDeps).toBeDefined();
      expect(serverDeps?.operatorActions).toBeDefined();
      expect(typeof serverDeps?.operatorActions?.retry).toBe("function");
      expect(typeof serverDeps?.operatorActions?.stop).toBe("function");
      expect(typeof serverDeps?.operatorActions?.archive).toBe("function");
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("operatorActions.retry delegates to retryRun against runtime state", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-operator-retry-"),
    );
    const workflow = createWorkflow(root);
    const gitlab = createGitLabForHumanReviewScanPollution();
    let serverDeps: ServerDeps | undefined;
    const state = createRuntimeState();
    state.setRun("run-9", {
      runId: "run-9",
      status: "failed",
      attempt: 1,
      issue: {
        id: "9",
        iid: 9,
        title: "Boom",
        url: "https://gitlab.example.com/group/project/-/issues/9",
        projectId: "group/project",
        labels: ["ai-failed"],
      },
    });

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () => gitlab),
        createServer: vi.fn(async (deps: ServerDeps) => {
          serverDeps = deps;
          return createFakeServer();
        }),
        startLoop: vi.fn(() => ({
          tick: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        })),
        state,
      },
    );

    try {
      const result = await serverDeps!.operatorActions!.retry({
        runId: "run-9",
        operator: "alice",
      });
      expect(result.ok).toBe(true);
      expect(state.getRun("run-9")?.status).toBe("claimed");
      expect(state.getRun("run-9")?.attempt).toBe(2);
      expect(gitlab.transitionLabels).toHaveBeenCalledWith(9, {
        add: ["ai-rework"],
        remove: ["ai-running", "ai-failed", "ai-blocked"],
      });

      // The daemon's eventBus subscriber must bridge operator_action_*
      // records into the per-run eventStore so `/api/events?runId=...`
      // (the dashboard's audit log query) sees the retry attempt. Without
      // this bridge actions.ts publishes only to the bus and the audit
      // trail vanishes the moment the SSE client disconnects.
      //
      // The bridge's `eventStore.append` is fire-and-forget (matches the
      // existing publishEvent pattern), so poll briefly for the records
      // instead of asserting synchronously.
      const deadline = Date.now() + 2_000;
      let types: string[] = [];
      while (Date.now() < deadline) {
        const events = await serverDeps!.readEvents("run-9");
        types = events.map((e) => e.type);
        if (
          types.includes("operator_action_requested") &&
          types.includes("operator_action_succeeded")
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(types).toContain("operator_action_requested");
      expect(types).toContain("operator_action_succeeded");
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the configured rework label for closed unmerged merge requests", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-rework-label-"),
    );
    const workflow = createWorkflow(root);
    workflow.tracker.activeLabels = ["ai-ready", "needs-agent-rework"];
    workflow.tracker.reworkLabel = "needs-agent-rework";
    const gitlab = createGitLabForClosedUnmergedReview();
    let loopDeps: LoopDeps | undefined;
    const state = createRuntimeState();
    state.setRun("run-7", {
      runId: "run-7",
      status: "completed",
      attempt: 1,
      issue: {
        id: "7",
        iid: 7,
        title: "Needs review",
        url: "https://gitlab.example.com/group/project/-/issues/7",
        projectId: "group/project",
        labels: ["human-review"],
      },
    });

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () => gitlab),
        createServer: vi.fn(async () => createFakeServer()),
        startLoop: vi.fn((deps) => {
          loopDeps = deps;
          return {
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          };
        }),
        state,
      },
    );

    try {
      await loopDeps?.reconcileRunning();

      expect(gitlab.transitionLabels).toHaveBeenCalledWith(7, {
        add: ["needs-agent-rework"],
        remove: ["human-review"],
        requireCurrent: ["human-review"],
      });
      expect(
        (state.getRun("run-7")?.["issue"] as { labels?: string[] }).labels,
      ).toEqual(["needs-agent-rework"]);
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // V2.5 Command Center: the daemon must construct a report store rooted at
  // `${workflow.workspace.root}/.issuepilot` and inject it into createServer
  // so `/api/runs`, `/api/runs/:runId` and `/api/reports` can return report
  // summaries. We only assert the wiring here; report contents are exercised
  // in the unit tests for the report store, server and dashboard helpers.
  it("wires a V4.1 work item service into createServer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-work-items-"),
    );
    const workflow = createWorkflow(root);
    let serverDeps: ServerDeps | undefined;
    const createServer = vi.fn(async (deps: ServerDeps) => {
      serverDeps = deps;
      return createFakeServer();
    });

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () =>
          createGitLabForHumanReviewScanPollution(),
        ),
        createServer,
        startLoop: vi.fn(() => ({
          tick: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        })),
        state: createRuntimeState(),
      },
    );

    try {
      expect(serverDeps).toBeDefined();
      expect(serverDeps?.workItems).toBeDefined();
      expect(typeof serverDeps?.workItems?.planFromIssue).toBe("function");
      expect(typeof serverDeps?.workItems?.list).toBe("function");
      expect(typeof serverDeps?.workItems?.detail).toBe("function");
      expect(typeof serverDeps?.workItems?.acceptPlan).toBe("function");
      expect(typeof serverDeps?.workItems?.regeneratePlan).toBe("function");
      expect(typeof serverDeps?.workItems?.skipTask).toBe("function");
      expect(typeof serverDeps?.workItems?.retryTask).toBe("function");
      expect(typeof serverDeps?.workItems?.report).toBe("function");
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("wires a report store into createServer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-daemon-reports-"),
    );
    const workflow = createWorkflow(root);
    let serverDeps: ServerDeps | undefined;
    const createServer = vi.fn(async (deps: ServerDeps) => {
      serverDeps = deps;
      return createFakeServer();
    });

    const daemon = await startDaemon(
      { workflowPath: workflow.source.path },
      {
        workflowLoader: {
          loadOnce: vi.fn(async () => workflow),
          start: vi.fn(async () => ({
            stop: vi.fn(async () => {}),
          })),
          render: vi.fn(() => "prompt"),
        },
        createGitLab: vi.fn(async () =>
          createGitLabForHumanReviewScanPollution(),
        ),
        createServer,
        startLoop: vi.fn(() => ({
          tick: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
        })),
        state: createRuntimeState(),
      },
    );

    try {
      expect(serverDeps).toBeDefined();
      expect(serverDeps?.reports).toBeDefined();
      expect(typeof serverDeps?.reports?.get).toBe("function");
      expect(typeof serverDeps?.reports?.save).toBe("function");
      expect(typeof serverDeps?.reports?.summary).toBe("function");
      expect(typeof serverDeps?.reports?.allSummaries).toBe("function");
    } finally {
      await daemon.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
