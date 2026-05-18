# Changelog

本仓库的所有显著变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] V4.3 Review Packet + Evidence

### Added

- 2026-05-17 — **V4.3 Review Packet + Evidence**：在 V4.1/V4.2
  WorkItem 聚合基础上，把 Parent Review Packet 升级为 reviewer 可据此
  判断大 Issue 是否可交付的核心产物。设计源头是
  `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
  §7 V4.3、§14.3、§14.4、§15，实施计划是
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`。
  - **数据模型**（`@issuepilot/shared-contracts`）：
    `WorkItemEvidenceEntry.kind` 增加 `screenshot` / `recording` /
    `playwright` / `command_output` / `test_result`，新增
    `confidence` 三态、`evidenceId`、`source`、`confirmedBy` /
    `confirmedAt` 字段；`RunReportArtifact.evidence` 新增可选数组；
    `WorkItemReport` 增加 `humanReviewChecklist`、`ciSummary`、
    `testSummary`。
  - **事件**：新增 `work_item_evidence_indexed` /
    `work_item_evidence_confirmed` / `work_item_report_rendered`，envelope
    与既有 `IssuePilotInternalEvent` 保持一致。
  - **orchestrator**：task worktree
    `.issuepilot/evidence/<runId>/` 目录约定 + `manifest.json` 优先 +
    50MB 安全上限；evidence scanner 接入 daemon-level dispatch
    closure；aggregate 派生 checklist + CI/test summary；新增统一
    Markdown renderer，GitLab handoff note 与 dashboard Markdown export
    共用同一渲染源；新增
    `GET /api/work-items/:id/report.md`、
    `GET /api/work-items/:id/evidence`、受限静态
    `GET /api/work-items/:id/evidence/file`、
    `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm`
    路由；team-mode evidence file route 同时支持 `project` query。
  - **dashboard**：新增 `Evidence` 视图（`list` / `graph` / `evidence`
    三态切换），按 task / kind 分组渲染图片缩略图、录屏、
    Playwright zip、命令输出、测试结果；新增 `ConfidencePill` 与
    `HumanReviewChecklist`；`Copy as Markdown` 改为请求 orchestrator
    同源 `report.md`。
  - **测试**：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    覆盖 evidence happy path、confirm flow、oversized/rejected evidence
    follow-up、missing report/evidence；dashboard 增加 EvidenceTab /
    checklist / project-scoped evidence file URL 覆盖。本轮本地验证使用
    Codex bundled Node runtime（显式把
    `/Users/wangmeng5/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`
    放到 `PATH` 最前）跑过包级 Vitest；默认 Codex app Node 在当前机器会被
    Rollup native optional dependency code-signature 问题挡住，根 smoke 又被
    `pnpm` / `corepack` 缺失挡住，具体 gate 记录见
    `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence-acceptance.md`。
  - **不变量保持**：父 Issue label / handoff note 仍只由 aggregator 经
    `decideWorkItemStatus` + `writeParentHandoff` 写入；`TaskRunLink` 仍是
    canonical task-to-run binding；synthetic task run 的
    `parentIssueLabelMode === "suppressed"`；不创建 child GitLab Issue；
    evidence 文件不离开 task worktree。

### Security

- 2026-05-18 — **evidence-file-server symlink bypass 收口**：当 task
  worktree 内的 `<runId>` 子目录或 `.issuepilot` / `.issuepilot/evidence`
  中间路径是 symlink 指向 worktree 外（理论上 Codex 在 worktree 内可写），
  原本只对叶子文件做 `lstat` 不能阻止 sandbox 越界。现在
  `apps/orchestrator/src/work-items/evidence-file-server.ts` 增加二次
  realpath 校验：要求 realpath(`<taskWorktreePath>/.issuepilot/evidence/
  <runId>`) 仍必须落在 realpath(`<taskWorktreePath>`)/.issuepilot/evidence
  内。新增单测覆盖 runId 子目录是 symlink、`.issuepilot` 是 symlink 两类
  bypass 场景，并在 `work-items-v43-e2e.test.ts` 加一条端到端 case。

### Fixed

- 2026-05-18 — **Dashboard `?view=` 持久化**：`work-item-detail.tsx`
  通过 `history.replaceState` 把 `list` / `graph` / `evidence` 写回 URL，
  share-link 与刷新都会回到同一视图。
- 2026-05-18 — **EvidenceTab 乐观更新中间态消除**：confirm 期间
  `ConfidencePill` 不再抢跑变绿，pill 与按钮共享 in-flight 收尾，避免
  「pill 已绿 + 按钮仍 Confirming…」的可见冲突。失败时 pill 不需要回滚。
- 2026-05-18 — **render-report.test.ts fixture**：把非法 `kind: "artifact"`
  替换为合法 `command_output`，与 `WorkItemEvidenceKind` 枚举一致。
- 2026-05-18 — **manifest 内存防御**：evidence scanner 给
  `manifest.json.entries` 加 1000 条上限，超出量被记为 `manifest-overflow`
  rejected，aggregator 经 `appendOversizedFollowUps` 转入
  `WorkItemReport.openQuestions`，避免恶意/脏数据撑爆内存。

### Tests

- 2026-05-18 — V4.3 端到端 case 数量从 4 → 6：新增
  `assertV4Invariants` helper（fake GitLab `createIssue` 调用次数 0、
  per-task 唯一 `TaskRunLink`），并在每个 case 末尾正面断言；新增「runTaskOnce
  路径上 `parentIssueLabelMode === "suppressed"`」与「`<runId>` symlink 指向
  worktree 外被 forbidden」两条 e2e case。
- 2026-05-18 — `confidence-pill.test.tsx` 显式断言 pill 不带
  `role="status"` / `aria-live`，避免被 SR 当成 live region 反复 announcement。
- 2026-05-18 — `lib/api.test.ts` 加 `buildEvidenceFileUrl` 往返测试，固化
  client `URLSearchParams` 与 server form-decode 在 `+` / `%2B` / 空格 上
  的对称约定。

### CI / Tooling

- 2026-05-18 — 新增 `scripts/ci-equivalent-check.sh`：把
  `tsc -b` / `tsc -p scripts/tsconfig.json` / `next build`（dashboard）/
  `eslint --max-warnings 0` / 各 package 的 `vitest run` / `git diff --check`
  串成单一入口，给「默认 Node 跑不动 Rollup native binding」或缺少
  `pnpm` / `corepack` 的机器提供与 `pnpm -r build|lint|test` 等价的本地
  gate。配套更新 `AGENTS.md` §「验证要求」段落，把这个脚本写为代码变更
  交付前的默认 gate。

### Known limitations

- 单文件 evidence 大小上限 50MB，超出文件不进 evidence index 但写入
  `WorkItemReport.openQuestions`。
- Playwright trace 不内嵌渲染，dashboard 仅给 `npx playwright show-trace`
  提示链接。
- 视频不做转码、不生成图片缩略图，`<img>` 直接使用原图 + CSS `max-h`。
- `humanReviewChecklist` 在 V4.3 仅 read-only：所有项 `confirmed: false`，
  人工确认仍走 evidence 级 `POST .../evidence/:evidenceId/confirm`。
- `manifest.json.entries` 单 manifest 上限 1000 条，超出量被记为
  `manifest-overflow` 并提示 reviewer 检查。
- evidence 持久化保留在 task worktree，未引入对象存储；50MB 上限和
  worktree 隔离都依赖文件系统语义，可在 V3 引入对象存储后放宽。

## [Unreleased] V4.2 Task Graph

### Added

- 2026-05-17 — **V4.2 Task Graph**：在 V4.1 Workflow Spine 基础上加入依赖
  图执行、Task Graph 可视化、单 task replan、local mark-rework / unskip、
  branch chaining、team-mode 多 project work-items 装配。设计源头是
  `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
  §7 V4.2，实施计划是
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`。
  - **数据模型**（`@issuepilot/shared-contracts`）：`TaskNode` 增加
    `needsReworkReason`；`TaskPlan` 增加 `replanOf: { planId, taskId }`；
    `TaskPlanEdit.field` 联合类型加入 `"replan"`；`TaskNode.runIds`
    在 dispatch 时按时间顺序 append，replan 时保留作为历史证据。
  - **事件**：新增 `task_marked_needs_rework` / `task_replanned` /
    `task_unskipped` / `task_graph_recomputed`，envelope 与 V4.1
    `IssuePilotInternalEvent` 完全一致。
  - **orchestrator HTTP API**：新增 4 条 work-item 路由
    `POST /api/work-items/:id/tasks/:taskId/replan`、
    `POST /api/work-items/:id/tasks/:taskId/mark-rework`、
    `POST /api/work-items/:id/tasks/:taskId/unskip`、
    `GET  /api/work-items/:id/graph`；全部 work-item 路由（含
    V4.1 既有路由）支持 `x-issuepilot-project` header 做 team-mode
    路由分发，缺 header → 400 `project_header_required`，未知
    project id → 404 `project_not_found`。
  - **orchestration**：`tickWorkItem` 在 dispatch 单上游依赖的 task
    时调用 `decideEffectiveBase`，上游 `completed` 且 MR 未 merged
    时下游 `DispatchInput.baseBranch === origin/<上游分支>`（线性
    chaining）；多上游或上游失败回退为「等所有上游 merged」的
    `blocked_by_dependency` 状态。`task_run_dispatched` 事件在 chain
    场景下附带 `chainedFrom` / `baseOverride` 用于审计。
  - **team daemon**：`apps/orchestrator/src/team/daemon.ts` 装配
    `workItemsByProject: Map<string, WorkItemService>`，每个 project
    独享 `.issuepilot/` workspace 命名空间；planner / fetchIssue /
    tick 在 V4.2 仍是 operator-driven stub（Phase 3 再接 GitLab
    adapter）。
  - **dashboard**：新增 Task Graph SVG 视图（topology layout + critical
    path 高亮）、list/graph view toggle、单 task replan dialog、mark
    rework dialog、unskip 按钮、team-mode 顶栏 Project Switcher
    （`localStorage` 持久化 + `x-issuepilot-project` header 自动注入）。
  - **测试**：orchestrator 用例从 384 提升到 448（+64 / +16.7%），新增
    branch-chain 单测、replan / mark-rework / unskip / graph service 单测、
    `work-items-v42-e2e.test.ts` 端到端覆盖 chain + replan + mark-rework
    + unskip、`team/work-items.test.ts` HTTP 路由层 project header 隔离
    覆盖；dashboard 增量增加 TaskGraph / ViewToggle / Replan / MarkRework /
    ProjectSwitcher 组件测试。`tests/e2e` 51 个 V1/V2 happy-path 用例
    全部保持通过。
  - **不变量保持**：父 Issue label / handoff note 仍只由 aggregator 经
    `decideWorkItemStatus` + `writeParentHandoff` 写入；replan / mark-rework
    / unskip 全部走 `reconcileWorkItem`；不创建 child GitLab Issue；
    synthetic task run 的 `parentIssueLabelMode` 仍是 `"suppressed"`；
    `aggregate.decideOverallStatus` 增加 operator-driven 状态
    （`skipped` / `needs_rework`）的 carve-out，使 `markNeedsRework`
    能让 WorkItem 从 `completed` 回到 `partial`；与之配套的
    `decideParentLabelTransition` 同步增加 4 条 V4.2 状态迁移
    （`completed → partial`、`partial → running`、`partial → completed`、
    `completed → running`），覆盖 §12.3 rework loop：父 Issue label
    在 `markNeedsRework` 时由 `human-review` → `ai-rework`，retry
    后由 `ai-rework` → `ai-running`，loop closed 后由 `ai-rework`
    → `human-review`。

- 2026-05-17 — **V4.2 Task Graph code review fix**：补齐 V4.2 review
  发现的 3 个 Critical + 4 个 Important 缺陷，使 §12.3 rework loop /
  team-mode SSR / dashboard 状态渲染真正闭环。
  - **C1**（Critical）—— `apps/orchestrator/src/work-items/orchestration.ts`
    `computeReadyTasks` 之前会跳过任何已有 `TaskRunLink.status === "completed"`
    的 task，导致 `retryTask` / `replanTask` 对历史 completed task 是
    silent no-op；spec §12.3 的 rework 回路根本走不下去。修复：删除
    历史 link 的 completed-skip，仅保留 `running` link 作为 spec §11.4
    幂等守卫；`task.status`（operator 驱动：retryTask / unskipTask /
    acceptPlan after replan 都把它设回 `ready` / `planned`）成为是否
    re-dispatch 的唯一来源。新增 e2e 用例：plan + 两 task 全部 complete
    + markNeedsRework T2 + retryTask T2 → T2 在新 runId 上重派，
    `T2.runIds` 携带两次尝试，旧 `completed` link 仍保留作为历史证据。
  - **C2**（Critical）—— `decideParentLabelTransition` 之前只识别
    `ready → running` 和 `running → completed` 两条迁移，V4.2 引入的
    `completed → partial` 等四条迁移全部是 silent no-op，使
    `markNeedsRework` 后父 Issue label 卡在 `human-review`。修复：
    `handoff.ts` 增加 4 条 V4.2 状态迁移（见上一节）；同时给
    `retryTask` / `unskipTask` 末尾补 `await deps.reconcileWorkItem(...)`，
    让 tick 之后 WorkItem-level aggregate 与父 label 立刻跟上 in-flight
    状态。`handoff.test.ts` 新增 4 条迁移单测；`work-items-v42-e2e.test.ts`
    新增 rework 回路 e2e：merged → markNeedsRework → retry → re-merge，
    断言每次 label flip 都落到 fake GitLab adapter 的 labelLog。
  - **C3**（Critical）—— `apps/dashboard/app/work-items/[id]/page.tsx`
    是 Server Component，team-mode 下调用 `getWorkItem(id)` 时无法读
    `localStorage`，orchestrator 返回 400 `project_header_required`，
    详情页直接渲染错误 banner。修复：新增
    `apps/dashboard/lib/active-project-cookie.ts` 共享 cookie key；
    ProjectSwitcher 在选择 / 水合时同步写入 cookie；详情页通过
    `next/headers` 的 `cookies()` 读 cookie 并以 `{ project }` 透传给
    `getWorkItem`。新增 SSR 单测在 cookie 命中 / 缺失两种场景下
    分别断言 `getWorkItem` 拿到正确的 `opts.project`。
  - **I1**（Important）—— `task-list.tsx` 的 `effectiveStatus`
    （`link?.status ?? task.status`）与 `aggregate.effectiveTaskStatus`
    （operator-driven `needs_rework` / `skipped` 优先）不一致，导致
    operator 把已完成 task 标为 needs_rework 后，dashboard 仍把它分到
    `Completed` 组并显示 Mark-rework 按钮。修复：把
    `effectiveTaskStatus` 提升到 `@issuepilot/shared-contracts`，
    orchestrator 与 dashboard 共用同一份函数；新增两条 task-list 单测：
    operator-driven `needs_rework` 胜过历史 completed link、
    operator-driven `skipped` 胜过历史 running link。
  - **I2**（Important）—— `ProjectSwitcher` 之前在 `useState` 的 lazy
    initializer 里读 `localStorage`，SSR 与首次 client render 不一致，
    React 会发出 hydration mismatch warning。修复：`useState("")` 保持
    确定性，把 `localStorage` 读取 / cookie 同步 / API client 模块状态
    更新全部移到 post-mount `useEffect`；新增 `console.error` 探针
    单测固化 SSR-safe 模式。
  - **I3**（Important）—— `apps/dashboard/app/work-items/page.tsx`
    的首屏 `listWorkItems()` 与 ProjectSwitcher 的 mount effect 竞态，
    cold-load 经常拿不到 `x-issuepilot-project` header 即返回 400。
    修复：load() 顶部同步读 `localStorage` 并把值同时塞给
    `setActiveWorkItemsProject` 和 `listWorkItems` 的 `opts.project`，
    使第一发 fetch 始终携带 header；新增列表页 CSR 单测覆盖。
  - **I4**（Important）—— CHANGELOG / USAGE / README 之前已经声明
    `markNeedsRework` 会驱动父 Issue label 转 `ai-rework`，但实际实现
    缺失（C2）。本次同时修订 CHANGELOG 与 §12.3 rework 描述，使其与
    `decideParentLabelTransition` 的最新行为对齐，避免操作员根据文档
    误判。

### Fixed

- 2026-05-17 — **V4.1 Workflow Spine code review fix**：补齐之前 review 发现的
  4 个缺陷（2 个 Critical + 2 个 Important），使 V4.1 闭环在生产环境真正生效。
  - **C1**（Critical）—— `apps/orchestrator/src/daemon.ts` 中的 V4.1
    `dispatchTask` 之前是 no-op stub（注释里写着「lands in V4.2」），synthetic
    task run 在生产里根本不跑。修复后通过 `runTaskOnce` shim 把
    `parentIssueLabelMode: "suppressed"` 的 `DispatchInput` 接到真正的
    `orchestrator/dispatch.ts`，按 V2.x 路径完成 mirror / worktree /
    Codex agent / commits / MR / `RunReportArtifact`，但 `onFailure`
    单独实现成「只 mark report failed，不动父 Issue label / note」以
    维持 spec §11.2 的「合成 task 不允许越过 aggregator 触父 Issue」契约。
    重 dispatch 异步 fire-and-forget，不阻塞 operator 的 HTTP 调用。
    `runTaskOnce` 的接口同步收紧成 `dispatch: (input) => Promise<void>`（去掉
    `deps` 参数），让 daemon 可以在 runId / branch 已知后再构造
    DispatchDeps，避免把 `{} as never` 喂给 V2.x dispatch。
  - **C2**（Critical）—— `daemon.ts` 的 `reconcileWorkItem`（service 调用
    `skipTask` / `retryTask` 时走的路径）之前直接拿未变 `WorkItem` 调
    `writeParentHandoff`，导致 `previousStatus === currentStatus`、
    `decideParentLabelTransition` 永返回 `{ add: [], remove: [] }`，父
    Issue label 永远卡在 `ai-running`。修复后改成
    「aggregate → `decideWorkItemStatus(...)` → `saveWorkItem(updated)`
    → `writeParentHandoff({ workItem: updated, previousStatus, ... })`」
    与 `service.settleTaskRunFinal` 完全同构。`decideWorkItemStatus`
    从 service.ts 导出供 daemon 复用，避免两条路径 drift。
  - **I1**（Important）—— `service.acceptPlan` 之前对 operator `edits`
    跳过 `validatePlanDraft`，cycles / unknown deps / 空 title 会被持久化成
    `accepted`。修复后在 `applyEdits` 之后重跑校验，失败时返回
    `validation_failed`。
  - **I2**（Important）—— `decideWorkItemStatus` 把 `incomplete` 分支的
    `someRunning ? "running" : "running"` 死代码三元清掉，改成显式
    `return "running"` 并加注释解释「incomplete 总是当 in-flight 处理，
    让父 Issue 抢到 `ai-running` label」。
  - 测试新增：
    - `service.test.ts` 加 `"acceptPlan rejects operator edits that
      introduce a dependency cycle"` 与 `"... empty out a required
      field"`，断言 `validation_failed.code` 与 plan 仍处于 `draft`。
    - `work-items-e2e.test.ts` 加
      `"operator skip path: reconcileWorkItem advances WorkItem.status
      and emits the parent label transition (C2)"`，证明
      reconcile 把 `WorkItem.status` 从 `ready` 推到 `running`、
      `summaryReportId` 被写入、并在 `gitlab.transitionLabels` 里看到
      `add: ["ai-running"], remove: ["ai-ready"]`（pre-fix 三个断言全部
      会失败）。
    - 同文件的 harness `reconcileWorkItem` 也按 C2 修正，跟 daemon 保持
      同构。
  - 验证：`pnpm -r build` / `pnpm -r typecheck` /
    `pnpm -r lint --max-warnings 0` /
    `pnpm -r test -- --maxWorkers=1 --minWorkers=1`（orchestrator 384 +
    e2e 51 + dashboard 等）全部绿；`git diff --check` 干净。

### Added

- 2026-05-17 — **V4.2 Task Graph 实施计划起草**。新增
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`，覆盖
  V4 spec §7 V4.2 的六项能力：依赖图执行 + 线性 branch chaining、Task
  Graph 可视化（topology SVG）、单 task 重规划保留 plan version、Mark
  rework / Unskip / Retry 操作完整化、team-mode daemon 装配 work-items
  service 并通过 `x-issuepilot-project` header 隔离多 project。计划共
  25 个 TDD 任务（含 contract / orchestration / dispatch / service / server /
  daemon / dashboard / i18n / E2E / 文档 / 验收），均以 V4.1 已落地代码
  作为抓手，不引入 reactflow / dagre 以控制 dashboard bundle 增长。
  对应 spec：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`。

- 2026-05-17 — **V4.1 Workflow Spine 闭环落地（任务 11–22）**。在已有的契约 +
  store + planner + orchestration + aggregate 之上补齐 parent handoff、HTTP
  路由、daemon 装配、dashboard UI、E2E 与文档收口，使一个大 GitLab Issue
  能在 IssuePilot 内完成「拆解 → operator 接受 plan → 多个 synthetic task
  run → 汇总报告 → 父 Issue 切到 `human-review`」的完整闭环（spec §16.5 / §17）。
  - `apps/orchestrator/src/work-items/handoff.ts`：`writeParentHandoff` 是 V4.1
    唯一允许动父 Issue label / handoff note 的地方，note 用
    `<!-- issuepilot:work-item:<id> -->` marker 做幂等更新；
    `decideParentLabelTransition` 把 `running → completed` 翻译成
    `add: [handoffLabel], remove: [runningLabel]`，其余转移留给 operator。
  - orchestrator 新增 8 条工作单元 HTTP 路由：`POST /api/issues/:iid/plan`、
    `GET /api/work-items`、`GET /api/work-items/:id`、
    `POST /api/work-items/:id/plan/accept`、
    `POST /api/work-items/:id/plan/regenerate`、
    `POST /api/work-items/:id/tasks/:taskId/skip|retry`、
    `GET /api/work-items/:id/report`。所有 POST 透传
    `x-issuepilot-operator` header，错误统一映射成 `not_found` / `invalid_iid` /
    `validation_failed` / `planner_failed` / `work_items_unavailable`。
  - `apps/orchestrator/src/work-items/service.ts` `createWorkItemService`
    把 store / planner / orchestration / aggregate / handoff 装到一个 façade，
    `settleTaskRunFinal` 监听 `dispatch_completed` / `dispatch_failed`，串起
    "applyTaskRunFinal → aggregate → 更新 WorkItem.status → writeParentHandoff"
    一条线；`apps/orchestrator/src/daemon.ts` 把它接到 Fastify server 与
    eventBus 上，并通过 `taskRunIndex` 做 runId↔workItem 的反查。
  - dashboard 新增 `apps/dashboard/lib/api.ts` work-item 客户端
    （`planWorkItem` / `listWorkItems` / `getWorkItem` /
    `acceptWorkItemPlan` / `regenerateWorkItemPlan` /
    `skipWorkItemTask` / `retryWorkItemTask` / `getWorkItemReport`），
    全部透传 operator header。
  - dashboard 新增 `/work-items` 列表（按 6 种状态展示 counters + 表格，
    空态、行点击进入详情）、`/work-items/[id]` 详情（顶部 WorkItem 元数据 +
    `PlanEditor` + `TaskList` + `ParentReviewPacket`），并在顶栏导航与
    Command Center inspector 暴露入口（`Plan work item` 按钮 → 调
    `planWorkItem(iid)` 后硬导航到 `/work-items/<id>`）。
  - `PlanEditor`：`plan.status === "draft"` 时支持
    `title/goal/scope/dependsOn/suggestedValidation` 五个字段的
    inline editing；接受时只 POST operator 改过的字段（diff against
    snapshot）。一旦 plan accepted 就锁定，后续只能走 regenerate 起新版本。
  - `TaskList`：按 effective status（TaskRunLink 优先 TaskNode）分组，
    failed / needs_rework / blocked 行显示「Retry」，可跳过状态显示
    「Skip」，draft plan 下两个按钮 disabled。
  - `ParentReviewPacket`：把 `WorkItemReport` 映射成 status banner（complete
    /partial/incomplete/draft）、validation summary、risks、每 task 卡片
    （diff、validation、risks、follow-ups、CI、next action、MR 链接）、
    open questions、recommended next actions 与 evidence index。
    内置「Copy as Markdown」按钮把同样的内容复制到剪贴板，`renderMarkdown`
    与 GitLab handoff note 同源；测试断言 V4.1 永远不输出
    `ready_to_merge` 字样（spec §17）。
  - 新增 `apps/orchestrator/src/__tests__/work-items-e2e.test.ts`：使用
    real WorkItemStore + real planner / orchestration / aggregate /
    handoff、fake GitLab + fake LLM + fake run dispatch，覆盖 happy path
    （两 task 全 completed → 父 Issue label 进 `human-review`、note 含
    work-item marker）、partial 路径（一 task fail → `WorkItem.status`
    转 `partial`、父 Issue label 不进 `human-review`）、dependency 路径
    （T2 dependsOn T1，T1 MR 仅 `opened` 未 merged → T2 保持
    `blocked_by_dependency` 并 emit `task_run_blocked_by_dependency`）。
  - i18n（`apps/dashboard/i18n/messages/{en,zh}.json`）补齐
    `nav.workItems`、`workItems.*`（counters / columns / 空态 / 错误）、
    `workItem.field.*` / `workItem.plan.*` / `workItem.tasks.*` /
    `workItem.parentReviewPacket.*` / `workItem.action.*` 全集，中英双语
    同步。
  - 验证：`pnpm -r build` / `pnpm -r typecheck` / `pnpm -r lint`
    （`--max-warnings 0`）/ `pnpm -r test`（orchestrator 381 + dashboard 131
    + e2e 51 + 其它包）全绿；`git diff --check` 干净。
  - 任务 22 验收清单：`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine-acceptance.md`
    给出 V4.1 §17 验收标准的逐项证据（E2E case、组件测试、reconcile
    `parentIssueLabelMode: "suppressed"` 覆盖、`createIssue` 不调用、
    全量 build/test/lint 通过、双语文档同步）。

- 2026-05-17 — **V4.1 Workflow Spine 实施 plan 与首批契约落地**。
  - 新增 `docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`：
    22 任务、TDD 流程的 bite-sized 实施计划，对齐 V4 设计 spec §7
    V4.1、§9 数据模型、§16 测试策略、§17 验收标准；明确遵守 V4.1 task
    execution contract（不创建 child Issue、per-task run 不动父 Issue
    label、`TaskRunLink` 唯一 binding、父 Issue handoff 由 aggregator
    统一写入）。
  - 新增 `@issuepilot/shared-contracts` work-item 契约：`WorkItem` /
    `TaskPlan` / `TaskNode` / `TaskRunLink` / `WorkItemReport`、状态枚举
    （`planning|ready|running|partial|completed|blocked` 等）和 type
    guard。`RiskLevel` 与 V2.5 `RunReportArtifact` 共用 `report.ts` 的
    定义，避免在两处定义不同字面量。
  - 注册 13 条 V4.1 事件类型：`work_item_created` /
    `work_item_plan_drafted` / `work_item_plan_accepted` /
    `work_item_plan_rejected` / `work_item_plan_regenerated` /
    `work_item_planning_failed` / `task_run_dispatched` /
    `task_run_completed` / `task_run_failed` / `task_run_skipped` /
    `task_run_blocked_by_dependency` / `work_item_aggregated` /
    `work_item_handoff_written`。
  - 新增 V4.1 HTTP 响应类型：`WorkItemsListResponse`（counters 覆盖全部
    `WorkItemStatus`）、`WorkItemDetailResponse`（plan history + tasks +
    runLinks + 可选 report）、`PlanWorkItemRequest`、
    `AcceptWorkItemPlanRequest`（带 operator edits 数组）、
    `WorkItemReportResponse`。
  - 新增 `apps/orchestrator/src/work-items/` 模块（store / planner /
    validation 三件套）：
    - `WorkItemStore`：file-backed JSON 持久化，按 spec §10 落到
      `work-items/`、`task-plans/`、`task-run-links/<taskId>/`、
      `work-item-reports/` 四个目录；内存缓存只是 fast path，所有写都过
      `redact()` 落盘；`getCurrentPlan` 返回最高 version 非 `rejected`
      的 plan；`listAllTaskRunLinks` 按 `WorkItem.taskIds` 反查每个
      taskId 目录。
    - `validatePlanDraft`：强制 2–5 任务、依赖图无环（DFS 三色法，含
      self-loop）、所有 `dependsOn` 目标必须存在、`taskId` 必填且唯一、
      `title` / `goal` 不能空白、`riskLevel` 必须在 `RISK_LEVEL_VALUES`
      内；遇到第一条违规即返回稳定 code（i18n / 质量分析友好）。
    - `WorkItemPlanner`：可注入 `callPlannerLlm` 的拆解器，把大 Issue
      文本转成 `TaskPlan` draft；JSON 解析失败、LLM 抛错、validation
      失败统一映射成稳定 code（`planner_call_failed` /
      `planner_parse_failed` / forwarded validator codes）。
  - `reconcile.ts` 引入 `parentIssueLabelMode: "active" | "suppressed"`：
    V2.x 单 Issue→单 MR 路径保持 `"active"`（默认），自动写父 Issue
    workpad handoff note 并切到 `human-review`；V4.1 synthetic task run
    设为 `"suppressed"`，只走 push / create MR / update MR，**不**
    写父 Issue note 也**不**切父 Issue label —— parent handoff 完全由
    WorkItem aggregator（V4.1 任务 11）统一执行。已有 V2.x 调用方
    无需改动（参数省略时退回 `"active"`）。
- 2026-05-17 — **V4.1 任务 8–10：synthetic task run 编排与 WorkItemReport
  聚合**。建立"plan → ready tasks → synthetic runs → 汇总报告"链路的
  中间三层。
  - 任务 8 — `apps/orchestrator/src/work-items/dispatch-task.ts`：synthetic
    task run 的 dispatch 薄壳。生成新 `runId`、写 `RunRecord(status="claimed")`
    并附带 `workItem: { workItemId, taskId }` 反向指针，构造任务级
    branch（`<branch_prefix>/<iid>-<task-slug>`）以及任务级 prompt
    vars（`workItem.taskId/.taskTitle/.taskGoal/.taskScope/.suggestedValidation/`
    `.dependsOn/.dependenciesSummary/.riskLevel`），并把
    `parentIssueLabelMode: "suppressed"` 透传给底层 `dispatch()`。事件
    发射保留给 orchestration 层，避免 retry / replay 重复 emit。
  - `apps/orchestrator/src/orchestrator/dispatch.ts` 配套扩展：
    `DispatchInput` 新增 `parentIssueLabelMode?` 与 `extraPromptVars?`；
    `DispatchDeps.reconcile` 同步暴露 `parentIssueLabelMode?`，dispatch
    在调用 `deps.reconcile` 时把字段透传过去。`extraPromptVars` 在合并
    时不会覆盖 `issue` / `workspace` / `git` / `attempt` 等 canonical key。
    V2.x 既有调用方无须改动（默认值保持 V2 行为）。
  - 任务 9 — `apps/orchestrator/src/work-items/orchestration.ts`：
    plan → ready tasks → runs → status update 三段式纯函数 + I/O 边界。
    - `computeReadyTasks(plan, links, upstreamMerged)`：纯函数，按
      `planned/ready/blocked_by_dependency` 状态、活跃 TaskRunLink、
      已完成 TaskRunLink 与 upstream MR 是否 merged 共同决定哪些任务
      可以下发。`needs_rework` 不被自动重派，留给 operator 显式 retry。
    - `tickWorkItem(workItem, plan, links, deps)`：单次 tick。先 await
      每个 completed link 的 RunReport 拿 `mergeRequest.state`（spec
      §12.4 的"upstream MR 未合并 → 下游保持 blocked"），再调
      `computeReadyTasks`，按 `availableSlots()` 节流（V4.1 不引入
      per-WorkItem 配额，先到先得）。每次成功 dispatch 都写
      `running` TaskRunLink + `running` TaskNode + emit
      `task_run_dispatched`；upstream 未 merge 的下游 emit
      `task_run_blocked_by_dependency`；slot 不够的留到下次 tick，
      返回值 `{ dispatched, blockedByDependency, blockedBySlots }`
      让 dashboard 也能看出原因。
    - `applyTaskRunFinal(input, deps)`：daemon 监听
      `dispatch_completed` / `dispatch_failed` 后调用，把 RunReport
      映射成 TaskNodeStatus（completed/failed/blocked，retrying/running
      回退成 running），写 TaskRunLink（含 `mergeRequest.iid/.url`），
      在 failed/blocked 时把 `lastError.message` 落进
      TaskNode.statusReason，并 emit `task_run_completed` / `task_run_failed`
      （V4.1 事件词表暂没有 `task_run_blocked`，run.blocked 走
      `task_run_failed` 并在 detail 里保留 `status: "blocked"`，
      与 `task_run_blocked_by_dependency` 区分语义）。
  - 任务 10 — `apps/orchestrator/src/work-items/aggregate.ts`：
    `aggregateWorkItem(workItem, plan, links, deps)` 把每个 task 的
    `RunReportArtifact` 聚合成单一 `WorkItemReport`：
    - `overallStatus` 矩阵：每个 task 都有 completed link + 报告 →
      `complete`；任一 task 缺 link 或缺报告 → `incomplete`；其余存在
      `failed`/`blocked`/`needs_rework`/`skipped` → `partial`。**任何**
      情况下都不会输出 `ready_to_merge` 或自动 merge 建议（spec §17 硬
      约束，单测断言整段 JSON 不含该字符串）。
    - 每 task 一条 summary：标题、status（取最新 link 状态、回退到
      TaskNode）、可选 `runId` / `diffSummary` / `mergeRequestUrl` /
      `ciStatus` / `nextAction`。`nextAction` 仅在能给出有意义指引时
      才写入（兼容 `exactOptionalPropertyTypes`）。
    - Evidence 索引同时输出 `index`（扁平时间线）和 `byTask`（按 task
      折叠卡片），覆盖 `diff` / `validation` / `risk` / `ci` /
      `review_feedback` 五种 kind。
    - `recommendedNextActions`：complete 推 reviewer 介入并切
      human-review；partial 列出具体 failed / blocked / skipped 任务
      建议 retry / 决策；incomplete 提示等待飞行任务结算后重新聚合。
    - `validationSummary` / `riskSummary` 按 task 拼接成可读 markdown
      行，给父 Issue handoff note 与 dashboard Parent Review Packet
      共用同一份事实源。
    - 取最新 TaskRunLink（按 `attempt`，平手按 `startedAt`）使重试结果
      自然覆盖前次。
  - 测试覆盖：dispatch-task 4 cases、orchestration 13 cases（ready 计算
    / blocked / 并发限速 / 下游门控 / final 状态映射）、aggregate 7
    cases（complete / partial / incomplete / 缺 link / never
    ready_to_merge / evidence kind 索引 / 失败任务 next actions）。
    全仓 `pnpm -r build` / `pnpm -r test` 通过（orchestrator 343、
    e2e 51）。`git diff --check` 干净。

### Fixed

- 2026-05-17 — **V4.1 任务 1–7 code review 修复**。
  - `apps/orchestrator/src/work-items/planner.ts`：收紧
    `isRawPlanResponse` 的 element 校验，确保数组里 `null` / 字符串等
    非对象 entry **也**被 funnel 到稳定错误码 `planner_parse_failed`，
    而不是抛裸 `TypeError`。这一项守住 planner header 注释里承诺的
    "所有 LLM/parse 失败都映射为稳定 code" 契约（V4 spec §12.1 拆解
    失败）。补充 `planner.test.ts` 两个回归用例（`[null]`、字符串
    entry）。
  - `apps/orchestrator/src/work-items/store.ts`：移除 `loadPlansFromDisk`
    里的空 `if (plan.workItemId === workItemId) {}` dead 块；把"为何
    hot-load 整目录"的设计意图改写到函数顶部 leading comment。
    `workItemId` 参数保留（call site 可读性），仅在体内显式标注未使用。

### Changed

  主设计 spec 同步）。
  - **V3 收敛为生产化执行平台**：部署形态、worker、sandbox、身份权限、
    预算配额、Postgres 持久化、Webhook + poll、GitLab 审计 / secret 治理、
    可选自动 merge、观测和运维 runbook。
  - **V4 收敛为智能研发工作台**：大 Issue 拆解、跨 Issue 依赖、多 agent
    协作、智能 review、验收材料、质量分析、workflow / skills 持续改进和
    多执行器生态。
  - **执行顺序改为 V4 → V3**：V3 / V4 作为能力域编号，不再强制按数字顺序
    交付；先在现有 V2.x runtime 上验证研发流程智能，再用 V3 把已验证能力
    平台化。
  - **补充 local-first 路线原则**：先把本地版 / 团队机器版的流程能力打磨
    完整，登录、权限、预算、生产部署、集中存储、审计和观测统一后置到 V3。
  - **移除隐含的中间智能阶段**：不再把 V4 的流程智能拆成独立过渡版本；
    V4 就是下一阶段的智能研发工作台，后续 V3 再做生产可部署和治理。
  - **主 spec §20 修正 V2 状态**：从旧的"Phase 3 已合入、下一步 Phase 4"
    更新为 V2 Phase 1–5、V2.5 Command Center、V2.6 dashboard shell 均已
    完成，并把可选自动 merge 从 V2 摘要下沉到 V3 生产策略。

- 2026-05-17 — **USAGE 文档精简 + 中心化配置过时项修复**（中英双语同步）。
  - **§5 重构、节省 ~7 行**：合并 §5.1 入口对比到 Part 5 引言（V1/V2 选型
    已在 §1.2），后续 §5.2..§5.8 顺移为 §5.1..§5.7。
  - **§5.1 中心化 team config 示例精简**：
    - 删 `defaults.labels` / `defaults.codex`（schema 接受但 compiler 尚未
      消费，留着误导读者）。
    - team-wide `ci:` 和 `retention:` 改为注释示例（profile 已默认提供，
      只有真正想 override 时才需要写）。
    - project 文件里的 `agent.*` 改为注释示例（profile 兜底，多数情况无需
      在 project 文件里覆盖）。
    - 字段约束表的 `projects[].project` 与 `projects[].workflow_profile`
      合并为同一行，去掉重复描述。
    - 把"`projects[].workflow` 不再支持"那段精简到一段话，明确"loader 会
      以可操作 dotted-path 错误（指向需要替换为的字段）拒绝加载"，与
      Important #1 修复呼应。
  - **§5.2 加入 `render-workflow`**：新增 4 步工作流（validate → render →
    run → dashboard），明确"编译产物永远不落盘 / 敏感字段已脱敏"。
  - **§1.2 V1/V2 对照表修复过时项**：V2 行的 "Config source of truth"
    从 `issuepilot.team.yaml aggregating multiple WORKFLOW.md` 改为
    `中心化 issuepilot-config/ 目录：issuepilot.team.yaml + projects/*.yaml
    + workflows/*.md`。
  - **§1.3 目录角色补全**：增加 `/path/to/issuepilot-config` 块（V2 入口），
    并明确 `WORKFLOW.md` 仅 V1 单项目入口使用。
  - **§3 Part 入口前置说明**：澄清 §3.3（`WORKFLOW.md`）和 §3.5
    （`validate --workflow`）仅 V1 入口使用，V2 团队模式由 §5.1 中心化
    配置接管并改用 `validate --config`。
  - **§7.1 CLI 速查表**：新增 `render-workflow --config ... --project ...`
    命令条目。

- 2026-05-17 — **code-review 修复：中心化 workflow 配置 PR 收口**。基于
  `code-reviewer` subagent 的审查反馈修了 3 个 Important + 1 个 Minor 问题：
  - **legacy `projects[].workflow` 错误信息可操作化**（`apps/orchestrator/src/team/config.ts`）：
    新增 `detectLegacyProjectFields` 前置检查，遇到 `workflow:` 字段时
    直接抛出 `projects.0.workflow: \`projects[].workflow\` is no longer
    supported in team mode; replace it with \`project: ./<project>.yaml\`
    and \`workflow_profile: ./<profile>.md\` ...`，避免被 zod 的"required
    field missing"误导到 `project` 字段上。测试断言收紧为
    `path === "projects.0.workflow"` + 消息匹配 `no longer supported` /
    `workflow_profile`，把契约绑死。
  - **`render-workflow` 输出 hooks / retention / prompt_template**
    （`apps/orchestrator/src/cli.ts`）：之前 `renderWorkflowYaml` 默默
    丢弃了 `hooks` / `retention` / `promptTemplate`——operators 审计
    workflow 时恰恰需要看到 shell 命令和完整的 Codex 提示词。现在补齐
    这三块，prompt 用 YAML literal block scalar（`|`）保留 newline 和
    Liquid 标签；CLI 测试新增对 `after_create` / `before_run` / `after_run`
    / `retention.successful_run_days` / `prompt_template: |` 多行块的
    断言，仍 assert `token_env` / `GITLAB_TOKEN` / `sha256` 等敏感字段不
    出现。
  - **`scheduler.test.ts` fixture 更新**：之前的 `project()` helper
    仍引用已删除的 `workflowPath` 字段，因为 orchestrator tsconfig
    排除了 `**/*.test.ts`，`tsc --noEmit` 不会报错——一颗静默漂移
    地雷。改用新的 `projectPath` / `workflowProfilePath` /
    `effectiveWorkflowPath` 三字段。
  - **`cli.test.ts` 两个 team-daemon fixture** 仍写 `workflow:
    ./WORKFLOW.md`（被 mock 跳过解析所以通过），同步迁移到 `project:` +
    `workflow_profile:` 以免误导后人。
  - 全部 4 个包测试和 typecheck 仍然全绿。

- 2026-05-17 — **IssuePilot 中心化 workflow 配置（破坏式替换 team mode 输入模型）**。
  按 `docs/superpowers/plans/2026-05-17-issuepilot-central-workflow-config.md` 全量落地
  `docs/superpowers/specs/2026-05-17-issuepilot-central-workflow-config-design.md`：
  - **schema**：`issuepilot.team.yaml -> projects[]` 字段从单一 `workflow`
    拆成必填的 `project`（项目事实文件）+ `workflow_profile`（工作流模板），
    新增可选 `defaults`（`labels` / `codex` / `workspaceRoot` / `repoCacheRoot`）。
    `apps/orchestrator/src/team/config.ts` 改用 `z.strictObject`，遇到
    遗留的 `projects[].workflow` 会显式报 `projects.<n>.workflow:
    Unrecognized key`。
  - **compiler**：新增 `@issuepilot/workflow#compileCentralWorkflowProject`
    （`packages/workflow/src/central.ts`），先用新的 `parseWorkflowString`
    把 profile 内容解析为 base `WorkflowConfig`，再合并 project 文件里
    project-level 字段；profile 不允许覆盖 high-risk 字段（issue 筛选 /
    queue / Codex 路由 / labels / runtime），违反时抛
    `CentralWorkflowConfigError(code: "profile_field_forbidden")`。
  - **registry & daemon**：`createProjectRegistry` 改为依赖
    `compileCentralWorkflowProject` 而非 `loadWorkflow`；`startTeamDaemon`
    把 compiler 作为可注入依赖。`RegisteredProject` 新增
    `projectPath` / `workflowProfilePath` / `effectiveWorkflowPath`。
  - **shared contracts**：`ProjectSummary` 移除 `workflowPath`，新增
    `projectPath` / `profilePath` / `effectiveWorkflowPath`，供 dashboard 展示。
  - **CLI**：`issuepilot validate --config` 输出改为
    `project=... profile=...`；新增 `issuepilot render-workflow
    --config <path> --project <id>`，把 effective `WorkflowConfig`
    渲染成 YAML 方便人工审查。
  - **dashboard**：`ProjectList` 把单一 Workflow 列拆成 `Project` /
    `Profile` 两列（显示 basename，悬停查看绝对路径）；en/zh i18n 同步。
  - **docs/specs**：`USAGE.md` / `USAGE.zh-CN.md` 的 team config
    最小模板改成中心化目录布局，明确"`projects[].workflow` 已不再支持"。
    spec `2026-05-17` 状态标为「已实现」，master spec `2026-05-15` 第 2 章
    更新为「已破坏式替换 team-mode 输入模型」。
  - **测试**：`@issuepilot/workflow` 58 cases / `@issuepilot/orchestrator`
    282 cases / `@issuepilot/shared-contracts` 42 cases / `@issuepilot/dashboard`
    97 cases 全部通过；四个包 `tsc --noEmit` 全绿。

### Added

- 2026-05-16 — **dashboard 布局抛光：三页等宽、non-modal Sheet、Board polish、
  ServiceHeader 折叠、Reports 趋势卡**（continuation of V2.6 layout refresh）。
  - **三个页面 `max-w` 统一为 1440px**：Command Center 已经是 1440，把
    Reports 从 1280、Run Detail 从 1200 也统一到 1440，避免在 sticky topbar
    下切换页面时 main 容器宽度抖动。所有三页都 `mx-auto w-full
    max-w-[1440px]`。
  - **Sheet 改成非模态 inspector**（用户反馈："划出详情时不应该有遮罩，
    这样方便快速切换卡片"）。去掉 `bg-overlay/40` 遮罩、去掉
    `body.overflow:hidden` 锁滚、不再 `aria-modal=true`，`role` 从 `dialog`
    改成 `complementary`。Esc / ✕ 仍可关闭。
  - **Sheet 进一步改成 GitLab 风纯 overlay**（用户反馈："不应该点击之后
    把页面挤回去"——参考 GitLab issue 看板从右滑出 details 时主看板不让位）。
    回退之前给主容器加的 `transition-[padding] / lg:pr-[440px]` 让位逻辑，
    `command-center-page` 主区永远 `mx-auto max-w-[1440px] lg:px-8`；
    sheet 现在是纯 fixed overlay 浮在看板右侧上方，**主内容布局完全不变**，
    被覆盖的两栏照常存在（横向滚动可继续看），点 sheet 之外的卡片立刻替换
    inspector 内容。`RunBoardView` 列宽也从 768/140 恢复成更舒展的
    `min-w-[1080px]` + `minmax(180px, 1fr)`，每栏视觉宽度回到 ~180px，
    避免之前为让位被挤窄的 6 栏看起来局促。
  - **Board 卡片信息密度 + 选中 motion**：每张卡片移除冗长的 `runId`
    单独行（仍通过 `title=` + `aria-label` 暴露给鼠标 tooltip / 屏读器），
    标题加 `line-clamp-2 leading-snug` 防止 3-行 issue 标题撑爆卡片高度；
    选中 / hover 增加 `-translate-y-0.5` + `shadow-2` motion，配合现有
    `ring-2 ring-info/40` 共同表达"被选中且可点别的卡片继续切换"。
  - **ServiceHeader 二级 metadata 折叠**：把不常用的 `Last config reload`
    / `Workspace usage` / `Next cleanup` 从 always-visible dl 收进
    `<button aria-expanded>` 控制的 disclosure（`More details` / `Hide details`
    + 旋转 chevron），默认折叠。Tier 1 只剩 `Service status` /
    `Concurrency` / `Poll interval` / `Workflow` / `Last poll`，垂直空间
    再省一截；服务首屏更聚焦"在不在跑、跑得多快"。
  - **Reports 页 4 张 Counter 全部带 sparkline**：之前只有 `Total reports`
    有 7 日 sparkline，现在 `Ready to merge` / `Blocked` / `Median duration`
    都接上各自的 7 日趋势——`bucketByDay` 加 optional predicate 复用同一
    桶逻辑算 ready / blocked 计数；新增 `medianDurationByDay` 算每天中位
    耗时（秒）。每张卡都看得出"今天在变好还是变坏"。
  - **i18n**：新增 `service.expand` / `service.collapse` 中英双语
    （`More details` / `Hide details` ↔ `更多详情` / `收起`）。
  - **测试**：`service-header.test.tsx` 适配 disclosure，新增"折叠默认隐藏
    tier-2"用例；97 用例全过、`lint` 0 warning、`typecheck` pass、
    `next build` pass。

- 2026-05-16 — **dashboard shell + Command Center 布局重构（短期 1–6）**。基于
  `ui-ux-pro-max` 系统化评估的结论，把 v2.5 的"左侧 sidebar + 右侧常驻 Review
  Packet split-pane"中后台壳重做成更宽松的"顶部水平导航 + 主内容全宽 +
  按需 sheet"结构。
  - **顶部水平导航（替换左 sidebar）**：新增 `components/shell/top-bar.tsx`，
    把 `Command Center` / `Reports` 主导航 + `LocaleToggle` / `ThemeToggle`
    工具区收成单条 sticky 顶栏（h-14 mobile / h-16 desktop，
    `bg-surface/95 backdrop-blur`，`max-w-[1440px]` 居中）；删除原来 232px
    的 `components/shell/sidebar.tsx`。`AppShell` 改成纵向布局，
    并在最顶层加 `Skip to main content` 链接（首次 Tab 即可跳过 chrome），
    同步去掉不再需要的 `--sidebar-width` CSS token。回收主区域约 232px 横向
    空间，board 视图 6 栏不再被压缩成 x-overflow。
  - **list / board 混合 inspector 布局**：`command-center-page.tsx` 不再
    用恒定的 `2.2fr / 1fr` split-pane，而是按 view 自适应：list 视图选中
    一行才把右侧 320–420px Review Packet 列展开（无选中时整列折叠），
    board 视图保持全宽 6 栏，点卡片才从右侧滑入 sheet。Esc 关闭、点遮罩
    关闭，并用 useEffect 监听键盘事件（list 视图无 modal 也支持 Esc 清空
    选中）。
  - **新增 `components/ui/sheet.tsx`**：便携式右侧 drawer。`createPortal`
    挂在 `document.body`，遮罩 `bg-overlay/40 backdrop-blur-[1px]`，面板
    `translate-x-full → translate-x-0` 200ms 滑入；通过 `mounted` state 控制
    动画结束后再卸载 children（避免 testing-library / 屏读器看到隐藏内容）；
    open 时锁 `body.overflow:hidden`，关闭时把焦点恢复到上一个 active
    element。Tailwind config 加 `overlay` 颜色映射 + 全局 token。
  - **review-packet-inspector 双形态**：新增 `variant: "default" | "sheet"`
    + 可选 `onClose`。default 模式仍是 sticky Card（list 视图右栏），sheet
    模式去掉 Card / sticky / 重复 close 按钮，由 sheet 自带的 ✕ 负责关闭。
    用 `cachedRun` state 缓存最后一次有效的 run，避免 sheet 关闭瞬间内容
    闪空。
  - **summary cards → 横向 stacked health bar**：`overview/summary-cards.tsx`
    重写成单 Card 布局——`Active queue · {total} total` 标题 + 一根 2px
    高的横向堆叠条（按 5 个生命周期状态比例着色，`title=status:count`
    悬浮提示） + 5 列紧凑数字 chip（`StatusDot + status + tabular-nums`）。
    替代原来 5 个 `text-3xl` 大数字 kpi 卡，纵向空间从 ~120px 压到 ~96px，
    "队列是否健康" 一眼可读。新增 `summary.totalLabel` /
    `summary.trackAria` / `summary.trackEmptyAria` 文案。
  - **service-header workflow 长路径修复**：用 `truncate + dir="rtl"` +
    `<bdo dir="ltr">` 让过长路径优先保留尾部（文件名 `WORKFLOW.md`）可见，
    而不是像旧版那样切掉尾部变成 `…/workflo`，并加 `title=` 原生 tooltip
    展示完整路径。
  - **micro-label 减负**：原来到处都是 `text-[11px] uppercase
    tracking-[0.18em]` 的 section header（"SUMMARY" / "RUNS" /
    "Per-run summary" / "Timeline" / "Tool calls" / "Latest review feedback"
    等），全部改成 `text-base font-semibold tracking-tight text-fg`，只保留
    page-level overhead label 和 `dt` field-label 两类合理用法，整页视觉
    噪音明显降低，主标题对比度回归。
  - **i18n / a11y**：`nav.skipToMain` / `common.close` / `summary.totalLabel`
    / `summary.trackAria` / `summary.trackEmptyAria` 中英双语 catalog 同步；
    sheet `role=dialog` `aria-modal=true` + `aria-label`；移除已不再使用的
    `nav.primaryCompact`。
  - **验证**：`pnpm --filter @issuepilot/dashboard test` 96 用例全过、
    `lint` 0 warning、`typecheck` 通过、`next build` 通过。

- 2026-05-16 — **sidebar toggle 对称化 + 中文译文 polish**（i18n round 2）。
  - **UI 修正**：之前 sidebar 底部的 `LocaleToggle` 是双 chip segmented，
    `ThemeToggle` 是单按钮显示当前态，两个 card 在 `lg:items-stretch`
    模式下都被撑满 sidebar 整宽，但内容左对齐，右侧留大片空白；两个
    控件视觉权重不对等。这次把 `ThemeToggle` 重写成跟 `LocaleToggle`
    同款 segmented control（`☼ Light | ☾ Dark` 双 chip），并把两个组件
    的容器从 `inline-flex` 改成 `flex`，内部按钮加 `flex-1` 平分整宽。
    两个 card 现在等宽、内部 chip 平均分布、视觉对称。
  - **中文译文 polish**：把 `zh.json` 里若干"硬翻 / 机翻味"的句子改成
    更符合工程师产品语境的写法（关键字仍按 AGENTS 规则保英文）。代表性
    改动：`home.description` 从「IssuePilot run 的单屏视图。实时更新通过
    SSE 从 ... 推送…」改成「一屏看完所有活跃的 IssuePilot run。实时事件走
    SSE，从 ... 推过来…」；`common.selectRun` 和 `inspector.empty` 从「在左侧
    选中一条 run 以加载它的 Review Packet。」改成「在左侧选一条 run，即可
    加载它的 Review Packet。」；`list.emptyBody` / `runsTable.empty` 从
    「给一个 GitLab issue 打上 ai-ready 标签来启动」改成「在 GitLab 给 issue
    打上 ai-ready 标签即可触发」；`inspector.missingReport` 从「尚未生成
    报告 — daemon 还没为这条 run 产出报告，或属于历史记录。」改成「还没有
    报告 — daemon 尚未为这条 run 写入报告，或者它是历史 run。」；
    `reportsPage.description` 从「基于本地报告产物的质量与耗时指标」改成
    「从本地 run 报告里跑出来的质量与耗时指标」；`reportsPage.tableEmpty` 从
    「运行 orchestrator 后这里就会填充内容」改成「orchestrator 跑起来后，
    这里就会有数据」；`runDetail.reviewSwept/reviewEmpty` 把"采集"改成
    "扫描"；`reviewPacket.validationEmpty` "未报告" → "未填写"；
    `reviewPacket.nextAction` "下一步动作" → "下一步"；`overview.title`
    从「IssuePilot 仪表盘」回到「IssuePilot Dashboard」（产品名遵循
    AGENTS 不翻译规则）；`projects.loadError` "加载错误" → "加载失败"；
    `theme.toggle` "切换配色" → "切换主题"。

- 2026-05-16 — **dashboard 中英双语 i18n（next-intl + cookie-driven locale）**。
  之前 dashboard 全部 user-facing 文案都是写死的英文；这次把它做成可切换的
  内部化方案：
  - **运行时**：`apps/dashboard` 引入 `next-intl@4`，新增
    `i18n/request.ts`（cookie `issuepilot-locale` → `en` / `zh` 兜底 `en`）、
    `i18n/locales.ts`（locale 注册中心 + cookie 工具）、`i18n/messages/en.json`
    与 `i18n/messages/zh.json`（按 surface 分 namespace 的两份 catalog），
    `next.config.mjs` 接 `createNextIntlPlugin`，`app/layout.tsx` 用
    `NextIntlClientProvider` 包整个 AppShell 并在服务端读 locale 设
    `<html lang>`。
  - **切换 UI**：`components/shell/locale-toggle.tsx` 在 sidebar 加
    EN / 中 双键 toggle，点击写 cookie 并 `window.location.reload()`，
    保证下一次 SSR 命中新的 locale；EN / 中 永远显示英文 + 中文 short label，
    避免 lost-in-translation。
  - **保留的"关键字"**：状态码、label、产品名按用户要求保持英文 —
    `running` / `retrying` / `completed` / `failed` / `blocked` /
    `human-review` / `ai-ready` / `ai-running` / `ai-rework` / `ai-failed` /
    `ai-blocked` / `ready` / `not-ready` / `unknown` / `success` /
    `pending` / `low` / `medium` / `high` 等 status / readiness / risk
    枚举不翻；`IssuePilot` / `Codex` / `GitLab` / `Workflow` /
    `Workspace` / `Review Packet` / `MR` / `CI` / `SSE` / event types
    与 run id / branch / path / cmd 等技术名词也都保持原文。
  - **翻译范围**：sidebar nav / theme & locale toggle / Command Center
    首页（标题、描述、ServiceHeader 字段、SummaryCards caption、ViewToggle、
    RunListView 表头与空态、RunBoardView 列头与空态、ReviewPacketInspector
    字段与空态）、Reports 页（KPI 标签、sparkline label、chart title、
    table headers、空态、`ofTotal` 百分比、`failedCount` 复数）、Run detail
    页（breadcrumb、metadata strip 字段、ReviewPacket 三块、EventTimeline /
    ToolCallList / LogTail 空态与字段、ReviewFeedback panel、Retry/Stop/
    Archive 按钮）、overview / runs-table / project-list 旧入口、
    `app/page.tsx` 和 `app/reports/page.tsx` 的错误回退态（用
    `getTranslations()` 服务端解析）。
  - **测试**：新增 `apps/dashboard/test/intl.tsx` 提供 `renderWithIntl`
    包一层 `NextIntlClientProvider` 默认走 EN catalog；`app/page.test.tsx`
    针对 `getTranslations` 加了 in-process mock，保留对 `<code>` 元素的
    文本断言。15 个 component test 文件统一切到 `renderWithIntl`，96 个
    用例全绿。

### Changed

- 2026-05-16 — **V2.5 dashboard 视觉重做：Swiss Modernism 2.0 双模设计系统**。
  这次按 `ui-ux-pro-max` skill 的 `--design-system` 建议把整个 Command Center 重
  绘了一遍，落地点：
  - **Design tokens**：`apps/dashboard/app/globals.css` 新增 light + dark 两套
    HSL 变量（surface / fg / border / primary / accent / success / warning /
    danger / info / violet 共 10 组语义色），4/8 dp 间距体系，新建
    `.grid-12`、`.tabular`、`.surface-row` 组件类；`tailwind.config.ts`
    打开 `darkMode: "class"`，把所有 Tailwind 颜色映射到上面的 token，并接入
    Fira Sans + Fira Code 两个 `next/font/google` 字体变量。
  - **App shell**：`apps/dashboard/components/shell/` 下新增 `AppShell`、
    `Sidebar`（≥1024px 显示左 232px 主导航，&lt;1024px 退化成顶部 compact
    导航）、`ThemeToggle`（class-based 暗色，localStorage 持久化，
    `<head>` 内联 bootstrap 脚本避免 flash）。
  - **状态色阶**：`components/ui/status.tsx` 集中维护 `RUN_STATUS_TONES /
    READINESS_TONES / PIPELINE_TONES`，新增 `StatusDot` + `StatusPill`，所有
    badge 同时使用颜色 + 文本 + dot，满足 §1 `color-not-only`。
  - **Command Center 首页**：`ServiceHeader` 从竖排 dl 改成单行 metadata
    strip（status pill + 工程名 + 5 列字段）；`SummaryCards` 加顶部彩色 stripe
    + 状态点 + 等宽数字；`RunListView` 改造成 Linear 风格行（左 accent 条 +
    status / issue / branch / readiness / CI / attempt 6 列），`RunBoardView`
    每列加顶 accent 条 + 数量徽标 + sticky 列头；新增空态 / 视图切换图标
    （`ViewToggle`）。
  - **Reports 页**：从 `4 counter + 1 表` 升级为 KPI（带 sparkline）+ 7 天
    `<MiniBars>` 趋势 + `<Donut>` readiness 占比 + 可排序表格（`aria-sort` 同步
    更新），新增纯 SVG `Sparkline` / `MiniBars` / `Donut` 工具组件
    （`components/ui/charts.tsx`），零图表库依赖。
  - **Run detail**：顶部新增 sticky metadata strip（status pill + run id +
    Archive 按钮 + Issue/Branch/MR/Workspace/Labels/CI 网格），`ReviewPacket`
    改成 2-列 + 嵌套块（Handoff 包含 summary / validation / risks / follow-ups
    / next action；Merge readiness 用 readiness 软色包裹 + reasons + checks
    分组），breadcrumb + 区段标题统一成 `tracking-[0.18em]` 大写小标签。
  - **Token 迁移**：清理 `RunsTable / OverviewPage / ProjectList /
    EventTimeline / ToolCallList / LogTail` 的硬编码 `slate-* / sky-* /
    rose-*`，统一切到 `fg / fg-muted / border / danger-soft` 等语义 token，
    所以 dark mode 不再有黑底白卡冲突。
  - **可访问性**：全局 `:focus-visible { outline: 2px solid hsl(var(--color-ring)); }`，
    `prefers-reduced-motion` reset 所有过渡，焦点环用 ring offset 与背景区分。
  - **mock 对齐**：`scripts/demo/mock-orchestrator.mjs` 的 `buildSummary`
    重写成真实 `RunReportSummary` 形状（`issueTitle / labels /
    mergeReadinessStatus / updatedAt / totalMs` 等），并给 `runRecords`
    带上 `latestCiStatus` / `mergeRequestUrl` 让 dashboard 各处 badge 不再
    fallback。
  - **测试**：`pnpm --filter @issuepilot/dashboard lint && pnpm --filter
    @issuepilot/dashboard typecheck && pnpm --filter @issuepilot/dashboard
    test`（96 tests / 20 files）全部通过；调整了 `summary-cards / service-
    header / reports-page` 三个用例以匹配新 DOM 结构（如 `getByText("ready")`
    改成 `getAllByText("ready").length > 0`，避免被 donut legend 干扰）。

### Added

- 2026-05-16 — **V2.5 Command Center：单屏 Linear 风格 dashboard +
  RunReportArtifact**。本次同时落 8 个 task，落地 V2.5 设计：
  - **共享契约**：`packages/shared-contracts/src/report.ts` 新增
    `RunReportArtifact`（version 1）、`RunReportSummary`、merge readiness
    枚举、`isMergeReadinessStatus` 类型守卫与 `buildRunReportSummary`
    派生函数；`api.ts` 在 `/api/runs`、`/api/runs/:runId` 响应里新增可选
    `report` / `reports` 字段，并新增 `ReportsListResponse`。
  - **orchestrator 报告流水线**：`apps/orchestrator/src/reports/` 下新增
    `lifecycle.ts`（`createInitialReport` / `updateReportHandoff` /
    `markReportFailed`）、`store.ts`（in-memory + JSON 文件双写，落盘到
    `~/.issuepilot/.../reports/<runId>.json`，写盘前过 `redact`）、
    `render.ts`（handoff / failure / closing GitLab note 从同一报告渲染）、
    `merge-readiness.ts`（dry-run 评估器，覆盖 CI / approvals / review
    feedback / risks），每个文件都有配套 vitest 测试。
  - **生命周期接入**：`daemon.ts` 在 claim 时调 `createInitialReport`
    并存盘，reconcile 拿 `reportStore.get(runId)` 注入 `ReconcileInput`
    并把 MR / handoff note id / agent handoff 字段回写到报告，failure
    路径调 `markReportFailed`；`reconcile` 改为返回 `ReconcileResult`，
    `dispatch` 的 `reconcile` 签名同步放宽到 `Promise<void | ReconcileResult>`；
    `ci-feedback.ts` / `review-feedback.ts` 接受 `reports?` 依赖，落盘
    最新 CI / review 状态并重新评估 merge readiness。
  - **API**：`apps/orchestrator/src/server/index.ts` 接受
    `reports?: ReportStore`，`/api/runs` 给每条记录加 `report`
    summary，`/api/runs/:runId` 返回完整 `RunReportArtifact`，新增
    `/api/reports` 端点；`server.test.ts` 新增 “run reports” 子套件。
  - **dashboard**：`apps/dashboard/lib/api.ts` 导出 `RunWithReport` 与
    `listReports`；首页 `app/page.tsx` 替换为
    `components/command-center/command-center-page.tsx`（List ↔ Board
    切换 + Review Packet inspector），并补 list / board / page 三套
    vitest；运行详情页顶部新增
    `components/detail/review-packet.tsx`；新增 `/reports` 聚合页
    （`app/reports/page.tsx` + `components/reports/reports-page.tsx`），
    汇总 ready-to-merge / blocked / failed 计数与逐 run 摘要表。
  - **文档**：`README.md` / `README.zh-CN.md` 在 Roadmap 新增 “V2.5 —
    Command Center” 章节，并把 Linear 风格 List / Board、Review Packet
    与 `/reports` 页加入 Current Status；`USAGE.md` / `USAGE.zh-CN.md`
    在 §4.1 dashboard 启动后说明 Command Center / Review Packet /
    `/reports` 的用法，并强调 merge readiness 仅做 dry-run。
  - **验证**：`pnpm --filter @issuepilot/shared-contracts test`、
    `pnpm --filter @issuepilot/orchestrator test`（278 个 case 全过）、
    `pnpm --filter @issuepilot/dashboard test`、三个包的 `typecheck`
    全部通过；`git diff --check` 清洁。

### Fixed

- 2026-05-16 — **V2.5 Command Center code review 跟进修复**：
  - **C1/C2/I2 (Critical/Important)**：`apps/orchestrator/src/orchestrator/reconcile.ts`
    抽出可复用的 `mergeAgentHandoffIntoReport`，在调用 `renderHandoffNote`
    前用 `agentSummary` / `agentValidation` / `agentRisks` /
    `noCodeChangeReason` 覆盖 seed report 的占位字段，并把 `mergeRequest`
    一并 patch 上去。`apps/orchestrator/src/daemon.ts` 的 reconcile 回写
    复用同一个 helper，确保 store 里也是合并后的字段；handoff note 与
    Review Packet 不再渲染 "not reported" 占位符，`noCodeChangeReason`
    也会进入 What changed / Validation。
  - **I1 (Important)**：`onFailure` 现在优先调用
    `renderFailureNote(failedReport, ...)`，仅在报告缺失时回退到 legacy
    `createFailureNote`；plan 中要求的"render failure note from report"
    在 daemon 路径上得到落实。
  - **I3 (Important)**：新增 4 个集成测试覆盖 V2.5 关键路径：
    `reconcile.test.ts` 增加 seed report 合并 / noCodeChangeReason 兜底
    两条；`ci-feedback.test.ts` 验证 sweep 把 latest CI status 写回报告
    并重新计算 `mergeReadiness.evaluatedAt`；`review-feedback.test.ts`
    验证 unresolved 计数和 comments 被写回 `reviewFeedback`。回归测试
    总数从 274 → 278。

### Changed

- 2026-05-16 — **使用文档从 `docs/getting-started.*` 提升为根目录 `USAGE.*`
  并按 7 个 Part 重写**。目的是修「文档藏在 `docs/` 子目录里、13 个数字小节
  扁平、V2 团队模式被挤在 §13 当附录读不到」三个问题。
  - 文件迁移：`git mv docs/getting-started.md USAGE.md` + `git mv
    docs/getting-started.zh-CN.md USAGE.zh-CN.md`（git rename detection
    识别为重命名，历史保留）。两份文档现在与 `README.md` / `CHANGELOG.md`
    / `LICENSE` 同级，遵循根目录 `USAGE` 的业界约定。
  - 重写结构：把原扁平的 13 节合并成 7 个 Part，并在顶部加 TOC：
    - Part 1 总览（V1 vs V2 对比表 + 仓库与目录角色）
    - Part 2 快速跑通（环境要求 / 安装 / 第一次跑通核对清单）
    - Part 3 准备目标 GitLab 项目（labels / SSH / WORKFLOW.md / 凭据 /
      validate）
    - Part 4 V1 单项目模式（个人开发机；启动 + 第一个 Issue + 6 个 label
      状态对应动作）
    - Part 5 V2 团队模式（入口对比 / team config / 校验 / Phase 2-5 + V2
      当前边界）—— **V2 团队模式从附录提升为与 V1 平级的主章节**
    - Part 6 日常运维与排障（"在哪里看什么"表 + 失败 run 取证 + FAQ）
    - Part 7 参考（CLI 速查表 + HTTP API 端点 + 文档导航）
  - 链接同步：`AGENTS.md` 文档语言 §「公开双语入口」规则从
    `docs/getting-started.*` 改为 `USAGE.*`；`README.md` /
    `README.zh-CN.md` 中所有使用手册链接（顶部 V1 快速通道、Roadmap §V2
    团队模式 walkthrough、Documentation 区第一条）全部指向根目录
    `USAGE.{md,zh-CN.md}`；`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
    第 183 行凭据章节引用从 `docs/getting-started.zh-CN.md §5` 改为
    `../../../USAGE.zh-CN.md §3.4`。
  - 不更新的引用：`docs/superpowers/specs/2026-05-1{1,4,5}-*.md` /
    `docs/superpowers/plans/2026-05-1{4,5}-*.md` 中提及的
    `docs/getting-started.*` 路径是带日期戳的历史档案（写 plan / spec
    那一刻的真实路径），保留以维护档案历史一致性；同理本 CHANGELOG
    的旧条目（`## 2026-05-14 ...` / `## 2026-05-15 ...` 等）也不改路径。
  - 此条与下面 5-16 那条「V2 文档收口」是同一天的两次提交：先把 V2 完成
    状态、架构图 / 流程图、§13 V2 团队模式章节写到 `docs/getting-started.*`
    并合入 `main`；本次再做结构与位置重排。

### Added

- 2026-05-16 — **V2 文档收口 + 架构图/流程图 + 中英文使用手册新增 V2 团队
  模式章节**。本次只动文档，不动代码；目的是把"V2 Phase 1–5 已全部合入
  `main`"这件事在仓库的所有面向用户的入口同步出来，并补齐之前缺的视觉
  化文档。注：本条提到的 `docs/getting-started.md` / `docs/getting-started.zh-CN.md`
  在 2026-05-16 已经被 rename 为根目录 `USAGE.md` / `USAGE.zh-CN.md`，
  详见上面 Changed 节那条；行文保留写入时的原路径作为历史档案。
  - `docs/superpowers/diagrams/v2-architecture.mmd` + `.svg`（新）：V2 团队
    可运营 runtime 架构图，覆盖 team config / workflow loader / project
    registry / scheduler + lease store / main loop / Phase 2–5 周期任务 /
    adapter 层（tracker-gitlab、workspace、runner-codex-app-server）/
    observability（event bus + JSONL event store + run record + pino
    logger）/ Fastify HTTP API（state/runs/events/SSE/operator actions）/
    `~/.issuepilot` 本地存储 / dashboard 三个视图。
  - `docs/superpowers/diagrams/v2-flow.mmd` + `.svg`（新）：V2 端到端
    生命周期流程图，覆盖 lease 申请 / claim → 401/403 → ai-blocked 升级、
    dispatcher → retry/failed/blocked/completed 四种 outcome、handoff →
    Phase 3 CI scanner 五种 pipeline 分支、Phase 4 review sweep → 注入
    `## Review feedback` prompt、Phase 2 dashboard retry/stop/archive、
    Phase 5 workspace retention 三段式 sweep（active 永不删 / successful 7d
    / failed 30d）。
  - `docs/superpowers/diagrams/README.md`（新）：mermaid 源 + SVG 产物的
    维护方式、`npx -y -p @mermaid-js/mermaid-cli mmdc ...` 渲染命令、
    "节点 label 含括号 / 引号 / `#` 必须用 `"..."` 包裹"等踩坑记录。
  - `docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`
    顶部状态行从「Phase 1–4 已合入」改成「Phase 1–5 全部已合入；V2 团队
    可运营版本的功能交付已经完成」；`§0 文档入口和当前进度` 进度表把
    Phase 5 由「下一步，待实施」改为「已完成（V1 入口已激活；team daemon
    wiring 列为后续 follow-up）」；新增可视化入口段落引用上面两张图。
    `§16 Phase 5` 展开成实施清单 + follow-up 边界说明，明确 team daemon
    暂未自动跑 cleanup loop 的现状。
  - `docs/getting-started.md` / `docs/getting-started.zh-CN.md`（双语
    同步更新）：顶部添加版本覆盖说明（V1 + V2 Phase 1–5）和图链接；
    底部新增 §13 V2 团队模式章节，覆盖入口对比、team config 最小模板、
    `validate --config` / `run --config` 启动、Phase 2 dashboard
    retry/stop/archive（含 V2 team daemon 暂返回 `503 actions_unavailable`
    的限制）、Phase 3 CI 状态矩阵（含「改 ci.enabled 必须重启 daemon」
    与「override 必须三键齐发」约束）、Phase 4 review feedback sweep
    工作机制（含 reviewer envelope 防 prompt injection）、Phase 5 retention
    默认策略 + `doctor --workspace` dry-run 示例 + team daemon 暂未跑
    cleanup loop 的诚实说明 + runbook 链接、最后 §13.8 V2 边界（显式
    列出 RBAC / 远程 worker / 自动 merge / Postgres / 多 tracker / 远端
    `ai/*` 分支清理等 V3+ 范围）。
  - `README.md` / `README.zh-CN.md`（双语同步更新）：顶部 WARNING 框
    更新为「V2 Phase 1–5 已全部合入 main；team daemon 不自动跑 cleanup
    loop 是 follow-up」；§Roadmap §V2 把「Deployable to a shared team
    box / Multi-project workflow / Concurrency lifted from 1 to 2–5」从
    待办无标记改为 ✅，Phase 1 从 🚧 改为 ✅，开头加视觉版本 + 团队
    模式手册链接，Phase 5 ✅ 条目下追加 team daemon wiring follow-up
    限制；§Documentation 区追加架构图 / 流程图 / 图源目录 / runbook 四个
    新入口。
  - 后续待办（不阻塞本次文档收口）：V2 team daemon 装配 workspace
    cleanup loop；V2 team daemon 装配 operator actions（目前返回
    `503 actions_unavailable`）。

- 2026-05-16 — **V2 Phase 5 Workspace Retention 落地：`~/.issuepilot` 下的
  worktree 在终态满足 retention policy 时被 orchestrator 周期性自动清理，
  active run 永远不动、未到期失败现场默认保留、容量压力不允许凌驾于
  forensics 之上。** 新增 `RetentionConfig`（`packages/shared-contracts/src/retention.ts`）
  + `DEFAULT_RETENTION_CONFIG = { successfulRunDays: 7, failedRunDays: 30,
  maxWorkspaceGb: 50, cleanupIntervalMs: 3_600_000 }`，team config 与
  workflow front matter 共用同一 schema，未配置时回落到默认值；team config
  与 workflow `retention.cleanup_interval_ms` 最小 60_000 ms，避免误填导致
  主循环空转（schema 测试同步覆盖）。**Behavior change**：相对 V2 Phase 1
  早期默认（`failedRunDays = 14`），本次把失败现场默认保留期延长到 30 天，
  与 V2 spec §11 对齐；如果你的部署希望维持 14 天，请在 team config / workflow
  显式设置 `retention.failed_run_days: 14`。
  新增纯函数 planner `packages/workspace/src/retention.ts`
  (`planWorkspaceCleanup` / `enumerateWorkspaceEntries`)：按 `RuntimeState`
  注解每个 workspace 目录为 `active / successful / failed / blocked / completed
  / unknown`，根据 mtime 与 `endedAt` 计算到期、永远不把 `active` 列入
  `delete`、`over-capacity` 也只能从已过期的 terminal run 中挑、并把 stat
  失败转成 `errors[]`。新增 executor
  `apps/orchestrator/src/maintenance/workspace-cleanup.ts` 的
  `runWorkspaceCleanupOnce`：调 planner、emit
  `workspace_cleanup_planned`（含 `totalBytes` / `retainBytes` /
  `overCapacity` / `deleteCount`）、逐条 `fs.rm` 并按结果 emit
  `workspace_cleanup_completed` 或 `workspace_cleanup_failed`，单条失败
  不阻塞整轮。`apps/orchestrator/src/orchestrator/loop.ts` 在 tick 末尾
  按 `retention.cleanup_interval_ms` 触发 sweep；
  `apps/orchestrator/src/daemon.ts` 装配 executor 并把
  `workspaceUsageGb` / `nextCleanupAt` 透出到 `OrchestratorStateSnapshot.service`
  + `/api/state`。dashboard `apps/dashboard/components/overview/service-header.tsx`
  在两字段存在时新增 `Workspace usage` / `Next cleanup` 两块。新增
  `issuepilot doctor --workspace --workflow <path>` dry-run：从 workflow 读出
  `workspace.root` + retention，调 `enumerateWorkspaceEntries` + planner 并
  打印「entries / total usage / will delete / keep failure markers」摘要；
  dry-run 不持有 RuntimeState，所有目录视为 `unknown`，因此天然不会删任何文件，
  把"真实想删什么"留给订阅 `workspace_cleanup_planned` 事件。新增三个 shared
  contracts 事件类型 + `OrchestratorStateSnapshot.service.{workspaceUsageGb,
  nextCleanupAt}`。`apps/orchestrator` 新增 `runWorkspaceCleanupOnce` /
  `RunWorkspaceCleanupInput` 公共导出供 e2e 测试调用。新增 e2e
  `tests/e2e/workspace-cleanup.test.ts` 覆盖 plan §Task 6 三条契约
  （A 过期成功 → 删除 + completed 事件；B active run → 不删；C 五个保留期内
  failed run + 容量超限 → `deleteCount=0` + `overCapacity=true`）。新增
  runbook `docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`：
  决策树（常规 vs 强制 vs 关闭）、`doctor --workspace` dry-run 用法、
  `workspace_cleanup_failed.reason` 分类表（`enumerate_failed` / `stat_failed`
  / `rm_failed`）与诊断步骤、误删 + active 被误清 + dry-run 异常三种场景的
  rollback 步骤、操作前自检清单。Phase 5 不解决远端 GitLab `ai/*` 分支清理、
  workspace 归档与多 host 共享协议（spec §4），如需后续走 V3 RFC。详见
  spec `docs/superpowers/specs/2026-05-16-issuepilot-v2-phase5-workspace-retention-design.md`
  与实施计划 `docs/superpowers/plans/2026-05-15-issuepilot-v2-workspace-retention.md`。

- 2026-05-16 — **V2 Phase 5 review hardening**：基于 code review 修复 important
  + 部分 minor 一致性问题，未引入新功能。`runWorkspaceCleanupOnce` 改为
  返回 `CleanupRunResult`（在 `CleanupPlan` 基础上新增 `totalBytesAfter` =
  `plan.totalBytes` 减去本轮成功删除的 entry 字节数）；daemon 用 `totalBytesAfter`
  刷新 `OrchestratorStateSnapshot.service.workspaceUsageGb`，避免 dashboard
  在下一个 `cleanupIntervalMs` 之内一直显示扫描前的旧值。`CleanupDelete`
  追加 `projectId` / `runId` / `bytes`：executor 在 `fs.rm` 前用
  `RuntimeState.getRun(runId)` 再次校验 status，若 run 在 plan -> rm 之间被
  retry 重新翻回 `claimed/running/retrying/stopping`，跳过本条删除并 emit
  `workspace_cleanup_failed(reason=rm_failed, message=...reclaimed...)`，
  消除 TOCTOU 窗口。daemon SSE 持久化 subscriber 加上 `workspace_cleanup_`
  前缀分支：cleanup 事件用 sentinel `runId=workspace-cleanup` 落到
  event store 的 `__system__-0.jsonl`，`/api/events?runId=workspace-cleanup`
  返回历史、`/api/events/stream?runId=workspace-cleanup` 提供实时流
  （runbook §3 / §5 同步更新 curl 命令）。daemon 启动时 `nextWorkspaceCleanupAt`
  改为 `undefined`，由首轮 cleanup 完成后回填，dashboard 不再撒谎说"下一次
  清理在 1 小时后"。V2 team daemon 在启动时打 warn 提示 `retention` 节
  被解析但不消费（Phase 5 只在 V1 入口激活，team-mode wiring 留给后续 release），
  spec §4 显式列入「Phase 5 不包含」。tests/e2e/workspace-cleanup.test.ts
  的 `seedWorkspace` 删除掉无作用的 `fs.utimesSync` 调用：planner 用
  `RuntimeState.endedAt` 算保留期，并不读 mtime，原先的代码与注释会误导
  后续 contributor。

### Changed

- 2026-05-16 — **V2 Phase 4 后续 hardening**：基于 code review 修复 important
  + 部分 minor 一致性问题，未引入新功能。`apps/orchestrator/src/orchestrator/dispatch.ts`
  在注入 `## Review feedback` 块时把每条 reviewer body 包到
  `<<<REVIEWER_BODY id=N>>> ... <<<END_REVIEWER_BODY>>>` envelope 里，并对
  envelope marker 自身做最小 escape——reviewer 评论内的 markdown 分隔符或
  `Ignore all prior instructions` 这类 prompt-injection 文本不再能破出 review
  区段；`buildReviewFeedbackBlock` 的 JSDoc 同步移除了"`attempt > 1`"的旧措辞，
  与 carry-forward 路径行为对齐。`sweepReviewFeedbackOnce` 的候选筛选保留
  `status === "completed"` + `endedAt` / `archivedAt` 均为空 这条规则，但
  把 `ReviewFeedbackWorkflowSlice.tracker.handoffLabel` 的 JSDoc 改写成
  "字段保留作未来在 handoff 时回填 `RunRecord.issue.labels` 后启用 label
  二次校验"——避免文档误导成"已经做 label safety net"，与 Phase 3 CI feedback
  scanner 的同一约束保持一致（`RunRecord.issue.labels` 是 claim 时刻快照，
  handoff 后不刷新，所以现阶段不能用作 label 判据）。`review_feedback_summary_generated`
  事件在 empty case（无 fresh 评论）时 `cursor` 字段从合成 `generatedAt` 改成
  `cursor ?? null`，让事件 payload 与持久化的 `lastDiscussionCursor` 在
  "尚未推进"语义上保持一致。新增 2 条单测：reviewer body 含 markdown /
  prompt-injection 时 envelope 把恶意片段全部夹在 marker 之间；首次 sweep
  MR 存在但零人类评论时 `cursor` 为 `null`。Phase 4 设计 spec 增补：
  决策 4 写明 reviewer envelope 与信任范围；新增决策 6 解释为何只靠
  `status + endedAt` 作 safety net、`handoffLabel` 字段语义；新增决策 7
  显式列出 `review_feedback_*` 事件的全部 `reason` 取值（`no_mr` /
  `no_new_comments` / 缺省，以及 failed 路径 `lookup_failed`）。
  顺手把 `apps/orchestrator/src/daemon.ts` 里 Phase 4 引入的 import 顺序
  调成 ESLint 的 `import/order` 期望（lint smoke 之前因此 warn 失败）。

### Added

- 2026-05-16 — **V2 Phase 4 Review Feedback Sweep 落地：MR 上的人工评论会被
  orchestrator 周期性扫描，结构化为 `ReviewFeedbackSummary` 写回 run 记录，并
  在 issue 被打回 `ai-rework` 时自动继承到新一轮 run 的 prompt 中。** 新增
  `apps/orchestrator/src/orchestrator/review-feedback.ts` 的
  `sweepReviewFeedbackOnce`：扫 `RunRecord.status === "completed"` 且未
  `endedAt`/`archivedAt` 的 review-stage run，按 `branch` 找开放 MR，调
  `listMergeRequestNotes`，过滤 GitLab 系统 note、`<!-- issuepilot:` marker
  开头的自写 note 与可选的 `tracker.botAccountName` bot；游标 `cursorIso`
  控制"新评论"判定，但持久化的 summary 始终包含完整人工评论历史
  （`allHumanComments`），保证 reviewer 在两次 ai-rework 之间留下的多条评论
  不会被新一轮 sweep 覆盖丢失。每次 tick emit
  `review_feedback_sweep_started` / `review_feedback_summary_generated`
  /（lookup 失败时）`review_feedback_sweep_failed`，event payload 仅含本
  tick 新增 delta；audit 日志因此既能查到 sweep 在跑、又不重复输出整段历史。
  `apps/orchestrator/src/orchestrator/loop.ts` 在 `reconcileRunning` →
  `scanCiFeedback` 之后调用 `sweepReviewFeedback`，daemon 在
  `apps/orchestrator/src/daemon.ts` 中无条件装配（sweep 自身对无 MR /
  无新评论的 run 是 no-op，不需要 workflow 开关）。dispatch 端
  `apps/orchestrator/src/orchestrator/dispatch.ts` 在生成 prompt 前把
  `latestReviewFeedback` 注入 `vars.reviewFeedback`（供模板访问），当
  `latestReviewFeedback` 存在时再把标准化的 `## Review feedback` markdown
  区段拼接到 prompt 之前；不再依赖 `attempt > 1`，因为 sweep 只在收集到
  fresh 评论时才落盘 summary，summary 存在本身就证明在 rework 闭环里。
  claim 端 `apps/orchestrator/src/orchestrator/claim.ts` 新增
  `findPriorReviewState`：每次 claim 时按 `issue.iid` 查最近一次旧 run，
  把 `latestReviewFeedback` 与 `lastDiscussionCursor` 复制到新 runId，
  解决"ai-rework 重新 claim 后 runId 变化 / sweep 状态丢失"的接缝。
  共享契约 `packages/shared-contracts/src/events.ts` 追加
  `review_feedback_sweep_started` / `review_feedback_summary_generated`
  / `review_feedback_sweep_failed` 事件类型；`run.ts` 给 `RunRecord` 加
  可选 `lastDiscussionCursor` 与 `latestReviewFeedback`；新增 `review.ts`
  导出 `ReviewComment` / `ReviewFeedbackSummary`。`@issuepilot/workflow`
  的 `PromptContext` 增加 `reviewFeedback?: ReviewFeedbackSummary`，
  `render.ts` 把 camelCase 字段同时挂成 snake_case `review_feedback` 别名，
  方便 Liquid 模板 `{{ review_feedback.comments }}` 直接遍历。
  `apps/dashboard/components/detail/run-detail-page.tsx` 在 detail 页底部
  新增 `Latest review feedback` 面板：展示 MR 链接、generatedAt、cursor、
  每条评论 author + createdAt + resolved badge + 截断 body + 跳回 MR
  note 的深链接。daemon 事件 bridge `apps/orchestrator/src/daemon.ts` 的
  eventBus subscriber 把 `review_feedback_*` 与 `operator_action_*` /
  `ci_status_*` 一同 append 到 eventStore，让 `/api/events?runId=...` 与
  dashboard 审计日志能查到 sweep 事件。e2e 新增
  `tests/e2e/review-feedback-sweep.test.ts` 两条场景：(a) seed reviewer
  评论 → 等 sweep emit `review_feedback_summary_generated` →
  人工 ai-rework reclaim → 抓 fake-codex `IPILOT_FAKE_DEBUG_LOG` 截到第二轮
  `turn/start` 的 prompt 真的包含 `## Review feedback` + 历史评论文本；
  (b) MR 不存在时 sweep emit `no_mr` summary 不动 labels。e2e helpers
  `tests/e2e/fixtures/workflow.fake.md.tpl` 接入 `__ACTIVE_LABELS__`
  占位符（默认 `["ai-ready"]` 保持 happy/CI 套件语义，sweep 测试覆盖
  `["ai-ready", "ai-rework"]` 验证完整 reclaim 链路）。验证：`pnpm lint`
  / `pnpm typecheck` / `pnpm --filter @issuepilot/orchestrator test`（243
  单测，含新增 1 个 carry-forward claim 测试 + 1 个 accumulator sweep
  测试 + 1 个 carry-forward dispatch 测试）/ `pnpm --filter
  @issuepilot/tests-e2e test`（48 e2e，含新增 2 个 review feedback 场景）
  全绿。
  - **故意 out of scope**：摘要 LLM（V4 范围）、跨 MR / 跨 issue 评论聚合、
    review 评论触发自动 merge、替代 Phase 3 CI 回流。

### Fixed

- 2026-05-15 — **V2 Phase 3 CI Feedback：`unknown` 状态归入 wait，避免 race condition 时 marker note 被 unknown 占坐**。`apps/orchestrator/src/orchestrator/ci-feedback.ts`：原来 `unknown` 与 `canceled` 一起走 manual prompt 路径（写 marker note + emit `ci_status_observed{action:"manual"}`）。但 dispatch 完成 issue 进入 `human-review` 后 fake / 真实 GitLab pipeline 可能还没生成（pipelines 表为空 → `getPipelineStatus` 返回 `unknown`），scanner 在同一个 tick 内已经能看到 MR 但还没看到 pipeline，结果先用 marker note 写了"unusual CI status: `unknown`"提示文案。下一轮 pipeline 真正变为 `failed` 时，C1 dedup 命中已有 marker note 直接跳过 `createIssueNote`，rework "failing CI pipeline" note 永远写不进去。把 `unknown` 改成与 `running`/`pending` 同组走 wait 路径（不写 note，emit `ci_status_observed{action:"wait"}`），保住 marker note 槽位给后续真正需要 prompt 的状态。`canceled`（含 gitbeaker 的 `skipped → canceled` 映射）保持 manual prompt 行为不变。新增 2 个单测：(a) `unknown` 与 `running`/`pending` 同走 wait，无 note；(b) regression 单测复现 e2e race —— 先 `unknown` 一轮，再 `failed`，期望第二轮能正常写 rework note。e2e `ci-feedback.test.ts` 5/5 全绿、orchestrator 单测 227/227 全绿。
- 2026-05-15 — **V2 Phase 3 CI Feedback code review 收口（C1 + I1/I2/I3 + M1/M2/M3/M4/M5）**：把 Phase 3 review 出的 1 个 Critical、3 个 Important、5 个 Minor 全部清掉。验证：`pnpm lint` / `pnpm typecheck` / `pnpm --filter @issuepilot/orchestrator test`（含新增 4 个 ci-feedback dedup/endedAt 测试 + 3 个 registry ci override 测试 + 2 个 team config project-level ci 测试 + 4 个 daemon syncHumanReviewFinalLabels 测试）/ `pnpm --filter @issuepilot/tests-e2e test`（含新增 D + E 两个 ci-feedback 场景）全绿。
  - **C1 `apps/orchestrator/src/orchestrator/ci-feedback.ts`：marker-tagged 的 ci-feedback note 跨 poll cycle 幂等**。原 `canceled` / `unknown` 状态每个 tick 都会写一条新 issue note，pipeline 卡在 canceled 半天能堆出几十条同样的 note。`CiFeedbackGitLabSlice` 加 `findWorkpadNote(iid, marker)`（复用 `@issuepilot/tracker-gitlab` 已有 API），scanner 在 manual / rework note 写入前先 lookup 同 `<!-- issuepilot:ci-feedback:<runId> -->` marker，命中则跳过 `createIssueNote`、仍照常 emit 审计事件。`findWorkpadNote` 抛错时 fallback 当作"没找到"以免 notes 端点抖动卡住 label transition。新增单测：(a) canceled 状态在 GitLab 已有 marker 时不再写 note；(b) 连续两次 failed scan 只写一条 rework note。e2e 新增 scenario E（canceled，连续 ~6 个 poll cycle 只产生 1 条 marker note）。
  - **I1 `apps/orchestrator/src/daemon.ts` + `ci-feedback.ts`：human-review 终态后 scanner 自动收手**。`completed` 状态本身不带"已离开 review"语义，原实现会让所有曾经走到 `human-review` 的 run 永远留在 scanner 候选集，无限拉 GitLab pipeline / 复算 latestCi。`syncHumanReviewFinalLabels`（之前只同步 labels）改名拓展为同时把 `RunRecord.endedAt = event.ts` 写进 state，触发条件是 `human_review_issue_closed`（MR merged 后 IssuePilot 关 Issue）和 `human_review_rework_requested`（MR closed unmerged，labels 翻 ai-rework）两条终态事件；`mr_still_open` / `mr_missing` 等非终态事件不动 endedAt。`scanCiFeedbackOnce` 候选筛选追加 `endedAt` skip 分支，scanner 自然不再扫已结案 run。`endedAt` 重复写入时保留最早的时间戳。新增 4 个 daemon 单测覆盖三条终态路径 + 非终态路径 + 重复事件保序，新增 1 个 scanner 单测覆盖 endedAt skip。
  - **I2 `apps/orchestrator/src/team/{config,registry}.ts`：team 级 `ci` 和 `projects[].ci` 真正生效**。原 `TeamConfig.ci` 解析后没人消费，team config 加 `ci:` 节像 no-op 配置陷阱。`TeamProjectConfig` 新增可选 `ci` 节（与顶层同 schema），`createProjectRegistry` 用新 `resolveEffectiveCi(workflow.ci, team.ci, project.ci)` 合成 effective ci（precedence: project.ci > team.ci > workflow.ci），把合成结果直接写回 `RegisteredProject.workflow.ci`，下游 scanner / dashboard 拿到的就是 effective 值，无需感知 team override。partial merge 不支持以避免"半生效"歧义；override 时三键齐发或不发。新增 3 个 registry 单测覆盖三种 precedence + 2 个 config 单测覆盖 projects[].ci 解析 / 校验。
  - **I3 `tests/e2e/ci-feedback.test.ts`：补 D + E 两条场景**。Scenario D（`failed` + `ci.on_failure: human-review`）：验证 failed 不动 labels、不写 marker note、emit `ci_status_observed{action:"noop"}`、`latestCiStatus=failed` 正确写回。Scenario E（`canceled` + C1 dedup）：人为让 scanner 跑 ~6 个 poll cycle，断言 marker note 数量等于 1、labels 仍是 `human-review`、`latestCiStatus=canceled`。合并 review 前已有的 A/B/C 三场景共 5 条 e2e。
  - **M1 `CiFeedbackGitLabSlice.transitionLabels` 返回类型**。原 `Promise<{ labels: string[] }> | Promise<void>` 是 `Promise<X> | Promise<Y>` 而非 `Promise<X | Y>`，TypeScript narrowing 不友好。改成 `Promise<{ labels: string[] } | void>`。
  - **M2 rework / manual note 加 `mrUrl`**。原 `buildFailureNote` / `buildManualNote` 只放 `runId` + `branch`，reviewer 看不到要去哪个 MR。两个函数都接收一个 `MergeRequestRef`，note 追加 `- MR: !<iid> <webUrl>` 行。单测 + e2e 都加了对该行的断言。
  - **M3 README + CHANGELOG 注明 `ci.enabled` 不支持热生效**。`workflow.ci.enabled` 只在 daemon 启动时计算一次决定是否注入 `scanCiFeedback` 闭包，运行中改 workflow 文件不会让 scanner 上下线。README 文档化「修改 ci.enabled 后需重启 `issuepilot run`」。
  - **M4 `ci-feedback.test.ts` 误导性单测重写**。原 `does not re-trigger rework after the daemon advances the run off completed` 模拟了"completed → running"的 status flip，但 V1 dispatch 不会做这种回退；改成模拟 I1 的真实路径——把 `endedAt` 写进 state，scanner 跳过同一个 run，名字也改成 `does not re-trigger rework after the run leaves the review-stage candidate set` 更准确。
  - **M5 scanner publish 前走 `redact`**。`emit()` 把 `data` payload 过一层 `redact()`（来自 `@issuepilot/observability`）再传给 event bus，防未来给 `ci_status_*` 加 access token、pipeline log line、job name 等敏感字段时绕过 daemon 的 redact wrapper（scanner 是直接 publish，不走 `publishEvent`）。

### Added

- 2026-05-15 — **V2 Phase 3 CI Feedback 落地：human-review 阶段的 MR pipeline 状态读取与 `ai-rework` 自动回流。** 给 IssuePilot 加上"CI 失败自动打回 ai-rework"的回流路径，让 reviewer 只在 CI 绿了之后才花时间走人工 review，而不是替 CI 把关。新增 `apps/orchestrator/src/orchestrator/ci-feedback.ts` 的 `scanCiFeedbackOnce` 服务函数：扫描 `RunRecord.status === "completed"` 的 review-stage run（不依赖 claim 时刻 stale 的 `RunRecord.issue.labels`），用 `branch` 找 MR、调 `gitlab.getPipelineStatus(branch)`、按 5 类 pipeline 状态分支处理：`success` 静默观察 emit `ci_status_observed{action:"noop"}`、`failed` + `on_failure: "ai-rework"` 走 `transitionLabels({add:[reworkLabel],remove:[handoffLabel],requireCurrent:[handoffLabel]})` + 写 `<!-- issuepilot:ci-feedback:<runId> -->` marker note + emit `ci_status_rework_triggered`、`failed` + `on_failure: "human-review"` 与 `running`/`pending` 走 `ci_status_observed{action:"noop"/"wait"}`、`canceled`/`unknown` 写提示人工 review 的 marker note + emit `ci_status_observed{action:"manual"}`，所有路径都把 `latestCiStatus` + `latestCiCheckedAt` 写回 `RuntimeState`；`getPipelineStatus` 抛错走 `ci_status_lookup_failed` 不动 labels。stale-label 防护：rework transition 显式带 `requireCurrent: [handoffLabel]`，issue 已不在 human-review（被人工 reopen / merge close / 自动 close）时返回 `claim_conflict`，scanner 吞下后 emit `ci_status_observed{action:"stale"}` 而不会误把已结案 issue 翻回 ai-rework。loop integration：`apps/orchestrator/src/orchestrator/loop.ts` 的 `LoopDeps` 增加 `scanCiFeedback?: (() => Promise<void>) | undefined`，每个 tick 在 `reconcileRunning()` 之后调用一次，try/catch 隔离避免单次扫描错误废掉整轮 poll；`apps/orchestrator/src/daemon.ts` 在启动时按 `workflow.ci.enabled` 决定是否注入闭包，false 时传 `undefined` 让 loop 直接跳过。共享契约扩展：`packages/shared-contracts/src/events.ts` 追加 `ci_status_observed` / `ci_status_rework_triggered` / `ci_status_lookup_failed` 三个事件类型，`packages/shared-contracts/src/run.ts` 追加 `RunRecord.latestCiStatus?: PipelineStatus` + `RunRecord.latestCiCheckedAt?: string` 与 `PIPELINE_STATUS_VALUES`/`isPipelineStatus`。workflow / team config 扩展：`packages/workflow/src/{types,parse}.ts` 新增 `CiConfig { enabled, onFailure: "ai-rework"|"human-review", waitForPipeline }`，未配置时默认 `{ enabled: false, onFailure: "ai-rework", waitForPipeline: true }`；`apps/orchestrator/src/team/config.ts` 新增可选 `ci` 节，team 级别可全局覆盖默认值，未配置时保持 workflow 默认。dashboard 显示：`apps/dashboard/components/overview/runs-table.tsx` 在 run 状态 badge 旁边追加 `CI <status>` badge（success → emerald、failed → rose、running/pending → sky、canceled → warning、unknown → neutral），hover 显示 `latestCiCheckedAt`；`apps/dashboard/components/detail/run-detail-page.tsx` header 区追加 `Latest CI` 字段，badge + ISO 时间戳。daemon 事件持久化：扩展 `apps/orchestrator/src/daemon.ts` 的 eventBus subscriber 让 `ci_status_*` 事件和 `operator_action_*` 一样 bridge 到 eventStore，以便 `/api/events?runId=...` 和 dashboard 审计日志能查到。focused e2e：`tests/e2e/ci-feedback.test.ts` 三场景，复用 fake GitLab 的 `state.pipelines` 注入 + `injectFault({pathPrefix:".../pipelines"})`：(A) pipeline=success → labels 保持 `human-review`，`latestCiStatus=success`、emit `ci_status_observed{status:"success"}`；(B) pipeline=failed → labels 翻 `ai-rework`，issue 多一条带 marker `<!-- issuepilot:ci-feedback:<runId> -->` 的 note，event log 出现 `ci_status_rework_triggered`；(C) `/pipelines` 注入 500 fault → emit `ci_status_lookup_failed`，labels 保持 `human-review`。e2e helpers `tests/e2e/helpers/workspace.ts` + `fixtures/workflow.fake.md.tpl` 接入 `ciEnabled` / `ciOnFailure` 选项。验证：`pnpm lint` / `pnpm typecheck` / `pnpm --filter @issuepilot/orchestrator test`（213 单测，新增 12 个 ci-feedback 单测 + 3 个 loop integration 单测）/ `pnpm --filter @issuepilot/dashboard test` / `pnpm --filter @issuepilot/tests-e2e test`（44 e2e，含 3 个新增 ci-feedback 场景）全绿。
  - **Review-stage 判定改用 `RunRecord.status === "completed"`**：`RunRecord.issue.labels` 是 claim 时刻的快照，dispatch 之后 GitLab side label 已从 `ai-ready` 走到 `ai-running` / `human-review`，但 RunRecord 不会反向同步。如果按 `record.issue.labels.includes(handoffLabel)` 过滤，scanner 永远找不到候选。改成按 V1 dispatch 完成态 `status === "completed"` 过滤（dispatch 完成后 issue 一定已 transition 到 handoff label，且未被 reconcileHumanReview 关闭），并由 `transitionLabels(requireCurrent:[handoffLabel])` 做最终防护。
  - **不在本期范围**：pipeline 日志摘要生成、按 job 名映射 reviewer、webhook 实时回流（V3 才做）、自动 merge（V2 §3 非目标）、多 MR 关联同一 issue 的歧义解决（本期仍以 source branch 为主键）、review feedback sweep（Phase 4）、workspace cleanup（Phase 5）。
  - **V2 team daemon 暂不装配 ci-feedback**：和 Phase 2 operator actions 一样，V2 team mode Phase 1 只有 claim foundation 没有 dispatch / runAgent，team daemon 没有 run 处于 `completed` 状态可扫，所以 team daemon 不注入 `scanCiFeedback`。V2 dispatch 落地后再补。

- 2026-05-15 — **V2 Phase 2 Dashboard Operations 落地：retry / stop / archive 三件套，stop 走 Codex `turn/interrupt` 真实 cancel。** 新增 `apps/orchestrator/src/operations/actions.ts`（三个 action service 函数 + state 回滚 + emit `operator_action_*` 事件），`apps/orchestrator/src/runtime/run-cancel-registry.ts`（内存型 `runId → cancel` 闭包映射，5s 默认超时分类 `cancel_timeout` / `cancel_threw` / `not_registered`）。runner 包 `packages/runner-codex-app-server/src/lifecycle.ts` 暴露 `onTurnActive(cancel)` 钩子，每个 turn 把 `turn/interrupt` JSON-RPC request 闭包传给 caller；turn 收敛后闭包变 noop。识别 `turn/completed { turn.status: "interrupted" }` 走 cancelled outcome。共享契约 `packages/shared-contracts` 新增 3 个事件类型、`RUN_STATUS_VALUES` 增加 `stopping`、`RunRecord.archivedAt` 可选字段。orchestrator Fastify server 新增 POST `/api/runs/:runId/{retry|stop|archive}` 三个路由，operator header `x-issuepilot-operator` 兜底为 `"system"`，`/api/runs` 默认隐藏 archived runs，支持 `?includeArchived=true`；stop 路由额外接受 `?cancelTimeoutMs=<ms>` 透传给 registry。V1 daemon 装配 `operatorActions` 与 `runCancelRegistry`，把 `operator_action_*` 事件 bridge 到 eventStore（fire-and-forget append，与现有 publishEvent 模式一致），供 `/api/events` 与 dashboard 审计日志读取。Dashboard `apps/dashboard/lib/api.ts` 新增 `retryRun` / `stopRun` / `archiveRun` POST 客户端 + `ApiError.code/reason` 解析 + `listRuns({ includeArchived })`；`app/page.tsx` 用 `listRuns({ includeArchived: true })` 拉全量 runs，让 runs-table 的 Show archived toggle 真正可用；`components/overview/run-actions.tsx` 渲染按 run 状态决定的按钮组合，runs-table 加 Actions 列与 Show archived toggle，detail 页 header 区放 RunActions。focused e2e `tests/e2e/operator-actions.test.ts` 覆盖 retry / stop-interrupt / stop-timeout 三场景，新增 fixtures `codex.stop-interrupt.json` 与 `codex.stop-ignore-interrupt.json`。code review 收口：(a) `apps/dashboard/app/page.tsx` 默认 `includeArchived: true`（C1：Show archived toggle 否则永远 false），(b) `apps/orchestrator/src/__tests__/daemon.test.ts` 扩展 `operatorActions.retry delegates` 用例验证 eventBus bridge 真的把 `operator_action_*` 写进 eventStore，(c) e2e Scenario A 把 `expect(["claimed","running"])` 收紧为 `expect("claimed")` 并写明 plan 已记录的 retry → re-claim 端到端 gap。验证：`pnpm lint` / `pnpm typecheck` / `pnpm --filter @issuepilot/orchestrator test`（195 单测）/ `pnpm --filter @issuepilot/dashboard test`（78 单测）/ `pnpm --filter @issuepilot/tests-e2e test`（41 e2e，含 3 个新增 operator-actions 场景）全绿。
  - **V2 team daemon operatorActions 暂未装配**：V2 Phase 1 只是 claim foundation，没有 runAgent dispatch，state 里也没有真实 run，operatorActions 没东西可操作。V2 模式下三个路由返回 HTTP 503 `actions_unavailable`，dashboard 按钮显隐不分 mode，让用户在 V2 模式下点按钮能看到明确反馈。V2 dispatch 落地后再补回装配。
  - **retry → re-claim 端到端 gap**：`retryRun` 在 state 写 `status=claimed`，但 V1 dispatch loop 只 dispatch `retrying` 或新 claim 的 run；workflow `active_labels=["ai-ready"]` 不含 `ai-rework`，retry 后的 issue 永远不会被 loop 重新选中（即使加入 `active_labels`，`claimCandidates` 也会按 runId 新建一条 run，留下两条对应同一 issue 的记录）。Phase 2 e2e Scenario A 只断言 `status=claimed` 与 GitLab labels 翻成 `ai-rework`，不验证 re-dispatch 完整闭环。Phase 3+ 再选择 (a) `retryRun` 改写 `status=retrying + nextRetryAt`，或 (b) `claimCandidates` 复用同 `(projectId, iid)` 已有 run 的 runId。
  - **operator_action_* not_found 事件丢失**：`actions.ts` 在 `state.getRun(runId)` 返回 undefined 时仍 emit `operator_action_requested` / `operator_action_failed{code: not_found}` 到 bus，但 daemon 的 bridge 因为无法解析 issueIid 把这两条 record 静默丢弃（per-run 审计日志本来就查不到这种 runId，影响仅限"global audit"消费者）。V3 RBAC / 全局审计落地时再处理。
  - **dashboard summary 不 bucket `stopping`**：`stopping` 是 cancel_timeout → turnTimeoutMs → failed 的短暂中间态，`DASHBOARD_SUMMARY_VALUES`（spec §14）目前不包含它；改动需要 contract + dashboard SummaryCards 高亮表协同更新，暂记 follow-up。
  - **EventBus 类型变型**：V1 daemon `eventBus: EventBus<OrchestratorEvent>`（issue 必填）传给 `OperatorActionDeps.eventBus: EventBus<IssuePilotInternalEvent>`（issue 可选）；运行时所有消费者都容错，TypeScript 通过 bivariance 放行，但严格说是 unsound。后续可把 bridge 改成走 `publishEvent({ type, runId, ts, detail })` 让 issue 通过 `fallbackEventIssue` 归一化，顺便解决上一条。
  - **不在本期范围**：CI 回流（Phase 3）、review sweep（Phase 4）、workspace cleanup（Phase 5）、RBAC 多用户身份（V3）、批量 retry / 批量 archive。
  - **runner 进程级 SIGKILL 兜底**：本期不做。`turn/interrupt` 失败时退回 `stopping` 中间态，依赖 `turnTimeoutMs` 收敛。如果未来发现 Codex 不响应 interrupt 比例高，再单独做 SIGKILL fallback。

- 2026-05-15 — **V2 Phase 2 Task 1–4 后端 cancel 基座落地（feature branch `v2/phase2-dashboard-ops`）**：把 Phase 2 plan 的 Task 1–4 全部 TDD 完成，构成 dashboard operations 的后端闭环。Task 1：`packages/shared-contracts` 加 3 个 `operator_action_*` 事件类型、`RUN_STATUS_VALUES` 增加 `stopping`、`RunRecord.archivedAt` 可选字段。Task 2：`packages/runner-codex-app-server/src/lifecycle.ts` 暴露 `DriveInput.onTurnActive(cancel)` 钩子，每个 turn 把 `turn/interrupt` JSON-RPC request 闭包传给 caller，turn 收敛后闭包变 noop；`notificationOutcome` 识别 `turn/completed { turn.status: "interrupted" }` 走 cancelled outcome，与原 `turn/cancelled` 通知路径共存。Task 3：`apps/orchestrator/src/runtime/run-cancel-registry.ts` 内存型 `runId → cancel()` 映射，`cancel()` 默认 5s timeout race，分类 `not_registered` / `cancel_threw` / `cancel_timeout`。Task 4：`apps/orchestrator/src/operations/actions.ts` 三个 service 函数（retryRun / stopRun / archiveRun），emit `operator_action_requested` + `operator_action_succeeded` / `operator_action_failed`，retry 失败 GitLab 时回滚 state，stop 失败时把 run 标 `stopping` 让 turnTimeout 兜底。dashboard 顺手补 `STATUS_TONES` 的 `stopping` 分支（warning tone）。验证：`pnpm lint` / `pnpm typecheck` / `pnpm test` 全绿，含新增 4 个 runner cancel 测试、8 个 registry 测试、15 个 actions 测试，总 orchestrator 179 单测 + e2e 38 测试无回归。**剩余**：Task 5（HTTP routes）、Task 6（V1/V2 daemon 装配）、Task 7-8（dashboard client + UI）、Task 9（e2e）、Task 10（文档收口）。
- 2026-05-15 — **V2 Phase 2 Dashboard Operations 实施计划全量更新**：`docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`。按补充设计 spec 把原 plan 重写为 10 个 TDD 任务，覆盖共享契约（events + `stopping` + `archivedAt`）、runner-codex-app-server `onTurnActive` + `turn/interrupt` + `turn/completed { interrupted }` cancelled 识别、orchestrator `runtime/run-cancel-registry.ts` 内存型 cancel 映射、`operations/actions.ts` 三个 service（含 5s timeout 分类 cancel_timeout / cancel_threw / not_registered）、Fastify 三个 POST 路由（含 503 `actions_unavailable` 兜底）、`/api/runs?includeArchived=true` 过滤、dashboard `RunActions` 组件 + runs-table Actions 列 + Show archived toggle + detail header、focused e2e 三场景（retry / stop-interrupt / stop-timeout）、文档与 CHANGELOG 收口。明确 V2 team daemon 在 Phase 2 暂不装配 operatorActions（V2 dispatch 落地后再补），server 返回 503 让用户在 V2 模式下点按钮能看到明确反馈而不是 5xx 黑盒。验证：`git diff --check` 通过。
- 2026-05-15 — **V2 Phase 2 Dashboard Operations 补充设计 spec**：`docs/superpowers/specs/2026-05-15-issuepilot-v2-phase2-dashboard-operations-design.md`。基于 V2 总 spec §8 和原 Phase 2 plan，锁定两个原 plan 未完整解决的设计决策：(1) 用 Codex app-server 上游 `turn/interrupt` JSON-RPC request 做**真正的 cancel** 通路，替换原 plan 中 `runnerCancel: () => Promise.reject("not_implemented")` 占位；新增 `runner-codex-app-server` 的 `onTurnActive(cancel)` 钩子、orchestrator 端 `run-cancel-registry`、5s timeout + cancel_timeout / cancel_threw / not_registered 分类；(2) operator 身份收敛为 server 默认 `"system"`，dashboard client 不再读 `NEXT_PUBLIC_OPERATOR_DISPLAY_NAME`，HTTP route 仍读 `x-issuepilot-operator` header 为 V3 登录态留接口。spec 还显式标注对 dispatch cancelled outcome 处理的假设检查、stop 不直接写 GitLab labels 的不变量、`stopping` 中间态语义、以及与原 Phase 2 plan 的 6 项 diff 标注，供 writing-plans 阶段更新原 plan 使用。

### Fixed

- 2026-05-15 — **V2 Phase 1 review Minor 收口（M1/M2/M4/M5/M6/M7/M8/M9 + service-header SSR）**：把 V2 review 出的 8 个 Minor 设计偏差和一个 pre-existing SSR hydration warning 一并清理掉，让 Phase 1 底座的 CLI / lease store / dashboard / 共享契约层都符合 spec 边角条款。验证：`pnpm lint`（11 task）、`pnpm typecheck`（20 task）、`pnpm test`（20 task，含 156 orchestrator 单测 + 51 dashboard + 38 e2e + smoke）全绿。
  - **M1 `team/config.ts`：TeamConfigError dotted path 通用化**。原实现硬编码 `maxConcurrentRuns ↔ max_concurrent_runs` 等翻译表，新字段（如 `successfulRunDays`）一加进 schema 就会用 camelCase 报错给用户，违反"YAML key 是用户输入的"约束。改成对每段 zod issue path 都跑 `camelToSnake`（已 snake / 纯数字 segment 保留），未来加字段不再需要更新翻译表。新增针对 `scheduler.lease_ttl_ms` 的 regression 测试。
  - **M2 `team/config.ts`：YAML 解析失败 path 不再是空串**。原 `TeamConfigError.path = ""` 让 CLI / runbook 摸不着头脑。YAML parse 错改用 `(yaml)`，zod root 错改用 `(root)`，path 字段总有可读值。新增对 malformed YAML 的测试。
  - **M4 `runtime/leases.ts`：acquire/heartbeat 加 ttlMs 运行时校验**。zod 只在 config 入口约束 `lease_ttl_ms ≥ 60_000`，但 scheduler / 测试 / 未来的回调可以从别的路径传 0、负数、NaN 给 lease store，导致永久过期的 lease。lease store 自己也防御一道：`ttlMs ≤ 0` 或 `!Number.isFinite(ttlMs)` 直接抛 `lease acquire requires ttlMs > 0`。同时覆盖三种非法输入的测试。
  - **M5 `runtime/leases.ts`：lease 文件 JSON 损坏时 quarantine 不崩 daemon**。原 `JSON.parse` 抛 `SyntaxError` 会把整个 team daemon 直接挂掉。现在捕获 `SyntaxError`，把坏文件 rename 到 `<lease>.corrupt-<ISO>` 保留取证、stderr 打 quarantine path、然后从空 store 重启。新增测试：写入 `{not valid json` 后 acquire 仍成功，且产物文件名匹配 `leases.json.corrupt-…`。
  - **M6 `cli.ts`：新增 `issuepilot validate --config <path>`**。原 `validate` 只能校 V1 WORKFLOW.md；team-mode 配置错误只能等 `run --config` 启动时才暴露。`validate --config` 现在跑同一条 `loadTeamConfig` 管道，把 YAML / zod 错按 M1+M2 humanised 后的 path 报出来，并列出 scheduler 限额、project 数、enabled / disabled / workflow path。`--config` 与 `--workflow` 互斥；同时传给出明确错误。新增 3 个 CLI 测试。
  - **M7 `orchestrator/claim.ts` + `daemon.ts`：V1 RunRecord.projectId 默认 "default"**。V2 dashboard 按 `projectId` 聚合，V1 单 workflow 模式未填该字段，老 run 在 dashboard 上掉进 unnamed bucket。给 `ClaimInput` 加 `projectId` + `projectName`，V1 daemon 透传 `"default"` / `"Default"`，V2 scheduler 不受影响（仍写真实 project id）。新增 2 个 claim 测试覆盖显式覆盖和 default fallback。
  - **M8 `shared-contracts.ProjectSummary` + `team/registry.ts` + `project-list.tsx`：disabledReason 枚举区分手动关闭 vs 加载失败**。原 dashboard 把"yaml 里 `enabled: false`"和"WORKFLOW.md 加载失败"都显示成灰色 disabled，operator 只能靠读 `lastError` 才能区分。新增 `ProjectSummary.disabledReason: "config" | "load-error"`，registry 把两种 disabled 原因都填上；dashboard 在 `load-error` 时改用红色 `danger` badge + 文案 `load error`，manual 关闭仍是中性 `disabled`。registry / ProjectList 测试同步更新。
  - **M9 `shared-contracts.IssuePilotInternalEvent`：统一 V1/V2 daemon 内部事件类型**。V1 daemon 的 `OrchestratorEvent` 和 V2 team daemon 的 `TeamEvent` 各自定义、字段不一致（V2 缺 `createdAt` / `ts` / `issue` / `data`），但 Fastify SSE server 用宽 generic 兼掉了所以编译过、运行时差异隐藏。抽出 `IssuePilotInternalEvent` 到 shared-contracts，V1 用 intersection 强制 `issue: required`（V1 总会填 issue 上下文），V2 直接用 shared 类型，server `eventBus` 类型收紧到这一公共契约。未来任意一端漏字段会立刻 typecheck 失败。
  - **service-header.tsx：pre-existing SSR hydration mismatch 顺手修掉**。和 V2 review I6 同源问题——`toLocaleString()` 在 Node 与浏览器读不同 TZ + locale，触发 React hydration mismatch warning。改成与 `ProjectList` 一致的稳定 UTC 字符串 `YYYY-MM-DD HH:mm:ssZ`。新增专门的 SSR 稳定格式断言。

- 2026-05-15 — **V2 Phase 1 团队运行时底座 review 收口（C1-C6 + I1-I7）**：修复 V2 review 出的 6 个 Critical 并发/正确性 bug 和 6 个 Important 设计偏差，把 Phase 1 底座从「TDD 已通过但 Phase 2 一接 GitLab poll 就会暴露 bug」推进到「可以安全开 Phase 2」状态。验证：`pnpm lint`（11 task）、`pnpm typecheck`（20 task）、`pnpm test`（20 task，含 147 orchestrator 单测 + 49 dashboard + 38 e2e + smoke）全绿。
  - **C1 `runtime/leases.ts`：lease store 加 promise-chain mutex**。`acquire/release/heartbeat/expireStale/active` 全部串到同一个 promise chain 上，让 `Promise.all(...)` 风格的多项目并发 poll 不会因为 read-modify-write race 各自看到同一 active set、各自 append 然后互相覆盖。这是 spec §17 #2「并发 2 没有重复 claim 同一 issue」的核心实现保障。同时新增 `activeCount(): number` 同步 accessor 给 server `/api/state` getter 用，避免在 handler 里重新跑 IO；deny 路径只在 `expireInPlace` 真的标了过期 lease 时才写文件，避免每次 poll 失败都 churn 一次 lease 文件；tmp 文件名从 `pid-Date.now()` 改成 `crypto.randomUUID()`，避免同 ms 同 pid 冲突。新增 3 个单测：并发 5 acquire under cap=2 只发出 2 个 lease、expired-then-reacquire 同 project+issue 成功、deny 时 mtime 不变。
  - **C2 `team/scheduler.ts`：transitionLabels 失败改 continue + onClaimError**。原实现 `throw err` 中止整批 candidate，与 V1 `claim.ts` 的 `continue + onClaimError` 行为不一致，一个 stale-label 409 会废掉整轮 poll，违反 spec §13。改成与 V1 一致：失败时 release lease + 调 `onClaimError({ phase: "transition-labels" })` + `continue`。
  - **C3 `team/scheduler.ts`：rollback release 包独立 try/catch**。原 rollback 路径 `await leaseStore.release(...)` 没有 try/catch，release 自己抛错（磁盘满 / 文件被外部改坏）会替换掉原始 transitionLabels 错误且留下永久 active lease。改成 `safeReleaseLease` helper，release 失败成 `phase: "release-lease"` 通知，永远不替换 upstream err。
  - **C4 `team/scheduler.ts`：getIssue 失败回滚 lease + label**。原 getIssue 无 try/catch，失败会留下 lease=active + GitLab labels=ai-running + 无 run record，只能等 TTL（≤15min）被动恢复。现在 try-catch 包住：先把 label 从 ai-running 翻回原 matchedLabel（best-effort，失败成 `phase: "rollback-labels"` 通知），再释放 lease，最后 `phase: "fetch-issue"` 通知 + `continue`。新增 3 个 scheduler 单测覆盖三条错误路径。
  - **C5 `server/index.ts`：runtime/projects 改 getter**。原 `ServerDeps.runtime/projects` 是 plain value，daemon 启动时一次性求值传给 server，`registry.summaries()` 和 `lease store` 后续变更永远不可见。改成 `T | (() => T)` 两栖类型，getter 形式每次 `/api/state` 调用时重新求值。V1 单 workflow 路径保留 value 形式，零回归。新增 server 单测覆盖「两次请求 getter 各调一次、看到不同的 activeLeases / activeRuns」。
  - **C6 `team/daemon.ts`：daemon 创建真实 lease store 实例**。原 `runtime.activeLeases: 0` 是字面量，daemon 根本没有 lease store 实例可用。现在 `startTeamDaemon` 创建 `createLeaseStore({ filePath: ~/.issuepilot/state/leases-<sha12>.json })`（用 config sha256 前 12 位避免多 team daemon 互相覆盖），把 `runtime` 改成 getter `() => ({ ..., activeLeases: leaseStore.activeCount(), projectCount: registry.summaries().length })`，`projects` 改成 `() => registry.summaries()`。新增 `StartTeamDaemonDeps.createLeaseStore` 注入点供测试 stub。
  - **I1 `team/daemon.ts`：装 SIGINT/SIGTERM handler**。原 `wait()` 只在 `stop()` 被显式调用时 resolve，Ctrl-C 不会触发，要靠外层 smoke runner 的 5s SIGKILL 兜底。现在 `process.once("SIGINT"/"SIGTERM", () => void stop())`，并在 `stop()` 内 removeListener 避免在同进程跑多个 daemon 时泄漏。
  - **I2 `cli.ts`：`--port`/`--host` 不再覆盖 yaml**。原 commander default `"4738"`/`"127.0.0.1"` 让 team 模式永远拿不到 `issuepilot.team.yaml` 的 `server.host/port`。改成只在用户显式传 `--port` / `--host` 时才转发给 team daemon，让 yaml fallback 真正生效。V1 单 workflow 模式保留原内置默认，零回归。新增 CLI 单测覆盖显式覆盖路径。
  - **I3 `team/config.ts`：retention 默认值改回 spec §6/§11 的 30/50**。原默认 `failedRunDays: 14`、`maxWorkspaceGb: 20` 是隐式 spec drift；Phase 5 workspace retention plan 已经按 spec 30/50 制定，越早对齐越好。
  - **I4 `team/scheduler.ts`：branch 命名复用 `@issuepilot/workspace`**。原 `deriveBranchName` 自己写 slug 算法（`[^a-z0-9]+ → -`），与 V1 `slugify` + `branchName`（`[^a-z0-9-]`、保留 hyphen、空 slug fallback `untitled`、`..` / `:` / `~` / `^` / `\\` reject、长度 ≤200）不一致。同一个 issue 在 V1/V2 路径下会得到不同 branch name，会撞坏 reconciliation marker / MR lookup / 已有 source branch。改成直接 `import { branchName, slugify } from "@issuepilot/workspace"`，单测预期兼容。
  - **I5：补 2 个 focused 单测**。`leases.test.ts` 新增「expired-then-reacquire 同 project+issue 成功」（覆盖 spec §7 #1 的实际收敛行为）。`scheduler.test.ts` 新增「rollback release lease」+「getIssue 失败 rollback labels」+「release 自己抛错保留原始 transitionLabels error」三组（覆盖 plan §任务 8 步骤 1 声明但原未实测的契约）。
  - **I6 `components/overview/project-list.tsx`：`formatLastPoll` 用稳定 UTC 字符串**。原 `new Date(value).toLocaleString()` server 端用 Node TZ + locale 渲染、client 端用浏览器 TZ + locale 渲染，触发 React hydration mismatch warning。改成 `2026-05-15 01:23:45Z` 形式的稳定 UTC 输出，server / client 一致。`service-header.tsx` 的同类问题是 pre-existing，本次只修新加代码。
  - **I7 `scheduler.test.ts`：删除 `void createRealLeaseStore` 死代码**。原注释 "cover the real factory" 是误导（`void` 不调用 factory body），改成 `import type { LeaseStore, RunLease }`。

### Added

- 2026-05-15 — **V2 Phase 5 Workspace Retention 实施计划**：`docs/superpowers/plans/2026-05-15-issuepilot-v2-workspace-retention.md`。纯函数 retention planner（`packages/workspace/src/retention.ts`），active run 永不删、失败 30 天、成功 7 天、超容量只清已过期，失败现场 marker 默认保留；executor 加事件 `workspace_cleanup_planned/_completed/_failed`；CLI 新增 `issuepilot doctor --workspace` dry-run；dashboard service header 显示 workspace usage 与下次 cleanup 时间；runbook `docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md` 给操作员 SOP 与 rollback 步骤。
- 2026-05-15 — **V2 Phase 4 Review Feedback Sweep 实施计划**：`docs/superpowers/plans/2026-05-15-issuepilot-v2-review-feedback-sweep.md`。在 `human-review` 阶段 sweep MR notes，per-run `lastDiscussionCursor` 防重复；prompt context 增 `reviewFeedback`，模板 `{% for c in review_feedback.comments %}` 可访问；新事件 `review_feedback_sweep_*`；dashboard detail 页加 Latest review feedback 面板。
- 2026-05-15 — **V2 Phase 3 CI 回流实施计划**：`docs/superpowers/plans/2026-05-15-issuepilot-v2-ci-feedback.md`。复用现有 `getPipelineStatus` 在 `human-review` 阶段扫 MR pipeline，failed 默认回流 `ai-rework`；新事件 `ci_status_observed` / `ci_status_rework_triggered` / `ci_status_lookup_failed`；workflow + team config 增加 `ci` 节；dashboard runs-table 显示 CI badge。
- 2026-05-15 — **V2 Phase 2 Dashboard Operations 实施计划**：`docs/superpowers/plans/2026-05-15-issuepilot-v2-dashboard-operations.md`。覆盖 retry / stop / archive 三件套 API、`operator_action_*` 事件、`RunRecord.archivedAt`、`x-issuepilot-operator` header、dashboard 按钮组件与 focused e2e。同步在 V2 spec 的 Phase 2-5 节末追加对应 plan 链接（含 Phase 3/4/5 占位，便于后续 agent 跳转）。Phase 间无硬依赖（依赖 Phase 1）。

- 2026-05-15 — **V2 团队运行时底座（Phase 1）落地：`issuepilot run --config <issuepilot.team.yaml>` 多项目入口。** 在保留现有 `--workflow` 单项目入口的前提下，给 orchestrator 新增并行 team-mode 入口，daemon 可加载多个项目 workflow、用轻量 lease 控制并发，并把 project-aware state 暴露给 dashboard。新增模块：`apps/orchestrator/src/team/{config,registry,daemon,scheduler}.ts`（yaml+zod team config 解析、project registry、Fastify daemon shell、lease-first claim 底座），`apps/orchestrator/src/runtime/leases.ts`（file-backed lease store，支持 acquire / release / heartbeat / expireStale / active，写入用 tmp + rename 原子化）。共享契约 `packages/shared-contracts/src/{state,run}.ts` 增加可选 `ProjectSummary`、`TeamRuntimeSummary`、`RunRecord.projectId/projectName`，server `/api/state` 在 team 模式下附带 `runtime` 和 `projects` 字段。dashboard 新增 `components/overview/project-list.tsx` 渲染 project 行，`overview-page` 在快照含 projects 时显示 Projects section；orchestrator fallback 文案更新为 `WORKFLOW.md` + `--config` 双示例。CLI 拒绝 `--workflow` 与 `--config` 同时使用，未识别选项给出 `Error: --workflow and --config cannot be used together`。验证：`pnpm lint`、`pnpm typecheck`、`pnpm test`（含 e2e）全部通过，新增 18 个 focused 单测（contracts 2、orchestrator 8 split across config/leases/registry/daemon/scheduler/cli/server、dashboard 2）。不在本次范围：dashboard 写操作、CI 回流、review sweep、workspace cleanup、多 worker / 跨机器锁。
  - **新增依赖**：`apps/orchestrator/package.json` 引入 `yaml@^2.8.4` 和 `zod@^4.4.3` 用于 team config 解析与 schema 校验。
  - **team config 解析器**（`apps/orchestrator/src/team/config.ts`）：`parseTeamConfig` / `loadTeamConfig` 使用 zod v4 校验 `version`、`scheduler.max_concurrent_runs` (1..5)、`scheduler.lease_ttl_ms` (≥60_000)、`scheduler.poll_interval_ms` (≥1_000)、`projects` 至少一个、`project.id` 仅允许 lowercase 字母数字 hyphen。相对 `workflow` 路径按 config 文件目录解析成绝对路径。重复 project id 抛 `TeamConfigError("duplicate project id: <id>", "projects")`。`source.sha256` 用 raw 文本计算并存储于 `source` 元数据。
  - **lease store**（`apps/orchestrator/src/runtime/leases.ts`）：JSON 文件形态 `{ leases: RunLease[] }`，文件缺失按空数组处理。`acquire` 先把过期 lease 标 `expired`，再依次检查全局并发上限、单项目并发上限和同 issue 冲突。`release` 只把 active lease 标 `released` 保留历史。`heartbeat` 更新 `heartbeatAt` 和 `expiresAt`。写入走 `${file}.tmp-<pid>-<ts>` + `rename` 原子化。
  - **project registry**（`apps/orchestrator/src/team/registry.ts`）：`createProjectRegistry` 不调用 disabled project 的 `workflowLoader.loadOnce()`；enabled project 加载失败的 project 仍出现在 `summaries()` 中，但带 `enabled: false` + `lastError`，保证 dashboard 可观测启动失败原因。`summaries()` 顺序与 team config 中 `projects` 一致。
  - **team daemon shell**（`apps/orchestrator/src/team/daemon.ts`）：`startTeamDaemon` 解析 config、加载 registry、创建 `RuntimeState` 和 `EventBus`、并把 project-aware 元数据传给 `createServer`（`workflowPath = config.source.path`、`gitlabProject = "team"`、`runtime.mode = "team"`、`projects = registry.summaries()`）。Phase 1 不开 GitLab poll，仅启动 project-aware API shell。`handle.wait()` 阻塞直到 `stop()` 被调用，供 CLI signal handling 使用。
  - **team scheduler claim 底座**（`apps/orchestrator/src/team/scheduler.ts`）：`claimTeamProjectOnce` 顺序严格——先 `leaseStore.acquire`，acquire 失败立即 skip 不动 GitLab labels；acquire 成功后才调 `gitlab.transitionLabels`，labels 转换失败时立刻 `leaseStore.release` 回滚，避免「拿到 lease 但 GitLab 仍在 `ai-ready`」的悬空状态。run record 携带 `projectId`、`projectName`、`leaseId` 字段。
  - **CLI 路由**（`apps/orchestrator/src/cli.ts`）：`run` command 新增 `--config <path>` 选项；同时传 `--workflow` 和 `--config` 时直接退出 `exitCode=1` 并打印 `Error: --workflow and --config cannot be used together`；config 文件不存在打印 `Error: team config file not found: <path>` 并退出。成功路径打印 `IssuePilot team daemon ready: <url>` 后 `await handle.wait()`。
  - **dashboard team overview**（`apps/dashboard/components/overview/project-list.tsx`）：每行展示 project name、`gitlabProject` 或 fallback `workflowPath`、`Badge` 显示 `N active` 或 `disabled`、`Last poll` 时间、和 `lastError` 红框。`overview-page.tsx` 在 `snapshot.projects` 存在时插入 Projects section（Summary 与 Runs 之间）；空 projects 数组显示 `No team projects configured.`；fallback 页面的 unreachable 命令更新为 `issuepilot run --workflow /path/to/target-project/WORKFLOW.md` 或 `issuepilot run --config /path/to/issuepilot.team.yaml`。
  - **共享契约扩展**（`packages/shared-contracts/src/state.ts` + `run.ts`）：新增 `interface ProjectSummary { id, name, workflowPath, gitlabProject, enabled, activeRuns, lastPollAt, lastError? }`、`interface TeamRuntimeSummary { mode: "single"|"team", maxConcurrentRuns, activeLeases, projectCount }`，`OrchestratorStateSnapshot` 新增可选 `runtime` 和 `projects`；`RunRecord` 新增可选 `projectId` 和 `projectName`。V1 单 workflow daemon 不发送这些字段，dashboard 兼容回退。
  - **文档对齐**：`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md` 在 `Phase 1` 节末尾追加 plan 链接 `docs/superpowers/plans/2026-05-15-issuepilot-v2-team-runtime-foundation.md`。`README.md` `### V2 — Team-operable release` 和 `README.zh-CN.md` `### V2 — 团队可运营版本` 新增首条 🚧 标记，标注 Phase 1 foundation 已经可用为实验性 team mode。

- 2026-05-15 — **V1 本地可安装 CLI release 闭环完成。** 新增 `issuepilot@0.1.0` 本地 tarball 打包、全量 runtime 依赖自包含安装、安装态 `issuepilot dashboard` 启动路径、`release:install-smoke` 和 `release:check` 门禁。用户可通过 `pnpm release:pack` 生成 `dist/release/issuepilot-0.1.0.tgz`，再用 `npm install -g ./dist/release/issuepilot-0.1.0.tgz` 安装，并从任意目录执行 `issuepilot --version`、`issuepilot doctor`、`issuepilot validate --workflow ...`、`issuepilot run --workflow ...` 和 `issuepilot dashboard`。验证：`pnpm release:check` 通过，覆盖 format/lint/typecheck/build/test、安装态 smoke、fake smoke runner 和 `git diff --check`；安装态 daemon / dashboard 启动路径已本机验证；真实 GitLab smoke 已由操作者确认通过，Issue / MR / dashboard evidence 链接待归档。

- 2026-05-14 — **新增 GitLab OAuth 2.0 Device Flow 登录：`issuepilot auth login | status | logout`，daemon 自动 refresh token。** 把 spec §22 决策 3 从「P1 规划」提到「现役交付」，正式让用户摆脱手工 PAT 维护。新增 `@issuepilot/credentials` 包（device flow client + 0600/0700 本地存储 + 自动 refresh + CredentialResolver），重写 daemon 启动时的凭据解析路径（env 优先 → `~/.issuepilot/credentials` fallback），改造 `@issuepilot/tracker-gitlab` 在 401 时自动 refresh 一次再重试。验证：`pnpm -w turbo run build typecheck lint test` 44/44 全绿（新增 49 个单测：credentials 36、tracker-gitlab 5、orchestrator 13），`pnpm -w turbo run test:smoke` 通过。
  - **新增 `@issuepilot/credentials` 包（packages/credentials/）**：6 个模块、36 单测。
    - `device-flow.ts`：`requestDeviceCode` / `pollForToken` / `refreshAccessToken` 三个端点 client。`OAuthError` 把 RFC 8628 的 7 种状态（authorization_pending、slow_down、expired_token、access_denied、invalid_grant、invalid_client、transient/unknown）连同 `retriable` 一起暴露。所有 fetch 走 `AbortController` 30s timeout；5xx 即便 body 含 OAuth `error` 也归 `transient`；任何错误 message 都不嵌入 device_code / user_code / refresh token / access token。
    - `paths.ts` + `store.ts`：`~/.issuepilot/credentials` 默认路径（可被 `IPILOT_HOME` 覆盖），目录强制 `mkdir(mode=0o700)` + `chmod 0o700`，文件 `writeFile(mode=0o600)` + `chmod 0o600`，写入用 `${file}.tmp-<rand>` + `fs.rename` 原子化。读前 `assertSecureFileMode` 校验，发现 `mode & 0o077 !== 0` 抛 `CredentialsPermissionError` 提示用户 `chmod 600`。Windows 平台跳过 mode 校验。
    - `resolver.ts`：`createCredentialResolver({ store, env, refresh, refreshSkewMs=5min })`。`resolve({ hostname, trackerTokenEnv })` 优先级：①`tracker.token_env` 命中 → `source:"env"`，**不**触碰 store；②store 命中且未临近到期 → `source:"oauth"`；③即将过期（≤skew）→ 自动调 `refreshAccessToken` 写回 store；④无 credential → 抛 `CredentialError("not_logged_in")` 提示 `issuepilot auth login`。每个 oauth ResolvedCredential 都自带 `refresh()` 闭包供调用方按需触发。
  - **`@issuepilot/tracker-gitlab` 改造**：新增 `createGitLabClientFromCredential` 与 `createGitLabAdapterFromCredential`。前者持有当前 `ResolvedCredential`，`request<T>(label, fn)` 在 `toGitLabError` 分类为 `auth` 且 source=oauth 且未在本次重试过时，调一次 `credential.refresh!()` → `Object.defineProperty` 覆盖 hidden `_token` slot → 用新 token 重建 `Gitlab` 实例 → 重跑 fn 一次。env source 上的 401 立即向上抛，避免误触 refresh。`createGitLabClient` 旧签名零改动，所有 7 测试集 + 旧调用方完全兼容；新增 5 个 `client-credential.test.ts` 用例覆盖 401 → refresh-and-retry 路径。
  - **`@issuepilot/workflow` 让 `tracker.token_env` 可选**：schema、types、parse mapping 全部接受省略；`validateWorkflowEnv` 在 tokenEnv 缺失时静默通过；`resolveTrackerSecret` 缺失时抛带「使用 `issuepilot auth login`」提示的错。47 个 workflow 测试不变。
  - **`apps/orchestrator` CLI 新增 `auth` 子命令**（`src/auth/index.ts` + `src/cli.ts`）：
    - `auth login --hostname <host> [--scope ...] [--client-id ...] [--base-url ...]`：调 device flow → 控制台只打印 `user_code` 与 `verification_uri_complete` → 轮询直到拿到 token → 持久化。`maskToken()` 把 access token 缩成 `oauth-…ab` 形式打印；refresh token / device code 全程不出现在控制台。OAuth client_id 默认 `issuepilot-cli`，可被 `--client-id` 或 `IPILOT_OAUTH_CLIENT_ID` 环境变量覆盖（client_id 是公开值不是 secret）。
    - `auth status [--hostname]`：列出 hostname / clientId / scope / expiresAt / obtainedAt / tokenType；`describeExpiry` 输出「expires in N minutes」「expired」等友好状态；token 字符串本身永远不打印。
    - `auth logout [--hostname | --all]`：单 hostname 删除直接执行；不带 hostname 时强制要求 `--all` 才能清空，避免误操作。
  - **daemon 凭据解析优先级**（`apps/orchestrator/src/daemon.ts`）：startDaemon 在创建 GitLab adapter 前 fail-fast 调 `CredentialResolver.resolve(...)`：成功且 source=env 走旧 `createGitLabAdapter` 路径（保留 sandbox 友好的同步分支），source=oauth 走新 `createGitLabAdapterFromCredential` 路径。新增 `hostnameFromBaseUrl` 把 baseUrl 收敛成 store key，避免末尾斜杠/路径污染 credentials 文件。新增 `deps.credentialResolver` / `deps.credentialsStore` 测试钩子。
  - **新增 13 个 orchestrator 单测**：`auth/login.test.ts` 6 个（login 持久化 + 永不打印 token / 错误传播 / status 列出 / logout / 拒绝 wipe-all），`cli.test.ts` 4 个新增（auth login/status/logout 命令路由 + 错误时退出码=1），`daemon.test.ts` 3 个新增（`hostnameFromBaseUrl` 三种入参形态）。
  - **未做的扩展**：fake OAuth e2e server（计划 §Phase 7.1-7.3）暂不引入，因为 36 + 5 + 13 = 54 个单测已经覆盖：device flow 7 错误状态、refresh-and-retry 一次性、credentials 文件 0600 权限校验、daemon hostname 解析、CLI 路由 + token 不打印。后续若加跨 daemon 持久化或多 hostname 场景再补 e2e。

### Changed

- 2026-05-14 — **凭据管理文档大幅精简，中英文同步并预告 `issuepilot auth login`。** 中文 `docs/getting-started.zh-CN.md §5.0` 从 4 个方案 + 80+ 行（A direnv / B 手动 source / C shell profile / D glab 桥接 + 4 段实现细节）压缩为一张 3 行优先级表 + 3 段简洁示例（A `issuepilot auth login` 推荐 / B `.env` + direnv / C glab CLI 桥接），删除信息量低的方案 B/C 和方案 D 的工作原理段落；英文 `docs/getting-started.md` 从「完全没有 §5.0」补齐到与中文对等的 §5.0 章节，并把 §5.2/§5.3 里裸 `export GITLAB_TOKEN` 改成"§5.0 已配置则跳过，否则临时执行"。同时把即将上线的 OAuth Device Flow CLI（`issuepilot auth login/status/logout`）作为推荐方案 A 写进文档，对齐 `docs/superpowers/specs/2026-05-11-issuepilot-design.md` §22 的规划方向。

- 2026-05-13 — **统一单元测试目录结构：所有 TypeScript 包采用 `src/__tests__/` 摆位。** 测试与源码同层（`event-bus.ts` 旁边躺一个 `event-bus.test.ts`）会让 IDE 文件树噪声很重，借助方案 B（业界 Jest/Vitest 主流约定）把单元测试集中收纳：源码区只剩源文件，单元测试统一在 `src/__tests__/`，跟源码同包同层（不像方案 C 那样跨到 `pkg/tests/`，所以 import 只多一层 `../`，重构和静态分析都更友好）。`packages/workflow/tests/fixtures/` 这种 fixture 资料保持原位（fixture 不是测试代码）；`apps/dashboard` 保持 colocation（Next.js 13+ App Router 心智模型一致，不强行偏离社区惯例）。共移动 51 个 `.test.ts` 文件并修正所有相对 import。验证：`pnpm typecheck`（18/18，含 scripts）、`pnpm lint`（10/10）、`pnpm test`（18/18，含 6 包单测 + smoke + e2e）、`pnpm build`（10/10）全绿。
  - **物理迁移范围**：`packages/{core,observability,runner-codex-app-server,shared-contracts,tracker-gitlab,workflow,workspace}/src/*.test.ts` + `packages/runner-codex-app-server/src/tools/*.test.ts` + `apps/orchestrator/src/{*,orchestrator,runtime,server}/*.test.ts` 全部 `git mv` 进各自所在目录新建的 `__tests__/` 子目录；保持 git rename 历史，方便后续 `git log --follow`。
  - **import 路径自动校正**：用 inline node 脚本对所有迁移后的 51 个文件，匹配 `from "..."` / `import("...")` 上下文里的 `./X` 和 `../X` 路径，分别下移成 `../X` 和 `../../X`。regex 精确锚定 `from\s+` / `import\s*\(` 关键字，避免误改 `packages/workflow/src/__tests__/render.test.ts` 里 liquid 模板字面量 `{% include "../etc/passwd" %}`（验证测试 filesystem tag 被禁用的核心字符串，语义上必须保持 `..`）。
  - **fixture 路径同步**：4 个测试文件（`packages/workflow/src/__tests__/{parse,resolve,watch,loader}.test.ts`）通过 `path.dirname(fileURLToPath(import.meta.url))` 拼接 `tests/fixtures`，迁移后需要多上溯一层；从 `path.join(here, "..", "tests", "fixtures")` 改为 `path.join(here, "..", "..", "tests", "fixtures")`，对应实际相对位置。
  - **tsconfig 显式排除 `__tests__/**`**：8 个 package 的 `tsconfig.json` 的 `exclude` 从 `["**/*.test.ts", "dist/**"]` 改为 `["**/*.test.ts", "**/__tests__/**", "dist/**"]`，明确把 `__tests__/` 整个目录排除在编译产物之外（未来在 `__tests__/` 里放 helpers 也不会被打包进 `dist/`）。vitest config 不需要改：`include: ["src/**/*.test.ts"]` 仍然能匹配 `src/__tests__/*.test.ts`。
  - **eslint 不动**：根 `eslint.config.mjs` 的 test files override 用的是 `["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts"]`，已经覆盖 `src/__tests__/*.test.ts`；每个包的 `lint: eslint src --max-warnings 0` 仍能扫到（因为 `src/__tests__/` 在 `src/` 下）。
  - **dashboard 保持原状**：`apps/dashboard/{app,components,lib}/` 的 colocation 测试不动，遵循 Next.js App Router 社区惯例；它的 vitest include 也跨多个目录，不需要为了"统一"破坏 Next.js 文件路由思维模型。

- 2026-05-13 — **Turborepo pipeline 按官方 best-practice skill 重写，消除所有反模式。** 参考 `.agents/skills/turborepo/SKILL.md` 把根 `package.json` 里的 `&&` 串接（`turbo run test && pnpm test:smoke`、`turbo run typecheck && tsc -p scripts/tsconfig.json`、`pnpm --filter ... coverage` 串接）全部消除，重新设计 turbo 任务图，并修复 `scripts/smoke.ts` 一处 `exactOptionalPropertyTypes` 下的 execa 类型不兼容（顺手扫干净 typecheck）。验证：`pnpm typecheck`（18 task 全绿，含 scripts）、`pnpm lint`（10 task 全绿）、`pnpm test`（17/18 通过，单测 + smoke + e2e；blocked-and-failed 偶发 timer flake 重跑通过）。
  - **T1 消除 `&&` 反模式**：`pnpm test` → `turbo run test test:smoke`、`pnpm typecheck` → `turbo run typecheck typecheck:scripts`、`pnpm coverage` → `turbo run coverage`。新增 root tasks `//#test:smoke`（喂入 `scripts/**/*.ts` + `tests/integration/**/*.ts` + `vitest.config.ts` 作 inputs，声明 `env: ["GITLAB_TOKEN"]`）和 `//#typecheck:scripts`（喂入 `scripts/**/*.ts` + `scripts/tsconfig.json`）。新增根 script `typecheck:scripts` 作为 root task 实现。Coverage 改成 `turbo run coverage` 全 workspace 扫描，已经声明 `coverage` 脚本的包（workflow / tracker-gitlab）会跑，其他包 turbo no-op。
  - **T3 typecheck outputs 补齐**：`typecheck` task 现在声明 `outputs: ["dist/.tsbuildinfo", "tsconfig.tsbuildinfo"]`，让所有 composite + `incremental` 包（packages/*）和 dashboard（`incremental: true` + `tsc --noEmit` 会写 `tsconfig.tsbuildinfo`）的增量信息能被 cache 还原；命中后第二轮 typecheck 18 task 里 15 个直接 cache hit，1s 左右完成。
  - **T4 `globalDependencies` 声明顶层共享配置**：`tsconfig.base.json`、`eslint.config.mjs`、`.prettierrc`、`.prettierignore`、`.npmrc` 改动现在会让所有 task 缓存失效，避免改 lint/format 规则后 cache hit 不复跑。
  - **T5 严格模式 env 声明**：`globalEnv: ["NODE_ENV", "CI"]` + `globalPassThroughEnv: ["HOME", "USERPROFILE"]`，让 turbo strict env mode 下 `packages/workspace/src/mirror.ts` 读 `process.env["HOME"]`、CI 上跑 task 时仍能拿到必要变量；`GITLAB_TOKEN` 限定在 `//#test:smoke` 的 `env` 里（任务级声明，命中时显式 hash），既不污染全局也保证 smoke runtime 可读。
  - **T6 turbo.json 加 `$schema`**：指向 `https://turbo.build/schema.json` 让编辑器能自动校验配置。
  - **顺手修复** `scripts/smoke.ts` 的 `waitForChild` 签名：原来 `child: ReturnType<typeof execa>` 在 execa 9 + `exactOptionalPropertyTypes: true` 下推断出 `ResultPromise<具体options>` 跟 `ResultPromise<Options>` 不兼容，typecheck 一直红；改成 `<T extends PromiseLike<unknown> & { kill(signal: NodeJS.Signals): boolean }>(child: T, ...)` 结构化签名，配合 `Promise.resolve(child)` 拿到可 `.then().catch()` 的 promise 引用，函数语义不变。
  - **未做但 skill 推荐过的项**：transit-nodes 模式不引入。当前 `typecheck` 任务跑 `tsc --noEmit`，配合 monorepo TS Project References 需要上游 `dist/*.d.ts` 真实存在才能解析跨包类型，因此保留 `dependsOn: ["^build"]`；如果后续把跨包路径解析改成 source-mode（`paths` 直接指 `src/`），可以再引入 transit 让 typecheck 并行。

### Added

- 2026-05-13 — **README 增加项目亮点、Symphony 对比与 Roadmap 三块内容（中英文同步）。** 用户反馈现有 README 缺少"产品价值 hook"和"未来计划"的入口，借机把 fork 与原项目的边界也讲清楚。涉及 `README.md` / `README.zh-CN.md` 三处增量、`CHANGELOG.md` 一处记录，无代码改动；`git diff --check` 通过。
  - **顶部 hook + Highlights**：在 IssuePilot 简介前加一段 blockquote 风格的痛点 + 价值主张（"把项目工作转化为隔离的自主实现 run，让团队回到管理工作本身，而不是监督编码代理"），紧随其后新增 6 条 `### 核心亮点 / Highlights` 列表，覆盖 Issue 驱动认领、工作证明（CI / MR / reconciliation / event store / dashboard）、可信交付边界（fail-blocked + workspace 取证 + secret redact）、本地单机闭环、与 harness engineering 的互补关系、SPEC + Elixir 参考实现的开放属性。中英文版本术语保持一致（`run` / `worktree` / `MR` / `Codex app-server` 等不翻译）。
  - **「与 OpenAI Symphony 的异同」对比小节**：放在「为什么需要 IssuePilot？/ Why IssuePilot?」与「当前状态 / Current Status」之间。先用一段说明强调"整体架构思路是一脉相承"（Issue Tracker = 控制平面、per-issue workspace、Codex app-server 协议、repo-owned workflow、tracker + 文件系统驱动恢复），再用 13 行对比表列出定位 / Issue Tracker / 状态机表达 / 工作流契约 / 实现语言 / 运行形态 / 工作区策略 / 事件日志 / MR-PR 处理 / 重启恢复 / 安全姿态 / 公开 SPEC / 当前状态 13 个维度的差异，末尾给出"选 Linear+Elixir 看 `elixir/` 与 `SPEC.md`，选 GitLab+TypeScript 看仓库根目录 IssuePilot 实现"的导航句。
  - **Roadmap 小节**：放在「安全模型 / Security Model」与「文档 / Documentation」之间，基于 `docs/superpowers/specs/2026-05-11-issuepilot-design.md` §20 的 V1–V4 路线图改写，但加上 P0 完成度 emoji（✅ / 🚧）和已落地能力的引用（Fastify daemon / 14 类标准化事件 / dashboard SSE / fake E2E + smoke runbook）。V2 团队可运营版本（多项目 workflow、2–5 并发、dashboard retry/stop/archive、CI 自动回流 ai-rework、review feedback sweep、运行报告、workspace 清理）、V3 生产化平台（多 worker + 容器 sandbox + 预算 + 权限 + webhook + 观测平台 + Postgres）、V4 智能工作台（拆分子任务、跨 Issue 依赖、多 agent + reviewer、walkthrough video、质量指标、workflow 推荐、更多 runners）。末尾标注"以 design spec 为准，路线图随实际进展调整"。

- 2026-05-13 — **新增 IssuePilot 中英文使用指南。** 落地两份产品视角的 Getting Started 文档（不是 smoke runbook 的复制），告诉首次使用者「装好以后该怎么用」：
  - `docs/getting-started.zh-CN.md` 中文版（12 章 ~430 行）：环境要求、GitLab label/token/SSH 准备、`.agents/workflow.md` 字段说明（含 `token_env` / `active_labels` / `branch_prefix` / `max_attempts` / `approval_policy` / sandbox 限制 / `poll_interval_ms` 7 个要点表）、`pnpm exec issuepilot doctor|validate|run` + `pnpm smoke` 启动流程、第一个 ai-ready Issue 全链路时间线（11 个 IssuePilotEvent 类型）、6 个 label 状态的处理动作、失败 workspace 取证（`.issuepilot/failed-at-*` + JSONL event store + `issuepilot.log`）、hot reload / retry 分类（blocked vs failed vs retryable）/ approval policy / hooks / 容器多机 / 并发 6 个高级用法、CLI cheat sheet + HTTP API 端点、7 条 FAQ（codex 路径 / mirror push / GitLab 401/403 / dashboard CORS / smoke readiness 5s SIGKILL / note runId marker / cancel run）。
  - `docs/getting-started.md` 英文版（完整 1:1 翻译，保持术语、命令、路径与中文版一致）。
  - 在 `README.md` 与 `README.zh-CN.md` 的 Documentation 章节顶部新增明显入口，并补充了 smoke runbook、design spec、implementation plan 三条链接的描述说明，让"先打开哪份文档"的认知负担降到最低。
  - 文档以"实操路径"组织（环境 → GitLab → workflow.md → daemon → first run → label semantics → forensics → advanced → CLI → FAQ → next steps），区别于 spec/runbook 的"逐项验收"组织方式。

### Fixed

- 2026-05-13 — **IssuePilot Phase 8 code-review 修复合集（M8 加固版）。** 处理 [phase-8 review](docs/superpowers/specs/2026-05-11-issuepilot-design.md) 列出的 7 个 Important + 9 个 Minor 问题，外加一个根因级 bug 修复，e2e 从 28 用例扩到 34 用例并保持全绿。验证：`pnpm -w turbo run build test lint typecheck` 40 个 task 全绿（orchestrator 89 单测、tests-e2e 34 e2e、workspace 40 单测）。
  - **根因 bug** — `apps/orchestrator/src/orchestrator/classify.ts`：`classifyError` 之前先看 `"status" in err` 把所有带 HTTP 状态码的 `GitLabError` 一律分到运行时 outcome 分支返回 `kind: "failed"`，把 401/403 永久降级成可"重试再失败"的普通 failed，违反 spec §21.12 escalation。修复改为：先按 `name + category` 走 typed error 分支，再按 `typeof status === "string"` 守卫 runner outcome 分支；新增 2 个回归单测覆盖 `GitLabError + status:403` 和 `+ status:401` 必须被分类为 `kind: "blocked"`。
  - **Important #1** — claim 阶段 401/403 现在能正确升级到 `ai-blocked`：`packages/core/src/orchestrator/claim.ts` `ClaimInput` 加 `onClaimError` 回调；`apps/orchestrator/src/daemon.ts` 在 `claim()` 里挂钩——失败时 `classifyError` 是 `blocked` 才生成 synthetic runId、`runIndex` 注册、best-effort 推 `ai-blocked` label、发布带 `iid/kind/code/labelTransitioned/targetLabel` 的 `claim_failed` 事件。两条 e2e（"escalates ai-blocked" + "permanently denied 不动 label 但仍发事件"）覆盖 ai-blocked 升级路径与永久 403 兜底路径。
  - **Important #2** — retry 路径有了真实 e2e 覆盖：新增 `tests/e2e/fixtures/codex.retry-timeout.json`（连续两次 `turn/timeout` 让 spec §13 retryable 生效），`tests/e2e/fixtures/workflow.fake.md.tpl` 加 `__MAX_ATTEMPTS__` / `__TURN_TIMEOUT_MS__` 模板变量并把 `before_run` hook 的 `git commit` 改幂等（`git diff --cached --quiet || git commit ...`）以承受重试；`tests/e2e/helpers/workspace.ts` 把 `maxAttempts` / `turnTimeoutMs` option 透出。新增 e2e 断言 `run.attempt === 2` + `run.status === "failed"` + `retry_scheduled` 事件存在。
  - **Important #3 + Minor #M3** — `packages/workspace/src/mirror.ts` 抽出 `migrateMirrorClone` 并在「首次 clone」与「复用已有 mirror」两条路径都跑一次，确保用旧版 cache 升级上来的镜像也能正确 `git push origin <refspec>`；fetch 的注释明确「显式 `--prune origin` 而不是 mirror-fetch all-refs」原因，避免后续误改。
  - **Important #4** — `packages/workspace/src/mirror.test.ts` 加两个回归测试：① `clone --mirror` 之后 `remote.origin.mirror` 必须被 unset 且 `git push origin <refspec>` 成功；② 模拟「老版本遗留 cache（remote.origin.mirror=true）」场景，`ensureMirror` 必须把它修复掉。
  - **Important #5** — `tests/e2e/helpers/net.ts` 新增 `pickFreePort()`（`net.createServer().listen(0)` 拿真实 free port，避免 `Math.random` 端口冲突），`happy-path.test.ts` 与 `blocked-and-failed.test.ts` 全部改用。
  - **Important #6 + Minor #M6** — `tests/e2e/happy-path.test.ts` 把 `it` timeout 收紧到 30s 并加 `performance.now()` 运行时断言（`<25_000ms`）；新增 `waitForCompletedRun` helper 把 `run.status` 严格断言到 `"completed"`（不再放过 `"reconciling" | "retrying"` 等中间态）。
  - **Important #7 + Minor #M9** — `tests/e2e/fakes/codex/script.ts` 实现 `ScriptRequestStep.expectResponse` 校验：`kind: "result"` 时收到 error 报错，`kind: "error"` 时收到 result 也报错；`tests/e2e/fakes/codex/script.test.ts` 加 3 个用例（result-OK / result-with-error-rejected / error-with-result-rejected）。同时把内部 `pendingToolCalls` 改名 `pendingServerRequests`（Minor #M4），因为它同时承载 `tool_call` 与 `request` 两类 server-request。
  - **Minor #M1** — `tests/integration/smoke-runner.test.ts` 把"propagates JSON shape errors as fatal"重命名为「resolves immediately on a minimal valid ready response」，并新增「malformed JSON 继续轮询」「缺少 service 字段继续轮询」两个用例（之前的名字与实现含义不一致）。
  - **Minor #M2** — `tests/e2e/fakes/gitlab/server.ts` 新增 `pathMatchesFault()`，要求 `url === prefix || startsWith(prefix + "/") || startsWith(prefix + "?")`，避免 `/issues/12` 的 fault 误中 `/issues/120` 或 `/issues/12/notes`；`server.test.ts` 加专项断言。
  - **Minor #M5** — `apps/orchestrator/src/daemon.ts` 把 `splitCommand` 提取并 `export`，新实现支持单/双引号包裹（路径含空格也能用），完成 spec §16 命令解析；`tests/e2e/helpers/workspace.ts` 也加了控制字符防御性校验，防止假 codex 命令路径里塞奇怪字符。新增 `apps/orchestrator/src/daemon.test.ts` 7 个 splitCommand 单测覆盖空串/未配对引号/混合 quoting。
  - **Minor #M7** — `scripts/smoke.ts` 新增 `waitForChild(child, ms)`：readiness 失败 SIGTERM 后再等 5s，超时升级 SIGKILL，避免 daemon 不退出导致 wrapper 卡死。
  - **Minor #M8** — `apps/orchestrator/src/cli.ts` `run` 子命令新增 `--host <host>` option 透传到 `startDaemon`，`scripts/smoke.ts` 把 `--host` 真正传给 daemon；`apps/orchestrator/src/cli.test.ts` 更新断言；`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md` "常见问题" 节同步说明。
  - **Recommendation #1** — 新增 `tests/e2e/helpers/run-until-label.ts` 抽出"启动 daemon → 等 label 出现"的通用 pattern，让后续场景测试少写半屏样板代码。
  - 配套：`apps/orchestrator/src/index.ts` 导出 `splitCommand`；publishEvent 在 ENOENT（teardown 期 workspace 已删）时静默，保留其他错误的 `console.error`，让 e2e 输出更干净。

### Added

- 2026-05-12 — **IssuePilot P0 Phase 8（M8 端到端验证）完成。** 用 fake GitLab + fake Codex app-server 跑通 spec §18.2 全闭环，并提供 spec §18.3 真实 GitLab smoke runbook。验证：`pnpm -w turbo run build test typecheck lint` 全绿；`tests/e2e` 7 个测试文件 28 个 case 全绿（含 happy-path + 3 个失败/blocked 路径）；`pnpm smoke` 真实启动 daemon → ready → SIGINT 关停一次本地烟测通过。涵盖 5 个 Task：
  - **Task 8.1** `test(e2e): fake gitlab server with stateful endpoints` — `tests/e2e/fakes/gitlab/{data,server}.ts` 用 Fastify + 内存 store 模拟 `@gitbeaker/rest` 用到的最小端点子集（issues / notes / merge_requests / pipelines），暴露 `seed/getState/waitFor` 测试辅助；带 token 校验、fault injection（`{ method, path, status, count, body }`）与 ETag-less merge 行为。
  - **Task 8.2** `test(e2e): scriptable fake codex app-server` — `tests/e2e/fakes/codex/{main,script}.ts` 单进程 stdin/stdout JSON-RPC 桥，支持 `expect / respond / notify / tool_call / request` 五种脚本指令，可在测试里复现 codex app-server 的 `initialize → thread/start → turn/start → tool/call → turn/completed|failed` 全部生命周期；含 `IPILOT_FAKE_DEBUG_LOG` 排障入口与 EOF 安全 readOne 实现。
  - **Task 8.3** `test(e2e): full happy path with fakes` — `tests/e2e/happy-path.test.ts` + `tests/e2e/fixtures/workflow.fake.md.tpl` 跑通 spec §18.2 七步验收（seed ai-ready → 拾取 → worktree → tool calls → branch push + MR + note → label = human-review → JSONL event store 全覆盖）；`tests/e2e/helpers/workspace.ts` 一站式启动 fake stack。修复 `packages/workspace/src/mirror.ts` 的 `git clone --mirror` 之后 `remote.origin.mirror=true` 阻碍 `git push origin <refspec>` 的真实 bug。
  - **Task 8.4** `test(e2e): blocked and failed classification paths` — `tests/e2e/blocked-and-failed.test.ts` 三个场景：`turn/failed` 落 `ai-failed` + workpad failure note 不再重试；GitLab 403 让 claim 失败、issue 维持 `ai-ready` + 不进 retry；`approval_policy: never` 下 codex `item/commandExecution/requestApproval` 被自动批准并写入 `approval_auto_approved` 事件。脚本引擎补 `request` 步骤以下发任意 server-request。
  - **Task 8.5** `docs(superpowers): real gitlab smoke runbook and pnpm smoke wrapper` — `scripts/smoke.ts` 调度 orchestrator 子进程并轮询 `/api/state` 至 `ready`，打印 API + dashboard URL banner，转发 SIGINT/SIGTERM；`scripts/smoke-runner.ts` 抽出 `parseSmokeArgs / pollUntilReady / formatReadyBanner` 三个纯函数（8 个单测）；`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md` 提供 30 分钟内可执行的真实 GitLab smoke 指南，附 spec §18.3 十点验收清单。配套：`scripts/{package.json,tsconfig.json}` 把 scripts 纳入 ESM + strict typecheck，根 `typecheck` 串接 `tsc -p scripts/tsconfig.json`，lint smoke 扫 `scripts/`，devDeps 新增 `tsx`、`@types/node`。

- 2026-05-12 — **IssuePilot P0 Phase 7（M7 Dashboard）完成。** `@issuepilot/dashboard` 完整落地 spec §14 的两组只读视图（Overview `/` + Run detail `/runs/[runId]`），通过 SSE 实时刷新；dashboard 45 单测与 targeted typecheck/lint/build 通过，`/` 与 `/runs/[runId]` 路由都通过 Next.js 14 dynamic build。涵盖 4 个 Task：
  - **Task 7.1** `feat(dashboard): nextjs app with tailwind and shadcn primitives` — Tailwind 3.x + 手写 shadcn 风格 `Button/Card/Table/Badge` primitives + `cn` 工具（clsx + tailwind-merge）。
  - **Task 7.2** `feat(dashboard): typed api client and event stream hook` — `lib/api.ts` 5 个 typed REST helper + `ApiError` + base URL fallback；`lib/use-event-stream.ts` SSE hook 含指数退避、buffer cap、malformed payload 容错、test seam。
  - **Task 7.3** `feat(dashboard): overview page with service header and runs table` — Server Component 并行拉 state + runs，client side OverviewPage 节流 1s re-fetch；ServiceHeader 7 字段、SummaryCards 5 张 spec §14 计数卡（running/retrying/human-review/failed/blocked）、RunsTable 11 列含 issue/status sortable header、turn count 与 last event。
  - **Task 7.4** `feat(dashboard): run detail page with live timeline` — `app/runs/[runId]/page.tsx` 路由 Server Component 调 `getRunDetail` 获取 `run/events/logsTail`，404 走 `notFound()`；`RunDetailPage` 客户端组件用 `useEventStream({ runId })` 实时追加事件（按 `event.id` 去重）；`EventTimeline` 33 种 EventType 一一映射 BadgeTone，事件按 createdAt 升序，可展开 redacted data；`ToolCallList` 过滤 `tool_call_*`；`LogTail` 黑底终端样式，未拿到 logsTail 时给出 `~/.issuepilot/state/logs/issuepilot.log` 路径提示。新增 10 个详情组件单测。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.3（概览页）完成。** `apps/dashboard/app/page.tsx` + `components/overview/*` 落地 spec §14 三段视图（Service header / Summary cards / Runs table），首页改 `dynamic = "force-dynamic"` 走 Next.js Server Component 拉初始数据。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（34/34 单测），`pnpm -w turbo run test typecheck lint --force` 33/33 全绿。
  - `components/overview/service-header.tsx`：渲染 `status / gitlabProject / concurrency / pollIntervalMs / workflowPath / lastConfigReloadAt / lastPollAt` 7 个字段，status 用 Badge tone 区分（ready=success，degraded=warning），时间戳本地化 + invalid date fallback；2 个测试。
  - `components/overview/summary-cards.tsx`：用 `DASHBOARD_SUMMARY_VALUES`（shared-contracts 常量）渲染 5 张 spec §14 卡片，running/retrying/human-review/failed/blocked 高亮配色；1 个测试。
  - `components/overview/runs-table.tsx`：`"use client"` 表格组件，11 列覆盖 plan 7.3 全部要求（iid / title / labels / status / turn count / last event / elapsed / branch / MR / workspace / actions detail link），sortable header 支持 `iid / status` + `aria-sort` attribute + ▲▼ 视觉指示，默认 updatedAt desc；empty state 友好提示加 `ai-ready` label；外链全部 `rel="noreferrer noopener"`；5 个测试覆盖渲染 / empty / metadata fallback / detail link / 排序切换。
  - `components/overview/overview-page.tsx`：`"use client"` page wrapper，用 `useEventStream({ bufferSize: 50, onEvent })` 监听 `run_/claim_/retry_/reconciliation_` 前缀的生命周期事件，触发节流 1s 的 `refetch`（双护栏 `pendingRef + inflightRef` 防风暴 + 防重叠请求）；2 个测试。
  - `app/page.tsx`：Server Component 调 `fetchOverview()` 并行 GET state + runs，`refetch` 走 `"use server"` Server Action（避免 client → 4738 跨源），错误兜底页提示 `pnpm dev:orchestrator`。
  - 测试工具：vitest config 启用 esbuild automatic JSX runtime + `vitest.setup.ts` 引入 `@testing-library/jest-dom/vitest` matchers 并在 `afterEach` 调 `cleanup()` 防止 DOM 累积；devDeps 新增 `@testing-library/jest-dom`。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.2（API 客户端 + SSE hook）完成。** `apps/dashboard/lib/` 落地 typed REST client 与 `useEventStream` React hook，覆盖 spec §15 的 5 个 orchestrator endpoint。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（25/25 单测，5 个 spec 文件）。
  - `lib/api.ts`：`apiGet<T>` 用 fetch + `cache: "no-store"` + `accept: application/json`；`resolveApiBase()` 优先读 `NEXT_PUBLIC_API_BASE`、默认 `http://127.0.0.1:4738`、自动 strip trailing slash；`ApiError(status, body)` 保留状态码与响应体便于下层 fallback；`getState/listRuns/getRunDetail/listEvents/eventStreamUrl` 5 个 typed helper 直接返回 `@issuepilot/shared-contracts` 中的 `OrchestratorStateSnapshot / RunRecord（含 turnCount/lastEvent dashboard metadata） / RunDetailResponse / IssuePilotEvent`，`listRuns` 支持 `RunStatus | readonly RunStatus[]` 状态查询。
  - `lib/use-event-stream.ts`：`"use client"` React hook，封装 EventSource 连接 + 指数退避重连（1s → 2s → … 上限 30s）+ unmount 自动 close + runId 过滤参数；新增 `bufferSize`（默认 200 FIFO 防内存膨胀）、`onEvent` 回调（用 ref 缓存，回调变更不重连）、`enabled` 开关；malformed JSON 静默丢弃但保持 stream 打开。`__setEventSourceFactory` test seam 用 `__` 前缀显式标记。
  - 测试：`api.test.ts` 10 个 case 覆盖 base URL fallback / status query encode / runId URL-encode / 错误传播；`use-event-stream.test.tsx` 6 个 case 覆盖连接 / buffer cap / onEvent 回调 / 指数退避重连 / unmount cleanup / malformed payload 容错。
  - 依赖：新增 `@issuepilot/shared-contracts@workspace:*`、devDeps `@testing-library/react ^16`、`@testing-library/dom`、`jsdom`。

- 2026-05-12 — **IssuePilot P0 Phase 7 Task 7.1（Dashboard 脚手架）完成。** `@issuepilot/dashboard` 接入 Tailwind 3.x + shadcn 风格 primitives，为后续概览页/详情页打下基础。验证：`pnpm --filter @issuepilot/dashboard test typecheck lint build` 全绿（9/9 单测通过，Next.js 14 build 成功）。`pnpm -w turbo run test typecheck lint --force` 33/33 任务全绿不破坏其他包。
  - `lib/cn.ts` + `lib/cn.test.ts`：`clsx + tailwind-merge` 组合，conflict-resolution 友好的 className 工具，4 个测试覆盖 join / 条件 / 冲突覆盖 / 对象语法。
  - `components/ui/{button,card,table,badge}.tsx`：手写 shadcn 风格 primitives，Button 支持 variant/size 表驱动，Badge 支持 6 种 tone，Card 拆 `Card/CardHeader/CardTitle/CardContent`，Table 拆 `Table/TableHeader/TableBody/TableRow/TableHead/TableCell` 并外层加 overflow-x-auto；4 个 smoke 测试验证 forwardRef 组件可渲染。
  - `app/globals.css` + `tailwind.config.ts` + `postcss.config.mjs`：tailwind 3.x 三件套，content 覆盖 `app/components/lib`；扩展 `font-sans` / `font-mono` 字体栈。
  - `app/layout.tsx` 引入 globals.css 并加 `min-h-screen font-sans antialiased`；`app/page.tsx` 用新 primitives 展示 Phase 7 skeleton 状态。
  - 依赖：新增 `clsx ^2`、`tailwind-merge ^3`、devDeps 新增 `tailwindcss ^3.4`、`postcss ^8.4`、`autoprefixer ^10.4`；未引入 `@radix-ui/*` 与 shadcn-cli（P0 dashboard 只读不需要 popover/dialog，保持依赖轻量）。
  - dashboard 内部 import 改成无 `.js` 后缀（适配 Next.js webpack + bundler resolution）；vitest config 扩展 `.tsx` 文件并新增 `components/**/*.test.tsx` 入口。

### Fixed

- 2026-05-12 — **docs: IssuePilot design spec 与 implementation plan 全面修正（共 13 处问题）**
  - **Design Spec (`2026-05-11-issuepilot-design.md`)**：
    - §6 补充 `poll_interval_ms` 字段到 workflow YAML 示例，默认 `10000`；在加载规则中说明 `thread_sandbox`（kebab-case）与 `turn_sandbox_policy.type`（camelCase）分属不同 RPC 层级，格式差异是设计意图，`danger-full-access`/`dangerFullAccess` 均不允许
    - §7 `ai-rework` label 补充语义说明：这是人工主动打回（从 human-review 阶段触发）的独立状态，不是 `ai-ready` 的别名
    - §10 runner 职责说明补充 sandbox 字段格式对照注释（`thread/start` 用 kebab-case，`turn/start` 用 camelCase）
    - §12 reconciliation 兜底 push 策略补充分支冲突处理：使用 `git push --force-with-lease`；non-fast-forward 冲突分类为 `failed`，不强制覆盖
    - §16 `IssuePilotEvent.type` 从宽泛 `string` 改为 `EventType` 字面量联合类型，并补充 `threadId`/`turnId`/`projectId` 字段
    - §22 区分 workpad note（持久进度记录，agent 可主动更新）与 fallback note（orchestrator 兜底摘要），两者语义不同可共存
  - **Implementation Plan (`2026-05-11-issuepilot-implementation-plan.md`)**：
    - Architecture 描述包数量从"六个"修正为"七个"
    - Tech Stack 列表补充 `p-timeout`
    - Task 1.1 根 `package.json` devDependencies 补充 `execa`（根集成 smoke test 直接用 `execaSync`）
    - Task 2.1 `WorkflowSchema` 中的 `.default({} as any)` 改为 `.default({})`，并移除对 `danger-full-access`/`dangerFullAccess` 的允许；schema 新增 `poll_interval_ms` 字段
    - Task 3.2 排序职责澄清：adapter 只做单字段 API 排序，orchestrator 做多字段稳定排序
    - Task 5.2 补充 `p-timeout` 依赖声明说明
    - Task 6.6 `cfg.poll_interval_ms` 改为 `cfg.pollIntervalMs`（与 WorkflowConfig camelCase 对齐）
    - Phase 6.x Observability 改为 Phase 5.x，明确 `redact.ts` + `event-bus.ts` 必须在 Phase 5 前完成
    - Task 8.2 fake Codex 脚本 schema 补充四种指令类型（`expect`/`respond`/`notify`/`tool_call`）的完整语义说明和示例
  - **代码同步**：
    - `packages/workflow/src/types.ts`：`WorkflowConfig` 新增 `pollIntervalMs: number` 字段
    - `packages/workflow/src/parse.ts`：`WorkflowFrontMatterSchema` 新增 `poll_interval_ms` 字段（zod，默认 `10_000`），`parseWorkflowFile` 输出映射到 `pollIntervalMs`
    - 全量 `turbo typecheck` 通过，无 lint 错误

### Added

- 2026-05-11 — **IssuePilot P0 Phase 6（Orchestrator）完成。** `@issuepilot/orchestrator` 实现完整编排引擎，包含 8 个子模块、11 spec / 57 cases 全绿：
  - `feat(orchestrator): runtime state and concurrency slots` — 内存 RunEntry 管理 + 按状态查询/汇总、N 槽位并发控制。10 个测试。
  - `feat(orchestrator): claim candidates with optimistic labels` — 从 GitLab 拉候选 Issue、乐观 label 转换、冲突跳过、slot 感知。4 个测试。
  - `feat(orchestrator): classify errors and schedule retries` — 按 spec §13 把任意异常三分为 blocked/failed/retryable，retry 策略判断。14 个测试。
  - `feat(orchestrator): deterministic post-run reconciliation` — push / 创建或更新 MR / workpad note / label 转换 handoff，7 种缺失组合覆盖。7 个测试。
  - `feat(orchestrator): dispatch run through workspace and runner` — 串联 mirror → worktree → hooks → prompt → agent → reconcile 全流程，错误分类 + 重试决策。6 个测试。
  - `feat(orchestrator): main loop with reload and reconcile-on-start` — setInterval 驱动 tick、重启兜底 reconcile、inflight drain。5 个测试。
  - `feat(orchestrator): fastify HTTP API and SSE stream` — `/api/state`、`/api/runs`、`/api/runs/:runId`、`/api/events/stream` SSE 端点。5 个测试。
  - `feat(orchestrator): cli entry with run/validate/doctor` — commander CLI，run/validate/doctor 三命令冒烟验证。5 个测试。

- 2026-05-11 — **IssuePilot P0 Phase 6.x（Observability）完成。** `@issuepilot/observability` 实现 secret 脱敏、内存事件总线、JSONL 事件存储、原子 run 记录存储、pino 日志工厂。验证：27/27 全绿；observability 包内 6 spec / 25 cases 全绿。包含 5 个子模块：
  - `feat(observability): redact secrets in events and logs` — 基于 token 模式（glpat-/glrt-/Bearer/sk-）和字段名黑名单（password/secret/api_key/token 等）的递归脱敏。7 个测试。
  - `feat(observability): in-memory event bus` — 泛型 pub/sub，支持过滤函数和 unsubscribe，订阅者错误隔离。5 个测试。
  - `feat(observability): append-only event store` — JSONL 按 `<projectSlug>-<issueIid>.jsonl` 切文件，支持 limit/offset 分页。4 个测试。
  - `feat(observability): atomic run record store` — JSON 按 `<projectSlug>-<issueIid>.json` 存储，写入先到 .tmp 再 rename 保证原子性。5 个测试。
  - `feat(observability): pino logger with run context` — pino factory 支持 stdout + 可选文件双输出，child logger 注入 runId/issueIid。2 个测试。

- 2026-05-11 — **IssuePilot P0 Phase 5（M5 Codex App-Server Runner）完成。** `@issuepilot/runner-codex-app-server` 实现 spec §10 的 JSON-RPC stdio client、线程/回合生命周期编排、事件标准化和 spec §11 的 9 个 GitLab dynamic tools。验证：`pnpm -w turbo run build test typecheck --force` 27/27 全绿；runner 包内 5 spec / 24 cases 全绿。包含 5 个 Task：
  - **Task 5.1（commit 07ab23a）** `feat(runner): newline-delimited JSON-RPC stdio client` — `spawnRpc` 封装 `execa` 实现双向 NDJSON-RPC，支持 request/response（带 pending map）、通知、malformed 行处理、进程退出清理。6 个测试。
  - **Task 5.2（commit 6568a69）** `feat(runner): drive thread/turn lifecycle with timeouts` — `driveLifecycle` 编排 initialize → thread/start → turn/start 循环，处理 completed/failed/cancelled/timeout 四种回合结局，支持 maxTurns 限制。3 个测试。
  - **Task 5.3（commit 46a455f）** `feat(runner): normalize app-server notifications into events` — 把 turn/notification、tool/*、approval/request、turn/input_required 映射成标准 IssuePilotEvent；policy=never 自动 approve；input 请求自动回复 non-interactive 消息。8 个测试。
  - **Task 5.4（commit 2e8ac42）** `feat(runner): expose allowlisted GitLab dynamic tools` — `createGitLabTools` 生成 9 个 ToolDefinition，每个 handler 用 `safe()` 包装，成功返回 `{ok:true,data}`，失败返回 `{ok:false,error}`。5 个测试。
  - **Task 5.5（commit d36884d）** `feat(runner): expose codex runner facade` — 汇总导出所有 runner 功能到 index.ts。

- 2026-05-11 — **IssuePilot P0 Phase 4（M4 Workspace Manager）完成。** `@issuepilot/workspace` 实现 spec §9 的 bare mirror + git worktree 模型和 hooks 执行。验证：`pnpm -w turbo run build test typecheck --force` 27/27 全绿；workspace 包内 6 spec / 37 cases 全绿，覆盖路径安全、mirror 克隆/fetch、worktree 创建/复用/脏检测、hook 执行/超时/跳过、失败标记保留。包含 6 个 Task：
  - **Task 4.1（commit 2585c4e）** `feat(workspace): path safety and branch sanitizer` — `slugify` 仅保留 `[a-z0-9-]`，collapses 连字符，空返 `untitled`，支持 maxLen；`assertWithinRoot` 用 `fs.realpath` canonicalize 后校验子路径在根路径下，防 symlink escape 和 `..` traversal；`branchName` 生成 `prefix/iid-titleSlug`，校验 ≤200 字符且不含 `..`/`:`/`~`/`^`/`\\`。新增 15 个测试。
  - **Task 4.2（commit 0f3c7bb）** `feat(workspace): ensure bare mirror via execa` — `ensureMirror` 首次调用 `git clone --mirror`，后续调用 `git fetch --prune origin`，支持 `~` 路径展开。新增 4 个测试覆盖 first clone、fetch reuse、新 commit pickup、无效 URL 报错。
  - **Task 4.3（commit 963302e）** `feat(workspace): worktree create-or-reuse with safety checks` — `ensureWorktree` 路径确定 `<root>/<slug>/<iid>`，先 `assertWithinRoot`；不存在时 `git worktree add -B <branch> <baseBranch>`；存在时校验 is-worktree、branch 一致、工作区干净，脏工作区抛 `WorkspaceDirtyError`。新增 4 个测试。
  - **Task 4.4（commit db48996）** `feat(workspace): execute hooks with timeout and size cap` — `runHook` 用 `bash -lc` 在 workspace cwd 执行自定义脚本，支持 env 注入、可配 timeout（默认 600s）、stdout/stderr 1MB 截断；空/undefined script 跳过返回 `skipped: true`；非零退出或超时抛 `HookFailedError`。新增 7 个测试。
  - **Task 4.5（commit 3a92e41）** `feat(workspace): mark workspace failure for forensics` — `cleanupOnFailure` 不删除文件，仅在 `.issuepilot/failed-at-<iso>` 写入失败 context JSON；`pruneWorktree` 为 P1 占位。新增 4 个测试。
  - **Task 4.6（commit def715b）** `feat(workspace): expose workspace manager facade` — 汇总导出 slugify/assertWithinRoot/branchName/ensureMirror/ensureWorktree/runHook/cleanupOnFailure/pruneWorktree 及三个 Error class，index.test.ts 增加 facade 契约测试。

- 2026-05-11 — **IssuePilot P0 Phase 3（M3 GitLab Adapter）完成。** `@issuepilot/tracker-gitlab` 用 `@gitbeaker/rest@^43.8` 实现 spec §11 的 9 个适配器方法 + 三分类错误（auth/permission/not_found/validation/rate_limit/transient/unknown），retriable 默认与 spec §13 对齐。验证（无缓存）：`pnpm -w turbo run build test typecheck lint --force` 36/36 全绿；tracker-gitlab 包内 9 spec / 57 cases 全绿，覆盖 client 错误分类、issue 列表/详情、label 乐观锁、note workpad、MR 幂等 CRUD、pipeline 状态映射。包含 6 个 Task：
  - **Task 3.1（commit 6b21b3c）** `feat(tracker-gitlab): client factory with classified errors` — `createGitLabClient` 接受 baseUrl / tokenEnv / projectId，通过 `resolveGitLabToken` 校验 env name 合法（`^[A-Za-z_][A-Za-z0-9_]*$`）+ trim 后非空，token 用 `Object.defineProperty({ enumerable: false })` + 自定义 `toJSON` 双重隐藏；`request(label, fn)` 统一把抛错 normalize 成 `GitLabError`：401→auth / 403→permission / 404→not_found / 400-409-422→validation / 429→rate_limit / 5xx→transient / 其它→unknown。新增 13 个测试。
  - **Task 3.2（commit d61c2c1）** `feat(tracker-gitlab): list candidate issues with exclude filter` — `listCandidateIssues(client, opts)` 用 `Issues.all({ state: "opened", labels: activeLabels.join(","), orderBy: "updated_at", sort: "asc", perPage: opts.perPage ?? 50 })`，本地用 `Set(excludeLabels)` 过滤；`toIssueRef` 把 REST 的数字 id 映射成 `gid://gitlab/Issue/<n>` 并 `Object.freeze` labels 数组。同时拆出 `src/api-shape.ts` 给 `@gitbeaker/rest` 的最小接口定义（Issues/IssueNotes/MergeRequests/MergeRequestNotes/Pipelines + 配套 Raw* 行 schema），让 stub 注入和真实 ctor 共享类型。新增 7 个测试。
  - **Task 3.3（commit fa0a1a8）** `feat(tracker-gitlab): label transition with optimistic claim` — `transitionLabels(client, iid, { add, remove, requireCurrent })` 先 `Issues.show` 读 labels，缺失 `requireCurrent` → `GitLabError(category="validation", status=409, retriable=false, message="claim_conflict: ...")`；计算 `next = (current\remove) ∪ add` 保留顺序去重；只有差异时调 `Issues.edit`；第二次 `Issues.show` 验证 add 全部到位且 remove 全部移除，否则同样 claim_conflict。新增 7 个测试。
  - **Task 3.4（commit 959f97a）** `feat(tracker-gitlab): persistent workpad note operations` — `createIssueNote` / `updateIssueNote(... noteId, { body })` / `findWorkpadNote(iid, marker)`，第一行匹配（trim 后）`<!-- issuepilot:run=<runId> -->` 作为 workpad sticky note 标识；跳过 GitLab system note；perPage=100。新增 7 个测试。
  - **Task 3.5（commit 9d54638）** `feat(tracker-gitlab): merge request CRUD and pipeline status` — `createMergeRequest` 先 `MergeRequests.all({ sourceBranch, state: "opened", perPage: 5 })`，已存在 opened MR 时幂等返回，否则 `MergeRequests.create(projectId, source, target, title, { description, issueIid })`；`updateMergeRequest` 在 updates 为空时直接 short-circuit；`getMergeRequest` 投影 `{ iid, webUrl, state }`；`listMergeRequestNotes` 把 author 回退到 username→name→`"unknown"`。`getPipelineStatus(ref)` 取 `Pipelines.all({ ref, perPage: 1, orderBy: "updated_at", sort: "desc" })` 最新一条，`classifyPipelineStatus` 把 GitLab 12+ 种 raw status 收敛成 6 种（created/manual/scheduled/preparing/waiting_for_resource → pending；skipped → canceled；未知 → unknown）。新增 13 个测试。
  - **Task 3.6（commit 5038a10）** `feat(tracker-gitlab): expose adapter facade` — `createGitLabAdapter(input)` 返回 `GitLabAdapterHandle = GitLabAdapter & { client }`，每个方法是 helper 的一行 binding，保持 adapter 无状态；同时补全 `getIssue(iid) → IssueRef & { description }`（description 缺失回退 `""`）。8 个 contract 测试覆盖 11 个方法签名 + token 仍然 redact。

### Fixed

- 2026-05-11 — **IssuePilot Workflow Loader 安全边界加固。** 拒绝 workflow 配置 `danger-full-access` / `dangerFullAccess` sandbox；`tracker.token_env` 限制为合法环境变量名且缺失错误不回显疑似 secret；`renderPrompt` 在运行时构造 prompt 白名单 context，额外字段渲染为空并 warn；`createWorkflowLoader` 统一执行 parse → path expand → token env validate；hot reload 忽略较晚完成的过期 reload 结果。验证：`pnpm --filter @issuepilot/workflow test` 47/47 通过，`typecheck` / `lint` / `build` / `git diff --check` 通过。

### Added

- 2026-05-11 — **IssuePilot P0 Phase 2（M2 Workflow Loader）完成。** `@issuepilot/workflow` 完整实现 `.agents/workflow.md` 的解析、`~/$HOME` 路径与 token env 解析、liquidjs prompt 渲染、fs.watch + stat 轮询的 hot reload，以及面向 orchestrator 的 `createWorkflowLoader` 门面。验证（无缓存）：`pnpm -w turbo run build test typecheck lint --force` 36/36 全绿；workflow 包内 6 spec / 47 cases 全绿，覆盖 spec §6 加载规则、§6 全部 12 个模板变量、与缺失 secret/缺失 tracker/坏 YAML/hot reload 失败保留 last-known-good 等错误路径。包含 5 个 Task：
  - **Task 2.1（commit 8636bb4）** `feat(workflow): parse front matter into typed config` — `parseWorkflowFile` 通过 `gray-matter` + `yaml`（显式拒绝 array/标量 front matter）+ zod schema，把 snake_case YAML 映射成 camelCase `WorkflowConfig`，可选 section 用 `prefault({})` 触发嵌套 default 与 spec §6 默认值对齐；`WorkflowConfigError(path)` 区分 `<file>` / `<front-matter>` / 字段 dot-path 三类错误。新增 4 个 fixture（valid/minimal/missing-tracker/bad-yaml）+ 6 个测试。
  - **Task 2.2（commit 1127790）** `feat(workflow): resolve tilde paths and validate token env` — `expandHomePath` 支持 `~`、`~/...` 与字面量 `$HOME`（仅在边界字符前），显式不展开 `~user/...`、`${HOME}`、`$HOMEX`、其它 env；非字符串输入抛 `WorkflowConfigError(path = "<path>")`。`expandWorkflowPaths` 克隆并展开 `workspace.root` / `repoCacheRoot`，保持纯函数。`validateWorkflowEnv` 与 `resolveTrackerSecret` 把 secret 解析集中到运行期，cfg 永不带 token。新增 15 个测试。
  - **Task 2.3（commit e4569f8）** `feat(workflow): render liquid prompt with whitelisted context` — `renderPrompt` 用 liquidjs（strictVariables=false / strictFilters=true / cache=false / root=[]），并把 `fs` 适配器全部替换成 reject/false 实现，显式禁掉 `{% include %}` / `{% render %}`；`detectMissingVariables` 用正则提取顶层 dotted 引用静态扫描，缺失项以 `{ path }` 元数据走可注入的 `PromptRenderLogger.warn`。新增 8 个测试覆盖 spec §6 12 个变量、未定义字段空串 + warn 路径、空数组不触发 warn、include/render 抛错、未知 filter 抛错。
  - **Task 2.4（commit 079ecb9）** `feat(workflow): hot reload with last-known-good fallback` — `watchWorkflow(file, opts)` 监听 dirname + basename 过滤，规避编辑器 rename-then-write 模式；debounce 默认 250ms（测试可调低），`sha256` dedup 防止编辑器双写；运行期 parse 失败包装成 `WorkflowConfigError` 走 `onError`、`current()` 保留 last-known-good；`stop()` 幂等。新增 6 个测试。
  - **Task 2.5（commit dd610bb）** `feat(workflow): expose loader facade with start/loadOnce/render` — `createWorkflowLoader({ logger? })` 返回 `{ loadOnce, start, render }`，`start` 的 `onReload` / `onError` 默认 no-op，`render` 默认沿用注入 logger 调用方可覆盖。同时在 `watch.ts` 加上 `max(debounceMs*4, 200ms)` 的 stat-mtime 轮询兜底（解决 turbo 并发跑时 fs.watch 偶发不触发），仍依赖 sha256 dedup。`index.ts` 汇总导出 parse/resolve/render/watch/loader 的公共 API。新增 4 个集成测试。

- 2026-05-11 — **IssuePilot P0 Phase 1（M1 Skeleton）完成。** 落地 pnpm workspace + Turborepo + TypeScript 项目引用，并把跨包公共契约前置到 `@issuepilot/shared-contracts`。验证：`pnpm -w turbo run build test typecheck lint` 36/36 全绿、`pnpm test:smoke` 11/11 全绿、`pnpm --filter @issuepilot/shared-contracts test` 20/20 全绿。包含 4 个 Task：
  - **Task 1.1（commit 1228596）** `chore: bootstrap pnpm workspace with turborepo` — 根 `package.json` 锁定 `pnpm@10.33.2` + Node 22；新增 `pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`（strict + NodeNext + ES2023 + composite）、`.npmrc`（engine-strict）、`.gitignore`、`tests/integration/scaffold.smoke.test.ts`。
  - **Task 1.2（commit e403384）** `chore: scaffold workspace packages and apps` — 为 7 个 library package（`@issuepilot/core`、`workflow`、`tracker-gitlab`、`workspace`、`runner-codex-app-server`、`observability`、`shared-contracts`）和 2 个 app（`@issuepilot/orchestrator` 占位 + `@issuepilot/dashboard` Next.js 14 + React 18 最小可 build 应用）创建 stub。每个 workspace 都接入 turbo `build/test/typecheck/lint` 调度。
  - **Task 1.3（commit 6548e94）** `chore: configure eslint, prettier, tsconfig project references` — 接入 ESLint v9 flat config（`typescript-eslint` recommended + `eslint-plugin-import`，测试与 dashboard 上下文有针对性 override）、Prettier（80 列、双引号、`trailingComma: all`）、`.editorconfig`，根 `tsconfig.json` 聚合 8 个 emitting workspace 的 `references`；每个包 `lint` script 由占位 echo 改为 `eslint --max-warnings 0`。新增 `tests/integration/lint.smoke.test.ts` 把契约纳入 CI。
  - **Task 1.4（commit 26cdd3b）** `feat(shared-contracts): define run/event/state interfaces` — 在 `@issuepilot/shared-contracts` 落地 5 个子模块：`issue.ts`（`IssueRef`）、`run.ts`（`RUN_STATUS_VALUES` + `RunStatus` + `isRunStatus` + `RunRecord`）、`events.ts`（覆盖 spec §10 全部 33 个 event type 的 `EVENT_TYPE_VALUES` + `EventType` + `isEventType` + `IssuePilotEvent`）、`state.ts`（`SERVICE_STATUS_VALUES` + `OrchestratorStateSnapshot`）、`api.ts`（`ListRunsQuery` / `RunsListResponse` / `RunDetailResponse` / `EventsQuery` / `EventsListResponse`）。每个值 + 类型对都用 `expectTypeOf` 配套测试防止漂移。
- 2026-05-11 — 新增 IssuePilot P0 实现计划：`docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md`。计划基于 `docs/superpowers/specs/2026-05-11-issuepilot-design.md`，按 spec §19 的里程碑拆分为 8 个 Phase（M1 skeleton → M8 E2E + smoke），细化到 ≈ 40 个 Task，每个 Task 给出 Files / TDD 5 步 / 验收。包含跨包接口契约（`@issuepilot/shared-contracts`、`@issuepilot/workflow`、`@issuepilot/tracker-gitlab`、`@issuepilot/workspace`、`@issuepilot/runner-codex-app-server`、`@issuepilot/observability`）、文件结构总图、风险与回退、以及与 spec §21 MVP DoD 14 条逐项对齐的验证矩阵。
