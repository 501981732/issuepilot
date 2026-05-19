"use client";

import type {
  AgentRole,
  AgentReport,
  MrPublicationStatus,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ApiError, revokeAiReview } from "../../lib/api";
import { Button } from "../ui/button";

/**
 * V4.6 Revoke AI Review button（spec §17.2 / plan Task 11.5）。
 *
 * 可见性矩阵：
 * - 仅 reviewer role 渲染（非 reviewer → return null）。
 * - reviewer + `mrPublication.status = "published"` → 可见可点。
 * - reviewer + `pending` / `publish_failed` / `revoked` / `skipped_by_config`
 *   → 可见但 disabled + i18n tooltip 解释。
 * - reviewer + `AgentReport.status ∈ {cancelled, failed, incomplete}` 且
 *   `mrPublication.status = published` → 可见可点，但附带 "incomplete run"
 *   提示。
 */

export interface RevokeAiReviewButtonProps {
  agentReportId: string;
  role: AgentRole;
  agentReportStatus: AgentReport["status"];
  mrPublicationStatus: MrPublicationStatus;
  onRevoked?: (agentReportId: string) => void;
}

const DISABLED_REASONS: Partial<
  Record<MrPublicationStatus, keyof IntlNamespace>
> = {
  pending: "pending",
  publish_failed: "publishFailed",
  revoked: "alreadyRevoked",
  skipped_by_config: "skippedByConfig",
};

type IntlNamespace = {
  pending: string;
  publishFailed: string;
  alreadyRevoked: string;
  skippedByConfig: string;
};

export function RevokeAiReviewButton({
  agentReportId,
  role,
  agentReportStatus,
  mrPublicationStatus,
  onRevoked,
}: RevokeAiReviewButtonProps) {
  const t = useTranslations("workItem.revoke");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (role !== "reviewer") return null;

  const isPublished = mrPublicationStatus === "published";
  const disabledReasonKey = DISABLED_REASONS[mrPublicationStatus];
  const isIncompleteRun =
    isPublished && agentReportStatus !== "complete";

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await revokeAiReview(agentReportId);
      setSuccess(true);
      setConfirming(false);
      onRevoked?.(agentReportId);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t("failure", { message: err.code ?? err.message }));
      } else if (err instanceof Error) {
        setError(t("failure", { message: err.message }));
      } else {
        setError(t("failure", { message: "unknown_error" }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      data-component="revoke-ai-review"
      data-mr-status={mrPublicationStatus}
      data-incomplete-run={isIncompleteRun ? "true" : "false"}
      className="inline-flex flex-col items-start gap-1"
    >
      {confirming ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs"
          role="alertdialog"
          aria-labelledby={`revoke-confirm-${agentReportId}`}
        >
          <span id={`revoke-confirm-${agentReportId}`} className="font-medium">
            {t("confirmTitle")}
          </span>
          <span className="text-fg-muted">{t("confirmDescription")}</span>
          <Button
            variant="danger"
            size="sm"
            disabled={submitting}
            onClick={handleConfirm}
            data-testid="revoke-confirm"
          >
            {t("confirm")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={submitting}
            data-testid="revoke-cancel"
          >
            {t("cancel")}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={!isPublished || submitting || success}
          aria-disabled={!isPublished || submitting || success ? "true" : "false"}
          title={
            disabledReasonKey
              ? t(`disabledReason.${disabledReasonKey}`)
              : isIncompleteRun
                ? t("incompleteRun")
                : undefined
          }
          onClick={() => setConfirming(true)}
          data-testid="revoke-trigger"
        >
          {success ? t("success") : t("buttonLabel")}
        </Button>
      )}
      {error ? (
        <span role="alert" className="text-xs text-danger-fg">
          {error}
        </span>
      ) : null}
      {isIncompleteRun && !confirming && !success ? (
        <span
          className="text-xs text-warning-fg"
          data-testid="incomplete-warning"
        >
          {t("incompleteRun")}
        </span>
      ) : null}
    </div>
  );
}
