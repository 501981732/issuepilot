"use client";

import type {
  AgentReport,
  AgentReportSummary,
  GetPipelineResponse,
  MarkTaskReworkRequest,
  ReplanTaskRequest,
  TaskPlanEdit,
  WorkItem,
  WorkItemDetailResponse,
  WorkItemEvidenceResponse,
  WorkItemGraphResponse,
} from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";

import {
  acceptWorkItemPlan,
  confirmWorkItemTaskEvidence,
  getWorkItem,
  getWorkItemEvidence,
  getWorkItemGraph,
  markWorkItemTaskRework,
  regenerateWorkItemPlan,
  replanWorkItemTask,
  retryWorkItemTask,
  skipWorkItemTask,
  unskipWorkItemTask,
} from "../../lib/api";
import { cn } from "../../lib/cn";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

import { AgentReportTabs } from "./agent-report-tabs";
import { EvidenceTab } from "./evidence-tab";
import { ParentReviewPacket } from "./parent-review-packet";
import { PipelineProgress } from "./pipeline-progress";
import { PlanEditor } from "./plan-editor";
import { RecipeSelector } from "./recipe-selector";
import { TaskGraph } from "./task-graph";
import { TaskList } from "./task-list";
import { ViewToggle, type WorkItemView } from "./view-toggle";

const STATUS_TONE: Record<WorkItem["status"], string> = {
  planning: "bg-info-soft text-info-fg",
  ready: "bg-warning-soft text-warning-fg",
  running: "bg-info-soft text-info-fg",
  partial: "bg-warning-soft text-warning-fg",
  completed: "bg-success-soft text-success-fg",
  blocked: "bg-danger-soft text-danger-fg",
};

export interface WorkItemDetailProps {
  initial: WorkItemDetailResponse;
  /** Operator name written into edit/skip/retry headers; defaults to "operator". */
  operator?: string;
  /**
   * V4.2: initial view (list/graph). Persisted by the page in the URL
   * `?view=` so refresh + share-link round-trips work. Defaults to
   * `list` when not provided.
   */
  initialView?: WorkItemView;
  /** Team-mode project id resolved from SSR cookie; used before client hydration. */
  project?: string;
  /**
   * V4.6 Multi-Agent Pipeline integration（plan Task 11.6 / 11.7）。
   * 由 SSR 页面并行 fetch 后传入；若工作单元没有 V4.6 数据 → undefined。
   * - `pipelinesByTask` 当前活跃 task 的最新 PipelineRun + agentReports 摘要。
   * - `agentReportsByTask` 当前活跃 task 三 role 的完整 AgentReport，供
   *   AgentReportTabs 渲染。
   */
  pipelinesByTask?: Record<string, GetPipelineResponse>;
  agentReportsByTask?: Record<
    string,
    Partial<Record<AgentReport["role"], AgentReport>>
  >;
}

export function WorkItemDetail({
  initial,
  operator = "operator",
  initialView = "list",
  project,
  pipelinesByTask,
  agentReportsByTask,
}: WorkItemDetailProps) {
  const t = useTranslations("workItem");
  const [data, setData] = useState<WorkItemDetailResponse>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [view, setView] = useState<WorkItemView>(initialView);
  const [graph, setGraph] = useState<WorkItemGraphResponse | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<WorkItemEvidenceResponse | null>(
    null,
  );
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const refresh = useCallback((next: WorkItemDetailResponse) => {
    setData(next);
  }, []);

  const reload = useCallback(async () => {
    const next = await getWorkItem(
      data.workItem.workItemId,
      project ? { project } : {},
    );
    startTransition(() => refresh(next));
  }, [data.workItem.workItemId, project, refresh]);

  const handleAccept = useCallback(
    async ({
      edits,
    }: {
      edits: Array<Omit<TaskPlanEdit, "at" | "by"> & { by: string }>;
    }) => {
      setBusy(true);
      setError(null);
      try {
        await acceptWorkItemPlan(
          data.workItem.workItemId,
          {
            planId: data.plan.current.planId,
            operator,
            edits: edits.map((e) => ({
              taskId: e.taskId,
              field: e.field,
              after: e.after,
            })),
          },
          { operator },
        );
        await reload();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [data.plan.current.planId, data.workItem.workItemId, operator, reload],
  );

  const handleRegenerate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await regenerateWorkItemPlan(data.workItem.workItemId, { operator });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [data.workItem.workItemId, operator, reload]);

  const handleSkip = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await skipWorkItemTask(data.workItem.workItemId, taskId, { operator });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleRetry = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await retryWorkItemTask(data.workItem.workItemId, taskId, { operator });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleReplan = useCallback(
    async (taskId: string, body: ReplanTaskRequest) => {
      setError(null);
      try {
        await replanWorkItemTask(data.workItem.workItemId, taskId, body, {
          operator,
        });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleMarkRework = useCallback(
    async (taskId: string, body: MarkTaskReworkRequest) => {
      setError(null);
      try {
        await markWorkItemTaskRework(data.workItem.workItemId, taskId, body, {
          operator,
        });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  const handleUnskip = useCallback(
    async (taskId: string) => {
      setError(null);
      try {
        await unskipWorkItemTask(data.workItem.workItemId, taskId, {
          operator,
        });
        await reload();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [data.workItem.workItemId, operator, reload],
  );

  // V4.3：把当前 view 写回 URL，这样 share-link / 刷新都能落到同一视图。
  // 用 history.replaceState 而不是 router.replace 是为了避免触发 SSR 重渲染
  // — view 切换是纯客户端状态，不需要重新调 getWorkItem。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (view === "list") {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", view);
    }
    if (
      url.search !== window.location.search ||
      url.pathname !== window.location.pathname
    ) {
      window.history.replaceState(null, "", url.toString());
    }
  }, [view]);

  // Fetch the graph projection lazily — only when the operator switches
  // to the Graph view. Switching back to List does not invalidate the
  // cached projection so toggling is snappy.
  useEffect(() => {
    if (view !== "graph") return;
    let cancelled = false;
    setGraphError(null);
    getWorkItemGraph(data.workItem.workItemId)
      .then((next) => {
        if (!cancelled) setGraph(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setGraphError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, data.workItem.workItemId]);

  useEffect(() => {
    if (view !== "evidence") return;
    let cancelled = false;
    setEvidenceError(null);
    getWorkItemEvidence(data.workItem.workItemId, project ? { project } : {})
      .then((next) => {
        if (!cancelled) setEvidence(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEvidenceError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, data.workItem.workItemId, project]);

  const handleConfirmEvidence = useCallback(
    async (taskId: string, evidenceId: string) => {
      setError(null);
      try {
        await confirmWorkItemTaskEvidence(
          data.workItem.workItemId,
          taskId,
          evidenceId,
          { operator, ...(project ? { project } : {}) },
        );
        const [nextEvidence] = await Promise.all([
          getWorkItemEvidence(
            data.workItem.workItemId,
            project ? { project } : {},
          ),
          reload(),
        ]);
        setEvidence(nextEvidence);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      }
    },
    [data.workItem.workItemId, operator, project, reload],
  );

  const wi = data.workItem;
  const planAccepted = data.plan.current.status === "accepted";

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-6 lg:px-8 lg:py-8">
      <header
        aria-label={t("headerAria", { id: wi.workItemId })}
        className="flex flex-col gap-2"
      >
        <Link
          href="/work-items"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-fg-subtle hover:underline"
        >
          {t("backLink")}
        </Link>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-fg">
          {wi.title}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
              STATUS_TONE[wi.status],
            )}
          >
            {wi.status}
          </span>
          <a
            href={wi.sourceIssue.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[11px] text-fg-subtle hover:underline"
          >
            {t("field.issue")}: #{wi.sourceIssue.iid}
          </a>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("field.updatedAt")}: {wi.updatedAt}
          </span>
        </div>
        {wi.blockedReason ? (
          <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg">
            {wi.blockedReason}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger-fg"
          >
            {error}
          </p>
        ) : null}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("field.goal")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-fg">
          <p>{wi.goal || "—"}</p>
          {wi.acceptanceCriteria.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                {t("field.acceptance")}
              </span>
              <ul className="list-disc pl-5 text-sm text-fg-muted">
                {wi.acceptanceCriteria.map((ac, i) => (
                  <li key={i}>{ac}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <PlanEditor
        plan={data.plan.current}
        operator={operator}
        busy={busy}
        onAccept={handleAccept}
        onRegenerate={handleRegenerate}
      />

      {planAccepted ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-end">
            <ViewToggle view={view} onChange={setView} />
          </div>
          {view === "list" ? (
            <>
              <TaskList
                tasks={data.tasks}
                runLinks={data.runLinks}
                onSkip={handleSkip}
                onRetry={handleRetry}
                onReplan={handleReplan}
                onMarkRework={handleMarkRework}
                onUnskip={handleUnskip}
                actionsEnabled
              />
              {pipelinesByTask ? (
                <V46PipelineSections
                  tasks={data.tasks}
                  workItemId={data.workItem.workItemId}
                  pipelinesByTask={pipelinesByTask}
                  agentReportsByTask={agentReportsByTask ?? {}}
                />
              ) : null}
            </>
          ) : view === "evidence" ? (
            evidence ? (
              <EvidenceTab
                workItemId={data.workItem.workItemId}
                evidence={evidence}
                project={project}
                onConfirm={handleConfirmEvidence}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>{t("evidenceTab.ariaLabel")}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-fg-subtle">
                    {evidenceError ?? t("evidenceTab.empty")}
                  </p>
                </CardContent>
              </Card>
            )
          ) : graph ? (
            <TaskGraph graph={graph} tasks={data.tasks} />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>{t("taskGraph.title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-fg-subtle">
                  {graphError ?? t("taskGraph.empty")}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

      {planAccepted ? (
        <ParentReviewPacket report={data.report} project={project} />
      ) : null}
    </div>
  );
}

/**
 * V4.6 pipeline 区段（plan Task 11.6）。遍历当前可见 task：只展开有
 * pipeline 数据的 task 节，其余的 task 节继续走原生 TaskList 渲染。每个
 * task 节包含 PipelineProgress + RecipeSelector + AgentReportTabs。
 *
 * 这块刻意做成"附加"在 TaskList 下方，而不是直接挂到 task 节点行里，方便
 * 渐进式上线：当 daemon 没有 V4.6 数据时 `pipelinesByTask` 为 undefined，
 * 整段不渲染（向后兼容 V4.5 dashboard 路径）。
 */
function V46PipelineSections({
  tasks,
  workItemId,
  pipelinesByTask,
  agentReportsByTask,
}: {
  tasks: WorkItemDetailResponse["tasks"];
  workItemId: string;
  pipelinesByTask: Record<string, GetPipelineResponse>;
  agentReportsByTask: Record<
    string,
    Partial<Record<AgentReport["role"], AgentReport>>
  >;
}) {
  const tasksWithPipeline = tasks.filter(
    (t) => pipelinesByTask[t.taskId]?.pipelineRun,
  );
  if (tasksWithPipeline.length === 0) return null;
  return (
    <div className="space-y-4" data-component="v46-pipeline-sections">
      {tasksWithPipeline.map((task) => {
        const pipeline = pipelinesByTask[task.taskId]!;
        const reports = agentReportsByTask[task.taskId] ?? {};
        const locked = [
          "running_coding",
          "running_reviewer",
          "running_test_evidence",
          "awaiting_human_review",
          "awaiting_rework",
          "partial",
          "failed",
          "cancelled",
        ].includes(pipeline.pipelineRun?.status ?? "");
        return (
          <section
            key={task.taskId}
            data-task-id={task.taskId}
            className="space-y-2"
          >
            <h4 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {task.title}
            </h4>
            <PipelineProgress
              pipelineRun={pipeline.pipelineRun}
              agentReports={pipeline.agentReports as AgentReportSummary[]}
              pendingRecipe={pipeline.pendingRecipe}
            />
            <RecipeSelector
              workItemId={workItemId}
              taskId={task.taskId}
              currentRecipe={pipeline.pipelineRun?.recipe ?? "full_pipeline"}
              currentSource={
                pipeline.pipelineRun?.recipeSource ?? "workflow_default"
              }
              pendingRecipe={pipeline.pendingRecipe}
              locked={locked}
            />
            <AgentReportTabs reports={reports} />
          </section>
        );
      })}
    </div>
  );
}
