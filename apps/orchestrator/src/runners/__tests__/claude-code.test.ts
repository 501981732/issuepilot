import type {
  RunnerDescriptor,
  RunnerEvent,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { createClaudeCodeAdapter } from "../claude-code.js";
import type {
  ClaudeCodeDriver,
  ClaudeCodeDriverResult,
} from "../claude-code-driver.js";

const claudeDescriptor = (): Extract<
  RunnerDescriptor,
  { kind: "claude_code" }
> => ({
  runnerId: "claude_reviewer",
  kind: "claude_code",
  capabilities: [
    "roles.reviewer",
    "events.streaming",
    "cancel",
    "artifacts",
    "filesystem.readonly",
  ],
  options: {
    command: "claude",
    model: "sonnet",
    maxTurns: 3,
    turnTimeoutMs: 600_000,
  },
});

const runnerInput = (
  overrides: Partial<RunnerRunInput> = {},
): RunnerRunInput => ({
  runnerId: "claude_reviewer",
  role: "reviewer",
  prompt: "review this diff",
  cwd: "/tmp/worktree",
  workItemId: "wi-1",
  taskId: "task-1",
  pipelineRunId: "pipe-1",
  roleProfileId: "reviewer@v1",
  timeoutSeconds: 5,
  toolAllow: [],
  sandbox: "read_only_worktree",
  metadata: {},
  ...overrides,
});

const fakeDriver = (result: ClaudeCodeDriverResult): ClaudeCodeDriver => ({
  start: vi.fn(() => ({
    result: Promise.resolve(result),
    kill: vi.fn().mockResolvedValue(undefined),
  })),
});

const hangingDriver = (onKill: (reason: "cancelled" | "timeout") => void): ClaudeCodeDriver => ({
  start: vi.fn(() => ({
    result: new Promise<ClaudeCodeDriverResult>(() => {}),
    kill: vi.fn(async (reason) => {
      onKill(reason);
    }),
  })),
});

describe("ClaudeCodeRunnerAdapter (V4.8)", () => {
  it("maps completed driver result to RunnerResult with events", async () => {
    const events: RunnerEvent[] = [];
    const adapter = createClaudeCodeAdapter({
      descriptor: claudeDescriptor(),
      driver: fakeDriver({
        status: "completed",
        runnerRunId: "claude-run-1",
        finalMessage:
          '{"summary":"LGTM","decision":"approve_with_comments","confidence":0.82,"risks":[],"evidence_request":[],"findings":[],"inline_comments":[]}',
        artifacts: [{ kind: "log", summary: "review completed" }],
      }),
      now: () => "2026-05-21T00:00:00.000Z",
    });

    const result = await adapter.run(runnerInput(), {
      events: { emit: (event) => events.push(event) },
    });

    expect(result).toMatchObject({
      status: "completed",
      runId: "claude-run-1",
      finalMessage: expect.stringContaining('"decision"'),
      artifacts: [{ kind: "log", summary: "review completed" }],
    });
    expect(events.map((event) => event.type)).toEqual([
      "runner_started",
      "runner_message",
      "runner_completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      runnerId: "claude_reviewer",
      runnerRunId: "claude-run-1",
      role: "reviewer",
    });
  });

  it("maps failed driver result to failed RunnerResult", async () => {
    const adapter = createClaudeCodeAdapter({
      descriptor: claudeDescriptor(),
      driver: fakeDriver({
        status: "failed",
        runnerRunId: "claude-run-2",
        errorMessage: "not logged in",
        artifacts: [],
      }),
    });

    const result = await adapter.run(runnerInput());

    expect(result).toMatchObject({
      status: "failed",
      runId: "claude-run-2",
      error: { code: "runner_unavailable", message: "not logged in" },
    });
  });

  it("maps cancelled driver result to cancelled RunnerResult", async () => {
    const adapter = createClaudeCodeAdapter({
      descriptor: claudeDescriptor(),
      driver: fakeDriver({
        status: "cancelled",
        runnerRunId: "claude-run-3",
        cancelledAt: "2026-05-21T00:00:05.000Z",
        artifacts: [],
      }),
      now: () => "2026-05-21T00:00:00.000Z",
    });

    const result = await adapter.run(runnerInput());

    expect(result).toMatchObject({
      status: "cancelled",
      runId: "claude-run-3",
      cancelledAt: "2026-05-21T00:00:05.000Z",
    });
  });

  it("kills the driver on timeout and returns RunnerResultTimeout", async () => {
    const killed: string[] = [];
    const adapter = createClaudeCodeAdapter({
      descriptor: claudeDescriptor(),
      driver: hangingDriver((reason) => killed.push(reason)),
      now: () => "2026-05-21T00:00:00.000Z",
    });

    const result = await adapter.run(runnerInput({ timeoutSeconds: 0.001 }));

    expect(result).toMatchObject({
      status: "timeout",
      error: { code: "runner_timeout" },
    });
    expect(killed).toEqual(["timeout"]);
  });

  it("redacts secret-looking final message, errors and artifact summaries", async () => {
    const adapter = createClaudeCodeAdapter({
      descriptor: claudeDescriptor(),
      driver: fakeDriver({
        status: "failed",
        runnerRunId: "claude-run-4",
        finalMessage: "token=sk-test-abcdef",
        errorMessage: "token=sk-test-ghijkl",
        artifacts: [{ kind: "log", summary: "glpat-secret123456" }],
      }),
    });

    const result = await adapter.run(runnerInput());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("sk-test-abcdef");
    expect(serialized).not.toContain("sk-test-ghijkl");
    expect(serialized).not.toContain("glpat-secret123456");
    expect(result.redactedFields).toEqual(
      expect.arrayContaining([
        "finalMessage",
        "error.message",
        "artifacts[0].summary",
      ]),
    );
  });
});
