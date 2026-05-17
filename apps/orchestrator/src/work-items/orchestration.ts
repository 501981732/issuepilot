import type {
  RunReportArtifact,
  TaskNode,
  TaskNodeStatus,
  TaskPlan,
  TaskRunLink,
  WorkItem,
} from "@issuepilot/shared-contracts";

import type { EffectiveBaseDecision } from "./branch-chain.js";

/**
 * V4.1 Workflow Spine orchestration.
 *
 * Spec §11 (主流程) splits the WorkItem lifecycle into three concerns:
 *
 *  1. **Compute** which tasks are eligible to run right now ({@link
 *     computeReadyTasks}). A pure function over the plan / link state /
 *     "is upstream merged?" oracle, easy to unit test.
 *  2. **Dispatch** ready tasks while honouring shared concurrency slots
 *     ({@link tickWorkItem}). Uses the dispatch-task shim under the
 *     hood; emits `task_run_dispatched` and `task_run_blocked_by_dependency`
 *     events so the dashboard stays in sync.
 *  3. **Settle** a finished synthetic task run by translating its
 *     RunReport into a TaskRunLink + TaskNode status update
 *     ({@link applyTaskRunFinal}).
 *
 * Why not collapse these into a single function? Because the daemon
 * drives them at different times: tickWorkItem runs on a poll loop and
 * on plan acceptance, while applyTaskRunFinal runs as a reaction to
 * `dispatch_completed` / `dispatch_failed` events. Splitting them keeps
 * each concern reasoning about a small, explicit slice of state.
 *
 * Concurrency policy (spec §11):
 *  - V4.1 does NOT introduce per-WorkItem quotas; ready tasks share
 *    the global `agent.maxConcurrentAgents` slot pool with every other
 *    V2.x dispatch path. tickWorkItem stops dispatching once
 *    `availableSlots()` is exhausted; the leftover ready tasks come
 *    back next tick.
 *  - tickWorkItem does NOT decrement slots itself. The daemon owns the
 *    slot ledger; orchestration just queries it. This avoids a class
 *    of bugs where a crashed orchestration tick leaves slots held.
 *
 * Idempotency (spec §11.4):
 *  - A task that already has a TaskRunLink in `running` (or claimed)
 *    state is excluded from `computeReadyTasks`, so re-running tick
 *    after a transient error never produces a duplicate dispatch.
 *  - applyTaskRunFinal is safe to call multiple times for the same
 *    runId: the resulting TaskRunLink is keyed by `(taskId, runId)`
 *    and the TaskNode patch is value-idempotent.
 */
export interface OrchestrationDeps {
  /**
   * How many dispatch slots can be claimed right now. Implemented by the
   * daemon's shared `createConcurrencySlots` ledger. tickWorkItem polls
   * this once per call and dispatches at most that many tasks.
   */
  availableSlots(): number;

  /**
   * Resolve the latest RunReportArtifact for a given runId. Used to
   * answer "is the upstream MR merged?" before letting a downstream
   * task move from `blocked_by_dependency` to `ready`. Returning
   * `undefined` is treated as "not merged yet" by the upstream check.
   */
  getRunReport(runId: string): Promise<RunReportArtifact | undefined>;

  /**
   * Actually start the synthetic task run. Production wires this to
   * {@link import("./dispatch-task.js").runTaskOnce}; tests inject a
   * deterministic fake. Returning the runId lets tickWorkItem stamp
   * the TaskRunLink immediately so a follow-up tick (before the agent
   * even returns) sees the task as in-flight.
   *
   * V4.2 adds the optional `baseOverride` + `chainedFrom` options so
   * single-upstream chaining can dispatch a downstream task that bases
   * off the upstream branch instead of `workflow.git.baseBranch`. The
   * decision lives in {@link decideEffectiveBase}; tickWorkItem just
   * forwards the answer.
   */
  dispatchTask(
    task: TaskNode,
    options?: { baseOverride?: string; chainedFrom?: string },
  ): Promise<{ runId: string; branch: string }>;

  /**
   * V4.2: returns the effective base branch decision for a ready task.
   * Optional so existing callers (tests pre-dating chaining) keep
   * working — when absent, tickWorkItem behaves like V4.1 and uses the
   * caller-supplied `upstreamMerged` semantics (default base only).
   *
   * Production daemon wires this to
   * {@link import("./branch-chain.js").decideEffectiveBase}; tests can
   * inject a fake to assert the dispatch path without exercising
   * branch-chain internals.
   */
  decideEffectiveBase?(input: {
    task: TaskNode;
    plan: TaskPlan;
    links: TaskRunLink[];
  }): Promise<EffectiveBaseDecision>;

  /** Persist a TaskRunLink update. */
  saveTaskRunLink(link: TaskRunLink): Promise<void>;

  /**
   * Persist a TaskNode-level status update. The patch is intentionally
   * shallow so callers do not have to reconstruct the full TaskNode;
   * the store layer merges with the existing node from the current
   * TaskPlan.
   */
  saveTaskNode(taskId: string, patch: Partial<TaskNode>): Promise<void>;

  /**
   * Emit a typed event into the daemon bus. Event types are constrained
   * by `EVENT_TYPE_VALUES` in `@issuepilot/shared-contracts`; we keep
   * this typed loosely on purpose so orchestration does not have to
   * import the entire event union.
   */
  emit(event: {
    type: string;
    runId?: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void;

  now?(): string;
}

export interface TickResult {
  dispatched: Array<{ taskId: string; runId: string; branch: string }>;
  /** Tasks that stayed `blocked_by_dependency` because upstream MR isn't merged. */
  blockedByDependency: string[];
  /** Tasks that were ready but did not get a slot this tick. */
  blockedBySlots: string[];
}

export interface ApplyTaskRunFinalInput {
  workItemId: string;
  taskId: string;
  runId: string;
  runReport: RunReportArtifact;
}

export interface ApplyTaskRunFinalResult {
  taskStatus: TaskNodeStatus;
}

/**
 * V4.1 §11.4: A TaskNode is eligible to dispatch only when:
 *
 *   1. Its current status is one of `planned` / `ready` /
 *      `blocked_by_dependency` (i.e. it has not yet completed, failed
 *      out, or been skipped). `needs_rework` is intentionally excluded;
 *      the operator has to retry it explicitly.
 *   2. No active TaskRunLink exists for it (`running` or `claimed`).
 *      Re-dispatch happens via the operator retry path, which writes a
 *      fresh runId and clears the old link.
 *   3. No completed TaskRunLink exists for it. A completed run means
 *      the task is done — even if its TaskNode lags one tick behind on
 *      status, we must not dispatch it again.
 *   4. Every entry in `dependsOn` reports `upstreamMerged(taskId) ===
 *      true`. The "merged" predicate is supplied by the caller because
 *      reading MR state is async I/O.
 */
export function computeReadyTasks(
  plan: TaskPlan,
  links: TaskRunLink[],
  upstreamMerged: (taskId: string) => boolean,
): TaskNode[] {
  const linksByTask = new Map<string, TaskRunLink[]>();
  for (const link of links) {
    const arr = linksByTask.get(link.taskId);
    if (arr) arr.push(link);
    else linksByTask.set(link.taskId, [link]);
  }

  const ready: TaskNode[] = [];
  for (const t of plan.tasks) {
    if (!isStatusEligibleForReady(t.status)) continue;
    const taskLinks = linksByTask.get(t.taskId) ?? [];
    // TaskRunLink.status is a TaskNodeStatus; "claimed" is not in that
    // vocabulary because the link is only persisted once we have a real
    // TaskNode-level state (running / completed / failed / blocked).
    // The runtime-state RunRecord may pass through "claimed" briefly
    // inside dispatch-task, but at the orchestration layer "running" is
    // the only in-flight signal we need to gate on.
    if (taskLinks.some((l) => l.status === "running")) continue;
    if (taskLinks.some((l) => l.status === "completed")) continue;
    if (!t.dependsOn.every((dep) => upstreamMerged(dep))) continue;
    ready.push(t);
  }
  return ready;
}

/**
 * V4.2: `needs_rework` and `skipped` are explicit operator states —
 * operator must call `retryTask` / `unskipTask` to bring them back to
 * `ready`. `completed` / `failed` / `blocked` are terminal: re-running
 * them requires an explicit retry path (which writes a fresh runId).
 * `running` is in-flight. So the only "eligible" statuses for the
 * automatic ready computation are the three below.
 */
function isStatusEligibleForReady(status: TaskNodeStatus): boolean {
  return (
    status === "planned" ||
    status === "ready" ||
    status === "blocked_by_dependency"
  );
}

/**
 * Drive one orchestration tick for a single WorkItem.
 *
 * Steps (all observable via the returned {@link TickResult} so callers
 * can log or surface to the dashboard):
 *
 *  1. Build the upstream-merged predicate by looking at every
 *     `completed` TaskRunLink and asking the report store for its MR
 *     state. Only `mergeRequest.state === "merged"` unblocks downstream
 *     tasks; an `opened` MR keeps them parked.
 *  2. Compute ready tasks via {@link computeReadyTasks}.
 *  3. For each ready task:
 *     - If `availableSlots()` returned 0 by the time we get here, push
 *       the task into `blockedBySlots` and stop dispatching.
 *     - Otherwise call `dispatchTask`, persist a `running` TaskRunLink,
 *       flip the TaskNode to `running`, and emit `task_run_dispatched`.
 *  4. Tasks that stayed blocked because upstream wasn't merged are
 *     returned in `blockedByDependency` and emit
 *     `task_run_blocked_by_dependency` so the dashboard can show why.
 */
export async function tickWorkItem(
  workItem: WorkItem,
  plan: TaskPlan,
  links: TaskRunLink[],
  deps: OrchestrationDeps,
): Promise<TickResult> {
  const ts = deps.now?.() ?? new Date().toISOString();

  // Build "upstream ready for chaining" map. V4.1 only allowed downstream to
  // proceed when the upstream MR was actually merged. V4.2 broadens this:
  // when `decideEffectiveBase` is wired, an `completed` upstream counts as
  // ready-for-chaining (we then look up the per-task effective base below
  // to decide whether to use the default base or chain off the upstream
  // branch). When `decideEffectiveBase` is absent (V4.1 callers / tests
  // pre-dating chaining), we fall back to the strict "must be merged"
  // semantics so behaviour is unchanged.
  const chainingEnabled = typeof deps.decideEffectiveBase === "function";
  const upstreamMergedMap = new Map<string, boolean>();
  const completedLinks = links.filter((l) => l.status === "completed");
  for (const link of completedLinks) {
    if (upstreamMergedMap.get(link.taskId) === true) continue;
    const report = await deps.getRunReport(link.runId);
    const merged = report?.mergeRequest?.state === "merged";
    upstreamMergedMap.set(
      link.taskId,
      (upstreamMergedMap.get(link.taskId) ?? false) || merged,
    );
  }
  const upstreamMergedOrChainable = (taskId: string): boolean => {
    if (upstreamMergedMap.get(taskId) === true) return true;
    if (!chainingEnabled) return false;
    // 上游 task 在 plan 上是 completed 即视为「链可用」；最终是真 chain
    // 还是 default-base 由 decideEffectiveBase 决定。
    const upstreamNode = plan.tasks.find((t) => t.taskId === taskId);
    return upstreamNode?.status === "completed";
  };

  const ready = computeReadyTasks(plan, links, upstreamMergedOrChainable);

  // Identify tasks that stayed blocked because upstream isn't ready
  // — useful for the dashboard, and emits a one-time event per tick.
  const blockedByDependency: string[] = [];
  for (const t of plan.tasks) {
    if (t.status !== "blocked_by_dependency" && t.status !== "planned") {
      continue;
    }
    if (t.dependsOn.length === 0) continue;
    if (t.dependsOn.every((dep) => upstreamMergedOrChainable(dep))) continue;
    blockedByDependency.push(t.taskId);
  }

  const dispatched: TickResult["dispatched"] = [];
  const blockedBySlots: string[] = [];

  let slots = deps.availableSlots();
  for (const t of ready) {
    // V4.2: ask the chaining oracle whether to dispatch with default base
    // or chain off an upstream branch. When the oracle returns "blocked"
    // we keep the task in blocked_by_dependency for this tick.
    let decision: EffectiveBaseDecision = {
      kind: "default-base",
      baseBranch: "",
    };
    if (deps.decideEffectiveBase) {
      decision = await deps.decideEffectiveBase({ task: t, plan, links });
    }
    if (decision.kind === "blocked") {
      if (!blockedByDependency.includes(t.taskId)) {
        blockedByDependency.push(t.taskId);
      }
      continue;
    }

    if (slots <= 0) {
      blockedBySlots.push(t.taskId);
      continue;
    }
    slots -= 1;

    const dispatchOpts: { baseOverride?: string; chainedFrom?: string } = {};
    if (decision.kind === "chain-from-upstream") {
      dispatchOpts.baseOverride = decision.baseBranch;
      dispatchOpts.chainedFrom = decision.upstreamTaskId;
    }
    const { runId, branch } = await deps.dispatchTask(t, dispatchOpts);
    dispatched.push({ taskId: t.taskId, runId, branch });

    await deps.saveTaskRunLink({
      taskId: t.taskId,
      runId,
      attempt: 1,
      status: "running",
      branch,
      startedAt: ts,
    });
    await deps.saveTaskNode(t.taskId, { status: "running" });
    deps.emit({
      type: "task_run_dispatched",
      runId,
      ts,
      detail: {
        workItemId: workItem.workItemId,
        taskId: t.taskId,
        branch,
        ...(dispatchOpts.chainedFrom
          ? { chainedFrom: dispatchOpts.chainedFrom }
          : {}),
        ...(dispatchOpts.baseOverride
          ? { baseOverride: dispatchOpts.baseOverride }
          : {}),
      },
    });
  }

  // Emit blocked_by_dependency events at the end so chaining-induced
  // blocked tasks (from decideEffectiveBase) are also surfaced.
  for (const taskId of blockedByDependency) {
    deps.emit({
      type: "task_run_blocked_by_dependency",
      ts,
      detail: { workItemId: workItem.workItemId, taskId },
    });
  }

  return { dispatched, blockedByDependency, blockedBySlots };
}

/**
 * Translate a finished synthetic task run's RunReport into TaskRunLink
 * + TaskNode state. Called by the daemon when it observes
 * `dispatch_completed` / `dispatch_failed` for a runId that has a
 * `workItem` back-pointer.
 *
 * Mapping (spec §11.5):
 *
 *   - run.completed → task.completed (downstream still waits on MR
 *     merge; that's a `computeReadyTasks` concern, not ours).
 *   - run.failed    → task.failed (siblings keep running; the WorkItem
 *     aggregator will mark `partial` once everything settles).
 *   - run.blocked   → task.blocked (operator decides whether to retry,
 *     skip, or re-plan).
 *   - everything else → task.running (transient). The daemon should not
 *     normally call us for non-terminal states, but we accept it
 *     defensively rather than throwing.
 *
 * Event policy: `task_run_completed` / `task_run_failed`. There is no
 * `task_run_blocked` in the V4.1 event vocabulary; a run-level `blocked`
 * is surfaced as `task_run_failed` with `status: "blocked"` in the
 * detail so observers can still distinguish it. (The
 * `task_run_blocked_by_dependency` event is reserved for the
 * "upstream not merged" case in tickWorkItem.)
 */
export async function applyTaskRunFinal(
  input: ApplyTaskRunFinalInput,
  deps: OrchestrationDeps,
): Promise<ApplyTaskRunFinalResult> {
  const ts = deps.now?.() ?? new Date().toISOString();
  const taskStatus = mapRunStatusToTaskStatus(input.runReport.run.status);

  const link: TaskRunLink = {
    taskId: input.taskId,
    runId: input.runId,
    attempt: input.runReport.run.attempt,
    status: taskStatus,
    reportId: input.runId,
    branch: input.runReport.run.branch,
    ...(input.runReport.mergeRequest
      ? {
          mergeRequest: {
            iid: input.runReport.mergeRequest.iid,
            url: input.runReport.mergeRequest.url,
          },
        }
      : {}),
    startedAt: input.runReport.run.startedAt,
    ...(input.runReport.run.endedAt
      ? { completedAt: input.runReport.run.endedAt }
      : {}),
  };
  await deps.saveTaskRunLink(link);

  const patch: Partial<TaskNode> = { status: taskStatus };
  const reason = input.runReport.run.lastError?.message?.trim();
  if (reason && (taskStatus === "failed" || taskStatus === "blocked")) {
    patch.statusReason = reason;
  }
  await deps.saveTaskNode(input.taskId, patch);

  const eventType =
    taskStatus === "completed" ? "task_run_completed" : "task_run_failed";
  deps.emit({
    type: eventType,
    runId: input.runId,
    ts,
    detail: {
      workItemId: input.workItemId,
      taskId: input.taskId,
      status: taskStatus,
      ...(input.runReport.mergeRequest
        ? {
            mergeRequest: {
              iid: input.runReport.mergeRequest.iid,
              url: input.runReport.mergeRequest.url,
              state: input.runReport.mergeRequest.state,
            },
          }
        : {}),
    },
  });

  return { taskStatus };
}

function mapRunStatusToTaskStatus(
  status: RunReportArtifact["run"]["status"],
): TaskNodeStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "claimed":
    case "running":
    case "retrying":
    case "stopping":
      return "running";
    default:
      return "running";
  }
}
