/**
 * V4.6 Multi-Agent Collaboration AgentReport 契约。
 *
 * AgentReport 是每个角色（coder / reviewer / test_evidence）一次跑的中间产物，
 * 由 orchestrator 写入 `~/.issuepilot/<scope>/agent-reports/<taskId>/<role>/<agentReportId>.json`。
 * 多个 AgentReport 通过 PipelineRun 组成一次多角色 pipeline 执行。
 *
 * 本文件严格按 spec §8.2 / §11 / §16.2 定义枚举与字段；所有 contract
 * round-trip JSON 必须保留 shape。lastError.code 是 V4.6 在 orchestrator /
 * dashboard / V4.4 quality / V4.5 improvement 之间共享的单一 truth source。
 *
 * Source: docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md
 */

/** spec §8.2：三个 agent 角色，严格 snake_case。 */
export const AGENT_ROLE_VALUES = ["coder", "reviewer", "test_evidence"] as const;
export type AgentRole = (typeof AGENT_ROLE_VALUES)[number];

export const isAgentRole = (value: unknown): value is AgentRole =>
  typeof value === "string" &&
  (AGENT_ROLE_VALUES as readonly string[]).includes(value);

/** spec §8.2：AgentReport.status lifecycle。 */
export const AGENT_REPORT_STATUS_VALUES = [
  "running",
  "complete",
  "incomplete",
  "failed",
  "cancelled",
] as const;
export type AgentReportStatus = (typeof AGENT_REPORT_STATUS_VALUES)[number];

export const isAgentReportStatus = (
  value: unknown,
): value is AgentReportStatus =>
  typeof value === "string" &&
  (AGENT_REPORT_STATUS_VALUES as readonly string[]).includes(value);

/**
 * spec §16.2：AgentReport.lastError.code 单一 truth source。
 *
 * 15 项严格枚举，**不**含 `reviewer_cannot_review`（那是 TaskNode
 * roleFailureReason / event key，不是 lastError.code）。新增 code 必须
 * 同时更新本枚举与 V4.4 FailurePatternId / `failure-mapping.ts`，三处保
 * 持双向一致。
 */
export const LAST_ERROR_CODE_VALUES = [
  "scope_insufficient",
  "prompt_template_missing",
  "prompt_render_failed",
  "reviewer_unavailable",
  "runner_unavailable",
  "parse_failed",
  "sandbox_violation",
  "redaction_failed",
  "storage_full",
  "gitlab_rate_limited",
  "coding_failed",
  "evidence_unavailable",
  "evidence_partial",
  "reviewer_requested_changes",
  "pipeline_cancelled",
] as const;
export type LastErrorCode = (typeof LAST_ERROR_CODE_VALUES)[number];

export const isLastErrorCode = (value: unknown): value is LastErrorCode =>
  typeof value === "string" &&
  (LAST_ERROR_CODE_VALUES as readonly string[]).includes(value);

/**
 * spec §8.2：AgentReport.lastError 形态。
 *
 * - `status = failed` 时 lastError 必填；
 * - `status = incomplete` 时可填以解释；
 * - 其他状态可省。
 */
export interface AgentLastError {
  code: LastErrorCode;
  message: string;
  /** Operator-visible 修复指引（如 "Add api scope to ISSUEPILOT_GITLAB_TOKEN"）。 */
  hint?: string;
}

/** spec §8.2 公共字段。 */
export interface AgentReportBase {
  agentReportId: string;
  /** WorkItem id that owns this report; older persisted reports may omit it. */
  workItemId?: string;
  pipelineRunId: string;
  taskId: string;
  role: AgentRole;
  /** workflow YAML `roles.<role>` 的稳定 ID。 */
  roleProfileId: string;
  status: AgentReportStatus;
  startedAt: string;
  completedAt?: string;
  /** Codex run id；agent 未启动场景（spec §16.1）下为 null。 */
  runId?: string | null;
  /** prompt template sha256；agent 未启动场景下为 null。 */
  promptTemplateHash?: string | null;
  /** 必填条件见 spec §8.2 / §16.2。 */
  lastError?: AgentLastError;
  /** 指向 evidence 文件 / RunReportArtifact 锚点。 */
  evidenceLinks: string[];
  /** 落盘时被 redaction 的字段名。 */
  redactedFields: string[];
  /**
   * spec §8.2 / §10.3：retry / replan 时上一份 AgentReport 的 id。
   * 第一份 attempt 时为空；coordinator.retryRole 创建后续 attempt 时
   * 填写并同时把 prev report 的 `supersededBy` 写为当前 id。
   */
  supersedes?: string;
  /**
   * spec §8.2 / §10.3：被哪个新 AgentReport 取代。链末端为空。
   */
  supersededBy?: string;
}

/** spec §8.2：coder 角色专属字段。 */
export interface CoderAgentReportPayload {
  diffSummary: string;
  branch: string;
  mergeRequest?: {
    iid: number;
    url: string;
    state: "opened" | "merged" | "closed";
  };
  runReportArtifactId?: string;
  buildStatus?: "passed" | "failed" | "skipped" | "unknown";
  testStatus?: "passed" | "failed" | "skipped" | "unknown";
  lintStatus?: "passed" | "failed" | "skipped" | "unknown";
}

/** spec §11：reviewer finding 严重度。 */
export const FINDING_SEVERITY_VALUES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY_VALUES)[number];

/** spec §11：inline comment 仅允许 medium/high/critical（low 只能进主 note）。 */
export const INLINE_COMMENT_SEVERITY_VALUES = [
  "medium",
  "high",
  "critical",
] as const;
export type InlineCommentSeverity =
  (typeof INLINE_COMMENT_SEVERITY_VALUES)[number];

/** spec §8.2：reviewer decision 三态。 */
export const REVIEWER_DECISION_VALUES = [
  "approve_with_comments",
  "request_changes",
  "cannot_review",
] as const;
export type ReviewerDecision = (typeof REVIEWER_DECISION_VALUES)[number];

export const isReviewerDecision = (value: unknown): value is ReviewerDecision =>
  typeof value === "string" &&
  (REVIEWER_DECISION_VALUES as readonly string[]).includes(value);

/** spec §11.2：reviewer finding。 */
export interface ReviewerFinding {
  severity: FindingSeverity;
  category: string;
  message: string;
  locationHint?: {
    filePath: string;
    lineRange?: { start: number; end: number };
  };
}

/** spec §11.2：reviewer inline comment。 */
export interface ReviewerInlineComment {
  filePath: string;
  lineRange: { start: number; end: number };
  severity: InlineCommentSeverity;
  category: string;
  message: string;
  suggestedFix?: string;
}

/** spec §11：reviewer.evidenceRequest 条目。 */
export interface ReviewerEvidenceRequest {
  kind:
    | "screenshot"
    | "playwright_walkthrough"
    | "ci_log"
    | "test_run"
    | "custom";
  target: string;
  rationale: string;
}

/** spec §11：reviewer.risks 条目。 */
export interface ReviewerRisk {
  severity: FindingSeverity;
  message: string;
}

/** spec §12：reviewer MR 推送结果。 */
export const MR_PUBLICATION_STATUS_VALUES = [
  "pending",
  "published",
  "publish_failed",
  "skipped_by_config",
  "revoked",
] as const;
export type MrPublicationStatus =
  (typeof MR_PUBLICATION_STATUS_VALUES)[number];

export interface MrPublication {
  status: MrPublicationStatus;
  noteIds: string[];
  publishedAt?: string;
  lastError?: AgentLastError;
}

/** 仅 `published` 状态可被 revoke。 */
export const isMrPublicationRevocable = (status: MrPublicationStatus): boolean =>
  status === "published";

/** spec §8.2 / §11：reviewer 角色专属字段。 */
export interface ReviewerAgentReportPayload {
  /** ≤ 4000 字符；超出时 contract validator 抛 ReviewerSummaryTooLongError。 */
  summary: string;
  decision: ReviewerDecision;
  /** 0..1 浮点；序列化两位小数（spec §11.1）。 */
  confidence: number;
  risks: ReviewerRisk[];
  evidenceRequest: ReviewerEvidenceRequest[];
  findings: ReviewerFinding[];
  inlineComments: ReviewerInlineComment[];
  mrPublication: MrPublication;
}

/** spec §8.2：test_evidence.evidenceItems[]。 */
export interface TestEvidenceItem {
  kind: string;
  target: string;
  source: string;
  status: "collected" | "failed" | "skipped";
  artifactPath?: string;
  lastError?: AgentLastError;
}

/** spec §8.2 / §16.1：test_evidence 基线证据。 */
export interface TestEvidenceBaseline {
  ciSummary?: string;
  lintSummary?: string;
  testSummary?: string;
  coverageSnapshot?: string;
  collectedAt: string;
}

/** spec §8.2：test_evidence 角色专属字段。 */
export interface TestEvidenceAgentReportPayload {
  evidenceItems: TestEvidenceItem[];
  /** agent 未启动 / 基线收集失败时为 null（spec §16.1）。 */
  baselineEvidence: TestEvidenceBaseline | null;
}

export interface CoderAgentReport extends AgentReportBase {
  role: "coder";
  coder: CoderAgentReportPayload;
}

export interface ReviewerAgentReport extends AgentReportBase {
  role: "reviewer";
  reviewer: ReviewerAgentReportPayload;
}

export interface TestEvidenceAgentReport extends AgentReportBase {
  role: "test_evidence";
  testEvidence: TestEvidenceAgentReportPayload;
}

/**
 * spec §11.3：AgentReport discriminated union。narrow by `role` 即可
 * 类型安全访问 `.coder` / `.reviewer` / `.testEvidence` 字段。
 */
export type AgentReport =
  | CoderAgentReport
  | ReviewerAgentReport
  | TestEvidenceAgentReport;

const hasCommonAgentReportFields = (
  value: Record<string, unknown>,
): boolean =>
  typeof value.agentReportId === "string" &&
  typeof value.pipelineRunId === "string" &&
  typeof value.taskId === "string" &&
  isAgentRole(value.role) &&
  typeof value.roleProfileId === "string" &&
  isAgentReportStatus(value.status) &&
  typeof value.startedAt === "string" &&
  Array.isArray(value.evidenceLinks) &&
  Array.isArray(value.redactedFields);

export const isAgentReport = (value: unknown): value is AgentReport => {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (!hasCommonAgentReportFields(obj)) return false;
  switch (obj.role) {
    case "coder":
      return typeof obj.coder === "object" && obj.coder !== null;
    case "reviewer":
      return typeof obj.reviewer === "object" && obj.reviewer !== null;
    case "test_evidence":
      return (
        typeof obj.testEvidence === "object" && obj.testEvidence !== null
      );
    default:
      return false;
  }
};

export const isCoderAgentReport = (
  value: unknown,
): value is CoderAgentReport =>
  isAgentReport(value) && value.role === "coder";

export const isReviewerAgentReport = (
  value: unknown,
): value is ReviewerAgentReport =>
  isAgentReport(value) && value.role === "reviewer";

export const isTestEvidenceAgentReport = (
  value: unknown,
): value is TestEvidenceAgentReport =>
  isAgentReport(value) && value.role === "test_evidence";

/**
 * 把 `confidence` 序列化成两位小数字符串（spec §11.1）。
 * 用于 reviewer summary 渲染与 prompt 输出契约校验。
 */
export const formatConfidence = (value: number): string => value.toFixed(2);

/** spec §11.2：reviewer.summary 超长时由 contract validator 抛出。 */
export class ReviewerSummaryTooLongError extends Error {
  constructor(public readonly length: number) {
    super(`reviewer.summary exceeds 4000 characters (got ${length})`);
    this.name = "ReviewerSummaryTooLongError";
  }
}

/**
 * 静态校验 reviewer.summary 长度上限（spec §11.2）；上层 store 在持久化
 * 前调用，避免推到 MR 时被 GitLab API 报错。
 */
export const assertReviewerSummaryLength = (summary: string): void => {
  if (summary.length > 4000) {
    throw new ReviewerSummaryTooLongError(summary.length);
  }
};
