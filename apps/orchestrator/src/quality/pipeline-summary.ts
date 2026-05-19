/**
 * V4.6 review fix C4：把 V4.6 AgentReport 馈送给 `buildQualitySummary` 的
 * pipeline-aware 包装层。
 *
 * 该模块零 daemon-runtime 依赖，纯粹是 `collectQualitySources` +
 * `buildQualitySummary` + 可选 `PipelineStore.listAllAgentReports` 的胶水。
 * 同时被三个 caller 复用：
 *
 *   1. `apps/orchestrator/src/server/index.ts` 的 `GET /api/quality/summary`
 *      HTTP 路由 — dashboard `ByRolePanel` 的真正数据源。
 *   2. `apps/orchestrator/src/daemon.ts` 单机模式下注入到
 *      `createImprovementService({ buildQualitySummary })`。
 *   3. `apps/orchestrator/src/team/daemon.ts` per-project 同上。
 *
 * 暴露两个入口：
 *
 *   - `buildPipelineQualitySummary(deps, filters)`：以规范化的
 *     `QualitySummaryFilters` 直接产出 summary，HTTP 路由用这条路径
 *     （`parseQualityQuery` 已经把窗口/默认值规整好了）。
 *   - `createPipelineQualitySummaryCallback(deps)`：适配
 *     `ImprovementService` 的 `(input: ImprovementGenerateRequest) =>
 *     Promise<QualitySummaryResponse>` 回调签名，内部补 7d / now 默认值后
 *     调用上面的 workhorse。
 */
import type {
  AgentReport,
  ImprovementGenerateRequest,
  QualitySummaryFilters,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

import type { PipelineStore } from "../pipelines/store.js";

import { buildQualitySummary } from "./aggregate.js";
import {
  collectQualitySources,
  type QualityCollectorDeps,
} from "./collect.js";

export interface PipelineQualitySummaryDeps {
  /**
   * 启用 V4.6 multi-agent pipeline 时填实例；未启用时（V4.5 工作流）传
   * `undefined`，包装层不会拉取 AgentReport，`byRole` 切片保持
   * undefined，行为与 V4.5 一致。
   */
  pipelineStore: PipelineStore | undefined;
  collectorDeps: QualityCollectorDeps;
  scope: QualitySummaryResponse["scope"];
}

/**
 * Workhorse：以规范化的 `QualitySummaryFilters` 产出 `QualitySummaryResponse`。
 * `filters.from` 同时被用作 AgentReport 的 `sinceIso` 窗口下限，保证
 * `byRole` 和其它切片的时间窗对齐。
 */
export async function buildPipelineQualitySummary(
  deps: PipelineQualitySummaryDeps,
  filters: QualitySummaryFilters,
): Promise<QualitySummaryResponse> {
  const collected = await collectQualitySources(deps.collectorDeps);
  // 仅在启用 V4.6 pipeline 时拉取 AgentReport；exactOptionalPropertyTypes
  // 要求 `agentReports` 字段不允许显式传 undefined，所以用条件 spread。
  const agentReports: AgentReport[] | undefined = deps.pipelineStore
    ? await deps.pipelineStore.listAllAgentReports({ sinceIso: filters.from })
    : undefined;
  return buildQualitySummary({
    items: collected.items,
    filters,
    scope: deps.scope,
    diagnostics: collected.diagnostics,
    ...(agentReports ? { agentReports } : {}),
  });
}

/**
 * Adapter：把上面的 workhorse 包成 `ImprovementService` 期望的
 * `(input: ImprovementGenerateRequest) => Promise<QualitySummaryResponse>`
 * 回调。`input.filters` 是 partial 的，这里补 7d / now 默认值，保留与
 * commit 5db756f 之前完全一致的语义。
 *
 * NOTE：`fromIso` 默认窗口不读 `window`（保持 commit 5db756f 之前的语义，
 * 是上游 pre-existing behavior；reviewer 已确认不在本 task 范围）。
 */
export function createPipelineQualitySummaryCallback(
  deps: PipelineQualitySummaryDeps,
): (input: ImprovementGenerateRequest) => Promise<QualitySummaryResponse> {
  return async (input) => {
    const fromIso =
      input.filters?.from ??
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const filters: QualitySummaryFilters = {
      from: fromIso,
      to: input.filters?.to ?? new Date().toISOString(),
      window: input.filters?.window ?? "7d",
      ...(input.filters?.workflow ? { workflow: input.filters.workflow } : {}),
      ...(input.filters?.taskType ? { taskType: input.filters.taskType } : {}),
      ...(input.filters?.status ? { status: input.filters.status } : {}),
      ...(input.filters?.pattern ? { pattern: input.filters.pattern } : {}),
    };
    return buildPipelineQualitySummary(deps, filters);
  };
}
