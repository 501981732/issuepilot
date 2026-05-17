import { randomUUID } from "node:crypto";

import type { TaskNode, WorkItem } from "@issuepilot/shared-contracts";
import { branchName, slugify } from "@issuepilot/workspace";

import type { DispatchInput } from "../orchestrator/dispatch.js";
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
   * Underlying dispatcher. Production wires this to a closure that
   * builds the V4.1-shaped {@link DispatchDeps} (synthetic-run-aware
   * `onFailure` that does NOT touch the parent Issue label / note —
   * see daemon.ts `buildSyntheticDispatchDeps`) at call time, after
   * the shim has minted `runId` and `branch`. Tests inject a fake.
   *
   * The deps slice is intentionally NOT a separate parameter on the
   * shim: doing so would force the daemon to construct deps before
   * `runTaskOnce` returns the `runId`, but several deps fields
   * (`runAgent`, `reconcile`, `onFailure`) close over `runId` and
   * `branch`. Keeping deps construction inside the dispatch closure
   * lets the daemon mint runId/branch first and then build the deps
   * around them.
   */
  dispatch: (input: DispatchInput) => Promise<void>;
  /** Test seam for deterministic ids. */
  newRunId?: () => string;
  /** Test seam for deterministic clocks. */
  now?: () => string;
  /**
   * V4.2 branch chaining: when set, the dispatch input uses this branch
   * as the base instead of `workflow.git.baseBranch`. Typically
   * `origin/<upstream-task-branch>` so the downstream worktree includes
   * the upstream patch even if its MR has not been merged yet.
   */
  baseOverride?: string;
  /**
   * V4.2 branch chaining: when set, the upstream taskId whose branch is
   * being chained off. Threaded through `extraPromptVars.workItem.chainedFrom`
   * so prompt templates can render "this task is based on upstream task X".
   */
  chainedFrom?: string;
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
  //
  // We deliberately keep `issue.title` set to the **parent** Issue title
  // (not the task title): the runtime-state record represents the run
  // against the parent Issue, and downstream consumers (dashboard run
  // list, claim path) expect to see the parent title there. The task
  // title flows separately via `extraPromptVars.workItem.taskTitle`.
  opts.state.setRun(runId, {
    runId,
    status: "claimed",
    attempt: 1,
    issue: {
      iid: opts.workItem.sourceIssue.iid,
      title: opts.workItem.sourceIssue.title,
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
    baseBranch: opts.baseOverride ?? opts.workflow.git.baseBranch,
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
        ...(opts.chainedFrom ? { chainedFrom: opts.chainedFrom } : {}),
      },
    },
    ...(opts.workflow.hooks ? { hooks: opts.workflow.hooks } : {}),
  };

  await opts.dispatch(input);

  return { runId, branch };
}
