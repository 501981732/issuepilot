import { getTranslations } from "next-intl/server";

import { WorkItemsList } from "../../components/work-items/work-items-list";
import { listWorkItems } from "../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function WorkItemsRoute() {
  try {
    const { workItems, counters } = await listWorkItems();
    return <WorkItemsList workItems={workItems} counters={counters} />;
  } catch (err) {
    const t = await getTranslations("workItems");
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
