import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  RUN_REPORT_VERSION,
  type RunReportArtifact,
  type TaskNode,
  type TaskPlan,
  type TaskRunLink,
  type WorkItem,
} from "@issuepilot/shared-contracts";
import type { WorkflowConfig } from "@issuepilot/workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeaseStore } from "../../runtime/leases.js";
import {
  createServer as realCreateServer,
  type ServerDeps,
} from "../../server/index.js";
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

function workItemFixture(projectId: string): WorkItem {
  return {
    workItemId: "wi_01",
    sourceIssue: {
      projectId: `group/${projectId}`,
      iid: 7,
      url: `https://gitlab.com/group/${projectId}/-/issues/7`,
      title: "Project work item",
    },
    title: "Project work item",
    goal: "Ship scoped evidence",
    acceptanceCriteria: ["Evidence is project-scoped"],
    status: "ready",
    taskIds: ["t1"],
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  };
}

function taskFixture(): TaskNode {
  return {
    taskId: "t1",
    title: "Collect evidence",
    goal: "Expose review evidence",
    scope: "apps/orchestrator",
    dependsOn: [],
    suggestedValidation: ["vitest"],
    status: "completed",
    runIds: ["shared-run"],
    riskLevel: "low",
  };
}

function planFixture(projectId: string): TaskPlan {
  return {
    planId: `tp_${projectId}`,
    workItemId: "wi_01",
    version: 1,
    tasks: [taskFixture()],
    dependencies: [],
    operatorEdits: [],
    status: "accepted",
    acceptedAt: "2026-05-17T00:00:01.000Z",
  };
}

function linkFixture(): TaskRunLink {
  return {
    taskId: "t1",
    runId: "shared-run",
    attempt: 1,
    status: "completed",
    branch: "issuepilot/t1",
    startedAt: "2026-05-17T00:00:02.000Z",
    completedAt: "2026-05-17T00:01:00.000Z",
  };
}

function runReportFixture(projectId: string): RunReportArtifact {
  return {
    version: RUN_REPORT_VERSION,
    runId: "shared-run",
    issue: {
      projectId: `group/${projectId}`,
      iid: 7,
      title: "Project work item",
      url: `https://gitlab.com/group/${projectId}/-/issues/7`,
      labels: ["human-review"],
    },
    run: {
      status: "completed",
      attempt: 1,
      branch: "issuepilot/t1",
      workspacePath: `/tmp/${projectId}/shared-run`,
      startedAt: "2026-05-17T00:00:02.000Z",
      endedAt: "2026-05-17T00:01:00.000Z",
      durations: { totalMs: 58_000 },
    },
    handoff: {
      summary: `summary for ${projectId}`,
      validation: [],
      risks: [],
      followUps: [],
      nextAction: "Review the scoped report.",
    },
    diff: {
      summary: `diff for ${projectId}`,
      filesChanged: 1,
      notableFiles: ["apps/orchestrator/src/team/daemon.ts"],
    },
    checks: [],
    evidence: [
      {
        kind: "screenshot",
        label: `${projectId} screenshot`,
        relPath: "screenshots/login.png",
      },
    ],
    mergeReadiness: {
      mode: "dry-run",
      status: "ready",
      reasons: [],
      evaluatedAt: "2026-05-17T00:01:01.000Z",
    },
    notes: {},
  };
}

async function seedWorkItemGraph(
  workspaceRoot: string,
  projectId: string,
): Promise<void> {
  const root = path.join(workspaceRoot, ".issuepilot");
  await fs.mkdir(path.join(root, "work-items"), { recursive: true });
  await fs.mkdir(path.join(root, "task-plans"), { recursive: true });
  await fs.mkdir(path.join(root, "task-run-links", "t1"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(root, "work-items", "wi_01.json"),
    JSON.stringify(workItemFixture(projectId), null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "task-plans", `tp_${projectId}.json`),
    JSON.stringify(planFixture(projectId), null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "task-run-links", "t1", "shared-run.json"),
    JSON.stringify(linkFixture(), null, 2),
    "utf8",
  );
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

  it("exposes per-project ReportStores and aggregates evidence from the selected project only", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-team-wi-reports-"),
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
        expect(capturedDeps?.reportsByProject).toBeInstanceOf(Map);
        expect(capturedDeps?.reportsByProject?.size).toBe(2);
        expect(capturedDeps?.reportsByProject?.has("platform-web")).toBe(true);
        expect(capturedDeps?.reportsByProject?.has("infra-tools")).toBe(true);
        expect(capturedDeps?.reports).toBeUndefined();

        await seedWorkItemGraph(workspaceA, "platform-web");
        await seedWorkItemGraph(workspaceB, "infra-tools");
        await capturedDeps!.reportsByProject!
          .get("platform-web")!
          .save(runReportFixture("platform-web"));
        await capturedDeps!.reportsByProject!
          .get("infra-tools")!
          .save(runReportFixture("infra-tools"));

        const platformEvidence = await capturedDeps!.workItemsByProject!
          .get("platform-web")!
          .getEvidence("wi_01");
        const infraEvidence = await capturedDeps!.workItemsByProject!
          .get("infra-tools")!
          .getEvidence("wi_01");

        expect("error" in platformEvidence).toBe(false);
        expect("error" in infraEvidence).toBe(false);
        if ("error" in platformEvidence || "error" in infraEvidence) return;
        expect(platformEvidence.index.map((entry) => entry.label)).toContain(
          "platform-web screenshot",
        );
        expect(platformEvidence.index.map((entry) => entry.label)).not.toContain(
          "infra-tools screenshot",
        );
        expect(infraEvidence.index.map((entry) => entry.label)).toContain(
          "infra-tools screenshot",
        );
        expect(infraEvidence.index.map((entry) => entry.label)).not.toContain(
          "platform-web screenshot",
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

  // Task 22: end-to-end coverage that drives the real Fastify routes
  // through the team daemon's per-project WorkItemService map.
  //
  //  - GET /api/work-items without `x-issuepilot-project` → 400
  //    `project_header_required` (the route must refuse to silently
  //    pick a project when team-mode is on).
  //  - GET /api/work-items with the project A header → only A's
  //    WorkItem is returned, B's namespace is untouched.
  //  - GET /api/work-items with the project B header → empty (no
  //    cross-project leakage).
  //  - Each project persists its WorkItem under its own workspace
  //    `.issuepilot/work-items/` directory, never the other project's.
  it("HTTP routes isolate each project's WorkItem namespace via x-issuepilot-project", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "issuepilot-team-wi-e2e-"),
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

      // Capture the real Fastify app so we can drive HTTP routes with
      // `app.inject`. Build it via the actual `createServer` exported
      // by the route layer (no fake / stub) so this test exercises
      // the project-header middleware end-to-end.
      let capturedApp: Awaited<ReturnType<typeof realCreateServer>> | null =
        null;
      const createServerWrapper: typeof realCreateServer = async (
        deps,
        opts,
      ) => {
        capturedDeps = deps;
        const built = await realCreateServer(deps, { ...opts, port: 0 });
        capturedApp = built;
        return built;
      };

      const handle = await startTeamDaemon(
        {
          configPath: `${root}/issuepilot.team.yaml`,
          host: "127.0.0.1",
          port: 0,
        },
        {
          loadTeamConfig,
          createProjectRegistry,
          createServer: createServerWrapper,
          createLeaseStore,
        },
      );

      try {
        expect(capturedDeps).not.toBeNull();
        expect(capturedApp).not.toBeNull();
        const byProject = capturedDeps!.workItemsByProject!;
        const app = capturedApp!;

        // Drop a synthetic WorkItem into project A's store directly.
        // We cannot drive `planFromIssue` because team-mode's
        // fetchIssue is a stub (see test #3) — but seeding the store
        // is enough to verify the namespace + routing contract end
        // to end.
        const projectAService = byProject.get("platform-web")!;
        const projectAStore = (projectAService as unknown as {
          __test_store?: never;
        });
        void projectAStore;
        // Bypass to the underlying store via service.list() being a
        // pure read; we synthesise via writing a JSON file under the
        // workspace .issuepilot dir directly. This mirrors what
        // `WorkItemStore.saveWorkItem` does without re-importing it,
        // keeping the test focused on routing isolation.
        const wiADir = path.join(workspaceA, ".issuepilot", "work-items");
        await fs.mkdir(wiADir, { recursive: true });
        const wiAFixture = {
          workItemId: "wi_A1",
          sourceIssue: {
            kind: "gitlab" as const,
            projectId: "group/platform-web",
            iid: 7,
            url: "https://gitlab.com/group/platform-web/-/issues/7",
            title: "Platform feature",
            body: "Body",
            labels: ["ai-ready"],
            milestone: null,
            assignees: [],
            web_url: "https://gitlab.com/group/platform-web/-/issues/7",
          },
          status: "ready" as const,
          taskIds: [],
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        };
        await fs.writeFile(
          path.join(wiADir, `${wiAFixture.workItemId}.json`),
          JSON.stringify(wiAFixture),
          "utf8",
        );

        // 1) No header → 400 project_header_required.
        const respNoHeader = await app.inject({
          method: "GET",
          url: "/api/work-items",
        });
        expect(respNoHeader.statusCode).toBe(400);
        expect(JSON.parse(respNoHeader.body)).toMatchObject({
          ok: false,
          code: "project_header_required",
        });

        // 2) Header points to platform-web → sees the WorkItem we
        //    seeded under its namespace.
        const respA = await app.inject({
          method: "GET",
          url: "/api/work-items",
          headers: { "x-issuepilot-project": "platform-web" },
        });
        expect(respA.statusCode).toBe(200);
        const bodyA = JSON.parse(respA.body) as {
          workItems: Array<{ workItemId: string }>;
        };
        expect(bodyA.workItems).toHaveLength(1);
        expect(bodyA.workItems[0]!.workItemId).toBe("wi_A1");

        // 3) Header points to infra-tools → empty list (no cross-
        //    project bleed). Independent namespace.
        const respB = await app.inject({
          method: "GET",
          url: "/api/work-items",
          headers: { "x-issuepilot-project": "infra-tools" },
        });
        expect(respB.statusCode).toBe(200);
        const bodyB = JSON.parse(respB.body) as {
          workItems: Array<unknown>;
        };
        expect(bodyB.workItems).toEqual([]);

        // 4) Unknown project header → 404 project_not_found (the
        //    server distinguishes "missing header" from "bad project
        //    id" so the dashboard can show a clearer error).
        const respUnknown = await app.inject({
          method: "GET",
          url: "/api/work-items",
          headers: { "x-issuepilot-project": "nonexistent" },
        });
        expect(respUnknown.statusCode).toBe(404);
        expect(JSON.parse(respUnknown.body)).toMatchObject({
          ok: false,
          code: "project_not_found",
        });

        // 5) Workspace dir isolation: project B's .issuepilot dir
        //    must NOT contain the WorkItem we wrote under project A.
        //    The cleanest way to assert this without coupling to the
        //    store layout: project B's service.list() returned empty
        //    above. We additionally verify the FS layer:
        const wiBDirExists = await fs
          .stat(path.join(workspaceB, ".issuepilot", "work-items"))
          .then(() => true)
          .catch(() => false);
        if (wiBDirExists) {
          const entries = await fs.readdir(
            path.join(workspaceB, ".issuepilot", "work-items"),
          );
          expect(entries).toEqual([]);
        }
      } finally {
        await handle.stop();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
