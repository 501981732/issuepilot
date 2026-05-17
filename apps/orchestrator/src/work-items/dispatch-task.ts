import { randomUUID } from "node:crypto";

import type { TaskNode, WorkItem } from "@issuepilot/shared-contracts";
import { branchName, slugify } from "@issuepilot/workspace";

import type { DispatchDeps, DispatchInput } from "../orchestrator/dispatch.js";
import type { RuntimeState } from "../runtime/state.js";

/**
 * V4.1 Workflow Spine: thin shim that turns a {@link WorkItem} +
 * {@link TaskNode} pair into a synthetic "task run" by reusing the V2.x
 * dispatch path.
 *
 * Why a separate shim instead of teaching dispatch about WorkItems:
 *
 *  - dispatch is the V2.x runtime contract used by `claim → dispatch →
 *    reconcile` for plain Issues; it must keep working unchanged for
 *    callers that have no concept of WorkItems.
 *  - V4.1 task runs (a) get their own `runId` not minted by `claim`,
 *    (b) name branches per task, not per Issue, (c) must NOT touch the
 *    parent Issue label (`parentIssueLabelMode: "suppressed"`), and
 *    (d) need `workItem.*` template vars for the planner-shaped prompt.
 *
 * The shim therefore:
 *
 *  1. Mints a fresh `runId` and seeds the runtime state with a
 *     `RunRecord(status="claimed")` carrying both the parent Issue ref
 *     and a `workItem: { workItemId, taskId }` back-pointer. The latter
 *     lets the daemon resolve `dispatch_completed` events back to the
 *     owning task without re-deriving from branch names — that pattern
 *     was deliberately rejected in spec §7.V4.1 ("TaskRunLink is the
 *     canonical task↔run binding, not branch reverse-engineering").
 *  2. Constructs the {@link DispatchInput} with a task-aware branch
 *     (`<branch_prefix>/<iid>-<task-slug>`), `parentIssueLabelMode:
 *     "suppressed"`, and `extraPromptVars.workItem` (so templates can
 *     reference `{{ workItem.taskScope }}` etc.).
 *  3. Delegates to whichever `dispatch` function the caller injected.
 *     Production wires the real `dispatch` from `orchestrator/dispatch.ts`;
 *     unit tests inject a fake to capture inputs.
 *
 * The shim itself does NOT write `task_run_dispatched` events; that
 * belongs to the orchestration layer (`work-items/orchestration.ts`)
 * which decides _when_ to call this shim. Keeping the event policy
 * outside this layer avoids double-emission from retries / replays.
 */
export interface DispatchTaskWorkflow {
  git: {
    repoUrl: string;
    baseBranch: string;
    branchPrefix: string;
  };
  workspace: {
    root: string;
    repoCacheRoot: string;
  };
  tracker: {
    runningLabel: string;
    handoffLabel: string;
    reworkLabel: string;
  };
  hooks?: DispatchInput["hooks"];
}

export interface RunTaskOnceOptions {
  workItem: WorkItem;
  task: TaskNode;
  workflow: DispatchTaskWorkflow;
  /** Liquid template forwarded to the dispatch render step. */
  promptTemplate: string;
  /** Runtime state where the synthetic RunRecord is stamped. */
  state: RuntimeState;
  /**
   * Underlying dispatcher. Production wires `dispatch` from
   * `orchestrator/dispatch.ts`. Tests inject a fake to assert inputs.
   * Keeping this as a function (not the deps slice) keeps the shim
   * unaware of mirror / worktree / runner construction.
   */
  dispatch: (input: DispatchInput, deps: DispatchDeps) => Promise<void>;
  /**
   * Deps slice passed straight through to the underlying dispatcher.
   * The shim does not synthesise these; they belong to the daemon.
   */
  deps: DispatchDeps;
  /** Test seam for deterministic ids. */
  newRunId?: () => string;
  /** Test seam for deterministic clocks. */
  now?: () => string;
}

export interface RunTaskOnceResult {
  runId: string;
  branch: string;
}

export async function runTaskOnce(
  opts: RunTaskOnceOptions,
): Promise<RunTaskOnceResult> {
  const runId = opts.newRunId?.() ?? randomUUID();
  const ts = opts.now?.() ?? new Date().toISOString();

  const titleSlug = slugify(opts.task.title);
  const branch = branchName({
    prefix: opts.workflow.git.branchPrefix,
    iid: opts.workItem.sourceIssue.iid,
    titleSlug,
  });

  // RunEntry's open shape lets us stash V4.1 metadata before the
  // shared-contracts `RunRecord.workItem` field lands in task 13. The
  // daemon can read it via `state.getRun(runId)["workItem"]`.
  opts.state.setRun(runId, {
    runId,
    status: "claimed",
    attempt: 1,
    issue: {
      iid: opts.workItem.sourceIssue.iid,
      title: opts.task.title,
      url: opts.workItem.sourceIssue.url,
      projectId: opts.workItem.sourceIssue.projectId,
      labels: [],
    },
    branch,
    workspacePath: "",
    workItem: {
      workItemId: opts.workItem.workItemId,
      taskId: opts.task.taskId,
    },
    startedAt: ts,
    updatedAt: ts,
  });

  const dependenciesSummary =
    opts.task.dependsOn.length === 0
      ? "no upstream tasks"
      : `depends on: ${opts.task.dependsOn.join(", ")}`;

  const input: DispatchInput = {
    runId,
    issue: {
      iid: opts.workItem.sourceIssue.iid,
      title: opts.workItem.sourceIssue.title,
      url: opts.workItem.sourceIssue.url,
      projectId: opts.workItem.sourceIssue.projectId,
    },
    remoteUrl: opts.workflow.git.repoUrl,
    repoCacheRoot: opts.workflow.workspace.repoCacheRoot,
    worktreeRoot: opts.workflow.workspace.root,
    branch,
    baseBranch: opts.workflow.git.baseBranch,
    runningLabel: opts.workflow.tracker.runningLabel,
    handoffLabel: opts.workflow.tracker.handoffLabel,
    reworkLabel: opts.workflow.tracker.reworkLabel,
    promptTemplate: opts.promptTemplate,
    parentIssueLabelMode: "suppressed",
    extraPromptVars: {
      workItem: {
        workItemId: opts.workItem.workItemId,
        taskId: opts.task.taskId,
        taskTitle: opts.task.title,
        taskGoal: opts.task.goal,
        taskScope: opts.task.scope,
        suggestedValidation: opts.task.suggestedValidation,
        dependsOn: opts.task.dependsOn,
        dependenciesSummary,
        riskLevel: opts.task.riskLevel,
      },
    },
    ...(opts.workflow.hooks ? { hooks: opts.workflow.hooks } : {}),
  };

  await opts.dispatch(input, opts.deps);

  return { runId, branch };
}
