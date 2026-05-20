/**
 * V4.6 spec §8.2 / §10 / §16.2：Coder Agent。
 *
 * 负责一件事：把一份已经渲染好的 `CoderRoleProfile` + workItem/task 上下文
 * 交给 Codex lifecycle 跑一遍，最后写一份 `CoderAgentReport`。
 *
 * 设计要点：
 * - lifecycle 通过 DI 传入（`CoderLifecycleRunner`），便于 daemon wiring
 *   时复用既有 `@issuepilot/runner-codex-app-server`，而测试只需 mock。
 * - lifecycle 抛 `RunnerUnavailableError` / `SandboxViolationError` 时
 *   coder 仍会尝试落 AgentReport（`status = "failed"`，对应 `lastError.code`），
 *   spec §16.2 表 row 4 / row 7。
 * - lifecycle 返回 cancellation → `AgentRunResult.kind = "cancelled"`，
 *   coordinator 据此把 PipelineRun 整体 cancel。
 * - 不在本模块自动 write AgentReport 到 PipelineStore；persist 由
 *   coordinator 在 happy path 上完成。
 */

import { randomUUID } from "node:crypto";

import type {
  CoderAgentReport,
  LastErrorCode,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";

import type { CoderRoleProfile } from "../pipelines/role-profile.js";

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

export interface CoderLifecycleRunInput {
  profile: CoderRoleProfile;
  prompt: string;
  cwd: string;
  workItem: WorkItem;
  task: TaskNode;
}

export type CoderLifecycleStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "unknown";

export interface CoderLifecycleRunResult {
  runId: string;
  /** Codex agent 在 cwd 下产生的最终 diff/summary（已过 redact）。 */
  diffSummary: string;
  /** 落到本地 worktree 的 branch 名。 */
  branch: string;
  /** 可选：V4.3 RunReportArtifact id，dashboard 链接到它。 */
  runReportArtifactId?: string | undefined;
  buildStatus?: CoderLifecycleStatus;
  testStatus?: CoderLifecycleStatus;
  lintStatus?: CoderLifecycleStatus;
  mergeRequest?: {
    iid: number;
    url: string;
    state: "opened" | "merged" | "closed";
  };
}

export type CoderLifecycleOutcome =
  | { kind: "completed"; result: CoderLifecycleRunResult }
  /** 整体 lifecycle 跑完但 agent 自己声明 failed（例如 CI fail）。 */
  | {
      kind: "failed";
      reason: LastErrorCode;
      message: string;
      runId?: string | undefined;
      partial?: Partial<CoderLifecycleRunResult>;
    }
  | { kind: "cancelled"; cancelledAt: string };

export interface CoderLifecycleRunner {
  run(input: CoderLifecycleRunInput): Promise<CoderLifecycleOutcome>;
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

const codeToBranch = (lastErr: unknown): LastErrorCode => {
  if (lastErr instanceof RunnerUnavailableError) return "runner_unavailable";
  if (lastErr instanceof SandboxViolationError) return "sandbox_violation";
  return "coding_failed";
};

export const createCoderAgent = (deps: {
  lifecycle: CoderLifecycleRunner;
  /** clock injection；默认 Date.now()。 */
  now?: () => string;
  newId?: () => string;
}): CoderAgent => {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  return {
    async run(input) {
      const tickNow = input.now ?? now;
      const tickId = input.newId ?? newId;
      const startedAt = tickNow();
      let outcome: CoderLifecycleOutcome;
      try {
        outcome = await deps.lifecycle.run({
          profile: input.profile,
          prompt: input.profile.prompt,
          cwd: input.cwd,
          workItem: input.workItem,
          task: input.task,
        });
      } catch (cause) {
        const code = codeToBranch(cause);
        const report: CoderAgentReport = {
          agentReportId: tickId(),
          workItemId: input.workItem.workItemId,
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "coder",
          roleProfileId: input.profile.roleProfileId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: {
            code,
            message: cause instanceof Error ? cause.message : String(cause),
          },
          evidenceLinks: [],
          redactedFields: [],
          coder: { diffSummary: "", branch: "" },
        };
        return { kind: "report", report };
      }

      if (outcome.kind === "cancelled") {
        return { kind: "cancelled", cancelledAt: outcome.cancelledAt };
      }

      if (outcome.kind === "failed") {
        const report: CoderAgentReport = {
          agentReportId: tickId(),
          workItemId: input.workItem.workItemId,
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          role: "coder",
          roleProfileId: input.profile.roleProfileId,
          status: "failed",
          startedAt,
          completedAt: tickNow(),
          ...(outcome.runId ? { runId: outcome.runId } : {}),
          promptTemplateHash: input.profile.promptTemplateHash,
          lastError: { code: outcome.reason, message: outcome.message },
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: outcome.partial?.diffSummary ?? "",
            branch: outcome.partial?.branch ?? "",
            ...(outcome.partial?.runReportArtifactId
              ? { runReportArtifactId: outcome.partial.runReportArtifactId }
              : {}),
            ...(outcome.partial?.buildStatus
              ? { buildStatus: outcome.partial.buildStatus }
              : {}),
            ...(outcome.partial?.testStatus
              ? { testStatus: outcome.partial.testStatus }
              : {}),
            ...(outcome.partial?.lintStatus
              ? { lintStatus: outcome.partial.lintStatus }
              : {}),
          },
        };
        return { kind: "report", report };
      }

      // completed
      const r = outcome.result;
      const report: CoderAgentReport = {
        agentReportId: tickId(),
        workItemId: input.workItem.workItemId,
        pipelineRunId: input.pipelineRun.pipelineRunId,
        taskId: input.task.taskId,
        role: "coder",
        roleProfileId: input.profile.roleProfileId,
        status: "complete",
        startedAt,
        completedAt: tickNow(),
        runId: r.runId,
        promptTemplateHash: input.profile.promptTemplateHash,
        evidenceLinks: r.runReportArtifactId
          ? [`run-report-artifact://${r.runReportArtifactId}`]
          : [],
        redactedFields: [],
        coder: {
          diffSummary: r.diffSummary,
          branch: r.branch,
          ...(r.runReportArtifactId
            ? { runReportArtifactId: r.runReportArtifactId }
            : {}),
          ...(r.buildStatus ? { buildStatus: r.buildStatus } : {}),
          ...(r.testStatus ? { testStatus: r.testStatus } : {}),
          ...(r.lintStatus ? { lintStatus: r.lintStatus } : {}),
          ...(r.mergeRequest ? { mergeRequest: r.mergeRequest } : {}),
        },
      };
      return { kind: "report", report };
    },
  };
};
