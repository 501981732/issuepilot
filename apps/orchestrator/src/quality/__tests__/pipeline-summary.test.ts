/**
 * V4.6 review follow-up — unit tests for `quality/pipeline-summary.ts`.
 *
 * Scope: the pure factory (no HTTP, no Fastify). HTTP wiring is covered in
 * `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts` via
 * `app.inject(...)`. Tests here lock the two contracts:
 *
 * 1. `buildPipelineQualitySummary({ pipelineStore }, filters)` populates
 *    `summary.byRole` from V4.6 AgentReport JSON.
 * 2. `buildPipelineQualitySummary({ pipelineStore: undefined }, filters)`
 *    leaves `summary.byRole` undefined — V4.5 工作流不应该因为该 helper 被
 *    引入就开始渲染 ByRolePanel。
 * 3. `createPipelineQualitySummaryCallback({ pipelineStore })` 对接
 *    `ImprovementService` 的 callback 签名也透传 agentReports。
 *
 * 把 factory unit 测试集中放在该文件而不是 daemon-pipeline-wiring.test.ts，
 * 是 V4.6 review Issue 3 的重构产物：factory 不再住 daemon.ts，daemon
 * 那侧只跑 HTTP 集成测试。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CoderAgentReport,
  QualitySummaryFilters,
  ReviewerAgentReport,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { createPipelineStore } from "../../pipelines/store.js";
import {
  buildPipelineQualitySummary,
  createPipelineQualitySummaryCallback,
} from "../pipeline-summary.js";

const isoNow = "2026-05-20T01:00:00.000Z";

function coderReport(over: Partial<CoderAgentReport> = {}): CoderAgentReport {
  return {
    agentReportId: "ar_coder_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "coder",
    roleProfileId: "coder@v1",
    runnerId: "codex_app_server",
    runnerKind: "codex_app_server",
    runnerRunId: null,
    status: "complete",
    startedAt: isoNow,
    evidenceLinks: [],
    redactedFields: [],
    coder: {
      diffSummary: "wrote tests + diff",
      branch: "issuepilot/wi_1/t_1",
    },
    ...over,
  };
}

function reviewerReport(
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport {
  return {
    agentReportId: "ar_rev_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "reviewer",
    roleProfileId: "reviewer@v1",
    runnerId: "codex_app_server",
    runnerKind: "codex_app_server",
    runnerRunId: null,
    status: "complete",
    startedAt: isoNow,
    evidenceLinks: [],
    redactedFields: [],
    reviewer: {
      summary: "ok",
      decision: "approve_with_comments",
      confidence: 0.8,
      risks: [],
      evidenceRequest: [],
      findings: [],
      inlineComments: [],
      mrPublication: { status: "pending", noteIds: [] },
    },
    ...over,
  };
}

const filtersFor7d = (overrides: Partial<QualitySummaryFilters> = {}) => ({
  from: "2026-05-13T00:00:00.000Z",
  to: "2026-05-20T23:59:59.999Z",
  window: "7d" as const,
  ...overrides,
});

describe("buildPipelineQualitySummary (factory workhorse)", () => {
  it("populates byRole when pipelineStore has reviewer + coder reports in window", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-pipeline-summary-byrole-"));
    const pipelineStore = createPipelineStore({ root });
    await pipelineStore.saveAgentReport(
      coderReport({
        agentReportId: "ar_coder_w1",
        startedAt: "2026-05-20T00:30:00.000Z",
      }),
    );
    await pipelineStore.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_w1",
        startedAt: "2026-05-20T00:45:00.000Z",
      }),
    );

    const summary = await buildPipelineQualitySummary(
      {
        pipelineStore,
        collectorDeps: { metadata: { workflow: "team-v4-6.workflow.md" } },
        scope: { mode: "single-project" },
      },
      filtersFor7d(),
    );

    expect(summary.byRole).toBeDefined();
    expect(summary.byRole?.reviewerApproveRate).toBe(100);
    expect(summary.byRole?.coderSuccessRate).toBe(100);
  });

  it("excludes superseded reports from byRole by default", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ip-pipeline-summary-supersede-"),
    );
    const pipelineStore = createPipelineStore({ root });
    await pipelineStore.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_failed",
        startedAt: "2026-05-20T00:10:00.000Z",
        status: "failed",
        supersededBy: "ar_rev_ok",
      }),
    );
    await pipelineStore.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_ok",
        startedAt: "2026-05-20T00:20:00.000Z",
      }),
    );

    const summary = await buildPipelineQualitySummary(
      {
        pipelineStore,
        collectorDeps: { metadata: { workflow: "team-v4-6.workflow.md" } },
        scope: { mode: "single-project" },
      },
      filtersFor7d(),
    );
    expect(summary.byRole).toBeDefined();
    expect(summary.byRole?.reviewerApproveRate).toBe(100);
    expect(summary.byRole?.reviewerUnavailableRate ?? 0).toBe(0);
  });

  it("omits byRole entirely when pipelineStore is undefined (V4.5 path)", async () => {
    const summary = await buildPipelineQualitySummary(
      {
        pipelineStore: undefined,
        collectorDeps: { metadata: { workflow: "v4-5.workflow.md" } },
        scope: { mode: "single-project" },
      },
      filtersFor7d(),
    );
    expect(summary.byRole).toBeUndefined();
  });
});

describe("createPipelineQualitySummaryCallback (improvement-service adapter)", () => {
  it("forwards agentReports to byRole when pipelineStore present", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-pipeline-summary-cb-"));
    const pipelineStore = createPipelineStore({ root });
    await pipelineStore.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_cb",
        startedAt: "2026-05-20T00:45:00.000Z",
      }),
    );

    const callback = createPipelineQualitySummaryCallback({
      pipelineStore,
      collectorDeps: { metadata: { workflow: "v4-6.workflow.md" } },
      scope: { mode: "single-project" },
    });
    const summary = await callback({ filters: { window: "7d" } });
    expect(summary.byRole).toBeDefined();
    expect(summary.byRole?.reviewerApproveRate).toBe(100);
  });

  it("leaves byRole undefined when pipelineStore absent (V4.5 path)", async () => {
    const callback = createPipelineQualitySummaryCallback({
      pipelineStore: undefined,
      collectorDeps: { metadata: { workflow: "v4-5.workflow.md" } },
      scope: { mode: "single-project" },
    });
    const summary = await callback({ filters: { window: "7d" } });
    expect(summary.byRole).toBeUndefined();
  });
});
