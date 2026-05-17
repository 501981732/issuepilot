# IssuePilot V4.3 Review Packet + Evidence 验收检查清单

日期：2026-05-17
状态：**有条件通过（当前默认 runtime 存在 Rollup native code-signature 问题，且缺少 `pnpm` / `corepack`；已用 Codex bundled Node runtime + 本地 package bin 完成等价 gate）**

对应 spec：
`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
§7 V4.3 + §14.3 + §14.4 + §15。
对应实施计划：
`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
（任务 23）。

把本清单复制到 PR 描述里作为自检清单。

## V4.3 验收标准

- [x] **Evidence 自动索引**：task worktree 下
      `.issuepilot/evidence/<runId>/` 支持 `screenshots`、`recordings`、
      `playwright`、`commands`、`tests` 五类目录；`manifest.json`
      优先；超过 50MB 的文件不进入可服务索引；path traversal entry
      被拒绝。
  - 证据 1：`apps/orchestrator/src/work-items/evidence-scanner.ts`
    实现目录推断、manifest 解析、50MB 上限、path traversal 校验。
  - 证据 2：`apps/orchestrator/src/work-items/__tests__/evidence-scanner.test.ts`
    覆盖目录推断、manifest 优先、oversized 和 rejected entry。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    覆盖 task run 产出截图、Playwright zip、command log 后被聚合进
    `WorkItemReport.evidence.byTask`。

- [x] **AI vs human 区分**：`WorkItemEvidenceEntry.confidence` 支持
      `ai-claim`、`system-derived`、`human-confirmed`；dashboard
      `ConfidencePill` 可视化；confirm API 把单条 evidence 升级为
      human-confirmed。
  - 证据 1：`packages/shared-contracts/src/evidence.ts` 定义 confidence
    与确认字段。
  - 证据 2：`apps/orchestrator/src/work-items/store.ts` 持久化
    evidence confirmation sidecar；
    `apps/orchestrator/src/work-items/service.ts` 的
    `confirmTaskEvidence` 校验 task/evidence 归属、写入
    `confirmedBy` / `confirmedAt` 并触发 `reconcileWorkItem`。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    §confirm flow 断言 confidence 从 `ai-claim` 变为
    `human-confirmed`，并重新渲染 handoff note。
  - 证据 4：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 confirm 按钮和 optimistic reload 路径。

- [x] **统一 Parent Review Packet 渲染**：GitLab handoff note 与 dashboard
      Markdown export 共用 renderer；`GET /api/work-items/:id/report.md`
      返回 raw `text/markdown`，不是 JSON wrapper。
  - 证据 1：`apps/orchestrator/src/work-items/render-report.ts` 同时支持
    `audience: "gitlab"` 与 `audience: "markdown"`。
  - 证据 2：`apps/orchestrator/src/work-items/handoff.ts` 继续独占 marker
    拼接，避免 renderer 输出重复 marker。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    断言 handoff note body 与 `renderWorkItemReportMarkdown(...,
    { audience: "gitlab" })` 一致，`report.md` 与 markdown renderer 一致。
  - 证据 4：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
    覆盖 `Copy as Markdown` 从 orchestrator 拉取 `report.md`。

- [x] **Human review checklist**：Parent Review Packet 会把 medium/high
      risk、`needs_rework`、partial overall status、missing evidence、
      skipped task、CI failed 派生成 checklist；V4.3 checklist 只读，
      单条确认仍走 evidence tab。
  - 证据 1：`apps/orchestrator/src/work-items/aggregate.ts` 从 run report、
    risk、CI/test/evidence 缺口派生 `humanReviewChecklist`。
  - 证据 2：`apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`
    覆盖 checklist reason 与 confirmed=false。
  - 证据 3：`apps/dashboard/components/work-items/human-review-checklist.test.tsx`
    覆盖只读 checklist、localized hint 和 confirmed 渲染兼容。

- [x] **Dashboard 三态视图**：`?view=list|graph|evidence` 通过 URL
      持久化；`EvidenceTab` 支持 kind filter、图片缩略图、文件链接和单条
      confirm。
  - 证据 1：`apps/dashboard/components/work-items/view-toggle.test.tsx`
    覆盖 list / graph / evidence 三态按钮。
  - 证据 2：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 grouped entries、kind filter、截图渲染、confirm action。
  - 证据 3：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
    覆盖 `view=evidence` 初始态、EvidenceTab 接入、confirm 后 reload。

- [x] **Team-mode project 隔离**：Evidence index、`report.md`、file route
      和 confirm route 均保持 project-scoped；媒体链接通过 `project` query
      传递项目上下文。
  - 证据 1：`apps/orchestrator/src/server/__tests__/server.test.ts`
    覆盖 work-item routes 的 `x-issuepilot-project` 分发、400/404 错误码。
  - 证据 2：`apps/orchestrator/src/team/__tests__/work-items.test.ts`
    覆盖 per-project `WorkItemService` 与 ReportStore 隔离。
  - 证据 3：`apps/dashboard/lib/api.test.ts` 覆盖
    `buildEvidenceFileUrl` 的 `project` query。
  - 证据 4：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 project-scoped evidence file links。

- [x] **不变量保持**。
  - 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - `TaskRunLink` 仍是唯一 canonical task-to-run binding。
  - synthetic task run 的 `parentIssueLabelMode === "suppressed"`。
  - 不创建 child GitLab Issue。
  - evidence 文件不离开 task worktree。
  - 证据：V4.1/V4.2 既有 e2e 全部通过，V4.3 新增
    `work-items-v43-e2e.test.ts` 使用真实 `tickWorkItem` /
    `settleTaskRunFinal` / `scanRunEvidence` 路径验证同一不变量。

- [x] **验证 gate（带环境说明）**。
  - 可复现前置：
    `PATH=/Users/wangmeng5/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH`。
  - 默认 `/Applications/Codex.app/Contents/Resources/node` 在当前机器启动
    Vitest 会失败于 Rollup native optional dependency code-signature
    (`ERR_DLOPEN_FAILED`)；因此 Vitest 结果只声明为 bundled runtime 下
    的本地验证结果。
  - 当前 shell 没有 `pnpm` / `corepack`，所以 `pnpm -r build` /
    `pnpm -r lint` / `pnpm -r test` 和根 `vitest.config.ts` 中硬编码的
    `pnpm exec eslint ...` smoke 无法作为本环境 gate；同一 lint/build/test
    覆盖已用本地 package bin 执行。
  - `PATH=... ./node_modules/.bin/tsc -b` 通过。
  - `PATH=... ./node_modules/.bin/tsc -p scripts/tsconfig.json` 通过。
  - `PATH=... ./node_modules/.bin/next build`（`apps/dashboard`）通过。
  - `PATH=... ./node_modules/.bin/eslint apps/orchestrator/src apps/dashboard/app apps/dashboard/lib apps/dashboard/components packages/*/src tests/e2e --max-warnings 0`
    通过。
  - `PATH=... ../../node_modules/.bin/vitest run --maxWorkers=1 --minWorkers=1`
    以 package cwd 逐个执行通过：`packages/shared-contracts` 82、
    `packages/core` 2、`packages/credentials` 36、`packages/observability`
    31、`packages/runner-codex-app-server` 37、`packages/workflow` 58、
    `packages/workspace` 57、`packages/tracker-gitlab` 78、
    `apps/orchestrator` 546、`apps/dashboard` 209、`tests/e2e` 51。
  - `git diff --check` 通过。

- [x] **文档 + CHANGELOG 已更新**。
  - `CHANGELOG.md` 顶部新增 `[Unreleased] V4.3 Review Packet + Evidence`。
  - `README.md` / `README.zh-CN.md` roadmap V4 段落新增 V4.3 已落地条目。
  - `USAGE.md` / `USAGE.zh-CN.md` 新增 §5.9
    *V4.3 Review Packet + Evidence*；原边界章节顺延为 §5.10。
  - `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
    顶部「实施计划」加入 V4.3 链接。
  - 本文件即任务 23 的输出。
