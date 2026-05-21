import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeaseStore } from "../../runtime/leases.js";
import { createClaudeCodeAdapter } from "../../runners/claude-code.js";
import type { ServerDeps } from "../../server/index.js";
import type { TeamConfig } from "../config.js";
import { startTeamDaemon } from "../daemon.js";
import type { ProjectRegistry } from "../registry.js";

vi.mock("../../runners/claude-code.js", () => ({
  createClaudeCodeAdapter: vi.fn(({ descriptor }) => ({
    descriptor,
    run: vi.fn(async () => ({
      status: "completed",
      finalMessage: "{}",
      artifacts: [],
      redactedFields: [],
    })),
  })),
}));

interface FakeServer {
  listening: boolean;
  close: ReturnType<typeof vi.fn>;
  server: { address: () => { port: number } };
}

let createdDeps: ServerDeps | null;
let createdApp: FakeServer | null;

const baseConfig = (): TeamConfig => ({
  version: 1,
  server: { host: "127.0.0.1", port: 0 },
  scheduler: {
    maxConcurrentRuns: 2,
    maxConcurrentRunsPerProject: 1,
    leaseTtlMs: 900_000,
    pollIntervalMs: 10_000,
  },
  defaults: {
    labelsPath: null,
    codexPath: null,
    workspaceRoot: "~/.issuepilot/workspaces",
    repoCacheRoot: "~/.issuepilot/repos",
  },
  projects: [
    {
      id: "platform-web",
      name: "Platform Web",
      projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
      workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
      enabled: true,
      ci: null,
    },
    {
      id: "infra-tools",
      name: "Infra Tools",
      projectPath: "/srv/issuepilot-config/projects/infra-tools.yaml",
      workflowProfilePath:
        "/srv/issuepilot-config/workflows/default-node-lib.md",
      enabled: false,
      ci: null,
    },
  ],
  retention: {
    successfulRunDays: 7,
    failedRunDays: 14,
    maxWorkspaceGb: 20,
    cleanupIntervalMs: 3_600_000,
  },
  ci: null,
  source: {
    path: "/srv/issuepilot-config/issuepilot.team.yaml",
    sha256: "sha",
    loadedAt: new Date(0).toISOString(),
  },
});

const summaries = [
  {
    id: "platform-web",
    name: "Platform Web",
    projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
    profilePath: "/srv/issuepilot-config/workflows/default-web.md",
    effectiveWorkflowPath:
      "/srv/issuepilot-config/.generated/platform-web.workflow.md",
    gitlabProject: "group/platform-web",
    enabled: true as const,
    activeRuns: 0,
    lastPollAt: null,
  },
  {
    id: "infra-tools",
    name: "Infra Tools",
    projectPath: "/srv/issuepilot-config/projects/infra-tools.yaml",
    profilePath: "/srv/issuepilot-config/workflows/default-node-lib.md",
    effectiveWorkflowPath: "",
    gitlabProject: "",
    enabled: false as const,
    activeRuns: 0,
    lastPollAt: null,
  },
];

beforeEach(() => {
  createdDeps = null;
  createdApp = null;
  vi.mocked(createClaudeCodeAdapter).mockImplementation(({ descriptor }) => ({
    descriptor,
    run: vi.fn(async () => ({
      status: "completed",
      finalMessage: "{}",
      artifacts: [],
      redactedFields: [],
    })),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startTeamDaemon", () => {
  it("starts a project-aware server shell using parsed team config", async () => {
    const loadTeamConfig = vi.fn(async () => baseConfig());
    let summariesValue = [...summaries];
    const registry: ProjectRegistry = {
      enabledProjects: () => [],
      project: () => undefined,
      summaries: () => summariesValue,
      updateProjectPoll: () => {},
      updateProjectActiveRuns: () => {},
    };
    const createProjectRegistry = vi.fn(async () => registry);
    let cachedActive = 0;
    const leaseStore: LeaseStore = {
      acquire: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => null),
      expireStale: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activeCount: () => cachedActive,
    };
    const createLeaseStore = vi.fn(() => leaseStore);
    const createServer = vi.fn(async (deps: ServerDeps) => {
      createdDeps = deps;
      const close = vi.fn(async () => {
        if (createdApp) createdApp.listening = false;
      });
      const fake: FakeServer = {
        listening: true,
        close,
        server: { address: () => ({ port: 4738 }) },
      };
      createdApp = fake;
      return fake as never;
    });

    const handle = await startTeamDaemon(
      {
        configPath: "/srv/issuepilot.team.yaml",
        host: "127.0.0.1",
        port: 4738,
      },
      {
        loadTeamConfig,
        createProjectRegistry,
        createServer,
        createLeaseStore,
      },
    );

    expect(handle.url).toBe("http://127.0.0.1:4738");
    expect(createdDeps).not.toBeNull();
    expect(createdDeps).toMatchObject({
      workflowPath: "/srv/issuepilot-config/issuepilot.team.yaml",
      gitlabProject: "team",
      concurrency: 2,
    });
    expect(typeof createdDeps?.runtime).toBe("function");
    expect(typeof createdDeps?.projects).toBe("function");

    const runtimeGetter = createdDeps!.runtime as () => {
      mode: string;
      activeLeases: number;
      projectCount: number;
    };
    const projectsGetter = createdDeps!.projects as () => typeof summaries;
    expect(runtimeGetter()).toEqual({
      mode: "team",
      maxConcurrentRuns: 2,
      activeLeases: 0,
      projectCount: 2,
    });
    expect(projectsGetter()).toEqual(summaries);

    cachedActive = 1;
    summariesValue = [
      {
        ...summaries[0]!,
        activeRuns: 1,
        lastPollAt: "2026-05-15T01:00:00.000Z",
      },
      summaries[1]!,
    ];
    expect(runtimeGetter().activeLeases).toBe(1);
    expect(projectsGetter()[0]?.activeRuns).toBe(1);

    expect(createLeaseStore).toHaveBeenCalled();
    const leaseOpts = createLeaseStore.mock.calls[0]?.[0] as {
      filePath: string;
    };
    expect(leaseOpts.filePath).toMatch(/leases-/);

    await handle.stop();
    expect(createdApp?.close).toHaveBeenCalled();
  });

  it("does not wire operatorActions in Phase 2 (V2 dispatch lands later)", async () => {
    const loadTeamConfig = vi.fn(async () => baseConfig());
    const registry: ProjectRegistry = {
      enabledProjects: () => [],
      project: () => undefined,
      summaries: () => summaries,
      updateProjectPoll: () => {},
      updateProjectActiveRuns: () => {},
    };
    const createProjectRegistry = vi.fn(async () => registry);
    const leaseStore: LeaseStore = {
      acquire: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => null),
      expireStale: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activeCount: () => 0,
    };
    const createLeaseStore = vi.fn(() => leaseStore);
    const createServer = vi.fn(async (deps: ServerDeps) => {
      createdDeps = deps;
      const close = vi.fn(async () => {});
      const fake: FakeServer = {
        listening: true,
        close,
        server: { address: () => ({ port: 4738 }) },
      };
      createdApp = fake;
      return fake as never;
    });

    const handle = await startTeamDaemon(
      {
        configPath: "/srv/issuepilot.team.yaml",
        host: "127.0.0.1",
        port: 4738,
      },
      {
        loadTeamConfig,
        createProjectRegistry,
        createServer,
        createLeaseStore,
      },
    );

    try {
      expect(createdDeps?.operatorActions).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("wires V4.4 quality deps per project in team daemon", async () => {
    const loadTeamConfig = vi.fn(async () => baseConfig());
    const enabledProjects = [
      {
        id: "project-a",
        name: "Project A",
        projectPath: "/srv/issuepilot-config/projects/project-a.yaml",
        workflowProfilePath: "/srv/issuepilot-config/workflows/a.md",
        effectiveWorkflowPath: "/tmp/a.workflow.md",
        enabled: true as const,
        workflow: {
          source: {
            path: "/tmp/a.workflow.md",
            sha256: "sha",
            loadedAt: new Date(0).toISOString(),
          },
          tracker: {
            kind: "gitlab",
            baseUrl: "https://gitlab.example",
            projectId: "group/project-a",
            handoffLabel: "human-review",
          },
          agent: {
            command: "codex",
            args: [],
            timeoutMs: 60_000,
            maxConcurrentAgents: 1,
            cwd: null,
            envAllow: [],
            stdinPrompt: false,
          },
          retry: { maxAttempts: 1, backoffMs: 1000 },
          workspace: { root: "/tmp/issuepilot-test-a" },
        },
        lastPollAt: null,
        activeRuns: 0,
      },
      {
        id: "project-b",
        name: "Project B",
        projectPath: "/srv/issuepilot-config/projects/project-b.yaml",
        workflowProfilePath: "/srv/issuepilot-config/workflows/b.md",
        effectiveWorkflowPath: "/tmp/b.workflow.md",
        enabled: true as const,
        workflow: {
          source: {
            path: "/tmp/b.workflow.md",
            sha256: "sha",
            loadedAt: new Date(0).toISOString(),
          },
          tracker: {
            kind: "gitlab",
            baseUrl: "https://gitlab.example",
            projectId: "group/project-b",
            handoffLabel: "human-review",
          },
          agent: {
            command: "codex",
            args: [],
            timeoutMs: 60_000,
            maxConcurrentAgents: 1,
            cwd: null,
            envAllow: [],
            stdinPrompt: false,
          },
          retry: { maxAttempts: 1, backoffMs: 1000 },
          workspace: { root: "/tmp/issuepilot-test-b" },
        },
        lastPollAt: null,
        activeRuns: 0,
      },
    ] as never;
    const registry: ProjectRegistry = {
      enabledProjects: () => enabledProjects,
      project: () => undefined,
      summaries: () => summaries,
      updateProjectPoll: () => {},
      updateProjectActiveRuns: () => {},
    };
    const createProjectRegistry = vi.fn(async () => registry);
    const leaseStore: LeaseStore = {
      acquire: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => null),
      expireStale: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activeCount: () => 0,
    };
    const createLeaseStore = vi.fn(() => leaseStore);
    const createServer = vi.fn(async (deps: ServerDeps) => {
      createdDeps = deps;
      const close = vi.fn(async () => {});
      const fake: FakeServer = {
        listening: true,
        close,
        server: { address: () => ({ port: 4738 }) },
      };
      createdApp = fake;
      return fake as never;
    });

    const handle = await startTeamDaemon(
      {
        configPath: "/srv/issuepilot.team.yaml",
        host: "127.0.0.1",
        port: 4738,
      },
      {
        loadTeamConfig,
        createProjectRegistry,
        createServer,
        createLeaseStore,
      },
    );

    try {
      expect(createdDeps?.qualityByProject?.has("project-a")).toBe(true);
      expect(createdDeps?.qualityByProject?.has("project-b")).toBe(true);
      const projectA = createdDeps?.qualityByProject?.get("project-a");
      expect(projectA?.metadata?.workflow).toBe("a");
      expect(projectA?.reports).toBeDefined();
      expect(projectA?.workItems).toBeDefined();
    } finally {
      await handle.stop();
    }
  });

  /**
   * V4.6 Phase 9 Task 9.3: per-project pipeline services are wired only
   * for projects whose workflow declares both `default_recipe` and
   * `roles`. Projects missing those V4.6 fields are skipped with a
   * `console.warn`; the daemon stays bootable and routes for the
   * configured projects still work end-to-end.
   */
  it("wires V4.6 pipelinesByProject for projects with default_recipe + roles and skips legacy projects", async () => {
    const loadTeamConfig = vi.fn(async () => baseConfig());
    const enabledProjects = [
      {
        id: "project-a",
        name: "Project A",
        projectPath: "/srv/issuepilot-config/projects/project-a.yaml",
        workflowProfilePath: "/srv/issuepilot-config/workflows/a.md",
        effectiveWorkflowPath: "/tmp/a.workflow.md",
        enabled: true as const,
        workflow: {
          source: {
            path: "/tmp/a.workflow.md",
            sha256: "sha",
            loadedAt: new Date(0).toISOString(),
          },
          tracker: {
            kind: "gitlab",
            baseUrl: "https://gitlab.example",
            projectId: "group/project-a",
            handoffLabel: "human-review",
          },
          agent: {
            command: "codex",
            args: [],
            timeoutMs: 60_000,
            maxConcurrentAgents: 1,
            cwd: null,
            envAllow: [],
            stdinPrompt: false,
          },
          retry: { maxAttempts: 1, backoffMs: 1000 },
          workspace: { root: "/tmp/issuepilot-test-a" },
          defaultRecipe: "full_pipeline",
          runners: {
            codex_app_server: {
              runnerId: "codex_app_server",
              kind: "codex_app_server",
              capabilities: [
                "roles.coder",
                "roles.test_evidence",
                "filesystem.worktree_write",
                "artifacts",
              ],
            },
            claude_reviewer: {
              runnerId: "claude_reviewer",
              kind: "claude_code",
              capabilities: [
                "roles.reviewer",
                "events.streaming",
                "cancel",
                "artifacts",
                "filesystem.readonly",
              ],
              options: { command: "claude", turnTimeoutMs: 600_000 },
            },
          },
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
              runner: "claude_reviewer",
            },
            test_evidence: {
              role: "test_evidence",
              promptTemplate: "/tmp/t.md",
              promptTemplateHash: "deadbeef",
              sandbox: "read_only_source_write_evidence",
            },
          },
        },
        lastPollAt: null,
        activeRuns: 0,
      },
      {
        id: "project-legacy",
        name: "Project Legacy (no V4.6)",
        projectPath: "/srv/issuepilot-config/projects/project-legacy.yaml",
        workflowProfilePath: "/srv/issuepilot-config/workflows/legacy.md",
        effectiveWorkflowPath: "/tmp/legacy.workflow.md",
        enabled: true as const,
        workflow: {
          source: {
            path: "/tmp/legacy.workflow.md",
            sha256: "sha",
            loadedAt: new Date(0).toISOString(),
          },
          tracker: {
            kind: "gitlab",
            baseUrl: "https://gitlab.example",
            projectId: "group/project-legacy",
            handoffLabel: "human-review",
          },
          agent: {
            command: "codex",
            args: [],
            timeoutMs: 60_000,
            maxConcurrentAgents: 1,
            cwd: null,
            envAllow: [],
            stdinPrompt: false,
          },
          retry: { maxAttempts: 1, backoffMs: 1000 },
          workspace: { root: "/tmp/issuepilot-test-legacy" },
          // No defaultRecipe / roles — legacy V4.5 fixture.
        },
        lastPollAt: null,
        activeRuns: 0,
      },
    ] as never;
    const registry: ProjectRegistry = {
      enabledProjects: () => enabledProjects,
      project: () => undefined,
      summaries: () => summaries,
      updateProjectPoll: () => {},
      updateProjectActiveRuns: () => {},
    };
    const createProjectRegistry = vi.fn(async () => registry);
    const leaseStore: LeaseStore = {
      acquire: vi.fn(async () => null),
      release: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => null),
      expireStale: vi.fn(async () => []),
      active: vi.fn(async () => []),
      activeCount: () => 0,
    };
    const createLeaseStore = vi.fn(() => leaseStore);
    const createServer = vi.fn(async (deps: ServerDeps) => {
      createdDeps = deps;
      const close = vi.fn(async () => {});
      const fake: FakeServer = {
        listening: true,
        close,
        server: { address: () => ({ port: 4738 }) },
      };
      createdApp = fake;
      return fake as never;
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const createClaudeAdapterMock = vi.mocked(createClaudeCodeAdapter);
    createClaudeAdapterMock.mockClear();
    let handle: Awaited<ReturnType<typeof startTeamDaemon>> | undefined;
    try {
      handle = await startTeamDaemon(
        {
          configPath: "/srv/issuepilot.team.yaml",
          host: "127.0.0.1",
          port: 4738,
        },
        {
          loadTeamConfig,
          createProjectRegistry,
          createServer,
          createLeaseStore,
        },
      );
      expect(createdDeps?.pipelinesByProject?.has("project-a")).toBe(true);
      expect(createdDeps?.pipelinesByProject?.has("project-legacy")).toBe(
        false,
      );
      expect(createClaudeAdapterMock).toHaveBeenCalledWith({
        descriptor: {
          runnerId: "claude_reviewer",
          kind: "claude_code",
          capabilities: [
            "roles.reviewer",
            "events.streaming",
            "cancel",
            "artifacts",
            "filesystem.readonly",
          ],
          options: { command: "claude", turnTimeoutMs: 600_000 },
        },
      });

      const pipelineA = createdDeps?.pipelinesByProject?.get("project-a");
      expect(pipelineA).toBeDefined();
      const result = await pipelineA!.validateWorkflowRoles({
        workflowId: "default",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.valid).toBe(true);
      }

      expect(
        warn.mock.calls.some(([msg]) =>
          String(msg).includes(
            "V4.6 pipeline service skipped for project project-legacy",
          ),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
      if (handle) await handle.stop();
    }
  });
});
