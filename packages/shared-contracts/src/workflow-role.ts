/**
 * V4.6 Multi-Agent Collaboration workflow role 配置契约。
 *
 * 严格按 spec §10 定义 sandbox / tools / severity threshold 等枚举；
 * `parseRoleConfig` 把 YAML on-disk snake_case（`prompt_template` /
 * `severity_threshold` / `max_inline_comments` / `timeout_seconds` /
 * `publish_to_mr` / `token_scope_requirements`）映射成 TS in-memory
 * camelCase（`promptTemplate` / `severityThreshold` / `maxInlineComments`
 * / `timeoutSeconds` / `publishToMr` / `tokenScopeRequirements`）。
 *
 * 上层 workflow loader（`packages/workflow/`）调用本工具解析 YAML
 * 输入；orchestrator 在 pipeline coordinator 中复用本契约。
 *
 * Source: docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md
 */

import { type AgentRole } from "./agent-report.js";

/** spec §10：role.sandbox 三项受限枚举（snake_case）。 */
export const WORKFLOW_SANDBOX_VALUES = [
  "read_write_worktree",
  "read_only_worktree",
  "read_only_source_write_evidence",
] as const;
export type WorkflowSandbox = (typeof WORKFLOW_SANDBOX_VALUES)[number];

export const isWorkflowSandbox = (value: unknown): value is WorkflowSandbox =>
  typeof value === "string" &&
  (WORKFLOW_SANDBOX_VALUES as readonly string[]).includes(value);

/** spec §10：tool 白名单 7 项。 */
export const WORKFLOW_TOOL_NAME_VALUES = [
  "gitlab.create_mr",
  "gitlab.update_mr",
  "gitlab.read_mr",
  "gitlab.note_inline",
  "run.command",
  "playwright.walkthrough",
  "evidence.collect",
] as const;
export type WorkflowToolName = (typeof WORKFLOW_TOOL_NAME_VALUES)[number];

export const isWorkflowToolName = (
  value: unknown,
): value is WorkflowToolName =>
  typeof value === "string" &&
  (WORKFLOW_TOOL_NAME_VALUES as readonly string[]).includes(value);

/** spec §10：tool 白名单条目。`allow` 仅在 `name = "run.command"` 时可用。 */
export interface WorkflowToolGrant {
  name: WorkflowToolName;
  allow?: string[];
}

/** spec §11：reviewer severity threshold 默认 medium。 */
export const REVIEWER_SEVERITY_THRESHOLD_VALUES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type ReviewerSeverityThreshold =
  (typeof REVIEWER_SEVERITY_THRESHOLD_VALUES)[number];

export const isReviewerSeverityThreshold = (
  value: unknown,
): value is ReviewerSeverityThreshold =>
  typeof value === "string" &&
  (REVIEWER_SEVERITY_THRESHOLD_VALUES as readonly string[]).includes(value);

/** spec §10：所有角色共用的 base config（YAML 已映射成 camelCase）。 */
export interface WorkflowRoleConfigBase {
  role: AgentRole;
  promptTemplate: string;
  /**
   * Resolve 阶段计算并填入的 prompt template sha256。orchestrator 在
   * AgentReport 中写入此 hash 供复现追溯（spec §8.2 / §10）。
   * parse 阶段为 undefined，由 `packages/workflow/resolve.ts` 填充。
   */
  promptTemplateHash?: string;
  sandbox: WorkflowSandbox;
  tools?: WorkflowToolGrant[];
  timeoutSeconds?: number;
  /** workflow YAML `tracker.token_scope_requirements`，role-level override 可选。 */
  tokenScopeRequirements?: string[];
}

export interface CoderRoleConfig extends WorkflowRoleConfigBase {
  role: "coder";
}

export interface ReviewerRoleConfig extends WorkflowRoleConfigBase {
  role: "reviewer";
  /** 默认 true（spec §10）。 */
  publishToMr?: boolean;
  /** 默认 `medium`（spec §10）。 */
  severityThreshold?: ReviewerSeverityThreshold;
  /** 默认 25（spec §10）。 */
  maxInlineComments?: number;
}

export interface TestEvidenceRoleConfig extends WorkflowRoleConfigBase {
  role: "test_evidence";
}

export type WorkflowRoleConfig =
  | CoderRoleConfig
  | ReviewerRoleConfig
  | TestEvidenceRoleConfig;

/** 一份完整的 V4.6 roles 配置（YAML 顶层 `roles:` 节）。 */
export interface WorkflowRolesConfig {
  coder?: CoderRoleConfig;
  reviewer?: ReviewerRoleConfig;
  test_evidence?: TestEvidenceRoleConfig;
}

/** spec §10：workflow YAML 解析阶段的错误码枚举。 */
export type WorkflowConfigErrorCode =
  | "missing_prompt_template"
  | "unknown_sandbox"
  | "unknown_tool"
  | "tool_allow_only_for_run_command"
  | "tool_allow_wildcard_disallowed"
  | "global_wildcard_disallowed"
  | "invalid_severity_threshold"
  | "invalid_token_scope_requirements"
  | "invalid_timeout_seconds"
  | "invalid_max_inline_comments";

export class WorkflowConfigError extends Error {
  constructor(
    public readonly code: WorkflowConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowConfigError";
  }
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isFullWildcard = (token: string): boolean => token === "*";

const validateToolAllow = (allow: string[]): void => {
  for (const entry of allow) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new WorkflowConfigError(
        "tool_allow_wildcard_disallowed",
        `run.command allow entry must be a non-empty string`,
      );
    }
    const tokens = entry.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.every(isFullWildcard)) {
      throw new WorkflowConfigError(
        "tool_allow_wildcard_disallowed",
        `run.command allow entry cannot be a full wildcard ("${entry}")`,
      );
    }
  }
};

const parseToolGrant = (raw: unknown): WorkflowToolGrant => {
  if (!raw || typeof raw !== "object") {
    throw new WorkflowConfigError(
      "unknown_tool",
      `tool entry must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!isWorkflowToolName(obj.name)) {
    throw new WorkflowConfigError(
      "unknown_tool",
      `unknown tool name: ${JSON.stringify(obj.name)}`,
    );
  }
  const tool: WorkflowToolGrant = { name: obj.name };
  if (obj.allow !== undefined) {
    if (tool.name !== "run.command") {
      throw new WorkflowConfigError(
        "tool_allow_only_for_run_command",
        `tool "${tool.name}" does not accept allow[]; only run.command may`,
      );
    }
    if (!isStringArray(obj.allow)) {
      throw new WorkflowConfigError(
        "tool_allow_wildcard_disallowed",
        `tool allow[] must be an array of strings`,
      );
    }
    validateToolAllow(obj.allow);
    tool.allow = [...obj.allow];
  }
  return tool;
};

const parseTools = (raw: unknown): WorkflowToolGrant[] | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new WorkflowConfigError(
      "unknown_tool",
      `tools must be an array of tool grant objects`,
    );
  }
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (entry === "*") {
        throw new WorkflowConfigError(
          "global_wildcard_disallowed",
          `tools: ["*"] is not allowed; use explicit tool names`,
        );
      }
      throw new WorkflowConfigError(
        "unknown_tool",
        `tools entries must be objects with a name field`,
      );
    }
  }
  return raw.map(parseToolGrant);
};

const requireNumber = (
  value: unknown,
  field: string,
  code: WorkflowConfigErrorCode,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new WorkflowConfigError(
      code,
      `${field} must be a positive number; got ${JSON.stringify(value)}`,
    );
  }
  return value;
};

/**
 * 把 YAML 解析后的 raw object（snake_case）转换为 TS 端的
 * camelCase WorkflowRoleConfig。
 */
export const parseRoleConfig = (input: {
  role: AgentRole;
  raw: Record<string, unknown>;
}): WorkflowRoleConfig => {
  const { role, raw } = input;

  if (typeof raw.prompt_template !== "string" || raw.prompt_template.length === 0) {
    throw new WorkflowConfigError(
      "missing_prompt_template",
      `roles.${role}.prompt_template is required`,
    );
  }
  if (!isWorkflowSandbox(raw.sandbox)) {
    throw new WorkflowConfigError(
      "unknown_sandbox",
      `roles.${role}.sandbox must be one of ${WORKFLOW_SANDBOX_VALUES.join(
        ", ",
      )}; got ${JSON.stringify(raw.sandbox)}`,
    );
  }

  const tools = parseTools(raw.tools);

  let timeoutSeconds: number | undefined;
  if (raw.timeout_seconds !== undefined) {
    timeoutSeconds = requireNumber(
      raw.timeout_seconds,
      `roles.${role}.timeout_seconds`,
      "invalid_timeout_seconds",
    );
  }

  let tokenScopeRequirements: string[] | undefined;
  if (raw.token_scope_requirements !== undefined) {
    if (!isStringArray(raw.token_scope_requirements)) {
      throw new WorkflowConfigError(
        "invalid_token_scope_requirements",
        `roles.${role}.token_scope_requirements must be an array of strings`,
      );
    }
    tokenScopeRequirements = [...raw.token_scope_requirements];
  }

  const base: WorkflowRoleConfigBase = {
    role,
    promptTemplate: raw.prompt_template,
    sandbox: raw.sandbox,
    ...(tools ? { tools } : {}),
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    ...(tokenScopeRequirements ? { tokenScopeRequirements } : {}),
  };

  if (role === "reviewer") {
    let severityThreshold: ReviewerSeverityThreshold | undefined;
    if (raw.severity_threshold !== undefined) {
      if (!isReviewerSeverityThreshold(raw.severity_threshold)) {
        throw new WorkflowConfigError(
          "invalid_severity_threshold",
          `roles.reviewer.severity_threshold must be one of ${REVIEWER_SEVERITY_THRESHOLD_VALUES.join(
            ", ",
          )}; got ${JSON.stringify(raw.severity_threshold)}`,
        );
      }
      severityThreshold = raw.severity_threshold;
    }
    let maxInlineComments: number | undefined;
    if (raw.max_inline_comments !== undefined) {
      maxInlineComments = requireNumber(
        raw.max_inline_comments,
        `roles.reviewer.max_inline_comments`,
        "invalid_max_inline_comments",
      );
    }
    return {
      ...base,
      role: "reviewer",
      ...(raw.publish_to_mr !== undefined
        ? { publishToMr: Boolean(raw.publish_to_mr) }
        : {}),
      ...(severityThreshold !== undefined ? { severityThreshold } : {}),
      ...(maxInlineComments !== undefined ? { maxInlineComments } : {}),
    };
  }

  return {
    ...base,
    role,
  } as WorkflowRoleConfig;
};
