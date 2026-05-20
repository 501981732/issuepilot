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
 * - reviewer publisher 故意不注入 —— 验证 daemon 维持 deferred 决策
 *   （详见 spec §12 TODO + daemon.ts 4b 注释块）。
 * - `test_evidence` 角色仍然抛 `agent_not_configured`（Task 4c 会接），
 *   测试断言这一点是「这次只做 2/3 角色，testEvidence 留待 4c」。
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

import type { TaskNode, WorkItem } from "@issuepilot/shared-contracts";
import type { GitLabAdapter } from "@issuepilot/tracker-gitlab";
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
    server: { address: () => ({ port: 0, address: "127.0.0.1", family: "IPv4" }) },
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
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ip-task4b-single-"),
    );
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

        // Self-review item: reviewer publisher is intentionally NOT
        // injected. If a future change wires it without extending
        // tracker-gitlab.getMergeRequest, this assertion red-lights.
        expect(agents.reviewerPublisher).toBeUndefined();

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

        // ── 3) test_evidence remains a stub (Task 4c handles) ----------
        await expect(
          agents.testEvidence.run({
            workItem: sampleWorkItem,
            task: sampleTask,
            pipelineRun: makePipelineRun(),
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
          }),
        ).rejects.toMatchObject({
          name: "CoordinatorError",
          code: "agent_not_configured",
        });

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
        expect(agents.reviewerPublisher).toBeUndefined();

        const coderResult = await agents.coder.run(makeCoderInput());
        expect(coderResult.kind).toBe("report");
        if (coderResult.kind !== "report") return;
        expect(coderResult.report.role).toBe("coder");
        expect(mockedDriveLifecycle).toHaveBeenCalled();

        const reviewerResult = await agents.reviewer.run(makeReviewerInput());
        expect(reviewerResult.kind).toBe("report");

        // testEvidence on team daemon is still a stub (Task 4c handles).
        await expect(
          agents.testEvidence.run({
            workItem: sampleWorkItem,
            task: sampleTask,
            pipelineRun: makePipelineRun(),
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
          }),
        ).rejects.toMatchObject({
          name: "CoordinatorError",
          code: "agent_not_configured",
        });

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
});

function makePipelineRun(): {
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  recipe: "full_pipeline";
  recipeSource: "workflow_default";
  agentReportIds: { coder: null; reviewer: null; test_evidence: null };
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
