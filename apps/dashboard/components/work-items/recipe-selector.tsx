"use client";

import type {
  RecipeSource,
  WorkflowRecipe,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ApiError, setRecipeOverride } from "../../lib/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * V4.6 Recipe Selector（spec §17.2 / plan Task 11.4）。
 *
 * UI 状态机：
 * - 当 task 处于 `planned` / `blocked_by_dependency` / `ready` 且 pipeline
 *   未进入 running_coding 之后 → 选择器可编辑；保存调
 *   `setRecipeOverride()`。
 * - 当 pipeline 已 running_coding 或之后 → 锁定，按钮 disabled +
 *   tooltip 解释。
 * - 若已有 `pendingRecipe` → 选中态显示 "待生效" badge。
 */

const RECIPE_OPTIONS: WorkflowRecipe[] = [
  "full_pipeline",
  "coding_plus_reviewer",
  "coding_only",
];

export interface RecipeSelectorProps {
  workItemId: string;
  taskId: string;
  currentRecipe: WorkflowRecipe;
  currentSource: RecipeSource;
  pendingRecipe?: WorkflowRecipe;
  /**
   * 当 task 已进入 running_coding 之后，传 true 让选择器锁定。
   */
  locked: boolean;
  onSaved?: (recipe: WorkflowRecipe) => void;
}

export function RecipeSelector({
  workItemId,
  taskId,
  currentRecipe,
  currentSource,
  pendingRecipe,
  locked,
  onSaved,
}: RecipeSelectorProps) {
  const t = useTranslations("workItem.recipeSelector");
  const tRecipe = useTranslations("workItem.pipeline.recipe");
  const [selected, setSelected] = useState<WorkflowRecipe>(
    pendingRecipe ?? currentRecipe,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = selected !== (pendingRecipe ?? currentRecipe);

  return (
    <section
      data-component="recipe-selector"
      data-locked={locked ? "true" : "false"}
      className="rounded-md border border-border bg-surface px-4 py-3"
      aria-label={t("ariaLabel")}
    >
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{t("title")}</h3>
        <Badge tone="neutral" data-testid="current-source-badge">
          {t(`currentSource.${currentSource}` as const)}
        </Badge>
        {pendingRecipe ? (
          <Badge tone="violet" data-testid="pending-recipe-badge">
            {t("pending")}
          </Badge>
        ) : null}
        {locked ? (
          <Badge tone="warning" data-testid="locked-badge">
            {t("locked")}
          </Badge>
        ) : null}
      </header>
      <div
        role="radiogroup"
        aria-label={t("ariaLabel")}
        className="flex flex-wrap gap-2"
      >
        {RECIPE_OPTIONS.map((option) => (
          <label
            key={option}
            data-recipe={option}
            data-selected={selected === option ? "true" : "false"}
            className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${
              selected === option
                ? "border-info bg-info-soft text-info-fg"
                : "border-border bg-surface-2 text-fg"
            } ${locked ? "opacity-60 cursor-not-allowed" : ""}`}
          >
            <input
              type="radio"
              name={`recipe-${taskId}`}
              value={option}
              checked={selected === option}
              disabled={locked || saving}
              onChange={() => setSelected(option)}
              className="sr-only"
            />
            <span>{tRecipe(option)}</span>
          </label>
        ))}
      </div>
      <footer className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          data-testid="recipe-save"
          variant="default"
          disabled={!dirty || locked || saving}
          aria-disabled={!dirty || locked || saving ? "true" : "false"}
          title={locked ? t("lockedTooltip") : undefined}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await setRecipeOverride(workItemId, taskId, selected);
              onSaved?.(selected);
            } catch (err) {
              if (err instanceof ApiError) {
                setError(err.code ?? err.message);
              } else if (err instanceof Error) {
                setError(err.message);
              } else {
                setError("unknown_error");
              }
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? t("saving") : t("save")}
        </Button>
        {error ? (
          <span className="text-xs text-danger-fg" role="alert">
            {error}
          </span>
        ) : null}
      </footer>
    </section>
  );
}
