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
 * 当前输出策略：
 * - `CoderLifecycleRunResult.diffSummary` 优先使用 cwd 的 `git diff --stat`
 *   / `git status --short`，并把 lifecycle final message 作为人类可读摘要
 *   前缀；`branch` 从 cwd 的当前 git branch 读取。
 * - `ReviewerLifecycleResult.rawMessage` 使用 lifecycle 捕获到的最后一条
 *   Codex notification message，下游 `parseReviewerMessage` 负责校验 JSON
 *   fence 与 schema。
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
import { execa } from "execa";

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

interface CoderGitSummary {
  diffSummary?: string;
  branch?: string;
}

interface CoderMergeRequestSummary {
  iid: number;
  url: string;
  state: "opened" | "merged" | "closed";
}

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
  tools?: (ctx: {
    workItem: WorkItem;
    task: TaskNode;
    role: AgentRole;
  }) => ToolSchema[];
  /** 测试用：注入时钟（决定 cancelled outcome 的 `cancelledAt`）。 */
  now?: () => string;
  /**
   * 转发 lifecycle event。默认 no-op，匹配 daemon 当前行为。
   *
   * V4.6 follow-up Task 4c：`ctx` 把当前 `run()` 的 `workItem` / `task` /
   * `role` 透到 daemon 的 `publishEvent` 闭包里，让 detail 能携带
   * `issueIid` + `pipelineRunId`（由 daemon 通过 closure 决定）+
   * `taskId`，event store append 链路才能真正落库（详见
   * `daemon.ts:884-922`）。adapter 本身保持纯翻译，没有读取 ctx —
   * 这是 daemon wiring 层的可观测性扩展点。
   */
  onEvent?: (
    type: string,
    data: unknown,
    ctx: { workItem: WorkItem; task: TaskNode; role: AgentRole },
  ) => void;
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
  git: CoderGitSummary = {},
): CoderLifecycleOutcome => {
  switch (result.status) {
    case "completed": {
      const mergeRequest = extractMergeRequest(result);
      return {
        kind: "completed",
        result: {
          runId: result.lastTurnId ?? "",
          diffSummary:
            git.diffSummary && result.finalMessage
              ? `${result.finalMessage}\n${git.diffSummary}`
              : (git.diffSummary ?? result.finalMessage ?? ""),
          branch: git.branch ?? "",
          ...(mergeRequest ? { mergeRequest } : {}),
        },
      };
    }
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

const isMrState = (value: unknown): value is "opened" | "merged" | "closed" =>
  value === "opened" || value === "merged" || value === "closed";

const extractMergeRequest = (
  result: DriveResult,
): CoderMergeRequestSummary | undefined => {
  for (const call of [...(result.completedToolCalls ?? [])].reverse()) {
    if (call.tool !== "gitlab_create_merge_request") continue;
    const wrapper = call.result as
      | { ok?: unknown; data?: Record<string, unknown> }
      | undefined;
    if (!wrapper || wrapper.ok !== true || !wrapper.data) continue;
    const iid = wrapper.data["iid"];
    const webUrl = wrapper.data["webUrl"] ?? wrapper.data["web_url"];
    if (typeof iid !== "number" || typeof webUrl !== "string") continue;
    const state = wrapper.data["state"];
    return { iid, url: webUrl, state: isMrState(state) ? state : "opened" };
  }
  return undefined;
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
          rawMessage: result.finalMessage ?? "",
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

const readCoderGitSummary = async (cwd: string): Promise<CoderGitSummary> => {
  const branch = await readGitBranch(cwd);
  const diffSummary = await readGitDiffSummary(cwd);
  return {
    ...(branch ? { branch } : {}),
    ...(diffSummary ? { diffSummary } : {}),
  };
};

const readGitBranch = async (cwd: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : undefined;
  } catch {
    try {
      const { stdout } = await execa("git", ["symbolic-ref", "--short", "HEAD"], {
        cwd,
      });
      const branch = stdout.trim();
      return branch.length > 0 ? branch : undefined;
    } catch {
      return undefined;
    }
  }
};

const readGitDiffSummary = async (cwd: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execa("git", ["diff", "--stat"], { cwd });
    const summary = stdout.trim();
    if (summary.length > 0) return summary;
  } catch {
    return undefined;
  }
  try {
    const { stdout } = await execa("git", ["status", "--short"], { cwd });
    const summary = stdout.trim();
    return summary.length > 0 ? summary : undefined;
  } catch {
    return undefined;
  }
};

const runLifecycle = async (
  opts: CodexLifecycleOptions,
  role: AgentRole,
  input: SharedRunInput,
): Promise<DriveResult> => {
  const cmd = splitCommand(opts.codex.command);
  const rpc = spawnRpc({ ...cmd, cwd: input.cwd });
  // 把 daemon 注入的 3-arg `onEvent` 适配成 `driveLifecycle` 期待的
  // 2-arg 签名：在每次 lifecycle event 触发时把当前 `run()` 的
  // workItem / task / role 透回去，无 daemon 注入时退化为 no-op。
  const lifecycleOnEvent = opts.onEvent;
  const onEvent = lifecycleOnEvent
    ? (type: string, data?: unknown): void =>
        lifecycleOnEvent(type, data, {
          workItem: input.workItem,
          task: input.task,
          role,
        })
    : (): void => {};
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
      tools: opts.tools
        ? opts.tools({ workItem: input.workItem, task: input.task, role })
        : [],
      onEvent,
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
    const git =
      result.status === "completed"
        ? await readCoderGitSummary(input.cwd)
        : {};
    return mapCoderOutcome(result, opts, git);
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
