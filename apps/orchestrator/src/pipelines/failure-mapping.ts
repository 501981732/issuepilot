/**
 * V4.6 spec §16.2 / §21.1：lastError.code → TaskNode.roleFailureReason /
 * event key / FailurePatternId 的**单一 truth source**。
 *
 * 新增 LastErrorCode 必须同时扩 LAST_ERROR_CODE_VALUES（15 项常量）和本
 * 文件的 mapping 表，否则编译期 exhaustive switch 不通过。
 *
 * spec §16.2 表脚注约束：
 * - `prompt_template_missing`：phase = `role_profile_init` →
 *   `role_profile_invalid`；phase = `agent_start` →
 *   `reviewer_cannot_review`（dashboard 阻塞 reviewer）。
 * - `runner_unavailable`：按 role 拆分；event key 与 patternId 都是
 *   `runner_unavailable`。
 * - `pipeline_cancelled`：按 PipelineRun.status 拆分 TaskNode reason
 *   和 event key；patternId 统一是 `pipeline_cancelled`。
 * - `gitlab_rate_limited`：fail-soft，不写 TaskNode reason / event key /
 *   patternId（返回 null）。
 * - `sandbox_violation`：所有角色都映射 `sandbox_violation`，role 信息
 *   存在 AgentReport.role。
 */

import type {
  AgentRole,
  LastErrorCode,
  PipelineRunStatus,
  TaskRoleFailureReason,
} from "@issuepilot/shared-contracts";
import { LAST_ERROR_CODE_VALUES } from "@issuepilot/shared-contracts";

export class UnsupportedFailureMappingError extends Error {
  override readonly name = "UnsupportedFailureMappingError";

  constructor(
    message: string,
    public readonly code: LastErrorCode | string,
    public readonly role?: AgentRole,
  ) {
    super(message);
  }
}

export type FailureMappingPromptPhase = "role_profile_init" | "agent_start";

export interface FailureMappingContext {
  /** 仅 `prompt_template_missing` / `prompt_render_failed` 用到。 */
  phase?: FailureMappingPromptPhase;
  /** 仅 `pipeline_cancelled` 用到。 */
  pipelineStatus?: PipelineRunStatus | "draft";
}

const KNOWN_CODES = new Set<LastErrorCode>(LAST_ERROR_CODE_VALUES);

const assertKnown = (code: LastErrorCode): void => {
  if (!KNOWN_CODES.has(code)) {
    throw new UnsupportedFailureMappingError(
      `unsupported lastError.code: ${code}`,
      code,
    );
  }
};

/**
 * spec §16.2 表 patternId 列。所有 14 条都会有 patternId（含 cancellation），
 * 仅 `gitlab_rate_limited` 返回 null（fail-soft）。
 */
export const toFailurePatternId = (
  code: LastErrorCode,
): string | null => {
  assertKnown(code);
  switch (code) {
    case "scope_insufficient":
      return "reviewer_cannot_review";
    case "prompt_template_missing":
    case "prompt_render_failed":
      return "role_profile_invalid";
    case "reviewer_unavailable":
    case "parse_failed":
      return "reviewer_unavailable";
    case "runner_unavailable":
      return "runner_unavailable";
    case "sandbox_violation":
      return "sandbox_violation";
    case "redaction_failed":
      return "redaction_failed";
    case "storage_full":
      return "storage_full";
    case "gitlab_rate_limited":
      return null;
    case "coding_failed":
      return "coding_failed";
    case "evidence_unavailable":
      return "evidence_unavailable";
    case "evidence_partial":
      return "evidence_partial";
    case "reviewer_requested_changes":
      return "reviewer_requested_changes";
    case "pipeline_cancelled":
      return "pipeline_cancelled";
    default: {
      const _exhaustive: never = code;
      throw new UnsupportedFailureMappingError(
        `unsupported lastError.code: ${String(code)}`,
        code,
      );
    }
  }
};

/** spec §16.2 表 event key 列。 */
export const toEventKey = (
  code: LastErrorCode,
  role: AgentRole,
  ctx: FailureMappingContext = {},
): string | null => {
  assertKnown(code);
  switch (code) {
    case "scope_insufficient":
      return "reviewer_cannot_review";
    case "prompt_template_missing":
    case "prompt_render_failed":
      return "role_profile_invalid";
    case "reviewer_unavailable":
    case "parse_failed":
      return "reviewer_unavailable";
    case "runner_unavailable":
      return "runner_unavailable";
    case "sandbox_violation":
      return "sandbox_violation";
    case "redaction_failed":
      return "redaction_failed";
    case "storage_full":
      return "storage_full";
    case "gitlab_rate_limited":
      return null;
    case "coding_failed":
      return "coding_failed";
    case "evidence_unavailable":
      return "evidence_unavailable";
    case "evidence_partial":
      return "evidence_partial";
    case "reviewer_requested_changes":
      return "reviewer_requested_changes";
    case "pipeline_cancelled": {
      switch (ctx.pipelineStatus) {
        case "running_coding":
          return "coder_cancelled";
        case "running_reviewer":
          return "reviewer_cancelled";
        case "running_test_evidence":
          return "test_evidence_cancelled";
        default:
          // draft 之类的早期取消，按 role 推断
          if (role === "reviewer") return "reviewer_cancelled";
          if (role === "test_evidence") return "test_evidence_cancelled";
          return "coder_cancelled";
      }
    }
    default: {
      const _exhaustive: never = code;
      throw new UnsupportedFailureMappingError(
        `unsupported lastError.code: ${String(code)}`,
        code,
        role,
      );
    }
  }
};

/**
 * spec §16.2 表 TaskNode.roleFailureReason 列。
 *
 * 返回 null 表示「不写 TaskNode reason」：
 * - `gitlab_rate_limited`：fail-soft，不改 TaskNode 状态。
 * - `pipeline_cancelled` 发生在 `draft`（PipelineRun 还未跑起来）阶段：
 *   仅清掉 currentPipelineRunId，TaskNode 回滚到 `ready`。
 */
export const toTaskNodeReason = (
  code: LastErrorCode,
  role: AgentRole,
  ctx: FailureMappingContext = {},
): TaskRoleFailureReason | null => {
  assertKnown(code);
  switch (code) {
    case "scope_insufficient":
      return "reviewer_cannot_review";
    case "prompt_template_missing":
      if (ctx.phase === "role_profile_init") return "role_profile_invalid";
      // agent_start 阶段或未指定 phase：reviewer 启动前缺 prompt → block reviewer
      return "reviewer_cannot_review";
    case "prompt_render_failed":
      return "reviewer_cannot_review";
    case "reviewer_unavailable":
    case "parse_failed":
      return "reviewer_unavailable";
    case "runner_unavailable":
      if (role === "coder") return "coding_failed";
      if (role === "reviewer") return "reviewer_unavailable";
      return "evidence_unavailable";
    case "sandbox_violation":
      return "sandbox_violation";
    case "redaction_failed":
      return "reviewer_cannot_review";
    case "storage_full":
      return "storage_full";
    case "gitlab_rate_limited":
      return null;
    case "coding_failed":
      return "coding_failed";
    case "evidence_unavailable":
      return "evidence_unavailable";
    case "evidence_partial":
      return "evidence_partial";
    case "reviewer_requested_changes":
      return "reviewer_requested_changes";
    case "pipeline_cancelled": {
      switch (ctx.pipelineStatus) {
        case "running_coding":
          return "coding_failed";
        case "running_reviewer":
          return "reviewer_unavailable";
        case "running_test_evidence":
          return "evidence_unavailable";
        default:
          // 早期 cancel：TaskNode 不写 reason（spec §14.6 / §16.2 表）
          return null;
      }
    }
    default: {
      const _exhaustive: never = code;
      throw new UnsupportedFailureMappingError(
        `unsupported lastError.code: ${String(code)}`,
        code,
        role,
      );
    }
  }
};
