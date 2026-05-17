# IssuePilot V4.2 Task Graph 验收检查清单

日期：2026-05-17
状态：**全部通过**

对应 spec：
`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
§7 V4.2 + §12.3 + §12.4 + §14.2。
对应实施计划：
`docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`（任务 25）。

把本清单复制到 PR 描述里作为自检清单。

## V4.2 验收标准

- [x] **依赖图执行：T1 → T2 链式 dispatch，T2 dispatch 时
      `DispatchInput.baseBranch === origin/<T1-branch>`**（branch-chain
      单测 + E2E 覆盖）。
  - 证据 1：`apps/orchestrator/src/work-items/__tests__/branch-chain.test.ts`
    覆盖 `decideEffectiveBase` 的 5 个分支（默认 base、上游 completed
    但 MR opened、上游 completed 但 link 缺失、多上游未全 merged、
    多上游全 merged）。
  - 证据 2：`apps/orchestrator/src/__tests__/work-items-v42-e2e.test.ts`
    §`branch chaining` case：T1 完成（MR opened）→ T2 dispatch 时
    `dispatchOpts.baseOverride === "ai/run_T1/v1"`、`chainedFrom ===
    "T1"`；T2 完成 → T3 dispatch 同样链式。
  - 证据 3：`task_run_dispatched` 事件 payload 在 chain 场景下携带
    `chainedFrom` / `baseOverride`（同 e2e）。

- [x] **多上游依赖回退：T3 dependsOn T1 + T2，其中 T2 未 merged → T3
      保持 `blocked_by_dependency`**（branch-chain 单测 + E2E 覆盖）。
  - 证据：`branch-chain.test.ts` §`returns non-linear blocked when >= 2
    upstreams and at least one is not merged` + §`returns default base
    when >= 2 upstreams are all completed + merged`；orchestration
    `tickWorkItem` 在 chain decision 为 `non-linear-blocked` 时把 task
    放入 `blockedByDependency`，并 emit `task_run_blocked_by_dependency`
    事件（`orchestration.test.ts`）。

- [x] **Operator 可以在 dashboard 触发单 task replan，生成新 plan
      version；非 replan task 的 status / runIds 继承；旧 plan 标
      `superseded`**。
  - 证据 1（service 层）：
    `apps/orchestrator/src/work-items/__tests__/replan.test.ts`
    覆盖新 plan version、`replanOf` 字段、非 replan task 的
    `status` / `runIds` 继承、replan task 的 `runIds` 保留为历史证据。
  - 证据 2（端到端）：
    `apps/orchestrator/src/__tests__/work-items-v42-e2e.test.ts`
    §`single-task replan` case，断言 `plan.version` 1 → 2、
    `replanOf === { planId, taskId }`、T1 status/runIds 继承、T2
    title 替换且 runIds 保留、`task_replanned` 事件、旧 plan
    `status === "superseded"`。
  - 证据 3（UI）：
    `apps/dashboard/components/work-items/replan-task-dialog.test.tsx`
    覆盖 reason 必填校验、submit 触发 `onSubmit({ reason, hint })`、
    cancel 路径；`apps/dashboard/components/work-items/task-list.test.tsx`
    覆盖 `Replan` 按钮可见性 + dialog 装配；
    `work-item-detail.test.tsx` 覆盖 `replanWorkItemTask` 调用 +
    reload 路径。

- [x] **Operator 可以 mark rework / unskip / retry needs_rework，且
      WorkItem.status / 父 Issue handoff note 都按 aggregator 路径更新
      （不绕过 `reconcileWorkItem`）**。
  - 证据 1（mark-rework service）：
    `apps/orchestrator/src/work-items/__tests__/mark-rework.test.ts`
    覆盖完成态 → `needs_rework`、`needsReworkReason` 持久化、
    `task_marked_needs_rework` 事件、`reconcileWorkItem` 调用次数。
  - 证据 2（unskip service）：
    `apps/orchestrator/src/work-items/__tests__/unskip.test.ts`
    覆盖 `skipped → ready`、`task_unskipped` 事件、`reconcileWorkItem`
    调用次数。
  - 证据 3（端到端）：
    `work-items-v42-e2e.test.ts` §`markNeedsRework` 与 §`unskip`
    cases，端到端验证 WorkItem.status 从 `completed` 回到 `partial`、
    skipped task 被 `tick` 重新 dispatch。
  - 证据 4（aggregate 路径）：
    `apps/orchestrator/src/work-items/aggregate.ts` 增加 operator-driven
    settled state（`skipped` / `needs_rework`）的 carve-out，
    `effectiveTaskStatus` 让 markNeedsRework 不再被历史 link.status
    遮蔽；旧 e2e `work-items-e2e.test.ts` §`operator skip path`
    保持通过，确认 reconcile 路径仍写父 Issue handoff note + label。

- [x] **Dashboard 详情页可在 list / graph 之间切换；graph 视图渲染
      levels + edges + critical path 高亮**（组件测试覆盖）。
  - 证据 1：
    `apps/dashboard/components/work-items/view-toggle.test.tsx`
    覆盖 list/graph 互斥 + `aria-pressed` + `onChange` 回调。
  - 证据 2：
    `apps/dashboard/components/work-items/task-graph.test.tsx`
    覆盖节点渲染、edge `data-from` / `data-to` / `data-blocked`、
    critical path 高亮（`data-critical="true"` + warning ring）、
    空状态占位。
  - 证据 3：
    `apps/dashboard/components/work-items/work-item-detail.test.tsx`
    §view toggle，验证 toggle 后调用 `getWorkItemGraph` 并渲染
    `TaskGraph`。
  - 证据 4（URL 控制）：
    `apps/dashboard/app/work-items/[id]/page.tsx` 读取
    `?view=graph` query 作为 `initialView` 透传给 `WorkItemDetail`。

- [x] **team daemon 装配 work-items service：两个 project 互不可见、
      缺 `x-issuepilot-project` header 400**。
  - 证据 1（装配）：
    `apps/orchestrator/src/team/__tests__/work-items.test.ts` §1
    断言 `serverDeps.workItemsByProject` 是 `Map`，size === 2，
    两个 project id 都在；`workItems` 单实例未设置（强制 team-mode
    走 header 分发）；每个 service 暴露完整 V4.1 + V4.2 方法面。
  - 证据 2（命名空间隔离）：
    §2 断言不同 project 的 service 互不相同；§4（Task 22 新增）
    通过真实 `createServer` 起 Fastify 实例，HTTP 层 inject
    `/api/work-items` 请求：
    - 不带 header → 400 `project_header_required`；
    - `x-issuepilot-project: platform-web` → 仅返回 A 的 WorkItem；
    - `x-issuepilot-project: infra-tools` → 空列表；
    - `x-issuepilot-project: nonexistent` → 404 `project_not_found`。
  - 证据 3（路由层校验，跨场景共享）：
    `apps/orchestrator/src/server/__tests__/server.test.ts` 覆盖
    project header 路由、400 / 404 错误码、跨 work-item 路由的
    `resolveWorkItemService` 行为。

- [x] **全量 `pnpm -r build` / `pnpm -r lint` / `pnpm -r test` 通过；
      `git diff --check` 干净**。
  - 证据（2026-05-17 16:03 本地执行）：
    - `pnpm -r build` 全部 workspace exit 0（dashboard `next build`
      产出 `/work-items` + `/work-items/[id]` 路由；orchestrator /
      所有 packages `tsc -b` 干净）。
    - `pnpm -r lint` 全部 workspace exit 0（`--max-warnings 0`）。
    - `pnpm -r test` 共 **499+ 测试全部通过**：
      orchestrator 448（V4.1 基线 384 + V4.2 净增 64）+ tests/e2e
      51 + dashboard/shared-contracts 等其他 package 套件。
    - `git diff --check` 无空白噪音。

- [x] **文档 + CHANGELOG 已更新**。
  - `CHANGELOG.md` 顶部新增 `[Unreleased] V4.2 Task Graph` 段落。
  - `README.md` / `README.zh-CN.md` roadmap V4 段落新增 V4.2 已
    落地条目，指向 `2026-05-17-issuepilot-v4-2-task-graph.md`。
  - `USAGE.md` / `USAGE.zh-CN.md` 新增 §5.8
    *V4.2 Task Graph — graph view / replan / mark-rework / branch
    chaining / team-mode project switcher*；原 §5.8 顺延为 §5.9。
  - `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
    顶部「实施计划」加入 V4.2 链接。
  - 本文件即任务 25 的输出。

- [x] **V4.1 task execution contract 仍然成立**：
  - [x] Fake GitLab `createIssue` 调用次数为 0（V2/V4.1 不变量延续）。
    - 证据：`tests/e2e/fakes/gitlab/server.ts` 仍只暴露
      `createIssueNote`、`addIssueLabels` 等接口；
      `apps/orchestrator` / `packages/tracker-gitlab` 全文无对裸
      `createIssue(` 的调用。
  - [x] `TaskRunLink` 是唯一 canonical binding；replan 不复用
        runId，旧 link 留作历史证据。
    - 证据：`replan.test.ts` + `work-items-v42-e2e.test.ts`
      §single-task replan 断言 T2 重 dispatch 时 runIds 保留旧
      runId（历史），新 plan version 在 accept 后产出全新 runId。
  - [x] synthetic task run 的 `parentIssueLabelMode === "suppressed"`。
    - 证据：`apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`
      V4.1 三个 case 仍通过；V4.2 dispatch shim 沿用相同 mode 设置
      （`dispatch-task.ts`）。
  - [x] 父 Issue label / handoff note 仍只由 aggregator 经
        `decideWorkItemStatus` + `writeParentHandoff` 写。
    - 证据：`work-items-v42-e2e.test.ts` §markNeedsRework 验证
      `reconcileWorkItem` 触发 aggregator 重新计算 → WorkItem.status
      回 `partial` → 父 Issue label 切 `ai-rework`；中间没有
      synthetic task run 路径直接改 label。
    - 证据：`aggregate.ts` 的 `effectiveTaskStatus` 让 operator-driven
      `skipped` / `needs_rework` 不再被旧 TaskRunLink 状态遮蔽；
      `decideWorkItemStatus` 在 `report.overallStatus === "partial"`
      时返回 `partial`，handoff 状态机由此正确翻转。

## 不变量回顾（来自计划文末）

- [x] 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - 见上文「task execution contract」末两条证据。
- [x] TaskRunLink 是唯一 canonical task ↔ run binding；replan 不复用
      runId，旧 link 留作历史证据。
  - 见 §single-task replan e2e + `replan.test.ts`。
- [x] 不创建 child GitLab Issue；replan / mark rework / unskip 都只动
      IssuePilot 本地状态。
  - 见 `service.ts` 中 `replanTask` / `markNeedsRework` / `unskipTask`
    只调用 `store.saveTaskPlan` / `store.saveWorkItem` + emit 内部
    事件 + `reconcileWorkItem`，没有 tracker 写。
- [x] synthetic task run 的 `parentIssueLabelMode` 仍是 `suppressed`。
  - 见 `dispatch-task.ts` + `reconcile.test.ts`。
- [x] 单上游 branch chaining 必须能安全 fallback：上游 task 失败或被
      mark rework → 已 dispatch 的下游链回到 `blocked_by_dependency`
      等 operator 决策；in-flight run 仍跑完，结果由 aggregator 反映。
  - 见 `branch-chain.test.ts` §`completed but MR opened` 走 chain、
    §`>=2 upstreams and at least one not merged` 回退；
    `work-items-v42-e2e.test.ts` §branch chaining 不强行取消
    in-flight 下游 run，仅在下次 tick 时按当前 link 状态重新决策。
