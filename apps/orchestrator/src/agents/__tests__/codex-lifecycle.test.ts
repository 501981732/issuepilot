/**
 * Unit tests for `apps/orchestrator/src/agents/codex-lifecycle.ts`：
 * 把 Codex `spawnRpc + driveLifecycle` mock 掉，断言 outcome 翻译表
 * 与 finally close 行为符合契约（V4.6 follow-up Critical 1 part 1/3）。
 */

import type { TaskNode, WorkItem } from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@issuepilot/runner-codex-app-server", () => ({
  spawnRpc: vi.fn(),
  driveLifecycle: vi.fn(),
}));

import {
  driveLifecycle,
  spawnRpc,
} from "@issuepilot/runner-codex-app-server";

import {
  createCoderLifecycle,
  createReviewerLifecycle,
  type CodexLifecycleOptions,
} from "../codex-lifecycle.js";

const TASK: TaskNode = {
  taskId: "t_1",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "running_coding",
  runIds: [],
  riskLevel: "low",
};

const WORKITEM: WorkItem = {
  workItemId: "wi_1",
  sourceIssue: { projectId: "g/p", iid: 7, url: "u", title: "t" },
  title: "Title",
  goal: "g",
  acceptanceCriteria: ["AC"],
  status: "running",
  taskIds: ["t_1"],
  createdAt: "t0",
  updatedAt: "t0",
};

const CODEX: WorkflowConfig["codex"] = {
  command: "codex serve",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnTimeoutMs: 1_000,
  turnSandboxPolicy: { type: "workspaceWrite" },
};

const RUN_INPUT = {
  prompt: "do",
  cwd: "/tmp/wt",
  workItem: WORKITEM,
  task: TASK,
};

interface FakeRpc {
  close: ReturnType<typeof vi.fn>;
}

const makeFakeRpc = (): FakeRpc => ({ close: vi.fn(async () => undefined) });

const mockedSpawn = vi.mocked(spawnRpc);
const mockedDrive = vi.mocked(driveLifecycle);

const baseOpts = (
  threadName: CodexLifecycleOptions["threadName"] = () =>
    "g/p#7/t_1/coder",
): CodexLifecycleOptions => ({
  codex: CODEX,
  maxTurns: 1,
  threadName,
  now: () => "2026-05-20T00:00:00.000Z",
});

beforeEach(() => {
  mockedSpawn.mockReset();
  mockedDrive.mockReset();
});

describe("createCoderLifecycle.run", () => {
  it("completed → CoderLifecycleOutcome.completed，runId 来自 lastTurnId", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn_abc",
      threadId: "th_1",
    });

    const runner = createCoderLifecycle(baseOpts());
    const outcome = await runner.run(RUN_INPUT);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completed");
    expect(outcome.result.runId).toBe("turn_abc");
    expect(outcome.result.diffSummary).toBe("");
    expect(outcome.result.branch).toBe("");
    expect(rpc.close).toHaveBeenCalledTimes(1);
    // tools 默认（未传 opts.tools）应该透传成空数组给 driveLifecycle
    expect(mockedDrive.mock.calls[0]?.[0]?.tools).toEqual([]);
  });

  it("failed → outcome.failed with reason=coding_failed 且 message 含 lifecycle failureReason", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "failed",
      turnsUsed: 1,
      lastTurnId: "turn_x",
      threadId: "th_1",
      failureReason: "CI red",
    });

    const runner = createCoderLifecycle(baseOpts());
    const outcome = await runner.run(RUN_INPUT);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "coding_failed",
      message: "CI red",
      runId: "turn_x",
    });
  });

  it("cancelled → outcome.cancelled with cancelledAt from opts.now()", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "cancelled",
      turnsUsed: 1,
      lastTurnId: "turn_x",
      threadId: "th_1",
    });

    const runner = createCoderLifecycle(baseOpts());
    const outcome = await runner.run(RUN_INPUT);

    expect(outcome).toEqual({
      kind: "cancelled",
      cancelledAt: "2026-05-20T00:00:00.000Z",
    });
  });

  it("spawnRpc 同步抛错时不被吞，直接冒泡", async () => {
    mockedSpawn.mockImplementation(() => {
      throw new Error("rpc spawn failed");
    });

    const runner = createCoderLifecycle(baseOpts());
    await expect(runner.run(RUN_INPUT)).rejects.toThrow("rpc spawn failed");
    expect(mockedDrive).not.toHaveBeenCalled();
  });

  it("timeout → outcome.failed with reason=coding_failed 且 message 包含 \"timed out\"", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "timeout",
      turnsUsed: 1,
      lastTurnId: "t-1",
      threadId: "th_1",
      failureReason: "Turn timed out",
    });

    const runner = createCoderLifecycle(baseOpts());
    const outcome = await runner.run(RUN_INPUT);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.reason).toBe("coding_failed");
    expect(outcome.message).toMatch(/timed out/i);
    expect(outcome.runId).toBe("t-1");
  });

  it("blocked → outcome.failed with reason=coding_failed 且 message 包含 \"blocked\"", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "blocked",
      turnsUsed: 1,
      lastTurnId: "t-2",
      threadId: "th_1",
    });

    const runner = createCoderLifecycle(baseOpts());
    const outcome = await runner.run(RUN_INPUT);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.reason).toBe("coding_failed");
    expect(outcome.message).toMatch(/blocked/i);
    expect(outcome.runId).toBe("t-2");
  });

  it("driveLifecycle reject 时仍然在 finally 关闭 RPC", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockRejectedValue(new Error("lifecycle boom"));

    const runner = createCoderLifecycle(baseOpts());
    await expect(runner.run(RUN_INPUT)).rejects.toThrow("lifecycle boom");
    expect(rpc.close).toHaveBeenCalledTimes(1);
  });
});

describe("createReviewerLifecycle.run", () => {
  it("completed → outcome.message with runId from lastTurnId", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn_reviewer",
      threadId: "th_2",
    });

    const runner = createReviewerLifecycle(baseOpts());
    const outcome = await runner.run({
      // reviewer profile shape is irrelevant — adapter never reads it
      profile: { roleProfileId: "reviewer@x" } as never,
      prompt: "review",
      cwd: "/tmp/wt",
      workItem: WORKITEM,
      task: TASK,
    });

    expect(outcome.kind).toBe("message");
    if (outcome.kind !== "message") throw new Error("expected message");
    expect(outcome.result.runId).toBe("turn_reviewer");
    expect(outcome.result.rawMessage).toBe("");
  });

  it("failed → outcome.failed with reason=reviewer_unavailable", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "failed",
      turnsUsed: 1,
      lastTurnId: "turn_y",
      threadId: "th_2",
      failureReason: "timeout while reviewing",
    });

    const runner = createReviewerLifecycle(baseOpts());
    const outcome = await runner.run({
      profile: { roleProfileId: "reviewer@x" } as never,
      prompt: "review",
      cwd: "/tmp/wt",
      workItem: WORKITEM,
      task: TASK,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "reviewer_unavailable",
      message: "timeout while reviewing",
      runId: "turn_y",
    });
  });

  it("cancelled → outcome.cancelled with cancelledAt from opts.now()", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "cancelled",
      turnsUsed: 1,
      lastTurnId: "turn_z",
      threadId: "th_2",
    });

    const runner = createReviewerLifecycle(baseOpts());
    const outcome = await runner.run({
      profile: { roleProfileId: "reviewer@x" } as never,
      prompt: "review",
      cwd: "/tmp/wt",
      workItem: WORKITEM,
      task: TASK,
    });

    expect(outcome).toEqual({
      kind: "cancelled",
      cancelledAt: "2026-05-20T00:00:00.000Z",
    });
  });
});

describe("onTurnActive 透传", () => {
  it("传入时按引用透传给 driveLifecycle；未传时不写入 DriveInput", async () => {
    const rpc1 = makeFakeRpc();
    const rpc2 = makeFakeRpc();
    mockedSpawn.mockReturnValueOnce(rpc1 as never).mockReturnValueOnce(
      rpc2 as never,
    );
    mockedDrive.mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn_ota",
      threadId: "th_1",
    });

    const onTurnActive = vi.fn();
    const withRunner = createCoderLifecycle({
      ...baseOpts(),
      onTurnActive,
    });
    await withRunner.run(RUN_INPUT);

    const withoutRunner = createCoderLifecycle(baseOpts());
    await withoutRunner.run(RUN_INPUT);

    const driveInputWith = mockedDrive.mock.calls[0]?.[0];
    const driveInputWithout = mockedDrive.mock.calls[1]?.[0];

    expect(driveInputWith?.onTurnActive).toBe(onTurnActive);
    // 未传时 adapter 必须 *不* 写入这个 key —— exactOptionalPropertyTypes
    // 下传 `undefined` 与 "缺省" 含义不同；这里 in 检查可以同时挡住
    // `{ onTurnActive: undefined }` 这种误传。
    expect(driveInputWithout && "onTurnActive" in driveInputWithout).toBe(
      false,
    );
  });
});

describe("threadName callback", () => {
  it("createCoderLifecycle 传入 role=\"coder\"，createReviewerLifecycle 传入 role=\"reviewer\"", async () => {
    const rpc = makeFakeRpc();
    mockedSpawn.mockReturnValue(rpc as never);
    mockedDrive.mockResolvedValue({
      status: "completed",
      turnsUsed: 1,
      lastTurnId: "turn_role_test",
      threadId: "th_1",
    });

    const threadName = vi.fn(({ role }) => `g/p#7/t_1/${role}`);

    const coderRunner = createCoderLifecycle({ ...baseOpts(), threadName });
    await coderRunner.run(RUN_INPUT);

    const reviewerRunner = createReviewerLifecycle({
      ...baseOpts(),
      threadName,
    });
    await reviewerRunner.run({
      profile: { roleProfileId: "reviewer@x" } as never,
      prompt: "review",
      cwd: "/tmp/wt",
      workItem: WORKITEM,
      task: TASK,
    });

    const roles = threadName.mock.calls.map((c) => c[0].role);
    expect(roles).toEqual(["coder", "reviewer"]);
    // 顺带断言 driveLifecycle 收到了渲染好的 thread 名
    const driveCalls = mockedDrive.mock.calls.map((c) => c[0].threadName);
    expect(driveCalls).toEqual([
      "g/p#7/t_1/coder",
      "g/p#7/t_1/reviewer",
    ]);
  });
});
