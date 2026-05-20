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
import * as fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";

import { createEventBus } from "@issuepilot/observability";
import type {
  CoderAgentReport,
  IssuePilotInternalEvent,
  ReviewerAgentReport,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
import {
  createGitLabClient,
  type GitLabApi,
  type GitLabClient,
} from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// V4.6 follow-up Task 4b — stub the Codex runner module at hoist time so the
// new wiring drives a fake `spawnRpc + driveLifecycle` pair. The mock applies
// to every test in this file but the existing quality / revoke suites never
// call into `runAgent` (only daemon assembly + HTTP routes), so the stubs are
// transparent to them.
vi.mock("@issuepilot/runner-codex-app-server", () => ({
  spawnRpc: vi.fn(),
  driveLifecycle: vi.fn(),
  createGitLabTools: vi.fn(() => []),
}));

import { driveLifecycle, spawnRpc } from "@issuepilot/runner-codex-app-server";

import { startDaemon } from "../daemon.js";
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

/**
 * V4.6 review C3：daemon 端把 `revokeReviewerMrComments` 接到 GitLab API。
 *
 * 这个 describe 走的是真实的 wiring chain：
 *   `startDaemon`（捕获 `ServerDeps`）→ 复用捕获到的 `pipelineService`
 *   起一个真实 Fastify → `app.inject` POST 撤销路由 → 校验
 *   fake `MergeRequestNotes.remove` 真的被调用过 + AgentReport 持久化
 *   到 noteIds=[] / status=revoked。
 *
 * Bug-catching 验证（plan §3.4）：把 daemon.ts 里
 * `revokeReviewerMrComments: pipelineRevokeCallback` 这一行 revert 掉，
 * 这里的 `remove` mock 必然 zero call，断言会红 —— 充分证明测试能捕获
 * 「callback 没注入到 service」这一回归。
 */
function buildV46Workflow(root: string): WorkflowConfig {
  // 把 daemon.test.ts 的 createWorkflow 复刻最小一份，避免跨文件导出 helper
  // 带来的耦合；workflow 必须带上 V4.6 default_recipe + roles 才能触发
  // daemon.ts 的 V4.6 pipeline 装配路径（含 revoke callback）。
  return {
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.example.com",
      projectId: "group/project",
      activeLabels: ["ai-ready"],
      runningLabel: "ai-running",
      handoffLabel: "human-review",
      failedLabel: "ai-failed",
      blockedLabel: "ai-blocked",
      reworkLabel: "ai-rework",
      mergingLabel: "ai-merging",
    },
    workspace: {
      root,
      strategy: "worktree",
      repoCacheRoot: path.join(root, "repo-cache"),
    },
    git: {
      repoUrl: "git@gitlab.example.com:group/project.git",
      baseBranch: "main",
      branchPrefix: "issuepilot/",
    },
    agent: {
      runner: "codex-app-server",
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxAttempts: 1,
      retryBackoffMs: 1000,
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
      turnTimeoutMs: 1000,
      turnSandboxPolicy: { type: "workspaceWrite" },
    },
    hooks: {},
    ci: {
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    },
    retention: {
      successfulRunDays: 7,
      failedRunDays: 30,
      maxWorkspaceGb: 50,
      cleanupIntervalMs: 3_600_000,
    },
    pollIntervalMs: 10_000,
    promptTemplate: "noop",
    source: {
      path: path.join(root, "workflow.md"),
      sha256: "test",
      loadedAt: "2026-05-19T00:00:00.000Z",
    },
    defaultRecipe: "full_pipeline",
    roles: {
      coder: {
        role: "coder",
        promptTemplate: "/tmp/c.md",
        promptTemplateHash: "deadbeef",
        sandbox: "read_write_worktree",
      },
      reviewer: {
        role: "reviewer",
        promptTemplate: "/tmp/r.md",
        promptTemplateHash: "deadbeef",
        sandbox: "read_only_worktree",
      },
      test_evidence: {
        role: "test_evidence",
        promptTemplate: "/tmp/t.md",
        promptTemplateHash: "deadbeef",
        sandbox: "read_only_source_write_evidence",
      },
    },
  } satisfies WorkflowConfig;
}

function createFakeServer(): FastifyInstance {
  return {
    close: vi.fn(async () => {}),
  } as unknown as FastifyInstance;
}

/**
 * Build a GitLabAdapter handle whose `.client` is a real `GitLabClient`
 * backed by a stubbed `Gitlab` ctor — `MergeRequestNotes.remove` is a
 * `vi.fn` so the integration test can assert which (mrIid, noteId)
 * combinations the daemon's revoke callback hit. Adapter methods are
 * stubbed minimally to satisfy the `GitLabAdapter` interface; the
 * revoke path only goes through `.client`, never these methods.
 */
function buildFakeGitLabWithDeleteSpy(): {
  adapter: GitLabAdapter & { client: GitLabClient<GitLabApi> };
  remove: ReturnType<typeof vi.fn>;
} {
  const remove = vi.fn(async () => undefined);
  const client = createGitLabClient<GitLabApi>({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: () => "tok" },
    GitlabCtor: function GitlabStub(this: object) {
      Object.assign(this, {
        MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
      });
    } as never,
  });
  const adapter = {
    client,
    listCandidateIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => {
      throw new Error("not used");
    }),
    closeIssue: vi.fn(async () => ({ labels: [], state: undefined })),
    transitionLabels: vi.fn(async () => ({ labels: [] })),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    updateIssueNote: vi.fn(async () => {}),
    findWorkpadNote: vi.fn(async () => null),
    findLatestIssuePilotWorkpadNote: vi.fn(async () => null),
    findMergeRequestBySourceBranch: vi.fn(async () => null),
    createMergeRequest: vi.fn(async () => ({
      id: 1,
      iid: 1,
      webUrl: "https://gitlab.example.com/x",
    })),
    updateMergeRequest: vi.fn(async () => {}),
    getMergeRequest: vi.fn(async () => ({
      iid: 1,
      webUrl: "https://gitlab.example.com/x",
      state: "opened",
    })),
    listMergeRequestsBySourceBranch: vi.fn(async () => []),
    listMergeRequestNotes: vi.fn(async () => []),
    getPipelineStatus: vi.fn(async () => "unknown"),
  } satisfies GitLabAdapter & { client: GitLabClient<GitLabApi> };
  return { adapter, remove };
}

describe("V4.6 daemon revoke wiring (review C3)", () => {
  it("POST /api/agent-reports/:id/revoke-ai-review deletes GitLab notes and persists noteIds=[]", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ip-daemon-revoke-c3-"),
    );
    try {
      const workflow = buildV46Workflow(root);
      const { adapter: fakeGitLab, remove } = buildFakeGitLabWithDeleteSpy();

      let captured: ServerDeps | undefined;
      const daemon = await startDaemon(
        { workflowPath: workflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => workflow),
            start: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => fakeGitLab),
          createServer: vi.fn(async (deps: ServerDeps) => {
            captured = deps;
            return createFakeServer();
          }),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
          state: createRuntimeState(),
        },
      );

      try {
        if (!captured) throw new Error("server deps not captured");
        expect(captured.pipelines).toBeDefined();
        expect(captured.pipelineStore).toBeDefined();

        // 把 coder + reviewer report 直接写进 daemon 自己拼的 PipelineStore。
        // coder.coder.mergeRequest.iid = 42 是 daemon revoke callback 反查
        // mrIid 的唯一来源（spec §10.3 / agent-report.ts:121）；reviewer 的
        // mrPublication.noteIds = ["10","20"] 在撤销时会被翻译成 numeric
        // 然后送给 fake remove() spy。
        await captured.pipelineStore!.saveAgentReport({
          agentReportId: "ar_coder_http",
          pipelineRunId: "pr_http",
          taskId: "t_http",
          role: "coder",
          roleProfileId: "coder@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: "diff",
            branch: "issuepilot/t_http",
            mergeRequest: {
              iid: 42,
              url: "https://gitlab.example.com/x/-/merge_requests/42",
              state: "opened",
            },
          },
        });
        await captured.pipelineStore!.saveAgentReport({
          agentReportId: "ar_rev_http",
          pipelineRunId: "pr_http",
          taskId: "t_http",
          role: "reviewer",
          roleProfileId: "reviewer@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          reviewer: {
            summary: "ok",
            decision: "approve_with_comments",
            confidence: 0.9,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [],
            mrPublication: {
              status: "published",
              noteIds: ["10", "20"],
              publishedAt: "2026-05-20T00:30:00.000Z",
            },
          },
        });

        // 复用 daemon 拼出来的 ServerDeps 起一个真实 Fastify。这样 HTTP
        // 路由解析、resolveContext、operatorFrom 等都走真链，避免任何
        // 「测试自建 pipelineService」造成的假阳性。
        const app = await createServer(captured, { port: 0 });
        try {
          const resp = await app.inject({
            method: "POST",
            url: "/api/agent-reports/ar_rev_http/revoke-ai-review",
            headers: {
              "x-issuepilot-operator": "alice",
              "content-type": "application/json",
            },
            payload: JSON.stringify({}),
          });
          expect(resp.statusCode).toBe(200);
          const body = JSON.parse(resp.body) as {
            agentReportId: string;
            status: string;
            revokedAt?: string;
          };
          expect(body.status).toBe("revoked");
          expect(body.agentReportId).toBe("ar_rev_http");

          // 1) 关键断言：daemon 装的 callback 真的把 MergeRequestNotes.remove
          //    调用了，参数 (projectId, mrIid, noteId) 与 coder report
          //    + reviewer noteIds 一致。把 daemon.ts 的
          //    `revokeReviewerMrComments: pipelineRevokeCallback` revert
          //    后这里必然 zero call → 用例红。
          expect(remove.mock.calls).toEqual([
            ["group/project", 42, 10],
            ["group/project", 42, 20],
          ]);

          // 2) 持久化校验：service.ts fix 后 noteIds 必须清空、status 翻
          //    revoked、publishedAt 作为审计痕迹保留。
          const getResp = await app.inject({
            method: "GET",
            url: "/api/agent-reports/ar_rev_http",
          });
          expect(getResp.statusCode).toBe(200);
          const getBody = JSON.parse(getResp.body) as {
            agentReport: ReviewerAgentReport;
          };
          const mr = getBody.agentReport.reviewer.mrPublication;
          expect(mr.status).toBe("revoked");
          expect(mr.noteIds).toEqual([]);
          expect(mr.publishedAt).toBe("2026-05-20T00:30:00.000Z");
        } finally {
          await app.close();
        }
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("POST /api/agent-reports/:id/revoke-ai-review surfaces 500 when coder report has no mergeRequest.iid", async () => {
    // 防回归：当 coder report 缺 mergeRequest.iid 时 daemon callback 必须
    // throw（让 service 把错误传出去），不能静默走 service 现有的「callback
    // 缺失等价于撤销已成功」降级路径 —— 那条路径是给 dev/无凭据场景留的，
    // 不应该被 daemon 触发。
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ip-daemon-revoke-c3-no-mr-"),
    );
    try {
      const workflow = buildV46Workflow(root);
      const { adapter: fakeGitLab, remove } = buildFakeGitLabWithDeleteSpy();

      let captured: ServerDeps | undefined;
      const daemon = await startDaemon(
        { workflowPath: workflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => workflow),
            start: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => fakeGitLab),
          createServer: vi.fn(async (deps: ServerDeps) => {
            captured = deps;
            return createFakeServer();
          }),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
          state: createRuntimeState(),
        },
      );

      try {
        if (!captured) throw new Error("server deps not captured");
        // coder report 故意不带 mergeRequest.iid。
        await captured.pipelineStore!.saveAgentReport({
          agentReportId: "ar_coder_no_mr",
          pipelineRunId: "pr_no_mr",
          taskId: "t_no_mr",
          role: "coder",
          roleProfileId: "coder@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: "diff",
            branch: "issuepilot/t_no_mr",
          },
        });
        await captured.pipelineStore!.saveAgentReport({
          agentReportId: "ar_rev_no_mr",
          pipelineRunId: "pr_no_mr",
          taskId: "t_no_mr",
          role: "reviewer",
          roleProfileId: "reviewer@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          reviewer: {
            summary: "ok",
            decision: "approve_with_comments",
            confidence: 0.9,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [],
            mrPublication: {
              status: "published",
              noteIds: ["99"],
            },
          },
        });

        const app = await createServer(captured, { port: 0 });
        try {
          const resp = await app.inject({
            method: "POST",
            url: "/api/agent-reports/ar_rev_no_mr/revoke-ai-review",
            headers: { "content-type": "application/json" },
            payload: JSON.stringify({}),
          });
          // Fastify 默认把未捕获 Error 翻成 500；关键是不能 200。
          expect(resp.statusCode).toBeGreaterThanOrEqual(500);
          expect(remove).not.toHaveBeenCalled();
        } finally {
          await app.close();
        }
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Task 4b — V4.6 daemon wiring (C1 part 2/3).
 *
 * Sanity-check that the daemon no longer stubs coder / reviewer as
 * `agent_not_configured`：reviewer retry must drive `driveLifecycle`
 * via the lifecycle adapter and persist a new AgentReport (even if the
 * adapter's known V4.7 TODO leaves `rawMessage = ""`, so the report
 * lands as `status = "failed"` with `lastError.code = "parse_failed"`).
 *
 * Bug-catching：把 daemon.ts 里 reviewer 的 `coordinator.run` 改回
 * `throw new CoordinatorError(..., "agent_not_configured")` 后，retry
 * 响应会变成 503 service_unavailable，本测试断言会红。
 */
describe("Task 4b — V4.6 daemon wiring (C1 part 2/3)", () => {
  const driveMock = vi.mocked(driveLifecycle);
  const spawnMock = vi.mocked(spawnRpc);

  beforeEach(() => {
    driveMock.mockReset();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      close: vi.fn(async () => undefined),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
    } as never);
  });

  afterEach(() => {
    driveMock.mockReset();
    spawnMock.mockReset();
  });

  it("retryAgentReport(reviewer) drives the lifecycle adapter and persists a new AgentReport (no more 503)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ip-daemon-4b-"));
    try {
      const workflow = buildV46Workflow(root);
      // The default `buildV46Workflow` hard-codes `/tmp/c.md` etc. Override
      // role.promptTemplate to point at real files under the test root so
      // `buildRoleProfile` reads something deterministic instead of failing
      // on ENOENT.
      const templatesDir = path.join(root, "templates");
      await fs.mkdir(templatesDir, { recursive: true });
      const coderTpl = path.join(templatesDir, "c.md");
      const reviewerTpl = path.join(templatesDir, "r.md");
      const teTpl = path.join(templatesDir, "t.md");
      await fs.writeFile(coderTpl, "Coder: {{task.title}}", "utf8");
      await fs.writeFile(reviewerTpl, "Reviewer: {{task.title}}", "utf8");
      await fs.writeFile(teTpl, "TE: {{task.title}}", "utf8");
      const wiredWorkflow: WorkflowConfig = {
        ...workflow,
        roles: {
          coder: { ...workflow.roles!.coder!, promptTemplate: coderTpl },
          reviewer: {
            ...workflow.roles!.reviewer!,
            promptTemplate: reviewerTpl,
          },
          test_evidence: {
            ...workflow.roles!.test_evidence!,
            promptTemplate: teTpl,
          },
        },
      };

      const { adapter: fakeGitLab } = buildFakeGitLabWithDeleteSpy();
      let captured: ServerDeps | undefined;
      const daemon = await startDaemon(
        { workflowPath: wiredWorkflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => wiredWorkflow),
            start: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => fakeGitLab),
          createServer: vi.fn(async (deps: ServerDeps) => {
            captured = deps;
            return createFakeServer();
          }),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
          state: createRuntimeState(),
        },
      );

      try {
        if (!captured) throw new Error("server deps not captured");
        expect(captured.pipelines).toBeDefined();
        expect(captured.pipelineStore).toBeDefined();

        // Seed: a finished PipelineRun + coder report + reviewer report so
        // service.retryAgentReport(reviewer) can drive coordinator.retryRole
        // (which requires a previous reviewer report for the supersede chain).
        const taskId = "t_4b";
        const workItemId = "wi_4b";
        const pipelineRunId = "pr_4b";
        const coderReport: CoderAgentReport = {
          agentReportId: "ar_coder_4b",
          pipelineRunId,
          taskId,
          role: "coder",
          roleProfileId: "coder@deadbeef",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: "ok",
            branch: "issuepilot/t_4b",
          },
        };
        const reviewerOrig: ReviewerAgentReport = {
          agentReportId: "ar_rev_4b",
          pipelineRunId,
          taskId,
          role: "reviewer",
          roleProfileId: "reviewer@deadbeef",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          reviewer: {
            summary: "ok",
            decision: "request_changes",
            confidence: 0.5,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [],
            mrPublication: { status: "pending", noteIds: [] },
          },
        };
        await captured.pipelineStore!.saveAgentReport(coderReport);
        await captured.pipelineStore!.saveAgentReport(reviewerOrig);
        await captured.pipelineStore!.savePipelineRun({
          pipelineRunId,
          workItemId,
          taskId,
          recipe: "full_pipeline",
          recipeSource: "workflow_default",
          agentReportIds: {
            coder: coderReport.agentReportId,
            reviewer: reviewerOrig.agentReportId,
            test_evidence: null,
          },
          status: "awaiting_rework",
          currentRole: null,
          createdAt: isoNow,
          updatedAt: isoNow,
          completedAt: isoNow,
        });

        // Coordinator needs a WorkItem + TaskPlan in the workItemStore so the
        // RoleProfileResolver can hand the renderer real workItem / task ids.
        const workItem: WorkItem = {
          workItemId,
          sourceIssue: {
            projectId: "group/project",
            iid: 4242,
            url: "https://gitlab.example.com/group/project/-/issues/4242",
            title: "task title",
          },
          title: "task title",
          goal: "ship",
          acceptanceCriteria: ["AC"],
          status: "running",
          taskIds: [taskId],
          createdAt: isoNow,
          updatedAt: isoNow,
        };
        const task: TaskNode = {
          taskId,
          title: "task title",
          goal: "do reviewer retry",
          scope: "scope",
          dependsOn: [],
          suggestedValidation: [],
          status: "awaiting_human_review",
          runIds: [],
          riskLevel: "low",
          currentPipelineRunId: pipelineRunId,
        };
        const workItemRoot = path.join(root, ".issuepilot");
        await fs.mkdir(path.join(workItemRoot, "work-items"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workItemRoot, "work-items", `${workItemId}.json`),
          JSON.stringify(workItem),
          "utf8",
        );
        // Mirror createWorkItemStore's `task-plans/<planId>.json` layout
        // (apps/orchestrator/src/work-items/store.ts:100). The store scans
        // the directory + indexes by `workItemId` lazily.
        await fs.mkdir(path.join(workItemRoot, "task-plans"), {
          recursive: true,
        });
        const planId = "tp_4b";
        await fs.writeFile(
          path.join(workItemRoot, "task-plans", `${planId}.json`),
          JSON.stringify({
            planId,
            workItemId,
            version: 1,
            tasks: [task],
            status: "accepted",
            createdAt: isoNow,
            updatedAt: isoNow,
          }),
          "utf8",
        );

        // Fake lifecycle: completed turn, lifecycle adapter's known V4.7 TODO
        // means the reviewer report will be parse_failed (rawMessage = "").
        driveMock.mockResolvedValue({
          status: "completed",
          turnsUsed: 1,
          lastTurnId: "turn_reviewer_4b",
          threadId: "th_4b",
        });

        const app = await createServer(captured, { port: 0 });
        try {
          const resp = await app.inject({
            method: "POST",
            url: "/api/agent-reports/ar_rev_4b/retry",
            headers: {
              "x-issuepilot-operator": "alice",
              "content-type": "application/json",
            },
            payload: JSON.stringify({ reason: "rerun reviewer" }),
          });
          // Key assertion: the wiring is real — NO 503 / agent_not_configured.
          // Revert the daemon.ts wiring to its old `throw CoordinatorError(...
          // "agent_not_configured")` stub and this expectation goes red.
          expect(resp.statusCode).toBe(200);
          const body = JSON.parse(resp.body) as {
            pipelineRunId?: string;
            agentReportId?: string;
          };
          expect(body.pipelineRunId).toBe(pipelineRunId);
          expect(typeof body.agentReportId).toBe("string");
          expect(body.agentReportId).not.toBe(reviewerOrig.agentReportId);

          // The lifecycle adapter actually spawned + drove the fake runner.
          expect(spawnMock).toHaveBeenCalledTimes(1);
          expect(driveMock).toHaveBeenCalledTimes(1);
          const driveArgs = driveMock.mock.calls[0]?.[0];
          // Reviewer thread name uses the role suffix from the daemon's
          // threadNameFor helper. This protects the daemon → adapter →
          // lifecycle round-trip.
          expect(driveArgs?.threadName).toBe(
            `group/project#${workItem.sourceIssue.iid}/${taskId}/reviewer`,
          );

          // The new reviewer report landed with parse_failed (because the
          // adapter still passes rawMessage = "" — V4.7 TODO). The exact
          // status code less important than the proof that wiring happened.
          const fresh = await captured.pipelineStore!.findAgentReportById(
            body.agentReportId!,
          );
          expect(fresh).toBeTruthy();
          expect(fresh?.report.role).toBe("reviewer");
          expect(fresh?.report.status).toBe("failed");
          expect(fresh?.report.lastError?.code).toBe("parse_failed");
        } finally {
          await app.close();
        }
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("acceptPlan starts a real V4.6 PipelineRun through the work-item production path", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ip-daemon-accept-pipeline-"),
    );
    try {
      const workflow = buildV46Workflow(root);
      const templatesDir = path.join(root, "templates");
      await fs.mkdir(templatesDir, { recursive: true });
      const coderTpl = path.join(templatesDir, "c.md");
      const reviewerTpl = path.join(templatesDir, "r.md");
      const teTpl = path.join(templatesDir, "t.md");
      await fs.writeFile(coderTpl, "Coder: {{task.title}}", "utf8");
      await fs.writeFile(reviewerTpl, "Reviewer: {{task.title}}", "utf8");
      await fs.writeFile(teTpl, "TE: {{task.title}}", "utf8");
      const wiredWorkflow: WorkflowConfig = {
        ...workflow,
        roles: {
          coder: { ...workflow.roles!.coder!, promptTemplate: coderTpl },
          reviewer: {
            ...workflow.roles!.reviewer!,
            promptTemplate: reviewerTpl,
          },
          test_evidence: {
            ...workflow.roles!.test_evidence!,
            promptTemplate: teTpl,
          },
        },
      };

      const { adapter: fakeGitLab } = buildFakeGitLabWithDeleteSpy();
      fakeGitLab.getIssue = vi.fn(async () => ({
        iid: 4242,
        title: "accept plan pipeline",
        description: "Issue body",
        url: "https://gitlab.example.com/group/project/-/issues/4242",
        projectId: "group/project",
        labels: ["ai-ready"],
      }));

      let captured: ServerDeps | undefined;
      const daemon = await startDaemon(
        { workflowPath: wiredWorkflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => wiredWorkflow),
            start: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => fakeGitLab),
          createServer: vi.fn(async (deps: ServerDeps) => {
            captured = deps;
            return createFakeServer();
          }),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => {}),
            stop: vi.fn(async () => {}),
          })),
          state: createRuntimeState(),
          workItemPlanner: {
            draft: vi.fn(async ({ workItemId }) => ({
              ok: true,
              plan: {
                planId: "tp_accept_pipeline",
                workItemId: workItemId ?? "wi_accept_pipeline",
                version: 1,
                tasks: [
                  {
                    taskId: "t_accept_1",
                    title: "first task",
                    goal: "g",
                    scope: "s",
                    dependsOn: [],
                    suggestedValidation: [],
                    status: "planned",
                    runIds: [],
                    riskLevel: "low",
                  },
                  {
                    taskId: "t_accept_2",
                    title: "second task",
                    goal: "g",
                    scope: "s",
                    dependsOn: [],
                    suggestedValidation: [],
                    status: "planned",
                    runIds: [],
                    riskLevel: "low",
                  },
                ],
                dependencies: [],
                operatorEdits: [],
                status: "draft",
              },
            })),
          },
        },
      );

      try {
        if (!captured?.workItems || !captured.pipelineStore) {
          throw new Error("server deps not captured");
        }
        driveMock.mockResolvedValue({
          status: "completed",
          turnsUsed: 1,
          lastTurnId: "turn_accept_pipeline",
          threadId: "thread_accept_pipeline",
          finalMessage:
            "```json\n{\"summary\":\"ok\",\"decision\":\"approve_with_comments\",\"confidence\":0.9,\"risks\":[],\"evidenceRequest\":[],\"findings\":[],\"inlineComments\":[]}\n```",
        });

        const draft = await captured.workItems.planFromIssue({
          iid: 4242,
          regenerate: false,
          operator: "alice",
        });
        if ("code" in draft) {
          throw new Error(`planFromIssue failed: ${draft.code}`);
        }

        const accepted = await captured.workItems.acceptPlan({
          workItemId: draft.workItem.workItemId,
          planId: draft.plan.planId,
          edits: [],
          operator: "alice",
        });
        if ("code" in accepted) {
          throw new Error(`acceptPlan failed: ${accepted.code}`);
        }

        const latest = await captured.pipelineStore.latestForTask({
          workItemId: draft.workItem.workItemId,
          taskId: "t_accept_1",
        });
        expect(latest).toBeTruthy();
        expect(latest?.workItemId).toBe(draft.workItem.workItemId);
        expect(latest?.taskId).toBe("t_accept_1");
        expect(latest?.agentReportIds.coder).toBeTruthy();
        expect(latest?.agentReportIds.reviewer).toBeTruthy();
        expect(latest?.agentReportIds.test_evidence).toBeTruthy();
        expect(latest?.status).toBe("awaiting_human_review");

        const coder = await captured.pipelineStore.latestAgentReportForRole({
          taskId: "t_accept_1",
          role: "coder",
        });
        expect(coder?.role).toBe("coder");
        const reviewer = await captured.pipelineStore.latestAgentReportForRole({
          taskId: "t_accept_1",
          role: "reviewer",
        });
        expect(reviewer?.role).toBe("reviewer");
        if (reviewer?.role !== "reviewer") {
          throw new Error("expected reviewer report");
        }
        expect(reviewer.status).toBe("complete");
        expect(reviewer.reviewer.decision).toBe("approve_with_comments");
        const testEvidence =
          await captured.pipelineStore.latestAgentReportForRole({
            taskId: "t_accept_1",
            role: "test_evidence",
          });
        expect(testEvidence?.role).toBe("test_evidence");
        expect(spawnMock).toHaveBeenCalled();
        expect(driveMock).toHaveBeenCalled();
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
