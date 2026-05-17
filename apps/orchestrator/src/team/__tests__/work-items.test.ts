import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  WorkflowConfig,
  CompileCentralWorkflowProjectInput,
} from "@issuepilot/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeaseStore } from "../../runtime/leases.js";
import type { ServerDeps, WorkItemService } from "../../server/index.js";
import type { TeamConfig } from "../config.js";
import { startTeamDaemon } from "../daemon.js";
import type { ProjectRegistry, RegisteredProject } from "../registry.js";

interface FakeServer {
  listening: boolean;
  close: ReturnType<typeof vi.fn>;
  server: { address: () => { port: number } };
}

let capturedDeps: ServerDeps | null;
let capturedApp: FakeServer | null;

function makeWorkflow(projectId: string, workspaceRoot: string): WorkflowConfig {
  return {
    schemaVersion: 1,
    name: `wf-${projectId}`,
    agent: { kind: "codex", maxConcurrentAgents: 1 },
    git: {
      baseBranch: "main",
      branchPrefix: `issuepilot/${projectId}/`,
      remote: "origin",
      strategy: "feature_branch_pr",
    },
    tracker: {
      kind: "gitlab",
      baseUrl: "https://gitlab.com",
      projectId: `group/${projectId}`,
      tokenEnv: "GITLAB_TOKEN",
      readyLabel: "ai-ready",
      runningLabel: "ai-running",
      handoffLabel: "human-review",
      reworkLabel: "ai-rework",
      blockedLabel: "ai-blocked",
      failedLabel: "ai-failed",
    },
    workspace: { root: workspaceRoot, gitRepoDir: workspaceRoot },
    promptTemplate: "task",
    ci: { enabled: false, refreshIntervalMs: 60000, jobsLimit: 10 },
    source: {
      path: `/tmp/${projectId}.workflow.md`,
      sha256: "sha",
      loadedAt: new Date(0).toISOString(),
    },
  } as unknown as WorkflowConfig;
}

function baseConfig(generatedRoot: string): TeamConfig {
  return {
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
        projectPath: `${generatedRoot}/projects/platform-web.yaml`,
        workflowProfilePath: `${generatedRoot}/workflows/default-web.md`,
        enabled: true,
        ci: null,
      },
      {
        id: "infra-tools",
        name: "Infra Tools",
        projectPath: `${generatedRoot}/projects/infra-tools.yaml`,
        workflowProfilePath: `${generatedRoot}/workflows/default-node-lib.md`,
        enabled: true,
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
      path: `${generatedRoot}/issuepilot.team.yaml`,
      sha256: "sha-team",
      loadedAt: new Date(0).toISOString(),
    },
  };
}

function makeRegistry(projects: RegisteredProject[]): ProjectRegistry {
  return {
    enabledProjects: () => projects,
    project: (id) => projects.find((p) => p.id === id),
    summaries: () =>
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        projectPath: p.projectPath,
        profilePath: p.workflowProfilePath,
        effectiveWorkflowPath: p.effectiveWorkflowPath,
        gitlabProject: p.workflow.tracker.projectId,
        enabled: true,
        activeRuns: 0,
        lastPollAt: null,
      })),
    updateProjectPoll: () => {},
    updateProjectActiveRuns: () => {},
  };
}

function makeLeaseStore(): LeaseStore {
  return {
    acquire: vi.fn(async () => null),
    release: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => null),
    expireStale: vi.fn(async () => []),
    active: vi.fn(async () => []),
    activeCount: () => 0,
  };
}

beforeEach(() => {
  capturedDeps = null;
  capturedApp = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("team daemon V4.1/V4.2 work-items wiring", () => {
  it("exposes a workItemsByProject map keyed by enabled project ids", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-team-wi-"),
    );
    try {
      const workspaceA = path.join(root, "workspaces/platform-web");
      const workspaceB = path.join(root, "workspaces/infra-tools");
      await fs.mkdir(workspaceA, { recursive: true });
      await fs.mkdir(workspaceB, { recursive: true });
      const projects: RegisteredProject[] = [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/cfg/projects/platform-web.yaml",
          workflowProfilePath: "/cfg/workflows/default-web.md",
          effectiveWorkflowPath: "/cfg/.generated/platform-web.workflow.md",
          enabled: true,
          workflow: makeWorkflow("platform-web", workspaceA),
          lastPollAt: null,
          activeRuns: 0,
        },
        {
          id: "infra-tools",
          name: "Infra Tools",
          projectPath: "/cfg/projects/infra-tools.yaml",
          workflowProfilePath: "/cfg/workflows/default-node-lib.md",
          effectiveWorkflowPath: "/cfg/.generated/infra-tools.workflow.md",
          enabled: true,
          workflow: makeWorkflow("infra-tools", workspaceB),
          lastPollAt: null,
          activeRuns: 0,
        },
      ];
      const registry = makeRegistry(projects);
      const loadTeamConfig = vi.fn(async () => baseConfig(root));
      const createProjectRegistry = vi.fn(async () => registry);
      const createLeaseStore = vi.fn(() => makeLeaseStore());
      const createServer = vi.fn(async (deps: ServerDeps) => {
        capturedDeps = deps;
        const fake: FakeServer = {
          listening: true,
          close: vi.fn(async () => {
            if (capturedApp) capturedApp.listening = false;
          }),
          server: { address: () => ({ port: 4738 }) },
        };
        capturedApp = fake;
        return fake as never;
      });

      const handle = await startTeamDaemon(
        {
          configPath: `${root}/issuepilot.team.yaml`,
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
        expect(capturedDeps).not.toBeNull();
        const byProject = capturedDeps?.workItemsByProject;
        expect(byProject).toBeInstanceOf(Map);
        expect(byProject?.size).toBe(2);
        expect(byProject?.has("platform-web")).toBe(true);
        expect(byProject?.has("infra-tools")).toBe(true);
        // Single-project `workItems` must NOT be set in team-mode so the
        // server route layer enforces the x-issuepilot-project header
        // instead of silently picking a default service.
        expect(capturedDeps?.workItems).toBeUndefined();

        const svc = byProject!.get("platform-web")!;
        // The service still has the V4.1 + V4.2 surface even when planner
        // / fetchIssue are stubbed: callers exercising the routes can rely
        // on consistent method shapes.
        expect(typeof svc.planFromIssue).toBe("function");
        expect(typeof svc.list).toBe("function");
        expect(typeof svc.detail).toBe("function");
        expect(typeof svc.acceptPlan).toBe("function");
        expect(typeof svc.regeneratePlan).toBe("function");
        expect(typeof svc.skipTask).toBe("function");
        expect(typeof svc.retryTask).toBe("function");
        expect(typeof svc.replanTask).toBe("function");
        expect(typeof svc.markNeedsRework).toBe("function");
        expect(typeof svc.unskipTask).toBe("function");
        expect(typeof svc.graph).toBe("function");
        expect(typeof svc.report).toBe("function");
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("scopes each project's WorkItemStore under its own workspace root", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-team-wi-scope-"),
    );
    try {
      const workspaceA = path.join(root, "workspaces/platform-web");
      const workspaceB = path.join(root, "workspaces/infra-tools");
      await fs.mkdir(workspaceA, { recursive: true });
      await fs.mkdir(workspaceB, { recursive: true });
      const projects: RegisteredProject[] = [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/cfg/projects/platform-web.yaml",
          workflowProfilePath: "/cfg/workflows/default-web.md",
          effectiveWorkflowPath: "/cfg/.generated/platform-web.workflow.md",
          enabled: true,
          workflow: makeWorkflow("platform-web", workspaceA),
          lastPollAt: null,
          activeRuns: 0,
        },
        {
          id: "infra-tools",
          name: "Infra Tools",
          projectPath: "/cfg/projects/infra-tools.yaml",
          workflowProfilePath: "/cfg/workflows/default-node-lib.md",
          effectiveWorkflowPath: "/cfg/.generated/infra-tools.workflow.md",
          enabled: true,
          workflow: makeWorkflow("infra-tools", workspaceB),
          lastPollAt: null,
          activeRuns: 0,
        },
      ];
      const registry = makeRegistry(projects);
      const loadTeamConfig = vi.fn(async () => baseConfig(root));
      const createProjectRegistry = vi.fn(async () => registry);
      const createLeaseStore = vi.fn(() => makeLeaseStore());
      const createServer = vi.fn(async (deps: ServerDeps) => {
        capturedDeps = deps;
        const fake: FakeServer = {
          listening: true,
          close: vi.fn(async () => {}),
          server: { address: () => ({ port: 4738 }) },
        };
        capturedApp = fake;
        return fake as never;
      });

      const handle = await startTeamDaemon(
        {
          configPath: `${root}/issuepilot.team.yaml`,
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
        const byProject = capturedDeps!.workItemsByProject!;
        // Both project services must be independent: a list call must
        // succeed and return an empty array (their workspace .issuepilot
        // dirs are fresh). The two services must NOT be the same object —
        // if the daemon ever reuses a single store across projects, this
        // sanity check catches it.
        const a = await byProject.get("platform-web")!.list();
        const b = await byProject.get("infra-tools")!.list();
        expect(Array.isArray(a)).toBe(true);
        expect(Array.isArray(b)).toBe(true);
        expect(byProject.get("platform-web")).not.toBe(
          byProject.get("infra-tools"),
        );
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("planFromIssue on a team-mode service surfaces gitlab_failed instead of crashing", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-team-wi-stub-"),
    );
    try {
      const workspaceA = path.join(root, "workspaces/platform-web");
      await fs.mkdir(workspaceA, { recursive: true });
      const projects: RegisteredProject[] = [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/cfg/projects/platform-web.yaml",
          workflowProfilePath: "/cfg/workflows/default-web.md",
          effectiveWorkflowPath: "/cfg/.generated/platform-web.workflow.md",
          enabled: true,
          workflow: makeWorkflow("platform-web", workspaceA),
          lastPollAt: null,
          activeRuns: 0,
        },
      ];
      const registry = makeRegistry(projects);
      const loadTeamConfig = vi.fn(async () => baseConfig(root));
      const createProjectRegistry = vi.fn(async () => registry);
      const createLeaseStore = vi.fn(() => makeLeaseStore());
      const createServer = vi.fn(async (deps: ServerDeps) => {
        capturedDeps = deps;
        const fake: FakeServer = {
          listening: true,
          close: vi.fn(async () => {}),
          server: { address: () => ({ port: 4738 }) },
        };
        capturedApp = fake;
        return fake as never;
      });

      const handle = await startTeamDaemon(
        {
          configPath: `${root}/issuepilot.team.yaml`,
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
        const svc = capturedDeps!.workItemsByProject!.get("platform-web")!;
        const result = await svc.planFromIssue({
          iid: 42,
          operator: "tester",
        });
        // The stub fetchIssue rejects, so the WorkItemService surfaces
        // `gitlab_failed` rather than letting the route layer crash.
        expect("error" in result ? result.error.code : null).toBe(
          "gitlab_failed",
        );
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
