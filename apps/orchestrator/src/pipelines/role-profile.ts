/**
 * V4.6 spec §10：把 workflow YAML 的 role config + runtime 上下文（work
 * item / task / extra 变量）组装成 agent 可直接消费的 RoleProfile：
 *
 * - prompt 文本：从 promptTemplate 路径读文件，按 `{{var}}` 占位渲染。
 * - roleProfileId：`<role>@<promptHash[:7]>`，AgentReport 写入此 ID。
 * - sandbox / toolAllow / timeoutSeconds / tokenScopeRequirements：
 *   直接来自 workflow YAML（已 parse / resolve 完成）。
 * - reviewer 专属：publishToMr / severityThreshold / maxInlineComments，
 *   缺省值在调用方应用（这里只透传 raw 值；下游 reviewer agent 自行
 *   填默认）。
 *
 * 错误：
 * - promptTemplate 缺路径或不可读 → `RoleProfileInvalidError`。
 * - resolve 未跑（promptTemplateHash 缺失）→ `RoleProfileInvalidError`，
 *   提示调用方先跑 `resolveWorkflow`。
 */

import { readFile } from "node:fs/promises";

import type {
  AgentRole,
  CoderRoleConfig,
  ReviewerRoleConfig,
  ReviewerSeverityThreshold,
  TestEvidenceRoleConfig,
  WorkflowRoleConfig,
  WorkflowToolGrant,
  WorkflowSandbox,
} from "@issuepilot/shared-contracts";

export class RoleProfileInvalidError extends Error {
  override readonly name = "RoleProfileInvalidError";

  constructor(
    message: string,
    public readonly role: AgentRole,
    public readonly reason:
      | "prompt_template_missing"
      | "prompt_template_hash_missing"
      | "prompt_render_failed",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface RoleProfileTemplateContext {
  workItem: {
    id: string;
    iid: number;
    title: string;
    description?: string | undefined;
    label?: string | undefined;
  };
  task: {
    id: string;
    title: string;
    description?: string | undefined;
  };
  extra?: Record<string, string | number | boolean | undefined>;
}

const formatValue = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
};

const snakeToCamel = (segment: string): string =>
  segment.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());

const lookup = (path: string, ctx: RoleProfileTemplateContext): string => {
  const parts = path.split(".");
  let cursor: unknown = ctx;
  for (const part of parts) {
    if (cursor === undefined || cursor === null) {
      return `[missing: ${path}]`;
    }
    if (typeof cursor !== "object") {
      return `[missing: ${path}]`;
    }
    const obj = cursor as Record<string, unknown>;
    cursor = part in obj ? obj[part] : obj[snakeToCamel(part)];
  }
  const formatted = formatValue(cursor);
  return formatted ?? `[missing: ${path}]`;
};

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * spec §10：最小 Mustache 风格渲染器。只支持 `{{path.to.var}}`，
 * 不做 escape / partial / section，保证模板与上下文一一对应。
 */
export const renderPromptTemplate = (
  template: string,
  ctx: RoleProfileTemplateContext,
): string => template.replace(PLACEHOLDER_RE, (_match, path) => lookup(path, ctx));

export interface BaseRoleProfile {
  role: AgentRole;
  /** spec §8.2：`AgentReport.roleProfileId`。 */
  roleProfileId: string;
  /**
   * V4.7：role 引用的 runner id（workflow `runners:` 中的 key）。
   * agent factory 用它从 RunnerRegistry 取出 adapter 并写入 AgentReport
   * 的 runner trace 字段。
   */
  runnerId: string;
  /** spec §10：渲染后的 prompt 内容。 */
  prompt: string;
  /** spec §8.2 / §10：稳定 sha256，agent 写入 AgentReport 用于复现。 */
  promptTemplateHash: string;
  sandbox: WorkflowSandbox;
  toolAllow: WorkflowToolGrant[];
  timeoutSeconds: number | undefined;
  tokenScopeRequirements: string[] | undefined;
}

export interface CoderRoleProfile extends BaseRoleProfile {
  role: "coder";
}

export interface ReviewerRoleProfile extends BaseRoleProfile {
  role: "reviewer";
  publishToMr: boolean;
  severityThreshold: ReviewerSeverityThreshold;
  maxInlineComments: number;
}

export interface TestEvidenceRoleProfile extends BaseRoleProfile {
  role: "test_evidence";
}

export type RoleProfile =
  | CoderRoleProfile
  | ReviewerRoleProfile
  | TestEvidenceRoleProfile;

export interface BuildRoleProfileInput {
  role: WorkflowRoleConfig;
  workItem: RoleProfileTemplateContext["workItem"];
  task: RoleProfileTemplateContext["task"];
  extra?: RoleProfileTemplateContext["extra"];
}

const ensureHash = (cfg: WorkflowRoleConfig): string => {
  if (!cfg.promptTemplateHash) {
    throw new RoleProfileInvalidError(
      `role ${cfg.role}: promptTemplateHash missing (did you call resolveWorkflow?)`,
      cfg.role,
      "prompt_template_hash_missing",
    );
  }
  return cfg.promptTemplateHash;
};

const readTemplate = async (cfg: WorkflowRoleConfig): Promise<string> => {
  try {
    return await readFile(cfg.promptTemplate, "utf8");
  } catch (cause) {
    throw new RoleProfileInvalidError(
      `role ${cfg.role}: failed to read prompt template at ${cfg.promptTemplate}`,
      cfg.role,
      "prompt_template_missing",
      { cause },
    );
  }
};

const buildBase = async (
  cfg: WorkflowRoleConfig,
  ctx: RoleProfileTemplateContext,
): Promise<BaseRoleProfile> => {
  const promptTemplateHash = ensureHash(cfg);
  const template = await readTemplate(cfg);
  let prompt: string;
  try {
    prompt = renderPromptTemplate(template, ctx);
  } catch (cause) {
    throw new RoleProfileInvalidError(
      `role ${cfg.role}: prompt render failed`,
      cfg.role,
      "prompt_render_failed",
      { cause },
    );
  }
  return {
    role: cfg.role,
    roleProfileId: `${cfg.role}@${promptTemplateHash.slice(0, 7)}`,
    runnerId: cfg.runner,
    prompt,
    promptTemplateHash,
    sandbox: cfg.sandbox,
    toolAllow: cfg.tools ? [...cfg.tools] : [],
    timeoutSeconds: cfg.timeoutSeconds,
    tokenScopeRequirements: cfg.tokenScopeRequirements
      ? [...cfg.tokenScopeRequirements]
      : undefined,
  };
};

/**
 * spec §10 默认值：
 * - reviewer.publishToMr = true
 * - reviewer.severityThreshold = "medium"
 * - reviewer.maxInlineComments = 25
 */
const REVIEWER_DEFAULTS = {
  publishToMr: true,
  severityThreshold: "medium" as ReviewerSeverityThreshold,
  maxInlineComments: 25,
};

export const buildRoleProfile = async (
  input: BuildRoleProfileInput,
): Promise<RoleProfile> => {
  const ctx: RoleProfileTemplateContext = {
    workItem: input.workItem,
    task: input.task,
    ...(input.extra ? { extra: input.extra } : {}),
  };

  const base = await buildBase(input.role, ctx);

  if (input.role.role === "reviewer") {
    const cfg = input.role as ReviewerRoleConfig;
    const reviewer: ReviewerRoleProfile = {
      ...base,
      role: "reviewer",
      publishToMr: cfg.publishToMr ?? REVIEWER_DEFAULTS.publishToMr,
      severityThreshold:
        cfg.severityThreshold ?? REVIEWER_DEFAULTS.severityThreshold,
      maxInlineComments:
        cfg.maxInlineComments ?? REVIEWER_DEFAULTS.maxInlineComments,
    };
    return reviewer;
  }
  if (input.role.role === "coder") {
    const _cfg: CoderRoleConfig = input.role;
    return { ...base, role: "coder" } satisfies CoderRoleProfile;
  }
  const _cfg: TestEvidenceRoleConfig = input.role;
  return { ...base, role: "test_evidence" } satisfies TestEvidenceRoleProfile;
};
