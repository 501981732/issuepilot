import { getTranslations } from "next-intl/server";

import { ReportsPage } from "../../components/reports/reports-page";
import { getQualitySummary, listReports } from "../../lib/api";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function ReportsRoute() {
  try {
    const [{ reports }, quality] = await Promise.all([
      listReports(),
      getQualitySummary(),
    ]);
    return <ReportsPage reports={reports} quality={quality} />;
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
