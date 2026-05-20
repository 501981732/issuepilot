export interface TrackerConfig {
  kind: "gitlab";
  baseUrl: string;
  projectId: string;
  /**
   * Name of the env var that supplies a static GitLab access token (PAT,
   * Group Access Token, etc.). Optional — when omitted the orchestrator
   * falls back to OAuth credentials stored in `~/.issuepilot/credentials`
   * (see spec §22 decision 3).
   */
  tokenEnv?: string;
  /**
   * V4.6 spec §10：可选的 token scope 要求列表（例如 `["api"]`）。
   * orchestrator 在 reviewer 启动前做 token scope probe，缺 scope 时
   * reviewer 进 `cannot_review`（spec §16）。
   */
  tokenScopeRequirements?: string[];
  activeLabels: string[];
  runningLabel: string;
  handoffLabel: string;
  failedLabel: string;
  blockedLabel: string;
  reworkLabel: string;
  mergingLabel: string;
}

export interface WorkspaceConfig {
  root: string;
  strategy: "worktree";
  repoCacheRoot: string;
}

export interface GitConfig {
  repoUrl: string;
  baseBranch: string;
  branchPrefix: string;
}

export interface AgentConfig {
  runner: "codex-app-server";
  maxConcurrentAgents: number;
  maxTurns: number;
  maxAttempts: number;
  retryBackoffMs: number;
}

export type CodexApprovalPolicy = "never" | "untrusted" | "on-request";

export type CodexThreadSandbox = "workspace-write" | "read-only";

export type CodexTurnSandboxType = "workspaceWrite" | "readOnly";

export interface CodexTurnSandboxPolicy {
  type: CodexTurnSandboxType;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: CodexApprovalPolicy;
  threadSandbox: CodexThreadSandbox;
  turnTimeoutMs: number;
  turnSandboxPolicy: CodexTurnSandboxPolicy;
}

export interface HooksConfig {
  afterCreate?: string;
  beforeRun?: string;
  afterRun?: string;
}

/**
 * CI feedback policy applied during the `human-review` reconciliation
 * loop (V2 spec §9). When `enabled`, the orchestrator polls the latest
 * pipeline on the run's source branch:
 *
 * - `success` keeps the run in `human-review` and merely records the
 *   observation.
 * - `failed` recycles the issue to `onFailure` (`ai-rework` by default,
 *   meaning "ask Codex to retry"; setting `human-review` keeps the run
 *   parked but emits the observation event for visibility).
 * - `running` / `pending` are no-ops aside from emitting `ci_status_observed`.
 *
 * `waitForPipeline` is reserved for a follow-up plan and currently maps
 * to a no-op flag carried through configuration to avoid breaking team
 * configs that already encode user intent. Defaults match V2 spec §9:
 * `{ enabled: false, onFailure: "ai-rework", waitForPipeline: true }`.
 */
export interface CiConfig {
  enabled: boolean;
  onFailure: "ai-rework" | "human-review";
  waitForPipeline: boolean;
}

export interface WorkflowSource {
  path: string;
  sha256: string;
  loadedAt: string;
}

export interface WorkflowConfig {
  tracker: TrackerConfig;
  workspace: WorkspaceConfig;
  git: GitConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  hooks: HooksConfig;
  ci: CiConfig;
  /**
   * V1 single-project fallback for workspace retention. Mirrors the
   * `retention:` block on `issuepilot.team.yaml` and feeds the same
   * planner / executor used in team mode. Defaults come from
   * `DEFAULT_RETENTION_CONFIG` (V2 spec §11).
   */
  retention: RetentionConfig;
  /** Orchestrator main-loop poll interval in milliseconds. Defaults to 10 000. */
  pollIntervalMs: number;
  promptTemplate: string;
  source: WorkflowSource;
  /**
   * V4.6 spec §10：workflow 顶层 `default_recipe` 字段。
   * 缺省时 fallback 到 `full_pipeline`（V4.6 把三角色 pipeline 作为
   * 新默认；若想保留 V4.5 单 coder 行为需显式声明 `coding_only`）。
   */
  defaultRecipe: WorkflowRecipe;
  /**
   * V4.6 spec §10：workflow 顶层 `roles:` 节。
   * 缺省时 fallback 到内置 best-effort 默认 role profile（仅 P0 提供）。
   * `parse.ts` emit `result.warnings[]` 提示运维者显式声明 roles。
   */
  roles: WorkflowRolesConfig;
  /**
   * Parser-emit 的可见警告（V4.6 default_recipe / roles 升级提示等）。
   * 主流程不消费此字段；dashboard / CLI 用于提示运维者升级配置。
   */
  warnings?: WorkflowConfigWarning[];
}

export interface WorkflowConfigWarning {
  code: string;
  message: string;
  /** YAML 字段路径，例如 `roles.coder` / `default_recipe`。 */
  path: string;
}

export interface IssuePromptInfo {
  id: string;
  iid: number;
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  url: string;
  author: string;
  assignees: string[];
}

import type {
  RetentionConfig,
  ReviewFeedbackSummary,
  WorkflowRecipe,
  WorkflowRolesConfig,
} from "@issuepilot/shared-contracts";

export type {
  RetentionConfig,
  ReviewFeedbackSummary,
  WorkflowRecipe,
  WorkflowRolesConfig,
};

export interface PromptContext {
  issue: IssuePromptInfo;
  attempt: number;
  workspace: { path: string };
  git: { branch: string };
  /**
   * V2 Phase 4 review feedback context. When supplied, the renderer
   * also exposes it as `review_feedback` (snake_case) so Liquid
   * templates can iterate with `{% for c in review_feedback.comments
   * %}`. Absent on the first attempt or when no human reviewer comment
   * has been observed yet.
   */
  reviewFeedback?: ReviewFeedbackSummary;
}
