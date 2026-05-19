/**
 * V4.6 spec §18：Pipeline Service —— 把 store / coordinator / workflow
 * 三个底层拼成 HTTP route 直接消费的高层接口。
 *
 * 设计要点：
 * - 所有方法返回 `{ ok: true; value }` 或 `{ ok: false; error: { code, message } }`，
 *   error.code 必须落在 spec §18.4 `PipelineRouteErrorCode` 集合内，方便
 *   Fastify route 直接把 code 映射成 HTTP status。
 * - service 不知道 single / team 模式：daemon 在装配时为每个 project 单独
 *   `createPipelineService(...)`，再用 server 的 project-resolver pattern
 *   按 header 派发。
 * - coder retry 与 reviewer / test_evidence retry 走不同路径：
 *   - reviewer / test_evidence：复用同一个 PipelineRun，调用
 *     `coordinator.retryRole()` 在 supersede 链上追加新 AgentReport。
 *   - coder：直接清空 TaskNode 的 V4.6 状态字段（pendingRecipe / last_cancelled_at
 *     / currentPipelineRunId / roleFailureReason），交回给上层调度系统创建
 *     新 PipelineRun。本 service 不在响应里塞 newPipelineRunId（保留为
 *     undefined），dashboard 收到 200 后下次轮询 `GET /api/work-items/:id/tasks/:taskId/pipeline`
 *     会拿到新创建的 PipelineRun（spec §15 auto-advance）。
 * - skip：reviewer / test_evidence 的当前 AgentReport status → cancelled，
 *   并把 PipelineRun 推到下一个 role 的 running_* 或 awaiting_human_review。
 *   coder skip 直接返回 `role_skip_not_allowed`（spec §18.3）。
 * - validateWorkflowRoles：现阶段是纯结构校验 —— 三个 role 都存在 +
 *   每个 role 都有 `promptTemplateHash`。后续 V4.7+ 接入 sandbox / token
 *   scope 探测时再扩展。
 */

import {
  isWorkflowRecipe,
  type AgentReport,
  type AgentRole,
  type GetAgentReportResponse,
  type GetPipelineResponse,
  type ListPipelineRunAgentReportsResponse,
  type ListPipelinesResponse,
  type ListTaskAgentReportsResponse,
  type PipelineRouteErrorCode,
  type PipelineRun,
  type AgentReportSummary,
  type RetryAgentReportResponse,
  type RevokeAiReviewResponse,
  type SetRecipeOverrideResponse,
  type SkipAgentReportResponse,
  type TaskNode,
  type ValidateWorkflowRolesResponse,
  type WorkItem,
  type WorkflowRecipe,
  type WorkflowRolesConfig,
} from "@issuepilot/shared-contracts";

import type { Coordinator } from "./coordinator.js";
import { recipeRoles } from "./recipe.js";
import type { PipelineStore } from "./store.js";

export type PipelineServiceResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: PipelineRouteErrorCode; message: string };
    };

const err = (
  code: PipelineRouteErrorCode,
  message: string,
): PipelineServiceResult<never> => ({ ok: false, error: { code, message } });

/**
 * patch 字段允许显式 `undefined`，让 service 在 coder retry 时清空
 * `currentPipelineRunId` / `roleFailureReason` 等 V4.6 字段（spec §8.3）。
 * 与 `coordinator.ts:TaskPatch` 保持同一形状，daemon 注入时可以直接
 * 把 `taskWriter.updateTask` 转接进来。
 */
export type PipelineTaskPatch = {
  [K in keyof TaskNode]?: TaskNode[K] | undefined;
};

export interface PipelineWorkItemAccess {
  getWorkItem(id: string): Promise<WorkItem | undefined>;
  getTask(input: {
    workItemId: string;
    taskId: string;
  }): Promise<TaskNode | undefined>;
  updateTask(input: {
    workItemId: string;
    taskId: string;
    patch: PipelineTaskPatch;
  }): Promise<void>;
}

export interface PipelineWorkflowAccess {
  /** Workflow YAML 的 `default_recipe`。 */
  getDefaultRecipe(): WorkflowRecipe;
  /** Workflow YAML 的 `roles:` 节（已 parse + resolve）。 */
  getRoles(): WorkflowRolesConfig;
}

export interface RevokeReviewerMrCommentsInput {
  agentReportId: string;
  noteIds: string[];
  operator?: string;
}

export interface RevokeReviewerMrCommentsResult {
  revokedAt: string;
}

export interface CreatePipelineServiceOptions {
  pipelineStore: PipelineStore;
  coordinator: Coordinator;
  workItems: PipelineWorkItemAccess;
  workflow: PipelineWorkflowAccess;
  /**
   * Phase 7 reviewer publisher 提供的 revoke 入口。未注入时，service 仍
   * 写 `mrPublication.status = "revoked"` 到 AgentReport，但**不会**调用
   * GitLab API（dev / tests / 缺凭据的部署可走此降级路径）。
   */
  revokeReviewerMrComments?: (
    input: RevokeReviewerMrCommentsInput,
  ) => Promise<RevokeReviewerMrCommentsResult>;
  /** Clock 注入，便于测试稳定时序。 */
  now?: () => string;
}

export interface PipelineService {
  getPipelineForTask(input: {
    workItemId: string;
    taskId: string;
  }): Promise<PipelineServiceResult<GetPipelineResponse>>;
  listPipelinesForTask(input: {
    workItemId: string;
    taskId: string;
  }): Promise<PipelineServiceResult<ListPipelinesResponse>>;
  getAgentReport(input: {
    agentReportId: string;
  }): Promise<PipelineServiceResult<GetAgentReportResponse>>;
  listTaskAgentReports(input: {
    workItemId: string;
    taskId: string;
    role?: AgentRole;
    includeSuperseded?: boolean;
  }): Promise<PipelineServiceResult<ListTaskAgentReportsResponse>>;
  listPipelineRunAgentReports(input: {
    pipelineRunId: string;
  }): Promise<PipelineServiceResult<ListPipelineRunAgentReportsResponse>>;
  setRecipeOverride(input: {
    workItemId: string;
    taskId: string;
    recipe: WorkflowRecipe;
    operator?: string;
  }): Promise<PipelineServiceResult<SetRecipeOverrideResponse>>;
  revokeAiReview(input: {
    agentReportId: string;
    operator?: string;
  }): Promise<PipelineServiceResult<RevokeAiReviewResponse>>;
  retryAgentReport(input: {
    agentReportId: string;
    operator?: string;
    reason?: string;
  }): Promise<PipelineServiceResult<RetryAgentReportResponse>>;
  skipAgentReport(input: {
    agentReportId: string;
    operator?: string;
    reason?: string;
  }): Promise<PipelineServiceResult<SkipAgentReportResponse>>;
  validateWorkflowRoles(input: {
    workflowId: string;
  }): Promise<PipelineServiceResult<ValidateWorkflowRolesResponse>>;
}

const summarizeReport = (report: AgentReport): AgentReportSummary => {
  const base: AgentReportSummary = {
    agentReportId: report.agentReportId,
    pipelineRunId: report.pipelineRunId,
    taskId: report.taskId,
    role: report.role,
    status: report.status,
    startedAt: report.startedAt,
  };
  if (report.completedAt) base.completedAt = report.completedAt;
  if (report.lastError?.code) base.lastErrorCode = report.lastError.code;
  const supersededBy = (report as { supersededBy?: string }).supersededBy;
  if (typeof supersededBy === "string" && supersededBy.length > 0) {
    base.supersededBy = supersededBy;
  }
  if (report.role === "reviewer") {
    base.decision = report.reviewer.decision;
    base.confidence = report.reviewer.confidence;
  }
  return base;
};

const TASK_STATUSES_PENDING_ALLOWED = new Set<TaskNode["status"]>([
  "planned",
  "blocked_by_dependency",
  "ready",
]);

const TASK_STATUSES_LOCKED_FROM_OVERRIDE = new Set<TaskNode["status"]>([
  "running_coding",
  "running_reviewer",
  "running_test_evidence",
  "awaiting_human_review",
]);

export const createPipelineService = (
  opts: CreatePipelineServiceOptions,
): PipelineService => {
  const now = opts.now ?? (() => new Date().toISOString());

  const findReport = async (
    agentReportId: string,
  ): Promise<
    | {
        report: AgentReport;
        taskId: string;
        role: AgentRole;
      }
    | null
  > => opts.pipelineStore.findAgentReportById(agentReportId);

  const collectAgentReportSummaries = async (
    run: PipelineRun,
  ): Promise<AgentReportSummary[]> => {
    const summaries: AgentReportSummary[] = [];
    for (const role of ["coder", "reviewer", "test_evidence"] as const) {
      const id = run.agentReportIds[role];
      if (!id) continue;
      const r = await opts.pipelineStore.getAgentReport({
        taskId: run.taskId,
        role,
        agentReportId: id,
      });
      if (r) summaries.push(summarizeReport(r));
    }
    return summaries;
  };

  return {
    async getPipelineForTask({ workItemId, taskId }) {
      const task = await opts.workItems.getTask({ workItemId, taskId });
      if (!task) {
        return err("task_not_found", `task ${taskId} not found`);
      }
      const latest = await opts.pipelineStore.latestForTask({
        workItemId,
        taskId,
      });
      const value: GetPipelineResponse = {
        pipelineRun: latest,
        agentReports: latest ? await collectAgentReportSummaries(latest) : [],
      };
      if (task.pendingRecipe && isWorkflowRecipe(task.pendingRecipe)) {
        value.pendingRecipe = task.pendingRecipe;
      }
      if (
        task.pendingRecipeSource === "workflow_default" ||
        task.pendingRecipeSource === "operator_override"
      ) {
        value.pendingRecipeSource = task.pendingRecipeSource;
      }
      return { ok: true, value };
    },

    async listPipelinesForTask({ workItemId, taskId }) {
      const task = await opts.workItems.getTask({ workItemId, taskId });
      if (!task) return err("task_not_found", `task ${taskId} not found`);
      const items = await opts.pipelineStore.listForTask({
        workItemId,
        taskId,
      });
      return {
        ok: true,
        value: {
          pipelineRuns: items.map((it) => it.pipelineRun),
        },
      };
    },

    async getAgentReport({ agentReportId }) {
      const found = await findReport(agentReportId);
      if (!found) {
        return err(
          "agent_report_not_found",
          `agent report ${agentReportId} not found`,
        );
      }
      return { ok: true, value: { agentReport: found.report } };
    },

    async listTaskAgentReports({
      workItemId,
      taskId,
      role,
      includeSuperseded,
    }) {
      const task = await opts.workItems.getTask({ workItemId, taskId });
      if (!task) return err("task_not_found", `task ${taskId} not found`);
      const roles: AgentRole[] = role
        ? [role]
        : ["coder", "reviewer", "test_evidence"];
      const out: AgentReportSummary[] = [];
      for (const r of roles) {
        const { reports, index } = await opts.pipelineStore.listAgentReportsForRole({
          taskId,
          role: r,
        });
        for (const rep of reports) {
          const reportId = rep.agentReportId;
          const supersededBy = (rep as { supersededBy?: string })
            .supersededBy;
          if (!includeSuperseded && supersededBy) continue;
          // Defensive: if the index lists an id but the file is missing
          // skip silently (the supersede chain still references the
          // missing entry; dashboard will show "deleted").
          void index;
          out.push(summarizeReport({ ...rep, agentReportId: reportId }));
        }
      }
      return { ok: true, value: { agentReports: out } };
    },

    async listPipelineRunAgentReports({ pipelineRunId }) {
      // We do not have a direct prid → (wid, tid) index so we have to scan
      // pipelines/<wid>/<tid>/<prid>.json. For the typical small workspaces
      // V4.6 targets this is bounded and acceptable.
      const matches = await scanPipelineRunById(opts.pipelineStore, pipelineRunId);
      if (!matches) {
        return err(
          "pipeline_run_not_found",
          `pipeline run ${pipelineRunId} not found`,
        );
      }
      const reports: AgentReport[] = [];
      for (const role of ["coder", "reviewer", "test_evidence"] as const) {
        const id = matches.agentReportIds[role];
        if (!id) continue;
        const r = await opts.pipelineStore.getAgentReport({
          taskId: matches.taskId,
          role,
          agentReportId: id,
        });
        if (r) reports.push(r);
      }
      return { ok: true, value: { agentReports: reports } };
    },

    async setRecipeOverride({ workItemId, taskId, recipe }) {
      if (!isWorkflowRecipe(recipe)) {
        return err("unknown_recipe", `unknown recipe: ${String(recipe)}`);
      }
      const task = await opts.workItems.getTask({ workItemId, taskId });
      if (!task) return err("task_not_found", `task ${taskId} not found`);

      if (TASK_STATUSES_LOCKED_FROM_OVERRIDE.has(task.status)) {
        return err(
          "recipe_override_locked",
          `task is ${task.status}; recipe cannot be overridden`,
        );
      }

      // ready 状态：如果已经有 draft PipelineRun，直接更新它；否则写
      // pendingRecipe（PipelineRun 创建时灌入）。
      if (task.status === "ready" && task.currentPipelineRunId) {
        const run = await opts.pipelineStore.getPipelineRunById({
          workItemId,
          taskId,
          pipelineRunId: task.currentPipelineRunId,
        });
        if (run) {
          // 不允许覆盖已经开始跑的 PipelineRun（防御：理论上 task 状态
          // 应该已经 caught it via running_* 检查，但 store / TaskNode
          // 之间可能不同步，加一层兜底）。
          if (
            run.status === "running_coding" ||
            run.status === "running_reviewer" ||
            run.status === "running_test_evidence"
          ) {
            return err(
              "recipe_override_locked",
              `pipeline run ${run.pipelineRunId} is ${run.status}; recipe cannot be overridden`,
            );
          }
          const updated: PipelineRun = {
            ...run,
            recipe,
            recipeSource: "operator_override",
            updatedAt: now(),
          };
          await opts.pipelineStore.savePipelineRun(updated);
          return {
            ok: true,
            value: {
              recipe,
              recipeSource: "operator_override",
              appliedTo: "pipeline_run",
              pipelineRunId: run.pipelineRunId,
            },
          };
        }
      }

      // planned / blocked_by_dependency / ready 无 PipelineRun → pendingRecipe。
      if (!TASK_STATUSES_PENDING_ALLOWED.has(task.status)) {
        return err(
          "recipe_override_locked",
          `task is ${task.status}; recipe cannot be overridden`,
        );
      }

      await opts.workItems.updateTask({
        workItemId,
        taskId,
        patch: {
          pendingRecipe: recipe,
          pendingRecipeSource: "operator_override",
        },
      });
      return {
        ok: true,
        value: {
          recipe,
          recipeSource: "operator_override",
          appliedTo: "pending",
        },
      };
    },

    async revokeAiReview({ agentReportId, operator }) {
      const found = await findReport(agentReportId);
      if (!found) {
        return err(
          "agent_report_not_found",
          `agent report ${agentReportId} not found`,
        );
      }
      if (found.role !== "reviewer") {
        return err(
          "role_mismatch",
          `agent report ${agentReportId} is not a reviewer report`,
        );
      }
      // discriminated union narrows to reviewer here
      const reviewer = found.report;
      if (reviewer.role !== "reviewer") {
        return err("role_mismatch", `unexpected role narrowing failure`);
      }
      const publication = reviewer.reviewer.mrPublication;
      if (publication.status !== "published") {
        return err(
          "not_revocable",
          `mr publication status is ${publication.status}; only published reviews can be revoked`,
        );
      }
      let revokedAt = now();
      if (opts.revokeReviewerMrComments) {
        const outcome = await opts.revokeReviewerMrComments({
          agentReportId,
          noteIds: publication.noteIds,
          ...(operator ? { operator } : {}),
        });
        revokedAt = outcome.revokedAt;
      }
      const updated: AgentReport = {
        ...reviewer,
        reviewer: {
          ...reviewer.reviewer,
          mrPublication: {
            ...publication,
            status: "revoked",
          },
        },
      };
      await opts.pipelineStore.saveAgentReport(updated);
      return {
        ok: true,
        value: {
          agentReportId,
          status: "revoked",
          revokedAt,
        },
      };
    },

    async retryAgentReport({ agentReportId, operator: _operator, reason: _reason }) {
      void _operator;
      void _reason;
      const found = await findReport(agentReportId);
      if (!found) {
        return err(
          "agent_report_not_found",
          `agent report ${agentReportId} not found`,
        );
      }
      const run = await opts.pipelineStore.getPipelineRunById({
        workItemId: "",
        taskId: found.taskId,
        pipelineRunId: found.report.pipelineRunId,
      }).catch(() => undefined);
      // We may not have a workItemId here since reverse-lookup; do a scan if
      // the direct path fails (this is rare but possible during tests where
      // workItemId is required to build the path).
      const concreteRun =
        run ??
        (await scanPipelineRunById(
          opts.pipelineStore,
          found.report.pipelineRunId,
        ).then((m) => m ?? null));
      if (!concreteRun) {
        return err(
          "pipeline_run_not_found",
          `pipeline run ${found.report.pipelineRunId} not found`,
        );
      }

      const task = await opts.workItems.getTask({
        workItemId: concreteRun.workItemId,
        taskId: concreteRun.taskId,
      });
      const workItem = await opts.workItems.getWorkItem(concreteRun.workItemId);
      if (!task || !workItem) {
        return err("task_not_found", `task ${concreteRun.taskId} not found`);
      }

      if (found.role === "coder") {
        // Coder retry: clear V4.6 state, leave PipelineRun in place (caller
        // observes pipelineRun marked failed/cancelled). The next dispatch
        // tick will create a new PipelineRun and supersede the previous one.
        await opts.workItems.updateTask({
          workItemId: concreteRun.workItemId,
          taskId: concreteRun.taskId,
          patch: {
            status: "ready",
            currentPipelineRunId: undefined,
            last_cancelled_at: undefined,
            roleFailureReason: undefined,
            statusReason: undefined,
          },
        });
        return {
          ok: true,
          value: {
            pipelineRunId: concreteRun.pipelineRunId,
          },
        };
      }

      // reviewer / test_evidence: reuse the existing PipelineRun and link
      // the new report into the supersede chain via the coordinator.
      try {
        const outcome = await opts.coordinator.retryRole({
          workItem,
          task,
          pipelineRunId: concreteRun.pipelineRunId,
          role: found.role,
        });
        return {
          ok: true,
          value: {
            pipelineRunId: outcome.pipelineRun.pipelineRunId,
            agentReportId: outcome.report.agentReportId,
          },
        };
      } catch (cause) {
        return err(
          "invalid_payload",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },

    async skipAgentReport({ agentReportId, operator: _operator, reason: _reason }) {
      void _operator;
      void _reason;
      const found = await findReport(agentReportId);
      if (!found) {
        return err(
          "agent_report_not_found",
          `agent report ${agentReportId} not found`,
        );
      }
      if (found.role === "coder") {
        return err(
          "role_skip_not_allowed",
          "coder role cannot be skipped; retry the pipeline instead",
        );
      }

      const cancelledReport: AgentReport = {
        ...found.report,
        status: "cancelled",
        completedAt: now(),
        lastError: {
          code: "pipeline_cancelled",
          message: "skipped_by_operator",
        },
      };
      await opts.pipelineStore.saveAgentReport(cancelledReport);

      // Look up the parent PipelineRun to decide where the pipeline should
      // land next (next role in recipe or `awaiting_human_review`).
      const concreteRun = await scanPipelineRunById(
        opts.pipelineStore,
        found.report.pipelineRunId,
      );
      let nextRole: AgentRole | "awaiting_human_review" = "awaiting_human_review";
      if (concreteRun) {
        const order = recipeRoles(concreteRun.recipe);
        const idx = order.indexOf(found.role);
        if (idx >= 0 && idx < order.length - 1) {
          nextRole = order[idx + 1]!;
        }
        const updatedRun: PipelineRun = {
          ...concreteRun,
          status:
            nextRole === "awaiting_human_review"
              ? "awaiting_human_review"
              : nextRole === "reviewer"
                ? "running_reviewer"
                : nextRole === "test_evidence"
                  ? "running_test_evidence"
                  : "running_coding",
          currentRole: nextRole === "awaiting_human_review" ? null : nextRole,
          updatedAt: now(),
          ...(nextRole === "awaiting_human_review"
            ? { completedAt: now() }
            : {}),
        };
        await opts.pipelineStore.savePipelineRun(updatedRun);
        if (nextRole === "awaiting_human_review") {
          await opts.workItems.updateTask({
            workItemId: concreteRun.workItemId,
            taskId: concreteRun.taskId,
            patch: {
              status: "awaiting_human_review",
              currentPipelineRunId: undefined,
            },
          });
        }
      }

      return {
        ok: true,
        value: {
          pipelineRunId: found.report.pipelineRunId,
          agentReportId,
          nextRole,
        },
      };
    },

    async validateWorkflowRoles({ workflowId: _workflowId }) {
      void _workflowId;
      const roles = opts.workflow.getRoles();
      const errors: ValidateWorkflowRolesResponse["errors"] = [];
      for (const role of ["coder", "reviewer", "test_evidence"] as const) {
        const cfg = roles[role];
        if (!cfg) {
          errors.push({
            code: "missing_role",
            message: `roles.${role} is not configured`,
            role,
          });
          continue;
        }
        if (!cfg.promptTemplateHash) {
          errors.push({
            code: "missing_prompt_template_hash",
            message: `roles.${role}.promptTemplateHash is missing; did you call resolveWorkflow?`,
            role,
          });
        }
      }
      return {
        ok: true,
        value: {
          valid: errors.length === 0,
          errors,
        },
      };
    },
  };
};

/**
 * Walk `<root>/pipelines/<wid>/<tid>/<prid>.json` to locate a PipelineRun by
 * id alone. Used by `listPipelineRunAgentReports` / `retryAgentReport` /
 * `skipAgentReport` where the dashboard only passes the run id.
 */
const scanPipelineRunById = async (
  store: PipelineStore,
  pipelineRunId: string,
): Promise<PipelineRun | null> => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const pipelinesRoot = path.join(store.root, "pipelines");
  let wids: string[];
  try {
    wids = await fs.readdir(pipelinesRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  for (const wid of wids) {
    let taskDirs: string[];
    try {
      taskDirs = await fs.readdir(path.join(pipelinesRoot, wid));
    } catch {
      continue;
    }
    for (const tid of taskDirs) {
      const candidate = path.join(
        pipelinesRoot,
        wid,
        tid,
        `${pipelineRunId}.json`,
      );
      try {
        await fs.access(candidate);
      } catch {
        continue;
      }
      const run = await store.getPipelineRunById({
        workItemId: wid,
        taskId: tid,
        pipelineRunId,
      });
      if (run) return run;
    }
  }
  return null;
};
