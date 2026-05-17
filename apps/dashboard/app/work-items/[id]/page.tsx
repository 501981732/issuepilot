import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { WorkItemDetail } from "../../../components/work-items/work-item-detail";
import { getWorkItem } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WorkItemDetailRoute(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  try {
    const detail = await getWorkItem(id);
    return <WorkItemDetail initial={detail} />;
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
