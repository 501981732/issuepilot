"use client";

import type { ReplanTaskRequest } from "@issuepilot/shared-contracts";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";

import { Button } from "../ui/button";

export interface ReplanTaskDialogProps {
  open: boolean;
  taskId: string;
  taskTitle: string;
  onClose: () => void;
  onSubmit: (body: ReplanTaskRequest) => Promise<void>;
}

/**
 * V4.2: modal dialog to re-draft a single task. Operator must supply a
 * human-readable `reason` (≥3 chars; the orchestrator enforces this
 * server-side too) and may optionally pass a `hint` that becomes part of
 * the planner prompt. On success the dialog closes; the caller is
 * responsible for refreshing the work item detail (the replanned plan is
 * `draft` and needs operator acceptance).
 */
export function ReplanTaskDialog({
  open,
  taskId,
  taskTitle,
  onClose,
  onSubmit,
}: ReplanTaskDialogProps) {
  const t = useTranslations("workItem.replanDialog");
  const [reason, setReason] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setHint("");
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

  const canSubmit = reason.trim().length >= 3 && !busy;

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
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">{t("hintLabel")}</span>
          <textarea
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder={t("hintPlaceholder")}
            className="min-h-[60px] resize-y rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                const body: ReplanTaskRequest = { reason: reason.trim() };
                if (hint.trim().length > 0) body.hint = hint.trim();
                await onSubmit(body);
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
