import type {
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
} from "@issuepilot/shared-contracts";

/**
 * V4.2 branch chaining (spec §12.4).
 *
 * 当下游 task 准备 dispatch 时，要回答一个问题：「我应该 base off 哪条 git
 * 分支」？V4.1 默认所有 task 都 base off `workflow.git.baseBranch`，下游
 * 通过 `computeReadyTasks` 等上游 MR 真正 merge 后才会 ready。V4.2 引入
 * 「branch chaining」：当且仅当上游 task 在 IssuePilot 内部已经
 * `completed` 但其 MR 尚未 merge 时，下游可以直接 base off 上游分支，
 * 避免「明明 IssuePilot 知道上游 patch 已经 ready，却因为 reviewer 未点
 * merge 而把整个 work item 卡住」。
 *
 * 安全口径：
 *  - 仅在「线性单上游依赖」时启用 chaining；多上游 chaining 会引入自动
 *    rebase 风险，留给后续阶段。
 *  - chaining 决策只看 IssuePilot 本地数据：`TaskNode.status === "completed"`
 *    + `TaskRunLink.status === "completed"` + `RunReportArtifact.mergeRequest`
 *    在 `merged` 之外（含缺失）。任何上游缺失 TaskRunLink 都视为「不可链」。
 *  - 不读取 git 仓库本身；调用方负责在真正 dispatch 时 push 出对应 branch。
 */

export type EffectiveBaseDecision =
  | { kind: "default-base"; baseBranch: string }
  | {
      kind: "chain-from-upstream";
      baseBranch: string;
      upstreamTaskId: string;
    }
  | { kind: "blocked"; reason: "non-linear" | "upstream-not-completed" };

export interface DecideEffectiveBaseInput {
  task: TaskNode;
  plan: TaskPlan;
  links: TaskRunLink[];
  /** 解析上游 runId 对应的 RunReportArtifact；缺失视为 MR 未合并。 */
  getRunReport: (runId: string) => Promise<RunReportArtifact | undefined>;
  /** workflow.git.baseBranch；未链式时直接返回。 */
  defaultBaseBranch: string;
}

export async function decideEffectiveBase(
  input: DecideEffectiveBaseInput,
): Promise<EffectiveBaseDecision> {
  const { task, plan, links, getRunReport, defaultBaseBranch } = input;

  // 0-deps fast path —— 不需要查任何上游。
  if (task.dependsOn.length === 0) {
    return { kind: "default-base", baseBranch: defaultBaseBranch };
  }

  // 单上游：可以 chain。
  if (task.dependsOn.length === 1) {
    const upstreamTaskId = task.dependsOn[0]!;
    const upstreamCompleted = isUpstreamCompleted(upstreamTaskId, plan);
    if (!upstreamCompleted) {
      return { kind: "blocked", reason: "upstream-not-completed" };
    }
    const latest = latestCompletedLink(links, upstreamTaskId);
    if (!latest) {
      // 上游 node 状态为 completed 但缺 TaskRunLink。视为不可链；保留为
      // blocked-by-dependency，等 link 写入或 operator 介入。
      return { kind: "blocked", reason: "upstream-not-completed" };
    }
    const report = await getRunReport(latest.runId);
    const merged = report?.mergeRequest?.state === "merged";
    if (merged) {
      return { kind: "default-base", baseBranch: defaultBaseBranch };
    }
    return {
      kind: "chain-from-upstream",
      baseBranch: `origin/${latest.branch}`,
      upstreamTaskId,
    };
  }

  // 多上游：要求全部 completed + merged 才放行，否则保持 blocked。
  for (const upstreamTaskId of task.dependsOn) {
    const upstreamCompleted = isUpstreamCompleted(upstreamTaskId, plan);
    if (!upstreamCompleted) {
      return { kind: "blocked", reason: "non-linear" };
    }
    const latest = latestCompletedLink(links, upstreamTaskId);
    if (!latest) {
      return { kind: "blocked", reason: "non-linear" };
    }
    const report = await getRunReport(latest.runId);
    if (report?.mergeRequest?.state !== "merged") {
      return { kind: "blocked", reason: "non-linear" };
    }
  }
  return { kind: "default-base", baseBranch: defaultBaseBranch };
}

function isUpstreamCompleted(taskId: string, plan: TaskPlan): boolean {
  const node = plan.tasks.find((t) => t.taskId === taskId);
  return node?.status === "completed";
}

function latestCompletedLink(
  links: TaskRunLink[],
  taskId: string,
): TaskRunLink | undefined {
  const completed = links.filter(
    (l) => l.taskId === taskId && l.status === "completed",
  );
  if (completed.length === 0) return undefined;
  // 最大 attempt 优先，attempt 相同时取最新 completedAt；都缺失则取最后一个。
  return [...completed].sort((a, b) => {
    if (a.attempt !== b.attempt) return b.attempt - a.attempt;
    const aT = Date.parse(a.completedAt ?? a.startedAt ?? "");
    const bT = Date.parse(b.completedAt ?? b.startedAt ?? "");
    if (Number.isNaN(aT) && Number.isNaN(bT)) return 0;
    if (Number.isNaN(aT)) return 1;
    if (Number.isNaN(bT)) return -1;
    return bT - aT;
  })[0];
}
