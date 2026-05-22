# IssuePilot V4.9 智能 Review 工作流验收记录

日期：2026-05-21
状态：实施完成，待用户验收

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow.md`

## 默认 gate

- [x] `pnpm --filter @issuepilot/shared-contracts test -- src/__tests__/review-rework.test.ts src/__tests__/report.test.ts src/__tests__/work-item.test.ts src/__tests__/events.test.ts src/__tests__/quality.test.ts`
- [x] `pnpm --filter @issuepilot/workflow test -- src/__tests__/render.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator test -- src/review-workflow src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts src/work-items/__tests__/aggregate.test.ts src/quality/__tests__/aggregate.test.ts`
- [x] `pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx`
- [x] `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`
      （stage 1/5 tsc -b、stage 2/5 tsc -p scripts/tsconfig.json、
      stage 3/5 next build (apps/dashboard)、stage 4/5 eslint
      --max-warnings 0、stage 5/5 vitest run（含 review-workflow /
      dispatch / review-feedback / E2E / aggregate / quality /
      dashboard 全套）全部通过；最后 git diff --check 也通过。）

## 完整 review-rework E2E

- [x] `pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts`

  V4.9 happy path（planner → accept → dispatch 注入 accepted plan）以及
  V4.8 mixed-runner reviewer findings 的 `runnerKind` provenance 透传均通过。

## 实施摘要

V4.9 共拆成 11 个 task 执行：

1. Task 1 — `ReviewReworkPlan` / `ReviewReworkItem` / `ReviewReworkSummary` /
   `ReviewReworkSourceRef` shared contract + 类型守卫 + `RunReportArtifact`、
   `WorkItemReport`、`EVENT_TYPE_VALUES` 联动。
2. Task 2 — `PromptContext.reviewReworkPlan` + Liquid alias
   `review_rework_plan`（snake_case）+ 深克隆防止 prompt 渲染修改原始 plan。
3. Task 3 — deterministic classifier（含问题型评论识别）+ planner（按目标文件
   / normalized title 去重，priority `pickStronger`）。
4. Task 4 — 原子写入 plan store（in-memory cache + redaction + supersede 链）。
5. Task 5 — plan service（generate / accept / dismiss / accept-item /
   dismiss-item / resolve-item / split-item + `IssuePilotInternalEvent` 审计）。
6. Task 6 — Fastify routes，含 operator 解析、project-scoped service 解析、
   `x-issuepilot-operator` header 校验。
7. Task 7 — dispatch 注入 + V2 `## Review feedback` fallback；事件命名修正为
   `review_rework_plan_generation_failed`。
8. Task 8 — sweep → planner 集成；`ReviewReworkPlan` 写回
   `RunReportArtifact.reviewReworkPlan`；daemon 注入 service slice。
9. Task 9 — work item `reviewReworkSummary` 聚合 + Quality Analytics
   `QualitySummaryResponse.reviewWorkflow` 切片（plansGenerated / itemsAccepted /
   itemsResolved / topCategories / runnerKindBreakdown）。
10. Task 10 — Dashboard：`ReviewReworkPlanPanel`、`ReviewReworkSummary`、
    `ReviewWorkflowCard` 三件套接入 Run Detail / Parent Review Packet /
    Reports 页面，zh / en i18n 同步。
11. Task 11 — E2E（happy path + mixed-runner runnerKind）+ docs / README /
    CHANGELOG 同步 + acceptance 记录。

## V4.8 mixed runner 透传

- `claude_code` runner 产生的 `ReviewerAgentReport.findings` 经 planner 后，
  `ReviewReworkSourceRef.runnerKind` 仍为 `claude_code`，
  `agentReportId` 也保留；这保证 Quality Analytics 的
  `runnerKindBreakdown` 与 Parent Review Packet 的 provenance 在第二 runner
  路径下不丢失（见 `apps/orchestrator/src/__tests__/v4-9-mixed-runner-source-ref.test.ts`）。

## V4.10 用户验收 / Dog-food 复核（2026-05-22）

- [x] `pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts`
  - Result: 88 test files passed, 1 skipped; 1003 tests passed, 1 skipped.
- [x] `pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/review-workflow`
  - Result: 88 test files passed, 1 skipped; 1003 tests passed, 1 skipped.
- [x] `pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx`
  - Result: 47 test files passed; 295 tests passed.

V4.10 复核结论：V4.9 review-rework 链路可作为 release-lock 的可复现 dog-food 场景。accepted plan 注入、fallback、mixed-runner provenance 和 dashboard/report 展示路径均有 focused gate 覆盖。

## 已知后续工作

- V4.5 路径下若调用 `reviewWorkflowService.list({ workItemId })` 仍需 V4.6+
  pipeline 提供真实 `taskAgentReports`，daemon V1 single-task 路径暂传空列表。
- `team` daemon 的 review workflow service 绑定属于后续 multi-project 服务
  化范畴，本计划未涉及。

## 风险与回滚

- planner 默认 deterministic，所有评论 / findings 都至少有 fallback
  category；即便分类不准，dispatch 也只是 prepend 更长的 block，不会破坏
  V2 行为。
- 若需关闭 V4.9：在 daemon 启动时不注入 `reviewWorkflow` slice 即可让
  `dispatch` 与 `sweepReviewFeedbackOnce` fallback 到 V2 路径，无需 schema
  迁移；plan store 文件保留在 workspace root 下供后续审计。
