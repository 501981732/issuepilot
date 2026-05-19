/**
 * V4.6 review follow-up critical fixes — daemon-level pipeline wiring tests.
 *
 * Scope of this file:
 * - Task 2 (C4)：`/api/quality/summary` 的 `byRole` 切片在 V4.6 启用时真正
 *   有数据；即 daemon 把 `pipelineStore.listAllAgentReports()` 拿到的报告
 *   通过 `buildPipelineQualitySummary` 喂进 `buildQualitySummary`。
 *
 * Tasks 3 / 4 会向本文件追加更高粒度的 HTTP 集成用例（revokeAiReview /
 * startPipeline 等）。当前文件只覆盖 Task 2 的回归契约。
 *
 * 退路方案说明（plan §Task 2 Step 2.4 已批注）：完整 `startDaemon` e2e 需
 * 要 GitLab 凭据与 dispatch mock，对本 task 过重；改为直接覆盖 daemon 抽
 * 出的 `buildPipelineQualitySummary` 工厂。该工厂同时被 single 与 team
 * daemon 调用，所以一份测试同时反向覆盖两条路径。把 daemon.ts 里
 * `pipelineStore` 参数 revert 为 `undefined`（即 Step 2.3 的改动）后，
 * 这里的 byRole 断言必 red — 充分验证测试能捕获 V4.6 review C4 这个 bug。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CoderAgentReport,
  ReviewerAgentReport,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { buildPipelineQualitySummary } from "../daemon.js";
import { createPipelineStore } from "../pipelines/store.js";

const isoNow = "2026-05-20T01:00:00.000Z";

function coderReport(over: Partial<CoderAgentReport> = {}): CoderAgentReport {
  return {
    agentReportId: "ar_coder_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "coder",
    roleProfileId: "coder@v1",
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

describe("daemon buildPipelineQualitySummary (V4.6 review C4)", () => {
  it("populates byRole when pipelineStore has reviewer + coder reports in window", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-daemon-wiring-byrole-"));
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

    const buildQualitySummary = buildPipelineQualitySummary({
      pipelineStore,
      collectorDeps: {
        // No work-item / report fixtures needed — buildQualitySummary only
        // uses agentReports for the byRole slice. Other slices stay empty.
        metadata: { workflow: "team-v4-6.workflow.md" },
      },
      scope: { mode: "single-project" },
    });

    const summary = await buildQualitySummary({
      filters: { window: "7d" },
    });

    expect(summary.byRole).toBeDefined();
    // approve_with_comments 1 / 1 → 100
    expect(summary.byRole?.reviewerApproveRate).toBe(100);
    // coder complete 1 / 1 → 100
    expect(summary.byRole?.coderSuccessRate).toBe(100);
  });

  it("excludes superseded reports from byRole by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-daemon-wiring-supersede-"));
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

    const buildQualitySummary = buildPipelineQualitySummary({
      pipelineStore,
      collectorDeps: { metadata: { workflow: "team-v4-6.workflow.md" } },
      scope: { mode: "single-project" },
    });

    const summary = await buildQualitySummary({ filters: { window: "7d" } });
    // 仅最新的 ar_rev_ok 应该参与统计，所以 approveRate = 100 而不是 50。
    expect(summary.byRole).toBeDefined();
    expect(summary.byRole?.reviewerApproveRate).toBe(100);
    expect(summary.byRole?.reviewerUnavailableRate ?? 0).toBe(0);
  });

  it("omits byRole entirely when pipelineStore is undefined (V4.5 path)", async () => {
    // 这条用例锁定 V4.5 行为：dashboard 老路径不应当因为 V4.6 helper 被
    // 引入而开始渲染 ByRolePanel。
    const buildQualitySummary = buildPipelineQualitySummary({
      pipelineStore: undefined,
      collectorDeps: { metadata: { workflow: "v4-5.workflow.md" } },
      scope: { mode: "single-project" },
    });
    const summary = await buildQualitySummary({ filters: { window: "7d" } });
    expect(summary.byRole).toBeUndefined();
  });
});
