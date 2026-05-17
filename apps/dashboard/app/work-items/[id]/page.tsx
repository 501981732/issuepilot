import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { WorkItemDetail } from "../../../components/work-items/work-item-detail";
import { PROJECT_COOKIE_KEY } from "../../../lib/active-project-cookie";
import { getWorkItem } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WorkItemDetailRoute(props: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ view?: string }>;
}) {
  const { id } = await props.params;
  const sp = props.searchParams ? await props.searchParams : {};
  const initialView = sp.view === "graph" ? "graph" : "list";
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
    return <WorkItemDetail initial={detail} initialView={initialView} />;
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
