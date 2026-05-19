/**
 * V4.6 spec §8.2 / §11 / §12 / §16.2：Reviewer Agent。
 *
 * 负责：
 * 1. 把 Codex lifecycle 输出的 reviewer message 解析成结构化 payload
 *    （summary / decision / confidence / findings / inlineComments /
 *    risks / evidenceRequest）。
 * 2. 按 `severityThreshold` / `maxInlineComments` 过滤 findings →
 *    inlineComments（spec §11 / §12）。
 * 3. 写出 `ReviewerAgentReport`：成功（含 `request_changes` /
 *    `cannot_review`）为 `status = "complete"`；解析失败 / lifecycle 崩
 *    为 `status = "failed"` + lastError.code。
 *
 * 注：MR publish / revoke 由独立模块 `gitlab/mr-comments.ts` 负责（Phase
 * 7 Task 7.4），coordinator 在 reviewer.run 之后再调用。
 */

import { randomUUID } from "node:crypto";

import {
  FINDING_SEVERITY_VALUES,
  INLINE_COMMENT_SEVERITY_VALUES,
  REVIEWER_DECISION_VALUES,
  REVIEWER_SEVERITY_THRESHOLD_VALUES,
  type LastErrorCode,
  type ReviewerAgentReport,
  type ReviewerDecision,
  type ReviewerEvidenceRequest,
  type ReviewerFinding,
  type ReviewerInlineComment,
  type ReviewerRisk,
  type ReviewerSeverityThreshold,
  type TaskNode,
  type WorkItem,
} from "@issuepilot/shared-contracts";
import { ReviewerSummaryTooLongError, assertReviewerSummaryLength } from "@issuepilot/shared-contracts";

import type { ReviewerRoleProfile } from "../pipelines/role-profile.js";

export interface ReviewerLifecycleResult {
  runId: string;
  /** Codex 输出的原始 message（待 parse）。 */
  rawMessage: string;
}

export type ReviewerLifecycleOutcome =
  | { kind: "message"; result: ReviewerLifecycleResult }
  | { kind: "failed"; reason: LastErrorCode; message: string; runId?: string }
  | { kind: "cancelled"; cancelledAt: string };

export interface ReviewerLifecycleRunner {
  run(input: {
    profile: ReviewerRoleProfile;
    prompt: string;
    cwd: string;
    workItem: WorkItem;
    task: TaskNode;
  }): Promise<ReviewerLifecycleOutcome>;
}

const SEVERITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export class ReviewerParseError extends Error {
  override readonly name = "ReviewerParseError";

  constructor(
    message: string,
    public readonly code: "prompt_output_schema_mismatch" | "reviewer_summary_too_long",
  ) {
    super(message);
  }
}

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const ensureArray = (v: unknown, where: string): unknown[] => {
  if (!Array.isArray(v)) {
    throw new ReviewerParseError(
      `${where} must be an array`,
      "prompt_output_schema_mismatch",
    );
  }
  return v;
};

const parseFinding = (raw: unknown, where: string): ReviewerFinding => {
  if (!raw || typeof raw !== "object") {
    throw new ReviewerParseError(
      `${where} entry must be object`,
      "prompt_output_schema_mismatch",
    );
  }
  const obj = raw as Record<string, unknown>;
  const sev = obj.severity;
  if (!isString(sev) || !(FINDING_SEVERITY_VALUES as readonly string[]).includes(sev)) {
    throw new ReviewerParseError(
      `${where}.severity invalid`,
      "prompt_output_schema_mismatch",
    );
  }
  if (!isString(obj.category) || !isString(obj.message)) {
    throw new ReviewerParseError(
      `${where} missing category/message`,
      "prompt_output_schema_mismatch",
    );
  }
  const finding: ReviewerFinding = {
    severity: sev as ReviewerFinding["severity"],
    category: obj.category,
    message: obj.message,
  };
  if (obj.locationHint && typeof obj.locationHint === "object") {
    const lh = obj.locationHint as Record<string, unknown>;
    if (isString(lh.filePath)) {
      finding.locationHint = { filePath: lh.filePath };
      if (lh.lineRange && typeof lh.lineRange === "object") {
        const lr = lh.lineRange as Record<string, unknown>;
        if (typeof lr.start === "number" && typeof lr.end === "number") {
          finding.locationHint.lineRange = { start: lr.start, end: lr.end };
        }
      }
    }
  }
  return finding;
};

const parseRisk = (raw: unknown, where: string): ReviewerRisk => {
  if (!raw || typeof raw !== "object") {
    throw new ReviewerParseError(
      `${where} entry must be object`,
      "prompt_output_schema_mismatch",
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    !isString(obj.severity) ||
    !(FINDING_SEVERITY_VALUES as readonly string[]).includes(obj.severity) ||
    !isString(obj.message)
  ) {
    throw new ReviewerParseError(
      `${where} invalid`,
      "prompt_output_schema_mismatch",
    );
  }
  return {
    severity: obj.severity as ReviewerRisk["severity"],
    message: obj.message,
  };
};

const parseEvidenceRequest = (
  raw: unknown,
  where: string,
): ReviewerEvidenceRequest => {
  if (!raw || typeof raw !== "object") {
    throw new ReviewerParseError(
      `${where} entry must be object`,
      "prompt_output_schema_mismatch",
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    !isString(obj.kind) ||
    !["screenshot", "playwright_walkthrough", "ci_log", "test_run", "custom"].includes(
      obj.kind,
    ) ||
    !isString(obj.target) ||
    !isString(obj.rationale)
  ) {
    throw new ReviewerParseError(
      `${where} invalid`,
      "prompt_output_schema_mismatch",
    );
  }
  return {
    kind: obj.kind as ReviewerEvidenceRequest["kind"],
    target: obj.target,
    rationale: obj.rationale,
  };
};

const parseInlineComment = (
  raw: unknown,
  where: string,
): ReviewerInlineComment => {
  if (!raw || typeof raw !== "object") {
    throw new ReviewerParseError(
      `${where} entry must be object`,
      "prompt_output_schema_mismatch",
    );
  }
  const obj = raw as Record<string, unknown>;
  if (
    !isString(obj.filePath) ||
    !obj.lineRange ||
    typeof obj.lineRange !== "object" ||
    !isString(obj.severity) ||
    !(INLINE_COMMENT_SEVERITY_VALUES as readonly string[]).includes(obj.severity) ||
    !isString(obj.category) ||
    !isString(obj.message)
  ) {
    throw new ReviewerParseError(
      `${where} invalid`,
      "prompt_output_schema_mismatch",
    );
  }
  const lr = obj.lineRange as Record<string, unknown>;
  if (typeof lr.start !== "number" || typeof lr.end !== "number") {
    throw new ReviewerParseError(
      `${where}.lineRange invalid`,
      "prompt_output_schema_mismatch",
    );
  }
  const inline: ReviewerInlineComment = {
    filePath: obj.filePath,
    lineRange: { start: lr.start, end: lr.end },
    severity: obj.severity as ReviewerInlineComment["severity"],
    category: obj.category,
    message: obj.message,
  };
  if (isString(obj.suggestedFix)) {
    inline.suggestedFix = obj.suggestedFix;
  }
  return inline;
};

export interface ReviewerParseResult {
  summary: string;
  decision: ReviewerDecision;
  confidence: number;
  risks: ReviewerRisk[];
  evidenceRequest: ReviewerEvidenceRequest[];
  findings: ReviewerFinding[];
  /** 来自 LLM 直接给出的 inline；如果 LLM 没给，留空数组，下游 helper
   *  会从 findings 派生。 */
  inlineComments: ReviewerInlineComment[];
}

const FENCE_RE = /```json\s*([\s\S]*?)```/i;

/**
 * spec §11.1：从 reviewer raw message 中抽出 JSON fence，并 schema 校验。
 * 解析失败抛 ReviewerParseError；summary > 4000 字符也抛错。
 */
export const parseReviewerMessage = (raw: string): ReviewerParseResult => {
  const match = raw.match(FENCE_RE);
  if (!match || !match[1]) {
    throw new ReviewerParseError(
      "reviewer output missing ```json fence",
      "prompt_output_schema_mismatch",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (cause) {
    throw new ReviewerParseError(
      `reviewer JSON fence invalid: ${(cause as Error).message}`,
      "prompt_output_schema_mismatch",
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ReviewerParseError(
      "reviewer payload must be object",
      "prompt_output_schema_mismatch",
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (!isString(obj.summary)) {
    throw new ReviewerParseError(
      "summary missing",
      "prompt_output_schema_mismatch",
    );
  }
  try {
    assertReviewerSummaryLength(obj.summary);
  } catch (cause) {
    if (cause instanceof ReviewerSummaryTooLongError) {
      throw new ReviewerParseError(
        "reviewer_summary_too_long",
        "reviewer_summary_too_long",
      );
    }
    throw cause;
  }
  if (
    !isString(obj.decision) ||
    !(REVIEWER_DECISION_VALUES as readonly string[]).includes(obj.decision)
  ) {
    throw new ReviewerParseError(
      "decision invalid",
      "prompt_output_schema_mismatch",
    );
  }
  if (typeof obj.confidence !== "number" || obj.confidence < 0 || obj.confidence > 1) {
    throw new ReviewerParseError(
      "confidence must be in [0,1]",
      "prompt_output_schema_mismatch",
    );
  }
  const findings = ensureArray(obj.findings ?? [], "findings").map((r, i) =>
    parseFinding(r, `findings[${i}]`),
  );
  const risks = ensureArray(obj.risks ?? [], "risks").map((r, i) =>
    parseRisk(r, `risks[${i}]`),
  );
  const evidenceRequest = ensureArray(
    obj.evidenceRequest ?? [],
    "evidenceRequest",
  ).map((r, i) => parseEvidenceRequest(r, `evidenceRequest[${i}]`));
  const inlineComments = ensureArray(
    obj.inlineComments ?? [],
    "inlineComments",
  ).map((r, i) => parseInlineComment(r, `inlineComments[${i}]`));

  return {
    summary: obj.summary,
    decision: obj.decision as ReviewerDecision,
    confidence: obj.confidence,
    risks,
    evidenceRequest,
    findings,
    inlineComments,
  };
};

/**
 * spec §11.1：confidence 序列化保留两位小数（用作 dashboard 文本 + MR
 * note 文本）。注意：JSON 落盘时仍然是 number；这里只做 display helper。
 */
export const formatReviewerConfidence = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) return "0.00";
  if (value > 1) return "1.00";
  return value.toFixed(2);
};

export interface FilterFindingsInput {
  findings: ReviewerFinding[];
  severityThreshold: ReviewerSeverityThreshold;
  maxInlineComments: number;
  /** LLM 直接给出的 inlineComments；若非空优先使用，仍要 filter + cap。 */
  llmInlineComments?: ReviewerInlineComment[];
}

export interface FilterFindingsResult {
  /** 给 GitLab MR 推送的 inline 列表（已过滤 + 截断）。 */
  inlineComments: ReviewerInlineComment[];
  /** 因 cap 被裁掉的条数，用于 markdown 主 note 末尾追加摘要。 */
  hiddenCount: number;
}

const findingToInline = (f: ReviewerFinding): ReviewerInlineComment | null => {
  if (!f.locationHint) return null;
  const sev = f.severity;
  if (!(INLINE_COMMENT_SEVERITY_VALUES as readonly string[]).includes(sev)) {
    return null;
  }
  const lh = f.locationHint;
  const range = lh.lineRange ?? { start: 1, end: 1 };
  return {
    filePath: lh.filePath,
    lineRange: range,
    severity: sev as ReviewerInlineComment["severity"],
    category: f.category,
    message: f.message,
  };
};

/**
 * spec §11 / §12：按 severityThreshold（low/medium/high/critical 中至少其一
 * 为 medium 起：spec 默认 medium）过滤；按 maxInlineComments 截断；并把
 * 隐藏数量返回供主 note 渲染聚合。
 */
export const filterFindingsForInline = (
  input: FilterFindingsInput,
): FilterFindingsResult => {
  const threshold = SEVERITY_RANK[input.severityThreshold] ?? 2;
  const base: ReviewerInlineComment[] = (
    input.llmInlineComments && input.llmInlineComments.length > 0
      ? input.llmInlineComments
      : (input.findings
          .map(findingToInline)
          .filter((x): x is ReviewerInlineComment => x !== null))
  );
  // low 永不入 inline，threshold 拦截更高 severity。
  const filtered = base.filter((c) => {
    const rank = SEVERITY_RANK[c.severity] ?? 0;
    return rank >= threshold;
  });
  const cap = Math.max(0, input.maxInlineComments);
  if (filtered.length <= cap) {
    return { inlineComments: filtered, hiddenCount: 0 };
  }
  return {
    inlineComments: filtered.slice(0, cap),
    hiddenCount: filtered.length - cap,
  };
};

export interface ReviewerAgentRunInput {
  workItem: WorkItem;
  task: TaskNode;
  pipelineRun: { pipelineRunId: string };
  profile: ReviewerRoleProfile;
  cwd: string;
  now?: () => string;
  newId?: () => string;
}

export type ReviewerAgentResult =
  | { kind: "report"; report: ReviewerAgentReport }
  | { kind: "cancelled"; cancelledAt: string };

export interface ReviewerAgent {
  run(input: ReviewerAgentRunInput): Promise<ReviewerAgentResult>;
}

export const createReviewerAgent = (deps: {
  lifecycle: ReviewerLifecycleRunner;
  now?: () => string;
  newId?: () => string;
}): ReviewerAgent => {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return {
    async run(input) {
      const tickNow = input.now ?? now;
      const tickId = input.newId ?? newId;
      const startedAt = tickNow();
      let outcome: ReviewerLifecycleOutcome;
      try {
        outcome = await deps.lifecycle.run({
          profile: input.profile,
          prompt: input.profile.prompt,
          cwd: input.cwd,
          workItem: input.workItem,
          task: input.task,
        });
      } catch (cause) {
        const report: ReviewerAgentReport = {
          agentReportId: tickId(),
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "reviewer",
          roleProfileId: input.profile.roleProfileId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: {
            code: "reviewer_unavailable",
            message: cause instanceof Error ? cause.message : String(cause),
          },
          evidenceLinks: [],
          redactedFields: [],
          reviewer: emptyReviewer(),
        };
        return { kind: "report", report };
      }

      if (outcome.kind === "cancelled") {
        return { kind: "cancelled", cancelledAt: outcome.cancelledAt };
      }

      if (outcome.kind === "failed") {
        const report: ReviewerAgentReport = {
          agentReportId: tickId(),
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "reviewer",
          roleProfileId: input.profile.roleProfileId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          ...(outcome.runId ? { runId: outcome.runId } : {}),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: { code: outcome.reason, message: outcome.message },
          evidenceLinks: [],
          redactedFields: [],
          reviewer: emptyReviewer(),
        };
        return { kind: "report", report };
      }

      let parsed: ReviewerParseResult;
      try {
        parsed = parseReviewerMessage(outcome.result.rawMessage);
      } catch (cause) {
        const errCode: LastErrorCode = "parse_failed";
        const report: ReviewerAgentReport = {
          agentReportId: tickId(),
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "reviewer",
          roleProfileId: input.profile.roleProfileId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          runId: outcome.result.runId,
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: {
            code: errCode,
            message: cause instanceof ReviewerParseError ? cause.code : String(cause),
          },
          evidenceLinks: [],
          redactedFields: [],
          reviewer: emptyReviewer(),
        };
        return { kind: "report", report };
      }

      const filter = filterFindingsForInline({
        findings: parsed.findings,
        severityThreshold: input.profile.severityThreshold,
        maxInlineComments: input.profile.maxInlineComments,
        llmInlineComments: parsed.inlineComments,
      });

      const report: ReviewerAgentReport = {
        agentReportId: tickId(),
        pipelineRunId: input.pipelineRun.pipelineRunId,
        taskId: input.task.taskId,
        role: "reviewer",
        roleProfileId: input.profile.roleProfileId,
        status: "complete",
        startedAt,
        completedAt: tickNow(),
        runId: outcome.result.runId,
        promptTemplateHash: input.profile.promptTemplateHash,
        evidenceLinks: [],
        redactedFields: [],
        reviewer: {
          summary: parsed.summary,
          decision: parsed.decision,
          confidence: Math.round(parsed.confidence * 100) / 100,
          risks: parsed.risks,
          evidenceRequest: parsed.evidenceRequest,
          findings: parsed.findings,
          inlineComments: filter.inlineComments,
          mrPublication: input.profile.publishToMr
            ? { status: "pending", noteIds: [] }
            : { status: "skipped_by_config", noteIds: [] },
        },
      };
      return { kind: "report", report };
    },
  };
};

const emptyReviewer = (): ReviewerAgentReport["reviewer"] => ({
  summary: "",
  decision: "cannot_review",
  confidence: 0,
  risks: [],
  evidenceRequest: [],
  findings: [],
  inlineComments: [],
  mrPublication: { status: "pending", noteIds: [] },
});

export type {
  ReviewerSeverityThreshold,
} from "@issuepilot/shared-contracts";

export const REVIEWER_SEVERITY_THRESHOLDS = REVIEWER_SEVERITY_THRESHOLD_VALUES;
