import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_RETENTION_CONFIG,
  RUNNER_CAPABILITY_VALUES,
  WORKFLOW_RECIPE_VALUES,
  WorkflowConfigError as RoleConfigError,
  isRunnerCapability,
  isRunnerKind,
  parseRoleConfig,
  type AgentRole,
  type ClaudeCodeRunnerOptions,
  type CodexAppServerRunnerOptions,
  type RetentionConfig,
  type RunnerCapability,
  type RunnerDescriptor,
  type RunnerKind,
  type WorkflowRecipe,
  type WorkflowRoleConfig,
  type WorkflowRolesConfig,
} from "@issuepilot/shared-contracts";
import matter from "gray-matter";
import YAML from "yaml";
import { z, type ZodIssue } from "zod";

import type {
  AgentConfig,
  CiConfig,
  CodexConfig,
  GitConfig,
  HooksConfig,
  TrackerConfig,
  WorkflowConfig,
  WorkflowConfigWarning,
  WorkflowSource,
  WorkspaceConfig,
} from "./types.js";

/**
 * V4.6 spec §10：缺 `roles:` 时 fallback 到一份内置 best-effort 默认
 * profile（仅 P0 提供；P1 之后会推动每个项目显式声明 roles）。
 * V4.7：默认 role 自动绑定到 `codex_app_server` runner id。
 */
const DEFAULT_ROLES_CONFIG: WorkflowRolesConfig = {
  coder: {
    role: "coder",
    runner: "codex_app_server",
    promptTemplate: "prompts/coder.md",
    sandbox: "read_write_worktree",
    timeoutSeconds: 1800,
  },
  reviewer: {
    role: "reviewer",
    runner: "codex_app_server",
    promptTemplate: "prompts/reviewer.md",
    sandbox: "read_only_worktree",
    publishToMr: true,
    severityThreshold: "medium",
    maxInlineComments: 25,
    timeoutSeconds: 900,
  },
  test_evidence: {
    role: "test_evidence",
    runner: "codex_app_server",
    promptTemplate: "prompts/test-evidence.md",
    sandbox: "read_only_source_write_evidence",
    timeoutSeconds: 1200,
  },
};

/**
 * V4.7：缺 `runners:` 时 fallback 到一份内置 codex app-server descriptor。
 * 包含所有三个角色 + 流式事件 + cancel + artifacts + GitLab tools +
 * worktree filesystem write，覆盖默认 role 的所有 capability 需求。
 */
const DEFAULT_RUNNERS_CONFIG: Record<string, RunnerDescriptor> = {
  codex_app_server: {
    runnerId: "codex_app_server",
    kind: "codex_app_server",
    displayName: "Codex App Server",
    capabilities: [
      "roles.coder",
      "roles.reviewer",
      "roles.test_evidence",
      "events.streaming",
      "cancel",
      "artifacts",
      "gitlab.tools",
      "filesystem.worktree_write",
    ],
    defaultTimeoutSeconds: 1800,
    options: {
      command: "codex app-server",
      maxTurns: 20,
      turnTimeoutMs: 3_600_000,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
    },
  },
};

/** YAML role keys allowed under V4.7 `roles.<role>` 节。 */
const ALLOWED_ROLE_KEYS_COMMON = new Set([
  "runner",
  "prompt_template",
  "sandbox",
  "tools",
  "timeout_seconds",
  "token_scope_requirements",
]);

const ALLOWED_ROLE_KEYS_REVIEWER_EXTRA = new Set([
  "publish_to_mr",
  "severity_threshold",
  "max_inline_comments",
]);

/**
 * V4.7：当 workflow 显式声明 `runners:` 时，role 不允许携带 legacy runner
 * 覆盖键（spec §3 cutover rule）。这里集中拒绝，避免 V4.6 升级时残留覆盖
 * 让 runner 选择来源出现两个 truth source。
 */
const LEGACY_RUNNER_KEYS = new Set([
  "runner_kind",
  "runner_options",
  "codex",
  "agent",
  "command",
  "max_turns",
  "turn_timeout_ms",
]);

/** V4.8：runner.options 中明确禁止的 key（敏感或破坏 worktree 边界）。 */
const FORBIDDEN_RUNNER_OPTION_KEYS = new Set([
  "env",
  "token",
  "secret",
  "credential",
  "cwd",
  "workspace_root",
  "workspaceRoot",
  "repo_root",
  "repoRoot",
  "shell",
  "args",
  "script",
  "stdin_template",
  "stdinTemplate",
]);

const ENV_VAR_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Thrown when a workflow file cannot be loaded or fails validation.
 *
 * `path` points at the offending field using dot-notation (e.g.
 * `tracker.project_id`), or one of the sentinel values:
 *
 * - `<file>`     — the file itself could not be read.
 * - `<front-matter>` — YAML front matter failed to parse.
 */
export class WorkflowConfigError extends Error {
  override readonly name = "WorkflowConfigError";

  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const TrackerSchema = z.object({
  kind: z.literal("gitlab"),
  base_url: z.string().url(),
  project_id: z.string().min(1),
  // Optional: omitted means "rely on `issuepilot auth login` OAuth
  // credentials". When provided it must be a syntactically valid env var
  // name; the value is resolved at runtime.
  token_env: z
    .string()
    .regex(ENV_VAR_NAME_REGEX, "must be a valid environment variable name")
    .optional(),
  /**
   * V4.6 spec §10：可选 token scope 要求列表。当 reviewer 启动前的
   * scope probe 调用 GitLab `/personal_access_tokens/self` 时，缺少
   * 此处任一 scope 视为 `cannot_review`。
   */
  token_scope_requirements: z.array(z.string().min(1)).optional(),
  active_labels: z
    .array(z.string().min(1))
    .min(1)
    .default(["ai-ready", "ai-rework"]),
  running_label: z.string().min(1).default("ai-running"),
  handoff_label: z.string().min(1).default("human-review"),
  failed_label: z.string().min(1).default("ai-failed"),
  blocked_label: z.string().min(1).default("ai-blocked"),
  rework_label: z.string().min(1).default("ai-rework"),
  merging_label: z.string().min(1).default("ai-merging"),
});

const WorkspaceSchema = z
  .object({
    root: z.string().min(1).default("~/.issuepilot/workspaces"),
    strategy: z.literal("worktree").default("worktree"),
    repo_cache_root: z.string().min(1).default("~/.issuepilot/repos"),
  })
  .prefault({});

const GitSchema = z.object({
  repo_url: z.string().min(1),
  base_branch: z.string().min(1).default("main"),
  branch_prefix: z.string().min(1).default("ai"),
});

const AgentSchema = z
  .object({
    runner: z.literal("codex-app-server").default("codex-app-server"),
    max_concurrent_agents: z.number().int().min(1).default(1),
    max_turns: z.number().int().min(1).default(10),
    max_attempts: z.number().int().min(1).default(2),
    retry_backoff_ms: z.number().int().min(0).default(30_000),
  })
  .prefault({});

const CodexSchema = z
  .object({
    command: z.string().min(1).default("codex app-server"),
    approval_policy: z
      .enum(["never", "untrusted", "on-request"])
      .default("never"),
    thread_sandbox: z
      .enum(["workspace-write", "read-only"])
      .default("workspace-write"),
    turn_timeout_ms: z.number().int().min(1_000).default(3_600_000),
    turn_sandbox_policy: z
      .object({
        type: z.enum(["workspaceWrite", "readOnly"]).default("workspaceWrite"),
      })
      .prefault({}),
  })
  .prefault({});

const HooksSchema = z
  .object({
    after_create: z.string().min(1).optional(),
    before_run: z.string().min(1).optional(),
    after_run: z.string().min(1).optional(),
  })
  .prefault({});

const CiSchema = z
  .object({
    enabled: z.boolean().default(false),
    on_failure: z.enum(["ai-rework", "human-review"]).default("ai-rework"),
    wait_for_pipeline: z.boolean().default(true),
  })
  .prefault({});

const RetentionSchema = z
  .object({
    successful_run_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RETENTION_CONFIG.successfulRunDays),
    failed_run_days: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_RETENTION_CONFIG.failedRunDays),
    max_workspace_gb: z
      .number()
      .min(0)
      .default(DEFAULT_RETENTION_CONFIG.maxWorkspaceGb),
    // 60s floor matches the team-config zod rule; below that the daemon
    // would re-`du` faster than the main poll loop and starve dispatch.
    cleanup_interval_ms: z
      .number()
      .int()
      .min(60_000)
      .default(DEFAULT_RETENTION_CONFIG.cleanupIntervalMs),
  })
  .prefault({});

const WorkflowFrontMatterSchema = z.object({
  tracker: TrackerSchema,
  workspace: WorkspaceSchema,
  git: GitSchema,
  agent: AgentSchema,
  codex: CodexSchema,
  hooks: HooksSchema,
  ci: CiSchema,
  retention: RetentionSchema,
  poll_interval_ms: z.number().int().min(1_000).default(10_000),
  /**
   * V4.6 spec §10：顶层 `default_recipe` 字段。缺省时 fallback 到
   * `full_pipeline`（parse 时同时 emit warning，提示运维者升级）。
   */
  default_recipe: z.enum(WORKFLOW_RECIPE_VALUES).optional(),
  /**
   * V4.6 spec §10：顶层 `roles:` 节。缺省时 fallback 到内置默认 role
   * profile，emit warning。这里只做 schema 级粗校验（必须是 object），
   * 真正的字段校验交由 shared-contracts 的 `parseRoleConfig`。
   */
  roles: z
    .object({
      coder: z.record(z.string(), z.unknown()).optional(),
      reviewer: z.record(z.string(), z.unknown()).optional(),
      test_evidence: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /**
   * V4.7 spec §3：顶层 `runners:` registry，每个条目 raw shape 由
   * `buildRunnersConfig()` 手工校验，错误消息能精确到 `runners.<id>.options`。
   */
  runners: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});

type WorkflowFrontMatter = z.infer<typeof WorkflowFrontMatterSchema>;

/**
 * Parse a WORKFLOW.md-compatible file into a typed {@link WorkflowConfig}.
 *
 * Throws {@link WorkflowConfigError} for IO errors, YAML errors, or any
 * Zod validation failure; in the validation case `error.path` mirrors the
 * snake_case YAML path so it can be surfaced to the user as-is.
 */
export async function parseWorkflowFile(
  filePath: string,
): Promise<WorkflowConfig> {
  const raw = await readWorkflowFile(filePath);
  return parseWorkflowString(raw, filePath);
}

/**
 * Parse an in-memory WORKFLOW.md-compatible payload into a typed
 * {@link WorkflowConfig}. Used by the central workflow compiler so a
 * generated effective workflow can be validated without round-tripping
 * through disk; `sourcePath` is recorded on `source.path` verbatim
 * (typically pointing at a virtual `.generated/<project>.workflow.md`).
 */
export function parseWorkflowString(
  raw: string,
  sourcePath: string,
): WorkflowConfig {
  const parsed = parseFrontMatter(raw);
  const fm = validateFrontMatter(parsed.data);

  const promptTemplate = parsed.content.replace(/^\n+/, "");
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  return buildWorkflowConfig(fm, promptTemplate, {
    path: sourcePath,
    sha256,
    loadedAt: new Date().toISOString(),
  });
}

function buildWorkflowConfig(
  fm: WorkflowFrontMatter,
  promptTemplate: string,
  source: WorkflowSource,
): WorkflowConfig {
  const warnings: WorkflowConfigWarning[] = [];

  const tracker: TrackerConfig = {
    kind: fm.tracker.kind,
    baseUrl: fm.tracker.base_url,
    projectId: fm.tracker.project_id,
    ...(fm.tracker.token_env ? { tokenEnv: fm.tracker.token_env } : {}),
    ...(fm.tracker.token_scope_requirements
      ? { tokenScopeRequirements: [...fm.tracker.token_scope_requirements] }
      : {}),
    activeLabels: fm.tracker.active_labels,
    runningLabel: fm.tracker.running_label,
    handoffLabel: fm.tracker.handoff_label,
    failedLabel: fm.tracker.failed_label,
    blockedLabel: fm.tracker.blocked_label,
    reworkLabel: fm.tracker.rework_label,
    mergingLabel: fm.tracker.merging_label,
  };

  const workspace: WorkspaceConfig = {
    root: fm.workspace.root,
    strategy: fm.workspace.strategy,
    repoCacheRoot: fm.workspace.repo_cache_root,
  };

  const git: GitConfig = {
    repoUrl: fm.git.repo_url,
    baseBranch: fm.git.base_branch,
    branchPrefix: fm.git.branch_prefix,
  };

  const agent: AgentConfig = {
    runner: fm.agent.runner,
    maxConcurrentAgents: fm.agent.max_concurrent_agents,
    maxTurns: fm.agent.max_turns,
    maxAttempts: fm.agent.max_attempts,
    retryBackoffMs: fm.agent.retry_backoff_ms,
  };

  const codex: CodexConfig = {
    command: fm.codex.command,
    approvalPolicy: fm.codex.approval_policy,
    threadSandbox: fm.codex.thread_sandbox,
    turnTimeoutMs: fm.codex.turn_timeout_ms,
    turnSandboxPolicy: { type: fm.codex.turn_sandbox_policy.type },
  };

  const hooks: HooksConfig = {};
  if (fm.hooks.after_create !== undefined) {
    hooks.afterCreate = fm.hooks.after_create;
  }
  if (fm.hooks.before_run !== undefined) {
    hooks.beforeRun = fm.hooks.before_run;
  }
  if (fm.hooks.after_run !== undefined) {
    hooks.afterRun = fm.hooks.after_run;
  }

  const ci: CiConfig = {
    enabled: fm.ci.enabled,
    onFailure: fm.ci.on_failure,
    waitForPipeline: fm.ci.wait_for_pipeline,
  };

  const retention: RetentionConfig = {
    successfulRunDays: fm.retention.successful_run_days,
    failedRunDays: fm.retention.failed_run_days,
    maxWorkspaceGb: fm.retention.max_workspace_gb,
    cleanupIntervalMs: fm.retention.cleanup_interval_ms,
  };

  const defaultRecipe: WorkflowRecipe =
    fm.default_recipe ?? "full_pipeline";
  if (!fm.default_recipe) {
    warnings.push({
      code: "default_recipe_missing",
      path: "default_recipe",
      message:
        "default_recipe 未声明，已 fallback 到 full_pipeline；若想保留 V4.5 旧行为，请显式声明 coding_only。",
    });
  }

  const runners = buildRunnersConfig(fm.runners, warnings);
  const runnersDeclared = fm.runners !== undefined;
  const roles = buildRolesConfig(fm.roles, warnings, runnersDeclared);

  const config: WorkflowConfig = {
    tracker,
    workspace,
    git,
    agent,
    codex,
    hooks,
    ci,
    retention,
    pollIntervalMs: fm.poll_interval_ms,
    promptTemplate,
    source,
    defaultRecipe,
    roles,
    runners,
  };
  if (warnings.length > 0) config.warnings = warnings;
  return config;
}

function buildRunnersConfig(
  raw: WorkflowFrontMatter["runners"],
  warnings: WorkflowConfigWarning[],
): Record<string, RunnerDescriptor> {
  if (!raw) {
    warnings.push({
      code: "runner_default_used",
      path: "runners.codex_app_server",
      message:
        "runners 未声明，已 fallback 到内置 codex_app_server descriptor；建议在 workflow 中显式声明 runners:。",
    });
    return structuredClone(DEFAULT_RUNNERS_CONFIG);
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    warnings.push({
      code: "runner_default_used",
      path: "runners.codex_app_server",
      message:
        "runners 为空，已 fallback 到内置 codex_app_server descriptor；建议在 workflow 中显式声明 runners:。",
    });
    return structuredClone(DEFAULT_RUNNERS_CONFIG);
  }
  const out: Record<string, RunnerDescriptor> = {};
  for (const [runnerId, value] of entries) {
    out[runnerId] = parseRunnerDescriptorFromYaml(runnerId, value);
  }
  return out;
}

function parseRunnerDescriptorFromYaml(
  runnerId: string,
  raw: unknown,
): RunnerDescriptor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowConfigError(
      `runners.${runnerId} must be an object`,
      `runners.${runnerId}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const kindRaw = obj.kind;
  if (!isRunnerKind(kindRaw)) {
    throw new WorkflowConfigError(
      `unsupported runner kind: ${JSON.stringify(kindRaw)}`,
      `runners.${runnerId}.kind`,
    );
  }

  const capabilitiesRaw = obj.capabilities;
  if (!Array.isArray(capabilitiesRaw) || capabilitiesRaw.length === 0) {
    throw new WorkflowConfigError(
      `runners.${runnerId}.capabilities must be a non-empty array`,
      `runners.${runnerId}.capabilities`,
    );
  }
  const capabilities: RunnerCapability[] = [];
  for (const cap of capabilitiesRaw) {
    if (!isRunnerCapability(cap)) {
      throw new WorkflowConfigError(
        `unknown runner capability: ${JSON.stringify(cap)}; allowed: ${RUNNER_CAPABILITY_VALUES.join(
          ", ",
        )}`,
        `runners.${runnerId}.capabilities`,
      );
    }
    capabilities.push(cap);
  }

  const common: {
    runnerId: string;
    capabilities: RunnerCapability[];
    displayName?: string;
    defaultTimeoutSeconds?: number;
  } = {
    runnerId,
    capabilities,
  };

  if (obj.display_name !== undefined) {
    if (typeof obj.display_name !== "string") {
      throw new WorkflowConfigError(
        `runners.${runnerId}.display_name must be a string`,
        `runners.${runnerId}.display_name`,
      );
    }
    common.displayName = obj.display_name;
  }

  if (obj.timeout_seconds !== undefined) {
    if (
      typeof obj.timeout_seconds !== "number" ||
      !Number.isFinite(obj.timeout_seconds) ||
      obj.timeout_seconds <= 0
    ) {
      throw new WorkflowConfigError(
        `runners.${runnerId}.timeout_seconds must be a positive number`,
        `runners.${runnerId}.timeout_seconds`,
      );
    }
    common.defaultTimeoutSeconds = obj.timeout_seconds;
  }

  for (const key of Object.keys(obj)) {
    if (
      key !== "kind" &&
      key !== "capabilities" &&
      key !== "display_name" &&
      key !== "timeout_seconds" &&
      key !== "options"
    ) {
      throw new WorkflowConfigError(
        `runners.${runnerId} unknown field: ${key}`,
        `runners.${runnerId}.${key}`,
      );
    }
  }

  if (kindRaw === "codex_app_server") {
    const options =
      obj.options === undefined
        ? undefined
        : parseRunnerOptionsByKind(runnerId, kindRaw, obj.options);
    return options === undefined
      ? { ...common, kind: "codex_app_server" }
      : { ...common, kind: "codex_app_server", options };
  }

  const options =
    obj.options === undefined
      ? undefined
      : parseRunnerOptionsByKind(runnerId, kindRaw, obj.options);
  return options === undefined
    ? { ...common, kind: "claude_code" }
    : { ...common, kind: "claude_code", options };
}

function parseRunnerOptionsByKind(
  runnerId: string,
  kind: RunnerKind,
  raw: unknown,
): CodexAppServerRunnerOptions | ClaudeCodeRunnerOptions {
  switch (kind) {
    case "codex_app_server":
      return parseCodexAppServerOptions(runnerId, raw);
    case "claude_code":
      return parseClaudeCodeOptions(runnerId, raw);
  }
}

function parseCodexAppServerOptions(
  runnerId: string,
  raw: unknown,
): CodexAppServerRunnerOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowConfigError(
      `runners.${runnerId}.options must be an object`,
      `runners.${runnerId}.options`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: CodexAppServerRunnerOptions = {};
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_RUNNER_OPTION_KEYS.has(key)) {
      throw new WorkflowConfigError(
        `runners.${runnerId}.options.${key} is not allowed (secret-like or sandbox escalation)`,
        `runners.${runnerId}.options`,
      );
    }
    switch (key) {
      case "command":
        if (typeof value !== "string" || value.length === 0) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.command must be a non-empty string`,
            `runners.${runnerId}.options.command`,
          );
        }
        out.command = value;
        break;
      case "max_turns":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value <= 0
        ) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.max_turns must be a positive integer`,
            `runners.${runnerId}.options.max_turns`,
          );
        }
        out.maxTurns = value;
        break;
      case "turn_timeout_ms":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 1000
        ) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.turn_timeout_ms must be an integer >= 1000`,
            `runners.${runnerId}.options.turn_timeout_ms`,
          );
        }
        out.turnTimeoutMs = value;
        break;
      case "approval_policy":
        if (value !== "never") {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.approval_policy must be "never" for codex_app_server`,
            `runners.${runnerId}.options.approval_policy`,
          );
        }
        out.approvalPolicy = "never";
        break;
      case "thread_sandbox":
        if (value !== "workspace-write") {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.thread_sandbox must be "workspace-write" for codex_app_server`,
            `runners.${runnerId}.options.thread_sandbox`,
          );
        }
        out.threadSandbox = "workspace-write";
        break;
      default:
        throw new WorkflowConfigError(
          `runners.${runnerId}.options unknown option: ${key}`,
          `runners.${runnerId}.options`,
        );
    }
  }
  return out;
}

function parseClaudeCodeOptions(
  runnerId: string,
  raw: unknown,
): ClaudeCodeRunnerOptions {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowConfigError(
      `runners.${runnerId}.options must be an object`,
      `runners.${runnerId}.options`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const out: ClaudeCodeRunnerOptions = {};
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_RUNNER_OPTION_KEYS.has(key)) {
      throw new WorkflowConfigError(
        `runners.${runnerId}.options.${key} is not allowed (secret-like or sandbox escalation)`,
        `runners.${runnerId}.options`,
      );
    }
    switch (key) {
      case "command":
        if (typeof value !== "string" || value.length === 0) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.command must be a non-empty string`,
            `runners.${runnerId}.options.command`,
          );
        }
        out.command = value;
        break;
      case "model":
        if (typeof value !== "string" || value.length === 0) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.model must be a non-empty string`,
            `runners.${runnerId}.options.model`,
          );
        }
        out.model = value;
        break;
      case "turn_timeout_ms":
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < 1000
        ) {
          throw new WorkflowConfigError(
            `runners.${runnerId}.options.turn_timeout_ms must be an integer >= 1000`,
            `runners.${runnerId}.options.turn_timeout_ms`,
          );
        }
        out.turnTimeoutMs = value;
        break;
      default:
        throw new WorkflowConfigError(
          `runners.${runnerId}.options unknown option: ${key}`,
          `runners.${runnerId}.options`,
        );
    }
  }
  return out;
}

function buildRolesConfig(
  raw: WorkflowFrontMatter["roles"],
  warnings: WorkflowConfigWarning[],
  runnersDeclared: boolean,
): WorkflowRolesConfig {
  const target: WorkflowRolesConfig = {};
  const order: AgentRole[] = ["coder", "reviewer", "test_evidence"];
  for (const role of order) {
    const rawRole = raw?.[role];
    if (!rawRole) {
      const defaultProfile = DEFAULT_ROLES_CONFIG[role];
      if (defaultProfile) {
        target[role] = defaultProfile as never;
      }
      warnings.push({
        code: "role_default_used",
        path: `roles.${role}`,
        message: `roles.${role} 未声明，已 fallback 到内置默认 profile（spec §10）。`,
      });
      continue;
    }
    if (runnersDeclared) {
      assertNoLegacyRoleRunnerKeys(role, rawRole);
    }
    try {
      const parsed = parseRoleConfig({ role, raw: rawRole });
      target[role] = parsed as never;
    } catch (cause) {
      if (cause instanceof RoleConfigError) {
        throw new WorkflowConfigError(cause.message, `roles.${role}`, {
          cause,
        });
      }
      throw cause;
    }
  }
  return target;
}

function assertNoLegacyRoleRunnerKeys(
  role: AgentRole,
  rawRole: Record<string, unknown>,
): void {
  for (const key of Object.keys(rawRole)) {
    if (LEGACY_RUNNER_KEYS.has(key)) {
      throw new WorkflowConfigError(
        `legacy role runner override key not allowed when runners: registry is declared: roles.${role}.${key}`,
        `roles.${role}`,
      );
    }
    const allowed =
      ALLOWED_ROLE_KEYS_COMMON.has(key) ||
      (role === "reviewer" && ALLOWED_ROLE_KEYS_REVIEWER_EXTRA.has(key));
    if (!allowed) {
      throw new WorkflowConfigError(
        `legacy role runner override or unknown role key: roles.${role}.${key}`,
        `roles.${role}`,
      );
    }
  }
}

/** Re-export 给上层（central / cli）使用，避免重复定义。 */
export type {
  WorkflowRoleConfig,
  WorkflowRolesConfig,
  WorkflowRecipe,
};

async function readWorkflowFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "failed to read workflow file";
    throw new WorkflowConfigError(message, "<file>", { cause });
  }
}

interface ParsedFrontMatter {
  data: unknown;
  content: string;
}

function parseFrontMatter(raw: string): ParsedFrontMatter {
  try {
    const parsed = matter(raw, {
      engines: {
        yaml: {
          parse: (input: string): object => {
            const result: unknown = YAML.parse(input, { prettyErrors: true });
            if (result === null || result === undefined) return {};
            if (typeof result !== "object" || Array.isArray(result)) {
              throw new Error("front matter must be a YAML mapping");
            }
            return result as object;
          },
          stringify: (input: unknown): string => YAML.stringify(input),
        },
      },
    });
    return { data: (parsed.data ?? {}) as unknown, content: parsed.content };
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : "failed to parse front matter";
    throw new WorkflowConfigError(message, "<front-matter>", { cause });
  }
}

function validateFrontMatter(data: unknown): WorkflowFrontMatter {
  const result = WorkflowFrontMatterSchema.safeParse(data);
  if (result.success) return result.data;

  const issue = pickPrimaryIssue(result.error.issues);
  throw new WorkflowConfigError(formatIssue(issue), formatPath(issue.path));
}

function pickPrimaryIssue(issues: ZodIssue[]): ZodIssue {
  if (issues.length === 0) {
    return {
      code: "custom",
      path: [],
      message: "invalid workflow config",
    } as ZodIssue;
  }
  const required = issues.find(
    (i) =>
      i.code === "invalid_type" &&
      "received" in i &&
      (i as { received: unknown }).received === "undefined",
  );
  return required ?? issues[0]!;
}

function formatPath(parts: ReadonlyArray<PropertyKey>): string {
  if (parts.length === 0) return "<root>";
  return parts.map((p) => String(p)).join(".");
}

function formatIssue(issue: ZodIssue): string {
  const where = formatPath(issue.path);
  return `${issue.message} (at ${where})`;
}
