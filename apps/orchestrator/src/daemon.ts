import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  createCredentialResolver,
  createCredentialsStore,
  type CredentialResolver,
  type CredentialsStore,
} from "@issuepilot/credentials";
import {
  createBatchedEventStore,
  createEventBus,
  createEventStore,
  redact,
  type BatchedEventStore,
  type EventBus,
} from "@issuepilot/observability";
import {
  createGitLabTools,
  driveLifecycle,
  spawnRpc,
} from "@issuepilot/runner-codex-app-server";
import type {
  CoderAgentReport,
  IssuePilotInternalEvent,
  ReviewerAgentReport,
  RunReportArtifact,
  RunnerEvent,
  RunnerRunInput,
  TaskNode,
  TestEvidenceAgentReport,
  WorkItem,
  WorkflowRecipe,
} from "@issuepilot/shared-contracts";
import {
  createGitLabAdapter,
  createGitLabAdapterFromCredential,
  type GitLabAdapter,
  type GitLabAdapterHandle,
  type GitLabApi,
  type GitLabClient,
} from "@issuepilot/tracker-gitlab";
import {
  createWorkflowLoader,
  type PromptContext,
  type WorkflowConfig,
  type WorkflowLoader,
} from "@issuepilot/workflow";
import {
  branchName,
  ensureMirror,
  ensureWorktree,
  runHook,
  slugify,
} from "@issuepilot/workspace";
import { execa } from "execa";

import { createCoderAgent } from "./agents/coder.js";
import { collectorsForTask } from "./agents/evidence-collectors.js";
import { createReviewerAgent } from "./agents/reviewer.js";
import { createTestEvidenceAgent } from "./agents/test-evidence.js";
import { splitCommand } from "./codex/split-command.js";
import {
  publishReviewerToMr,
  revokeReviewerMrComments as revokeReviewerMrCommentsHelper,
} from "./gitlab/mr-comments.js";
import { createImprovementService } from "./improvements/service.js";
import { createImprovementStore } from "./improvements/store.js";
import { runWorkspaceCleanupOnce } from "./maintenance/workspace-cleanup.js";
import {
  archiveRun,
  retryRun,
  stopRun,
  type OperatorActionDeps,
  type OperatorActionInput,
} from "./operations/actions.js";
import { scanCiFeedbackOnce } from "./orchestrator/ci-feedback.js";
import { claimCandidates } from "./orchestrator/claim.js";
import { classifyError, type Classification } from "./orchestrator/classify.js";
import { dispatch } from "./orchestrator/dispatch.js";
import {
  reconcileHumanReview,
  type HumanReviewEvent,
} from "./orchestrator/human-review.js";
import { startLoop } from "./orchestrator/loop.js";
import {
  mergeAgentHandoffIntoReport,
  reconcile,
} from "./orchestrator/reconcile.js";
import { sweepReviewFeedbackOnce } from "./orchestrator/review-feedback.js";
import {
  CoordinatorError,
  createCoordinator,
  type Coordinator,
  type CoordinatorAgents,
  type RoleProfileResolver,
} from "./pipelines/coordinator.js";
import {
  buildPipelineRunReport,
  taskStatusFromPipelineStatus,
} from "./pipelines/report-artifact.js";
import {
  buildRoleProfile,
  type CoderRoleProfile,
  type ReviewerRoleProfile,
  type TestEvidenceRoleProfile,
} from "./pipelines/role-profile.js";
import { createPipelineService } from "./pipelines/service.js";
import { createPipelineStore, type PipelineStore } from "./pipelines/store.js";
import { createPipelineQualitySummaryCallback } from "./quality/pipeline-summary.js";
import { createInitialReport, markReportFailed } from "./reports/lifecycle.js";
import { renderFailureNote } from "./reports/render.js";
import { createReportStore } from "./reports/store.js";
import { createClaudeCodeAdapter } from "./runners/claude-code.js";
import { createCodexAppServerAdapter } from "./runners/codex-app-server.js";
import { createRunnerRegistry } from "./runners/registry.js";
import type { RunnerAdapter, RunnerEventSink } from "./runners/types.js";
import { createRunCancelRegistry } from "./runtime/run-cancel-registry.js";
import { createConcurrencySlots } from "./runtime/slots.js";
import { createRuntimeState, type RuntimeState } from "./runtime/state.js";
import { createServer, type WorkItemService } from "./server/index.js";
import { aggregateWorkItem } from "./work-items/aggregate.js";
import { decideEffectiveBase } from "./work-items/branch-chain.js";
import { runTaskOnce } from "./work-items/dispatch-task.js";
import {
  appendOversizedFollowUps,
  mergeReportEvidence,
} from "./work-items/evidence-merge.js";
import { scanRunEvidence } from "./work-items/evidence-scanner.js";
import { writeParentHandoff } from "./work-items/handoff.js";
import {
  createWorkItemPlanner,
  type RawPlanResponse,
  type WorkItemPlanner,
} from "./work-items/planner.js";
import {
  createWorkItemService,
  decideWorkItemStatus,
  settleTaskRunFinal,
  tickWorkItem as tickWorkItemImpl,
} from "./work-items/service.js";
import { createWorkItemStore } from "./work-items/store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4738;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const HUMAN_REVIEW_SCAN_RUN_ID = "human-review-scan";

// V1 daemon always fills the issue context (every event flows through a
// claim/run pair). We narrow `issue` from optional in the shared contract to
// required here, which keeps existing callers type-safe without forking the
// type tree (review M9). V2 team daemon uses the shared type as-is.
type OrchestratorEvent = IssuePilotInternalEvent & {
  issue: NonNullable<IssuePilotInternalEvent["issue"]>;
  data: unknown;
};

export interface DaemonHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly state: RuntimeState;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface StartDaemonOptions {
  workflowPath: string;
  host?: string | undefined;
  port?: number | undefined;
}

export interface StartDaemonDeps {
  workflowLoader?: WorkflowLoader | undefined;
  createGitLab?:
    | ((cfg: WorkflowConfig) => GitLabAdapter | Promise<GitLabAdapter>)
    | undefined;
  /**
   * Override credential resolution. When omitted, the daemon assembles its
   * own resolver backed by the on-disk credentials store and the env var
   * named in `tracker.token_env` (if any). Tests inject a fake resolver to
   * skip both fs and HTTP.
   */
  credentialResolver?: CredentialResolver | undefined;
  /** Override the on-disk credentials store (mostly useful for tests). */
  credentialsStore?: CredentialsStore | undefined;
  createServer?: typeof createServer | undefined;
  startLoop?: typeof startLoop | undefined;
  state?: RuntimeState | undefined;
  eventBus?: EventBus<OrchestratorEvent> | undefined;
  /**
   * V4.1 Workflow Spine: override the planner to skip the real Codex
   * call. Tests inject a fake that returns a deterministic plan; in
   * production we fall back to a Codex-backed planner spawned with a
   * single-turn JSON prompt.
   */
  workItemPlanner?: WorkItemPlanner | undefined;
}

function runKey(
  cfg: WorkflowConfig,
  issueIid: number,
): {
  projectSlug: string;
  issueIid: number;
} {
  return {
    projectSlug: slugify(cfg.tracker.projectId),
    issueIid,
  };
}

/**
 * Extract a bare hostname from `tracker.baseUrl`. The credentials store
 * keys entries by hostname, so reusing the URL parser keeps that mapping
 * deterministic instead of leaking trailing slashes / paths into the
 * credentials file.
 */
export function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

function toEventRecord(event: {
  type: string;
  runId: string;
  ts: string;
  detail: Record<string, unknown>;
  issue: OrchestratorEvent["issue"];
}): OrchestratorEvent {
  const redactedDetail = redact(event.detail);
  const detail =
    redactedDetail &&
    typeof redactedDetail === "object" &&
    !Array.isArray(redactedDetail)
      ? (redactedDetail as Record<string, unknown>)
      : {};
  const { issue: _issue, data: nestedData, ...topLevelDetail } = detail;
  const data = Object.prototype.hasOwnProperty.call(detail, "data")
    ? nestedData
    : detail;
  return {
    ...topLevelDetail,
    id: randomUUID(),
    runId: event.runId,
    issue: event.issue,
    type: event.type,
    message: event.type,
    createdAt: event.ts,
    ts: event.ts,
    data,
  };
}

function eventIssueFromUnknown(
  value: unknown,
): OrchestratorEvent["issue"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const issue = value as Record<string, unknown>;
  if (
    typeof issue["id"] !== "string" ||
    typeof issue["iid"] !== "number" ||
    typeof issue["title"] !== "string" ||
    typeof issue["url"] !== "string" ||
    typeof issue["projectId"] !== "string"
  ) {
    return undefined;
  }
  return {
    id: issue["id"],
    iid: issue["iid"],
    title: issue["title"],
    url: issue["url"],
    projectId: issue["projectId"],
  };
}

function fallbackEventIssue(
  projectId: string,
  issueIid: number,
): OrchestratorEvent["issue"] {
  return {
    id: String(issueIid),
    iid: issueIid,
    title: issueIid > 0 ? `Issue #${issueIid}` : "IssuePilot scan",
    url: "",
    projectId,
  };
}

/**
 * Mirror the terminal label set we just observed in
 * `reconcileHumanReview` back onto every RunRecord for the issue, and
 * stamp `endedAt` on those runs so downstream scanners (V2 Phase 3 CI
 * feedback, V2 Phase 4 review sweep) know the run has left the
 * human-review loop and should stop being polled for pipelines / MR
 * notes.
 *
 * We only act on the two events that actually retire the issue from
 * `human-review`:
 *
 *   - `human_review_issue_closed` — MR was merged and IssuePilot
 *     removed `human-review` and closed the GitLab Issue.
 *   - `human_review_rework_requested` — MR was closed without merging
 *     and labels flipped to `ai-rework`. The next claim will spawn a
 *     fresh run; the current one is done.
 *
 * `human_review_mr_still_open` is *not* terminal: the reviewer is still
 * looking at the MR and the scanner should keep polling pipelines so
 * CI failures recycle the issue automatically (spec §9). Same with
 * `human_review_mr_missing` — that's a diagnostic, not a terminal.
 */
export function syncHumanReviewFinalLabels(
  state: RuntimeState,
  event: HumanReviewEvent,
): void {
  if (
    event.type !== "human_review_issue_closed" &&
    event.type !== "human_review_rework_requested"
  ) {
    return;
  }
  if (event.issueIid <= 0 || !Array.isArray(event.detail["labels"])) return;

  const labels = event.detail["labels"];
  if (!labels.every((label): label is string => typeof label === "string")) {
    return;
  }

  const endedAt = event.ts;

  for (const run of state.allRuns()) {
    const issue = run["issue"];
    if (
      typeof issue !== "object" ||
      issue === null ||
      !("iid" in issue) ||
      Number((issue as { iid: unknown }).iid) !== event.issueIid
    ) {
      continue;
    }

    state.setRun(run.runId, {
      ...run,
      issue: {
        ...issue,
        labels: [...labels],
      },
      // Only stamp endedAt once; preserve the earliest observation in
      // case a later poll re-emits the terminal event (defensive).
      endedAt: typeof run["endedAt"] === "string" ? run["endedAt"] : endedAt,
    });
  }
}

/**
 * V4.6 follow-up Task 4b：`splitCommand` 已经迁出到
 * `./codex/split-command.ts`，避免 `agents/codex-lifecycle.ts` 通过
 * `daemon.ts` 产生函数级循环引用。这里 re-export 一份保留向后兼容
 * （`index.ts` / 测试仍按 `daemon.ts` 入口 import）。
 */
export { splitCommand } from "./codex/split-command.js";

async function hasNewCommits(
  cwd: string,
  baseBranch: string,
): Promise<boolean> {
  const result = await execa("git", [
    "-C",
    cwd,
    "rev-list",
    "--count",
    `${baseBranch}..HEAD`,
  ]);
  return Number(result.stdout.trim()) > 0;
}

async function pushBranch(cwd: string, branch: string): Promise<void> {
  await execa("git", ["-C", cwd, "push", "-u", "origin", branch]);
}

async function createFailureNote(
  gitlab: GitLabAdapter,
  iid: number,
  input: {
    runId: string;
    branch: string;
    classification: Classification;
    attempt: number;
    statusLabel: string;
    readyLabel: string;
  },
): Promise<void> {
  const title =
    input.classification.kind === "blocked"
      ? "IssuePilot run blocked"
      : "IssuePilot run failed";
  await gitlab.createIssueNote(
    iid,
    [
      `## ${title}`,
      "",
      `- Status: ${input.statusLabel}`,
      `- Run: \`${input.runId}\``,
      `- Attempt: ${input.attempt}`,
      `- Branch: \`${input.branch}\``,
      "",
      "### Reason",
      input.classification.reason,
      "",
      "### Next action",
      `Address the reason above, then move this Issue back to \`${input.readyLabel}\`.`,
    ].join("\n"),
  );
}

function readyLabel(workflow: WorkflowConfig): string {
  return workflow.tracker.activeLabels[0] ?? "ai-ready";
}

/**
 * Default planner used when no override is supplied. The real
 * single-workflow daemon currently does not run a Codex single-turn
 * planner directly (that would require its own RPC handle and a
 * stable JSON contract); we keep the surface present but fail
 * deterministically with `planner_call_failed` so the V4.1 HTTP
 * routes still return a structured 500 to dashboards instead of
 * crashing the process. Tests inject a real fake planner via
 * `deps.workItemPlanner`.
 *
 * Spec §7.V4.1 calls this out explicitly: the planner Codex contract
 * lands later in V4.2 once the planner-prompt template stabilises.
 */
function createDefaultWorkItemPlanner(): WorkItemPlanner {
  return createWorkItemPlanner({
    callPlannerLlm: async (): Promise<RawPlanResponse | string> => {
      throw new Error(
        "WorkItemPlanner is not configured for this workflow. Provide deps.workItemPlanner or configure a planner runner.",
      );
    },
  });
}

async function readLogTail(logFile: string, limit = 200): Promise<string[]> {
  try {
    const content = await fs.readFile(logFile, "utf-8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((line) => String(redact(line)));
  } catch {
    return [];
  }
}

export async function startDaemon(
  options: StartDaemonOptions,
  deps: StartDaemonDeps = {},
): Promise<DaemonHandle> {
  const workflowPath = path.resolve(options.workflowPath);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const workflowLoader = deps.workflowLoader ?? createWorkflowLoader();
  let workflow = await workflowLoader.loadOnce(workflowPath);

  const state = deps.state ?? createRuntimeState();
  const slots = createConcurrencySlots(workflow.agent.maxConcurrentAgents);
  const eventBus = deps.eventBus ?? createEventBus<OrchestratorEvent>();
  // V4.7 review N-2 修复:B1 修好之后 lifecycle 流式事件第一次真的能进
  // event store,一次 Codex 多 turn run 可能在几秒内产生上百条 RunnerEvent。
  // 用 `createBatchedEventStore` 包一层 in-memory 缓冲,把同一
  // `(projectSlug, issueIid)` 的多次 append 在 250ms 内 / 50 条以内合并到
  // 单次 fs.appendFile,减少 syscall amplification;read-after-write 语义
  // 由包装层在 read 前 flush 匹配 key 保证。
  const eventStoreDir = path.join(
    workflow.workspace.root,
    ".issuepilot",
    "events",
  );
  const baseEventStore = createEventStore(eventStoreDir);
  const eventStore: BatchedEventStore = createBatchedEventStore(
    baseEventStore,
    eventStoreDir,
  );
  // V2.5 Command Center: report artifacts live next to events under the
  // workspace's `.issuepilot/` so a single tarball captures both the audit
  // log and the per-run report state for support hand-off.
  const reportStore = createReportStore({
    rootDir: path.join(workflow.workspace.root, ".issuepilot"),
  });
  // V4.1 Workflow Spine: WorkItem / TaskPlan / TaskRunLink artifacts live
  // alongside reports under `.issuepilot/` so support tarballs capture
  // them too. The planner uses a default "we cannot run Codex from here"
  // fallback so single-workflow daemons that do not opt in still expose
  // the V4.1 routes (returning planner_failed) instead of crashing.
  const workItemStore = createWorkItemStore({
    rootDir: path.join(workflow.workspace.root, ".issuepilot"),
  });
  // V4.5 Improvement Loop: recommendations live alongside reports and work
  // items so support tarballs capture the operator review trail. The store
  // is lazy on disk so a daemon that never runs Improvement actions still
  // exposes the routes (returning empty lists) without polluting the
  // workspace tree.
  const improvementStore = createImprovementStore({
    rootDir: path.join(workflow.workspace.root, ".issuepilot"),
  });
  // Patch preview sandbox: only read files inside the workflow file itself or
  // anywhere under the workflow workspace root (where project rules, prompt
  // templates and skill instructions live). Keeps a malicious / tampered
  // recommendation.json from getting the orchestrator to read credentials.
  const improvementSandbox = [
    workflowPath,
    path.resolve(workflow.workspace.root),
  ];
  /**
   * Resolve GitLab credentials before the V4.6 pipeline service / loop start
   * taking traffic. The order is:
   *
   *   1. Test seam (`deps.createGitLab`) — kept for the existing in-memory
   *      e2e tests that drive the daemon entirely with fakes.
   *   2. Credential resolver (env var or `~/.issuepilot/credentials`) →
   *      adapter that knows how to refresh on 401.
   *
   * Failing fast here is intentional: spec §17 says the daemon should
   * refuse to start when neither credential source is available, with a
   * pointer at `issuepilot auth login`.
   *
   * V4.6 fix C3: this block is hoisted above the V4.6 pipeline assembly so
   * the reviewer-revoke callback (`revokeReviewerMrComments`) can close
   * over `gitlab` synchronously. Real production factories return a
   * `GitLabAdapterHandle` (with `.client`); the legacy `deps.createGitLab`
   * test seam may return a bare `GitLabAdapter` without `.client`, in
   * which case the callback throws on invocation — never silently.
   */
  let gitlab: GitLabAdapter;
  if (deps.createGitLab) {
    gitlab = await deps.createGitLab(workflow);
  } else {
    const hostname = hostnameFromBaseUrl(workflow.tracker.baseUrl);
    const resolver =
      deps.credentialResolver ??
      createCredentialResolver({
        store: deps.credentialsStore ?? createCredentialsStore(),
      });
    let credential;
    try {
      const resolveInput: { hostname: string; trackerTokenEnv?: string } = {
        hostname,
      };
      if (workflow.tracker.tokenEnv) {
        resolveInput.trackerTokenEnv = workflow.tracker.tokenEnv;
      }
      credential = await resolver.resolve(resolveInput);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to resolve GitLab credentials for ${hostname}: ${message}`,
      );
    }
    if (credential.source === "env" && workflow.tracker.tokenEnv) {
      // Preserve the existing fast path so the synchronous sandbox-friendly
      // adapter is used when callers still rely on `tracker.token_env`.
      gitlab = createGitLabAdapter({
        baseUrl: workflow.tracker.baseUrl,
        projectId: workflow.tracker.projectId,
        tokenEnv: workflow.tracker.tokenEnv,
      });
    } else {
      gitlab = createGitLabAdapterFromCredential({
        baseUrl: workflow.tracker.baseUrl,
        projectId: workflow.tracker.projectId,
        credential,
      });
    }
  }
  /**
   * V4.6 Multi-Agent Pipeline: pipeline + agent-report artifacts live under
   * `<workspace.root>/.issuepilot/{pipelines,agent-reports}/...`. The store
   * is lazy on disk so a daemon that never runs a V4.6 pipeline still
   * exposes the routes (returning empty lists) without writing anything.
   *
   * Phase 9 Task 9.3: build a `Coordinator` with conservative agent
   * stubs so the routes are reachable end-to-end. Real coder / reviewer /
   * test_evidence agent runners land via Phase 5-7 wiring in a subsequent
   * change; for now we surface a deterministic `CoordinatorError` whenever
   * a route tries to actually execute an agent (retry / start-pipeline).
   * Non-execution routes (get / list / setRecipeOverride / skip /
   * revoke-ai-review / validateWorkflowRoles) work fully against the real
   * `PipelineStore`. When the workflow is missing the V4.6 `default_recipe`
   * / `roles` sections we skip wiring (with a friendly log) so the daemon
   * stays bootable against legacy V4.5 workflow YAML — matches the plan's
   * "missing workflow config → friendly log, does not crash" gate.
   */
  let pipelineService: ReturnType<typeof createPipelineService> | undefined;
  let startPipelineForTask:
    | ((input: {
        workItem: WorkItem;
        task: TaskNode;
        pendingRecipe?: WorkflowRecipe;
      }) => Promise<{
        pipelineRunId: string;
        branch: string;
        taskStatus: TaskNode["status"];
        mergeRequest?: {
          iid: number;
          url?: string;
          state?: "opened" | "merged" | "closed";
        };
      }>)
    | undefined;
  // V4.6 review fix C4：把 pipelineStore 引用提到 if-block 外，让下面的
  // `buildPipelineQualitySummary` callback 也能读到（启用 V4.6 时填实例，
  // 未启用 V4.6 时保持 undefined，buildQualitySummary 行为不变）。
  let pipelineStore: PipelineStore | undefined;
  if (workflow.defaultRecipe && workflow.roles) {
    pipelineStore = createPipelineStore({
      root: path.join(workflow.workspace.root, ".issuepilot"),
    });
    const activePipelineStore = pipelineStore;
    /**
     * V4.6 follow-up Task 4b (review C1 part 2/3)：把 coder + reviewer
     * 真正接到 `@issuepilot/runner-codex-app-server` 的
     * `spawnRpc + driveLifecycle`。
     *
     * Codex 的 cwd 锚到 V4.5 `ensureWorktree` 的实际 layout
     * (`<workspace.root>/<projectSlug>/<issueIid>`，见
     * `packages/workspace/src/worktree.ts:204`)。V4.6 pipeline 自己
     * 暂时还没接 ensureMirror / ensureWorktree —— 那仍是 V4.5
     * dispatch path 的职责。所以当 issue 还没在 V4.5 路径上跑过
     * 时，这里的 cwd 不存在，Codex spawn / driveLifecycle 会让
     * lifecycle adapter 抛错；上游 `createCoderAgent` 把它翻成
     * `runner_unavailable` 写入 AgentReport（spec §16.2 row 4），
     * dashboard 看到失败而非 daemon 崩。把 worktree 主动 ensure
     * 进 V4.6 pipeline 是 V4.7 范围。
     */
    const codexCwdFor = (workItem: WorkItem): string =>
      path.join(
        workflow.workspace.root,
        slugify(workflow.tracker.projectId),
        String(workItem.sourceIssue.iid),
      );

    /**
     * V4.6 follow-up Task 4c — `publishLifecycleEvent` 接受 lifecycle
     * adapter 透回来的 ctx，把 `issueIid` + `taskId` + `role` 写进
     * `event.detail`，让 `publishEvent`（daemon.ts:884-922）能从
     * `event.detail.issueIid` 解出 (projectSlug, issueIid) 真把事件
     * 落到 eventStore；`runId` 也由占位升级为 task 粒度，dashboard 可
     * 按 task / pipelineRunId 过滤。pipelineRunId 来自 closure 透传
     * （adapter 没暴露 pipelineRun，但 daemon 装配层在每次 V4.6 agent
     * run 时已经拿得到 input.pipelineRun.pipelineRunId）。
     */
    const publishLifecycleEvent = (input: {
      role: "coder" | "reviewer" | "test_evidence";
      type: string;
      data: unknown;
      workItem: WorkItem;
      task: TaskNode;
    }): void => {
      publishEvent({
        type: `codex_v46_${input.role}_${input.type}`,
        runId: `pipeline-${input.task.taskId}-${input.role}`,
        ts: new Date().toISOString(),
        detail: {
          data: input.data,
          issueIid: input.workItem.sourceIssue.iid,
          taskId: input.task.taskId,
          role: input.role,
        },
      });
    };
    const gitlabToolsAdapter = {
      getIssue: async (iid: number) => {
        const fullIssue = await gitlab.getIssue(iid);
        return {
          ...fullIssue,
          labels: [...fullIssue.labels],
        };
      },
      transitionLabels: gitlab.transitionLabels,
      createIssueNote: gitlab.createIssueNote,
      updateIssueNote: (iid: number, noteId: number, update: { body: string }) =>
        gitlab.updateIssueNote(iid, noteId, update.body),
      createMergeRequest: gitlab.createMergeRequest,
      updateMergeRequest: gitlab.updateMergeRequest,
      getMergeRequest: gitlab.getMergeRequest,
      listMergeRequestNotes: gitlab.listMergeRequestNotes,
      getPipelineStatus: gitlab.getPipelineStatus,
    };
    /**
     * V4.7 runner adapter contract：runner adapter 自己不持有 workItem，
     * 但 GitLab tools 工厂需要当前 issue 的 iid / url / title 来生成
     * `gitlab_*` tool schemas，RunnerEvent → publishEvent 也需要把
     * workItem.sourceIssue.iid 写进 `detail.issueIid` 让 eventStore
     * 能按 issue 路由。所以这里维护一个 per-call-key 的 workItem 表，
     * pipelineAgents 包装器在调用 agent.run 之前 set，结束后 delete；
     * 表 key = `<pipelineRunId>/<taskId>/<role>`，唯一对应一次 V4.6
     * agent.run。
     */
    const currentWorkItemByCallKey = new Map<string, WorkItem>();
    const runnerCallKey = (input: {
      pipelineRunId: string;
      taskId: string;
      role: string;
    }): string =>
      `${input.pipelineRunId}/${input.taskId}/${input.role}`;

    const codexAdapterTools = (input: RunnerRunInput) => {
      const wi = currentWorkItemByCallKey.get(runnerCallKey(input));
      if (!wi) return [];
      return createGitLabTools(gitlabToolsAdapter, {
        id: String(wi.sourceIssue.iid),
        iid: wi.sourceIssue.iid,
        title: wi.sourceIssue.title,
        url: wi.sourceIssue.url,
        projectId: wi.sourceIssue.projectId,
        labels: [],
      });
    };

    const runnerEventSink: RunnerEventSink = {
      emit(event: RunnerEvent): void {
        const wi = currentWorkItemByCallKey.get(
          runnerCallKey({
            pipelineRunId: event.pipelineRunId,
            taskId: event.taskId,
            role: event.role,
          }),
        );
        if (!wi) return;
        publishLifecycleEvent({
          role: event.role as "coder" | "reviewer" | "test_evidence",
          type: event.type,
          data: {
            ...(event.data ?? {}),
            runnerId: event.runnerId,
            ...(event.runnerRunId ? { runnerRunId: event.runnerRunId } : {}),
            ...(event.message ? { message: event.message } : {}),
            ...(event.redactedFields && event.redactedFields.length > 0
              ? { redactedFields: event.redactedFields }
              : {}),
          },
          workItem: wi,
          task: {
            taskId: event.taskId,
            title: "",
            goal: "",
            scope: "",
            dependsOn: [],
            suggestedValidation: [],
            status: "running",
            runIds: [],
            riskLevel: "low",
          },
        });
      },
    };

    const workflowRunners = workflow.runners ?? {};
    const adapters: RunnerAdapter[] = Object.values(workflowRunners).map(
      (descriptor) => {
        switch (descriptor.kind) {
          case "codex_app_server":
            return createCodexAppServerAdapter({
              descriptor,
              codex: workflow.codex,
              tools: codexAdapterTools,
            });
          case "claude_code":
            return createClaudeCodeAdapter({ descriptor });
        }
      },
    );
    const runnerRegistry = createRunnerRegistry({
      descriptors: workflowRunners,
      adapters,
    });

    const coderAgent = createCoderAgent({
      runnerRegistry,
      events: runnerEventSink,
    });
    const reviewerAgent = createReviewerAgent({
      runnerRegistry,
      events: runnerEventSink,
    });
    /**
     * V4.7 — test_evidence agent 也通过 RunnerRegistry 取 adapter
     * （spec §16.1）：runner 跑一次决定要采哪些证据，然后再串接 collectors
     * 把证据真正落盘到 `<workspace>/.issuepilot/evidence/<taskId>/`。
     * collectors 由 daemon 装配层按 task 注入，agent.run 时一并消费。
     */
    const testEvidenceAgent = createTestEvidenceAgent({
      runnerRegistry,
      events: runnerEventSink,
    });
    const evidenceDirFor = (workItem: WorkItem, task: TaskNode): string =>
      path.join(
        workflow.workspace.root,
        slugify(workflow.tracker.projectId),
        String(workItem.sourceIssue.iid),
        ".issuepilot",
        "evidence",
        task.taskId,
      );

    /**
     * Coordinator 的 `AgentRunInput` 不含 `cwd`（worktree path 是 daemon
     * 装配层的事），所以这里建薄 adapter：补 `cwd`，narrow
     * `RoleProfile` 到具体 role profile，再把 `CoderAgentResult` /
     * `ReviewerAgentResult` 直接当作 `AgentRunResult` 返回（结构兼容）。
     *
     * V4.6 production gap closure：reviewer publisher 现在通过 coder report
     * 里的 MR iid 反查 GitLab `diff_refs`，再调用 `publishReviewerToMr`
     * 生成 summary + inline comments。找不到 MR / diff_refs 时 fail soft
     * 写回 `publish_failed`，不让 pipeline 因发布装配问题崩溃。
     */
    const buildPublishFailed = (message: string) => ({
      mrPublication: {
        status: "publish_failed" as const,
        noteIds: [],
        lastError: {
          code: "gitlab_rate_limited" as const,
          message,
        },
      },
      redactedFieldsAdded: [],
      scopeInsufficient: false as const,
    });

    const withRunnerCallContext = async <T,>(
      key: string,
      workItem: WorkItem,
      fn: () => Promise<T>,
    ): Promise<T> => {
      currentWorkItemByCallKey.set(key, workItem);
      try {
        return await fn();
      } finally {
        currentWorkItemByCallKey.delete(key);
      }
    };

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
          const key = runnerCallKey({
            pipelineRunId: input.pipelineRun.pipelineRunId,
            taskId: input.task.taskId,
            role: "coder",
          });
          return withRunnerCallContext(key, input.workItem, () =>
            coderAgent.run({
              workItem: input.workItem,
              task: input.task,
              pipelineRun: { pipelineRunId: input.pipelineRun.pipelineRunId },
              profile: coderProfile,
              cwd: codexCwdFor(input.workItem),
            }),
          );
        },
      },
      reviewer: {
        async run(input): Promise<
          | { kind: "report"; report: ReviewerAgentReport }
          | { kind: "cancelled"; cancelledAt: string }
        > {
          // coordinator 在调入 reviewer 之前已经把 profile.role 校验
          // 成 "reviewer"（pipelines/coordinator.ts:324）。这里再校验
          // 一次保留 narrow 路径，避免依赖上游不变量。
          if (input.profile.role !== "reviewer") {
            throw new CoordinatorError(
              `reviewer agent received non-reviewer profile: ${input.profile.role}`,
              "role_profile_invalid",
            );
          }
          const reviewerProfile: ReviewerRoleProfile = input.profile;
          const key = runnerCallKey({
            pipelineRunId: input.pipelineRun.pipelineRunId,
            taskId: input.task.taskId,
            role: "reviewer",
          });
          return withRunnerCallContext(key, input.workItem, () =>
            reviewerAgent.run({
              workItem: input.workItem,
              task: input.task,
              pipelineRun: { pipelineRunId: input.pipelineRun.pipelineRunId },
              profile: reviewerProfile,
              cwd: codexCwdFor(input.workItem),
            }),
          );
        },
      },
      testEvidence: {
        async run(input): Promise<
          | { kind: "report"; report: TestEvidenceAgentReport }
          | { kind: "cancelled"; cancelledAt: string }
        > {
          if (input.profile.role !== "test_evidence") {
            throw new CoordinatorError(
              `test_evidence agent received non-test_evidence profile: ${input.profile.role}`,
              "role_profile_invalid",
            );
          }
          const teProfile: TestEvidenceRoleProfile = input.profile;
          const key = runnerCallKey({
            pipelineRunId: input.pipelineRun.pipelineRunId,
            taskId: input.task.taskId,
            role: "test_evidence",
          });
          return withRunnerCallContext(key, input.workItem, () =>
            testEvidenceAgent.run({
              workItem: input.workItem,
              task: input.task,
              pipelineRun: { pipelineRunId: input.pipelineRun.pipelineRunId },
              profile: teProfile,
              cwd: codexCwdFor(input.workItem),
              evidenceDir: evidenceDirFor(input.workItem, input.task),
              collectors: collectorsForTask(input.task),
            }),
          );
        },
      },
      reviewerPublisher: {
        async publish(input) {
          const coderId = input.pipelineRun.agentReportIds.coder;
          const coder = coderId
            ? await activePipelineStore.getAgentReport({
                taskId: input.task.taskId,
                role: "coder",
                agentReportId: coderId,
              })
            : null;
          const mrIid =
            coder?.role === "coder" ? coder.coder.mergeRequest?.iid : undefined;
          if (!mrIid) {
            return buildPublishFailed(
              `cannot publish reviewer report ${input.reviewerReport.agentReportId}: coder report has no mergeRequest.iid`,
            );
          }
          const client = (gitlab as GitLabAdapterHandle).client as
            | GitLabClient<GitLabApi>
            | undefined;
          if (!client) {
            return buildPublishFailed(
              "GitLab adapter does not expose .client; cannot publish reviewer comments",
            );
          }
          const mr = await gitlab.getMergeRequest(mrIid);
          if (!mr.diffRefs) {
            return buildPublishFailed(
              `GitLab MR !${mrIid} did not include diff_refs; cannot create inline review comments`,
            );
          }
          return publishReviewerToMr({
            client,
            reviewerReport: input.reviewerReport,
            mrRef: { iid: mr.iid, ...mr.diffRefs },
            publishToMr: input.profile.publishToMr,
            requiredScope: "api",
          });
        },
      },
    };
    const workflowRoles = workflow.roles;
    const pipelineRoleProfileResolver: RoleProfileResolver = {
      async resolveRoleProfile(role, { workItem, task }) {
        const cfg = workflowRoles[role];
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
    const pipelineCoordinator: Coordinator = createCoordinator({
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
    startPipelineForTask = async ({ workItem, task, pendingRecipe }) => {
      const result = await pipelineCoordinator.startPipeline({
        workItem,
        task,
        workflowDefault: workflow.defaultRecipe,
        ...(pendingRecipe ? { pendingRecipe } : {}),
      });
      const report = buildPipelineRunReport({
        workItem,
        pipelineRun: result.pipelineRun,
        finalStatus: result.finalStatus,
        reports: result.reports,
      });
      await reportStore.save(report);
      const mergeRequest = report.mergeRequest
        ? {
            iid: report.mergeRequest.iid,
            ...(report.mergeRequest.url ? { url: report.mergeRequest.url } : {}),
            ...(report.mergeRequest.state
              ? { state: report.mergeRequest.state }
              : {}),
          }
        : undefined;
      return {
        pipelineRunId: result.pipelineRun.pipelineRunId,
        branch: report.run.branch,
        taskStatus: taskStatusFromPipelineStatus(result.finalStatus),
        ...(mergeRequest ? { mergeRequest } : {}),
      };
    };
    // V4.6 fix C3：把 PipelineService 的撤销契约接到真实的 GitLab API。
    // 之前 `createPipelineService` 没传 `revokeReviewerMrComments`，导致
    // dashboard 的 revoke 操作只翻本地 mrPublication.status = "revoked"，
    // 但 GitLab 上的 note 一条都没删（spec §12 contract 失败）。下面的
    // adapter 把 service 签名（agentReportId / noteIds / operator）翻译到
    // gitlab/mr-comments.ts 的 helper 签名（client / mrIid / mrPublication），
    // mrIid 通过同 task 下的 coder report.coder.mergeRequest.iid 反查。
    const pipelineStoreForCallback = pipelineStore;
    const pipelineRevokeCallback = async (input: {
      agentReportId: string;
      noteIds: string[];
      operator?: string;
    }): Promise<{ revokedAt: string }> => {
      void input.operator;
      const found =
        await pipelineStoreForCallback.findAgentReportById(input.agentReportId);
      if (!found || found.role !== "reviewer") {
        throw new Error(
          `daemon revoke callback: reviewer agent report ${input.agentReportId} not found`,
        );
      }
      const run = await pipelineStoreForCallback.getPipelineRunByIdOnly({
        pipelineRunId: found.report.pipelineRunId,
      });
      const coderId = run?.agentReportIds.coder;
      const coder = coderId
        ? await pipelineStoreForCallback.getAgentReport({
            taskId: found.taskId,
            role: "coder",
            agentReportId: coderId,
          })
        : await pipelineStoreForCallback.latestAgentReportForRole({
            taskId: found.taskId,
            role: "coder",
          });
      const mrIid =
        coder?.role === "coder" ? coder.coder.mergeRequest?.iid : undefined;
      if (!mrIid) {
        throw new Error(
          `daemon revoke callback: cannot resolve mrIid for reviewer report ${input.agentReportId} (no coder report or no mergeRequest.iid)`,
        );
      }
      const client = (gitlab as GitLabAdapterHandle).client as
        | GitLabClient<GitLabApi>
        | undefined;
      if (!client) {
        throw new Error(
          "daemon revoke callback: GitLab adapter does not expose .client (test seam returned a bare GitLabAdapter); cannot delete MR notes",
        );
      }
      const reviewerReport = found.report;
      const mrPublication =
        reviewerReport.role === "reviewer"
          ? reviewerReport.reviewer.mrPublication
          : { status: "revoked" as const, noteIds: [] };
      await revokeReviewerMrCommentsHelper({
        client,
        mrIid,
        mrPublication,
        requiredScope: "api",
      });
      return { revokedAt: new Date().toISOString() };
    };
    pipelineService = createPipelineService({
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
        getDefaultRecipe: () => workflow.defaultRecipe,
        getRoles: () => workflow.roles,
      },
      revokeReviewerMrComments: pipelineRevokeCallback,
    });
  } else {
    console.warn(
      "[issuepilot] V4.6 pipeline service skipped: workflow YAML is missing default_recipe or roles. Update the workflow to enable /api/work-items/.../pipeline endpoints (spec §10).",
    );
  }

  const improvementService = createImprovementService({
    store: improvementStore,
    allowedPathPrefixes: improvementSandbox,
    resolveTargetPath: ({ template }) => {
      // First-pass mapping per spec §7 / spec §10. We only resolve the two
      // canonical targets that live at well-known paths; the other kinds stay
      // `undefined` and patch preview surfaces `target_path_missing` until a
      // future change adds a richer resolver.
      switch (template.targetKind) {
        case "workflow_front_matter":
          return workflowPath;
        case "project_rules":
          return path.join(workflow.workspace.root, "AGENTS.md");
        default:
          return undefined;
      }
    },
    // V4.6 review follow-up (Issue 1)：improvement service 的
    // buildQualitySummary callback 与 HTTP `/api/quality/summary` 路由
    // 共享同一份 `buildPipelineQualitySummary` 实现，确保 byRole 切片
    // 在两条路径上语义一致。未启用 V4.6 pipeline 时 pipelineStore 为
    // undefined，等价于 V4.5 历史行为。
    buildQualitySummary: createPipelineQualitySummaryCallback({
      pipelineStore,
      collectorDeps: {
        metadata: { workflow: path.basename(workflowPath) },
        reports: reportStore,
        workItems: workItemStore,
      },
      scope: { mode: "single-project" },
    }),
  });
  const workItemPlanner =
    deps.workItemPlanner ?? createDefaultWorkItemPlanner();
  const taskRunIndex = new Map<
    string,
    { workItemId: string; taskId: string }
  >();
  const runIndex = new Map<string, { projectSlug: string; issueIid: number }>();
  const runCancelRegistry = createRunCancelRegistry();

  const publishEvent = (event: {
    type: string;
    runId: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void => {
    const existing = runIndex.get(event.runId);
    const run = state.getRun(event.runId);
    const issue =
      eventIssueFromUnknown(event.detail["issue"]) ??
      eventIssueFromUnknown(run?.["issue"]) ??
      fallbackEventIssue(
        workflow.tracker.projectId,
        Number.isFinite(Number(event.detail["issueIid"] ?? event.detail["iid"]))
          ? Number(event.detail["issueIid"] ?? event.detail["iid"])
          : 0,
      );
    const record = toEventRecord({ ...event, issue });
    eventBus.publish(record);
    // V4.6 follow-up Task 4c review: lifecycle events from
    // createCoderLifecycle / createReviewerLifecycle ride synthetic
    // runIds (`pipeline-<taskId>-<role>`) that never enter runIndex
    // and never have a state.runs entry — those runs are coordinator-
    // owned, not V4.5 dispatch-owned. Without consulting
    // `event.detail.issueIid` / `iid` (the same fields the issue
    // hydrator above already reads) the gate would short-circuit and
    // `eventStore.append` would silently drop every codex_v46_*
    // event. Accept any finite positive integer; non-numeric / 0 /
    // negative values still bail out, matching the pre-4c behavior.
    const detailIidRaw = event.detail["issueIid"] ?? event.detail["iid"];
    const detailIid =
      typeof detailIidRaw === "number" ||
      (typeof detailIidRaw === "string" && detailIidRaw !== "")
        ? Number(detailIidRaw)
        : NaN;
    const issueIid =
      existing?.issueIid ??
      (typeof run?.["issue"] === "object" &&
      run["issue"] !== null &&
      "iid" in run["issue"]
        ? Number((run["issue"] as { iid: unknown }).iid)
        : undefined) ??
      (Number.isFinite(detailIid) && detailIid > 0 ? detailIid : undefined);
    if (!issueIid || !Number.isFinite(issueIid)) return;
    const key = existing ?? runKey(workflow, issueIid);
    runIndex.set(record.runId, key);
    void eventStore
      .append(key.projectSlug, key.issueIid, record)
      .catch((err) => {
        // ENOENT can fire during teardown if the workspace dir was
        // removed between scheduling the publish and flushing it. Silence
        // that specific case to keep test output clean; everything else
        // is still surfaced for diagnostics.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return;
        console.error(err);
      });
  };

  // V2 Phase 5: persist workspace cleanup events to a sentinel slot so
  // `/api/events?runId=workspace-cleanup` returns the audit history
  // the runbook tells operators to grep. These events are not tied to
  // a single run/issue (they describe the whole `~/.issuepilot` root),
  // so we map the sentinel `runId` -> `("__system__", 0)` once at
  // startup; the same `runIndex` is reused below for operator/CI/review
  // bridging.
  const WORKSPACE_CLEANUP_RUN_ID = "workspace-cleanup";
  const WORKSPACE_CLEANUP_KEY = {
    projectSlug: "__system__",
    issueIid: 0,
  } as const;
  runIndex.set(WORKSPACE_CLEANUP_RUN_ID, WORKSPACE_CLEANUP_KEY);

  // Operator action services, the CI feedback scanner and the workspace
  // cleanup sweep all publish directly to the event bus (they do not
  // have access to publishEvent's eventStore-aware path). Bridge those
  // records into the eventStore so `/api/events?runId=...` and the
  // dashboard's audit log can surface them alongside dispatch/codex
  // events. The bus already received the record from the caller; this
  // subscriber strictly appends to disk and never re-publishes.
  eventBus.subscribe((record) => {
    if (
      !record.type.startsWith("operator_action_") &&
      !record.type.startsWith("ci_status_") &&
      !record.type.startsWith("review_feedback_") &&
      !record.type.startsWith("workspace_cleanup_")
    ) {
      return;
    }
    let key: { projectSlug: string; issueIid: number } | undefined;
    if (record.type.startsWith("workspace_cleanup_")) {
      // System-level events: ignore `record.runId` (always the
      // sentinel) and the per-run lookup below. Pin straight to the
      // shared `__system__-0.jsonl` log.
      key = WORKSPACE_CLEANUP_KEY;
    } else {
      const existing = runIndex.get(record.runId);
      const run = state.getRun(record.runId);
      const issueIid =
        existing?.issueIid ??
        (typeof run?.["issue"] === "object" &&
        run["issue"] !== null &&
        "iid" in run["issue"]
          ? Number((run["issue"] as { iid: unknown }).iid)
          : undefined);
      if (!issueIid || !Number.isFinite(issueIid)) return;
      key = existing ?? runKey(workflow, issueIid);
      runIndex.set(record.runId, key);
    }
    void eventStore
      .append(key.projectSlug, key.issueIid, record)
      .catch((err) => {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return;
        console.error(err);
      });
  });

  const publishHumanReviewEvent = (event: HumanReviewEvent): void => {
    syncHumanReviewFinalLabels(state, event);
    if (event.issueIid > 0) {
      const key = runKey(workflow, event.issueIid);
      if (event.runId === HUMAN_REVIEW_SCAN_RUN_ID) {
        const record = toEventRecord({
          type: event.type,
          runId: event.runId,
          ts: event.ts,
          issue: fallbackEventIssue(workflow.tracker.projectId, event.issueIid),
          detail: {
            issueIid: event.issueIid,
            ...event.detail,
          },
        });
        eventBus.publish(record);
        void eventStore
          .append(key.projectSlug, key.issueIid, record)
          .catch((err) => {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code === "ENOENT") return;
            console.error(err);
          });
        return;
      }
      runIndex.set(event.runId, key);
    }
    publishEvent({
      type: event.type,
      runId: event.runId,
      ts: event.ts,
      detail: {
        issueIid: event.issueIid,
        ...event.detail,
      },
    });
  };

  const patchReportEvidence = async (
    finalReport: RunReportArtifact,
  ): Promise<void> => {
    try {
      const taskWorktreePath = finalReport.run.workspacePath.trim();
      if (!taskWorktreePath) {
        publishEvent({
          type: "work_item_evidence_index_skipped",
          runId: finalReport.runId,
          ts: new Date().toISOString(),
          detail: {
            reason: "missing-workspace-path",
          },
        });
        return;
      }

      const scan = await scanRunEvidence({
        taskWorktreePath,
        runId: finalReport.runId,
      });
      const publishIndexed = () =>
        publishEvent({
          type: "work_item_evidence_indexed",
          runId: finalReport.runId,
          ts: new Date().toISOString(),
          detail: {
            count: scan.entries.length,
            oversizedCount: scan.oversized.length,
            rejectedCount: scan.rejected.length,
            manifestUsed: scan.manifestUsed,
          },
        });

      const existingEvidence = finalReport.evidence ?? [];
      const nextEvidence = mergeReportEvidence(existingEvidence, scan);
      const nextFollowUps = appendOversizedFollowUps(
        finalReport.handoff.followUps,
        scan.oversized,
        scan.rejected,
      );
      const evidenceChanged =
        JSON.stringify(existingEvidence) !== JSON.stringify(nextEvidence);
      const followUpsChanged =
        JSON.stringify(finalReport.handoff.followUps) !==
        JSON.stringify(nextFollowUps);
      if (!evidenceChanged && !followUpsChanged) {
        publishIndexed();
        return;
      }

      const { evidence: _evidence, ...reportWithoutEvidence } = finalReport;
      const patchedReport: RunReportArtifact =
        nextEvidence.length > 0
          ? {
              ...finalReport,
              evidence: nextEvidence,
              handoff: {
                ...finalReport.handoff,
                followUps: nextFollowUps,
              },
            }
          : {
              ...reportWithoutEvidence,
              handoff: {
                ...finalReport.handoff,
                followUps: nextFollowUps,
              },
            };
      try {
        await reportStore.save(patchedReport);
        publishIndexed();
      } catch (err) {
        // The scanner succeeded even if the patch write failed. Preserve the
        // indexed event for observability, then let the outer handler emit the
        // failure event with the save error.
        publishIndexed();
        throw err;
      }
    } catch (err) {
      publishEvent({
        type: "work_item_evidence_index_failed",
        runId: finalReport.runId,
        ts: new Date().toISOString(),
        detail: {
          reason: err instanceof Error ? err.message : String(err),
          ...(finalReport.run.workspacePath
            ? { workspacePath: finalReport.run.workspacePath }
            : {}),
        },
      });
    }
  };

  const operatorActionDeps = (): OperatorActionDeps => ({
    state,
    eventBus,
    runCancelRegistry,
    gitlab: {
      transitionLabels: async (iid, labels) => {
        await gitlab.transitionLabels(iid, labels);
      },
    },
    workflow: {
      tracker: {
        runningLabel: workflow.tracker.runningLabel,
        reworkLabel: workflow.tracker.reworkLabel,
        failedLabel: workflow.tracker.failedLabel,
        blockedLabel: workflow.tracker.blockedLabel,
      },
    },
  });

  // V2 Phase 5: latest cleanup plan summary, refreshed by the
  // maintenance executor each time the loop runs cleanup. Both fields
  // start as `undefined` so the dashboard knows "cleanup hasn't run
  // yet" (distinct from a literal 0GB usage). The first sweep runs on
  // the very next tick (lastCleanupAt = 0 in the loop), so seeding
  // `nextWorkspaceCleanupAt` to "now + interval" would have advertised
  // an hour-out ETA while the real ETA is the next tick — leave both
  // undefined until the executor reports back.
  let lastWorkspaceUsageGb: number | undefined;
  let nextWorkspaceCleanupAt: string | undefined;

  const workItemHandoffWorkflow = () => ({
    runningLabel: workflow.tracker.runningLabel,
    handoffLabel: workflow.tracker.handoffLabel,
    reworkLabel: workflow.tracker.reworkLabel,
    blockedLabel: workflow.tracker.blockedLabel,
    readyLabel: readyLabel(workflow),
  });
  const workItemAggregateDeps = () => ({
    getRunReport: (runId: string) => reportStore.get(runId),
    getEvidenceConfirmations: (workItemId: string) =>
      workItemStore.loadEvidenceConfirmations(workItemId),
  });

  const workItems: WorkItemService = createWorkItemService({
    store: workItemStore,
    planner: workItemPlanner,
    fetchIssue: async (iid) => {
      const fullIssue = await gitlab.getIssue(iid);
      return {
        iid: fullIssue.iid,
        title: fullIssue.title,
        description: fullIssue.description ?? "",
        url: fullIssue.url,
        projectId: fullIssue.projectId,
        labels: [...fullIssue.labels],
      };
    },
    tick: async (wi) => {
      const plan = await workItemStore.getCurrentPlan(wi.workItemId);
      if (!plan || plan.status !== "accepted") return;
      const links = await workItemStore.listAllTaskRunLinks(wi.workItemId);
      return tickWorkItemImpl(wi, plan, links, {
        availableSlots: () => slots.available(),
        getRunReport: (runId) => reportStore.get(runId),
        ...(startPipelineForTask ? { startPipelineForTask } : {}),
        decideEffectiveBase: (input) =>
          decideEffectiveBase({
            task: input.task,
            plan: input.plan,
            links: input.links,
            getRunReport: (runId) => reportStore.get(runId),
            defaultBaseBranch: workflow.git.baseBranch,
          }),
        dispatchTask: async (task, dispatchOpts) => {
          // V4.1 review C1 fix: synthetic task runs now go through the
          // real V2.x dispatch path with `parentIssueLabelMode:
          // "suppressed"` (set by `runTaskOnce` on the DispatchInput).
          // The shim mints `runId` + `branch`, then we build the
          // DispatchDeps closure around them and call the same
          // `dispatch()` that V2.x runs use — so we get mirror /
          // worktree / Codex agent / commits / MR / RunReportArtifact
          // exactly like a normal Issue run, minus parent-label /
          // workpad-note writes (which are reconcile.ts's job and
          // are gated on `parentIssueLabelMode`).
          //
          // Two V4.1-specific deltas vs the V2.x dispatch wiring:
          //   1. `onFailure` does NOT call
          //      gitlab.transitionLabels(parentIssueIid, ...) — that
          //      would defeat the suppression invariant. Instead we
          //      mark the report as failed; the bus listener picks up
          //      `dispatch_failed`, runs `settleTaskRunFinal`, which
          //      aggregates and writes (or doesn't write) the parent
          //      handoff via the WorkItem aggregator alone.
          //   2. We pre-seed an "initial" RunReportArtifact under the
          //      synthetic runId so reconcile / failure paths can
          //      update it instead of guarding for missing reports
          //      (mirroring V2.x claim-time seeding).
          const issue = wi.sourceIssue;
          const parentProjectSlug = slugify(issue.projectId);
          const titleSlug = slugify(task.title);

          const { runId, branch } = await runTaskOnce({
            workItem: wi,
            task,
            workflow: {
              git: workflow.git,
              workspace: workflow.workspace,
              tracker: {
                runningLabel: workflow.tracker.runningLabel,
                handoffLabel: workflow.tracker.handoffLabel,
                reworkLabel: workflow.tracker.reworkLabel,
              },
              ...(workflow.hooks ? { hooks: workflow.hooks } : {}),
            },
            promptTemplate: workflow.promptTemplate,
            state,
            ...(dispatchOpts?.baseOverride
              ? { baseOverride: dispatchOpts.baseOverride }
              : {}),
            ...(dispatchOpts?.chainedFrom
              ? { chainedFrom: dispatchOpts.chainedFrom }
              : {}),
            dispatch: async (input) => {
              taskRunIndex.set(input.runId, {
                workItemId: wi.workItemId,
                taskId: task.taskId,
              });

              // Seed the initial RunReportArtifact so downstream
              // updaters (`reconcile`, `markReportFailed`,
              // `settleTaskRunFinal`) operate on an existing record
              // rather than racing on `reportStore.get()` returning
              // undefined. Mirrors V2.x claim seeding (line ~1085).
              try {
                const initialReport = createInitialReport({
                  runId: input.runId,
                  issue: {
                    iid: issue.iid,
                    title: issue.title,
                    url: issue.url,
                    projectId: issue.projectId,
                    labels: [],
                  },
                  status: "running",
                  attempt: 1,
                  branch: input.branch,
                  workspacePath: "",
                  startedAt: new Date().toISOString(),
                });
                await reportStore.save(initialReport);
              } catch (err) {
                publishEvent({
                  type: "report_seed_failed",
                  runId: input.runId,
                  ts: new Date().toISOString(),
                  detail: {
                    reason: err instanceof Error ? err.message : String(err),
                    workItemId: wi.workItemId,
                    taskId: task.taskId,
                  },
                });
              }

              // dispatch() drives mirror → worktree → Codex → reconcile
              // and can take minutes. tickWorkItem (and therefore the
              // operator-facing `acceptPlan` HTTP request) must NOT
              // block on it; instead we fire-and-forget. dispatch.ts's
              // own try/catch turns terminal errors into `onFailure` +
              // `dispatch_failed` events, which the bus listener turns
              // into `settleTaskRunFinal`. The .catch here is a final
              // safety net for unexpected throws outside dispatch.ts's
              // own envelope.
              void (async () => {
                try {
                  await dispatch(input, buildDeps());
                } catch (err) {
                  publishEvent({
                    type: "task_run_dispatch_uncaught",
                    runId: input.runId,
                    ts: new Date().toISOString(),
                    detail: {
                      reason: err instanceof Error ? err.message : String(err),
                      workItemId: wi.workItemId,
                      taskId: task.taskId,
                    },
                  });
                }
              })();

              function buildDeps(): Parameters<typeof dispatch>[1] {
                return {
                  state,
                  maxAttempts: workflow.agent.maxAttempts,
                  retryBackoffMs: workflow.agent.retryBackoffMs,
                  ensureMirror: async (opts) =>
                    ensureMirror({
                      repoUrl: opts.remoteUrl,
                      projectSlug: parentProjectSlug,
                      repoCacheRoot: opts.repoCacheRoot,
                    }),
                  ensureWorktree: async (opts) => {
                    const result = await ensureWorktree({
                      mirrorPath: opts.mirrorPath,
                      projectSlug: parentProjectSlug,
                      issueIid: issue.iid,
                      titleSlug,
                      baseBranch: opts.baseBranch,
                      branchPrefix: workflow.git.branchPrefix,
                      workspaceRoot: opts.worktreeRoot,
                    });
                    return {
                      worktreePath: result.workspacePath,
                      created: !result.reused,
                    };
                  },
                  runHook: (opts) =>
                    runHook({
                      cwd: opts.cwd,
                      name: opts.name,
                      script: opts.script,
                      env: opts.env ?? {},
                    }),
                  renderPrompt: (opts) =>
                    workflowLoader.render(
                      opts.template,
                      opts.vars as unknown as PromptContext,
                    ),
                  runAgent: async (opts) => {
                    const cmd = splitCommand(workflow.codex.command);
                    const rpc = spawnRpc({ ...cmd, cwd: opts.cwd });
                    const gitlabToolsAdapter = {
                      getIssue: async (iid: number) => {
                        const fullIssue = await gitlab.getIssue(iid);
                        return {
                          ...fullIssue,
                          labels: [...fullIssue.labels],
                        };
                      },
                      transitionLabels: gitlab.transitionLabels,
                      createIssueNote: gitlab.createIssueNote,
                      updateIssueNote: (
                        iid: number,
                        noteId: number,
                        update: { body: string },
                      ) => gitlab.updateIssueNote(iid, noteId, update.body),
                      createMergeRequest: gitlab.createMergeRequest,
                      updateMergeRequest: gitlab.updateMergeRequest,
                      getMergeRequest: gitlab.getMergeRequest,
                      listMergeRequestNotes: gitlab.listMergeRequestNotes,
                      getPipelineStatus: gitlab.getPipelineStatus,
                    };
                    try {
                      const result = await driveLifecycle({
                        rpc,
                        maxTurns: workflow.agent.maxTurns,
                        prompt: opts.prompt,
                        title: issue.title,
                        cwd: opts.cwd,
                        threadName: `${workflow.tracker.projectId}#${issue.iid}/${task.taskId}`,
                        sandboxType: workflow.codex.threadSandbox,
                        approvalPolicy: workflow.codex.approvalPolicy,
                        turnSandboxPolicy: workflow.codex.turnSandboxPolicy,
                        turnTimeoutMs: workflow.codex.turnTimeoutMs,
                        tools: createGitLabTools(gitlabToolsAdapter, {
                          id: String(issue.iid),
                          iid: issue.iid,
                          title: issue.title,
                          url: issue.url,
                          projectId: issue.projectId,
                          labels: [],
                        }),
                        onEvent: (type, data) =>
                          publishEvent({
                            type: `codex_${type}`,
                            runId: input.runId,
                            ts: new Date().toISOString(),
                            detail: { data },
                          }),
                        onTurnActive: (cancel) =>
                          runCancelRegistry.register(input.runId, cancel),
                      });
                      return {
                        status: result.status,
                        summary: result.failureReason,
                      };
                    } finally {
                      runCancelRegistry.unregister(input.runId);
                      await rpc.close();
                    }
                  },
                  reconcile: async (opts) => {
                    const report = await reportStore.get(opts.runId);
                    const result = await reconcile({
                      ...opts,
                      ...(report ? { report } : {}),
                      git: {
                        hasNewCommits,
                        push: pushBranch,
                      },
                      gitlab: {
                        findMergeRequest: (sourceBranch) =>
                          gitlab.findMergeRequestBySourceBranch(sourceBranch),
                        createMergeRequest: (mrOpts) =>
                          gitlab.createMergeRequest({
                            ...mrOpts,
                            issueIid: opts.iid,
                          }),
                        updateMergeRequest: (mrIid, updates) =>
                          gitlab.updateMergeRequest(mrIid, updates),
                        findWorkpadNote: (issueIid, marker) =>
                          gitlab.findWorkpadNote(issueIid, marker),
                        createNote: (issueIid, body) =>
                          gitlab.createIssueNote(issueIid, body),
                        updateNote: (issueIid, noteId, body) =>
                          gitlab.updateIssueNote(issueIid, noteId, body),
                        transitionLabels: async (iid, labelOpts) => {
                          await gitlab.transitionLabels(iid, labelOpts);
                        },
                      },
                      onEvent: publishEvent,
                    });
                    if (report) {
                      const merged = mergeAgentHandoffIntoReport(
                        report,
                        {
                          reworkLabel: opts.reworkLabel,
                          ...(opts.agentSummary !== undefined
                            ? { agentSummary: opts.agentSummary }
                            : {}),
                          ...(opts.agentValidation !== undefined
                            ? { agentValidation: opts.agentValidation }
                            : {}),
                          ...(opts.agentRisks !== undefined
                            ? { agentRisks: opts.agentRisks }
                            : {}),
                          ...(opts.noCodeChangeReason !== undefined
                            ? { noCodeChangeReason: opts.noCodeChangeReason }
                            : {}),
                        },
                        result.mergeRequest
                          ? {
                              iid: result.mergeRequest.iid,
                              ...(result.mergeRequest.webUrl
                                ? { webUrl: result.mergeRequest.webUrl }
                                : {}),
                            }
                          : null,
                      );
                      const nextReport = {
                        ...merged,
                        run: {
                          ...merged.run,
                          ...(opts.workspacePath &&
                          opts.workspacePath !== merged.run.workspacePath
                            ? { workspacePath: opts.workspacePath }
                            : {}),
                        },
                        notes: {
                          ...merged.notes,
                          ...(result.handoffNoteId !== undefined
                            ? { handoffNoteId: result.handoffNoteId }
                            : {}),
                        },
                      };
                      await reportStore.save(nextReport);
                      await patchReportEvidence(nextReport);
                    }
                    return result;
                  },
                  onEvent: publishEvent,
                  // V4.1 onFailure deliberately does NOT touch the
                  // parent Issue label or write a parent-Issue failure
                  // note — that would violate the
                  // `parentIssueLabelMode: "suppressed"` invariant
                  // (synthetic task runs are only allowed to influence
                  // the parent Issue via the WorkItem aggregator). We
                  // just persist the failed report so
                  // `settleTaskRunFinal` (the dispatch_failed bus
                  // listener) sees it; the listener then aggregates
                  // and lets `decideParentLabelTransition` decide the
                  // parent label, which for `partial`/`blocked`
                  // outcomes is intentionally a no-op.
                  onFailure: async (failedRunId, classification, _attempt) => {
                    try {
                      const report = await reportStore.get(failedRunId);
                      if (report) {
                        const failedReport = markReportFailed(report, {
                          status:
                            classification.kind === "blocked"
                              ? "blocked"
                              : "failed",
                          endedAt: new Date().toISOString(),
                          lastError: {
                            code: classification.code,
                            message: classification.reason,
                            classification:
                              classification.kind === "blocked"
                                ? "blocked"
                                : classification.kind === "retryable"
                                  ? "failed"
                                  : classification.kind,
                          },
                        });
                        await reportStore.save(failedReport);
                        await patchReportEvidence(failedReport);
                      }
                    } catch (err) {
                      publishEvent({
                        type: "report_failure_update_failed",
                        runId: failedRunId,
                        ts: new Date().toISOString(),
                        detail: {
                          reason:
                            err instanceof Error ? err.message : String(err),
                          workItemId: wi.workItemId,
                          taskId: task.taskId,
                        },
                      });
                    }
                  },
                };
              }
            },
          });
          taskRunIndex.set(runId, {
            workItemId: wi.workItemId,
            taskId: task.taskId,
          });
          return { runId, branch };
        },
        saveTaskRunLink: (link) => workItemStore.saveTaskRunLink(link),
        saveTaskNode: async (taskId, patch) => {
          const current = await workItemStore.getCurrentPlan(wi.workItemId);
          if (!current) return;
          const nextTasks = current.tasks.map((t) =>
            t.taskId === taskId ? { ...t, ...patch } : t,
          );
          await workItemStore.saveTaskPlan({
            ...current,
            tasks: nextTasks,
          });
        },
        emit: publishEvent,
      });
    },
    aggregateDeps: {
      getRunReport: (runId) => reportStore.get(runId),
    },
    reconcileWorkItem: async (workItemId) => {
      // V4.1: re-run aggregate + handoff against whatever links are
      // already on disk. Called by the service layer for operator
      // actions (skipTask / retryTask) so the dashboard sees the new
      // aggregate immediately and — critically — so the parent Issue
      // label can flip when the operator's action satisfies the
      // "all required tasks completed" condition.
      //
      // V4.1 review C2 fix: previously this path called
      // writeParentHandoff with the unmutated `wi`, so
      // `previousStatus === currentStatus` and
      // decideParentLabelTransition always returned an empty
      // transition. After an operator skipped the last failing task
      // the WorkItem aggregator reported `complete` but the parent
      // Issue stayed `ai-running` forever. We now mirror the
      // status-update + handoff sequence used by `settleTaskRunFinal`
      // so both code paths produce identical observable behaviour.
      const wi = await workItemStore.getWorkItem(workItemId);
      const plan = await workItemStore.getCurrentPlan(workItemId);
      if (!wi || !plan) return;
      const links = await workItemStore.listAllTaskRunLinks(workItemId);
      const ts = new Date().toISOString();

      const { report } = await aggregateWorkItem(
        wi,
        plan,
        links,
        workItemAggregateDeps(),
      );
      await workItemStore.saveReport(report);
      // Note: settleTaskRunFinal already emits `work_item_aggregated`
      // when a synthetic-run settle path triggers reconcileWorkItem.
      // For service-level callers (skipTask / retryTask) the
      // `work_item_handoff_written` event below is enough — it carries
      // the same workItemId + outcome information observers need, and
      // skipping the duplicate avoids flooding the parent Issue's
      // event log on every operator click.

      const previousStatus = wi.status;
      const nextStatus = decideWorkItemStatus(
        report.overallStatus,
        plan,
        links,
      );
      const updated = {
        ...wi,
        status: nextStatus,
        summaryReportId: report.workItemId,
        updatedAt: ts,
      };
      await workItemStore.saveWorkItem(updated);

      await writeParentHandoff({
        workItem: updated,
        plan,
        report,
        previousStatus,
        workflow: workItemHandoffWorkflow(),
        deps: {
          gitlab: {
            findWorkpadNote: gitlab.findWorkpadNote,
            createNote: gitlab.createIssueNote,
            updateNote: gitlab.updateIssueNote,
            transitionLabels: async (iid, labelOpts) => {
              await gitlab.transitionLabels(iid, labelOpts);
            },
          },
          emit: publishEvent,
        },
      });
    },
    emit: publishEvent,
  });

  // V4.1 §11: subscribe to dispatch_completed / dispatch_failed events
  // for synthetic task runs and walk them through the
  // orchestration/aggregate/handoff path. Recognised by reading the
  // RunRecord for `workItem`. Non-task runs are ignored.
  eventBus.subscribe(async (record) => {
    if (
      record.type !== "dispatch_completed" &&
      record.type !== "dispatch_failed"
    ) {
      return;
    }
    const run = state.getRun(record.runId);
    const wiMeta =
      (run as { workItem?: { workItemId: string; taskId: string } } | undefined)
        ?.workItem ?? taskRunIndex.get(record.runId);
    if (!wiMeta) return;
    try {
      const report = await reportStore.get(record.runId);
      if (!report) return;
      await settleTaskRunFinal(
        {
          workItemId: wiMeta.workItemId,
          taskId: wiMeta.taskId,
          runId: record.runId,
          runReport: report,
        },
        {
          store: workItemStore,
          aggregateDeps: workItemAggregateDeps(),
          parentHandoff: {
            gitlab: {
              findWorkpadNote: gitlab.findWorkpadNote,
              createNote: gitlab.createIssueNote,
              updateNote: gitlab.updateIssueNote,
              transitionLabels: async (iid, labelOpts) => {
                await gitlab.transitionLabels(iid, labelOpts);
              },
            },
            emit: publishEvent,
          },
          workflow: workItemHandoffWorkflow(),
          emit: publishEvent,
          saveTaskRunLink: (link) => workItemStore.saveTaskRunLink(link),
          saveTaskNode: async (taskId, patch) => {
            const current = await workItemStore.getCurrentPlan(
              wiMeta.workItemId,
            );
            if (!current) return;
            const nextTasks = current.tasks.map((t) =>
              t.taskId === taskId ? { ...t, ...patch } : t,
            );
            await workItemStore.saveTaskPlan({
              ...current,
              tasks: nextTasks,
            });
          },
        },
      );
    } catch (err) {
      publishEvent({
        type: "work_item_settle_failed",
        runId: record.runId,
        ts: new Date().toISOString(),
        detail: {
          reason: err instanceof Error ? err.message : String(err),
          ...wiMeta,
        },
      });
    }
  });

  const serverFactory = deps.createServer ?? createServer;
  const app = await serverFactory(
    {
      state,
      eventBus,
      workflowPath,
      gitlabProject: workflow.tracker.projectId,
      handoffLabel: workflow.tracker.handoffLabel,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      concurrency: workflow.agent.maxConcurrentAgents,
      workspaceUsageGb: () => lastWorkspaceUsageGb,
      nextCleanupAt: () => nextWorkspaceCleanupAt,
      workItems,
      readEvents: async (runId, readOpts) => {
        const key = runIndex.get(runId);
        if (!key) return [];
        return eventStore.read(key.projectSlug, key.issueIid, readOpts);
      },
      readLogsTail: async (_runId, readOpts) =>
        readLogTail(
          path.join(
            workflow.workspace.root,
            ".issuepilot",
            "logs",
            "issuepilot.log",
          ),
          readOpts?.limit,
        ),
      operatorActions: {
        retry: (input: OperatorActionInput) =>
          retryRun(input, operatorActionDeps()),
        stop: (input: OperatorActionInput) =>
          stopRun(input, operatorActionDeps()),
        archive: (input: OperatorActionInput) =>
          archiveRun(input, operatorActionDeps()),
      },
      reports: reportStore,
      quality: {
        metadata: { workflow: path.basename(workflowPath) },
        reports: reportStore,
        workItems: workItemStore,
      },
      improvements: improvementService,
      ...(pipelineService ? { pipelines: pipelineService } : {}),
      // V4.6 review follow-up (Issue 1)：把 pipelineStore 透给
      // /api/quality/summary 路由，让 dashboard `ByRolePanel` 的 byRole
      // 切片在单 project 模式下真正落地。未启用 V4.6 时 pipelineStore
      // 为 undefined，路由表现与历史一致。
      ...(pipelineStore ? { pipelineStore } : {}),
    },
    { host, port },
  );

  let watcher: Awaited<ReturnType<WorkflowLoader["start"]>> | undefined;
  try {
    watcher = await workflowLoader.start(workflowPath, {
      onReload: (cfg) => {
        workflow = cfg;
      },
      onError: (err) => {
        console.error(err);
      },
    });
  } catch {
    watcher = undefined;
  }

  const loopFactory = deps.startLoop ?? startLoop;
  const loop = loopFactory({
    state,
    slots,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    loadConfig: () => ({ pollIntervalMs: DEFAULT_POLL_INTERVAL_MS }),
    claim: async () => {
      const claimGitlab = {
        listCandidateIssues: async (opts: {
          activeLabels: string[];
          excludeLabels: string[];
        }) => {
          const issues = await gitlab.listCandidateIssues(opts);
          return Promise.all(
            issues.map(async (issue) => {
              const fullIssue = await gitlab.getIssue(issue.iid);
              return {
                ...fullIssue,
                labels: [...fullIssue.labels],
              };
            }),
          );
        },
        transitionLabels: gitlab.transitionLabels,
      };
      const claimed = await claimCandidates({
        gitlab: claimGitlab,
        state,
        slots,
        activeLabels: workflow.tracker.activeLabels,
        runningLabel: workflow.tracker.runningLabel,
        excludeLabels: [
          workflow.tracker.runningLabel,
          workflow.tracker.handoffLabel,
          workflow.tracker.failedLabel,
          workflow.tracker.blockedLabel,
        ],
        projectId: "default",
        projectName: "Default",
        onClaimError: async ({ issue, error }) => {
          // Spec §21.12 says blocked issues must surface as `ai-blocked`
          // (not silently re-polled). When a permission/auth error trips
          // the claim transition we cannot acquire a slot, but we can:
          //   1. emit a `claim_failed` event so the dashboard sees it;
          //   2. best-effort push the label into `ai-blocked` so the
          //      issue exits the active-label set and stops getting polled.
          const classification = classifyError(error);
          if (classification.kind !== "blocked") return;

          const syntheticRunId = randomUUID();
          runIndex.set(syntheticRunId, runKey(workflow, issue.iid));
          const issueBranch = branchName({
            prefix: workflow.git.branchPrefix,
            iid: issue.iid,
            titleSlug: slugify(issue.title),
          });

          let labelTransitioned = false;
          try {
            await gitlab.transitionLabels(issue.iid, {
              add: [workflow.tracker.blockedLabel],
              remove: [
                workflow.tracker.runningLabel,
                ...workflow.tracker.activeLabels,
              ],
            });
            labelTransitioned = true;
          } catch {
            // Both the claim transition and the blocked transition failed
            // (e.g. the token has no PUT permission anywhere). The label
            // stays as-is, but the `claim_failed` event below still gives
            // operators a visible signal.
          }

          try {
            await createFailureNote(gitlab, issue.iid, {
              runId: syntheticRunId,
              branch: issueBranch,
              classification,
              attempt: 1,
              statusLabel: workflow.tracker.blockedLabel,
              readyLabel: readyLabel(workflow),
            });
          } catch {
            // A token that cannot transition labels may also be unable to
            // write notes. Keep the claim_failed event as the durable signal.
          }

          publishEvent({
            type: "claim_failed",
            runId: syntheticRunId,
            ts: new Date().toISOString(),
            detail: {
              iid: issue.iid,
              issue,
              kind: classification.kind,
              code: classification.code,
              reason: classification.reason,
              labelTransitioned,
              targetLabel: workflow.tracker.blockedLabel,
            },
          });
        },
      });
      for (const c of claimed) {
        runIndex.set(c.runId, runKey(workflow, c.issue.iid));
        // V2.5 Command Center: seed a `RunReportArtifact` at claim time so
        // every downstream stage (reconcile, CI scan, review sweep, failure
        // path) writes onto an existing record instead of guarding for a
        // missing one. Reports live next to events under `.issuepilot/`.
        try {
          const initialReport = createInitialReport({
            runId: c.runId,
            issue: {
              id: c.issue.id,
              iid: c.issue.iid,
              title: c.issue.title,
              url: c.issue.url,
              projectId: c.issue.projectId,
              labels: [...c.issue.labels],
            },
            status: "running",
            attempt: 1,
            branch: branchName({
              prefix: workflow.git.branchPrefix,
              iid: c.issue.iid,
              titleSlug: slugify(c.issue.title),
            }),
            workspacePath: "",
            startedAt: new Date().toISOString(),
          });
          await reportStore.save(initialReport);
        } catch (err) {
          publishEvent({
            type: "report_seed_failed",
            runId: c.runId,
            ts: new Date().toISOString(),
            detail: {
              reason: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      return claimed.map((c) => ({ runId: c.runId }));
    },
    dispatch: async (runId) => {
      const run = state.getRun(runId);
      const issue = run?.["issue"] as
        | {
            id?: string | undefined;
            iid: number;
            title: string;
            url: string;
            projectId: string;
            description?: string | undefined;
            labels?: string[] | undefined;
            author?: string | undefined;
            assignees?: string[] | undefined;
          }
        | undefined;
      if (!issue) throw new Error(`Run not found or missing issue: ${runId}`);

      const projectSlug = slugify(workflow.tracker.projectId);
      const titleSlug = slugify(issue.title);
      const branch = branchName({
        prefix: workflow.git.branchPrefix,
        iid: issue.iid,
        titleSlug,
      });
      state.setRun(runId, { ...run!, branch });

      await dispatch(
        {
          runId,
          issue,
          remoteUrl: workflow.git.repoUrl,
          repoCacheRoot: workflow.workspace.repoCacheRoot,
          worktreeRoot: workflow.workspace.root,
          branch,
          baseBranch: workflow.git.baseBranch,
          runningLabel: workflow.tracker.runningLabel,
          handoffLabel: workflow.tracker.handoffLabel,
          reworkLabel: workflow.tracker.reworkLabel,
          promptTemplate: workflow.promptTemplate,
          hooks: workflow.hooks,
        },
        {
          state,
          maxAttempts: workflow.agent.maxAttempts,
          retryBackoffMs: workflow.agent.retryBackoffMs,
          ensureMirror: async (opts) =>
            ensureMirror({
              repoUrl: opts.remoteUrl,
              projectSlug,
              repoCacheRoot: opts.repoCacheRoot,
            }),
          ensureWorktree: async (opts) => {
            const result = await ensureWorktree({
              mirrorPath: opts.mirrorPath,
              projectSlug,
              issueIid: issue.iid,
              titleSlug,
              baseBranch: opts.baseBranch,
              branchPrefix: workflow.git.branchPrefix,
              workspaceRoot: opts.worktreeRoot,
            });
            return {
              worktreePath: result.workspacePath,
              created: !result.reused,
            };
          },
          runHook: (opts) =>
            runHook({
              cwd: opts.cwd,
              name: opts.name,
              script: opts.script,
              env: opts.env ?? {},
            }),
          renderPrompt: (opts) =>
            workflowLoader.render(
              opts.template,
              opts.vars as unknown as PromptContext,
            ),
          runAgent: async (opts) => {
            const cmd = splitCommand(workflow.codex.command);
            const rpc = spawnRpc({ ...cmd, cwd: opts.cwd });
            const gitlabToolsAdapter = {
              getIssue: async (iid: number) => {
                const fullIssue = await gitlab.getIssue(iid);
                return {
                  ...fullIssue,
                  labels: [...fullIssue.labels],
                };
              },
              transitionLabels: gitlab.transitionLabels,
              createIssueNote: gitlab.createIssueNote,
              updateIssueNote: (
                iid: number,
                noteId: number,
                update: { body: string },
              ) => gitlab.updateIssueNote(iid, noteId, update.body),
              createMergeRequest: gitlab.createMergeRequest,
              updateMergeRequest: gitlab.updateMergeRequest,
              getMergeRequest: gitlab.getMergeRequest,
              listMergeRequestNotes: gitlab.listMergeRequestNotes,
              getPipelineStatus: gitlab.getPipelineStatus,
            };
            try {
              const result = await driveLifecycle({
                rpc,
                maxTurns: workflow.agent.maxTurns,
                prompt: opts.prompt,
                title: issue.title,
                cwd: opts.cwd,
                threadName: `${workflow.tracker.projectId}#${issue.iid}`,
                sandboxType: workflow.codex.threadSandbox,
                approvalPolicy: workflow.codex.approvalPolicy,
                turnSandboxPolicy: workflow.codex.turnSandboxPolicy,
                turnTimeoutMs: workflow.codex.turnTimeoutMs,
                tools: createGitLabTools(gitlabToolsAdapter, {
                  id: issue.id ?? String(issue.iid),
                  iid: issue.iid,
                  title: issue.title,
                  url: issue.url,
                  projectId: issue.projectId,
                  labels: [...(issue.labels ?? [])],
                }),
                onEvent: (type, data) =>
                  publishEvent({
                    type: `codex_${type}`,
                    runId,
                    ts: new Date().toISOString(),
                    detail: { data },
                  }),
                onTurnActive: (cancel) =>
                  runCancelRegistry.register(runId, cancel),
              });
              return {
                status: result.status,
                summary: result.failureReason,
              };
            } finally {
              runCancelRegistry.unregister(runId);
              await rpc.close();
            }
          },
          reconcile: async (opts) => {
            const report = await reportStore.get(opts.runId);
            const result = await reconcile({
              ...opts,
              ...(report ? { report } : {}),
              git: {
                hasNewCommits,
                push: pushBranch,
              },
              gitlab: {
                findMergeRequest: (sourceBranch) =>
                  gitlab.findMergeRequestBySourceBranch(sourceBranch),
                createMergeRequest: (mrOpts) =>
                  gitlab.createMergeRequest({
                    ...mrOpts,
                    issueIid: opts.iid,
                  }),
                updateMergeRequest: (mrIid, updates) =>
                  gitlab.updateMergeRequest(mrIid, updates),
                findWorkpadNote: (issueIid, marker) =>
                  gitlab.findWorkpadNote(issueIid, marker),
                createNote: (issueIid, body) =>
                  gitlab.createIssueNote(issueIid, body),
                updateNote: (issueIid, noteId, body) =>
                  gitlab.updateIssueNote(issueIid, noteId, body),
                transitionLabels: async (iid, labelOpts) => {
                  await gitlab.transitionLabels(iid, labelOpts);
                },
              },
              onEvent: publishEvent,
            });
            if (report) {
              // V2.5 review C1/C2/I2: persist the merged report so the
              // dashboard, future renders, and Markdown exports all see
              // the same agentSummary / agentValidation / agentRisks /
              // noCodeChangeReason / nextAction that we just wrote into
              // the handoff note. Without this writeback the seed
              // "not reported" placeholders would stick in the store
              // even after the note was rendered correctly.
              const merged = mergeAgentHandoffIntoReport(
                report,
                {
                  reworkLabel: opts.reworkLabel,
                  ...(opts.agentSummary !== undefined
                    ? { agentSummary: opts.agentSummary }
                    : {}),
                  ...(opts.agentValidation !== undefined
                    ? { agentValidation: opts.agentValidation }
                    : {}),
                  ...(opts.agentRisks !== undefined
                    ? { agentRisks: opts.agentRisks }
                    : {}),
                  ...(opts.noCodeChangeReason !== undefined
                    ? { noCodeChangeReason: opts.noCodeChangeReason }
                    : {}),
                },
                result.mergeRequest
                  ? {
                      iid: result.mergeRequest.iid,
                      ...(result.mergeRequest.webUrl
                        ? { webUrl: result.mergeRequest.webUrl }
                        : {}),
                    }
                  : null,
              );
              const nextReport = {
                ...merged,
                run: {
                  ...merged.run,
                  ...(opts.workspacePath &&
                  opts.workspacePath !== merged.run.workspacePath
                    ? { workspacePath: opts.workspacePath }
                    : {}),
                },
                notes: {
                  ...merged.notes,
                  ...(result.handoffNoteId !== undefined
                    ? { handoffNoteId: result.handoffNoteId }
                    : {}),
                },
              };
              await reportStore.save(nextReport);
            }
            return result;
          },
          onEvent: publishEvent,
          onFailure: async (_failedRunId, classification, attempt) => {
            const label =
              classification.kind === "blocked"
                ? workflow.tracker.blockedLabel
                : workflow.tracker.failedLabel;
            await gitlab.transitionLabels(issue.iid, {
              add: [label],
              remove: [workflow.tracker.runningLabel],
            });
            // V2.5 Command Center: refresh the report artifact with the final
            // failure status, persist it, and prefer the report-driven
            // failure note so dashboard + GitLab + future Markdown exports
            // share the same wording. Falls back to the legacy
            // createFailureNote path if the report could not be loaded
            // (e.g. an older run that pre-dates V2.5).
            let failedReport: Awaited<ReturnType<typeof reportStore.get>>;
            try {
              const report = await reportStore.get(_failedRunId);
              if (report) {
                failedReport = markReportFailed(report, {
                  status:
                    classification.kind === "blocked" ? "blocked" : "failed",
                  endedAt: new Date().toISOString(),
                  lastError: {
                    code: classification.code,
                    message: classification.reason,
                    classification:
                      classification.kind === "blocked"
                        ? "blocked"
                        : classification.kind === "retryable"
                          ? "failed"
                          : classification.kind,
                  },
                });
                await reportStore.save(failedReport);
              }
            } catch (err) {
              publishEvent({
                type: "report_failure_update_failed",
                runId: _failedRunId,
                ts: new Date().toISOString(),
                detail: {
                  reason: err instanceof Error ? err.message : String(err),
                },
              });
            }
            if (failedReport) {
              await gitlab.createIssueNote(
                issue.iid,
                renderFailureNote(failedReport, {
                  statusLabel: label,
                  readyLabel: readyLabel(workflow),
                }),
              );
            } else {
              await createFailureNote(gitlab, issue.iid, {
                runId: _failedRunId,
                branch,
                classification,
                attempt,
                statusLabel: label,
                readyLabel: readyLabel(workflow),
              });
            }
          },
        },
      );
    },
    scanCiFeedback: workflow.ci.enabled
      ? async () => {
          await scanCiFeedbackOnce({
            state,
            eventBus,
            gitlab: {
              findMergeRequestBySourceBranch:
                gitlab.findMergeRequestBySourceBranch,
              getPipelineStatus: gitlab.getPipelineStatus,
              transitionLabels: gitlab.transitionLabels,
              createIssueNote: gitlab.createIssueNote,
              findWorkpadNote: gitlab.findWorkpadNote,
            },
            workflow: {
              tracker: {
                handoffLabel: workflow.tracker.handoffLabel,
                reworkLabel: workflow.tracker.reworkLabel,
              },
              ci: workflow.ci,
            },
            reports: reportStore,
          });
        }
      : undefined,
    // V2 Phase 5: workspace retention sweep. Each tick we honour the
    // workflow `retention.cleanup_interval_ms` (defaults to one hour);
    // when the interval has elapsed since the last sweep, the executor
    // walks `workflow.workspace.root`, builds a `CleanupPlan` from
    // RuntimeState + retention policy, and rm's expired terminal
    // workspaces. Per-entry failures stay confined to a single
    // `workspace_cleanup_failed` event so the rest of the loop is
    // unaffected. Result usage / next-ETA is stashed on the closures
    // above so `/api/state` and the dashboard service header can show
    // them without polling the filesystem.
    cleanup: {
      runOnce: async () => {
        const result = await runWorkspaceCleanupOnce({
          workspaceRoot: workflow.workspace.root,
          state,
          retention: workflow.retention,
          eventBus,
        });
        // I3: report post-sweep usage. `totalBytes` is the enumeration
        // snapshot before any `rm`; reporting it would leave the
        // dashboard quoting a stale pre-cleanup number for up to
        // `cleanupIntervalMs`. `totalBytesAfter` subtracts the bytes
        // of every workspace the executor actually removed.
        lastWorkspaceUsageGb = result.totalBytesAfter / 1024 ** 3;
        nextWorkspaceCleanupAt = new Date(
          Date.now() + workflow.retention.cleanupIntervalMs,
        ).toISOString();
      },
      intervalMs: workflow.retention.cleanupIntervalMs,
    },
    // V2 Phase 4: always-on review feedback sweep. The plan deliberately
    // does not introduce a `reviewSweep.enabled` toggle yet; sweeping a
    // run that has no MR is a no-op (emits `no_mr` and moves on), so
    // there is no downside to running it on every tick. If a future
    // deployment needs to disable it (e.g. a self-hosted GitLab with a
    // notes-list outage), we can introduce the toggle without breaking
    // existing workflow files.
    sweepReviewFeedback: async () => {
      await sweepReviewFeedbackOnce({
        state,
        eventBus,
        gitlab: {
          findMergeRequestBySourceBranch: gitlab.findMergeRequestBySourceBranch,
          listMergeRequestNotes: gitlab.listMergeRequestNotes,
        },
        workflow: {
          tracker: {
            handoffLabel: workflow.tracker.handoffLabel,
          },
        },
        reports: reportStore,
      });
    },
    reconcileRunning: async () => {
      const runningLabel = workflow.tracker.runningLabel;
      const failedLabel = workflow.tracker.failedLabel;
      const blockedLabel = workflow.tracker.blockedLabel;
      await reconcileHumanReview({
        handoffLabel: workflow.tracker.handoffLabel,
        reworkLabel: workflow.tracker.reworkLabel,
        gitlab: {
          listHumanReviewIssues: async () => {
            const issues = await gitlab.listCandidateIssues({
              activeLabels: [workflow.tracker.handoffLabel],
              excludeLabels: [runningLabel, failedLabel, blockedLabel],
            });
            return Promise.all(
              issues.map(async (issue) => {
                const fullIssue = await gitlab.getIssue(issue.iid);
                return {
                  ...fullIssue,
                  labels: [...fullIssue.labels],
                };
              }),
            );
          },
          findLatestIssuePilotWorkpadNote:
            gitlab.findLatestIssuePilotWorkpadNote,
          listMergeRequestsBySourceBranch:
            gitlab.listMergeRequestsBySourceBranch,
          getIssue: async (iid) => {
            const fullIssue = await gitlab.getIssue(iid);
            return {
              ...fullIssue,
              labels: [...fullIssue.labels],
            };
          },
          createIssueNote: gitlab.createIssueNote,
          closeIssue: gitlab.closeIssue,
          transitionLabels: gitlab.transitionLabels,
        },
        onEvent: publishHumanReviewEvent,
      });
    },
    logError: (err) => {
      console.error(err);
    },
  });

  let stopped = false;
  let resolveStopped: (() => void) | undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    await loop.stop();
    await watcher?.stop();
    await app.close();
    // V4.7 review N-2:在退出前 drain batched event store,避免最后一批
    // 缓冲事件因 setTimeout 还没触发而被丢弃(timer 在 dispose 里被显式
    // 清掉,Node 进程才能干净退出)。
    await eventStore.dispose();
    resolveStopped?.();
  }

  const handleSignal = (): void => {
    void stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    state,
    stop,
    wait: () => stoppedPromise,
  };
}

export async function validateWorkflow(
  workflowPath: string,
): Promise<WorkflowConfig> {
  const workflowLoader = createWorkflowLoader();
  return workflowLoader.loadOnce(path.resolve(workflowPath));
}

export async function checkCodexAppServer(): Promise<string> {
  const result = await execa("codex", ["--version"]);
  return result.stdout.trim() || "available";
}
