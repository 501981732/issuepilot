import type {
  AgentReport,
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
    const detail = await getWorkItem(
      id,
      project ? { project } : {},
    );
    // V4.6 plan Task 11.7：并行 fetch 每个 task 的 PipelineRun 摘要 +
    // 三 role 完整 AgentReport。orchestrator 在 V4.5 之前的工作单元上
    // 没有 V4.6 数据，会返回 404 `pipeline_run_not_found` / `agent_report_not_found`，
    // 这里 fail soft → 静默把对应 task 留空，UI 自动回退到旧路径。
    const opts = project ? { project } : {};
    const taskIds = detail.tasks.map((t) => t.taskId);
    const pipelinePairs = await Promise.all(
      taskIds.map(async (taskId): Promise<[
        string,
        GetPipelineResponse | null,
      ]> => {
        try {
          const res = await getPipeline(id, taskId, opts);
          return [taskId, res];
        } catch (err) {
          if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
            return [taskId, null];
          }
          throw err;
        }
      }),
    );
    const pipelinesByTask = Object.fromEntries(
      pipelinePairs.filter(
        (entry): entry is [string, GetPipelineResponse] => entry[1] !== null,
      ),
    );
    const agentReportsByTask: Record<
      string,
      Partial<Record<AgentReport["role"], AgentReport>>
    > = {};
    for (const [taskId, pipeline] of Object.entries(pipelinesByTask)) {
      const byRole: Partial<Record<AgentReport["role"], AgentReport>> = {};
      const summaries = pipeline.agentReports.filter((s) => !s.supersededBy);
      await Promise.all(
        summaries.map(async (summary) => {
          try {
            const detail: GetAgentReportResponse = await getAgentReport(
              summary.agentReportId,
              opts,
            );
            byRole[detail.agentReport.role] = detail.agentReport;
          } catch (err) {
            if (err instanceof ApiError) return;
            throw err;
          }
        }),
      );
      agentReportsByTask[taskId] = byRole;
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
