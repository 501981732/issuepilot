# IssuePilot V4.4 Quality Analytics 验收清单

日期：2026-05-18
状态：implementation landed，等待 final gate 验证

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics.md`
- 内部 spec：`docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- 仓库规则：`AGENTS.md`

## 1. 验收范围

V4.4 Quality Analytics 第一版只覆盖：

- `apps/orchestrator/src/quality/`（`collect.ts` / `filters.ts` / `patterns.ts` /
  `aggregate.ts`）以及 `GET /api/quality/summary` 路由。
- single-mode（`apps/orchestrator/src/daemon.ts`）与 team-mode
  （`apps/orchestrator/src/team/daemon.ts`）的 quality 装配。
- dashboard `apps/dashboard/lib/api.ts#getQualitySummary` 客户端、
  `apps/dashboard/app/reports/page.tsx` 数据流，以及
  `apps/dashboard/components/reports/quality-analytics.tsx`
  Quality Analytics UI（SummaryStrip / TrendPanel / PatternList / DrilldownTable）。
- 中英 i18n：`apps/dashboard/i18n/messages/en.json` 与
  `apps/dashboard/i18n/messages/zh.json` `reportsPage.quality.*` 节。
- 共享 contract：`packages/shared-contracts/src/quality.ts`，从 `index.ts` /
  `api.ts` 重新导出。

不在范围：

- 任何 LLM 失败分类、Postgres、外部分析存储、后台分析 job。
- workflow / skills / prompt 自动改写（属于后续 V4.5 范围）。
- 修改 `RunStatus` / `PipelineStatus` 枚举或 work-item label 状态机。
- 新增 `cancelled` 状态、`skipped` pipeline 状态、或 `project` query
  scope（团队 scope 继续走 `x-issuepilot-project` header）。

## 2. 验收 checklist（对齐 spec §12）

- [x] **§12.1**：`/api/quality/summary` 能从 run reports 和 work-item reports
  聚合 success / failure / rework / CI / review / missing-evidence / median
  duration 指标（见
  `apps/orchestrator/src/quality/aggregate.ts`，单测
  `apps/orchestrator/src/quality/__tests__/aggregate.test.ts`）。
- [x] **§12.2**：指标支持 `x-issuepilot-project` scope，以及
  `workflow` / `taskType` / `status` / `pattern` 过滤和 `7d` / `30d` 默认窗口
  + `from` / `to` 显式窗口（见 `filters.ts` 与
  `apps/orchestrator/src/server/__tests__/server.test.ts` 中的
  `V4.4 quality summary route` describe 块）。
- [x] **§12.3**：Failure patterns 能稳定识别 `permission-issue` /
  `environment-issue` / `unclear-requirements` / `review-rework` /
  `ci-failure` / `missing-tests` / `missing-evidence`（见
  `patterns.ts` 与 `patterns.test.ts`）。
- [x] **§12.4**：`/reports` 页面展示 Quality Summary、Trend、Failure Patterns
  和 Drill-Down（见 `quality-analytics.tsx` 与
  `quality-analytics.test.tsx`）。
- [x] **§12.5**：点击 pattern 会更新 URL `pattern` query 并过滤 drill-down
  来源（`quality-analytics.test.tsx` 的「filters drilldown when a pattern
  button is clicked and writes URL」case；同一行 drilldown 仍链接回原始 run /
  work item / task / evidence）。
- [x] **§12.6**：team mode 下 project A / project B 的质量数据互不可见
  （`server.test.ts` 的「routes team quality summary to the selected
  project」case，以及「rejects unknown project id in team mode」case）。
- [x] **§12.7**：空数据与 unknown 数据状态稳定可读（`quality-analytics.test.tsx`
  的「renders an empty state when no metric data exists」case；空 store 在
  `server.test.ts` 的「returns stable empty response when stores are absent」
  case 中验证）。

## 3. 验证命令

> **运行环境注意**：本机默认 Node 23 在加载 Rollup native optional
> dependency 时被 code-signature 问题挡住；当前可靠的本地 gate 是显式把
> `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`
> 放到 `PATH` 最前并跑包级 Vitest。完整 lockstep gate（`pnpm -r build|lint|test`）
> 依然需要 corepack / pnpm。

### 3.1 焦点单测（验证 V4.4 边界）

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/quality.test.ts
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/quality-analytics.test.tsx components/reports/reports-page.test.tsx
```

期望：全部通过。

### 3.2 仓库 gate

```bash
scripts/ci-equivalent-check.sh
```

期望：所有 stage（`tsc -b`、`tsc -p scripts/tsconfig.json`、`next build`、
`eslint --max-warnings 0`、各 package `vitest run`、`git diff --check`）通过。
若本机默认 Node 不能加载 Rollup native module，按 `AGENTS.md` 指引设置
`NODE_BIN_DIR` 指向 Codex bundled Node。

### 3.3 文档检查

```bash
git diff --check
```

期望：无 whitespace 警告。

## 4. 风险与跟进

- **指标定义稳定性**：metric id 与 pattern id 一旦发布，下游会缓存 URL 与
  分享视图；后续要扩展时只追加，不重命名。
- **deterministic 分类**：当前规则按 `lastError.code` / `message` /
  `humanReviewChecklist` 等做关键字匹配，覆盖度受字段质量约束；如果未来
  runner 改变 error 字段语义，需要同步更新 `patterns.ts` 与
  `patterns.test.ts`。
- **观测视图局限**：V4.4 故意不提供「自动改写 workflow / skills」能力，所有
  改进路径走后续 V4.5。
- **本地 gate 不等价于 CI**：在缺少 corepack / pnpm 或 Rollup native
  binding 的开发环境，使用 `scripts/ci-equivalent-check.sh` 作为本地 gate；
  发布或合并仍需 CI 通过。
