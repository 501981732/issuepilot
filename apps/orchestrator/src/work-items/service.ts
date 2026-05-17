import { randomUUID } from "node:crypto";

import type {
  AcceptWorkItemPlanRequest,
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemReport,
  WorkItemStatus,
} from "@issuepilot/shared-contracts";

import type { WorkItemService, WorkItemServiceError } from "../server/index.js";

import { aggregateWorkItem, type AggregateDeps } from "./aggregate.js";
import {
  decideParentLabelTransition,
  writeParentHandoff,
  type ParentHandoffDeps,
  type ParentHandoffWorkflow,
} from "./handoff.js";
import { applyTaskRunFinal, tickWorkItem } from "./orchestration.js";
import { validatePlanDraft } from "./plan-validation.js";
import type { WorkItemPlanner } from "./planner.js";
import type { WorkItemStore } from "./store.js";

/**
 * V4.1 Workflow Spine façade glueing planner / store / orchestration /
 * aggregate / handoff together for the daemon's HTTP surface. Lives in
 * the work-items domain rather than `daemon.ts` so the wiring stays
 * unit-testable without spinning up the whole daemon.
 *
 * This module is intentionally synchronous on its happy path beyond
 * what the underlying store/orchestration require — the API expects
 * "click button -> response" semantics, and tickWorkItem decides
 * whether to actually dispatch task runs (it may schedule zero of
 * them when concurrency is exhausted; that is normal V4.1 behaviour).
 */

export interface WorkItemServiceDeps {
  store: WorkItemStore;
  planner: WorkItemPlanner;
  /**
   * Issue oracle. Used by `planFromIssue` to fetch the source Issue
   * fields (title / description / labels) — we don't trust dashboard
   * input for these.
   */
  fetchIssue(iid: number): Promise<{
    iid: number;
    title: string;
    description: string;
    url: string;
    projectId: string;
    labels: string[];
  }>;
  /**
   * tickWorkItem-equivalent that the daemon supplies. Hidden behind a
   * function so the service does not have to know about concurrency
   * slots / dispatch wiring. Returns whatever tickWorkItem returns so
   * the caller can log how many tasks were dispatched.
   */
  tick(workItem: WorkItem): Promise<void>;
  /**
   * Run aggregation + handoff for one WorkItem. Daemon owns the
   * label-mode transition rules; this service just asks for it.
   */
  reconcileWorkItem(workItemId: string): Promise<void>;
  emit(event: {
    type: string;
    runId?: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void;
  now?(): string;
  newId?(): string;
}

export function createWorkItemService(
  deps: WorkItemServiceDeps,
): WorkItemService {
  const now = (): string => deps.now?.() ?? new Date().toISOString();
  const newId = (): string => deps.newId?.() ?? `wi_${randomUUID()}`;

  async function buildDetail(
    id: string,
  ): Promise<WorkItemDetailResponse | undefined> {
    const wi = await deps.store.getWorkItem(id);
    if (!wi) return undefined;
    const current = await deps.store.getCurrentPlan(id);
    const history = await deps.store.listPlanHistory(id);
    if (!current) {
      return undefined;
    }
    const runLinks = await deps.store.listAllTaskRunLinks(id);
    const report = await deps.store.getReport(id);
    return {
      workItem: wi,
      plan: { current, history },
      tasks: current.tasks,
      runLinks,
      ...(report ? { report } : {}),
    };
  }

  return {
    async planFromIssue({ iid, regenerate, operator }) {
      let issue;
      try {
        issue = await deps.fetchIssue(iid);
      } catch (err) {
        return errorResult(
          "gitlab_failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      // Look up an existing WorkItem for this Issue so re-planning re-uses
      // the same workItemId / parent Issue label history.
      const existing = await findWorkItemByIid(deps.store, issue.projectId, iid);
      const workItemId = existing?.workItemId ?? newId();
      const ts = now();

      const draft = await deps.planner.draft({ issue, workItemId });
      if (!draft.ok) {
        const code =
          draft.code === "planner_parse_failed" ||
          draft.code === "planner_call_failed"
            ? "planner_failed"
            : draft.code.startsWith("too_") || draft.code.startsWith("dependency_")
              ? "validation_failed"
              : "planner_failed";
        deps.emit({
          type: "work_item_planning_failed",
          ts,
          detail: {
            workItemId,
            iid,
            code: draft.code,
            message: draft.message,
            operator,
          },
        });
        return errorResult(code, draft.message);
      }

      // Mark the existing draft (if any) as superseded when operator regenerates.
      if (existing && regenerate) {
        const prevPlan = await deps.store.getCurrentPlan(existing.workItemId);
        if (prevPlan && prevPlan.status === "draft") {
          await deps.store.saveTaskPlan({ ...prevPlan, status: "superseded" });
          deps.emit({
            type: "work_item_plan_regenerated",
            ts,
            detail: {
              workItemId: existing.workItemId,
              previousPlanId: prevPlan.planId,
              operator,
            },
          });
        }
      }

      const planVersion = existing
        ? ((await deps.store.listPlanHistory(existing.workItemId)).reduce(
            (max, p) => Math.max(max, p.version),
            0,
          ) + 1)
        : 1;

      const plan: TaskPlan = {
        ...draft.plan,
        workItemId,
        version: planVersion,
      };
      await deps.store.saveTaskPlan(plan);

      const wi: WorkItem = existing
        ? {
            ...existing,
            taskIds: plan.tasks.map((t) => t.taskId),
            status: "planning",
            updatedAt: ts,
          }
        : {
            workItemId,
            sourceIssue: {
              projectId: issue.projectId,
              iid: issue.iid,
              url: issue.url,
              title: issue.title,
            },
            title: issue.title,
            goal: deriveGoal(issue.description),
            acceptanceCriteria: deriveAcceptanceCriteria(issue.description),
            status: "planning",
            taskIds: plan.tasks.map((t) => t.taskId),
            createdAt: ts,
            updatedAt: ts,
          };
      await deps.store.saveWorkItem(wi);

      deps.emit({
        type: existing ? "work_item_plan_drafted" : "work_item_created",
        ts,
        detail: {
          workItemId: wi.workItemId,
          iid,
          planId: plan.planId,
          taskCount: plan.tasks.length,
          operator,
        },
      });

      return { workItem: wi, plan };
    },

    async list() {
      return deps.store.listWorkItems();
    },

    async detail(id) {
      return buildDetail(id);
    },

    async acceptPlan({ planId, edits, operator, workItemId }) {
      const wi = await deps.store.getWorkItem(workItemId);
      if (!wi) return errorResult("not_found", "work item not found");
      const plan = await deps.store.getCurrentPlan(workItemId);
      if (!plan || plan.planId !== planId) {
        return errorResult("not_found", "plan not found");
      }
      if (plan.status === "accepted") {
        return errorResult("invalid_status", "plan is already accepted");
      }

      const ts = now();
      const editedTasks = applyEdits(plan.tasks, edits);

      // V4.1 review I1: re-validate the post-edit plan. operator edits
      // can introduce dependency cycles, unknown deps, empty titles or
      // duplicate taskIds — all of which would slip past the planner's
      // validatePlanDraft otherwise (which only ran on the LLM draft).
      // Without this guard `acceptPlan` would persist a structurally
      // broken plan and then orchestration / aggregate would behave
      // unpredictably (computeReadyTasks loops forever on cycles, etc).
      if (edits.length > 0) {
        const v = validatePlanDraft(editedTasks);
        if (!v.ok) {
          return errorResult(
            "validation_failed",
            `Operator edit ${v.code}: ${v.message}`,
          );
        }
      }

      const operatorEdits = edits.map((e) => ({
        taskId: e.taskId,
        field: e.field,
        before:
          (plan.tasks.find((t) => t.taskId === e.taskId) as
            | Record<string, unknown>
            | undefined)?.[e.field] ?? null,
        after: e.after,
        by: operator,
        at: ts,
      }));

      const accepted: TaskPlan = {
        ...plan,
        tasks: editedTasks,
        operatorEdits: [...plan.operatorEdits, ...operatorEdits],
        dependencies: editedTasks.flatMap((t) =>
          t.dependsOn.map((from) => ({ from, to: t.taskId })),
        ),
        status: "accepted",
        acceptedAt: ts,
      };
      await deps.store.saveTaskPlan(accepted);

      const updatedWorkItem: WorkItem = {
        ...wi,
        status: "ready",
        taskIds: accepted.tasks.map((t) => t.taskId),
        updatedAt: ts,
      };
      await deps.store.saveWorkItem(updatedWorkItem);

      deps.emit({
        type: "work_item_plan_accepted",
        ts,
        detail: {
          workItemId,
          planId: accepted.planId,
          version: accepted.version,
          editCount: edits.length,
          operator,
        },
      });

      // Kick the orchestration tick so independent (zero-dep) tasks
      // start dispatching right away.
      await deps.tick(updatedWorkItem);

      return { workItem: updatedWorkItem, plan: accepted };
    },

    async regeneratePlan(id, operator) {
      const wi = await deps.store.getWorkItem(id);
      if (!wi) return errorResult("not_found", "work item not found");
      const result = await this.planFromIssue({
        iid: wi.sourceIssue.iid,
        regenerate: true,
        operator,
      });
      return result;
    },

    async skipTask(workItemId, taskId, operator) {
      const wi = await deps.store.getWorkItem(workItemId);
      if (!wi) return errorResult("not_found", "work item not found");
      const plan = await deps.store.getCurrentPlan(workItemId);
      if (!plan) return errorResult("not_found", "plan not found");
      const task = plan.tasks.find((t) => t.taskId === taskId);
      if (!task) return errorResult("not_found", "task not found");

      const ts = now();
      const nextTasks: TaskNode[] = plan.tasks.map((t) =>
        t.taskId === taskId
          ? {
              ...t,
              status: "skipped",
              statusReason: `Skipped by ${operator}`,
            }
          : t,
      );
      await deps.store.saveTaskPlan({ ...plan, tasks: nextTasks });
      deps.emit({
        type: "task_run_skipped",
        ts,
        detail: { workItemId, taskId, operator },
      });
      await deps.reconcileWorkItem(workItemId);
      return { ok: true } as const;
    },

    async retryTask(workItemId, taskId, operator) {
      const wi = await deps.store.getWorkItem(workItemId);
      if (!wi) return errorResult("not_found", "work item not found");
      const plan = await deps.store.getCurrentPlan(workItemId);
      if (!plan) return errorResult("not_found", "plan not found");
      const task = plan.tasks.find((t) => t.taskId === taskId);
      if (!task) return errorResult("not_found", "task not found");

      const ts = now();
      const nextTasks: TaskNode[] = plan.tasks.map((t) => {
        if (t.taskId !== taskId) return t;
        const { statusReason: _ignored, ...rest } = t;
        return { ...rest, status: "ready" as const };
      });
      await deps.store.saveTaskPlan({ ...plan, tasks: nextTasks });
      deps.emit({
        type: "task_run_dispatched",
        ts,
        detail: { workItemId, taskId, operator, retried: true },
      });
      await deps.tick(wi);
      return { ok: true } as const;
    },

    async replanTask({ workItemId, taskId, reason, hint, operator }) {
      const wi = await deps.store.getWorkItem(workItemId);
      if (!wi) return errorResult("not_found", "work item not found");
      const prev = await deps.store.getCurrentPlan(workItemId);
      if (!prev) return errorResult("not_found", "plan not found");
      const targetIndex = prev.tasks.findIndex((t) => t.taskId === taskId);
      if (targetIndex < 0) return errorResult("not_found", "task not found");
      if (prev.status !== "accepted") {
        return errorResult(
          "invalid_status",
          "current plan must be accepted before single-task replan; use regeneratePlan for drafts",
        );
      }

      let issue;
      try {
        issue = await deps.fetchIssue(wi.sourceIssue.iid);
      } catch (err) {
        return errorResult(
          "gitlab_failed",
          err instanceof Error ? err.message : String(err),
        );
      }

      const draft = await deps.planner.draft({
        issue,
        workItemId,
        replanScope: {
          taskId,
          reason,
          ...(hint !== undefined ? { hint } : {}),
        },
      });
      const ts = now();
      if (!draft.ok) {
        const code =
          draft.code === "replan_returned_multi" ||
          draft.code === "replan_task_id_mismatch" ||
          draft.code === "missing_title" ||
          draft.code === "missing_goal"
            ? "validation_failed"
            : draft.code === "planner_parse_failed" ||
                draft.code === "planner_call_failed"
              ? "planner_failed"
              : "planner_failed";
        deps.emit({
          type: "work_item_planning_failed",
          ts,
          detail: {
            workItemId,
            taskId,
            replan: true,
            code: draft.code,
            message: draft.message,
            operator,
          },
        });
        return errorResult(code, draft.message);
      }

      const replanned = draft.plan.tasks[0]!;
      const previousTask = prev.tasks[targetIndex]!;
      // V4.2: replaced task keeps its prior runIds (canonical historical
      // evidence) plus prior `needsReworkReason`. Other fields come from
      // planner output. Status resets to `planned` so orchestration can
      // re-dispatch through the standard ready computation.
      const mergedTask: TaskNode = {
        ...replanned,
        runIds: [...previousTask.runIds],
        status: "planned",
      };
      const nextTasks: TaskNode[] = prev.tasks.map((t, i) =>
        i === targetIndex ? mergedTask : t,
      );

      // Mark previous accepted plan as superseded.
      await deps.store.saveTaskPlan({ ...prev, status: "superseded" });

      const replanEdit = {
        taskId,
        field: "replan" as const,
        before: previousTask,
        after: mergedTask,
        by: operator,
        at: ts,
      };

      const planVersion =
        (await deps.store.listPlanHistory(workItemId)).reduce(
          (max, p) => Math.max(max, p.version),
          0,
        ) + 1;
      const newPlan: TaskPlan = {
        planId: draft.plan.planId,
        workItemId,
        version: planVersion,
        tasks: nextTasks,
        dependencies: nextTasks.flatMap((t) =>
          t.dependsOn.map((from) => ({ from, to: t.taskId })),
        ),
        operatorEdits: [...prev.operatorEdits, replanEdit],
        status: "draft",
        replanOf: { planId: prev.planId, taskId },
      };
      await deps.store.saveTaskPlan(newPlan);

      const updatedWi: WorkItem = {
        ...wi,
        taskIds: newPlan.tasks.map((t) => t.taskId),
        updatedAt: ts,
      };
      await deps.store.saveWorkItem(updatedWi);

      deps.emit({
        type: "task_replanned",
        ts,
        detail: {
          workItemId,
          taskId,
          previousPlanId: prev.planId,
          newPlanId: newPlan.planId,
          version: planVersion,
          reason,
          operator,
        },
      });

      return { workItem: updatedWi, plan: newPlan };
    },

    async markNeedsRework() {
      // Implemented in task 9.
      return errorResult("not_implemented", "markNeedsRework not implemented");
    },

    async unskipTask() {
      // Implemented in task 10.
      return errorResult("not_implemented", "unskipTask not implemented");
    },

    async graph() {
      // Implemented in task 11.
      return errorResult("not_implemented", "graph not implemented");
    },

    async report(id) {
      return deps.store.getReport(id);
    },
  };
}

function errorResult(code: string, message: string): WorkItemServiceError {
  return { error: { code, message } };
}

async function findWorkItemByIid(
  store: WorkItemStore,
  projectId: string,
  iid: number,
): Promise<WorkItem | undefined> {
  const all = await store.listWorkItems();
  return all.find(
    (wi) => wi.sourceIssue.projectId === projectId && wi.sourceIssue.iid === iid,
  );
}

function applyEdits(
  tasks: TaskNode[],
  edits: AcceptWorkItemPlanRequest["edits"],
): TaskNode[] {
  if (edits.length === 0) return tasks;
  return tasks.map((t) => {
    const taskEdits = edits.filter((e) => e.taskId === t.taskId);
    if (taskEdits.length === 0) return t;
    let next: TaskNode = { ...t };
    for (const edit of taskEdits) {
      next = applyEdit(next, edit);
    }
    return next;
  });
}

function applyEdit(
  task: TaskNode,
  edit: AcceptWorkItemPlanRequest["edits"][number],
): TaskNode {
  switch (edit.field) {
    case "title":
      return { ...task, title: String(edit.after) };
    case "goal":
      return { ...task, goal: String(edit.after) };
    case "scope":
      return { ...task, scope: String(edit.after) };
    case "dependsOn":
      return {
        ...task,
        dependsOn: Array.isArray(edit.after)
          ? edit.after.map((v) => String(v))
          : task.dependsOn,
      };
    case "suggestedValidation":
      return {
        ...task,
        suggestedValidation: Array.isArray(edit.after)
          ? edit.after.map((v) => String(v))
          : task.suggestedValidation,
      };
    default:
      return task;
  }
}

function deriveGoal(description: string): string {
  const trimmed = (description || "").trim();
  if (trimmed.length === 0) return "(no description provided)";
  // Spec §16.2 leaves goal extraction loose for V4.1; just take the
  // first 280 chars so the parent Issue note has _something_.
  return trimmed.slice(0, 280);
}

function deriveAcceptanceCriteria(description: string): string[] {
  const list: string[] = [];
  const lines = (description || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]\s+|\d+\.\s+|AC\d+[:.]?\s*)(.+)$/);
    if (m && m[1]) list.push(m[1].trim());
  }
  return list;
}

/**
 * Daemon-facing helper that, given a finished synthetic task run's
 * RunReport, walks the orchestration → aggregate → handoff path and
 * persists every artifact involved.
 *
 * Lives next to {@link createWorkItemService} so the daemon does not
 * have to import all of orchestration / aggregate / handoff directly.
 */
export interface SettleTaskRunDeps {
  store: WorkItemStore;
  aggregateDeps: AggregateDeps;
  parentHandoff: ParentHandoffDeps;
  workflow: ParentHandoffWorkflow;
  emit(event: {
    type: string;
    runId?: string;
    ts: string;
    detail: Record<string, unknown>;
  }): void;
  now?(): string;
  saveTaskRunLink(link: Parameters<WorkItemStore["saveTaskRunLink"]>[0]): Promise<void>;
  saveTaskNode(taskId: string, patch: Partial<TaskNode>): Promise<void>;
}

export async function settleTaskRunFinal(
  input: {
    workItemId: string;
    taskId: string;
    runId: string;
    runReport: RunReportArtifact;
  },
  deps: SettleTaskRunDeps,
): Promise<{
  workItem: WorkItem | undefined;
  report: WorkItemReport | undefined;
}> {
  const ts = deps.now?.() ?? new Date().toISOString();
  // Reuse orchestration.applyTaskRunFinal for the link / node patch.
  await applyTaskRunFinal(input, {
    availableSlots: () => 0,
    getRunReport: deps.aggregateDeps.getRunReport,
    dispatchTask: async () => {
      throw new Error("dispatchTask should not be called from applyTaskRunFinal");
    },
    saveTaskRunLink: deps.saveTaskRunLink,
    saveTaskNode: deps.saveTaskNode,
    emit: deps.emit,
    now: () => ts,
  });

  const wi = await deps.store.getWorkItem(input.workItemId);
  if (!wi) return { workItem: undefined, report: undefined };
  const plan = await deps.store.getCurrentPlan(input.workItemId);
  if (!plan) return { workItem: wi, report: undefined };
  const links = await deps.store.listAllTaskRunLinks(input.workItemId);

  const report = await aggregateWorkItem(wi, plan, links, deps.aggregateDeps);
  await deps.store.saveReport(report);
  deps.emit({
    type: "work_item_aggregated",
    ts,
    detail: {
      workItemId: wi.workItemId,
      overallStatus: report.overallStatus,
    },
  });

  // Decide the next WorkItem.status so handoff can drive the parent
  // label state machine (spec §9.0).
  const previousStatus = wi.status;
  const nextStatus = decideWorkItemStatus(report.overallStatus, plan, links);
  const updated: WorkItem = {
    ...wi,
    status: nextStatus,
    summaryReportId: report.workItemId,
    updatedAt: ts,
  };
  await deps.store.saveWorkItem(updated);

  await writeParentHandoff({
    workItem: updated,
    plan,
    report,
    previousStatus,
    workflow: deps.workflow,
    deps: deps.parentHandoff,
  });

  return { workItem: updated, report };
}

/**
 * V4.1 §9.0 status state machine. Translates an aggregate `overallStatus`
 * (which is a property of the *report*) into a `WorkItemStatus` (which
 * is a property of the *work item* and drives the parent Issue label
 * transition via `decideParentLabelTransition`).
 *
 * Exported for the daemon's `reconcileWorkItem` (operator skip / retry
 * paths) so it can run the same status update + handoff sequence
 * `settleTaskRunFinal` runs on dispatch_completed events. Without this
 * shared helper the two paths would drift; concrete bug observed in
 * V4.1 review: `reconcileWorkItem` never advanced WorkItem.status
 * before calling writeParentHandoff, so `previousStatus === currentStatus`
 * and the parent label never transitioned to `human-review` after a
 * skip.
 *
 * Mapping (review I2 fix replaces the dead-code `running ? "running" :
 * "running"` ternary with an explicit comment that documents intent):
 *   - complete   → "completed"
 *   - incomplete → "running"
 *     (incomplete = at least one task's RunReportArtifact is missing
 *     because the task either hasn't dispatched yet, is still running,
 *     or its report failed to persist. We always return "running" so
 *     the parent label flips to `ai-running` as soon as orchestration
 *     starts producing reports — operators want to see "in flight" on
 *     the parent Issue rather than waiting for every task to settle.
 *     A truly stuck WorkItem will eventually land on `partial` /
 *     `blocked` once enough tasks fail, at which point the operator
 *     gets a different label.)
 *   - partial    → "blocked" if every task ended blocked/failed,
 *     otherwise "partial".
 */
export function decideWorkItemStatus(
  overall: WorkItemReport["overallStatus"],
  plan: TaskPlan,
  _links: Parameters<WorkItemStore["saveTaskRunLink"]>[0][] | Awaited<
    ReturnType<WorkItemStore["listAllTaskRunLinks"]>
  >,
): WorkItemStatus {
  if (overall === "complete") return "completed";
  if (overall === "incomplete") return "running";
  // partial
  const allBlocked = plan.tasks.every(
    (t) => t.status === "blocked" || t.status === "failed",
  );
  return allBlocked ? "blocked" : "partial";
}

/**
 * `tickWorkItem` exported for daemon use so it can drive orchestration
 * outside of API requests (poll loop, retry path).
 */
export { tickWorkItem };

/**
 * Re-export for daemon-level imports so the wiring surface stays
 * `work-items/service` instead of fanning out to multiple files.
 */
export { decideParentLabelTransition };
