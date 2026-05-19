import {
  isFailurePatternId,
  isQualityStatusFilter,
  type FailurePatternId,
  type ImprovementRecommendationFilters,
  type QualityStatusFilter,
} from "@issuepilot/shared-contracts";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";

import { ReportsPage } from "../../components/reports/reports-page";
import { PROJECT_COOKIE_KEY } from "../../lib/active-project-cookie";
import {
  getQualitySummary,
  listImprovementRecommendations,
  listReports,
} from "../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ReportsRouteProps {
  searchParams?: Promise<{
    workflow?: string;
    taskType?: string;
    from?: string;
    to?: string;
    window?: string;
    pattern?: string;
    status?: string;
  }>;
}

function parseQualityParams(
  sp: Awaited<NonNullable<ReportsRouteProps["searchParams"]>>,
): Parameters<typeof getQualitySummary>[0] {
  const params: Parameters<typeof getQualitySummary>[0] = {};
  if (typeof sp.workflow === "string" && sp.workflow.length > 0) {
    params.workflow = sp.workflow;
  }
  if (typeof sp.taskType === "string" && sp.taskType.length > 0) {
    params.taskType = sp.taskType;
  }
  if (typeof sp.from === "string" && sp.from.length > 0) params.from = sp.from;
  if (typeof sp.to === "string" && sp.to.length > 0) params.to = sp.to;
  if (sp.window === "7d" || sp.window === "30d") {
    params.window = sp.window;
  }
  if (isFailurePatternId(sp.pattern)) {
    params.pattern = sp.pattern as FailurePatternId;
  }
  if (isQualityStatusFilter(sp.status)) {
    params.status = sp.status as QualityStatusFilter;
  }
  return params;
}

function parseImprovementParams(
  sp: Awaited<NonNullable<ReportsRouteProps["searchParams"]>>,
): ImprovementRecommendationFilters {
  const params: ImprovementRecommendationFilters = {};
  if (typeof sp.workflow === "string" && sp.workflow.length > 0) {
    params.workflow = sp.workflow;
  }
  if (typeof sp.taskType === "string" && sp.taskType.length > 0) {
    params.taskType = sp.taskType;
  }
  if (isFailurePatternId(sp.pattern)) {
    params.pattern = sp.pattern as FailurePatternId;
  }
  return params;
}

export default async function ReportsRoute(props: ReportsRouteProps = {}) {
  const sp = props.searchParams ? await props.searchParams : {};
  const project = cookies().get(PROJECT_COOKIE_KEY)?.value;
  const opts = project ? { project } : {};
  const qualityParams = parseQualityParams(sp);
  const improvementParams = parseImprovementParams(sp);
  try {
    const [{ reports }, quality, { recommendations }] = await Promise.all([
      listReports(opts),
      getQualitySummary(qualityParams, opts),
      listImprovementRecommendations(improvementParams, opts),
    ]);
    return (
      <ReportsPage
        reports={reports}
        quality={quality}
        recommendations={recommendations}
      />
    );
  } catch (err) {
    const t = await getTranslations("reportsPage");
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
        <h1 className="text-xl font-semibold tracking-tight text-fg">
          {t("errorTitle")}
        </h1>
        <p className="rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger-fg">
          {(err as Error).message}
        </p>
      </div>
    );
  }
}
