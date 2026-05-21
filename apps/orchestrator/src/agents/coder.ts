/**
 * V4.6 spec §8.2 / §10 / §16.2 + V4.7 runner adapter contract：Coder Agent。
 *
 * 接受一个 `RunnerRegistry`，从 profile.runnerId 取出 adapter，运行一次
 * runner，把 `RunnerResult` 翻译成 `CoderAgentReport`。运行 / 输出错误
 * 通过 `runnerErrorToLastErrorCode()` 收敛到统一的 `lastError.code` truth
 * source（spec §16.2）。runner trace（runnerId / runnerKind / runnerRunId）
 * 写入 `AgentReport` 用于 V4.7 追溯。
 *
 * 设计要点：
 * - 业务报告由本模块构造；runner adapter 不直接写 AgentReport
 *   (spec §3 / Task 4 边界)。
 * - runner 抛 / registry fail closed → coder 仍然落 AgentReport
 *   (`status = "failed"`, `lastError.code = "runner_unavailable"`)，
 *   保留 runner trace 但 runnerRunId 可以为 null。
 * - runner result 是 `cancelled` → 返回 `{ kind: "cancelled" }`，
 *   coordinator 据此把 PipelineRun 整体 cancel。
 * - runner result 的 `redactedFields[]` 被映射到 AgentReport 的
 *   `redactedFields[]`（前缀 `runner.`）以保留 redaction audit。
 */

import { randomUUID } from "node:crypto";

import type {
  CoderAgentReport,
  RunnerArtifact,
  RunnerResult,
  TaskNode,
  WorkItem,
  WorkflowToolGrant,
} from "@issuepilot/shared-contracts";

import type { CoderRoleProfile } from "../pipelines/role-profile.js";
import { runnerErrorToLastErrorCode } from "../runners/failure-mapping.js";
import { RunnerRegistryError } from "../runners/registry.js";
import type { RunnerRegistry } from "../runners/types.js";
import type { RunnerEventSink } from "../runners/types.js";

/**
 * V4.6 legacy export：daemon / other modules may still throw these as
 * defensive shorthand. With V4.7 the agent factory primarily maps
 * `RunnerError.code` directly, but the symbols are kept exported so
 * downstream catch-clauses do not break.
 */
export class RunnerUnavailableError extends Error {
  override readonly name = "RunnerUnavailableError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export class SandboxViolationError extends Error {
  override readonly name = "SandboxViolationError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface CoderAgentRunInput {
  workItem: WorkItem;
  task: TaskNode;
  pipelineRun: { pipelineRunId: string };
  profile: CoderRoleProfile;
  /** Codex 的工作目录，必须落在 issue worktree 范围内（spec §6）。 */
  cwd: string;
  now?: () => string;
  newId?: () => string;
}

export type CoderAgentResult =
  | { kind: "report"; report: CoderAgentReport }
  | { kind: "cancelled"; cancelledAt: string };

export interface CoderAgent {
  run(input: CoderAgentRunInput): Promise<CoderAgentResult>;
}

const RUNNER_KIND_CODEX = "codex_app_server" as const;

const buildRunnerInput = (
  input: CoderAgentRunInput,
  toolAllow: WorkflowToolGrant[],
) => ({
  runnerId: input.profile.runnerId,
  role: "coder" as const,
  prompt: input.profile.prompt,
  cwd: input.cwd,
  workItemId: input.workItem.workItemId,
  taskId: input.task.taskId,
  pipelineRunId: input.pipelineRun.pipelineRunId,
  roleProfileId: input.profile.roleProfileId,
  toolAllow,
  sandbox: input.profile.sandbox,
  metadata: { agentReportRole: "coder" as const },
  ...(input.profile.timeoutSeconds !== undefined
    ? { timeoutSeconds: input.profile.timeoutSeconds }
    : {}),
});

interface ParsedArtifacts {
  diffSummary: string;
  branch: string;
  mergeRequest?: { iid: number; url: string; state: "opened" | "merged" | "closed" };
  runReportArtifactId?: string;
}

const isMrState = (v: unknown): v is "opened" | "merged" | "closed" =>
  v === "opened" || v === "merged" || v === "closed";

const MR_SUMMARY_RE = /^merge_request:(\d+):(.+)$/;
// adapter 在 `kind: "diff"` artifact 的 summary 头部插入 `branch:<name>\n`
// (见 apps/orchestrator/src/runners/codex-app-server.ts:buildArtifacts).
// 这里只提取 branch,剩余文本继续作为 `diffSummary` 给 dashboard / run
// report 渲染。读不到时让 branch 留空,由 report-artifact 决定 fallback。
const DIFF_BRANCH_HEADER_RE = /^branch:([^\n]+)\n?/;

const parseArtifacts = (
  artifacts: RunnerArtifact[] | undefined,
): ParsedArtifacts => {
  let diffSummary = "";
  let branch = "";
  let mergeRequest: ParsedArtifacts["mergeRequest"];
  if (artifacts) {
    for (const a of artifacts) {
      if (a.kind === "diff" && typeof a.summary === "string") {
        let body = a.summary;
        const m = DIFF_BRANCH_HEADER_RE.exec(body);
        if (m) {
          branch = m[1]!.trim();
          body = body.slice(m[0].length);
        }
        diffSummary = body.trim();
      }
      // 注意:`kind: "text"` artifact 故意不再 fallback 进 `diffSummary`。
      // 之前的实现会让 Codex 的 final_message 散文污染 dashboard 的
      // "diff" 显示 (V4.7 review H2)。Codex 散文应该走 `finalMessage`
      // 链路(reviewer JSON 等)或者由调用方显式消费 `text` artifact。
      if (a.kind === "tool_result" && typeof a.summary === "string") {
        const match = MR_SUMMARY_RE.exec(a.summary);
        if (match) {
          const iid = Number(match[1]);
          const url = match[2]!;
          mergeRequest = {
            iid,
            url,
            state: "opened",
          };
        }
      }
    }
  }
  void isMrState;
  return mergeRequest
    ? { diffSummary, branch, mergeRequest }
    : { diffSummary, branch };
};

const runnerRedactedFieldsToReport = (
  result: RunnerResult,
): string[] => {
  if (!result.redactedFields || result.redactedFields.length === 0) return [];
  return result.redactedFields.map((field) => `runner.${field}`);
};

export const createCoderAgent = (deps: {
  runnerRegistry: RunnerRegistry;
  events?: RunnerEventSink;
  now?: () => string;
  newId?: () => string;
}): CoderAgent => {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const newId = deps.newId ?? ((): string => randomUUID());

  return {
    async run(input) {
      const tickNow = input.now ?? now;
      const tickId = input.newId ?? newId;
      const startedAt = tickNow();
      const runnerId = input.profile.runnerId;

      let result: RunnerResult;
      try {
        const adapter = deps.runnerRegistry.getForRole({
          role: "coder",
          runnerId,
        });
        const runnerInput = buildRunnerInput(input, input.profile.toolAllow);
        result = await adapter.run(
          runnerInput,
          deps.events ? { events: deps.events } : undefined,
        );
      } catch (cause) {
        const isRegistryError = cause instanceof RunnerRegistryError;
        const message =
          cause instanceof Error ? cause.message : String(cause);
        const report: CoderAgentReport = {
          agentReportId: tickId(),
          workItemId: input.workItem.workItemId,
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "coder",
          roleProfileId: input.profile.roleProfileId,
          runnerId,
          runnerKind: RUNNER_KIND_CODEX,
          runnerRunId: null,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: {
            code: isRegistryError ? "runner_unavailable" : "coding_failed",
            message,
          },
          evidenceLinks: [],
          redactedFields: [],
          coder: { diffSummary: "", branch: "" },
        };
        return { kind: "report", report };
      }

      if (result.status === "cancelled") {
        return { kind: "cancelled", cancelledAt: result.cancelledAt };
      }

      const runnerRunId = result.runId ?? null;
      const redactedFields = runnerRedactedFieldsToReport(result);

      if (result.status === "failed" || result.status === "timeout") {
        const errorCode = runnerErrorToLastErrorCode(result.error.code);
        // V4.7 review follow-up:failed / timeout 路径下 adapter 现在也会
        // 把已存在的 MR artifact 透出来,coder report 把它带进
        // `coder.mergeRequest`,让 reviewer / dashboard 不会丢已经创建的
        // MR(对应「pipeline 后期失败但 MR 已经创建」场景)。
        const parsed = parseArtifacts(result.artifacts);
        const report: CoderAgentReport = {
          agentReportId: tickId(),
          workItemId: input.workItem.workItemId,
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "coder",
          roleProfileId: input.profile.roleProfileId,
          runnerId,
          runnerKind: RUNNER_KIND_CODEX,
          runnerRunId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          ...(result.runId ? { runId: result.runId } : {}),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: { code: errorCode, message: result.error.message },
          evidenceLinks: [],
          redactedFields,
          coder: {
            diffSummary: "",
            branch: "",
            ...(parsed.mergeRequest
              ? { mergeRequest: parsed.mergeRequest }
              : {}),
          },
        };
        return { kind: "report", report };
      }

      // status === "completed"
      const parsed = parseArtifacts(result.artifacts);
      const evidenceLinks: string[] = [];
      if (parsed.runReportArtifactId) {
        evidenceLinks.push(
          `run-report-artifact://${parsed.runReportArtifactId}`,
        );
      }
      const report: CoderAgentReport = {
        agentReportId: tickId(),
        workItemId: input.workItem.workItemId,
        pipelineRunId: input.pipelineRun.pipelineRunId,
        taskId: input.task.taskId,
        role: "coder",
        roleProfileId: input.profile.roleProfileId,
        runnerId,
        runnerKind: RUNNER_KIND_CODEX,
        runnerRunId,
        status: "complete",
        startedAt,
        completedAt: tickNow(),
        ...(result.runId ? { runId: result.runId } : {}),
        promptTemplateHash: input.profile.promptTemplateHash,
        evidenceLinks,
        redactedFields,
        coder: {
          diffSummary: parsed.diffSummary,
          branch: parsed.branch,
          ...(parsed.runReportArtifactId
            ? { runReportArtifactId: parsed.runReportArtifactId }
            : {}),
          ...(parsed.mergeRequest ? { mergeRequest: parsed.mergeRequest } : {}),
        },
      };
      return { kind: "report", report };
    },
  };
};
