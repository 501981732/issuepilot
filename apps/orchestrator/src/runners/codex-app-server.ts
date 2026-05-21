/**
 * V4.7 Codex App Server RunnerAdapter.
 *
 * This adapter is the orchestrator-side implementation of the
 * `codex_app_server` runner kind. It wraps the existing
 * `@issuepilot/runner-codex-app-server` lifecycle (`spawnRpc` +
 * `driveLifecycle`) and produces the V4.7 `RunnerResult` /
 * `RunnerEvent` shape so role-specific agent factories can build
 * `AgentReport` without speaking Codex RPC directly.
 *
 * Design rules:
 * - The adapter is pure with respect to AgentReport: it returns
 *   `RunnerResult` / emits `RunnerEvent`. It does not write to the
 *   pipeline store or touch role business semantics.
 * - V4.7 role-pipeline execution uses descriptor `options` as the
 *   source of truth for `approvalPolicy` / `threadSandbox` / `maxTurns`
 *   / `turnTimeoutMs` / `command`. Legacy top-level `workflow.codex` is
 *   only consulted for fields the descriptor does not override
 *   (`turnSandboxPolicy`, fallback command/timeout, never sandbox or
 *   approval escalation).
 * - All outbound payloads pass through `redactSecrets()` before
 *   returning / emitting. When redaction happens we record the dotted
 *   field paths in `RunnerResult.redactedFields[]` / `RunnerEvent.redactedFields[]`
 *   so the agent factory can mirror the audit into `AgentReport`.
 */

import {
  driveLifecycle,
  spawnRpc,
  type ToolSchema,
} from "@issuepilot/runner-codex-app-server";
import type {
  RunnerArtifact,
  RunnerDescriptor,
  RunnerError,
  RunnerErrorCode,
  RunnerEvent,
  RunnerEventType,
  RunnerResult,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { execa } from "execa";

import { splitCommand } from "../codex/split-command.js";

import type { RunnerAdapter, RunnerRunContext } from "./types.js";

/**
 * V4.7 review H1 + H2 修复：completed 路径下 adapter 必须真的从 issue
 * worktree 读出当前 branch 和 diff stat,以 `kind: "diff"` artifact 形式
 * 输出,而不是把 LLM 的 `final_message` 当 diffSummary 兜底。读取失败时
 * 返回 undefined,让下游决定 fallback,从而避免空字符串 / `final_message:`
 * 前缀污染 `CoderAgentReport.coder.{branch, diffSummary}`。
 *
 * V4.7 review N-1 修复:rev-parse 与 diff 拆开不同 timeout;失败时打
 * sanitized warn 让操作员能区分"没 branch"vs"git 读失败"。`execa` 在
 * `reject: false` 下仍把 ENOENT / 非零退出当成 promise resolve(注:在
 * timeout / signal abort 时 execa 会 reject),所以两条命令都包 try/catch
 * 兜底,不让 git 错反向阻塞 runner 完成。
 */
async function readWorkspaceGitSummary(cwd: string): Promise<{
  branch?: string;
  diffStat?: string;
}> {
  const summary: { branch?: string; diffStat?: string } = {};
  // 把 cwd 截短给日志用,避免在 stderr 把 worktree 绝对路径全 leak 出来。
  const cwdLabel = cwd.length > 64 ? `…${cwd.slice(-60)}` : cwd;
  try {
    const result = await execa(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      {
        cwd,
        reject: false,
        // rev-parse 在大仓库也是亚秒级,2s 足够;延长只会拖慢 happy path。
        timeout: 2_000,
      },
    );
    if (result.exitCode === 0) {
      const trimmed = result.stdout.trim();
      if (trimmed.length > 0 && trimmed !== "HEAD") {
        summary.branch = trimmed;
      }
    } else if (result.exitCode !== undefined) {
      console.warn(
        `[runner] git rev-parse degraded (exit=${result.exitCode}) cwd=${cwdLabel}`,
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    console.warn(`[runner] git rev-parse failed (${code}) cwd=${cwdLabel}`);
  }
  try {
    const result = await execa(
      "git",
      ["diff", "--stat", "HEAD"],
      {
        cwd,
        reject: false,
        // diff --stat 在大量改动 + 大文件场景容易 >5s,把 timeout 拉到
        // 15s 与 codex turnTimeoutMs 数量级对齐,避免静默退回到空 diff。
        timeout: 15_000,
      },
    );
    if (result.exitCode === 0) {
      const trimmed = result.stdout.trim();
      if (trimmed.length > 0) {
        summary.diffStat = trimmed;
      }
    } else if (result.exitCode !== undefined) {
      console.warn(
        `[runner] git diff degraded (exit=${result.exitCode}) cwd=${cwdLabel}`,
      );
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    console.warn(`[runner] git diff failed (${code}) cwd=${cwdLabel}`);
  }
  return summary;
}

type DriveResult = Awaited<ReturnType<typeof driveLifecycle>>;

export interface CreateCodexAppServerAdapterOptions {
  descriptor: RunnerDescriptor;
  /** workflow.codex (turnSandboxPolicy / fallback command / turn timeout). */
  codex: WorkflowConfig["codex"];
  tools?: (input: RunnerRunInput) => ToolSchema[];
  now?: () => string;
  onTurnActive?: (cancel: () => Promise<void>) => void;
}

/**
 * Codex lifecycle event name → V4.7 `RunnerEventType` mapping.
 *
 * The string keys are the **internal synthetic event names** that
 * `packages/runner-codex-app-server/src/lifecycle.ts` actually calls
 * `onEvent(...)` with (see e.g. `lifecycle.ts:152, 161, 298, 310, 314,
 * 321, 334, 362`). They are NOT raw Codex RPC method names (the RPC
 * stream uses `turn/notification`, `turn/start`, etc.), and the V4.6
 * adapter intentionally collapses those into a small `_`-separated
 * event vocabulary so V4.7 can stay runner-agnostic.
 *
 * Any name not in this table is intentionally dropped: V4.7 only wants
 * sanitized, contract-shaped events to reach the orchestrator
 * `RunnerEventSink`; raw control-plane chatter such as
 * `approval_required` / `turn_input_required` / `unsupported_tool_call`
 * is logged inside the Codex lifecycle but does not turn into a
 * `RunnerEvent` because it has no stable cross-runner meaning.
 *
 * V4.7 review N-3 / N-4 修复:
 * - `tool_call_failed` 改映射到 `runner_message`(不再借用
 *   `tool_call_completed`),让 dashboard 至少能从事件 type 区分成功 /
 *   失败的工具调用。后续在 V4.8 给 `RUNNER_EVENT_TYPE_VALUES` 增补
 *   `tool_call_failed` 后,这里再换回独立 enum。
 * - `turn_completed` 不再映射到 `runner_message`:多 turn 场景里
 *   `turn_completed` 会出现多次,emit `runner_message` 会让 dashboard
 *   误以为 LLM 又输出了一段消息。真正的"runner 终态"由 `run()` 在
 *   `mapDriveResultToRunnerResult` 之前显式 emit 一次
 *   `runner_completed` / `runner_failed` / `runner_cancelled` 终态事件。
 *
 * 注意:lifecycle.ts:176-177 的 fallback 会把任何未识别 RPC notification
 * 也 emit 成 `notification`,我们映射到 `runner_message` 让这部分流量
 * 仍可见但不带特殊语义。
 */
const NOTIFICATION_EVENT_TYPE: Record<string, RunnerEventType> = {
  session_started: "runner_started",
  turn_started: "turn_started",
  tool_call_started: "tool_call_started",
  tool_call_completed: "tool_call_completed",
  tool_call_failed: "runner_message",
  notification: "runner_message",
  turn_failed: "runner_failed",
  turn_cancelled: "runner_cancelled",
  turn_timeout: "runner_failed",
};

/**
 * `DriveResult.status` → V4.7 `RunnerEventType` 终态映射。
 * V4.7 review N-4:adapter 在 return RunnerResult 之前必须 emit 一次
 * 终态事件,让监控有「一次 run = 一个终态事件」的不变量,也让 V4.7
 * contract 里 `runner_completed` 不再是 dead value。
 */
const TERMINAL_EVENT_TYPE_BY_STATUS: Record<
  DriveResult["status"],
  RunnerEventType
> = {
  completed: "runner_completed",
  failed: "runner_failed",
  blocked: "runner_failed",
  timeout: "runner_failed",
  cancelled: "runner_cancelled",
};

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_THREAD_SANDBOX = "workspace-write" as const;
const DEFAULT_APPROVAL_POLICY = "never" as const;

const SECRET_KEYS = new Set([
  "token",
  "tokens",
  "secret",
  "credential",
  "credentials",
  "authorization",
  "auth",
  "password",
  "passwd",
  "api_key",
  "apiKey",
  "private_key",
  "privateKey",
]);

const SECRET_VALUE_PATTERN =
  /\b(glpat|gloas|gldt|github_pat|ghp|gho|sk-live|sk-test|sk-)[-A-Za-z0-9_]{6,}|token\s*=\s*[A-Za-z0-9._\-+/=]{6,}/gi;

interface RedactionScope {
  redacted: Set<string>;
}

/**
 * Replace secret-looking substrings inside a free-form text field.
 * Returns `[redactedText, wasRedacted]`.
 */
function redactStringField(value: string): [string, boolean] {
  let redacted = false;
  const next = value.replace(SECRET_VALUE_PATTERN, () => {
    redacted = true;
    return "[REDACTED]";
  });
  return [next, redacted];
}

/**
 * Convert arbitrary Codex notification data into the V4.7
 * `RunnerEvent.data` shape (primitives or null only) while redacting
 * secret-like fields. Nested objects / arrays are dropped to keep the
 * event payload structurally bounded.
 */
function sanitizeEventData(
  raw: unknown,
  pathPrefix: string,
  scope: RedactionScope,
): Record<string, string | number | boolean | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (SECRET_KEYS.has(key)) {
      out[key] = "[REDACTED]";
      scope.redacted.add(fullPath);
      continue;
    }
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value === "string") {
      const [next, wasRedacted] = redactStringField(value);
      if (wasRedacted) scope.redacted.add(fullPath);
      out[key] = next;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    // Drop nested objects / arrays to enforce structural bound.
  }
  return out;
}

interface MergeRequestArtifact {
  iid: number;
  url: string;
  state: "opened" | "merged" | "closed";
}

const isMrState = (
  value: unknown,
): value is MergeRequestArtifact["state"] =>
  value === "opened" || value === "merged" || value === "closed";

function extractMergeRequest(
  result: DriveResult,
): MergeRequestArtifact | undefined {
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
    return {
      iid,
      url: webUrl,
      state: isMrState(state) ? state : "opened",
    };
  }
  return undefined;
}

function classifyFailure(text: string): RunnerErrorCode {
  const lower = text.toLowerCase();
  if (lower.includes("sandbox")) return "sandbox_violation";
  if (lower.includes("denied") || lower.includes("blocked") || lower.includes("not allowed"))
    return "tool_denied";
  return "runner_unavailable";
}

function buildArtifacts(
  result: DriveResult,
  scope: RedactionScope,
  git: { branch?: string; diffStat?: string } | undefined,
): RunnerArtifact[] {
  const artifacts: RunnerArtifact[] = [];
  // V4.7 review H2:`kind: "diff"` artifact 真实承载 git diff stat,
  // agent factory 在没有 diff artifact 时不再用 text artifact 兜底,所以
  // 这里必须独立 emit。读不到 git 状态(无 git / detached HEAD / fs 错)时
  // 跳过 — agent 让 diffSummary 留空,由 report-artifact 决定下游 fallback。
  if (git?.diffStat || git?.branch) {
    const header = git?.branch ? `branch:${git.branch}\n` : "";
    const body = git?.diffStat ?? "";
    const raw = `${header}${body}`;
    if (raw.trim().length > 0) {
      const [summary, wasRedacted] = redactStringField(raw);
      if (wasRedacted)
        scope.redacted.add(`artifacts[${artifacts.length}].summary`);
      artifacts.push({ kind: "diff", summary });
    }
  }
  // `kind: "text"` 仍然承载 Codex 的 final message,但 agent 不再回退当
  // diffSummary 用,避免「LLM 散文 = diff」的污染。
  if (result.finalMessage) {
    const [summary, wasRedacted] = redactStringField(
      `final_message:\n${result.finalMessage}`,
    );
    if (wasRedacted) scope.redacted.add(`artifacts[${artifacts.length}].summary`);
    artifacts.push({ kind: "text", summary });
  }
  // V4.7 review follow-up:即便 driveLifecycle 走的是 failed / cancelled /
  // timeout / blocked 路径,只要 `gitlab_create_merge_request` 工具已经
  // 成功跑过,`completedToolCalls` 就含 MR 数据。把 MR artifact 抽取放在
  // `buildArtifacts` 公共部分,让 failure 路径也能把已经创建的 MR 传给
  // reviewer / handoff,避免「pipeline 后期失败但 MR 真实存在」的视觉黑洞。
  const mr = extractMergeRequest(result);
  if (mr) {
    const [summary, wasRedacted] = redactStringField(
      `merge_request:${mr.iid}:${mr.url}`,
    );
    if (wasRedacted) scope.redacted.add(`artifacts[${artifacts.length}].summary`);
    artifacts.push({ kind: "tool_result", summary });
  }
  return artifacts;
}

/**
 * V4.7 review follow-up:failure / cancelled / timeout 路径下也允许 adapter
 * emit 一个 `kind: "tool_result"` MR artifact,内容来自 `completedToolCalls`。
 * 不调 `buildArtifacts` 是因为 failure 路径没必要再读 worktree git 状态,
 * 也不想顺带带出 `final_message` text artifact。
 */
function buildFailureArtifacts(
  result: DriveResult,
  scope: RedactionScope,
): RunnerArtifact[] {
  const artifacts: RunnerArtifact[] = [];
  const mr = extractMergeRequest(result);
  if (mr) {
    const [summary, wasRedacted] = redactStringField(
      `merge_request:${mr.iid}:${mr.url}`,
    );
    if (wasRedacted) scope.redacted.add(`artifacts[${artifacts.length}].summary`);
    artifacts.push({ kind: "tool_result", summary });
  }
  return artifacts;
}

function buildRunnerError(
  code: RunnerErrorCode,
  reason: string | undefined,
  scope: RedactionScope,
): RunnerError {
  const raw = reason ?? "runner failed without explanation";
  const [message, wasRedacted] = redactStringField(raw);
  if (wasRedacted) scope.redacted.add("error.message");
  return { code, message };
}

async function mapDriveResultToRunnerResult(
  result: DriveResult,
  now: () => string,
  finalMessageOverride: string | undefined,
  scope: RedactionScope,
  cwd: string,
): Promise<RunnerResult> {
  const runId = result.lastTurnId;
  switch (result.status) {
    case "completed": {
      // 只在 completed 状态读 git 状态:其他状态下 worktree 可能已经被
      // cancel/timeout 中断,继续 spawn 子进程没有意义,也无法保证
      // 数据稳定。
      const git = await readWorkspaceGitSummary(cwd);
      const artifacts = buildArtifacts(result, scope, git);
      let finalMessage = finalMessageOverride;
      if (finalMessage === undefined && result.finalMessage !== undefined) {
        const [redactedMsg, wasRedacted] = redactStringField(result.finalMessage);
        if (wasRedacted) scope.redacted.add("finalMessage");
        finalMessage = redactedMsg;
      }
      const out: RunnerResult = {
        status: "completed",
        ...(runId ? { runId } : {}),
        ...(finalMessage !== undefined ? { finalMessage } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
      if (scope.redacted.size > 0) {
        return { ...out, redactedFields: [...scope.redacted] };
      }
      return out;
    }
    case "failed":
    case "blocked": {
      const code = classifyFailure(result.failureReason ?? "");
      const error = buildRunnerError(code, result.failureReason, scope);
      const artifacts = buildFailureArtifacts(result, scope);
      const out: RunnerResult = {
        status: "failed",
        ...(runId ? { runId } : {}),
        error,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
      if (scope.redacted.size > 0) {
        return { ...out, redactedFields: [...scope.redacted] };
      }
      return out;
    }
    case "timeout": {
      const error = buildRunnerError(
        "runner_timeout",
        result.failureReason ?? "runner timed out",
        scope,
      );
      const artifacts = buildFailureArtifacts(result, scope);
      const out: RunnerResult = {
        status: "timeout",
        ...(runId ? { runId } : {}),
        error,
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
      if (scope.redacted.size > 0) {
        return { ...out, redactedFields: [...scope.redacted] };
      }
      return out;
    }
    case "cancelled": {
      const cancelledAt = now();
      const artifacts = buildFailureArtifacts(result, scope);
      const out: RunnerResult = {
        status: "cancelled",
        cancelledAt,
        ...(runId ? { runId } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
      };
      if (scope.redacted.size > 0) {
        return { ...out, redactedFields: [...scope.redacted] };
      }
      return out;
    }
  }
}

function toRunnerEvent(
  type: string,
  data: unknown,
  input: RunnerRunInput,
  runnerId: string,
  now: () => string,
  runId: string | undefined,
): RunnerEvent | undefined {
  const eventType = NOTIFICATION_EVENT_TYPE[type];
  if (!eventType) return undefined;
  const scope: RedactionScope = { redacted: new Set() };
  const sanitized = sanitizeEventData(data, "data", scope);
  let message: string | undefined;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const messageRaw = (data as Record<string, unknown>).message;
    if (typeof messageRaw === "string") {
      const [redactedMsg, wasRedacted] = redactStringField(messageRaw);
      if (wasRedacted) scope.redacted.add("message");
      message = redactedMsg;
    }
  }
  const event: RunnerEvent = {
    type: eventType,
    at: now(),
    runnerId,
    ...(runId !== undefined ? { runnerRunId: runId } : {}),
    pipelineRunId: input.pipelineRunId,
    workItemId: input.workItemId,
    taskId: input.taskId,
    role: input.role,
    ...(message !== undefined ? { message } : {}),
    ...(sanitized && Object.keys(sanitized).length > 0
      ? { data: sanitized }
      : {}),
    redactedFields: [...scope.redacted],
  };
  return event;
}

export function createCodexAppServerAdapter(
  opts: CreateCodexAppServerAdapterOptions,
): RunnerAdapter {
  const now = opts.now ?? ((): string => new Date().toISOString());

  return {
    descriptor: opts.descriptor,
    async run(input, ctx: RunnerRunContext = {}): Promise<RunnerResult> {
      const command =
        opts.descriptor.options?.command ?? opts.codex.command;
      const cmd = splitCommand(command);
      const rpc = spawnRpc({ ...cmd, cwd: input.cwd });
      const maxTurns = opts.descriptor.options?.maxTurns ?? DEFAULT_MAX_TURNS;
      const threadSandbox =
        opts.descriptor.options?.threadSandbox ?? DEFAULT_THREAD_SANDBOX;
      const approvalPolicy =
        opts.descriptor.options?.approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
      const turnTimeoutMs =
        opts.descriptor.options?.turnTimeoutMs ?? opts.codex.turnTimeoutMs;
      const scope: RedactionScope = { redacted: new Set() };
      // Streaming RunnerEvent 必须在每次 turn 开始时就拿到 turnId,
      // 不能等 driveLifecycle resolve. lifecycle emit `turn_started`
      // 事件时已经把 `{ turnId }` 放进 data, 我们在 onEvent 里就地缓存
      // 让后续 `tool_call_*` / `runner_message` 都能带上正确的
      // `RunnerEvent.runnerRunId` (V4.7 review M1).
      let lastTurnId: string | undefined;

      try {
        const result = await driveLifecycle({
          rpc,
          maxTurns,
          prompt: input.prompt,
          title: `${input.workItemId}/${input.taskId}/${input.role}`,
          cwd: input.cwd,
          threadName: `${input.workItemId}/${input.taskId}/${input.role}`,
          sandboxType: threadSandbox,
          approvalPolicy,
          turnSandboxPolicy: opts.codex.turnSandboxPolicy,
          turnTimeoutMs,
          tools: opts.tools ? opts.tools(input) : [],
          onEvent: (type: string, data?: unknown) => {
            if (
              type === "turn_started" &&
              data &&
              typeof data === "object" &&
              !Array.isArray(data)
            ) {
              const candidate = (data as Record<string, unknown>).turnId;
              if (typeof candidate === "string" && candidate.length > 0) {
                lastTurnId = candidate;
              }
            }
            const event = toRunnerEvent(
              type,
              data,
              input,
              opts.descriptor.runnerId,
              now,
              lastTurnId,
            );
            if (event && ctx.events) {
              void ctx.events.emit(event);
            }
          },
          ...(opts.onTurnActive ? { onTurnActive: opts.onTurnActive } : {}),
        });
        // result.lastTurnId 与 onEvent("turn_started") 的 turnId 在
        // happy path 下一致;这里再赋一次只是为了 cancelled / failed 路径
        // 也能在 mapDriveResultToRunnerResult 里看到 runId.
        if (result.lastTurnId) lastTurnId = result.lastTurnId;
        // V4.7 review N-4:在 return RunnerResult 之前主动 emit 一次终态
        // 事件,让监控/dashboard 有「一次 run 一个终态事件」的不变量。
        // 这里直接构造 sanitized RunnerEvent,不走 NOTIFICATION_EVENT_TYPE
        // 表(因为 lifecycle 不发对应的 _ 命名事件)。
        if (ctx.events) {
          const terminalType = TERMINAL_EVENT_TYPE_BY_STATUS[result.status];
          const terminalScope: RedactionScope = { redacted: new Set() };
          let terminalMessage: string | undefined;
          if (result.failureReason) {
            const [redactedMsg, wasRedacted] = redactStringField(
              result.failureReason,
            );
            if (wasRedacted) terminalScope.redacted.add("message");
            terminalMessage = redactedMsg;
          }
          const terminalEvent: RunnerEvent = {
            type: terminalType,
            at: now(),
            runnerId: opts.descriptor.runnerId,
            ...(lastTurnId !== undefined
              ? { runnerRunId: lastTurnId }
              : {}),
            pipelineRunId: input.pipelineRunId,
            workItemId: input.workItemId,
            taskId: input.taskId,
            role: input.role,
            ...(terminalMessage !== undefined
              ? { message: terminalMessage }
              : {}),
            redactedFields: [...terminalScope.redacted],
          };
          void ctx.events.emit(terminalEvent);
        }
        return mapDriveResultToRunnerResult(
          result,
          now,
          undefined,
          scope,
          input.cwd,
        );
      } finally {
        await rpc.close();
      }
    },
  };
}

// Re-export for daemon imports
export { redactStringField as __testRedactStringField };
