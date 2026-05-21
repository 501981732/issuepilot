import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { execa } from "execa";
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
      // V4.7 review B1 修复:
      //   - `notification` 是 lifecycle 实际 emit 的事件名(见
      //     packages/runner-codex-app-server/src/lifecycle.ts:176),
      //     映射到 RunnerEvent.type = "runner_message"。
      //   - 先 emit `turn_started` 让 adapter 缓存 turnId,后续 RunnerEvent 才能
      //     带上 runnerRunId(V4.7 review M1)。
      onEvent("turn_started", { turnId: "turn-1" });
      onEvent("notification", { message: "hello", token: "SECRET-token=abc" });
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
    expect(firstMessage?.runnerRunId).toBe("turn-1");
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

  it("V4.7 review B1+M1 regression: forwards real lifecycle emit names to RunnerEventSink with runnerRunId", async () => {
    // 这是 B1 的回归保护:lifecycle.ts 实际 emit 的事件名是
    // `turn_started` / `tool_call_started` / `tool_call_completed` /
    // `notification` 等下划线版本(见
    // packages/runner-codex-app-server/src/lifecycle.ts:152, 298, 310,
    // 314, 321, 334, 362)。adapter NOTIFICATION_EVENT_TYPE 必须以这些
    // 真名为 key,否则生产环境流式 RunnerEvent 永远丢。
    //
    // 同时验证 M1:`turn_started` 的 data.turnId 必须立刻被缓存,后续
    // `tool_call_*` 事件的 RunnerEvent.runnerRunId 才能填上。
    vi.mocked(driveLifecycle).mockImplementation(async (driveInput: unknown) => {
      const onEvent = (
        driveInput as { onEvent: (type: string, data?: unknown) => void }
      ).onEvent;
      onEvent("session_started");
      onEvent("turn_started", { turnId: "turn-streaming" });
      onEvent("tool_call_started", { tool: "x", arguments: { y: 1 } });
      onEvent("notification", { message: "progress" });
      onEvent("tool_call_completed", { tool: "x", result: { ok: true } });
      return {
        status: "completed",
        turnsUsed: 1,
        lastTurnId: "turn-streaming",
        finalMessage: "ok",
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

    const types = events.map((e) => e.type);
    expect(types).toContain("runner_started");
    expect(types).toContain("turn_started");
    expect(types).toContain("tool_call_started");
    expect(types).toContain("runner_message");
    expect(types).toContain("tool_call_completed");

    const toolStart = events.find((e) => e.type === "tool_call_started");
    expect(toolStart?.runnerRunId).toBe("turn-streaming");
    const message = events.find((e) => e.type === "runner_message");
    expect(message?.runnerRunId).toBe("turn-streaming");
  });

  it("V4.7 review H1+H2 regression: emits kind:'diff' artifact with branch + diff stat from real git worktree", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "v47-runner-git-"));
    try {
      // 准备一个真实的 git 仓库 + 改动,让 adapter 的 readWorkspaceGitSummary
      // 跑到真 `git rev-parse` / `git diff --stat` 路径,而不是只走 mock。
      await execa("git", ["init", "-q"], { cwd: repo });
      await execa("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      });
      await execa("git", ["config", "user.name", "Test"], { cwd: repo });
      await execa("git", ["checkout", "-b", "feature/v4-7-regression"], {
        cwd: repo,
      });
      mkdirSync(path.join(repo, "src"));
      writeFileSync(path.join(repo, "src", "a.ts"), "export const A = 1;\n");
      await execa("git", ["add", "."], { cwd: repo });
      await execa("git", ["commit", "-q", "-m", "init"], { cwd: repo });
      writeFileSync(
        path.join(repo, "src", "a.ts"),
        "export const A = 2;\nexport const B = 3;\n",
      );

      vi.mocked(driveLifecycle).mockResolvedValue({
        status: "completed",
        turnsUsed: 1,
        lastTurnId: "turn-real-git",
        finalMessage: "applied",
        completedToolCalls: [],
      } as never);

      const adapter = createCodexAppServerAdapter({
        descriptor: codexDescriptor(),
        codex: codexConfig(),
      });

      const result = await adapter.run(baseInput({ cwd: repo }));
      if (result.status !== "completed") throw new Error("expected completed");
      const diffArtifact = (result.artifacts ?? []).find(
        (a) => a.kind === "diff",
      );
      expect(diffArtifact).toBeDefined();
      // 头部必须是 `branch:<name>\n` 给 agent factory 拆分。
      expect(diffArtifact?.summary).toMatch(/^branch:feature\/v4-7-regression\n/);
      // 剩余内容是 git diff --stat 输出,文件名应被引用。
      expect(diffArtifact?.summary).toMatch(/src\/a\.ts/);
      // text artifact 仍然存在(Codex final_message),但不再 fallback 进
      // CoderAgentReport.coder.diffSummary(覆盖在 coder.test.ts)。
      const textArtifact = (result.artifacts ?? []).find(
        (a) => a.kind === "text",
      );
      expect(textArtifact?.summary).toBe("final_message:\napplied");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("V4.7 review N-3 regression: tool_call_failed surfaces as runner_message (not tool_call_completed)", async () => {
    // adapter 不能把 tool_call_failed 静默映射到 tool_call_completed:
    // 否则 dashboard / event store 拿不到失败信号。V4.8 给
    // RUNNER_EVENT_TYPE_VALUES 加 tool_call_failed 之前,先用 runner_message
    // 让下游可见。
    vi.mocked(driveLifecycle).mockImplementation(async (driveInput: unknown) => {
      const onEvent = (
        driveInput as { onEvent: (type: string, data?: unknown) => void }
      ).onEvent;
      onEvent("turn_started", { turnId: "turn-n3" });
      onEvent("tool_call_failed", {
        tool: "broken",
        error: "permission denied",
      });
      return {
        status: "completed",
        turnsUsed: 1,
        lastTurnId: "turn-n3",
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

    const types = events.map((e) => e.type);
    expect(types).toContain("runner_message");
    // 关键反例:不能伪装成 tool_call_completed,否则下游分不清成功/失败。
    const completedStreaming = events.filter(
      (e) =>
        e.type === "tool_call_completed" &&
        // 区分本测试 case:终态 runner_completed 不应被 tool_call_completed
        // 计数,所以这里只数事件 type。
        true,
    );
    expect(completedStreaming).toHaveLength(0);
  });

  it("V4.7 review N-4 regression: emits a single terminal event mapped from DriveResult.status", async () => {
    vi.mocked(driveLifecycle).mockImplementation(async (driveInput: unknown) => {
      const onEvent = (
        driveInput as { onEvent: (type: string, data?: unknown) => void }
      ).onEvent;
      onEvent("turn_started", { turnId: "turn-n4" });
      // 注意:lifecycle 的 turn_completed 不再 emit RunnerEvent
      // (NOTIFICATION_EVENT_TYPE 已经去掉),所以 streaming 阶段不会冒出
      // runner_message。
      onEvent("turn_completed");
      return {
        status: "completed",
        turnsUsed: 1,
        lastTurnId: "turn-n4",
      } as never;
    });

    const eventsCompleted: RunnerEvent[] = [];
    await createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    }).run(baseInput(), {
      events: { emit: (event) => eventsCompleted.push(event) },
    });

    const terminalCompleted = eventsCompleted.filter(
      (e) => e.type === "runner_completed",
    );
    expect(terminalCompleted).toHaveLength(1);
    expect(terminalCompleted[0]?.runnerRunId).toBe("turn-n4");
    // 关键反例:turn_completed 不应再被映射成 runner_message。
    expect(eventsCompleted.some((e) => e.type === "runner_message")).toBe(
      false,
    );

    // failed 路径:`runner_failed` 终态事件必须独立于 streaming 阶段被 emit。
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "failed",
      turnsUsed: 1,
      failureReason: "boom",
    } as never);
    const eventsFailed: RunnerEvent[] = [];
    await createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    }).run(baseInput(), {
      events: { emit: (event) => eventsFailed.push(event) },
    });
    const terminalFailed = eventsFailed.filter(
      (e) => e.type === "runner_failed",
    );
    expect(terminalFailed).toHaveLength(1);
    expect(terminalFailed[0]?.message).toBe("boom");
  });

  it("V4.7 review follow-up regression: failed status still surfaces MR artifact", async () => {
    // pipeline 后期失败但 coder 已经成功调过 gitlab_create_merge_request:
    // adapter 必须把 MR artifact 透到 RunnerResult.artifacts,让下游
    // (reviewer / handoff / dashboard) 不丢已存在的 MR。
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "failed",
      turnsUsed: 2,
      failureReason: "reviewer raised concerns",
      completedToolCalls: [
        {
          tool: "gitlab_create_merge_request",
          // extractMergeRequest 期望 `{ ok: true, data: { iid, webUrl } }`
          // 的 wrapper(见 codex-app-server.ts:extractMergeRequest)。
          result: {
            ok: true,
            data: { iid: 99, webUrl: "https://gitlab/mr/99", state: "opened" },
          },
        },
      ],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });
    const result = await adapter.run(baseInput());
    if (result.status !== "failed") throw new Error("expected failed");
    const mrArtifact = (result.artifacts ?? []).find(
      (a) => a.kind === "tool_result",
    );
    expect(mrArtifact?.summary).toMatch(/merge_request:99:https:\/\/gitlab\/mr\/99/);
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
