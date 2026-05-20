/**
 * V4.6 follow-up Task 4b（review C1 part 2/3）—— daemon wiring smoke test.
 *
 * 这里要证明的事是：**`startDaemon`（单 daemon）+ `startTeamDaemon`
 * （team daemon）在装配 V4.6 pipeline 时不再注入「`CoordinatorError
 * ("agent_not_configured")` thrower」式 stub，而是接入真实的
 * `createCoderAgent` / `createReviewerAgent`（背靠
 * `@issuepilot/runner-codex-app-server` 的 `spawnRpc + driveLifecycle`）
 * 以及真实的 `buildRoleProfile`**。
 *
 * 设计要点：
 * - 我们没有 `POST /api/work-items/:id/tasks/:taskId/start-pipeline`
 *   HTTP 入口（spec §18 路由表暂不暴露 startPipeline）。所以本测试不走
 *   HTTP，而是把 `createCoordinator` mock 成一个透传 spy，捕获 daemon
 *   把哪些 agents / resolver 真正注入给了 coordinator。
 * - `@issuepilot/runner-codex-app-server` 同样被 mock，让 coder / reviewer
 *   lifecycle 在测试里安全地跑完一个 `completed` 回路，不真的 spawn Codex。
 * - reviewer publisher 已在 production gap closure 中注入；本文件只验证
 *   wiring 存在，具体 publish 成功/失败语义由 daemon-pipeline-wiring 与
 *   gitlab/mr-comments 测试覆盖。
 * - `test_evidence` 角色在 Task 4c 已接通（`createTestEvidenceAgent` +
 *   scanner snapshot collector）；本文件断言它不再抛 `agent_not_configured`，
 *   而是返回 `TestEvidenceAgentReport`，role / pipelineRunId 落位。
 *
 * Bug-catching 验证：如果把 daemon.ts 里 `coder` / `reviewer` 复原为
 * 原来的 `throw new CoordinatorError("...", "agent_not_configured")` stub，
 * 这里 `await agents.coder.run(...)` 的断言（应 resolve 成 `kind: "report"`）
 * 会立刻 reject，用例必红。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ReviewerAgentReport,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import {
  createGitLabClient,
  type GitLabAdapter,
  type GitLabApi,
  type GitLabClient,
} from "@issuepilot/tracker-gitlab";
import type { WorkflowConfig } from "@issuepilot/workflow";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 顶层 type-only import，给下方两个 vi.mock 的 importActual 调用提供
// 强类型签名（ESLint `consistent-type-imports` 不喜欢 `typeof import(...)`
// 的 inline 类型表达式）。
import type * as CoordinatorModuleType from "../pipelines/coordinator.js";
import type * as RunnerModuleType from "@issuepilot/runner-codex-app-server";

// ── Module-level mocks (hoisted) ─────────────────────────────────────
// vi.mock 必须在 import 之前发生（vitest 自动 hoist），这里把
// `@issuepilot/runner-codex-app-server` 替换成轻量 fake：spawnRpc 返回
// 一个仅实现 `close` 的对象，driveLifecycle 永远返回 `completed`。这样
// daemon 装配出的 coderLifecycle / reviewerLifecycle 在被 invoke 时不
// 会真的 spawn Codex，但会真的走完一遍 `mapCoderOutcome` /
// `mapReviewerOutcome` 翻译路径，证明 wiring 不是 stub。
vi.mock("@issuepilot/runner-codex-app-server", async () => {
  const actual = (await vi.importActual(
    "@issuepilot/runner-codex-app-server",
  )) as typeof RunnerModuleType;
  return {
    ...actual,
    spawnRpc: vi.fn(() => ({
      close: vi.fn(async () => undefined),
      onRequest: vi.fn(),
      onNotification: vi.fn(),
      sendRequest: vi.fn(async () => undefined),
      sendNotification: vi.fn(),
    })),
    driveLifecycle: vi.fn(async () => ({
      status: "completed" as const,
      turnsUsed: 1,
      lastTurnId: "fake-turn",
      threadId: "fake-thread",
    })),
    createGitLabTools: vi.fn(() => []),
  };
});

// `createCoordinator` 被 spy 包住：实现透传 `actual.createCoordinator`，
// 行为完全不变，但我们能从 `mock.calls[0][0]` 里捕获 daemon 注入的
// agents / roleProfileResolver / taskWriter。
vi.mock("../pipelines/coordinator.js", async () => {
  const actual = (await vi.importActual(
    "../pipelines/coordinator.js",
  )) as typeof CoordinatorModuleType;
  return {
    ...actual,
    createCoordinator: vi.fn(actual.createCoordinator),
  };
});

import { driveLifecycle } from "@issuepilot/runner-codex-app-server";

import { startDaemon } from "../daemon.js";
import {
  createCoordinator,
  type CoordinatorAgents,
  type CreateCoordinatorOptions,
  type RoleProfileResolver,
} from "../pipelines/coordinator.js";
import { createRuntimeState } from "../runtime/state.js";
import { startTeamDaemon } from "../team/daemon.js";
import type { TeamConfig } from "../team/config.js";
import type { ProjectRegistry, RegisteredProject } from "../team/registry.js";
import type { ServerDeps } from "../server/index.js";

const isoNow = "2026-05-20T01:00:00.000Z";

const sampleWorkItem: WorkItem = {
  workItemId: "wi_smoke",
  sourceIssue: {
    projectId: "group/project",
    iid: 11,
    url: "https://gitlab.example.com/group/project/-/issues/11",
    title: "Smoke",
  },
  title: "Smoke",
  goal: "smoke goal",
  acceptanceCriteria: ["AC"],
  status: "ready",
  taskIds: ["t_smoke"],
  createdAt: isoNow,
  updatedAt: isoNow,
};

const sampleTask: TaskNode = {
  taskId: "t_smoke",
  title: "smoke task",
  goal: "do the thing",
  scope: "scope",
  dependsOn: [],
  suggestedValidation: [],
  status: "ready",
  runIds: [],
  riskLevel: "low",
};

/**
 * Build a V4.6 workflow that points its role prompt templates at files
 * we just wrote under `root`. Mirrors `buildV46Workflow` in
 * `daemon-pipeline-wiring.test.ts` but uses real on-disk template paths
 * so `buildRoleProfile` can actually read them (the path-based render
 * pipeline runs against real fs).
 */
async function buildWorkflowWithTemplates(
  root: string,
): Promise<WorkflowConfig> {
  const coderTpl = path.join(root, "coder.md");
  const reviewerTpl = path.join(root, "reviewer.md");
  const teTpl = path.join(root, "test-evidence.md");
  await fs.writeFile(coderTpl, "coder prompt for {{task.title}}", "utf8");
  await fs.writeFile(reviewerTpl, "reviewer prompt for {{task.title}}", "utf8");
  await fs.writeFile(teTpl, "te prompt for {{task.title}}", "utf8");
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
    ci: { enabled: false, onFailure: "ai-rework", waitForPipeline: true },
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
      loadedAt: isoNow,
    },
    defaultRecipe: "full_pipeline",
    roles: {
      coder: {
        role: "coder",
        promptTemplate: coderTpl,
        promptTemplateHash: "abcdef0123",
        sandbox: "read_write_worktree",
      },
      reviewer: {
        role: "reviewer",
        promptTemplate: reviewerTpl,
        promptTemplateHash: "abcdef0123",
        sandbox: "read_only_worktree",
      },
      test_evidence: {
        role: "test_evidence",
        promptTemplate: teTpl,
        promptTemplateHash: "abcdef0123",
        sandbox: "read_only_source_write_evidence",
      },
    },
  } satisfies WorkflowConfig;
}

function createFakeServer(): FastifyInstance {
  return {
    close: vi.fn(async () => undefined),
    listen: vi.fn(async () => undefined),
    server: {
      address: () => ({ port: 0, address: "127.0.0.1", family: "IPv4" }),
    },
  } as unknown as FastifyInstance;
}

function createFakeGitLab(): GitLabAdapter {
  return {
    listCandidateIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => {
      throw new Error("not used");
    }),
    closeIssue: vi.fn(async () => ({ labels: [], state: undefined })),
    transitionLabels: vi.fn(async () => ({ labels: [] })),
    createIssueNote: vi.fn(async () => ({ id: 1 })),
    updateIssueNote: vi.fn(async () => undefined),
    findWorkpadNote: vi.fn(async () => null),
    findLatestIssuePilotWorkpadNote: vi.fn(async () => null),
    findMergeRequestBySourceBranch: vi.fn(async () => null),
    createMergeRequest: vi.fn(async () => ({
      id: 1,
      iid: 1,
      webUrl: "https://gitlab.example.com/x",
    })),
    updateMergeRequest: vi.fn(async () => undefined),
    getMergeRequest: vi.fn(async () => ({
      iid: 1,
      webUrl: "https://gitlab.example.com/x",
      state: "opened",
    })),
    listMergeRequestsBySourceBranch: vi.fn(async () => []),
    listMergeRequestNotes: vi.fn(async () => []),
    getPipelineStatus: vi.fn(async () => "unknown"),
  } satisfies GitLabAdapter;
}

const mockedCreateCoordinator = vi.mocked(createCoordinator);
const mockedDriveLifecycle = vi.mocked(driveLifecycle);

describe("Task 4b — V4.6 daemon wiring (C1 part 2/3) — single daemon", () => {
  beforeEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  afterEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  it("startDaemon assembles real coder + reviewer agents (no stubs) and a buildRoleProfile-backed resolver", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ip-task4b-single-"));
    try {
      const workflow = await buildWorkflowWithTemplates(root);
      const daemon = await startDaemon(
        { workflowPath: workflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => workflow),
            start: vi.fn(async () => ({ stop: vi.fn(async () => undefined) })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => createFakeGitLab()),
          createServer: vi.fn(async (_deps: ServerDeps) => createFakeServer()),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          })),
          state: createRuntimeState(),
        },
      );
      try {
        expect(mockedCreateCoordinator).toHaveBeenCalledTimes(1);
        const opts: CreateCoordinatorOptions =
          mockedCreateCoordinator.mock.calls[0]![0]!;
        const agents = opts.agents;

        // V4.6 production gap closure：tracker-gitlab now exposes MR
        // diff_refs, so daemon should inject a real reviewer publisher.
        expect(agents.reviewerPublisher?.publish).toEqual(expect.any(Function));

        // ── 1) coder agent — real wiring -------------------------------
        // 直接调一次 coder runner，断言 daemon 注入的不是 thrower：
        // 它必须 resolve 成 AgentRunResult，且 driveLifecycle 真的被
        // 触发过一次（即 lifecycle wiring 是真的，不是 stub）。
        const coderInput = makeCoderInput();
        const coderResult = await agents.coder.run(coderInput);
        expect(coderResult.kind).toBe("report");
        if (coderResult.kind !== "report") return;
        expect(coderResult.report.role).toBe("coder");
        expect(coderResult.report.roleProfileId).toMatch(/^coder@/);
        // driveLifecycle was actually called — proves wiring is real.
        expect(mockedDriveLifecycle).toHaveBeenCalled();

        // ── 2) reviewer agent — real wiring ----------------------------
        const reviewerInput = makeReviewerInput();
        const reviewerResult = await agents.reviewer.run(reviewerInput);
        expect(reviewerResult.kind).toBe("report");
        if (reviewerResult.kind !== "report") return;
        expect(reviewerResult.report.role).toBe("reviewer");
        expect(reviewerResult.report.roleProfileId).toMatch(/^reviewer@/);

        // ── 3) test_evidence — Task 4c wired ---------------------------
        // 不再抛 `agent_not_configured`：daemon 现在注入真实
        // `createTestEvidenceAgent` + scanner-snapshot collector。
        // evidenceDir 在测试 fixture 下不存在 → collector 落 `noop`
        // → agent 跳过该 outcome → items 空 → status="complete"
        // （test-evidence.ts:194-205 的 allFailed 前提是
        // `items.length > 0`）。这是 Task 4c review 要求的诚实路径：
        // 「首跑还没攒证据」与「证据收集失败」必须可区分。
        const tePipelineRun = makePipelineRun();
        const teResult = await agents.testEvidence.run({
          workItem: sampleWorkItem,
          task: sampleTask,
          pipelineRun: tePipelineRun,
          profile: {
            role: "test_evidence",
            roleProfileId: "test_evidence@abcdef0",
            prompt: "te",
            promptTemplateHash: "abcdef0123",
            sandbox: "read_only_source_write_evidence",
            toolAllow: [],
            timeoutSeconds: undefined,
            tokenScopeRequirements: undefined,
          },
        });
        expect(teResult.kind).toBe("report");
        if (teResult.kind !== "report") return;
        expect(teResult.report.role).toBe("test_evidence");
        expect(teResult.report.pipelineRunId).toBe(tePipelineRun.pipelineRunId);
        expect(teResult.report.taskId).toBe(sampleTask.taskId);
        expect(teResult.report.status).toBe("complete");
        expect(teResult.report.lastError).toBeUndefined();
        expect(teResult.report.testEvidence.evidenceItems).toEqual([]);

        // ── 4) RoleProfileResolver — buildRoleProfile-backed ----------
        const resolver: RoleProfileResolver = opts.roleProfileResolver;
        const coderProfile = await resolver.resolveRoleProfile("coder", {
          workItem: sampleWorkItem,
          task: sampleTask,
        });
        expect(coderProfile).not.toBeNull();
        expect(coderProfile?.role).toBe("coder");
        expect(coderProfile?.roleProfileId).toMatch(/^coder@/);
        // {{task.title}} placeholder was rendered against sampleTask.title.
        expect(coderProfile?.prompt).toContain(sampleTask.title);

        const reviewerProfile = await resolver.resolveRoleProfile("reviewer", {
          workItem: sampleWorkItem,
          task: sampleTask,
        });
        expect(reviewerProfile?.role).toBe("reviewer");
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Task 4b — V4.6 daemon wiring (C1 part 2/3) — team daemon", () => {
  beforeEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  afterEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  it("startTeamDaemon assembles real coder + reviewer agents per project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ip-task4b-team-"));
    try {
      const projectRoot = path.join(root, "p1-workspace");
      await fs.mkdir(projectRoot, { recursive: true });
      const workflow = await buildWorkflowWithTemplates(projectRoot);
      const fakeTeamConfig: TeamConfig = {
        version: 1,
        defaults: {} as TeamConfig["defaults"],
        projects: [],
        server: { host: "127.0.0.1", port: 0 },
        scheduler: {
          maxConcurrentRuns: 1,
          maxConcurrentRunsPerProject: 1,
          leaseTtlMs: 60_000,
          pollIntervalMs: 10_000,
        },
        source: {
          path: path.join(root, "team.yaml"),
          sha256: "deadbeefcafe1234",
          loadedAt: isoNow,
        },
      } as unknown as TeamConfig;
      const project: RegisteredProject = {
        id: "proj-a",
        name: "Project A",
        projectPath: projectRoot,
        workflowProfilePath: path.join(projectRoot, "workflow.profile.md"),
        effectiveWorkflowPath: workflow.source.path,
        enabled: true,
        workflow,
        lastPollAt: null,
        activeRuns: 0,
      };
      const fakeRegistry: ProjectRegistry = {
        enabledProjects: () => [project],
        project: (id) => (id === project.id ? project : undefined),
        summaries: () => [],
        updateProjectPoll: () => undefined,
        updateProjectActiveRuns: () => undefined,
      };

      const handle = await startTeamDaemon(
        { configPath: fakeTeamConfig.source.path },
        {
          loadTeamConfig: vi.fn(async () => fakeTeamConfig),
          createProjectRegistry: vi.fn(async () => fakeRegistry),
          createServer: vi.fn(async (_deps: ServerDeps) => createFakeServer()),
          createLeaseStore: vi.fn(() => ({
            acquire: vi.fn(async () => true),
            release: vi.fn(async () => undefined),
            list: vi.fn(async () => []),
            isHeldByOther: vi.fn(async () => false),
          })) as unknown as Parameters<
            typeof startTeamDaemon
          >[1]["createLeaseStore"],
          state: createRuntimeState(),
        },
      );
      try {
        // Per-project coordinator should be assembled once.
        expect(mockedCreateCoordinator).toHaveBeenCalledTimes(1);
        const opts: CreateCoordinatorOptions =
          mockedCreateCoordinator.mock.calls[0]![0]!;
        const agents: CoordinatorAgents = opts.agents;
        expect(agents.reviewerPublisher?.publish).toEqual(expect.any(Function));

        const coderResult = await agents.coder.run(makeCoderInput());
        expect(coderResult.kind).toBe("report");
        if (coderResult.kind !== "report") return;
        expect(coderResult.report.role).toBe("coder");
        expect(mockedDriveLifecycle).toHaveBeenCalled();

        const reviewerResult = await agents.reviewer.run(makeReviewerInput());
        expect(reviewerResult.kind).toBe("report");

        // testEvidence on team daemon — Task 4c wired（mirror 单 daemon
        // 的断言：empty evidenceDir → noop → items.length===0 → status
        // = "complete"，dashboard 能区分「首跑」与「真失败」）。
        const tePipelineRun = makePipelineRun();
        const teResult = await agents.testEvidence.run({
          workItem: sampleWorkItem,
          task: sampleTask,
          pipelineRun: tePipelineRun,
          profile: {
            role: "test_evidence",
            roleProfileId: "test_evidence@abcdef0",
            prompt: "te",
            promptTemplateHash: "abcdef0123",
            sandbox: "read_only_source_write_evidence",
            toolAllow: [],
            timeoutSeconds: undefined,
            tokenScopeRequirements: undefined,
          },
        });
        expect(teResult.kind).toBe("report");
        if (teResult.kind !== "report") return;
        expect(teResult.report.role).toBe("test_evidence");
        expect(teResult.report.pipelineRunId).toBe(tePipelineRun.pipelineRunId);
        expect(teResult.report.status).toBe("complete");
        expect(teResult.report.testEvidence.evidenceItems).toEqual([]);

        const coderProfile = await opts.roleProfileResolver.resolveRoleProfile(
          "coder",
          { workItem: sampleWorkItem, task: sampleTask },
        );
        expect(coderProfile?.role).toBe("coder");
        expect(coderProfile?.prompt).toContain(sampleTask.title);
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("team daemon publisher and revoke use the project GitLab client", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ip-task5-team-publish-"),
    );
    try {
      const projectRoot = path.join(root, "p1-workspace");
      await fs.mkdir(projectRoot, { recursive: true });
      const workflow = await buildWorkflowWithTemplates(projectRoot);
      const fakeTeamConfig: TeamConfig = {
        version: 1,
        defaults: {} as TeamConfig["defaults"],
        projects: [],
        server: { host: "127.0.0.1", port: 0 },
        scheduler: {
          maxConcurrentRuns: 1,
          maxConcurrentRunsPerProject: 1,
          leaseTtlMs: 60_000,
          pollIntervalMs: 10_000,
        },
        source: {
          path: path.join(root, "team.yaml"),
          sha256: "deadbeefcafe1234",
          loadedAt: isoNow,
        },
      } as unknown as TeamConfig;
      const project: RegisteredProject = {
        id: "proj-a",
        name: "Project A",
        projectPath: projectRoot,
        workflowProfilePath: path.join(projectRoot, "workflow.profile.md"),
        effectiveWorkflowPath: workflow.source.path,
        enabled: true,
        workflow,
        lastPollAt: null,
        activeRuns: 0,
      };
      const fakeRegistry: ProjectRegistry = {
        enabledProjects: () => [project],
        project: (id) => (id === project.id ? project : undefined),
        summaries: () => [],
        updateProjectPoll: () => undefined,
        updateProjectActiveRuns: () => undefined,
      };
      const fakeGitLab = buildFakeTeamGitLab();
      let capturedDeps: ServerDeps | undefined;

      const handle = await startTeamDaemon(
        { configPath: fakeTeamConfig.source.path },
        {
          loadTeamConfig: vi.fn(async () => fakeTeamConfig),
          createProjectRegistry: vi.fn(async () => fakeRegistry),
          createGitLab: vi.fn(async () => fakeGitLab.adapter),
          createServer: vi.fn(async (deps: ServerDeps) => {
            capturedDeps = deps;
            return createFakeServer();
          }),
          createLeaseStore: vi.fn(() => ({
            acquire: vi.fn(async () => true),
            release: vi.fn(async () => undefined),
            list: vi.fn(async () => []),
            isHeldByOther: vi.fn(async () => false),
          })) as unknown as Parameters<
            typeof startTeamDaemon
          >[1]["createLeaseStore"],
          state: createRuntimeState(),
        },
      );

      try {
        const opts: CreateCoordinatorOptions =
          mockedCreateCoordinator.mock.calls.at(-1)![0]!;
        const agents: CoordinatorAgents = opts.agents;
        const store = capturedDeps!.pipelineStoreByProject!.get("proj-a")!;
        await store.saveAgentReport({
          agentReportId: "ar_coder_team",
          pipelineRunId: "pr_team",
          taskId: sampleTask.taskId,
          role: "coder",
          roleProfileId: "coder@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: "diff",
            branch: "issuepilot/t",
            mergeRequest: {
              iid: 42,
              url: "https://gitlab.example.com/x/-/merge_requests/42",
              state: "opened",
            },
          },
        });
        await store.saveAgentReport({
          agentReportId: "ar_coder_newer_wrong_mr",
          pipelineRunId: "pr_other",
          taskId: sampleTask.taskId,
          role: "coder",
          roleProfileId: "coder@v1",
          status: "complete",
          startedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          coder: {
            diffSummary: "newer diff from another pipeline",
            branch: "issuepilot/other",
            mergeRequest: {
              iid: 99,
              url: "https://gitlab.example.com/x/-/merge_requests/99",
              state: "opened",
            },
          },
        });
        const reviewerReport: ReviewerAgentReport = {
          agentReportId: "ar_reviewer_team",
          pipelineRunId: "pr_team",
          taskId: sampleTask.taskId,
          role: "reviewer",
          roleProfileId: "reviewer@v1",
          status: "complete",
          startedAt: isoNow,
          completedAt: isoNow,
          evidenceLinks: [],
          redactedFields: [],
          reviewer: {
            summary: "Looks good",
            decision: "approve_with_comments",
            confidence: 0.9,
            risks: [],
            evidenceRequest: [],
            findings: [],
            inlineComments: [
              {
                id: "ic1",
                filePath: "src/a.ts",
                lineRange: { start: 10, end: 10 },
                severity: "medium",
                category: "correctness",
                message: "Check this line",
              },
            ],
            mrPublication: { status: "pending", noteIds: [] },
          },
        };

        const published = await agents.reviewerPublisher!.publish({
          workItem: sampleWorkItem,
          task: sampleTask,
          pipelineRun: {
            ...makePipelineRun(),
            pipelineRunId: "pr_team",
            agentReportIds: {
              coder: "ar_coder_team",
              reviewer: null,
              test_evidence: null,
            },
          },
          profile: makeReviewerInput().profile,
          reviewerReport,
        });
        expect(published.mrPublication.status).toBe("published");
        expect(published.mrPublication.noteIds).toEqual(["700", "701"]);
        expect(fakeGitLab.create).toHaveBeenCalledTimes(2);

        await store.saveAgentReport({
          ...reviewerReport,
          reviewer: {
            ...reviewerReport.reviewer,
            mrPublication: published.mrPublication,
          },
        });
        await store.savePipelineRun({
          ...makePipelineRun(),
          pipelineRunId: "pr_team",
          agentReportIds: {
            coder: "ar_coder_team",
            reviewer: reviewerReport.agentReportId,
            test_evidence: null,
          },
        });
        const revoke = await capturedDeps!
          .pipelinesByProject!.get("proj-a")!
          .revokeAiReview({ agentReportId: reviewerReport.agentReportId });
        expect(revoke.ok).toBe(true);
        expect(fakeGitLab.remove.mock.calls).toEqual([
          ["group/project", 42, 700],
          ["group/project", 42, 701],
        ]);
        const after = await store.findAgentReportById(
          reviewerReport.agentReportId,
        );
        expect(
          after?.report.role === "reviewer" &&
            after.report.reviewer.mrPublication.noteIds,
        ).toEqual([]);
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Task 4c review — publishEvent gate accepts detail.issueIid", () => {
  beforeEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  afterEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  it("codex_v46_coder_* events make it into eventStore (regression for the 4c review Block 1)", async () => {
    // Bug-catching：在 daemon.ts `publishEvent` 内只读 runIndex /
    // state.runs 解析 issueIid 时，pipeline-<taskId>-coder 这个合成
    // runId 永远不会命中，eventStore.append 被静默跳过。本用例真把
    // V4.6 coder lifecycle event 跑一遍并读 jsonl 文件，把那个回归
    // 兜住。
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ip-task4c-publish-"));
    try {
      const workflow = await buildWorkflowWithTemplates(root);
      // 让 driveLifecycle 在主动 emit 一个事件后落 completed —— adapter
      // 会把 ctx 透到 daemon，daemon publishLifecycleEvent 调
      // publishEvent，期望 eventStore 真的 append。
      mockedDriveLifecycle.mockImplementation(async (input) => {
        input.onEvent("task_started", { hint: "regression" });
        return {
          status: "completed",
          turnsUsed: 1,
          lastTurnId: "turn_regression",
          threadId: "th_regression",
        };
      });

      const daemon = await startDaemon(
        { workflowPath: workflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => workflow),
            start: vi.fn(async () => ({
              stop: vi.fn(async () => undefined),
            })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => createFakeGitLab()),
          createServer: vi.fn(async (_deps: ServerDeps) => createFakeServer()),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          })),
          state: createRuntimeState(),
        },
      );
      try {
        const opts: CreateCoordinatorOptions =
          mockedCreateCoordinator.mock.calls[0]![0]!;
        await opts.agents.coder.run({
          workItem: sampleWorkItem,
          task: sampleTask,
          pipelineRun: makePipelineRun(),
          profile: {
            role: "coder",
            roleProfileId: "coder@abcdef0",
            prompt: "do",
            promptTemplateHash: "abcdef0123",
            sandbox: "read_write_worktree",
            toolAllow: [],
            timeoutSeconds: undefined,
            tokenScopeRequirements: undefined,
          },
        });
        // eventStore.append 是 fire-and-forget；轮询读 jsonl 文件最多
        // 等 ~2s 给 I/O 落盘。
        const eventFile = path.join(
          root,
          ".issuepilot",
          "events",
          // slugify("group/project") => "group-project"
          `group-project-${sampleWorkItem.sourceIssue.iid}.jsonl`,
        );
        let content = "";
        for (let i = 0; i < 40; i += 1) {
          try {
            content = await fs.readFile(eventFile, "utf8");
            if (content.includes("codex_v46_coder_task_started")) break;
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(content).toContain("codex_v46_coder_task_started");
        const lines = content
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const v46Lines = lines.filter(
          (l) =>
            typeof l["type"] === "string" &&
            (l["type"] as string).startsWith("codex_v46_coder_"),
        );
        expect(v46Lines.length).toBeGreaterThan(0);
        const startedLine = v46Lines.find(
          (l) => l["type"] === "codex_v46_coder_task_started",
        );
        expect(startedLine).toBeDefined();
        expect(startedLine?.["runId"]).toBe(
          `pipeline-${sampleTask.taskId}-coder`,
        );
        // toEventRecord flattens detail to top-level (daemon.ts:222-244)：
        // 除了 detail.issue / detail.data，其它字段会被 spread 到记录
        // 顶层。所以 issueIid / taskId / role 出现在 record 顶层。
        expect(startedLine?.["issueIid"]).toBe(sampleWorkItem.sourceIssue.iid);
        expect(startedLine?.["taskId"]).toBe(sampleTask.taskId);
        expect(startedLine?.["role"]).toBe("coder");
        // fallbackEventIssue 根据 detail.issueIid 重建 issue 字段，
        // dashboard 时间线按 issue.iid 渲染时不会丢。
        const issue = startedLine?.["issue"] as Record<string, unknown>;
        expect(issue?.["iid"]).toBe(sampleWorkItem.sourceIssue.iid);
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Task 4c — V4.6 daemon testEvidence wiring (C1 part 3/3)", () => {
  beforeEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  afterEach(() => {
    mockedCreateCoordinator.mockClear();
    mockedDriveLifecycle.mockClear();
  });

  it(
    "testEvidence collector returns `collected` when evidenceDir is pre-populated " +
      "(proves daemon wired createTestEvidenceAgent + scanner-snapshot)",
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "ip-task4c-collect-"),
      );
      try {
        const workflow = await buildWorkflowWithTemplates(root);
        // 模拟 V4.5 dispatch 提前在 evidenceDir 留下产物（playwright zip /
        // screenshot / log）。Task 4c 的 scanner-snapshot collector 只看
        // 「目录是否存在 + 有没有 entry」，所以一个 dummy 文件就足够把
        // outcome 翻到 `collected`。layout 必须与 daemon.ts:`evidenceDirFor`
        // 一致：`<workspace.root>/<projectSlug>/<issueIid>/.issuepilot/
        // evidence/<taskId>`。
        const evidenceDir = path.join(
          root,
          // slugify("group/project") => "group-project"
          "group-project",
          String(sampleWorkItem.sourceIssue.iid),
          ".issuepilot",
          "evidence",
          sampleTask.taskId,
        );
        await fs.mkdir(evidenceDir, { recursive: true });
        await fs.writeFile(
          path.join(evidenceDir, "playwright.zip"),
          "fake-evidence",
          "utf8",
        );

        const daemon = await startDaemon(
          { workflowPath: workflow.source.path },
          {
            workflowLoader: {
              loadOnce: vi.fn(async () => workflow),
              start: vi.fn(async () => ({
                stop: vi.fn(async () => undefined),
              })),
              render: vi.fn(() => "prompt"),
            },
            createGitLab: vi.fn(async () => createFakeGitLab()),
            createServer: vi.fn(async (_deps: ServerDeps) =>
              createFakeServer(),
            ),
            startLoop: vi.fn(() => ({
              tick: vi.fn(async () => undefined),
              stop: vi.fn(async () => undefined),
            })),
            state: createRuntimeState(),
          },
        );
        try {
          expect(mockedCreateCoordinator).toHaveBeenCalledTimes(1);
          const opts: CreateCoordinatorOptions =
            mockedCreateCoordinator.mock.calls[0]![0]!;
          const agents = opts.agents;

          const tePipelineRun = makePipelineRun();
          const teResult = await agents.testEvidence.run({
            workItem: sampleWorkItem,
            task: sampleTask,
            pipelineRun: tePipelineRun,
            profile: {
              role: "test_evidence",
              roleProfileId: "test_evidence@abcdef0",
              prompt: "te",
              promptTemplateHash: "abcdef0123",
              sandbox: "read_only_source_write_evidence",
              toolAllow: [],
              timeoutSeconds: undefined,
              tokenScopeRequirements: undefined,
            },
          });
          // 4c 真正的成功路径：scanner-snapshot 看见 evidenceDir 有内容
          // → item.status="collected" + artifactPath=evidenceDir →
          // agent 把 final status 翻成 "complete"（test-evidence.ts:204）。
          // 把 daemon.ts 里的 testEvidence wiring revert 成
          // `throw CoordinatorError(..., "agent_not_configured")` 后，
          // 这里 `agents.testEvidence.run(...)` 会 reject，整个用例必红。
          expect(teResult.kind).toBe("report");
          if (teResult.kind !== "report") return;
          expect(teResult.report.status).toBe("complete");
          expect(teResult.report.role).toBe("test_evidence");
          expect(teResult.report.pipelineRunId).toBe(
            tePipelineRun.pipelineRunId,
          );
          expect(teResult.report.lastError).toBeUndefined();
          const items = teResult.report.testEvidence.evidenceItems;
          expect(items.length).toBe(1);
          expect(items[0]?.status).toBe("collected");
          expect(items[0]?.source).toBe("scanner");
          expect(items[0]?.artifactPath).toBe(evidenceDir);
          // evidenceLinks 顶层聚合应当复用 artifactPath（agent 行为契约）。
          expect(teResult.report.evidenceLinks).toEqual([evidenceDir]);
        } finally {
          await daemon.stop();
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("testEvidence rejects non-test_evidence profile with role_profile_invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ip-task4c-profile-"));
    try {
      const workflow = await buildWorkflowWithTemplates(root);
      const daemon = await startDaemon(
        { workflowPath: workflow.source.path },
        {
          workflowLoader: {
            loadOnce: vi.fn(async () => workflow),
            start: vi.fn(async () => ({
              stop: vi.fn(async () => undefined),
            })),
            render: vi.fn(() => "prompt"),
          },
          createGitLab: vi.fn(async () => createFakeGitLab()),
          createServer: vi.fn(async (_deps: ServerDeps) => createFakeServer()),
          startLoop: vi.fn(() => ({
            tick: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          })),
          state: createRuntimeState(),
        },
      );
      try {
        const opts: CreateCoordinatorOptions =
          mockedCreateCoordinator.mock.calls[0]![0]!;
        // 故意送一个 coder profile：daemon 的 narrow guard 必须把这条
        // 误用打成 `role_profile_invalid`，而不是把 coder profile 透给
        // testEvidenceAgent（会爆 evidenceDir / collectors 错位）。
        await expect(
          opts.agents.testEvidence.run({
            workItem: sampleWorkItem,
            task: sampleTask,
            pipelineRun: makePipelineRun(),
            profile: {
              role: "coder" as never,
              roleProfileId: "coder@abcdef0",
              prompt: "do",
              promptTemplateHash: "abcdef0123",
              sandbox: "read_write_worktree",
              toolAllow: [],
              timeoutSeconds: undefined,
              tokenScopeRequirements: undefined,
            },
          }),
        ).rejects.toMatchObject({
          name: "CoordinatorError",
          code: "role_profile_invalid",
        });
      } finally {
        await daemon.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function makePipelineRun(): {
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  recipe: "full_pipeline";
  recipeSource: "workflow_default";
  agentReportIds: {
    coder: string | null;
    reviewer: string | null;
    test_evidence: string | null;
  };
  status: "running_coding";
  currentRole: "coder";
  createdAt: string;
  updatedAt: string;
} {
  return {
    pipelineRunId: `pr_${randomUUID()}`,
    workItemId: sampleWorkItem.workItemId,
    taskId: sampleTask.taskId,
    recipe: "full_pipeline",
    recipeSource: "workflow_default",
    agentReportIds: { coder: null, reviewer: null, test_evidence: null },
    status: "running_coding",
    currentRole: "coder",
    createdAt: isoNow,
    updatedAt: isoNow,
  };
}

function makeCoderInput() {
  return {
    workItem: sampleWorkItem,
    task: sampleTask,
    pipelineRun: makePipelineRun(),
    profile: {
      role: "coder" as const,
      roleProfileId: "coder@abcdef0",
      prompt: "do",
      promptTemplateHash: "abcdef0123",
      sandbox: "read_write_worktree" as const,
      toolAllow: [],
      timeoutSeconds: undefined,
      tokenScopeRequirements: undefined,
    },
  };
}

function makeReviewerInput() {
  return {
    workItem: sampleWorkItem,
    task: sampleTask,
    pipelineRun: makePipelineRun(),
    profile: {
      role: "reviewer" as const,
      roleProfileId: "reviewer@abcdef0",
      prompt: "review",
      promptTemplateHash: "abcdef0123",
      sandbox: "read_only_worktree" as const,
      toolAllow: [],
      timeoutSeconds: undefined,
      tokenScopeRequirements: undefined,
      publishToMr: true,
      severityThreshold: "medium" as const,
      maxInlineComments: 25,
    },
  };
}

function buildFakeTeamGitLab(): {
  adapter: GitLabAdapter & { client: GitLabClient<GitLabApi> };
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  let nextId = 700;
  const create = vi.fn(async () => ({ id: nextId++ }));
  const remove = vi.fn(async () => undefined);
  const client = createGitLabClient<GitLabApi>({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: () => "tok" },
    GitlabCtor: function GitlabStub(this: object) {
      Object.assign(this, {
        MergeRequestNotes: { all: vi.fn(), create, remove },
      });
    } as never,
  });
  return {
    create,
    remove,
    adapter: {
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
        iid: 42,
        webUrl: "https://gitlab.example.com/x",
      })),
      updateMergeRequest: vi.fn(async () => {}),
      getMergeRequest: vi.fn(async () => ({
        iid: 42,
        webUrl: "https://gitlab.example.com/x",
        state: "opened",
        diffRefs: {
          baseSha: "base",
          startSha: "start",
          headSha: "head",
        },
      })),
      listMergeRequestsBySourceBranch: vi.fn(async () => []),
      listMergeRequestNotes: vi.fn(async () => []),
      getPipelineStatus: vi.fn(async () => "unknown"),
    },
  };
}
