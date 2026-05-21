/**
 * V4.7 Runner Adapter Contract.
 *
 * Runner 是 V4.7 把 Codex-specific lifecycle 抽象成的稳定本地执行器接口。
 * orchestrator 在 workflow `runners:` registry + `roles.<role>.runner` 选择
 * 出某个 `RunnerDescriptor`，并通过 adapter 的 `run()` 把 prompt / sandbox
 * 收集成 `RunnerResult`；agent factory 再把 `RunnerResult` 转成 role
 * specific `AgentReport`。
 *
 * 本文件只定义契约：枚举、形态、type guard。不 import workflow loader、
 * orchestrator、Codex RPC 或 filesystem store。
 *
 * Source: docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md
 */

import { type AgentRole, isAgentRole } from "./agent-report.js";
import {
  type WorkflowSandbox,
  type WorkflowToolGrant,
  isWorkflowSandbox,
} from "./workflow-role.js";

/** V4.7 仅支持单一 runner kind：`codex_app_server`。 */
export const RUNNER_KIND_VALUES = ["codex_app_server"] as const;
export type RunnerKind = (typeof RUNNER_KIND_VALUES)[number];

const includesString = <T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isRunnerKind = (value: unknown): value is RunnerKind =>
  includesString(RUNNER_KIND_VALUES, value);

/**
 * Capability 是 runner 声明可承担的能力集合，resolver 用它做静态校验，
 * 避免 runner 接到不支持的 role / sandbox / tool。
 */
export const RUNNER_CAPABILITY_VALUES = [
  "roles.coder",
  "roles.reviewer",
  "roles.test_evidence",
  "events.streaming",
  "cancel",
  "artifacts",
  "gitlab.tools",
  "filesystem.readonly",
  "filesystem.worktree_write",
] as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITY_VALUES)[number];

export const isRunnerCapability = (value: unknown): value is RunnerCapability =>
  includesString(RUNNER_CAPABILITY_VALUES, value);

/** Map 角色到对应的 runner capability key。 */
export const runnerCapabilityForRole = (role: AgentRole): RunnerCapability => {
  switch (role) {
    case "coder":
      return "roles.coder";
    case "reviewer":
      return "roles.reviewer";
    case "test_evidence":
      return "roles.test_evidence";
  }
};

/**
 * `codex_app_server` adapter 接受的选项 allowlist。
 * - 不允许 env / token / secret / credential / cwd / workspaceRoot 等敏感或
 *   会破坏 worktree 限定的字段；workflow parser 在加载阶段拒绝它们。
 * - V4.7 之后扩展第二 runner 时再为新 kind 单独定义 options 类型。
 */
export interface CodexAppServerRunnerOptions {
  command?: string;
  maxTurns?: number;
  turnTimeoutMs?: number;
  approvalPolicy?: "never";
  threadSandbox?: "workspace-write";
}

export interface RunnerDescriptor {
  runnerId: string;
  kind: RunnerKind;
  displayName?: string;
  capabilities: RunnerCapability[];
  defaultTimeoutSeconds?: number;
  options?: CodexAppServerRunnerOptions;
}

export interface RunnerRunInput {
  runnerId: string;
  role: AgentRole;
  prompt: string;
  cwd: string;
  workItemId: string;
  taskId: string;
  pipelineRunId: string;
  roleProfileId: string;
  timeoutSeconds?: number;
  toolAllow: WorkflowToolGrant[];
  sandbox: WorkflowSandbox;
  metadata: Record<string, string | number | boolean>;
}

export const RUNNER_ARTIFACT_KIND_VALUES = [
  "text",
  "diff",
  "evidence",
  "log",
  "tool_result",
] as const;
export type RunnerArtifactKind = (typeof RUNNER_ARTIFACT_KIND_VALUES)[number];

export interface RunnerArtifact {
  kind: RunnerArtifactKind;
  path?: string;
  mimeType?: string;
  summary?: string;
}

export const RUNNER_ERROR_CODE_VALUES = [
  "runner_unavailable",
  "runner_timeout",
  "sandbox_violation",
  "capability_missing",
  "tool_denied",
  "output_unparseable",
  "artifact_collection_failed",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODE_VALUES)[number];

export const isRunnerErrorCode = (value: unknown): value is RunnerErrorCode =>
  includesString(RUNNER_ERROR_CODE_VALUES, value);

export interface RunnerError {
  code: RunnerErrorCode;
  message: string;
  hint?: string;
}

export interface RunnerResultBase {
  redactedFields?: string[];
}

export interface RunnerResultCompleted extends RunnerResultBase {
  status: "completed";
  finalMessage?: string;
  runId?: string;
  artifacts?: RunnerArtifact[];
}

export interface RunnerResultFailed extends RunnerResultBase {
  status: "failed";
  error: RunnerError;
  runId?: string;
  artifacts?: RunnerArtifact[];
}

export interface RunnerResultCancelled extends RunnerResultBase {
  status: "cancelled";
  cancelledAt: string;
  runId?: string;
  // V4.7 review follow-up:即便 run 被 cancel,如果 coder 之前已经成功
  // 调过 `gitlab_create_merge_request`,artifact 流仍然要把 MR 透给
  // reviewer / handoff,避免"已建 MR 但 pipeline 中途取消"导致 MR 黑洞。
  artifacts?: RunnerArtifact[];
}

export interface RunnerResultTimeout extends RunnerResultBase {
  status: "timeout";
  error: RunnerError;
  runId?: string;
  // V4.7 review follow-up:见 `RunnerResultCancelled.artifacts` 注释。
  artifacts?: RunnerArtifact[];
}

export type RunnerResult =
  | RunnerResultCompleted
  | RunnerResultFailed
  | RunnerResultCancelled
  | RunnerResultTimeout;

export const RUNNER_EVENT_TYPE_VALUES = [
  "runner_started",
  "turn_started",
  "tool_call_started",
  "tool_call_completed",
  "runner_message",
  "runner_completed",
  "runner_failed",
  "runner_cancelled",
] as const;
export type RunnerEventType = (typeof RUNNER_EVENT_TYPE_VALUES)[number];

export const isRunnerEventType = (value: unknown): value is RunnerEventType =>
  includesString(RUNNER_EVENT_TYPE_VALUES, value);

export interface RunnerEvent {
  type: RunnerEventType;
  at: string;
  runnerId: string;
  runnerRunId?: string;
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  role: AgentRole;
  message?: string;
  data?: Record<string, string | number | boolean | null>;
  redactedFields: string[];
}

const isPrimitiveOrNull = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isRunnerArtifact = (value: unknown): value is RunnerArtifact => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!includesString(RUNNER_ARTIFACT_KIND_VALUES, obj.kind)) return false;
  if (obj.path !== undefined && typeof obj.path !== "string") return false;
  if (obj.mimeType !== undefined && typeof obj.mimeType !== "string")
    return false;
  if (obj.summary !== undefined && typeof obj.summary !== "string")
    return false;
  return true;
};

const isCodexAppServerOptions = (
  value: unknown,
): value is CodexAppServerRunnerOptions => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj.command !== undefined && typeof obj.command !== "string") return false;
  if (obj.maxTurns !== undefined && typeof obj.maxTurns !== "number")
    return false;
  if (obj.turnTimeoutMs !== undefined && typeof obj.turnTimeoutMs !== "number")
    return false;
  if (obj.approvalPolicy !== undefined && obj.approvalPolicy !== "never")
    return false;
  if (
    obj.threadSandbox !== undefined &&
    obj.threadSandbox !== "workspace-write"
  )
    return false;
  return true;
};

export const isRunnerDescriptor = (value: unknown): value is RunnerDescriptor => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.runnerId !== "string" || obj.runnerId.length === 0) return false;
  if (!isRunnerKind(obj.kind)) return false;
  if (obj.displayName !== undefined && typeof obj.displayName !== "string")
    return false;
  if (!Array.isArray(obj.capabilities)) return false;
  if (!obj.capabilities.every(isRunnerCapability)) return false;
  if (
    obj.defaultTimeoutSeconds !== undefined &&
    typeof obj.defaultTimeoutSeconds !== "number"
  )
    return false;
  if (!isCodexAppServerOptions(obj.options)) return false;
  return true;
};

const isRunnerError = (value: unknown): value is RunnerError => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!isRunnerErrorCode(obj.code)) return false;
  if (typeof obj.message !== "string") return false;
  if (obj.hint !== undefined && typeof obj.hint !== "string") return false;
  return true;
};

const isOptionalArtifacts = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every(isRunnerArtifact);
};

const isOptionalRedactedFields = (value: unknown): boolean => {
  if (value === undefined) return true;
  return isStringArray(value);
};

export const isRunnerResult = (value: unknown): value is RunnerResult => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!isOptionalRedactedFields(obj.redactedFields)) return false;
  if (obj.runId !== undefined && typeof obj.runId !== "string") return false;
  switch (obj.status) {
    case "completed":
      if (
        obj.finalMessage !== undefined &&
        typeof obj.finalMessage !== "string"
      )
        return false;
      return isOptionalArtifacts(obj.artifacts);
    case "failed":
      if (!isRunnerError(obj.error)) return false;
      return isOptionalArtifacts(obj.artifacts);
    case "cancelled":
      return typeof obj.cancelledAt === "string";
    case "timeout":
      return isRunnerError(obj.error);
    default:
      return false;
  }
};

const isRunnerEventData = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isPrimitiveOrNull);
};

export const isRunnerEvent = (value: unknown): value is RunnerEvent => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!isRunnerEventType(obj.type)) return false;
  if (typeof obj.at !== "string") return false;
  if (typeof obj.runnerId !== "string") return false;
  if (obj.runnerRunId !== undefined && typeof obj.runnerRunId !== "string")
    return false;
  if (typeof obj.pipelineRunId !== "string") return false;
  if (typeof obj.workItemId !== "string") return false;
  if (typeof obj.taskId !== "string") return false;
  if (!isAgentRole(obj.role)) return false;
  if (obj.message !== undefined && typeof obj.message !== "string") return false;
  if (!isRunnerEventData(obj.data)) return false;
  if (!isStringArray(obj.redactedFields)) return false;
  return true;
};

/** Sandbox 到必需 filesystem capability 的映射。 */
export const filesystemCapabilitiesForSandbox = (
  sandbox: WorkflowSandbox,
): RunnerCapability[] => {
  switch (sandbox) {
    case "read_write_worktree":
      return ["filesystem.worktree_write"];
    case "read_only_worktree":
      return ["filesystem.readonly", "filesystem.worktree_write"];
    case "read_only_source_write_evidence":
      return ["filesystem.readonly", "filesystem.worktree_write"];
  }
};

/**
 * Workflow resolver / runner registry 共用：列出某个 role 对应的必需
 * capability 集合。`filesystem.*` 给出 OR 集合（resolver 校验任一存在即可），
 * 其余必须全部出现。
 */
export interface RoleCapabilityRequirements {
  required: RunnerCapability[];
  anyOfFilesystem: RunnerCapability[];
}

export const requiredCapabilitiesForRole = (input: {
  role: AgentRole;
  sandbox: WorkflowSandbox;
  needsArtifacts?: boolean;
  needsGitlabTools?: boolean;
}): RoleCapabilityRequirements => {
  const required: RunnerCapability[] = [runnerCapabilityForRole(input.role)];
  if (input.needsArtifacts) required.push("artifacts");
  if (input.needsGitlabTools) required.push("gitlab.tools");
  // sandbox sanity check (used by resolver indirectly)
  isWorkflowSandbox(input.sandbox);
  return {
    required,
    anyOfFilesystem: filesystemCapabilitiesForSandbox(input.sandbox),
  };
};
