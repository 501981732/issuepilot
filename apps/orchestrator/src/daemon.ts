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
  createEventBus,
  createEventStore,
  redact,
  type EventBus,
} from "@issuepilot/observability";
import {
  createGitLabTools,
  driveLifecycle,
  spawnRpc,
} from "@issuepilot/runner-codex-app-server";
import type {
  IssuePilotInternalEvent,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";
import {
  createGitLabAdapter,
  createGitLabAdapterFromCredential,
  type GitLabAdapter,
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
import { buildQualitySummary } from "./quality/aggregate.js";
import { collectQualitySources } from "./quality/collect.js";
import { createInitialReport, markReportFailed } from "./reports/lifecycle.js";
import { renderFailureNote } from "./reports/render.js";
import { createReportStore } from "./reports/store.js";
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
 * Tokenize a `codex.command` string into `{ command, args[] }`. Supports
 * single + double quoted segments so paths containing spaces survive the
 * trip from the workflow YAML through to `execa`. Without this, an absolute
 * path like `/Users/User Name/.local/bin/codex` would be split into three
 * tokens by the previous `split(/\s+/)` and `execa` would try to spawn
 * `/Users/User`.
 *
 * Rules (intentionally a subset of POSIX shell):
 *   - Whitespace separates tokens.
 *   - `"…"` and `'…'` create a single token; the surrounding quotes are
 *     stripped. Escapes are NOT honoured inside quotes — keep paths simple.
 *   - Unbalanced quotes throw, matching the bash behaviour of refusing to
 *     execute the line.
 */
export function splitCommand(command: string): {
  command: string;
  args: string[];
} {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new Error(
      `codex.command has an unbalanced ${quote} quote: ${command}`,
    );
  }
  if (inToken) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error("codex.command must not be empty");
  }
  const [cmd, ...args] = tokens;
  return { command: cmd!, args };
}

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
  const eventStore = createEventStore(
    path.join(workflow.workspace.root, ".issuepilot", "events"),
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
  const improvementService = createImprovementService({
    store: improvementStore,
    buildQualitySummary: async (input) => {
      const collected = await collectQualitySources({
        metadata: { workflow: path.basename(workflowPath) },
        reports: reportStore,
        workItems: workItemStore,
      });
      return buildQualitySummary({
        items: collected.items,
        filters: {
          from:
            input.filters?.from ??
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: input.filters?.to ?? new Date().toISOString(),
          window: input.filters?.window ?? "7d",
          ...(input.filters?.workflow ? { workflow: input.filters.workflow } : {}),
          ...(input.filters?.taskType ? { taskType: input.filters.taskType } : {}),
          ...(input.filters?.status ? { status: input.filters.status } : {}),
          ...(input.filters?.pattern ? { pattern: input.filters.pattern } : {}),
        },
        scope: { mode: "single-project" },
        diagnostics: collected.diagnostics,
      });
    },
  });
  const workItemPlanner =
    deps.workItemPlanner ?? createDefaultWorkItemPlanner();
  const taskRunIndex = new Map<
    string,
    { workItemId: string; taskId: string }
  >();
  const runIndex = new Map<string, { projectSlug: string; issueIid: number }>();
  const runCancelRegistry = createRunCancelRegistry();

  /**
   * Resolve GitLab credentials before the server starts taking traffic. The
   * order is:
   *
   *   1. Test seam (`deps.createGitLab`) — kept for the existing in-memory
   *      e2e tests that drive the daemon entirely with fakes.
   *   2. Credential resolver (env var or `~/.issuepilot/credentials`) →
   *      adapter that knows how to refresh on 401.
   *
   * Failing fast here is intentional: spec §17 says the daemon should
   * refuse to start when neither credential source is available, with a
   * pointer at `issuepilot auth login`.
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
    const issueIid =
      existing?.issueIid ??
      (typeof run?.["issue"] === "object" &&
      run["issue"] !== null &&
      "iid" in run["issue"]
        ? Number((run["issue"] as { iid: unknown }).iid)
        : undefined);
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
      if (!evidenceChanged && !followUpsChanged) return;

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
      await reportStore.save(patchedReport);
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
      await tickWorkItemImpl(wi, plan, links, {
        availableSlots: () => slots.available(),
        getRunReport: (runId) => reportStore.get(runId),
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
