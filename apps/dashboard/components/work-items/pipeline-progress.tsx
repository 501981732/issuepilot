"use client";

import type {
  AgentReportSummary,
  AgentRole,
  PipelineRun,
  PipelineRunStatus,
  WorkflowRecipe,
} from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { cn } from "../../lib/cn";
import { Badge, type BadgeTone } from "../ui/badge";

/**
 * V4.6 Pipeline Progress（spec §17.2 / §23 / plan Task 11.2）。
 *
 * 设计原则（来自 `ui-ux-pro-max` skill 的 progressive-disclosure /
 * truncation-strategy）：
 * - 三步固定布局 `coder → reviewer → test_evidence`，按 recipe 标灰被跳过
 *   的步骤，避免视觉跳跃。
 * - 当前 role 加 motion 高亮（`animate-pulse` 类），其他步骤静态。
 * - 进度条根据 `pipelineRun.status` 推导整体语义（running / awaiting /
 *   failed / cancelled / partial）。
 * - 完全 SSR-safe：不读 window / theme，颜色靠 CSS 变量自动暗色切换。
 *
 * 为了让测试断言可靠，每个 role 节点带稳定 `data-role` 与 `data-state`。
 */

const ROLE_ORDER: AgentRole[] = ["coder", "reviewer", "test_evidence"];

type RoleState =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  | "incomplete"
  | "skipped_by_recipe";

function rolesForRecipe(recipe: WorkflowRecipe | undefined): Set<AgentRole> {
  if (recipe === "coding_only") return new Set<AgentRole>(["coder"]);
  if (recipe === "coding_plus_reviewer")
    return new Set<AgentRole>(["coder", "reviewer"]);
  return new Set<AgentRole>(["coder", "reviewer", "test_evidence"]);
}

function roleState(opts: {
  role: AgentRole;
  recipeRoles: Set<AgentRole>;
  currentRole: AgentRole | null;
  status: PipelineRunStatus | undefined;
  report: AgentReportSummary | undefined;
}): RoleState {
  if (!opts.recipeRoles.has(opts.role)) return "skipped_by_recipe";
  if (opts.report) {
    if (opts.report.status === "running") return "running";
    if (opts.report.status === "complete") return "complete";
    if (opts.report.status === "incomplete") return "incomplete";
    if (opts.report.status === "failed") return "failed";
    if (opts.report.status === "cancelled") return "cancelled";
  }
  if (opts.currentRole === opts.role) return "running";
  return "pending";
}

const STATE_TONE: Record<RoleState, BadgeTone> = {
  pending: "neutral",
  running: "info",
  complete: "success",
  failed: "danger",
  cancelled: "danger",
  incomplete: "warning",
  skipped_by_recipe: "neutral",
};

function pipelineStatusTone(status: PipelineRunStatus | undefined): BadgeTone {
  switch (status) {
    case "running_coding":
    case "running_reviewer":
    case "running_test_evidence":
      return "info";
    case "awaiting_human_review":
      return "success";
    case "awaiting_rework":
      return "warning";
    case "partial":
      return "warning";
    case "failed":
      return "danger";
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

export interface PipelineProgressProps {
  pipelineRun: PipelineRun | null;
  agentReports?: AgentReportSummary[];
  /**
   * Recipe override 来源：用于 hint。仅展示，不允许编辑（编辑入口在
   * RecipeSelector）。
   */
  pendingRecipe?: WorkflowRecipe | null;
}

export function PipelineProgress({
  pipelineRun,
  agentReports,
  pendingRecipe,
}: PipelineProgressProps) {
  const t = useTranslations("workItem.pipeline");

  if (!pipelineRun) {
    return (
      <section
        className="rounded-md border border-border bg-surface px-4 py-3"
        aria-label={t("ariaLabel")}
        data-component="pipeline-progress"
        data-state="empty"
      >
        <p className="text-sm text-fg-muted">{t("emptyState")}</p>
      </section>
    );
  }

  const recipe: WorkflowRecipe = pipelineRun.recipe;
  const recipeRoles = rolesForRecipe(recipe);
  const reportByRole = new Map<AgentRole, AgentReportSummary>();
  for (const report of agentReports ?? []) {
    if (!report.supersededBy) reportByRole.set(report.role, report);
  }

  return (
    <section
      className="space-y-2 rounded-md border border-border bg-surface px-4 py-3"
      aria-label={t("ariaLabel")}
      data-component="pipeline-progress"
      data-recipe={recipe}
      data-status={pipelineRun.status}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">{t("title")}</h3>
        <Badge tone="neutral" data-test="recipe-badge">
          {t(`recipe.${recipe}` as const)}
        </Badge>
        <Badge tone={pipelineStatusTone(pipelineRun.status)} data-test="status-badge">
          {t(`status.${pipelineRun.status}` as const)}
        </Badge>
        {pendingRecipe ? (
          <Badge tone="violet" data-test="pending-recipe-badge">
            {t("pendingHint", {
              recipe: t(`recipe.${pendingRecipe}` as const),
            })}
          </Badge>
        ) : null}
      </header>
      <ol
        className="flex flex-wrap items-center gap-2"
        aria-label={t("stepsAriaLabel")}
        role="list"
      >
        {ROLE_ORDER.map((role, idx) => {
          const state = roleState({
            role,
            recipeRoles,
            currentRole: pipelineRun.currentRole,
            status: pipelineRun.status,
            report: reportByRole.get(role),
          });
          const isCurrent = pipelineRun.currentRole === role;
          return (
            <li
              key={role}
              className="flex items-center gap-2"
              data-role={role}
              data-state={state}
            >
              {idx > 0 ? (
                <span
                  aria-hidden="true"
                  className="text-fg-muted"
                  data-test="step-arrow"
                >
                  →
                </span>
              ) : null}
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-1 text-xs font-medium",
                  state === "skipped_by_recipe"
                    ? "opacity-50"
                    : "",
                  isCurrent && state === "running"
                    ? "ring-2 ring-info/40 animate-pulse"
                    : "",
                )}
                aria-label={t(`stepAriaLabel.${role}`, {
                  state: t(`stepState.${state}`),
                })}
              >
                <span className="font-semibold">{t(`role.${role}`)}</span>
                <Badge tone={STATE_TONE[state]} data-test="role-state-badge">
                  {t(`stepState.${state}`)}
                </Badge>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
