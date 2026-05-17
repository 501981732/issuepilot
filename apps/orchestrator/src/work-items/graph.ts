import type {
  TaskPlan,
  TaskRunLink,
  WorkItemGraphResponse,
} from "@issuepilot/shared-contracts";

/**
 * V4.2 Task Graph projection（spec §14.2）。
 *
 * 把 `TaskPlan + TaskRunLink[]` 投影成 `WorkItemGraphResponse`：
 *
 *  - `levels`：拓扑分层。level 0 = `dependsOn.length === 0`；level k = 所有
 *    上游都属于 level < k 的 task。tie-break 按 `taskId` 字典序。
 *  - `edges`：每条 `dependsOn` 关系一条边。
 *  - `criticalPathTaskIds`：当前 plan 上「节点数最多」的路径；多条等长时
 *    取字典序首条。注意这里只看 plan 结构，不读 `TaskRunLink.run` 时长，
 *    V4.2 不引入耗时估算。
 *
 * 环检测：caller (planner / acceptPlan) 已经在 plan-validation 里挡住了
 * 依赖环；此处若再碰到，抛 Error 而非默默返回空 levels —— 这种情况一定
 * 是 store 被外部破坏。
 */
export function computeTaskGraph(
  plan: TaskPlan,
  _links: TaskRunLink[],
): WorkItemGraphResponse {
  const tasks = plan.tasks;
  if (tasks.length === 0) {
    return { levels: [], edges: [], criticalPathTaskIds: [] };
  }

  const taskIds = new Set(tasks.map((t) => t.taskId));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const t of tasks) {
    incoming.set(t.taskId, []);
    outgoing.set(t.taskId, []);
  }
  const edges: Array<{ from: string; to: string }> = [];
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!taskIds.has(dep)) continue;
      incoming.get(t.taskId)!.push(dep);
      outgoing.get(dep)!.push(t.taskId);
      edges.push({ from: dep, to: t.taskId });
    }
  }

  // 拓扑分层 + 环检测。
  const depth = new Map<string, number>();
  const indegree = new Map<string, number>();
  for (const t of tasks) {
    indegree.set(t.taskId, incoming.get(t.taskId)!.length);
    if (indegree.get(t.taskId) === 0) depth.set(t.taskId, 0);
  }
  // Kahn-like sweep but recording depth.
  let frontier = tasks
    .filter((t) => incoming.get(t.taskId)!.length === 0)
    .map((t) => t.taskId);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const d = depth.get(id)!;
      for (const child of outgoing.get(id) ?? []) {
        const newDepth = d + 1;
        const cur = depth.get(child);
        if (cur === undefined || newDepth > cur) {
          depth.set(child, newDepth);
        }
        const left = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, left);
        if (left === 0) next.push(child);
      }
    }
    frontier = next;
  }
  if (depth.size !== tasks.length) {
    throw new Error(
      "computeTaskGraph: dependency cycle detected (plan-validation should have rejected this plan)",
    );
  }

  const maxDepth = Math.max(...Array.from(depth.values()));
  const levels: string[][] = [];
  for (let i = 0; i <= maxDepth; i += 1) levels.push([]);
  for (const t of tasks) {
    levels[depth.get(t.taskId)!]!.push(t.taskId);
  }
  for (const lvl of levels) lvl.sort();

  // Longest-path search. Because the graph is a DAG (verified above), a
  // memoised DFS by reverse topological order would work, but the plans
  // are small enough that an explicit DFS-by-depth pass keeps the code
  // simple and avoids a separate topological sort.
  const longestFrom = new Map<string, string[]>();
  function longestPathFrom(taskId: string): string[] {
    const cached = longestFrom.get(taskId);
    if (cached) return cached;
    const children = [...(outgoing.get(taskId) ?? [])].sort();
    if (children.length === 0) {
      longestFrom.set(taskId, [taskId]);
      return [taskId];
    }
    let best: string[] | undefined;
    for (const child of children) {
      const candidate = [taskId, ...longestPathFrom(child)];
      if (
        !best ||
        candidate.length > best.length ||
        (candidate.length === best.length && pathCompare(candidate, best) < 0)
      ) {
        best = candidate;
      }
    }
    longestFrom.set(taskId, best!);
    return best!;
  }

  const roots = tasks
    .filter((t) => incoming.get(t.taskId)!.length === 0)
    .map((t) => t.taskId)
    .sort();
  let criticalPathTaskIds: string[] = [];
  for (const root of roots) {
    const path = longestPathFrom(root);
    if (
      criticalPathTaskIds.length === 0 ||
      path.length > criticalPathTaskIds.length ||
      (path.length === criticalPathTaskIds.length &&
        pathCompare(path, criticalPathTaskIds) < 0)
    ) {
      criticalPathTaskIds = path;
    }
  }

  return { levels, edges, criticalPathTaskIds };
}

function pathCompare(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}
