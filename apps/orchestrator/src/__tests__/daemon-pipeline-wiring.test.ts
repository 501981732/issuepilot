/**
 * V4.6 review follow-up critical fixes — daemon-level pipeline wiring tests.
 *
 * Scope:
 *
 * - Task 2 (review C4 + review follow-up Issue 1)：`GET /api/quality/summary`
 *   的 `byRole` 切片在 V4.6 启用时真正有数据。本文件用 `app.inject(...)`
 *   覆盖真实的 HTTP 路径（dashboard `ByRolePanel` 的真正数据源就是这个
 *   路由 / `apps/dashboard/lib/api.ts:281-284`），单 + team 模式都要覆盖。
 *   factory 层的纯单元用例放在
 *   `apps/orchestrator/src/quality/__tests__/pipeline-summary.test.ts`。
 *
 * Tasks 3 / 4 会向本文件追加更高粒度的 HTTP 集成用例（revokeAiReview /
 * startPipeline 等）。
 *
 * Bug-catching 验证（V4.6 review follow-up self-review）：把
 * `server/index.ts` `/api/quality/summary` 路由里的 `pipelineStore`
 * 参数 revert 为 `undefined`（即模拟 5db756f 之前的 "factory 接到了
 * improvement service 但没接到路由" 的情况）后，这里的 byRole 断言必
 * red — 充分验证测试能捕获 V4.6 review follow-up Issue 1 这个 bug。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus } from "@issuepilot/observability";
import type {
  CoderAgentReport,
  IssuePilotInternalEvent,
  ReviewerAgentReport,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRuntimeState } from "../runtime/state.js";
import { createServer, type ServerDeps } from "../server/index.js";
import {
  createPipelineStore,
  type PipelineStore,
} from "../pipelines/store.js";

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

async function buildServerForQualityRoute(
  overrides: Partial<
    Pick<
      ServerDeps,
      | "pipelineStore"
      | "pipelineStoreByProject"
      | "quality"
      | "qualityByProject"
    >
  > = {},
) {
  const state = createRuntimeState();
  const eventBus = createEventBus<IssuePilotInternalEvent>();
  const app = await createServer(
    {
      state,
      eventBus,
      readEvents: async () => [],
      workflowPath: ".agents/workflow.md",
      gitlabProject: "group/project",
      pollIntervalMs: 10_000,
      concurrency: 1,
      ...(overrides.quality ? { quality: overrides.quality } : {}),
      ...(overrides.qualityByProject
        ? { qualityByProject: overrides.qualityByProject }
        : {}),
      ...(overrides.pipelineStore
        ? { pipelineStore: overrides.pipelineStore }
        : {}),
      ...(overrides.pipelineStoreByProject
        ? { pipelineStoreByProject: overrides.pipelineStoreByProject }
        : {}),
    },
    { port: 0 },
  );
  return { app };
}

describe("daemon /api/quality/summary byRole HTTP wiring (V4.6 review follow-up Issue 1)", () => {
  let pipelineStore: PipelineStore | undefined;
  let pipelineStoreByProject: Map<string, PipelineStore> | undefined;

  beforeEach(() => {
    pipelineStore = undefined;
    pipelineStoreByProject = undefined;
  });

  afterEach(() => {
    pipelineStore = undefined;
    pipelineStoreByProject = undefined;
  });

  it("single mode: returns populated byRole when ServerDeps.pipelineStore is wired", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-daemon-http-byrole-"));
    pipelineStore = createPipelineStore({ root });
    await pipelineStore.saveAgentReport(
      coderReport({
        agentReportId: "ar_coder_http",
        startedAt: "2026-05-20T00:30:00.000Z",
      }),
    );
    await pipelineStore.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_http",
        startedAt: "2026-05-20T00:45:00.000Z",
      }),
    );
    const { app } = await buildServerForQualityRoute({ pipelineStore });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/quality/summary?window=7d&from=2026-05-13T00:00:00.000Z&to=2026-05-21T00:00:00.000Z",
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as {
        byRole?: {
          reviewerApproveRate?: number;
          coderSuccessRate?: number;
        };
      };
      expect(body.byRole).toBeDefined();
      expect(body.byRole?.reviewerApproveRate).toBe(100);
      expect(body.byRole?.coderSuccessRate).toBe(100);
    } finally {
      await app.close();
    }
  });

  it("single mode: omits byRole when ServerDeps.pipelineStore is absent (V4.5 path)", async () => {
    // 锁定 V4.5 行为：dashboard 老路径不应当因为 V4.6 helper 接入而开始
    // 渲染 ByRolePanel。
    const { app } = await buildServerForQualityRoute({});
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/quality/summary?window=7d",
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as { byRole?: unknown };
      expect(body.byRole).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("team mode: returns populated byRole only for the selected project (per-project isolation)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "ip-daemon-http-team-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "ip-daemon-http-team-b-"));
    const storeA = createPipelineStore({ root: rootA });
    const storeB = createPipelineStore({ root: rootB });
    await storeA.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_a",
        startedAt: "2026-05-20T00:45:00.000Z",
        reviewer: {
          summary: "approve",
          decision: "approve_with_comments",
          confidence: 0.9,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "pending", noteIds: [] },
        },
      }),
    );
    // Project B 投了一条 request_changes，应当只在 project=B 的请求里反映。
    await storeB.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_b",
        startedAt: "2026-05-20T00:45:00.000Z",
        reviewer: {
          summary: "needs fixes",
          decision: "request_changes",
          confidence: 0.6,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
          mrPublication: { status: "pending", noteIds: [] },
        },
      }),
    );

    pipelineStoreByProject = new Map<string, PipelineStore>([
      ["proj-a", storeA],
      ["proj-b", storeB],
    ]);
    const qualityByProject = new Map([
      ["proj-a", {}],
      ["proj-b", {}],
    ]);
    const { app } = await buildServerForQualityRoute({
      pipelineStoreByProject,
      qualityByProject,
    });
    try {
      type ByRoleBody = {
        byRole?: {
          reviewerApproveRate?: number;
          counts?: {
            reviewerApprove: number;
            reviewerRequestChanges: number;
          };
        };
      };
      const respA = await app.inject({
        method: "GET",
        url: "/api/quality/summary?window=7d&from=2026-05-13T00:00:00.000Z&to=2026-05-21T00:00:00.000Z",
        headers: { "x-issuepilot-project": "proj-a" },
      });
      expect(respA.statusCode).toBe(200);
      const bodyA = JSON.parse(respA.body) as ByRoleBody;
      // proj-a 投了 1 条 approve_with_comments，approveRate = 100。
      expect(bodyA.byRole).toBeDefined();
      expect(bodyA.byRole?.reviewerApproveRate).toBe(100);
      expect(bodyA.byRole?.counts?.reviewerApprove).toBe(1);
      expect(bodyA.byRole?.counts?.reviewerRequestChanges).toBe(0);

      const respB = await app.inject({
        method: "GET",
        url: "/api/quality/summary?window=7d&from=2026-05-13T00:00:00.000Z&to=2026-05-21T00:00:00.000Z",
        headers: { "x-issuepilot-project": "proj-b" },
      });
      expect(respB.statusCode).toBe(200);
      const bodyB = JSON.parse(respB.body) as ByRoleBody;
      // proj-b 投了 1 条 request_changes，approveRate = 0；counts 反向印证
      // 该报告没有窜到 proj-a。
      expect(bodyB.byRole).toBeDefined();
      expect(bodyB.byRole?.reviewerApproveRate).toBe(0);
      expect(bodyB.byRole?.counts?.reviewerRequestChanges).toBe(1);
      expect(bodyB.byRole?.counts?.reviewerApprove).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("team mode: omits byRole for a project without a pipelineStore entry", async () => {
    // qualityByProject 注册了 proj-c，但 pipelineStoreByProject 没有 ——
    // 等价于 V4.5 工作流的 project；byRole 必须 undefined。
    const { app } = await buildServerForQualityRoute({
      qualityByProject: new Map([["proj-c", {}]]),
      pipelineStoreByProject: new Map<string, PipelineStore>(),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/quality/summary?window=7d",
        headers: { "x-issuepilot-project": "proj-c" },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body) as { byRole?: unknown };
      expect(body.byRole).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
