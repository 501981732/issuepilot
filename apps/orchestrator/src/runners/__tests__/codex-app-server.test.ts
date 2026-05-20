import {
  driveLifecycle,
  spawnRpc,
} from "@issuepilot/runner-codex-app-server";
import type {
  RunnerDescriptor,
  RunnerEvent,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { createCodexAppServerAdapter } from "../codex-app-server.js";

vi.mock("@issuepilot/runner-codex-app-server", () => ({
  spawnRpc: vi.fn(),
  driveLifecycle: vi.fn(),
}));

const codexDescriptor = (): RunnerDescriptor => ({
  runnerId: "codex_app_server",
  kind: "codex_app_server",
  capabilities: [
    "roles.coder",
    "roles.reviewer",
    "roles.test_evidence",
    "events.streaming",
    "artifacts",
    "gitlab.tools",
    "filesystem.worktree_write",
  ],
  options: {
    command: "codex app-server",
    maxTurns: 5,
    turnTimeoutMs: 60_000,
    approvalPolicy: "never",
    threadSandbox: "workspace-write",
  },
});

const codexConfig = (): WorkflowConfig["codex"] => ({
  command: "codex app-server",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnTimeoutMs: 60_000,
  turnSandboxPolicy: { type: "workspaceWrite" },
});

const baseInput = (overrides: Partial<RunnerRunInput> = {}): RunnerRunInput => ({
  runnerId: "codex_app_server",
  role: "coder",
  prompt: "do the thing",
  cwd: "/tmp/wt",
  workItemId: "wi-1",
  taskId: "task-1",
  pipelineRunId: "pipe-1",
  roleProfileId: "coder@v1",
  toolAllow: [],
  sandbox: "read_write_worktree",
  metadata: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawnRpc).mockReturnValue({
    close: vi.fn().mockResolvedValue(undefined),
  } as never);
});

describe("CodexAppServerRunnerAdapter (V4.7)", () => {
  it("maps completed lifecycle to RunnerResult with runId/finalMessage", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn-1",
      finalMessage: "done",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    expect(result).toMatchObject({
      status: "completed",
      finalMessage: "done",
      runId: "turn-1",
    });
  });

  it("maps blocked lifecycle to failed runner result with tool_denied", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "blocked",
      turnsUsed: 2,
      lastTurnId: "turn-2",
      failureReason: "tool denied by policy",
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    expect(result).toMatchObject({
      status: "failed",
      runId: "turn-2",
    });
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.code).toBe("tool_denied");
  });

  it("maps sandbox-flavoured failure to sandbox_violation", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "failed",
      turnsUsed: 1,
      lastTurnId: "turn-sb",
      failureReason: "sandbox violation: write outside worktree",
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.code).toBe("sandbox_violation");
  });

  it("maps timeout lifecycle to timeout RunnerResult with runner_timeout", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "timeout",
      turnsUsed: 1,
      lastTurnId: "turn-t",
      failureReason: "turn exceeded budget",
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    expect(result.status).toBe("timeout");
    if (result.status !== "timeout") throw new Error("expected timeout");
    expect(result.error.code).toBe("runner_timeout");
  });

  it("maps cancelled lifecycle to cancelled RunnerResult", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "cancelled",
      turnsUsed: 0,
      lastTurnId: "turn-c",
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
      now: () => "2026-05-20T01:02:03.000Z",
    });

    const result = await adapter.run(baseInput());
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("expected cancelled");
    expect(result.cancelledAt).toBe("2026-05-20T01:02:03.000Z");
  });

  it("uses descriptor options as V4.7 source of truth for driveLifecycle inputs", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn-1",
      finalMessage: "done",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: {
        ...codexDescriptor(),
        options: {
          command: "codex app-server",
          maxTurns: 3,
          turnTimeoutMs: 1234,
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
        },
      },
      codex: {
        ...codexConfig(),
        approvalPolicy: "on-request",
        threadSandbox: "read-only",
        turnTimeoutMs: 9999,
      },
    });

    await adapter.run(baseInput());

    const callArgs = vi.mocked(driveLifecycle).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.maxTurns).toBe(3);
    expect(callArgs.turnTimeoutMs).toBe(1234);
    expect(callArgs.approvalPolicy).toBe("never");
    expect(callArgs.sandboxType).toBe("workspace-write");
  });

  it("emits sanitized RunnerEvent stripping nested raw notification fields", async () => {
    vi.mocked(driveLifecycle).mockImplementation(async (driveInput: unknown) => {
      const onEvent = (driveInput as { onEvent: (type: string, data: unknown) => void })
        .onEvent;
      onEvent("turn/notification", { message: "hello", token: "SECRET-token=abc" });
      return {
        status: "completed",
        turnsUsed: 1,
        lastTurnId: "turn-1",
        finalMessage: "done",
      } as never;
    });

    const events: RunnerEvent[] = [];
    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    await adapter.run(baseInput(), {
      events: { emit: (event) => events.push(event) },
    });

    expect(events.length).toBeGreaterThan(0);
    const firstMessage = events.find((e) => e.type === "runner_message");
    expect(firstMessage).toBeDefined();
    expect(firstMessage?.runnerId).toBe("codex_app_server");
    expect(firstMessage?.pipelineRunId).toBe("pipe-1");
    expect(firstMessage?.workItemId).toBe("wi-1");
    expect(firstMessage?.taskId).toBe("task-1");
    expect(firstMessage?.role).toBe("coder");
    expect(JSON.stringify(firstMessage)).not.toContain("SECRET-token=abc");
  });

  it("redacts finalMessage and artifact summaries that contain secret-like patterns", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn-secret",
      finalMessage: "token=SECRET_TOKEN_VALUE",
      completedToolCalls: [
        {
          tool: "gitlab_create_merge_request",
          result: {
            ok: true,
            data: {
              iid: 7,
              webUrl: "https://gitlab/mr/7?token=SECRET_TOKEN_VALUE",
              state: "opened",
            },
          },
        },
      ],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    expect(result.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_VALUE");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.redactedFields).toEqual(
      expect.arrayContaining(["finalMessage", "artifacts[0].summary"]),
    );
  });

  it("redacts runner error messages before returning failed RunnerResult", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "failed",
      turnsUsed: 1,
      lastTurnId: "turn-failed",
      failureReason: "runner crashed with token=SECRET_TOKEN_VALUE",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());
    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_VALUE");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.message).not.toContain("SECRET_TOKEN_VALUE");
    expect(result.redactedFields ?? []).toContain("error.message");
  });

  it("extracts gitlab merge request artifact from completed tool calls", async () => {
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn-mr",
      finalMessage: "implemented",
      completedToolCalls: [
        {
          tool: "gitlab_create_merge_request",
          result: {
            ok: true,
            data: {
              iid: 7,
              webUrl: "https://gitlab/mr/7",
              state: "opened",
            },
          },
        },
      ],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput({ role: "coder" }));
    if (result.status !== "completed") throw new Error("expected completed");
    const mrArtifact = (result.artifacts ?? []).find(
      (a) => a.kind === "tool_result",
    );
    expect(mrArtifact).toBeDefined();
    expect(mrArtifact?.summary).toMatch(/merge_request:7:https:\/\/gitlab\/mr\/7/);
  });

  it("closes the RPC client even when driveLifecycle throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(spawnRpc).mockReturnValue({ close } as never);
    vi.mocked(driveLifecycle).mockRejectedValue(new Error("spawn failed"));

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    await expect(adapter.run(baseInput())).rejects.toThrow("spawn failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
