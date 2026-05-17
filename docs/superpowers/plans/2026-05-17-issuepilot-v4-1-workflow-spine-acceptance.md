# IssuePilot V4.1 Workflow Spine 验收检查清单

日期：2026-05-17
状态：**全部通过**

对应 spec：
`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md` §17。
对应实施计划：
`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`（任务 22）。

把本清单复制到 PR 描述里作为自检清单。

## §17 V4.1 验收标准

- [x] **一个大 Issue 能被拆成两个子任务**（E2E 覆盖）。
  - 证据：`apps/orchestrator/src/__tests__/work-items-e2e.test.ts:378`
    `expect(planRes.plan.tasks).toHaveLength(2)`，三个 E2E case 全部基于
    2-task fake plan 跑通。

- [x] **Operator 能在 dashboard 接受或编辑 plan**（plan-editor 组件测试覆盖）。
  - 证据：`apps/dashboard/components/work-items/plan-editor.test.tsx`
    覆盖按钮可见性、行内编辑、`TaskPlanEdit` diff 生成。
  - 证据：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
    覆盖 `acceptWorkItemPlan` / `regenerateWorkItemPlan` 调用与
    reload 路径。

- [x] **两个子任务各自产生 run report**（reportStore 写出两条
      RunReportArtifact）。
  - 证据：E2E `happy path` test，`reportStore.list({ workItemId })`
    返回长度 2 的 `RunReportArtifact[]`；`taskSummaries` 长度 2。

- [x] **系统生成一个 `WorkItemReport`**（store `getReport(workItemId)`
      返回）。
  - 证据：E2E test 行 `finalReport = await store.getReport(workItemId)`
    后断言 `finalReport.overallStatus === "complete"` /
    `"partial"` / `"incomplete"`。

- [x] **Dashboard 能看到子任务状态、验证结果、风险和 Parent Review
      Packet**。
  - 证据：
    - `apps/dashboard/components/work-items/task-list.test.tsx`（按
      effective status 分组、Skip/Retry 入口）。
    - `apps/dashboard/components/work-items/parent-review-packet.test.tsx`
      （overallStatus banner、validation summary、risk summary、
      per-task cards、evidence index、Copy as Markdown）。
    - `apps/dashboard/components/work-items/work-item-detail.test.tsx`
      （详情页装配三个组件）。

- [x] **Fake GitLab + fake Codex E2E 跑通完整闭环**（task 19）。
  - 证据：`apps/orchestrator/src/__tests__/work-items-e2e.test.ts`
    三个测试全部通过：
    1. `happy path: plan → accept → tick dispatches both tasks →
       settle complete → parent label flips to human-review`
    2. `partial path: one task fails → WorkItem.status partial →
       parent label NOT moved to human-review`
    3. `dependency path: T2 dependsOn T1; T1's MR opened (not merged)
       keeps T2 in blocked_by_dependency`

- [x] **V4.1 task execution contract 全部满足**：

  - [x] 不创建 child GitLab Issue。
    - 证据：`apps/orchestrator/src/**` 与 `packages/tracker-gitlab/src/**`
      均无对裸 `createIssue(` 的调用（只用 `createIssueNote`），
      由构造保证。
  - [x] 每 task 一 branch / worktree，base = `base_branch`。
    - 证据：`apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`
      验证 synthetic run input 携带的 branch / worktree key。
  - [x] 每 task 一独立 MR。
    - 证据：每个 `TaskRunLink` 单独存放 `mrUrl` /
      `mrIid`；E2E `happy path` 在 settle 阶段为两个 task 写入两条
      不同 MR URL，aggregator 在 `taskSummaries` 里按 task 引用。
  - [x] `TaskRunLink` 是唯一 canonical binding。
    - 证据：`apps/orchestrator/src/work-items/__tests__/store.test.ts`
      覆盖 `saveTaskRunLink` / `getTaskRunLinks` 的幂等读写；
      `service.ts` 的 `acceptPlan` / `dispatchReadyTasks` 通过
      `TaskRunLink` 串联。
  - [x] 父 Issue label 切换 / handoff note 写入仅由 aggregator
        触发。
    - 证据 1：`apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
      §`V4.1 parentIssueLabelMode` 三个 case 全部断言
      `parentIssueLabelMode: "suppressed"` 时父 Issue label 不变、
      handoff note 不写。
    - 证据 2：`apps/orchestrator/src/__tests__/daemon.test.ts`
      §`startSingleProjectDaemon ... wires WorkItemService …`
      验证 daemon 通过 `settleTaskRunFinal` 把 aggregator 输出
      落到父 Issue。

- [x] **全量 `pnpm -r build` / `pnpm -r test` 通过**。
  - 证据（2026-05-17 13:35 本地执行）：
    - `pnpm -r build` 全部 workspace exit 0（dashboard `next build`
      产出 `/work-items` + `/work-items/[id]` 路由；orchestrator /
      所有 packages `tsc -b` 干净）。
    - `pnpm -r test` 共 **432 测试全部通过**（orchestrator 381 +
      tests/e2e 51）。
    - `pnpm -r lint` 全部 workspace exit 0（`--max-warnings 0`）。

- [x] **文档 + CHANGELOG 更新**。
  - `CHANGELOG.md` 新增 *V4.1 Workflow Spine* 段落。
  - `README.md` / `README.zh-CN.md` roadmap 新增 V4.1 已落地条目，
    指向设计 spec 和实施计划。
  - `USAGE.md` / `USAGE.zh-CN.md` 新增 §5.7
    *V4.1 Workflow Spine — plan a large issue end to end*，覆盖
    operator 5 步操作流和不变量提醒。
  - `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
    顶部新增「实施计划」链接。
  - 本文件即任务 22 的输出。

## 不变量回顾（来自计划文末）

- [x] V4.1 不能因单 task 失败丢掉整个 WorkItem 状态。
  - `apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`
    覆盖 `partial` 与 `incomplete` 路径；E2E `partial path` case
    端到端验证。
- [x] 所有 AI 生成的拆解 / 汇总都可追溯到输入和 evidence。
  - `TaskPlan.tasks` 含 `sourceIssue` 链接；`evidence index` 按
    task 引用 `RunReportArtifact`（`evidence-index.test.ts`）。
- [x] 人保留接受 plan / 编辑 task / 重试 task / 跳过 task 的权力。
  - 路由：`POST /api/work-items/:id/plan/accept`、
    `/plan/regenerate`、`/tasks/:taskId/skip`、`/tasks/:taskId/retry`
    全部覆盖（`server.test.ts`）。
  - UI：`plan-editor` / `task-list` / `work-item-detail` 测试覆盖。
- [x] GitLab note / dashboard / Markdown export 同源于
      `WorkItemReport`。
  - `handoff.ts` 渲染同一份 `WorkItemReport` 写到父 Issue note；
    dashboard `parent-review-packet` 直接渲染相同字段；
    `Copy as Markdown` 用同一份数据导出。
- [x] V4 不修改生产权限、部署、存储或审计模型。
  - WorkItem store 仍是 fs JSON
    （`apps/orchestrator/src/work-items/store.ts`）；daemon 仍是
    单机 V1/V2 daemon 装配。
