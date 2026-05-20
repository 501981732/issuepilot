/**
 * V4.6 follow-up Critical 1 — Codex lifecycle adapter（part 1/3）。
 *
 * 把 `@issuepilot/runner-codex-app-server` 的 `spawnRpc + driveLifecycle`
 * 流程封装成 `CoderLifecycleRunner` / `ReviewerLifecycleRunner` 契约，
 * 让 daemon 在 4b/4c 里可以把三个 V4.6 角色（coder / reviewer /
 * test_evidence）一次性接到既有 Codex app-server，不再抛
 * `agent_not_configured`。
 *
 * 设计要点：
 * - 这是 *lifecycle* 层适配器，只负责 spawn / drive / 关 RPC。把
 *   `DriveResult.status` 翻译成两种 outcome union；不构造 AgentReport，
 *   AgentReport 由上游 `createCoderAgent` / `createReviewerAgent` 用
 *   outcome 拼装（详见 spec §16.2 行错误码映射）。
 * - 同步抛错（`spawnRpc` / `splitCommand` / `driveLifecycle` 任一阶段）
 *   不被吞，直接向上冒泡，让 agent factory 的 `try { lifecycle.run() }`
 *   catch 把它映射成 `runner_unavailable` / `sandbox_violation` /
 *   `reviewer_unavailable`（与既有手写 `runAgent` 闭包行为一致）。
 * - 无论 happy / error / cancel，`rpc.close()` 都在 `finally` 调用一次，
 *   匹配 `daemon.ts:1294` 的现行习惯。
 *
 * 已知折中（TODO V4.7）：
 * - `CoderLifecycleRunResult.diffSummary` / `branch` 没有真正可读源 —
 *   lifecycle 本身不暴露 worktree diff 信息，需要从 cwd 调 `git` 反查
 *   或从 agent tool call 截获。本版先 pass 空串，`createCoderAgent` 已经
 *   在 `outcome.partial?.* ?? ""` 上做了兜底渲染。
 * - `ReviewerLifecycleResult.rawMessage` 同样没有 lifecycle 级捕获口；
 *   现阶段一律 pass `""`，下游 `parseReviewerMessage` 会判定缺
 *   ```json fence 抛 `prompt_output_schema_mismatch`，再由
 *   `createReviewerAgent` 翻成 `parse_failed`。这是诚实的中间态行为
 *   —— 4b/4c 会把真正的 reviewer message 抓取链路再补上来。
 */

import {
  driveLifecycle,
  spawnRpc,
  type ToolSchema,
} from "@issuepilot/runner-codex-app-server";
import type {
  AgentRole,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";

import { splitCommand } from "../codex/split-command.js";

import type {
  CoderLifecycleOutcome,
  CoderLifecycleRunInput,
  CoderLifecycleRunner,
} from "./coder.js";
import type {
  ReviewerLifecycleOutcome,
  ReviewerLifecycleRunner,
} from "./reviewer.js";

type DriveResult = Awaited<ReturnType<typeof driveLifecycle>>;

interface SharedRunInput {
  prompt: string;
  cwd: string;
  workItem: WorkItem;
  task: TaskNode;
}

export interface ThreadNameInput {
  workItem: WorkItem;
  task: TaskNode;
  role: AgentRole;
}

export interface CodexLifecycleOptions {
  /** workflow.codex（command / approvalPolicy / threadSandbox / turnSandboxPolicy / turnTimeoutMs）。 */
  codex: WorkflowConfig["codex"];
  /** workflow.agent.maxTurns。 */
  maxTurns: number;
  /** 每次调用的 thread 名；daemon 注入如 `<projectId>#<iid>/<taskId>/<role>`。 */
  threadName: (input: ThreadNameInput) => string;
  /**
   * 可选 tool schema 生产函数。coder 角色用 GitLab tools；reviewer /
   * test_evidence 默认 read-only tool set。默认值 `() => []`。
   */
  tools?: () => ToolSchema[];
  /** 测试用：注入时钟（决定 cancelled outcome 的 `cancelledAt`）。 */
  now?: () => string;
  /** 测试用：转发 lifecycle event。默认 no-op，匹配 daemon 当前行为。 */
  onEvent?: (type: string, data?: unknown) => void;
  /**
   * 透传到 `driveLifecycle.onTurnActive`：daemon 当前在
   * daemon.ts:1285-1286 用它把 `cancelTurn` 注册到 `runCancelRegistry`，
   * 4b/4c 会沿用这个 seam，所以 adapter 在 4a 阶段就把字段开出来，
   * 避免后续再扩 API。未提供时按 `exactOptionalPropertyTypes` 语义不
   * 写入 `DriveInput`，让 lifecycle 走自己的 default 行为（noop）。
   */
  onTurnActive?: (cancel: () => Promise<void>) => void;
}

const nowFor = (opts: CodexLifecycleOptions): string =>
  opts.now ? opts.now() : new Date().toISOString();

const coderFailed = (
  message: string,
  runId: string | undefined,
): CoderLifecycleOutcome => ({
  kind: "failed",
  reason: "coding_failed",
  message,
  runId,
});

const reviewerFailed = (
  message: string,
  runId: string | undefined,
): ReviewerLifecycleOutcome =>
  runId === undefined
    ? { kind: "failed", reason: "reviewer_unavailable", message }
    : { kind: "failed", reason: "reviewer_unavailable", message, runId };

const timeoutMessage = (result: DriveResult): string =>
  result.failureReason
    ? `lifecycle timed out: ${result.failureReason}`
    : "lifecycle timed out";

export const mapCoderOutcome = (
  result: DriveResult,
  opts: CodexLifecycleOptions,
): CoderLifecycleOutcome => {
  switch (result.status) {
    case "completed":
      return {
        kind: "completed",
        result: {
          runId: result.lastTurnId ?? "",
          // TODO V4.7：从 cwd 反查真正的 git diff / branch 名再回填。
          diffSummary: "",
          branch: "",
        },
      };
    case "failed":
      return coderFailed(
        result.failureReason ?? "lifecycle reported failed",
        result.lastTurnId,
      );
    case "timeout":
      return coderFailed(timeoutMessage(result), result.lastTurnId);
    case "blocked":
      return coderFailed("lifecycle reported blocked", result.lastTurnId);
    case "cancelled":
      return { kind: "cancelled", cancelledAt: nowFor(opts) };
  }
};

export const mapReviewerOutcome = (
  result: DriveResult,
  opts: CodexLifecycleOptions,
): ReviewerLifecycleOutcome => {
  switch (result.status) {
    case "completed":
      return {
        kind: "message",
        result: {
          runId: result.lastTurnId ?? "",
          // TODO V4.7：捕获 codex agent 的最终 message 作为 rawMessage；
          // 目前 lifecycle 没有暴露 message 出口，下游 parser 会按
          // `prompt_output_schema_mismatch` 翻译成 `parse_failed`。
          rawMessage: "",
        },
      };
    case "failed":
      return reviewerFailed(
        result.failureReason ?? "lifecycle reported failed",
        result.lastTurnId,
      );
    case "timeout":
      return reviewerFailed(timeoutMessage(result), result.lastTurnId);
    case "blocked":
      return reviewerFailed("lifecycle reported blocked", result.lastTurnId);
    case "cancelled":
      return { kind: "cancelled", cancelledAt: nowFor(opts) };
  }
};

const runLifecycle = async (
  opts: CodexLifecycleOptions,
  role: AgentRole,
  input: SharedRunInput,
): Promise<DriveResult> => {
  const cmd = splitCommand(opts.codex.command);
  const rpc = spawnRpc({ ...cmd, cwd: input.cwd });
  try {
    return await driveLifecycle({
      rpc,
      maxTurns: opts.maxTurns,
      prompt: input.prompt,
      title: input.workItem.title,
      cwd: input.cwd,
      threadName: opts.threadName({
        workItem: input.workItem,
        task: input.task,
        role,
      }),
      sandboxType: opts.codex.threadSandbox,
      approvalPolicy: opts.codex.approvalPolicy,
      turnSandboxPolicy: opts.codex.turnSandboxPolicy,
      turnTimeoutMs: opts.codex.turnTimeoutMs,
      tools: opts.tools ? opts.tools() : [],
      onEvent: opts.onEvent ?? (() => {}),
      // `exactOptionalPropertyTypes` 下不能直接传 `undefined`，必须条件展开。
      ...(opts.onTurnActive ? { onTurnActive: opts.onTurnActive } : {}),
    });
  } finally {
    await rpc.close();
  }
};

export const createCoderLifecycle = (
  opts: CodexLifecycleOptions,
): CoderLifecycleRunner => ({
  async run(input: CoderLifecycleRunInput): Promise<CoderLifecycleOutcome> {
    const result = await runLifecycle(opts, "coder", input);
    return mapCoderOutcome(result, opts);
  },
});

export const createReviewerLifecycle = (
  opts: CodexLifecycleOptions,
): ReviewerLifecycleRunner => ({
  async run(input): Promise<ReviewerLifecycleOutcome> {
    const result = await runLifecycle(opts, "reviewer", input);
    return mapReviewerOutcome(result, opts);
  },
});
