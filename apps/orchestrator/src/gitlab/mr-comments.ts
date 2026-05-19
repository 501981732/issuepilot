/**
 * V4.6 spec §12 — Reviewer MR publish / revoke 联动护栏。
 *
 * 本模块封装 reviewer agent 的 MR 推送 + 撤回流程，强制 §12 的 6 条护栏：
 *
 *   1. **明确 prefix**：每条 body 以 `[ai-reviewer] ` 开头。
 *   2. **聚合主 note**：每次 publish 恰好 1 条 summary + N 条 inline。
 *   3. **severity_threshold / max_inline_comments**：由 reviewer agent
 *      在 `filterFindingsForInline` 提前过滤；本模块只接受已过滤后的
 *      `reviewer.inlineComments`，不再二次裁剪。
 *   4. **fail soft**：非 scope 错（5xx / 网络）→
 *      `mrPublication.status = "publish_failed"`，`lastError` 写入；
 *      AgentReport 不被升级为 failed。
 *   5. **revoke**：每个 inline note 的 GitLab id 被记录在 `noteIds[]`，
 *      revoke 时按 id 逐个 DELETE，404 视为已删（idempotent）。
 *   6. **redaction**：write-time 调用 `@issuepilot/observability/redact` 过
 *      滤 token / Bearer / secret 字段；任何被改写的字段路径追加到
 *      `redactedFieldsAdded`，调用方合并入 AgentReport.redactedFields[]。
 *
 * 此外，401 / 403 → `scopeInsufficient` 信号，coordinator 据此把
 * AgentReport 升级为 `status = "failed"`，`lastError.code = "scope_insufficient"`，
 * TaskNode 状态机走 `awaiting_human_review` + `roleFailureReason =
 * "reviewer_cannot_review"`（spec §16.2）。
 */

import { redact } from "@issuepilot/observability";
import type {
  AgentLastError,
  MrPublication,
  ReviewerAgentReport,
  ReviewerInlineComment,
} from "@issuepilot/shared-contracts";
import {
  createMrInlineNote,
  createMrNote,
  deleteMrNotes,
  GitLabError,
  GitLabScopeMissingError,
  type GitLabApi,
  type GitLabClient,
  type MergeRequestNotePosition,
} from "@issuepilot/tracker-gitlab";

export interface MrRef {
  iid: number;
  /** MR diff `base_sha` — required for inline `position` payload. */
  baseSha: string;
  /** MR diff `start_sha`. */
  startSha: string;
  /** MR diff `head_sha`. */
  headSha: string;
}

export interface PublishReviewerToMrInput {
  client: GitLabClient<GitLabApi>;
  reviewerReport: ReviewerAgentReport;
  mrRef: MrRef;
  /**
   * From `workflow YAML roles.reviewer.publishToMr`. When `false`,
   * `mrPublication.status = "skipped_by_config"` and no HTTP call is made.
   */
  publishToMr: boolean;
  /**
   * From `tracker.token_scope_requirements.reviewer`. Surfaces inside
   * `GitLabScopeMissingError.missingScope` so the dashboard banner can name
   * the missing scope explicitly.
   */
  requiredScope?: string;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  now?: () => string;
}

export interface PublishReviewerToMrResult {
  /**
   * Updated `MrPublication`. Caller (coordinator) is responsible for storing
   * it back into the persisted ReviewerAgentReport.
   */
  mrPublication: MrPublication;
  /**
   * Field paths (relative to ReviewerAgentReport, e.g. `reviewer.summary`,
   * `reviewer.inlineComments[0].message`) that were modified by redaction.
   * Coordinator merges these into AgentReport.redactedFields[].
   */
  redactedFieldsAdded: string[];
  /**
   * `false` when no scope issue was detected. Otherwise the missing scope
   * name; coordinator must then upgrade AgentReport to
   * `status = "failed"` / `lastError.code = "scope_insufficient"`.
   */
  scopeInsufficient: false | { missingScope: string };
}

const PREFIX = "[ai-reviewer]";

function withPrefix(body: string): string {
  if (body.startsWith(PREFIX)) return body;
  return `${PREFIX} ${body}`;
}

function applyRedaction(
  value: string | undefined,
  field: string,
  redactedFields: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const r = redact(value);
  const out = typeof r === "string" ? r : value;
  if (out !== value) {
    redactedFields.push(field);
  }
  return out;
}

function buildMainNoteBody(report: ReviewerAgentReport): string {
  const r = report.reviewer;
  const lines: string[] = [];
  lines.push(`${PREFIX} ${r.summary}`);
  lines.push("");
  lines.push(`**Decision**: ${r.decision}`);
  lines.push(`**Confidence**: ${(Math.round(r.confidence * 100) / 100)
    .toFixed(2)}`);
  if (r.risks.length > 0) {
    lines.push("");
    lines.push("### Risks");
    for (const risk of r.risks) {
      lines.push(`- ${risk.severity}: ${risk.message}`);
    }
  }
  if (r.evidenceRequest.length > 0) {
    lines.push("");
    lines.push("### Evidence requested");
    for (const ev of r.evidenceRequest) {
      lines.push(`- ${ev.kind} @ ${ev.target}: ${ev.rationale}`);
    }
  }
  return lines.join("\n");
}

function inlineNoteBody(comment: ReviewerInlineComment): string {
  const lines: string[] = [];
  lines.push(`${PREFIX} (${comment.severity}/${comment.category}) ${comment.message}`);
  if (comment.suggestedFix) {
    lines.push("");
    lines.push("**Suggested fix**:");
    lines.push("");
    lines.push("```");
    lines.push(comment.suggestedFix);
    lines.push("```");
  }
  return lines.join("\n");
}

function inlinePosition(
  comment: ReviewerInlineComment,
  mrRef: MrRef,
): MergeRequestNotePosition {
  return {
    position_type: "text",
    base_sha: mrRef.baseSha,
    start_sha: mrRef.startSha,
    head_sha: mrRef.headSha,
    new_path: comment.filePath,
    old_path: comment.filePath,
    new_line: comment.lineRange.start,
  };
}

function classifyPublishError(err: unknown): AgentLastError {
  if (err instanceof GitLabScopeMissingError) {
    return {
      code: "scope_insufficient",
      message: err.message,
      hint: err.missingScope
        ? `Add scope '${err.missingScope}' to the GitLab token used by IssuePilot.`
        : "Add the required scope to the GitLab token used by IssuePilot.",
    };
  }
  if (err instanceof GitLabError) {
    if (err.status === 429) {
      return {
        code: "gitlab_rate_limited",
        message: err.message,
      };
    }
    // For 5xx and other transient/unknown GitLab errors we still bucket into
    // gitlab_rate_limited so the dashboard "MR publish failed" surface is
    // unified; spec §16.2 maps both to FailurePatternId `gitlab_rate_limited`.
    return {
      code: "gitlab_rate_limited",
      message: err.message,
    };
  }
  return {
    code: "gitlab_rate_limited",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Redact the reviewer's user-visible strings before publishing so secrets
 * cannot escape to GitLab.
 *
 * The caller passes a *cloned* `ReviewerAgentReport`; this function mutates
 * the clone in place to keep the publish flow straightforward, and returns
 * the list of changed field paths for the AgentReport.redactedFields[] log.
 */
function redactInPlace(report: ReviewerAgentReport): string[] {
  const redactedFields: string[] = [];
  const newSummary = applyRedaction(
    report.reviewer.summary,
    "reviewer.summary",
    redactedFields,
  );
  if (newSummary !== undefined) report.reviewer.summary = newSummary;

  report.reviewer.inlineComments.forEach((comment, idx) => {
    const newMessage = applyRedaction(
      comment.message,
      `reviewer.inlineComments[${idx}].message`,
      redactedFields,
    );
    if (newMessage !== undefined) comment.message = newMessage;

    const newFix = applyRedaction(
      comment.suggestedFix,
      `reviewer.inlineComments[${idx}].suggestedFix`,
      redactedFields,
    );
    if (newFix !== undefined) comment.suggestedFix = newFix;
  });

  return redactedFields;
}

function cloneReport(report: ReviewerAgentReport): ReviewerAgentReport {
  return {
    ...report,
    reviewer: {
      ...report.reviewer,
      risks: report.reviewer.risks.map((r) => ({ ...r })),
      evidenceRequest: report.reviewer.evidenceRequest.map((e) => ({ ...e })),
      findings: report.reviewer.findings.map((f) => ({ ...f })),
      inlineComments: report.reviewer.inlineComments.map((c) => ({
        ...c,
        lineRange: { ...c.lineRange },
      })),
      mrPublication: {
        ...report.reviewer.mrPublication,
        noteIds: [...report.reviewer.mrPublication.noteIds],
      },
    },
  };
}

/**
 * V4.6 reviewer publish flow (spec §12 / Phase 7 Task 7.4).
 *
 * On `publishToMr === false` returns immediately with
 * `mrPublication.status = "skipped_by_config"` and no HTTP traffic.
 *
 * On success: posts 1 main note + N inline notes (every body prefixed with
 * `[ai-reviewer] ` and redacted), records returned ids as strings into
 * `mrPublication.noteIds`, status = `"published"`, `publishedAt = now()`.
 *
 * On scope failure (401/403): returns `scopeInsufficient = { missingScope }`
 * along with `mrPublication.status = "publish_failed"` carrying
 * `lastError.code = "scope_insufficient"`. Coordinator must promote the
 * AgentReport to `status = "failed"` so TaskNode reaches
 * `awaiting_human_review`.
 *
 * On any other GitLab error: fail soft. `mrPublication.status =
 * "publish_failed"`, `lastError.code = "gitlab_rate_limited"`. Partial
 * `noteIds` collected so far are retained so the revoke endpoint can clean
 * them up later.
 */
export async function publishReviewerToMr(
  input: PublishReviewerToMrInput,
): Promise<PublishReviewerToMrResult> {
  const { client, mrRef, publishToMr, requiredScope } = input;
  const now = input.now ?? (() => new Date().toISOString());

  if (!publishToMr) {
    return {
      mrPublication: { status: "skipped_by_config", noteIds: [] },
      redactedFieldsAdded: [],
      scopeInsufficient: false,
    };
  }

  // We never mutate the caller's report — that's the coordinator's job.
  const safeReport = cloneReport(input.reviewerReport);
  const redactedFieldsAdded = redactInPlace(safeReport);

  const noteIds: string[] = [];
  let scopeInsufficient: false | { missingScope: string } = false;
  let lastError: AgentLastError | undefined;

  // 1) main note
  try {
    const mainBody = withPrefix(buildMainNoteBody(safeReport));
    const opts: { requiredScope?: string } = {};
    if (requiredScope !== undefined) opts.requiredScope = requiredScope;
    const result = await createMrNote({
      client,
      mrIid: mrRef.iid,
      body: mainBody,
      ...opts,
    });
    noteIds.push(String(result.id));
  } catch (err) {
    if (err instanceof GitLabScopeMissingError) {
      scopeInsufficient = { missingScope: err.missingScope };
    }
    lastError = classifyPublishError(err);
  }

  // 2) inline notes — keep going even if some fail, so revoke can clean up
  //    whatever did publish.
  if (lastError === undefined) {
    for (const comment of safeReport.reviewer.inlineComments) {
      try {
        const body = withPrefix(inlineNoteBody(comment));
        const opts: { requiredScope?: string } = {};
        if (requiredScope !== undefined) opts.requiredScope = requiredScope;
        const result = await createMrInlineNote({
          client,
          mrIid: mrRef.iid,
          body,
          position: inlinePosition(comment, mrRef),
          ...opts,
        });
        noteIds.push(String(result.id));
      } catch (err) {
        if (err instanceof GitLabScopeMissingError) {
          scopeInsufficient = { missingScope: err.missingScope };
        }
        lastError = classifyPublishError(err);
        break;
      }
    }
  }

  const mrPublication: MrPublication =
    lastError === undefined
      ? {
          status: "published",
          noteIds,
          publishedAt: now(),
        }
      : {
          status: "publish_failed",
          noteIds,
          lastError,
        };

  return { mrPublication, redactedFieldsAdded, scopeInsufficient };
}

export interface RevokeReviewerMrCommentsInput {
  client: GitLabClient<GitLabApi>;
  mrIid: number;
  mrPublication: MrPublication;
  /** See {@link PublishReviewerToMrInput.requiredScope}. */
  requiredScope?: string;
  now?: () => string;
}

export interface RevokeReviewerMrCommentsResult {
  /** Updated mrPublication ready to be persisted back. */
  mrPublication: MrPublication;
}

/**
 * Delete every previously-published note for a reviewer AgentReport
 * (idempotent — per-note 404 is silently absorbed).
 *
 * On scope failure or other GitLab error this function intentionally throws;
 * the dashboard endpoint translates `GitLabScopeMissingError` into HTTP 403
 * and other `GitLabError`s into HTTP 502 so operators can retry.
 */
export async function revokeReviewerMrComments(
  input: RevokeReviewerMrCommentsInput,
): Promise<RevokeReviewerMrCommentsResult> {
  const { client, mrIid, mrPublication, requiredScope } = input;

  if (mrPublication.noteIds.length === 0) {
    return {
      mrPublication: revokedShape(mrPublication),
    };
  }

  const numericIds = mrPublication.noteIds
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n));

  const opts: { requiredScope?: string } = {};
  if (requiredScope !== undefined) opts.requiredScope = requiredScope;
  await deleteMrNotes({
    client,
    mrIid,
    noteIds: numericIds,
    ...opts,
  });

  return {
    mrPublication: revokedShape(mrPublication),
  };
}

function revokedShape(prev: MrPublication): MrPublication {
  const out: MrPublication = {
    status: "revoked",
    noteIds: [],
  };
  if (prev.publishedAt !== undefined) out.publishedAt = prev.publishedAt;
  return out;
}
