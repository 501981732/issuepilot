/**
 * V4.6 spec §8 / §14 / §16：Pipeline Coordinator —— 把 effective recipe
 * 翻译成顺序执行的 agent 调用，并把每一步结果落到 PipelineStore /
 * WorkItemStore。
 *
 * 设计要点：
 * - Agent 通过 DI 传入（`CoderAgentRunner` / `ReviewerAgentRunner` /
 *   `TestEvidenceAgentRunner`），便于测试 mock。
 * - 状态推进遵循 spec §8.1：失败 / cancel / reviewer request_changes /
 *   evidence partial 各自映射到不同的 PipelineRun.status + TaskNode 状态。
 * - 任何写入失败（store fault、redaction fail）都视为 fatal，让上层
 *   daemon 重启时按 supersede 链恢复。
 */

import { randomUUID } from "node:crypto";

import {
  type AgentReport,
  type AgentRole,
  type CoderAgentReport,
  type PipelineRun,
  type PipelineRunStatus,
  type ReviewerAgentReport,
  type TaskNode,
  type TaskNodeStatus,
  type TestEvidenceAgentReport,
  type WorkItem,
  type WorkflowRecipe,
} from "@issuepilot/shared-contracts";

import { toEventKey, toTaskNodeReason } from "./failure-mapping.js";
import {
  type EffectiveRecipeSource,
  recipeRoles,
  resolveEffectiveRecipe,
  toPipelineRunRecipeSource,
} from "./recipe.js";
import type { ReviewerRoleProfile, RoleProfile } from "./role-profile.js";
import type { PipelineStore } from "./store.js";

export type AgentRunResult =
  | { kind: "report"; report: AgentReport }
  | { kind: "cancelled"; cancelledAt: string };

export interface AgentRunInput<TProfile extends RoleProfile = RoleProfile> {
  workItem: WorkItem;
  task: TaskNode;
  pipelineRun: PipelineRun;
  profile: TProfile;
}

export interface CoderAgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface ReviewerAgentRunner {
  run(input: AgentRunInput<ReviewerRoleProfile>): Promise<AgentRunResult>;
}

export interface TestEvidenceAgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface CoordinatorAgents {
  coder: CoderAgentRunner;
  reviewer: ReviewerAgentRunner;
  testEvidence: TestEvidenceAgentRunner;
}

export interface RoleProfileResolver {
  /** 按 role 返回已经渲染好的 RoleProfile；缺角色返回 null。 */
  resolveRoleProfile(
    role: AgentRole,
    ctx: { workItem: WorkItem; task: TaskNode },
  ): Promise<RoleProfile | null>;
}

/**
 * patch 字段允许 `undefined` 用于显式清空（TaskNode 上的 V4.6 字段如
 * `currentPipelineRunId` / `pendingRecipe` / `roleFailureReason`），
 * 配合 tsconfig `exactOptionalPropertyTypes` 严格模式。
 */
export type TaskPatch = {
  [K in keyof TaskNode]?: TaskNode[K] | undefined;
};

export interface TaskWriter {
  updateTask(input: {
    workItemId: string;
    taskId: string;
    patch: TaskPatch;
  }): Promise<void>;
}

export interface StartPipelineInput {
  workItem: WorkItem;
  task: TaskNode;
  /** workflow YAML 的默认 recipe。 */
  workflowDefault: WorkflowRecipe;
  /** 操作员可以 override 一次（spec §8.1）。 */
  pendingRecipe?: WorkflowRecipe | undefined;
  /** clock injection，方便测试。 */
  now?: () => string;
}

export interface StartPipelineResult {
  pipelineRun: PipelineRun;
  /** pipeline 收尾时刻，所有 AgentReport 已落盘。 */
  finalStatus: PipelineRunStatus;
  /** 推进过程中创建 / 加载过的 reports，便于上层注入 EventBus。 */
  reports: AgentReport[];
}

export class CoordinatorError extends Error {
  override readonly name = "CoordinatorError";

  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface CoordinatorEventEmitter {
  emit(event: { key: string; payload: Record<string, unknown> }): void;
}

const isCoderReport = (r: AgentReport): r is CoderAgentReport =>
  r.role === "coder";
const isReviewerReport = (r: AgentReport): r is ReviewerAgentReport =>
  r.role === "reviewer";
const isTestEvidenceReport = (r: AgentReport): r is TestEvidenceAgentReport =>
  r.role === "test_evidence";

const ROLE_TO_RUNNING_STATE: Record<AgentRole, PipelineRunStatus> = {
  coder: "running_coding",
  reviewer: "running_reviewer",
  test_evidence: "running_test_evidence",
};

const ROLE_TO_TASK_RUNNING: Record<AgentRole, TaskNodeStatus> = {
  coder: "running_coding",
  reviewer: "running_reviewer",
  test_evidence: "running_test_evidence",
};

export interface CreateCoordinatorOptions {
  pipelineStore: PipelineStore;
  agents: CoordinatorAgents;
  roleProfileResolver: RoleProfileResolver;
  taskWriter: TaskWriter;
  events?: CoordinatorEventEmitter;
  /** clock injection 用于稳定时序测试。 */
  now?: () => string;
  /** 默认 randomUUID()，测试可注入稳定 id。 */
  newId?: () => string;
}

export interface Coordinator {
  startPipeline(input: StartPipelineInput): Promise<StartPipelineResult>;
}

export const createCoordinator = (
  opts: CreateCoordinatorOptions,
): Coordinator => {
  const now = opts.now ?? (() => new Date().toISOString());
  const newId = opts.newId ?? (() => randomUUID());

  const persistRun = async (run: PipelineRun): Promise<void> => {
    await opts.pipelineStore.savePipelineRun(run);
  };

  const persistReport = async (report: AgentReport): Promise<void> => {
    await opts.pipelineStore.saveAgentReport(report);
  };

  const emit = (key: string, payload: Record<string, unknown>): void => {
    opts.events?.emit({ key, payload });
  };

  const startPipeline = async (
    input: StartPipelineInput,
  ): Promise<StartPipelineResult> => {
    const eff = resolveEffectiveRecipe({
      workflowDefault: input.workflowDefault,
      pendingRecipe: input.pendingRecipe,
      pipelineRecipe: undefined,
    });
    const recipeSource = eff.source === "workflow_default"
      ? "workflow_default"
      : toPipelineRunRecipeSource(eff.source as EffectiveRecipeSource);

    const pipelineRunId = newId();
    const t0 = now();
    let run: PipelineRun = {
      pipelineRunId,
      workItemId: input.workItem.workItemId,
      taskId: input.task.taskId,
      recipe: eff.recipe,
      recipeSource,
      agentReportIds: { coder: null, reviewer: null, test_evidence: null },
      status: ROLE_TO_RUNNING_STATE.coder,
      currentRole: "coder",
      createdAt: t0,
      updatedAt: t0,
    };
    await persistRun(run);
    await opts.taskWriter.updateTask({
      workItemId: input.workItem.workItemId,
      taskId: input.task.taskId,
      patch: {
        status: ROLE_TO_TASK_RUNNING.coder,
        currentPipelineRunId: pipelineRunId,
        pendingRecipe: undefined,
        pendingRecipeSource: undefined,
        last_cancelled_at: undefined,
        roleFailureReason: undefined,
        statusReason: undefined,
      },
    });
    emit("pipeline_started", {
      pipelineRunId,
      taskId: input.task.taskId,
      recipe: eff.recipe,
    });

    const reports: AgentReport[] = [];
    const roles = recipeRoles(eff.recipe);
    let cancelledAt: string | null = null;

    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i]!;
      run = {
        ...run,
        status: ROLE_TO_RUNNING_STATE[role],
        currentRole: role,
        updatedAt: now(),
      };
      await persistRun(run);
      await opts.taskWriter.updateTask({
        workItemId: input.workItem.workItemId,
        taskId: input.task.taskId,
        patch: { status: ROLE_TO_TASK_RUNNING[role] },
      });

      const profile = await opts.roleProfileResolver.resolveRoleProfile(role, {
        workItem: input.workItem,
        task: input.task,
      });
      if (!profile) {
        throw new CoordinatorError(
          `missing role profile for ${role}`,
          "role_profile_invalid",
        );
      }

      let result: AgentRunResult;
      if (role === "coder") {
        result = await opts.agents.coder.run({
          workItem: input.workItem,
          task: input.task,
          pipelineRun: run,
          profile,
        });
      } else if (role === "reviewer") {
        if (profile.role !== "reviewer") {
          throw new CoordinatorError(
            "reviewer role profile mismatch",
            "role_profile_invalid",
          );
        }
        result = await opts.agents.reviewer.run({
          workItem: input.workItem,
          task: input.task,
          pipelineRun: run,
          profile,
        });
      } else {
        result = await opts.agents.testEvidence.run({
          workItem: input.workItem,
          task: input.task,
          pipelineRun: run,
          profile,
        });
      }

      if (result.kind === "cancelled") {
        cancelledAt = result.cancelledAt;
        run = {
          ...run,
          status: "cancelled",
          currentRole: null,
          updatedAt: now(),
          completedAt: now(),
        };
        await persistRun(run);
        await opts.taskWriter.updateTask({
          workItemId: input.workItem.workItemId,
          taskId: input.task.taskId,
          patch: {
            status: "needs_rework",
            last_cancelled_at: cancelledAt,
            currentPipelineRunId: undefined,
          },
        });
        emit(toEventKey("pipeline_cancelled", role, { pipelineStatus: run.status }) ?? "pipeline_cancelled", {
          pipelineRunId,
          taskId: input.task.taskId,
          role,
        });
        return { pipelineRun: run, finalStatus: "cancelled", reports };
      }

      const report = result.report;
      await persistReport(report);
      reports.push(report);
      run = {
        ...run,
        agentReportIds: {
          ...run.agentReportIds,
          [role]: report.agentReportId,
        },
        updatedAt: now(),
      };
      await persistRun(run);

      // 处理失败 / 特殊 decision
      if (report.status === "failed") {
        const code = report.lastError?.code ?? "coding_failed";
        const taskReason = toTaskNodeReason(code, role);
        run = {
          ...run,
          status: "failed",
          currentRole: null,
          updatedAt: now(),
          completedAt: now(),
        };
        await persistRun(run);
        await opts.taskWriter.updateTask({
          workItemId: input.workItem.workItemId,
          taskId: input.task.taskId,
          patch: {
            status: taskReason === "storage_full" ? "blocked" : "failed",
            ...(taskReason !== null ? { roleFailureReason: taskReason } : {}),
            ...(report.lastError?.message
              ? { statusReason: report.lastError.message }
              : {}),
            currentPipelineRunId: undefined,
          },
        });
        const evKey = toEventKey(code, role);
        if (evKey) emit(evKey, { pipelineRunId, taskId: input.task.taskId, role });
        return { pipelineRun: run, finalStatus: "failed", reports };
      }

      if (isReviewerReport(report)) {
        const decision = report.reviewer.decision;
        if (decision === "cannot_review") {
          run = {
            ...run,
            status: "failed",
            currentRole: null,
            updatedAt: now(),
            completedAt: now(),
          };
          await persistRun(run);
          await opts.taskWriter.updateTask({
            workItemId: input.workItem.workItemId,
            taskId: input.task.taskId,
            patch: {
              status: "blocked",
              roleFailureReason: "reviewer_cannot_review",
              currentPipelineRunId: undefined,
            },
          });
          emit("reviewer_cannot_review", {
            pipelineRunId,
            taskId: input.task.taskId,
          });
          return { pipelineRun: run, finalStatus: "failed", reports };
        }
        if (decision === "request_changes") {
          run = {
            ...run,
            status: "awaiting_rework",
            currentRole: null,
            updatedAt: now(),
            completedAt: now(),
          };
          await persistRun(run);
          await opts.taskWriter.updateTask({
            workItemId: input.workItem.workItemId,
            taskId: input.task.taskId,
            patch: {
              status: "needs_rework",
              roleFailureReason: "reviewer_requested_changes",
              currentPipelineRunId: undefined,
            },
          });
          emit("reviewer_requested_changes", {
            pipelineRunId,
            taskId: input.task.taskId,
          });
          return { pipelineRun: run, finalStatus: "awaiting_rework", reports };
        }
      }
    }

    // pipeline 顺利推到末端，决定 final status
    const teReport = reports.find(isTestEvidenceReport);
    const finalStatus: PipelineRunStatus =
      teReport && teReport.status === "incomplete"
        ? "partial"
        : "awaiting_human_review";

    run = {
      ...run,
      status: finalStatus,
      currentRole: null,
      updatedAt: now(),
      completedAt: now(),
    };
    await persistRun(run);
    await opts.taskWriter.updateTask({
      workItemId: input.workItem.workItemId,
      taskId: input.task.taskId,
      patch: {
        status: "awaiting_human_review",
        currentPipelineRunId: undefined,
        ...(finalStatus === "partial"
          ? { roleFailureReason: "evidence_partial" }
          : {}),
      },
    });
    emit("pipeline_finished", {
      pipelineRunId,
      taskId: input.task.taskId,
      finalStatus,
    });
    return { pipelineRun: run, finalStatus, reports };
  };

  return { startPipeline };
};

// Re-export 便于 daemon 用一个文件 import 即可。
export type { RoleProfile, ReviewerRoleProfile } from "./role-profile.js";
export type { PipelineStore } from "./store.js";
export { isCoderReport, isReviewerReport, isTestEvidenceReport };
