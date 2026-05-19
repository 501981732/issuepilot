"use client";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";

interface RecommendationsProps {
  recommendations: ImprovementRecommendation[];
  onGenerate: () => Promise<void> | void;
  onAccept: (id: string) => Promise<void> | void;
  onReject: (id: string) => Promise<void> | void;
  onDefer: (id: string) => Promise<void> | void;
  onPreview: (id: string) => Promise<void> | void;
}

export function Recommendations({
  recommendations,
  onGenerate,
  onAccept,
  onReject,
  onDefer,
  onPreview,
}: RecommendationsProps) {
  const t = useTranslations("reportsPage.recommendations");
  const [selectedId, setSelectedId] = useState<string | undefined>(
    recommendations[0]?.recommendationId,
  );
  const selected = useMemo(
    () =>
      recommendations.find((r) => r.recommendationId === selectedId) ??
      recommendations[0],
    [recommendations, selectedId],
  );

  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-fg">
            {t("title")}
          </h2>
          <p className="max-w-2xl text-xs text-fg-muted">{t("description")}</p>
        </div>
        <Button size="sm" onClick={() => void onGenerate()}>
          {t("generate")}
        </Button>
      </div>

      {recommendations.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-fg-subtle">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <ul className="flex flex-col gap-2">
            {recommendations.map((recommendation) => (
              <li key={recommendation.recommendationId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(recommendation.recommendationId)}
                  className="flex w-full flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium text-fg">
                    {recommendation.title}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone="warning">{recommendation.problemPattern}</Badge>
                    <Badge tone="neutral">{recommendation.target.kind}</Badge>
                    <Badge tone="info">{recommendation.status}</Badge>
                  </span>
                  <span className="text-xs text-fg-subtle">
                    {t("evidenceCount", {
                      count: recommendation.evidenceRefs.length,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <Card>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold text-fg">
                    {selected.title}
                  </h3>
                  <p className="text-sm text-fg-muted">{selected.summary}</p>
                  <p className="font-mono text-[11px] text-fg-subtle">
                    {t("target", { value: selected.target.description })}
                  </p>
                  <p className="font-mono text-[11px] text-fg-subtle">
                    {t("confidence", { value: selected.confidence })} ·{" "}
                    {t("risk", { value: selected.risk })} ·{" "}
                    {t("status", { value: selected.status })}
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                    {t("evidence")}
                  </h4>
                  <ul className="flex flex-col gap-1 text-xs text-fg-muted">
                    {selected.evidenceRefs.map((ref) => (
                      <li key={ref.id}>
                        {ref.href ? (
                          <Link href={ref.href}>{ref.reason}</Link>
                        ) : (
                          ref.reason
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                    {t("patchPreview")}
                  </h4>
                  <pre className="max-h-56 overflow-auto rounded-md border border-border bg-surface-2 p-3 text-xs text-fg">
                    {selected.patchPreview.diff ?? selected.patchPreview.status}
                  </pre>
                  {selected.patchPreview.rollbackNotes ? (
                    <p className="text-xs text-fg-subtle">
                      {t("rollback")}: {selected.patchPreview.rollbackNotes}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void onAccept(selected.recommendationId)}
                  >
                    {t("accept")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void onDefer(selected.recommendationId)}
                  >
                    {t("defer")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void onReject(selected.recommendationId)}
                  >
                    {t("reject")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void onPreview(selected.recommendationId)}
                  >
                    {t("preview")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
