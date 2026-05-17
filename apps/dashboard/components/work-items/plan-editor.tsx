"use client";

import type {
  TaskPlan,
  TaskPlanEdit,
  TaskNode,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

const STATUS_CLASS: Record<TaskPlan["status"], string> = {
  draft: "bg-warning-soft text-warning-fg",
  accepted: "bg-success-soft text-success-fg",
  rejected: "bg-danger-soft text-danger-fg",
  superseded: "bg-fg-subtle/20 text-fg-subtle",
};

type EditableField = TaskPlanEdit["field"];

type Editable = Pick<
  TaskNode,
  "taskId" | "title" | "goal" | "scope" | "dependsOn" | "suggestedValidation"
>;

type EditableMap = Record<string, Editable>;

function snapshotPlan(plan: TaskPlan): EditableMap {
  const out: EditableMap = {};
  for (const t of plan.tasks) {
    out[t.taskId] = {
      taskId: t.taskId,
      title: t.title,
      goal: t.goal,
      scope: t.scope,
      dependsOn: [...t.dependsOn],
      suggestedValidation: [...t.suggestedValidation],
    };
  }
  return out;
}

function diffEdits(
  before: EditableMap,
  after: EditableMap,
  by: string,
): Array<Omit<TaskPlanEdit, "at" | "by"> & { by: string }> {
  const fields: EditableField[] = [
    "title",
    "goal",
    "scope",
    "dependsOn",
    "suggestedValidation",
  ];
  const edits: Array<Omit<TaskPlanEdit, "at" | "by"> & { by: string }> = [];
  for (const taskId of Object.keys(before)) {
    const b = before[taskId];
    const a = after[taskId];
    if (!a || !b) continue;
    for (const field of fields) {
      const beforeVal = b[field];
      const afterVal = a[field];
      const same = JSON.stringify(beforeVal) === JSON.stringify(afterVal);
      if (!same) {
        edits.push({
          taskId,
          field,
          before: beforeVal,
          after: afterVal,
          by,
        });
      }
    }
  }
  return edits;
}

export interface PlanEditorProps {
  plan: TaskPlan;
  /** Default operator id used to attribute edits when accepting. */
  operator?: string;
  busy?: boolean;
  /** Called with the diff edits when operator presses "Accept plan". */
  onAccept?: (
    args: { edits: Array<Omit<TaskPlanEdit, "at" | "by"> & { by: string }> },
  ) => Promise<void> | void;
  onRegenerate?: () => Promise<void> | void;
}

export function PlanEditor({
  plan,
  operator = "operator",
  busy = false,
  onAccept,
  onRegenerate,
}: PlanEditorProps) {
  const t = useTranslations("workItem.plan");
  const initial = useMemo(() => snapshotPlan(plan), [plan]);
  const [draft, setDraft] = useState<EditableMap>(initial);
  const [editing, setEditing] = useState(false);

  const isDraft = plan.status === "draft";

  const updateField = useCallback(
    (taskId: string, field: EditableField, raw: string) => {
      setDraft((prev) => {
        const cur = prev[taskId];
        if (!cur) return prev;
        if (field === "dependsOn" || field === "suggestedValidation") {
          const list = raw
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          return { ...prev, [taskId]: { ...cur, [field]: list } };
        }
        return { ...prev, [taskId]: { ...cur, [field]: raw } };
      });
    },
    [],
  );

  const handleAccept = useCallback(async () => {
    if (!onAccept) return;
    const edits = diffEdits(initial, draft, operator);
    await onAccept({ edits });
  }, [draft, initial, onAccept, operator]);

  const statusLabel = (() => {
    switch (plan.status) {
      case "draft":
        return t("draftBadge");
      case "accepted":
        return t("acceptedBadge");
      case "superseded":
        return t("supersededBadge");
      case "rejected":
        return t("rejectedBadge");
    }
  })();

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>{t("title")}</CardTitle>
          <span className="font-mono text-[11px] text-fg-subtle">
            {t("version", { version: plan.version })}
          </span>
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
            STATUS_CLASS[plan.status],
          )}
        >
          {statusLabel}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {plan.tasks.map((task) => {
            const d = draft[task.taskId] ?? {
              taskId: task.taskId,
              title: task.title,
              goal: task.goal,
              scope: task.scope,
              dependsOn: task.dependsOn,
              suggestedValidation: task.suggestedValidation,
            };
            const editableNow = isDraft && editing;
            return (
              <li
                key={task.taskId}
                className="flex flex-col gap-2 rounded-md border border-border/70 bg-surface-1 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-fg-subtle">
                    {task.taskId}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    risk {task.riskLevel}
                  </span>
                </div>
                <Field
                  label={t("fieldTitle")}
                  value={d.title}
                  editable={editableNow}
                  onChange={(v) => updateField(task.taskId, "title", v)}
                />
                <Field
                  label={t("fieldGoal")}
                  value={d.goal}
                  editable={editableNow}
                  onChange={(v) => updateField(task.taskId, "goal", v)}
                  multiline
                />
                <Field
                  label={t("fieldScope")}
                  value={d.scope}
                  editable={editableNow}
                  onChange={(v) => updateField(task.taskId, "scope", v)}
                  multiline
                />
                <Field
                  label={t("fieldDependsOn")}
                  value={d.dependsOn.join(", ")}
                  editable={editableNow}
                  onChange={(v) => updateField(task.taskId, "dependsOn", v)}
                />
                <Field
                  label={t("fieldSuggestedValidation")}
                  value={d.suggestedValidation.join("\n")}
                  editable={editableNow}
                  onChange={(v) =>
                    updateField(task.taskId, "suggestedValidation", v)
                  }
                  multiline
                />
              </li>
            );
          })}
        </ul>
        {isDraft ? (
          <div className="flex flex-wrap gap-2">
            {!editing ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setEditing(true)}
              >
                {t("edit")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDraft(initial);
                  setEditing(false);
                }}
              >
                {t("cancel")}
              </Button>
            )}
            {onAccept ? (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={handleAccept}
              >
                {busy ? t("saving") : t("accept")}
              </Button>
            ) : null}
            {onRegenerate ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onRegenerate()}
              >
                {busy ? t("regenerating") : t("regenerate")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  editable,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  editable: boolean;
  onChange: (next: string) => void;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
        {label}
      </span>
      {editable ? (
        multiline ? (
          <textarea
            aria-label={label}
            className="min-h-[60px] resize-y rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-ring"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            aria-label={label}
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-ring"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      ) : (
        <p className="whitespace-pre-line text-sm text-fg">{value || "—"}</p>
      )}
    </div>
  );
}
