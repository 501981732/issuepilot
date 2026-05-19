import * as os from "node:os";
import * as path from "node:path";

import { createEventBus, type EventBus } from "@issuepilot/observability";
import type { IssuePilotInternalEvent } from "@issuepilot/shared-contracts";

import { buildPipelineQualitySummary } from "../daemon.js";
import { createImprovementService } from "../improvements/service.js";
import { createImprovementStore } from "../improvements/store.js";
import {
  CoordinatorError,
  createCoordinator,
  type CoordinatorAgents,
  type RoleProfileResolver,
} from "../pipelines/coordinator.js";
import {
  createPipelineService,
  type PipelineService,
} from "../pipelines/service.js";
import {
  createPipelineStore,
  type PipelineStore,
} from "../pipelines/store.js";
import type { QualityCollectorDeps } from "../quality/collect.js";
import { createReportStore, type ReportStore } from "../reports/store.js";
import {
  createLeaseStore as defaultCreateLeaseStore,
  type LeaseStore,
} from "../runtime/leases.js";
import { createRuntimeState, type RuntimeState } from "../runtime/state.js";
import { createServer, type WorkItemService } from "../server/index.js";
import {
  createWorkItemPlanner,
  type RawPlanResponse,
} from "../work-items/planner.js";
import { createWorkItemService } from "../work-items/service.js";
import { createWorkItemStore } from "../work-items/store.js";

import {
  loadTeamConfig as defaultLoadTeamConfig,
  type TeamConfig,
} from "./config.js";
import {
  createProjectRegistry as defaultCreateProjectRegistry,
  type CentralWorkflowCompilerLike,
  type ProjectRegistry,
  type RegisteredProject,
} from "./registry.js";

/**
 * Public handle returned by {@link startTeamDaemon}. `wait()` resolves when
 * the server reports a graceful shutdown; `stop()` requests one.
 */
export interface TeamDaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartTeamDaemonOptions {
  configPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export interface StartTeamDaemonDeps {
  loadTeamConfig?: ((configPath: string) => Promise<TeamConfig>) | undefined;
  createProjectRegistry?:
    | ((
        config: TeamConfig,
        deps?: CentralWorkflowCompilerLike,
      ) => Promise<ProjectRegistry>)
    | undefined;
  /**
   * Injectable central workflow compiler — defaults to the real
   * `compileCentralWorkflowProject` from `@issuepilot/workflow`. Tests
   * pass a fake so they don't have to materialise project / profile
   * files on disk just to spin up a fake team daemon.
   */
  compileCentralWorkflowProject?:
    | CentralWorkflowCompilerLike["compileCentralWorkflowProject"]
    | undefined;
  createServer?: typeof createServer | undefined;
  createLeaseStore?:
    | ((opts: { filePath: string; now?: () => Date }) => LeaseStore)
    | undefined;
  state?: RuntimeState | undefined;
}

/**
 * Derive a deterministic lease file path for a team config. The first 12 chars
 * of the config sha256 keep multiple team daemons (e.g. one for staging, one
 * for production) from clobbering each other's lease state under the shared
 * `~/.issuepilot/state` directory.
 */
function deriveLeaseFilePath(config: TeamConfig): string {
  return path.join(
    os.homedir(),
    ".issuepilot",
    "state",
    `leases-${config.source.sha256.slice(0, 12)}.json`,
  );
}

// V2 team daemon emits events with the shared internal envelope so the SSE
// server hydrates events identically regardless of which entrypoint
// produced them (review M9).
type TeamEvent = IssuePilotInternalEvent;

/**
 * V4.2: build a per-project work-item service for team-mode. The service is
 * intentionally minimal:
 *
 *  - planner: returns a deterministic 503 — team-mode does not yet ship the
 *    planner runner, but we still want the route layer to respond
 *    consistently instead of crashing.
 *  - fetchIssue: stubbed for the same reason; once `Phase 3` lands a real
 *    GitLab adapter under team-mode this will swap in the project's
 *    {@link RegisteredProject.workflow} tracker credentials.
 *  - tick: no-op — team-mode does not auto-poll GitLab and currently does
 *    not dispatch synthetic task runs. V4.3 therefore wires per-project
 *    stores / report lookup only; the evidence scan hook belongs with the
 *    future team dispatch runner once that entrypoint exists.
 *  - reconcileWorkItem: no-op — there is no parent Issue label transition
 *    to run until the GitLab adapter is wired.
 *
 * The store is scoped under the project's own
 * `workspace.root/.issuepilot/` so team daemons never accidentally cross
 * project namespaces.
 */
function buildProjectWorkItemService(
  project: RegisteredProject,
  eventBus: EventBus<TeamEvent>,
  reportStore: ReportStore,
): { service: WorkItemService; store: ReturnType<typeof createWorkItemStore> } {
  const store = createWorkItemStore({
    rootDir: path.join(project.workflow.workspace.root, ".issuepilot"),
  });
  const planner = createWorkItemPlanner({
    callPlannerLlm: async (): Promise<RawPlanResponse | string> => {
      throw new Error(
        "WorkItemPlanner is not configured for team-mode. Phase 3 will wire a per-project planner runner.",
      );
    },
  });
  const service = createWorkItemService({
    store,
    planner,
    fetchIssue: async () => {
      throw new Error(
        `team-mode planFromIssue is not wired yet for project ${project.id}: configure a GitLab adapter`,
      );
    },
    tick: async () => {},
    reconcileWorkItem: async () => {},
    aggregateDeps: {
      getRunReport: (runId) => reportStore.get(runId),
    },
    emit: (event) => {
      eventBus.publish({
        type: event.type,
        ts: event.ts,
        runId: event.runId ?? null,
        detail: { ...event.detail, project: project.id },
      } as unknown as TeamEvent);
    },
  });
  return { service, store };
}

/**
 * Phase 1 team-mode entrypoint: parse the team config, load each enabled
 * project workflow, and bring up the Fastify server with project-aware
 * `/api/state`. No GitLab polling is wired up yet — the goal is to give the
 * dashboard and CLI a stable shell to talk to.
 *
 * V4.2 (Task Graph): team-mode now also wires per-project
 * {@link WorkItemService} instances under `workItemsByProject`. work-items
 * routes are **operator-driven** in team-mode — the daemon does NOT
 * auto-poll GitLab; `planFromIssue` / `acceptPlan` / `dispatch` only run
 * when the dashboard or CLI explicitly triggers them. This matches Phase
 * 1's "stable shell" stance and avoids surprising side effects across
 * projects. See `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-
 * graph.md` §14 for the rationale.
 */
export async function startTeamDaemon(
  options: StartTeamDaemonOptions,
  deps: StartTeamDaemonDeps = {},
): Promise<TeamDaemonHandle> {
  const configPath = path.resolve(options.configPath);
  const loadConfig = deps.loadTeamConfig ?? defaultLoadTeamConfig;
  const createRegistry =
    deps.createProjectRegistry ?? defaultCreateProjectRegistry;
  const createServerImpl = deps.createServer ?? createServer;
  const createLeaseStoreImpl = deps.createLeaseStore ?? defaultCreateLeaseStore;

  const config = await loadConfig(configPath);
  const registry = await createRegistry(
    config,
    deps.compileCentralWorkflowProject
      ? { compileCentralWorkflowProject: deps.compileCentralWorkflowProject }
      : undefined,
  );

  // V2 Phase 5 scope acknowledgement: `retention` is parsed for forward
  // compatibility (team config and V1 workflow front matter share the
  // schema) but the team daemon currently does not run
  // `runWorkspaceCleanupOnce`. Phase 5 ships the cleanup loop on the
  // V1 single-project daemon only; the team-mode wiring is tracked as
  // a follow-up. Emit a single warn at startup so operators don't
  // assume retention is active just because the schema validated.
  console.warn(
    "[issuepilot] V2 team daemon does not yet run workspace cleanup; " +
      "`retention` is parsed but not enforced. Use the V1 single-project " +
      "entrypoint (`issuepilot start --workflow ...`) for automatic " +
      "workspace retention. Tracked in docs/superpowers/specs/2026-05-16-" +
      "issuepilot-v2-phase5-workspace-retention-design.md §4 (follow-up).",
  );
  const state = deps.state ?? createRuntimeState();
  const eventBus: EventBus<TeamEvent> = createEventBus<TeamEvent>();
  const leaseStore = createLeaseStoreImpl({
    filePath: deriveLeaseFilePath(config),
  });

  const host = options.host ?? config.server.host;
  const port = options.port ?? config.server.port;

  // V4.2: assemble per-project work-item services keyed by the project id
  // exposed in `x-issuepilot-project`. Header is required by the server
  // route layer when this map is non-empty; team-mode never falls back to
  // a default service to keep operator actions strictly project-scoped.
  // team-mode work-items routes do NOT auto-poll GitLab — planFromIssue /
  // acceptPlan / dispatch are operator-driven (see daemon.ts header comment
  // and §17 of the design spec).
  const workItemsByProject = new Map<string, WorkItemService>();
  const reportsByProject = new Map<string, ReportStore>();
  const qualityByProject = new Map<string, QualityCollectorDeps>();
  const improvementsByProject = new Map<
    string,
    ReturnType<typeof createImprovementService>
  >();
  /**
   * V4.6 Multi-Agent Pipeline: per-project pipeline service. Mirrors the
   * single-daemon path — stores live under each project's own
   * `<workspace.root>/.issuepilot/{pipelines,agent-reports}/...` so team
   * isolation extends here too. Coordinator agents are deterministic stubs
   * until Phase 5-7 wiring lands per project; routes that don't execute an
   * agent (get / list / setRecipeOverride / skip / revoke-ai-review /
   * validateWorkflowRoles) work fully end-to-end.
   */
  const pipelinesByProject = new Map<string, PipelineService>();
  for (const project of registry.enabledProjects()) {
    const reportStore = createReportStore({
      rootDir: path.join(project.workflow.workspace.root, ".issuepilot"),
    });
    reportsByProject.set(project.id, reportStore);
    const { service: workItemService, store: workItemStore } =
      buildProjectWorkItemService(project, eventBus, reportStore);
    workItemsByProject.set(project.id, workItemService);
    qualityByProject.set(project.id, {
      metadata: {
        workflow: path.basename(
          project.workflowProfilePath,
          path.extname(project.workflowProfilePath),
        ),
      },
      reports: reportStore,
      workItems: workItemStore,
    });
    // V4.5 Improvement Loop: per-project recommendation store rooted under
    // the project workspace so support tarballs and team-mode isolation
    // both align with the existing reports / work-items layout. Patch
    // previews remain inert; the daemon never writes the suggested change
    // back to the project tree.
    const improvementStore = createImprovementStore({
      rootDir: path.join(project.workflow.workspace.root, ".issuepilot"),
    });
    const qualityDeps = qualityByProject.get(project.id)!;
    const projectId = project.id;
    // Patch preview sandbox per project: only allow reads under the project
    // workspace root or the project's compiled workflow file. Team-mode
    // isolation extends here too — one project's recommendation can never
    // read another project's tree.
    const improvementSandbox = [
      path.resolve(project.workflowProfilePath),
      path.resolve(project.workflow.workspace.root),
    ];
    // V4.6 per-project pipeline service. We bail (with a friendly log)
    // when the project workflow is missing the V4.6 `default_recipe` /
    // `roles` sections so the daemon stays bootable against test fixtures
    // and V4.5 workflows that have not been migrated yet (spec §10 +
    // plan Task 9.3 "missing config → friendly log").
    const projectDefaultRecipe = project.workflow.defaultRecipe;
    const projectRoles = project.workflow.roles;
    // V4.6 review fix C4：把 pipelineStore 提到 if-block 外，让本 project
    // 的 buildQualitySummary callback 在未启用 V4.6 时仍保持 undefined（行
    // 为不变），启用 V4.6 时拿到本 project 隔离的 pipelineStore（不会混
    // 用其他 project 的 AgentReport）。
    let pipelineStore: PipelineStore | undefined;
    if (projectDefaultRecipe && projectRoles) {
      pipelineStore = createPipelineStore({
        root: path.join(project.workflow.workspace.root, ".issuepilot"),
      });
      const pipelineAgents: CoordinatorAgents = {
        coder: {
          async run() {
            throw new CoordinatorError(
              "V4.6 coder agent runner is not wired on team-mode yet",
              "agent_not_configured",
            );
          },
        },
        reviewer: {
          async run() {
            throw new CoordinatorError(
              "V4.6 reviewer agent runner is not wired on team-mode yet",
              "agent_not_configured",
            );
          },
        },
        testEvidence: {
          async run() {
            throw new CoordinatorError(
              "V4.6 test_evidence agent runner is not wired on team-mode yet",
              "agent_not_configured",
            );
          },
        },
      };
      const pipelineRoleProfileResolver: RoleProfileResolver = {
        async resolveRoleProfile() {
          return null;
        },
      };
      const pipelineCoordinator = createCoordinator({
        pipelineStore,
        agents: pipelineAgents,
        roleProfileResolver: pipelineRoleProfileResolver,
        taskWriter: {
          updateTask: async ({ workItemId, taskId, patch }) => {
            const plan = await workItemStore.getCurrentPlan(workItemId);
            if (!plan) return;
            const nextTasks = plan.tasks.map((t) =>
              t.taskId === taskId ? ({ ...t, ...patch } as typeof t) : t,
            );
            await workItemStore.saveTaskPlan({ ...plan, tasks: nextTasks });
          },
        },
      });
      pipelinesByProject.set(
        project.id,
        createPipelineService({
          pipelineStore,
          coordinator: pipelineCoordinator,
          workItems: {
            getWorkItem: (id) => workItemStore.getWorkItem(id),
            getTask: async ({ workItemId, taskId }) => {
              const plan = await workItemStore.getCurrentPlan(workItemId);
              return plan?.tasks.find((t) => t.taskId === taskId);
            },
            updateTask: async ({ workItemId, taskId, patch }) => {
              const plan = await workItemStore.getCurrentPlan(workItemId);
              if (!plan) return;
              const nextTasks = plan.tasks.map((t) =>
                t.taskId === taskId ? ({ ...t, ...patch } as typeof t) : t,
              );
              await workItemStore.saveTaskPlan({ ...plan, tasks: nextTasks });
            },
          },
          workflow: {
            getDefaultRecipe: () => projectDefaultRecipe,
            getRoles: () => projectRoles,
          },
        }),
      );
    } else {
      console.warn(
        `[issuepilot] V4.6 pipeline service skipped for project ${project.id}: workflow is missing default_recipe or roles. Update the workflow YAML to enable /api/work-items/.../pipeline endpoints (spec §10).`,
      );
    }
    improvementsByProject.set(
      project.id,
      createImprovementService({
        store: improvementStore,
        allowedPathPrefixes: improvementSandbox,
        resolveTargetPath: ({ template }) => {
          switch (template.targetKind) {
            case "workflow_front_matter":
              return project.workflowProfilePath;
            case "project_rules":
              return path.join(project.workflow.workspace.root, "AGENTS.md");
            default:
              return undefined;
          }
        },
        // V4.6 review fix C4：team 模式下每个 project 一份独立的
        // pipelineStore；通过 buildPipelineQualitySummary helper 把本
        // project 的 AgentReport 喂给 buildQualitySummary，让 dashboard
        // 的 byRole 切片在 team 模式同样可见，且不混库（spec §9 / §17.4）。
        buildQualitySummary: buildPipelineQualitySummary({
          pipelineStore,
          collectorDeps: qualityDeps,
          scope: { mode: "team-project", projectId },
        }),
      }),
    );
  }

  const app = await createServerImpl(
    {
      state,
      eventBus,
      workflowPath: config.source.path,
      gitlabProject: "team",
      handoffLabel: "human-review",
      pollIntervalMs: config.scheduler.pollIntervalMs,
      concurrency: config.scheduler.maxConcurrentRuns,
      // Evaluate runtime/projects on every `/api/state` request so dashboard
      // counters reflect current lease and poll state instead of a snapshot
      // captured at daemon start (V2 review C5/C6).
      runtime: () => ({
        mode: "team",
        maxConcurrentRuns: config.scheduler.maxConcurrentRuns,
        activeLeases: leaseStore.activeCount(),
        projectCount: registry.summaries().length,
      }),
      projects: () => registry.summaries(),
      readEvents: async () => [],
      readLogsTail: async () => [],
      workItemsByProject,
      reportsByProject,
      qualityByProject,
      improvementsByProject,
      pipelinesByProject,
    },
    { host, port },
  );

  const address = app.server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : port;

  let stopped: Promise<void> | null = null;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  // Install signal handlers so Ctrl-C and `kill <pid>` resolve `wait()` and
  // close Fastify gracefully. Without these the CLI's `await handle.wait()`
  // would hang until the test/smoke harness's hard SIGKILL kicked in.
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const stop = (): Promise<void> => {
    if (!stopped) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      stopped = app.close().then(() => {
        resolveWait?.();
      });
    }
    return stopped;
  };

  return {
    host,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    stop,
    async wait() {
      await waitPromise;
    },
  };
}
