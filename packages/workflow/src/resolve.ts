import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  filesystemCapabilitiesForSandbox,
  runnerCapabilityForRole,
  type AgentRole,
  type RunnerCapability,
  type WorkflowRoleConfig,
  type WorkflowRolesConfig,
} from "@issuepilot/shared-contracts";

import { WorkflowConfigError } from "./parse.js";
import type { WorkflowConfig } from "./types.js";

export { WorkflowConfigError } from "./parse.js";

/**
 * V4.6 spec §10：role profile 缺失或不可读时抛出，
 * orchestrator 据此把 TaskNode 标 `role_profile_invalid`。
 */
export class RoleProfileInvalidError extends Error {
  override readonly name = "RoleProfileInvalidError";

  constructor(
    message: string,
    public readonly role: AgentRole,
    public readonly promptTemplatePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type EnvLike = Record<string, string | undefined>;

/**
 * Expand a path-shaped string by substituting `~` and the literal token
 * `$HOME` with `os.homedir()`.
 *
 * Behaviour (spec §6 "环境变量中的 secret 只在运行时解析"):
 *
 * - `~` 或 `~/<rest>` 展开为 homedir。`~user/...` 这类用户引用不展开。
 * - 字面量 `$HOME` 仅当后面紧跟边界字符（`/`、`\`、路径分隔符、字符串末尾）
 *   时展开；`$HOMEX` 这类不展开，`${HOME}` 与 `$OTHERVAR` 也不展开。
 * - 其余字符串原样返回，**不会**触发任意 shell expansion。
 */
export function expandHomePath(input: string): string {
  if (typeof input !== "string") {
    throw new WorkflowConfigError(
      `expected path string, got ${typeof input}`,
      "<path>",
    );
  }

  const home = os.homedir();
  let result = input;

  if (result === "~") {
    return home;
  }
  if (result.startsWith("~/") || result.startsWith("~\\")) {
    result = home + result.slice(1);
  }

  result = result.replace(/\$HOME(?=$|[/\\])/g, home);

  return result;
}

/**
 * Return a clone of `cfg` with all home-relative paths expanded. Currently
 * touches `workspace.root` and `workspace.repoCacheRoot`; other path-shaped
 * fields (git/codex command) are deliberately left as-is so they remain
 * transparent for downstream consumers.
 */
export function expandWorkflowPaths(cfg: WorkflowConfig): WorkflowConfig {
  return {
    ...cfg,
    workspace: {
      ...cfg.workspace,
      root: expandHomePath(cfg.workspace.root),
      repoCacheRoot: expandHomePath(cfg.workspace.repoCacheRoot),
    },
  };
}

/**
 * Confirm that the environment variable named by `tracker.tokenEnv` is set
 * to a non-empty value, *if* `tracker.tokenEnv` is configured. With OAuth
 * credentials available (spec §22 decision 3) `tokenEnv` may be omitted —
 * we treat that as "no env-var contract to validate" and let the daemon's
 * credential resolver decide whether the OAuth fallback is usable.
 *
 * `env` defaults to `process.env`. Callers in tests should pass an explicit
 * shape to keep the global process env clean.
 */
export function validateWorkflowEnv(
  cfg: WorkflowConfig,
  env: EnvLike = process.env,
): void {
  const tokenEnv = cfg.tracker.tokenEnv;
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) return;
  const value = env[tokenEnv];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowConfigError(
      "environment variable configured by tracker.token_env is not set",
      "tracker.token_env",
    );
  }
}

export interface TrackerSecret {
  /** Raw token loaded from `env[tracker.tokenEnv]`; never persisted in cfg. */
  token: string;
}

/**
 * Look up the tracker token at runtime without mutating the config. Used by
 * the GitLab adapter when it actually needs to authenticate; every other
 * layer should keep operating on the secret-free {@link WorkflowConfig}.
 *
 * Throws when `tracker.tokenEnv` is not configured — callers that have
 * OAuth credentials available should not reach this function; they go
 * through `@issuepilot/credentials` instead.
 */
export function resolveTrackerSecret(
  cfg: WorkflowConfig,
  env: EnvLike = process.env,
): TrackerSecret {
  const tokenEnv = cfg.tracker.tokenEnv;
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    throw new WorkflowConfigError(
      "tracker.token_env is not configured; use `issuepilot auth login` for OAuth credentials",
      "tracker.token_env",
    );
  }
  const value = env[tokenEnv];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkflowConfigError(
      "environment variable configured by tracker.token_env is not set",
      "tracker.token_env",
    );
  }
  return { token: value };
}

/**
 * V4.6 spec §10 / Task 2.4：读取每个 role 的 prompt_template 文件并计算
 * sha256。
 *
 * - `configRoot` 是 workflow YAML 所在目录的绝对路径（用于解析相对
 *   `prompt_template` 路径）。
 * - 缺失文件抛 `RoleProfileInvalidError`（带 role + 绝对路径）。
 * - 同一文件两次调用返回相同 hash（稳定）。
 */
export async function resolveRolePromptHashes(
  cfg: WorkflowConfig,
  configRoot: string,
): Promise<WorkflowRolesConfig> {
  const out: WorkflowRolesConfig = {};
  const order: AgentRole[] = ["coder", "reviewer", "test_evidence"];
  for (const role of order) {
    const profile = cfg.roles[role];
    if (!profile) continue;
    const resolvedPath = path.isAbsolute(profile.promptTemplate)
      ? profile.promptTemplate
      : path.resolve(configRoot, profile.promptTemplate);
    let contents: string;
    try {
      contents = await readFile(resolvedPath, "utf8");
    } catch (cause) {
      throw new RoleProfileInvalidError(
        `role ${role} prompt_template not readable: ${resolvedPath}`,
        role,
        resolvedPath,
        { cause },
      );
    }
    const hash = createHash("sha256").update(contents, "utf8").digest("hex");
    const enriched = {
      ...profile,
      promptTemplate: resolvedPath,
      promptTemplateHash: hash,
    } as unknown as WorkflowRoleConfig;
    if (enriched.role === "coder") {
      out.coder = enriched;
    } else if (enriched.role === "reviewer") {
      out.reviewer = enriched;
    } else if (enriched.role === "test_evidence") {
      out.test_evidence = enriched;
    }
  }
  return out;
}

/**
 * V4.7：runner 选择失败 / capability 缺失时抛出。`code` 让上层把校验
 * 错误暴露成 dashboard 与 routes 的统一形态。
 */
export class RunnerConfigInvalidError extends Error {
  override readonly name = "RunnerConfigInvalidError";

  constructor(
    message: string,
    public readonly path: string,
    public readonly code:
      | "runner_missing"
      | "unsupported_runner_kind"
      | "capability_missing",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * V4.7：检查每个声明的 role 引用的 runner 在 registry 中存在、kind 受支持、
 * 并且 capability 覆盖 role + sandbox + tool 需求。fail closed —— 任意校验失败
 * 立刻抛出，runner 不会启动。
 */
export function assertRunnerCapabilities(cfg: WorkflowConfig): void {
  const order: AgentRole[] = ["coder", "reviewer", "test_evidence"];
  for (const role of order) {
    const profile = cfg.roles[role];
    if (!profile) continue;
    const runnerId = profile.runner;
    const runner = cfg.runners[runnerId];
    if (!runner) {
      throw new RunnerConfigInvalidError(
        `roles.${role}.runner references unknown runner id: ${runnerId}`,
        `roles.${role}.runner`,
        "runner_missing",
      );
    }
    const required: RunnerCapability[] = [runnerCapabilityForRole(role)];
    if (role === "test_evidence") required.push("artifacts");
    if (needsGitlabTools(profile)) required.push("gitlab.tools");
    for (const capability of required) {
      if (!runner.capabilities.includes(capability)) {
        throw new RunnerConfigInvalidError(
          `capability_missing: runners.${runnerId} lacks ${capability} required by roles.${role}`,
          `runners.${runnerId}.capabilities`,
          "capability_missing",
        );
      }
    }
    const filesystemOptions = filesystemCapabilitiesForSandbox(profile.sandbox);
    const hasAnyFilesystem = filesystemOptions.some((cap) =>
      runner.capabilities.includes(cap),
    );
    if (!hasAnyFilesystem) {
      throw new RunnerConfigInvalidError(
        `capability_missing: runners.${runnerId} lacks any of [${filesystemOptions.join(
          ", ",
        )}] required by roles.${role}.sandbox=${profile.sandbox}`,
        `runners.${runnerId}.capabilities`,
        "capability_missing",
      );
    }
  }
}

function needsGitlabTools(profile: WorkflowRoleConfig): boolean {
  if (!profile.tools) return false;
  return profile.tools.some((tool) => tool.name.startsWith("gitlab."));
}

/**
 * 一次性 resolve：把路径展开 + role prompt hash 都填好的 WorkflowConfig
 * 返回。`configRoot` 留给上层自行决定（central / single 模式各取一处）。
 */
export async function resolveWorkflow(
  cfg: WorkflowConfig,
  configRoot: string,
): Promise<WorkflowConfig> {
  const expanded = expandWorkflowPaths(cfg);
  const roles = await resolveRolePromptHashes(expanded, configRoot);
  const resolved: WorkflowConfig = { ...expanded, roles };
  assertRunnerCapabilities(resolved);
  return resolved;
}
