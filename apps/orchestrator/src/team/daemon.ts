import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

import { createEventBus, type EventBus } from "@issuepilot/observability";
import type {
  CoderAgentReport,
  IssuePilotInternalEvent,
  ReviewerAgentReport,
  TaskNode,
  TestEvidenceAgentReport,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { slugify } from "@issuepilot/workspace";

import { createCoderAgent } from "../agents/coder.js";
import {
  createCoderLifecycle,
  createReviewerLifecycle,
} from "../agents/codex-lifecycle.js";
import { createReviewerAgent } from "../agents/reviewer.js";
import { createImprovementService } from "../improvements/service.js";
import { createImprovementStore } from "../improvements/store.js";
import {
  CoordinatorError,
  createCoordinator,
  type CoordinatorAgents,
  type RoleProfileResolver,
} from "../pipelines/coordinator.js";
import {
  buildRoleProfile,
  type CoderRoleProfile,
  type ReviewerRoleProfile,
} from "../pipelines/role-profile.js";
import {
  createPipelineService,
  type PipelineService,
} from "../pipelines/service.js";
import {
  createPipelineStore,
  type PipelineStore,
} from "../pipelines/store.js";
import type { QualityCollectorDeps } from "../quality/collect.js";
import { createPipelineQualitySummaryCallback } from "../quality/pipeline-summary.js";
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
  /**
   * V4.6 review follow-up (Issue 1)：per-project `PipelineStore` 的反向
   * 索引，专供 `GET /api/quality/summary` 路由按 `x-issuepilot-project`
   * 解析对应 store 用。与 `pipelinesByProject` 同一套 project id，
   * 严格 per-project 不混库；未启用 V4.6 的 project 不出现在 map 中，
   * 该 project 的 byRole 切片保持 undefined。
   */
  const pipelineStoreByProject = new Map<string, PipelineStore>();
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
    // V4.6 review follow-up (Issue 1)：pipelineStore 同时被两条路径消费：
    //   1) improvement service 的 buildQualitySummary callback（本地循环）。
    //   2) `GET /api/quality/summary` HTTP 路由（dashboard ByRolePanel）。
    // 因此提到 if-block 外保留 undefined / 实例两种状态，并把启用 V4.6 的
    // project 加入 `pipelineStoreByProject` 让 server 路由能按 project
    // 解析对应 store，严格不跨 project 混库。
    let pipelineStore: PipelineStore | undefined;
    if (projectDefaultRecipe && projectRoles) {
      pipelineStore = createPipelineStore({
        root: path.join(project.workflow.workspace.root, ".issuepilot"),
      });
      pipelineStoreByProject.set(project.id, pipelineStore);
      /**
       * V4.6 follow-up Task 4b (review C1 part 2/3) — 镜像单 daemon 的
       * coder + reviewer wiring。Codex 进程通过
       * `@issuepilot/runner-codex-app-server` 的 `spawnRpc + driveLifecycle`
       * 真正起来；`cwd` 锚到 V4.5 `ensureWorktree` 的实际 layout
       * (`<workspace.root>/<projectSlug>/<issueIid>`，见
       * `packages/workspace/src/worktree.ts:204`)。V4.6 pipeline 自己暂时
       * 还没接 ensureMirror / ensureWorktree —— 那仍是 V4.5 dispatch path
       * 的职责。所以当 issue 还没在 V4.5 路径上跑过时，这里的 cwd 不存
       * 在，Codex spawn / driveLifecycle 会让 lifecycle adapter 抛错；
       * 上游 agent factory 把它翻成 `runner_unavailable`/`coding_failed`
       * 写入 AgentReport（spec §16.2 row 4），dashboard 看到失败而非
       * daemon 崩。把 worktree 主动 ensure 进 V4.6 pipeline 是 V4.7 范围。
       */
      const projectWorkflow = project.workflow;
      const codexCwdFor = (workItem: WorkItem): string =>
        path.join(
          projectWorkflow.workspace.root,
          slugify(projectWorkflow.tracker.projectId),
          String(workItem.sourceIssue.iid),
        );
      const threadNameFor = ({
        workItem,
        task,
        role,
      }: {
        workItem: WorkItem;
        task: TaskNode;
        role: "coder" | "reviewer" | "test_evidence";
      }): string =>
        `${projectWorkflow.tracker.projectId}#${workItem.sourceIssue.iid}/${task.taskId}/${role}`;
      const publishLifecycleEvent = (input: {
        type: string;
        runId: string;
        data: unknown;
      }): void => {
        const ts = new Date().toISOString();
        eventBus.publish({
          id: randomUUID(),
          runId: input.runId,
          type: input.type,
          message: input.type,
          createdAt: ts,
          ts,
          data: input.data,
          detail: { project: project.id, data: input.data },
        } as unknown as TeamEvent);
      };
      const coderLifecycle = createCoderLifecycle({
        codex: projectWorkflow.codex,
        maxTurns: projectWorkflow.agent.maxTurns,
        threadName: threadNameFor,
        onEvent: (type, data) =>
          publishLifecycleEvent({
            type: `codex_v46_coder_${type}`,
            runId: "pipeline-coder",
            data,
          }),
      });
      const reviewerLifecycle = createReviewerLifecycle({
        codex: projectWorkflow.codex,
        maxTurns: projectWorkflow.agent.maxTurns,
        threadName: threadNameFor,
        onEvent: (type, data) =>
          publishLifecycleEvent({
            type: `codex_v46_reviewer_${type}`,
            runId: "pipeline-reviewer",
            data,
          }),
      });
      const coderAgent = createCoderAgent({ lifecycle: coderLifecycle });
      const reviewerAgent = createReviewerAgent({
        lifecycle: reviewerLifecycle,
      });
      /**
       * V4.6 follow-up Task 4b — reviewer publisher 故意不注入到
       * CoordinatorAgents：`publishReviewerToMr` 需要 `MrRef` 携带
       * `{iid, baseSha, startSha, headSha}`，但当前 GitLab adapter 的
       * `getMergeRequest` 只暴露 `{iid, webUrl, state}`，缺 diff_refs。
       * 扩展 tracker-gitlab `MergeRequestSummary` 是跨 package 改动，
       * 不在本次 critical-fix 范围内。在 publisher 接通之前 coordinator
       * 仍能跑：reviewer 报告正常落盘，`mrPublication` 保持 agent 初始
       * 值（`pending` / `skipped_by_config`），dashboard 也能显示。
       * Tracking：docs/superpowers/specs/2026-05-11-issuepilot-design.md §12
       */
      const pipelineAgents: CoordinatorAgents = {
        coder: {
          async run(input): Promise<
            | { kind: "report"; report: CoderAgentReport }
            | { kind: "cancelled"; cancelledAt: string }
          > {
            if (input.profile.role !== "coder") {
              throw new CoordinatorError(
                `coder agent received non-coder profile: ${input.profile.role}`,
                "role_profile_invalid",
              );
            }
            const coderProfile: CoderRoleProfile = input.profile;
            return coderAgent.run({
              workItem: input.workItem,
              task: input.task,
              pipelineRun: { pipelineRunId: input.pipelineRun.pipelineRunId },
              profile: coderProfile,
              cwd: codexCwdFor(input.workItem),
            });
          },
        },
        reviewer: {
          async run(input): Promise<
            | { kind: "report"; report: ReviewerAgentReport }
            | { kind: "cancelled"; cancelledAt: string }
          > {
            if (input.profile.role !== "reviewer") {
              throw new CoordinatorError(
                `reviewer agent received non-reviewer profile: ${input.profile.role}`,
                "role_profile_invalid",
              );
            }
            const reviewerProfile: ReviewerRoleProfile = input.profile;
            return reviewerAgent.run({
              workItem: input.workItem,
              task: input.task,
              pipelineRun: { pipelineRunId: input.pipelineRun.pipelineRunId },
              profile: reviewerProfile,
              cwd: codexCwdFor(input.workItem),
            });
          },
        },
        testEvidence: {
          // Task 4c 会接 test_evidence agent；本次仍保留 typed stub。
          async run(): Promise<
            | { kind: "report"; report: TestEvidenceAgentReport }
            | { kind: "cancelled"; cancelledAt: string }
          > {
            throw new CoordinatorError(
              "V4.6 test_evidence agent runner is not wired on team-mode yet",
              "agent_not_configured",
            );
          },
        },
      };
      const pipelineRoleProfileResolver: RoleProfileResolver = {
        async resolveRoleProfile(role, { workItem, task }) {
          const cfg = projectRoles[role];
          if (!cfg) return null;
          return buildRoleProfile({
            role: cfg,
            workItem: {
              id: workItem.workItemId,
              iid: workItem.sourceIssue.iid,
              title: workItem.title,
              ...(workItem.goal ? { description: workItem.goal } : {}),
            },
            task: {
              id: task.taskId,
              title: task.title,
              ...(task.goal ? { description: task.goal } : {}),
            },
          });
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
      // V4.6 fix C3：mirror 单 daemon 的撤销 callback wiring。team-mode
      // 当前还没有 per-project GitLab adapter（参考 `buildProjectWorkItemService`
      // 里的 fetchIssue stub），所以 callback 抛 typed error，把缺口显式
      // 暴露给 dashboard / 测试，而不是让 service 静默把本地 mrPublication.
      // status 翻成 "revoked" 却没删 GitLab note —— spec §12 的契约失败必须
      // 是 5xx 而非 200。Phase X 真正把 team-mode 接通 GitLab 后再换成
      // 单 daemon 同款 adapter callback。
      const projectIdForCallback = project.id;
      const teamPipelineRevokeCallback = async (input: {
        agentReportId: string;
        noteIds: string[];
        operator?: string;
      }): Promise<{ revokedAt: string }> => {
        void input;
        throw new Error(
          `team-mode revokeReviewerMrComments not wired for project ${projectIdForCallback}: per-project GitLab adapter is not configured yet (see team/daemon.ts).`,
        );
      };
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
          revokeReviewerMrComments: teamPipelineRevokeCallback,
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
        // V4.6 review follow-up (Issue 1)：improvement service 的
        // buildQualitySummary callback 与 `GET /api/quality/summary` 路由
        // 共享同一份 `createPipelineQualitySummaryCallback` /
        // `buildPipelineQualitySummary` 实现（见
        // `apps/orchestrator/src/quality/pipeline-summary.ts`），保证 byRole
        // 切片在两条路径上语义一致。team 模式下 pipelineStore 与
        // qualityDeps 都是 per-project 实例，严格不跨 project 混库
        // （spec §9 / §17.4）。
        buildQualitySummary: createPipelineQualitySummaryCallback({
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
      // V4.6 review follow-up (Issue 1)：team 模式下把 per-project
      // pipelineStore 透给 /api/quality/summary 路由，让 dashboard
      // ByRolePanel 按 `x-issuepilot-project` 解析对应 project 的 byRole
      // 切片，严格不跨 project 混库。未启用 V4.6 的 project 不在 map 中，
      // 该 project 的 byRole 切片保持 undefined。
      pipelineStoreByProject,
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
