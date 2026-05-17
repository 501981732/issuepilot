import { randomUUID } from "node:crypto";

import type { TaskNode, TaskPlan } from "@issuepilot/shared-contracts";

import { validatePlanDraft } from "./plan-validation.js";

/**
 * V4.1 Planner（spec §7 V4.1、§11 主流程第 3 步、§12.1 拆解失败）。
 *
 * planner 的职责是把大 Issue 文本翻译成 2–5 个可执行子任务草案；调用方
 * 决定是否接受。我们刻意把"如何调用 LLM"抽成 `callPlannerLlm` 注入项：
 *
 *   - 生产实现：daemon 用 Codex runner 跑一个 single-turn prompt，要求
 *     模型返回 JSON schema。
 *   - 测试 / 离线场景：注入 fake `callPlannerLlm` 直接返回固定的
 *     `RawPlanResponse`，让 V4.1 流程脱离 LLM 抖动也能确定地跑。
 *
 * 错误码与下游 UI / 质量分析共享：
 *   - planner_call_failed   ─ LLM 调用本身抛错（超时 / 网络）。
 *   - planner_parse_failed  ─ 模型回的内容不是合法 JSON，或没有 tasks[]。
 *   - too_few_tasks / too_many_tasks / dependency_cycle / ...
 *                            ─ 来自 plan-validation，原样透传。
 *
 * 这一层不写盘也不发事件；store / 事件由 daemon 装配层负责，这样 planner
 * 既可以被 dashboard 直接调（同步）也能被 daemon 异步调度。
 */
export interface RawPlanResponse {
  tasks: Array<
    Partial<TaskNode> & {
      taskId: string;
      title: string;
    }
  >;
}

export type DraftResult =
  | { ok: true; plan: TaskPlan }
  | { ok: false; code: string; message: string };

export interface PlannerIssueInput {
  iid: number;
  title: string;
  description: string;
  url: string;
  projectId: string;
  labels: string[];
}

/**
 * V4.2: when set, the planner is asked to redraft EXACTLY ONE task by
 * `taskId`. The non-scoped tasks of the current plan stay untouched and
 * are merged back by the service layer. The planner enforces the
 * single-task invariant; service.replanTask owns the merge.
 */
export interface ReplanScope {
  taskId: string;
  reason: string;
  hint?: string;
}

export interface WorkItemPlanner {
  draft(input: {
    issue: PlannerIssueInput;
    /** 已经为 work item 分配好的 id；新建场景由 daemon 生成后再调。 */
    workItemId?: string;
    /** V4.2 single-task replan scope。 */
    replanScope?: ReplanScope;
  }): Promise<DraftResult>;
}

export interface PlannerDeps {
  /**
   * 实际调用 LLM 的 hook。返回值可以是已经解析好的 `RawPlanResponse`，
   * 也可以是模型原始 JSON 字符串（planner 内部会尝试解析）。失败时直接
   * 抛错，planner 会把它转成 `planner_call_failed`。
   */
  callPlannerLlm(input: {
    issue: {
      title: string;
      description: string;
      labels: string[];
    };
    /** V4.2: when set, the prompt asks for a single replacement task. */
    replanScope?: ReplanScope;
  }): Promise<RawPlanResponse | string>;
}

export function createWorkItemPlanner(deps: PlannerDeps): WorkItemPlanner {
  return {
    async draft({ issue, workItemId, replanScope }) {
      let raw: unknown;
      try {
        raw = await deps.callPlannerLlm({
          issue: {
            title: issue.title,
            description: issue.description,
            labels: issue.labels,
          },
          ...(replanScope ? { replanScope } : {}),
        });
      } catch (err) {
        return {
          ok: false,
          code: "planner_call_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      const parsed = typeof raw === "string" ? safeParseJson(raw) : raw;
      if (!isRawPlanResponse(parsed)) {
        return {
          ok: false,
          code: "planner_parse_failed",
          message:
            "Planner response is not a JSON object containing a `tasks` array.",
        };
      }

      const tasks: TaskNode[] = parsed.tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        goal: typeof t.goal === "string" ? t.goal : "",
        scope: typeof t.scope === "string" ? t.scope : "",
        ...(Array.isArray(t.nonGoals) ? { nonGoals: t.nonGoals } : {}),
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
        suggestedValidation: Array.isArray(t.suggestedValidation)
          ? t.suggestedValidation
          : [],
        status: "planned",
        runIds: [],
        riskLevel: (t.riskLevel ?? "low") as TaskNode["riskLevel"],
      }));

      // V4.2 replan path: enforce single-task invariant and matching id;
      // skip validatePlanDraft (which requires 2-5 tasks). The service
      // layer merges this one task back into the previous plan.
      if (replanScope) {
        if (tasks.length !== 1) {
          return {
            ok: false,
            code: "replan_returned_multi",
            message: `Replan must return exactly 1 task (got ${tasks.length}).`,
          };
        }
        const only = tasks[0]!;
        if (only.taskId !== replanScope.taskId) {
          return {
            ok: false,
            code: "replan_task_id_mismatch",
            message: `Replan returned taskId ${only.taskId}; expected ${replanScope.taskId}.`,
          };
        }
        if (!only.title || only.title.trim().length === 0) {
          return {
            ok: false,
            code: "missing_title",
            message: `Replanned task ${only.taskId} has no title.`,
          };
        }
        if (!only.goal || only.goal.trim().length === 0) {
          return {
            ok: false,
            code: "missing_goal",
            message: `Replanned task ${only.taskId} has no goal.`,
          };
        }
        const replanPlan: TaskPlan = {
          planId: randomUUID(),
          workItemId: workItemId ?? "",
          version: 1,
          tasks: [only],
          dependencies: only.dependsOn.map((from) => ({
            from,
            to: only.taskId,
          })),
          operatorEdits: [],
          status: "draft",
        };
        return { ok: true, plan: replanPlan };
      }

      const validation = validatePlanDraft(tasks);
      if (!validation.ok) {
        return {
          ok: false,
          code: validation.code,
          message: validation.message,
        };
      }

      const dependencies = tasks.flatMap((t) =>
        t.dependsOn.map((from) => ({ from, to: t.taskId })),
      );

      const plan: TaskPlan = {
        planId: randomUUID(),
        workItemId: workItemId ?? "",
        version: 1,
        tasks,
        dependencies,
        operatorEdits: [],
        status: "draft",
      };

      return { ok: true, plan };
    },
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * LLM output is untrusted: the planner contract (see header) promises that
 * EVERY parse problem becomes `planner_parse_failed` instead of an uncaught
 * exception. We therefore validate not just the envelope (`{ tasks: [...] }`)
 * but also each element shape — `null`, primitives, or objects missing
 * `taskId` / `title` would otherwise crash the `tasks.map(...)` projection
 * with a raw `TypeError`. Anything that fails this guard is funnelled into
 * the stable `planner_parse_failed` code in `draft()`.
 *
 * Deeper field validation (riskLevel value set, dependsOn cycles, 2–5 task
 * count, etc.) still lives in `plan-validation.ts`; this guard only ensures
 * the projection is safe and the response has the minimal shape promised
 * by the LLM contract.
 */
function isRawPlanResponse(value: unknown): value is RawPlanResponse {
  if (!value || typeof value !== "object") return false;
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.every(
    (t) =>
      !!t &&
      typeof t === "object" &&
      typeof (t as { taskId?: unknown }).taskId === "string" &&
      typeof (t as { title?: unknown }).title === "string",
  );
}
