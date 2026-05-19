/**
 * V4.6 spec §15：auto-advance 监听器。
 *
 * 当 PipelineRun 处于 `running_*` 中间态、且对应 AgentReport 完成（`complete` /
 * `incomplete`）时，自动触发下一个 role；当 TaskNode 标记了
 * `last_cancelled_at` 时抑制 auto-advance，等 operator 显式 retry 时再清。
 *
 * 注意：我们的 coordinator 当前实现是**同步串行**跑完一整套 recipe（顺序
 * 调三个 agent），所以 auto-advance 在生产路径上只在以下场景才被触发：
 * - 异步重启：daemon 重启时检测到 supersede 链末端的 PipelineRun 卡在
 *   `running_*`，AgentReport 已经写完但下一步未起 → 重放。
 * - V4.6 后续可能拆 agent 调用为 EventBus 事件流，到那时 auto-advance
 *   作为唯一的状态推进入口。
 *
 * 当前实现把 `shouldAutoAdvance` 与 `nextRoleFor` 暴露成纯函数 + 一个
 * `onAgentReportFinalized` 编排函数，让上层在合适时机调用。
 */

import {
  type AgentReport,
  type AgentRole,
  type PipelineRun,
  type ReviewerAgentReport,
  type TaskNode,
} from "@issuepilot/shared-contracts";

import { recipeRoles } from "./recipe.js";

export interface AutoAdvanceTaskView {
  taskId: string;
  last_cancelled_at?: string;
}

export interface ShouldAutoAdvanceInput {
  pipelineRun: PipelineRun;
  finishedReport: AgentReport;
  task: AutoAdvanceTaskView;
}

const isReviewerReport = (r: AgentReport): r is ReviewerAgentReport =>
  r.role === "reviewer";

/**
 * spec §15：判定本次 AgentReport 完成后是否要继续推进 pipeline。
 *
 * - 任务被 cancel → 不推进。
 * - AgentReport.status ∈ {failed, cancelled} → 不推进（coordinator 已收尾）。
 * - reviewer.decision ∈ {request_changes, cannot_review} → 不推进。
 * - role 已经是末端 role → 不推进。
 * - 否则 → 推进，返回下一个 role。
 */
export const shouldAutoAdvance = (
  input: ShouldAutoAdvanceInput,
): { advance: false } | { advance: true; nextRole: AgentRole } => {
  const { pipelineRun, finishedReport, task } = input;
  if (task.last_cancelled_at) return { advance: false };
  if (
    finishedReport.status === "failed" ||
    finishedReport.status === "cancelled"
  ) {
    return { advance: false };
  }
  if (isReviewerReport(finishedReport)) {
    const dec = finishedReport.reviewer.decision;
    if (dec === "request_changes" || dec === "cannot_review") {
      return { advance: false };
    }
  }
  const order = recipeRoles(pipelineRun.recipe);
  const idx = order.indexOf(finishedReport.role);
  if (idx < 0 || idx >= order.length - 1) return { advance: false };
  return { advance: true, nextRole: order[idx + 1]! };
};

/**
 * 给定下一个 role，返回 PipelineRun 应当切换到的 status。
 */
export const nextPipelineStatusFor = (
  role: AgentRole,
): "running_coding" | "running_reviewer" | "running_test_evidence" => {
  switch (role) {
    case "coder":
      return "running_coding";
    case "reviewer":
      return "running_reviewer";
    case "test_evidence":
      return "running_test_evidence";
  }
};

export interface AutoAdvanceTrigger {
  /**
   * 由 EventBus / scheduler 在 AgentReport 落盘后调用。返回 advance 决策，
   * 不直接触发 agent，调用方拿到决策后再调用 coordinator.continueRole(...)
   * 等具体动作（避免本模块跟 coordinator 形成强耦合）。
   */
  onAgentReportFinalized(input: {
    pipelineRun: PipelineRun;
    finishedReport: AgentReport;
    task: TaskNode;
  }): { advance: false } | { advance: true; nextRole: AgentRole };
}

export const createAutoAdvance = (): AutoAdvanceTrigger => ({
  onAgentReportFinalized({ pipelineRun, finishedReport, task }) {
    return shouldAutoAdvance({
      pipelineRun,
      finishedReport,
      task,
    });
  },
});
