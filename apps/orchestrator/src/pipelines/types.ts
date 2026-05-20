/**
 * V4.6 spec §9：pipeline store 的内部类型。这里只保留 store 实现层
 * 自用的辅助类型，对外的 PipelineRun / AgentReport 契约定义在
 * `@issuepilot/shared-contracts`。
 */

import type {
  AgentReport,
  AgentRole,
  PipelineRun,
} from "@issuepilot/shared-contracts";

/**
 * 按 `taskId/<role>/index.json` 落盘的 supersede 链索引（spec §9）。
 *
 * 形态：每个 role 单独一份 index.json，记录该 role 下所有
 * AgentReport 的 id 顺序与 supersede 关系；orchestrator / dashboard
 * 据此快速取到 "latest non-superseded report"。
 */
export interface AgentReportRoleIndex {
  taskId: string;
  role: AgentRole;
  /** 按写入时间升序。`latestAgentReportId` 是 supersede 链最末端。 */
  agentReportIds: string[];
  /** prev → next（spec §8.1 supersede 链）。 */
  supersedeChain: Array<{ from: string; to: string }>;
  latestAgentReportId: string | null;
  updatedAt: string;
}

/** spec §9 三层目录布局的解析结果。 */
export interface PipelineStorePaths {
  /** `<root>/pipelines/<workItemId>/<taskId>/<pipelineRunId>.json` */
  pipelineRunPath: (input: {
    workItemId: string;
    taskId: string;
    pipelineRunId: string;
  }) => string;
  /** `<root>/agent-reports/<taskId>/<role>/<agentReportId>.json` */
  agentReportPath: (input: {
    taskId: string;
    role: AgentRole;
    agentReportId: string;
  }) => string;
  /** `<root>/agent-reports/<taskId>/<role>/index.json` */
  agentReportIndexPath: (input: { taskId: string; role: AgentRole }) => string;
}

/** PipelineStore.save / list helper 返回值。 */
export interface ListPipelinesForTaskItem {
  pipelineRun: PipelineRun;
  /** supersede 链最新一条为 true（spec §8.1 supersededBy 不存在时）。 */
  latest: boolean;
}

export type SaveAgentReportOptions = {
  /** 默认 true：写入后同步更新 index.json。测试可关掉以验证原子性。 */
  updateIndex?: boolean;
};

export type LoadedAgentReport = AgentReport;