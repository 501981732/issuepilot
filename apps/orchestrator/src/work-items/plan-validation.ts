import {
  RISK_LEVEL_VALUES,
  type TaskNode,
} from "@issuepilot/shared-contracts";

/**
 * V4.1 TaskPlan draft 校验。
 *
 * spec §16.2 把校验规则浓缩成：
 *   - 子任务数量控制在 2–5。
 *   - 依赖关系不能形成环。
 *   - operator edits 能生成新 plan version（在 store 层做，不在校验层）。
 *
 * 这里再加几条 P0 防御：必填字段、合法 riskLevel、依赖目标必须存在、
 * taskId 唯一、不允许 self-dependency（这是退化的 1-node 环）。
 *
 * 校验语义：第一条违规就返回，避免 UI 一次性显示十几条错误把 operator
 * 淹没。`code` 是稳定 ID，便于 i18n 与质量分析；`message` 仅做日志。
 */
export const MIN_TASKS = 2;
export const MAX_TASKS = 5;

export type ValidatePlanResult =
  | { ok: true }
  | { ok: false; code: ValidationCode; message: string };

export type ValidationCode =
  | "too_few_tasks"
  | "too_many_tasks"
  | "duplicate_task_id"
  | "missing_task_id"
  | "missing_title"
  | "missing_goal"
  | "invalid_risk_level"
  | "dependency_unknown"
  | "dependency_cycle";

export function validatePlanDraft(tasks: TaskNode[]): ValidatePlanResult {
  if (tasks.length < MIN_TASKS) {
    return {
      ok: false,
      code: "too_few_tasks",
      message: `Plan must contain at least ${MIN_TASKS} tasks (got ${tasks.length}).`,
    };
  }
  if (tasks.length > MAX_TASKS) {
    return {
      ok: false,
      code: "too_many_tasks",
      message: `Plan must contain at most ${MAX_TASKS} tasks (got ${tasks.length}).`,
    };
  }

  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.taskId || task.taskId.trim().length === 0) {
      return {
        ok: false,
        code: "missing_task_id",
        message: `Task is missing a stable taskId.`,
      };
    }
    if (seen.has(task.taskId)) {
      return {
        ok: false,
        code: "duplicate_task_id",
        message: `Duplicate taskId: ${task.taskId}.`,
      };
    }
    seen.add(task.taskId);
    if (!task.title || task.title.trim().length === 0) {
      return {
        ok: false,
        code: "missing_title",
        message: `Task ${task.taskId} has no title.`,
      };
    }
    if (!task.goal || task.goal.trim().length === 0) {
      return {
        ok: false,
        code: "missing_goal",
        message: `Task ${task.taskId} has no goal.`,
      };
    }
    if (!(RISK_LEVEL_VALUES as readonly string[]).includes(task.riskLevel)) {
      return {
        ok: false,
        code: "invalid_risk_level",
        message: `Task ${task.taskId} has invalid riskLevel: ${String(task.riskLevel)}.`,
      };
    }
  }

  const ids = new Set(tasks.map((t) => t.taskId));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.taskId) {
        return {
          ok: false,
          code: "dependency_cycle",
          message: `Task ${task.taskId} depends on itself.`,
        };
      }
      if (!ids.has(dep)) {
        return {
          ok: false,
          code: "dependency_unknown",
          message: `Task ${task.taskId} depends on missing task ${dep}.`,
        };
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    adjacency.set(task.taskId, [...task.dependsOn]);
  }
  if (hasCycle(adjacency)) {
    return {
      ok: false,
      code: "dependency_cycle",
      message: `Plan has a dependency cycle.`,
    };
  }

  return { ok: true };
}

/**
 * 经典 DFS 三色法：white = 未访问，gray = 当前 DFS 路径上，black = 完成。
 * 遇到 gray 节点说明存在 back-edge，也就是环。
 */
function hasCycle(adjacency: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);

  function visit(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const id of adjacency.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE && visit(id)) return true;
  }
  return false;
}
