"use client";

import type { MarkTaskReworkRequest } from "@issuepilot/shared-contracts";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

import { Button } from "../ui/button";

export interface MarkReworkDialogProps {
  open: boolean;
  taskId: string;
  taskTitle: string;
  onClose: () => void;
  onSubmit: (body: MarkTaskReworkRequest) => Promise<void>;
}

/**
 * V4.2: modal dialog to mark a task for reviewer-driven rework. The
 * reason is required (≥1 char on the client; the orchestrator also
 * validates server-side). On success, the dialog closes and the caller
 * is responsible for reloading the work-item detail.
 */
export function MarkReworkDialog({
  open,
  taskId,
  taskTitle,
  onClose,
  onSubmit,
}: MarkReworkDialogProps) {
  const t = useTranslations("workItem.reworkDialog");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const canSubmit = reason.trim().length > 0 && !busy;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-surface p-5 shadow-2"
      >
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="font-mono text-[11px] text-fg-subtle">
            {taskId} · {taskTitle}
          </p>
        </header>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">{t("reasonLabel")}</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("reasonPlaceholder")}
            className="min-h-[80px] resize-y rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger-soft px-2 py-1 text-xs text-danger-fg"
          >
            {error}
          </p>
        ) : null}
        <footer className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onSubmit({ reason: reason.trim() });
                onClose();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("submit")}
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
