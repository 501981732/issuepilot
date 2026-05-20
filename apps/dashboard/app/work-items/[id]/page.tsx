import type {
  AgentReport,
  AgentReportSummary,
  GetAgentReportResponse,
  GetPipelineResponse,
} from "@issuepilot/shared-contracts";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { WorkItemDetail } from "../../../components/work-items/work-item-detail";
import { PROJECT_COOKIE_KEY } from "../../../lib/active-project-cookie";
import {
  ApiError,
  getAgentReport,
  getPipeline,
  getWorkItem,
} from "../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// V4.6 follow-up Important #8: SSR 当一个工作单元有很多 task 时会同时打出
// N 个 pipeline + 最多 3N 个 agent-report 请求；不限流时 orchestrator 连接
// 池会被打爆，SSR P95 时延爆炸。统一通过 withConcurrency(8) 给两阶段限流。
// 8 与 orchestrator 单实例的合理并发上限对齐，且足以让 SSR 不空转。
const CONCURRENT = 8;

async function withConcurrency<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrent = CONCURRENT,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrent) {
    const slice = items.slice(i, i + concurrent);
    const batch = await Promise.allSettled(slice.map(worker));
    for (const r of batch) {
      if (r.status === "fulfilled") {
        out.push(r.value);
      } else {
        // worker 已经把 ApiError(404/400) 转成 soft null/skip，到达此处的
        // rejection 一定是 transport / 编程错误，必须冒泡，与替换前的无界
        // `Promise.all` 失败语义保持一致；allSettled 只是确保一个 batch
        // 内的多个失败不会互相吞噬调用栈。
        throw r.reason;
      }
    }
  }
  return out;
}

export default async function WorkItemDetailRoute(props: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string }>;
}) {
  const { id } = await props.params;
  const sp = props.searchParams ? await props.searchParams : {};
  const initialView =
    sp.view === "graph" || sp.view === "evidence" ? sp.view : "list";
  // V4.2 team-mode: the orchestrator requires `x-issuepilot-project`
  // on every work-item route when `workItemsByProject` is wired. SSR
  // can't read the operator's localStorage, so ProjectSwitcher mirrors
  // the selection into a cookie that this Server Component reads here.
  // Without this the team-mode SSR fetch returns HTTP 400
  // `project_header_required` and the detail page renders an error
  // instead of the work item.
  const project = cookies().get(PROJECT_COOKIE_KEY)?.value;
  try {
    const detail = await getWorkItem(id, project ? { project } : {});
    // V4.6 plan Task 11.7：并行 fetch 每个 task 的 PipelineRun 摘要 +
    // 三 role 完整 AgentReport。orchestrator 在 V4.5 之前的工作单元上
    // 没有 V4.6 数据，会返回 404 `pipeline_run_not_found` / `agent_report_not_found`，
    // 这里 fail soft → 静默把对应 task 留空，UI 自动回退到旧路径。
    const opts = project ? { project } : {};
    const taskIds = detail.tasks.map((t) => t.taskId);
    const pipelinePairs = await withConcurrency(
      taskIds,
      async (taskId): Promise<[string, GetPipelineResponse | null]> => {
        try {
          const res = await getPipeline(id, taskId, opts);
          return [taskId, res];
        } catch (err) {
          if (
            err instanceof ApiError &&
            (err.status === 404 || err.status === 400)
          ) {
            return [taskId, null];
          }
          throw err;
        }
      },
    );
    const pipelinesByTask = Object.fromEntries(
      pipelinePairs.filter(
        (entry): entry is [string, GetPipelineResponse] =>
          entry[1] !== null && entry[1].pipelineRun !== null,
      ),
    );
    // 把所有 task 的「活跃 agent-report 摘要」摊平成一份请求列表，再一次性
    // 走 withConcurrency(8)，避免某个 task 内 supersede 链尾 fan-out 触发
    // 局部无界 Promise.all。
    const agentReportFetches: {
      taskId: string;
      summary: AgentReportSummary;
    }[] = [];
    for (const [taskId, pipeline] of Object.entries(pipelinesByTask)) {
      for (const summary of pipeline.agentReports.filter(
        (s) => !s.supersededBy,
      )) {
        agentReportFetches.push({ taskId, summary });
      }
    }
    const agentReportEntries = await withConcurrency(
      agentReportFetches,
      async ({ taskId, summary }) => {
        try {
          const reportDetail: GetAgentReportResponse = await getAgentReport(
            summary.agentReportId,
            opts,
          );
          return {
            taskId,
            role: reportDetail.agentReport.role,
            report: reportDetail.agentReport,
          } as const;
        } catch (err) {
          if (
            err instanceof ApiError &&
            (err.status === 404 || err.status === 400)
          ) {
            return null;
          }
          throw err;
        }
      },
    );
    const agentReportsByTask: Record<
      string,
      Partial<Record<AgentReport["role"], AgentReport>>
    > = {};
    for (const taskId of Object.keys(pipelinesByTask)) {
      agentReportsByTask[taskId] = {};
    }
    for (const entry of agentReportEntries) {
      if (!entry) continue;
      const bucket = (agentReportsByTask[entry.taskId] ??= {});
      bucket[entry.role] = entry.report;
    }
    return (
      <WorkItemDetail
        initial={detail}
        initialView={initialView}
        project={project}
        pipelinesByTask={pipelinesByTask}
        agentReportsByTask={agentReportsByTask}
      />
    );
  } catch (err) {
    const error = err as Error & { status?: number };
    if (error.status === 404) {
      notFound();
    }
    const t = await getTranslations("workItems");
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          {t("errorTitle")}
        </h1>
        <p className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-fg">
          {error.message}
        </p>
      </div>
    );
  }
}
