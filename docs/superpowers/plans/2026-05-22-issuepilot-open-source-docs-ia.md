# IssuePilot Open Source Docs IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 IssuePilot 的开源入口重构成清晰、有截图、有启动路径、有 roadmap 的文档体系，同时保留内部 `docs/superpowers/*` 设计归档。

**Architecture:** 第一轮只改文档和截图资产，不改产品行为、dashboard UI、orchestrator API 或 roadmap 决策。公开入口变成 `README.*` + `docs/README.md` + `docs/getting-started.*.md` + `docs/roadmap.md`，内部设计 / plan / acceptance 继续放在 `docs/superpowers/`，但不再压在新读者第一层。

**Tech Stack:** Markdown、Git、IssuePilot dashboard、`scripts/demo/mock-orchestrator.mjs`、Next.js dev server、Codex Browser / Playwright 截图、`git diff --check`。

---

## Scope Check

本计划只实现：

- `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`

**In scope:**

- 新建公开文档中心：`docs/README.md`。
- 新建启动文档：`docs/getting-started.zh-CN.md`、`docs/getting-started.md`。
- 新建 roadmap：`docs/roadmap.md`。
- 新建截图目录并放入至少 2 张当前 TypeScript dashboard 真实截图。
- 重写 `README.md`、`README.zh-CN.md`、`README.en.md` 为开源项目入口。
- 给 `USAGE.md`、`USAGE.zh-CN.md` 顶部增加“不是首次启动入口”的定位说明。
- 在 `CHANGELOG.md` 记录 docs IA 的 design / plan / implementation。
- 跑 `git diff --check`。

**Out of scope:**

- 不引入 docs site 框架。
- 不拆完 `USAGE.*.md` 的所有深度章节。
- 不删除 `docs/superpowers/*`、`SPEC.md` 或 `elixir/`。
- 不改 dashboard 页面结构、组件样式或 API contract。
- 不用旧 `.github/media/elixir-screenshot.png` 或 Symphony prototype 图冒充当前产品截图。
- 不使用真实公司私有 GitLab 地址、token、用户名或项目名作为截图内容。

## Current Repo Facts

- `README.md` / `README.zh-CN.md` 当前是中文公开入口，`README.en.md` 是英文入口。
- `USAGE.md` / `USAGE.zh-CN.md` 当前是长用户手册；第一轮只加顶部定位，不整本拆分。
- 现有架构图和流程图：
  - `docs/superpowers/diagrams/v2-architecture.svg`
  - `docs/superpowers/diagrams/v2-flow.svg`
- 现有 dashboard mock server：
  - `scripts/demo/mock-orchestrator.mjs`
  - 支持 `/api/state`、`/api/runs`、`/api/runs/:id`、`/api/reports`、`/api/events`、`/api/events/stream`。
- dashboard dev 命令：
  - `NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm --filter @issuepilot/dashboard dev`
- mock server 中的 demo 数据已经使用 `gitlab.example.com`、`demo/web`、`~/.issuepilot/workspaces/demo-web/*`，适合公开截图。

## File Structure

- Create: `docs/README.md`
  - 公开 docs 导航中心，面向开源读者。
- Create: `docs/getting-started.zh-CN.md`
  - 中文启动文档，能独立指导本地源码启动、安装态启动和第一个 issue run。
- Create: `docs/getting-started.md`
  - 英文启动文档，与中文版本语义同步。
- Create: `docs/roadmap.md`
  - 开源 roadmap，承接 README 中的长路线图内容。
- Create: `docs/assets/screenshots/dashboard-command-center.png`
  - Command Center dashboard 截图，用于 README hero 和 docs 首页。
- Create: `docs/assets/screenshots/dashboard-run-detail.png`
  - Run Detail dashboard 截图，用于 Getting Started 和 README/docs。
- Modify: `README.md`
  - 中文默认开源首页，目标 220-320 行，不超过 350 行。
- Modify: `README.zh-CN.md`
  - 中文别名，与 `README.md` 语义同步。
- Modify: `README.en.md`
  - 英文开源首页，与中文 README 语义同步。
- Modify: `USAGE.md`
  - 顶部增加首次启动入口说明。
- Modify: `USAGE.zh-CN.md`
  - 顶部增加首次启动入口说明。
- Modify: `CHANGELOG.md`
  - 增加 Open Source Docs IA design / plan / implementation 记录。
- Modify: `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`
  - implementation 完成后把状态从 `待用户评审` 更新为 `实施完成`。

## Task 1: Plan Registration And Changelog

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`

- [ ] **Step 1: Verify branch hygiene**

Run:

```bash
git status --short --branch
```

Expected:

```text
## codex/docs-open-source-ia
```

If unrelated user changes appear, leave them untouched and only edit files listed in this plan.

- [ ] **Step 2: Add the docs IA changelog section**

Insert this section near the top of `CHANGELOG.md`, above V4.10:

```markdown
## [Unreleased] Open Source Docs IA（实施计划已提交）

### Design

- 2026-05-22 — 新增 IssuePilot Open Source Docs IA 设计：
  `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`。
  该设计把 README、启动文档、文档中心、roadmap、dashboard 截图和架构 / 流程图
  作为开源第一入口，同时保留 `docs/superpowers/*` 作为内部设计与验收归档。

### Plan

- 2026-05-22 — 新增 IssuePilot Open Source Docs IA 实施计划：
  `docs/superpowers/plans/2026-05-22-issuepilot-open-source-docs-ia.md`。
  计划按文档入口重构执行：先建立公开 docs 地图和启动文档，再用 mock orchestrator
  采集当前 dashboard 截图，随后重写 README 三语版本、降权 `USAGE.*.md` 并完成
  `git diff --check`。
```

- [ ] **Step 3: Update design spec status**

In `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`, change:

```markdown
状态：待用户评审
```

to:

```markdown
状态：实施计划已提交
```

- [ ] **Step 4: Verify doc hygiene**

Run:

```bash
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md
git commit -m "docs: register open source docs plan"
```

Expected: commit succeeds.

## Task 2: Public Docs Map

**Files:**

- Create: `docs/README.md`

- [ ] **Step 1: Create `docs/README.md`**

Create `docs/README.md` with this structure and content:

```markdown
# IssuePilot Docs

IssuePilot 是一个 local-first 的 GitLab Issue 驱动 AI engineering orchestrator。
如果你是第一次进入仓库，先从 Getting Started 开始；如果你想理解设计取舍，再进入
Internal Design Archive。

![IssuePilot Command Center](./assets/screenshots/dashboard-command-center.png)

## Start Here

| 目标 | 文档 |
| --- | --- |
| 5 分钟启动本地开发环境 | [Getting Started](./getting-started.zh-CN.md) |
| English quick start | [Getting Started](./getting-started.md) |
| 看当前能力和后续路线 | [Roadmap](./roadmap.md) |
| 查完整用户手册 | [USAGE.zh-CN.md](../USAGE.zh-CN.md) / [USAGE.md](../USAGE.md) |

## What IssuePilot Runs

IssuePilot 把一个 GitLab Issue 转成一个隔离的、可审查的 AI engineering run：

1. GitLab Issue 标记 `ai-ready`。
2. orchestrator claim issue 并创建 `~/.issuepilot` worktree。
3. Codex runner 在隔离 worktree 内执行任务。
4. IssuePilot 生成 branch、MR、handoff note 和 run report。
5. human reviewer 通过 `human-review` / `ai-rework` 决定下一步。
6. dashboard 展示 Command Center、Run Detail、Review Packet 和 Reports。

## Architecture And Flow

- [Architecture diagram](./superpowers/diagrams/v2-architecture.svg)
- [End-to-end flow diagram](./superpowers/diagrams/v2-flow.svg)

## Public Guides

| 文档 | 用途 |
| --- | --- |
| [Getting Started 中文](./getting-started.zh-CN.md) | 源码启动、安装态启动、第一个 workflow、第一个 issue run |
| [Getting Started English](./getting-started.md) | English version of the quick start |
| [Roadmap](./roadmap.md) | 当前成熟度、已完成能力、下一阶段 |
| [User Guide 中文](../USAGE.zh-CN.md) | 深度操作手册 |
| [User Guide English](../USAGE.md) | Full user guide |

## Internal Design Archive

`docs/superpowers/` 是 IssuePilot 的内部设计、计划、验收和 runbook 归档：

| 目录 | 角色 |
| --- | --- |
| `docs/superpowers/specs/` | 产品设计 spec 和 source-of-truth |
| `docs/superpowers/plans/` | 实施计划、验收记录、dog-food 记录 |
| `docs/superpowers/runbooks/` | 操作 runbook |
| `docs/superpowers/diagrams/` | 架构图和流程图 |

新读者不需要先阅读内部归档。贡献者在修改产品行为、workflow、runner、dashboard 或路线图时，
需要回到对应 spec / plan 保持事实同步。
```

- [ ] **Step 2: Verify screenshot reference is intentionally unresolved until Task 4**

Run:

```bash
rg -n "dashboard-command-center|v2-architecture|v2-flow" docs/README.md
```

Expected: output includes all three references.

- [ ] **Step 3: Commit Task 2**

Run:

```bash
git add docs/README.md
git commit -m "docs: add public docs map"
```

Expected: commit succeeds.

## Task 3: Getting Started Documents

**Files:**

- Create: `docs/getting-started.zh-CN.md`
- Create: `docs/getting-started.md`

- [ ] **Step 1: Create Chinese getting started**

Create `docs/getting-started.zh-CN.md` with these sections:

```markdown
# Getting Started

本页是第一次启动 IssuePilot 的最短路径。完整操作手册见
[USAGE.zh-CN.md](../USAGE.zh-CN.md)。

## 你会启动什么

- orchestrator：独立 Node daemon，默认 API 为 `http://127.0.0.1:4738`。
- dashboard：Next.js dashboard，用来查看 Command Center、run detail、review packet 和 reports。
- workspace：IssuePilot 在 `~/.issuepilot` 下维护 mirror、worktree、event logs 和 reports。

![Run Detail](./assets/screenshots/dashboard-run-detail.png)

## 环境要求

- Node.js `>=22 <23`
- pnpm `10.33.2`，通过 `corepack` 启用
- Git
- 可 push 的 GitLab 测试项目
- Codex CLI / Codex app-server 登录态

## 从源码启动

```bash
corepack enable
pnpm install
pnpm build
pnpm exec issuepilot doctor
```

启动 orchestrator：

```bash
pnpm dev:orchestrator
```

另开一个终端启动 dashboard：

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

打开 dashboard：

```text
http://localhost:3000
```

如果首页显示 Command Center，并且 service status 不是 error，dashboard 已连上 orchestrator。

## 安装本地 tarball

```bash
pnpm release:pack
npm install -g ./dist/release/issuepilot-*.tgz
issuepilot doctor
```

## 最小 WORKFLOW.md

在测试项目中创建 `.agents/workflow.md`：

```markdown
# IssuePilot Workflow

## Goal

Implement the GitLab Issue as a small, reviewable change.

## Rules

- Keep the change scoped to the issue.
- Run focused tests before handoff.
- Open a merge request and leave a concise handoff note.
```

## GitLab labels

至少准备这些 label：

```text
ai-ready
ai-running
human-review
ai-rework
ai-failed
ai-blocked
```

## 第一个 Issue run

1. 在 GitLab 测试项目创建一个小 Issue。
2. 添加 `ai-ready` label。
3. 确认 orchestrator 日志出现 claim / dispatch / handoff。
4. 在 dashboard 查看 run detail。
5. 在 MR 中检查 handoff note、validation、risk 和 next action。
6. 需要返工时，把 Issue 移到 `ai-rework`；可以合并时保留 `human-review` 给人工处理。

## 常见启动失败

| 症状 | 检查 |
| --- | --- |
| dashboard 显示 `GET /api/state failed` | 确认 `pnpm dev:orchestrator` 正在运行，`NEXT_PUBLIC_API_BASE` 指向 `http://127.0.0.1:4738` |
| GitLab 返回 401 / 403 | 确认 token 来自 `tracker.token_env` 指定的环境变量，不要写进 workflow 文件 |
| Codex runner 不可用 | 重新登录 Codex CLI / app-server，并运行 `issuepilot doctor` |
| 无法 push branch | 确认测试项目 remote、SSH key 和 GitLab 权限 |
| workspace 混乱 | 查看 `~/.issuepilot` 下对应 project / issue workspace 和 event logs |

## 下一步

- 阅读 [docs/README.md](./README.md) 了解文档地图。
- 阅读 [Roadmap](./roadmap.md) 了解当前成熟度。
- 阅读 [USAGE.zh-CN.md](../USAGE.zh-CN.md) 了解 team mode、review packet 和 operations。
```

- [ ] **Step 2: Create English getting started**

Create `docs/getting-started.md` with this content:

```markdown
# Getting Started

This page is the shortest path to running IssuePilot locally. For the full user
guide, see [USAGE.md](../USAGE.md).

## What You Will Start

- orchestrator: an independent Node daemon. The default API is `http://127.0.0.1:4738`.
- dashboard: a Next.js dashboard for Command Center, run detail, review packet and reports.
- workspace: IssuePilot keeps mirror repositories, worktrees, event logs and reports under `~/.issuepilot`.

![Run Detail](./assets/screenshots/dashboard-run-detail.png)

## Requirements

- Node.js `>=22 <23`
- pnpm `10.33.2`, enabled through `corepack`
- Git
- A GitLab test project you can push to
- Codex CLI / Codex app-server login state

## Start From Source

```bash
corepack enable
pnpm install
pnpm build
pnpm exec issuepilot doctor
```

Start the orchestrator:

```bash
pnpm dev:orchestrator
```

In another terminal, start the dashboard:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

Open the dashboard:

```text
http://localhost:3000
```

If the home page shows Command Center and the service status is not error, the dashboard is connected to the orchestrator.

## Install A Local Tarball

```bash
pnpm release:pack
npm install -g ./dist/release/issuepilot-*.tgz
issuepilot doctor
```

## Minimal WORKFLOW.md

Create `.agents/workflow.md` in your test project:

```markdown
# IssuePilot Workflow

## Goal

Implement the GitLab Issue as a small, reviewable change.

## Rules

- Keep the change scoped to the issue.
- Run focused tests before handoff.
- Open a merge request and leave a concise handoff note.
```

## GitLab Labels

Prepare at least these labels:

```text
ai-ready
ai-running
human-review
ai-rework
ai-failed
ai-blocked
```

## First Issue Run

1. Create a small Issue in your GitLab test project.
2. Add the `ai-ready` label.
3. Confirm the orchestrator logs show claim / dispatch / handoff.
4. Inspect the run detail page in the dashboard.
5. Inspect the handoff note, validation, risk and next action in the MR.
6. If rework is needed, move the Issue to `ai-rework`; if it can be merged, keep it in `human-review` for a human reviewer.

## Common Startup Failures

| Symptom | Check |
| --- | --- |
| dashboard shows `GET /api/state failed` | Confirm `pnpm dev:orchestrator` is running and `NEXT_PUBLIC_API_BASE` points to `http://127.0.0.1:4738` |
| GitLab returns 401 / 403 | Confirm the token comes from the environment variable configured by `tracker.token_env`; do not write tokens into workflow files |
| Codex runner is unavailable | Re-login to Codex CLI / app-server and run `issuepilot doctor` |
| branch push fails | Confirm the test project remote, SSH key and GitLab permissions |
| workspace state is confusing | Inspect the project / issue workspace and event logs under `~/.issuepilot` |

## Next Steps

- Read [docs/README.md](./README.md) for the documentation map.
- Read [Roadmap](./roadmap.md) for current maturity.
- Read [USAGE.md](../USAGE.md) for team mode, review packet and operations.
```

- [ ] **Step 3: Verify language sync**

Run:

```bash
rg -n "pnpm dev:orchestrator|pnpm dev:dashboard|ai-ready|dashboard-run-detail" docs/getting-started.zh-CN.md docs/getting-started.md
```

Expected: both files contain all four key references.

- [ ] **Step 4: Commit Task 3**

Run:

```bash
git add docs/getting-started.zh-CN.md docs/getting-started.md
git commit -m "docs: add getting started guides"
```

Expected: commit succeeds.

## Task 4: Roadmap And Diagrams

**Files:**

- Create: `docs/roadmap.md`

- [ ] **Step 1: Create roadmap**

Create `docs/roadmap.md` with this content:

```markdown
# IssuePilot Roadmap

IssuePilot 当前处在 local-first / team-machine pilot 阶段。它已经能把 GitLab Issue
转成隔离 worktree 内的 AI engineering run，并把 MR、review packet、quality analytics
和 review rework plan 带回给人工 reviewer。

## Current Status

| 阶段 | 状态 | 含义 |
| --- | --- | --- |
| P0 / V1 | 已完成 | 单机 GitLab Issue → worktree → runner → MR → human review 闭环 |
| V2 | 已完成 | team runtime、dashboard operations、CI feedback、review feedback sweep、workspace retention |
| V2.5 | 已完成 | Command Center，支持 list / board / review packet inspector |
| V4.1-V4.10 | 已完成 release lock | workflow spine、task graph、review packet evidence、quality analytics、improvement loop、多 agent 协作、runner adapter、第二 runner dog-food、智能 review workflow |
| V3 | 未开始 | production execution platform：RBAC、Postgres、多 worker、production sandbox、预算和 observability |

## Product Flow

![IssuePilot flow](./superpowers/diagrams/v2-flow.svg)

## Architecture

![IssuePilot architecture](./superpowers/diagrams/v2-architecture.svg)

## Completed Capabilities

- GitLab label-driven orchestration：`ai-ready`、`ai-running`、`human-review`、`ai-rework`、`ai-failed`、`ai-blocked`。
- `~/.issuepilot` workspace：mirror、worktree、event logs、reports。
- Codex app-server runner：本地隔离 cwd / sandbox 执行。
- Dashboard：Command Center、Run Detail、Work Items、Reports。
- Review Packet / Evidence：把 agent handoff、validation、risk、MR 和 evidence 汇总给 reviewer。
- Review feedback / rework plan：把人工 review comment 转成可审计返工计划。
- Runner adapter contract：runner kind、runner id、runner events 和 redaction trace。
- Quality analytics：从历史 run report 聚合失败模式和改进建议。

## Next: V4 Pilot Hardening

下一步不是直接进入 V3，而是用一个真实团队测试项目做 V4 pilot：

1. 用真实 GitLab issue 跑 single-project flow。
2. 用 dashboard 检查 Command Center、Run Detail、Review Packet 和 Reports。
3. 验证 `ai-rework` 能把 review feedback 带入下一轮 run。
4. 记录 blocker，特别是 Codex / Claude Code runner 登录态、workspace cleanup 和 MR handoff。
5. 决定 V3 production platform 的最小边界。

## Deferred To V3

- 多租户 SaaS。
- RBAC / SSO。
- Postgres 持久化。
- 多 worker 调度。
- production sandbox。
- budget / quota。
- OpenTelemetry 和长期指标。
- 自动 merge。

## Source Of Truth

- IssuePilot 总设计 spec：`docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- V4 intelligent workbench spec：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- V4.10 release lock acceptance：`docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
```

- [ ] **Step 2: Verify roadmap links**

Run:

```bash
rg -n "v2-flow|v2-architecture|V4.10|V3" docs/roadmap.md
```

Expected: output includes all four references.

- [ ] **Step 3: Commit Task 4**

Run:

```bash
git add docs/roadmap.md
git commit -m "docs: add open source roadmap"
```

Expected: commit succeeds.

## Task 5: Dashboard Screenshots

**Files:**

- Create: `docs/assets/screenshots/dashboard-command-center.png`
- Create: `docs/assets/screenshots/dashboard-run-detail.png`

- [ ] **Step 1: Start mock orchestrator**

Run:

```bash
node scripts/demo/mock-orchestrator.mjs
```

Expected output:

```text
IssuePilot V2.5 mock orchestrator ready: http://127.0.0.1:4738
```

Leave this process running until screenshot capture is complete.

- [ ] **Step 2: Start dashboard**

In a second terminal, run:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm --filter @issuepilot/dashboard dev
```

Expected: Next.js dev server starts, usually at `http://localhost:3000`.

- [ ] **Step 3: Create screenshot directory**

Run:

```bash
mkdir -p docs/assets/screenshots
```

- [ ] **Step 4: Capture Command Center**

Use Codex Browser or Playwright with viewport `1440x1100`.

Open:

```text
http://localhost:3000
```

Capture:

```text
docs/assets/screenshots/dashboard-command-center.png
```

Visual requirements:

- The screenshot shows the dashboard shell and `Command Center` heading.
- At least one run row is visible.
- No real GitLab host, token, username or private project appears.
- The content uses demo values such as `gitlab.example.com` and `demo/web`.

- [ ] **Step 5: Capture Run Detail**

Open:

```text
http://localhost:3000/runs/run-101
```

Capture:

```text
docs/assets/screenshots/dashboard-run-detail.png
```

Visual requirements:

- The screenshot shows issue `#101` or run `run-101`.
- Timeline / events and logs are visible.
- MR link uses `gitlab.example.com`.
- No private data appears.

- [ ] **Step 6: Verify image files exist**

Run:

```bash
file docs/assets/screenshots/dashboard-command-center.png docs/assets/screenshots/dashboard-run-detail.png
```

Expected: both files report `PNG image data`.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add docs/assets/screenshots/dashboard-command-center.png docs/assets/screenshots/dashboard-run-detail.png
git commit -m "docs: add dashboard screenshots"
```

Expected: commit succeeds.

## Task 6: README Rewrite

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`

- [ ] **Step 1: Rewrite Chinese README**

Replace `README.md` with a concise Chinese open-source homepage using this structure:

```markdown
# IssuePilot

IssuePilot 把 GitLab Issues 转成隔离的、可审查的 AI engineering runs。团队不需要盯着
agent 会话，而是通过 Issue、MR、Review Packet 和 dashboard 管理交付。

[快速启动](./docs/getting-started.zh-CN.md) · [文档中心](./docs/README.md) · [Roadmap](./docs/roadmap.md)

![IssuePilot Command Center](./docs/assets/screenshots/dashboard-command-center.png)

## 为什么需要 IssuePilot

AI coding agent 的难点不是“能不能写代码”，而是团队怎样安全地分派、隔离、审查和返工。
IssuePilot 把这些动作放回工程团队已经熟悉的 GitLab Issue / MR 流程里。

## 工作方式

1. 给 GitLab Issue 添加 `ai-ready`。
2. orchestrator claim issue，并在 `~/.issuepilot` 创建隔离 worktree。
3. runner 在 worktree 内执行任务。
4. IssuePilot 创建 branch / MR / handoff note / run report。
5. dashboard 展示 Command Center、Run Detail、Review Packet 和 Reports。
6. 人工 reviewer 决定 merge、`ai-rework`、`ai-blocked` 或 `ai-failed`。

![IssuePilot Run Detail](./docs/assets/screenshots/dashboard-run-detail.png)

## 核心能力

- GitLab label-driven orchestration。
- local-first workspace isolation。
- Codex app-server runner。
- dashboard Command Center。
- MR handoff note。
- Review Packet / Evidence。
- Review feedback → rework plan。
- Quality analytics 和 improvement loop。
- Runner adapter contract，支持 runner kind / provenance / redaction trace。

## 当前成熟度

| 阶段 | 状态 |
| --- | --- |
| P0 / V1 | 单机闭环已完成 |
| V2 / V2.5 | team runtime 和 Command Center 已完成 |
| V4.1-V4.10 | intelligent workbench 已完成 release lock |
| V3 | production execution platform 尚未开始 |

IssuePilot 当前适合本地开发、团队机器试点和内部 dog-food；它还不是 SaaS，也不会自动 merge MR。

## 快速启动

```bash
corepack enable
pnpm install
pnpm build
pnpm exec issuepilot doctor
pnpm dev:orchestrator
```

另开一个终端：

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

完整步骤见 [Getting Started](./docs/getting-started.zh-CN.md)。

## 文档

- [文档中心](./docs/README.md)
- [Getting Started 中文](./docs/getting-started.zh-CN.md)
- [Getting Started English](./docs/getting-started.md)
- [Roadmap](./docs/roadmap.md)
- [用户手册中文](./USAGE.zh-CN.md)
- [User Guide English](./USAGE.md)
- [架构图](./docs/superpowers/diagrams/v2-architecture.svg)
- [端到端流程图](./docs/superpowers/diagrams/v2-flow.svg)

## 开发与验证

文档变更至少运行：

```bash
git diff --check
```

涉及代码时优先运行：

```bash
SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

## License

见仓库 license 文件。
```

- [ ] **Step 2: Sync `README.zh-CN.md`**

Copy the same Chinese content into `README.zh-CN.md`.

- [ ] **Step 3: Rewrite English README**

Replace `README.en.md` with:

```markdown
# IssuePilot

IssuePilot turns GitLab Issues into isolated, reviewable AI engineering runs.
Teams should not have to supervise agent chat sessions directly; they should manage delivery through Issues, MRs, Review Packets and a dashboard.

[Get started](./docs/getting-started.md) · [Docs](./docs/README.md) · [Roadmap](./docs/roadmap.md)

![IssuePilot Command Center](./docs/assets/screenshots/dashboard-command-center.png)

## Why IssuePilot

The hard part of AI coding agents is not only whether they can write code. The hard part is how a team assigns work, isolates execution, reviews output and sends precise rework back through an existing engineering workflow.
IssuePilot puts those controls back into GitLab Issues and Merge Requests.

## How It Works

1. Add `ai-ready` to a GitLab Issue.
2. The orchestrator claims the issue and creates an isolated worktree under `~/.issuepilot`.
3. A runner executes inside that worktree.
4. IssuePilot creates a branch, MR, handoff note and run report.
5. The dashboard shows Command Center, Run Detail, Review Packet and Reports.
6. A human reviewer decides whether to merge, move to `ai-rework`, mark `ai-blocked` or mark `ai-failed`.

![IssuePilot Run Detail](./docs/assets/screenshots/dashboard-run-detail.png)

## Core Capabilities

- GitLab label-driven orchestration.
- local-first workspace isolation.
- Codex app-server runner.
- dashboard Command Center.
- MR handoff note.
- Review Packet / Evidence.
- Review feedback to rework plan.
- Quality analytics and improvement loop.
- Runner adapter contract with runner kind, provenance and redaction trace.

## Current Maturity

| Phase | Status |
| --- | --- |
| P0 / V1 | single-machine loop complete |
| V2 / V2.5 | team runtime and Command Center complete |
| V4.1-V4.10 | intelligent workbench release lock complete |
| V3 | production execution platform not started |

IssuePilot is currently suitable for local development, team-machine pilots and internal dog-food. It is not a SaaS product and it does not automatically merge MRs.

## Quick Start

```bash
corepack enable
pnpm install
pnpm build
pnpm exec issuepilot doctor
pnpm dev:orchestrator
```

In another terminal:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

For the full path, see [Getting Started](./docs/getting-started.md).

## Documentation

- [Docs home](./docs/README.md)
- [Getting Started 中文](./docs/getting-started.zh-CN.md)
- [Getting Started English](./docs/getting-started.md)
- [Roadmap](./docs/roadmap.md)
- [用户手册中文](./USAGE.zh-CN.md)
- [User Guide English](./USAGE.md)
- [Architecture diagram](./docs/superpowers/diagrams/v2-architecture.svg)
- [End-to-end flow diagram](./docs/superpowers/diagrams/v2-flow.svg)

## Development And Verification

For docs-only changes, run:

```bash
git diff --check
```

For code changes, prefer:

```bash
SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

## License

See the repository license file.
```

- [ ] **Step 4: Verify README size and sync**

Run:

```bash
wc -l README.md README.zh-CN.md README.en.md
rg -n "dashboard-command-center|dashboard-run-detail|docs/roadmap|v2-architecture|v2-flow" README.md README.zh-CN.md README.en.md
```

Expected:

- each README is under 350 lines.
- all three files reference the two screenshots.
- all three files link roadmap, architecture diagram and flow diagram.

- [ ] **Step 5: Commit Task 6**

Run:

```bash
git add README.md README.zh-CN.md README.en.md
git commit -m "docs: rewrite readme open source entry"
```

Expected: commit succeeds.

## Task 7: USAGE Positioning

**Files:**

- Modify: `USAGE.md`
- Modify: `USAGE.zh-CN.md`

- [ ] **Step 1: Add Chinese USAGE notice**

At the top of `USAGE.zh-CN.md`, after the title, add:

```markdown
> 第一次启动 IssuePilot？请先阅读
> [docs/getting-started.zh-CN.md](./docs/getting-started.zh-CN.md)。
> 本文件是完整用户手册，包含 single-project、team mode、dashboard operations、
> review packet、quality analytics 和 troubleshooting 等深度内容。
```

- [ ] **Step 2: Add English USAGE notice**

At the top of `USAGE.md`, after the title, add:

```markdown
> New to IssuePilot? Start with
> [docs/getting-started.md](./docs/getting-started.md).
> This file is the full user guide, covering single-project mode, team mode,
> dashboard operations, review packets, quality analytics and troubleshooting.
```

- [ ] **Step 3: Verify notices**

Run:

```bash
rg -n "getting-started|full user guide|完整用户手册" USAGE.md USAGE.zh-CN.md
```

Expected: both files contain the new notice.

- [ ] **Step 4: Commit Task 7**

Run:

```bash
git add USAGE.md USAGE.zh-CN.md
git commit -m "docs: clarify usage guide entry"
```

Expected: commit succeeds.

## Task 8: Final Acceptance

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`

- [ ] **Step 1: Mark design spec complete**

In `docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md`, change:

```markdown
状态：实施计划已提交
```

to:

```markdown
状态：实施完成
```

- [ ] **Step 2: Add changelog implementation entry**

Under `## [Unreleased] Open Source Docs IA（实施计划已提交）`, change the heading to:

```markdown
## [Unreleased] Open Source Docs IA（实施完成）
```

Add:

```markdown
### Added

- 2026-05-22 — 完成第一轮开源文档入口重构：新增 `docs/README.md`、
  `docs/getting-started.zh-CN.md`、`docs/getting-started.md`、`docs/roadmap.md`
  和 `docs/assets/screenshots/` dashboard 截图；README 三语版本收敛为短开源首页，
  `USAGE.*.md` 顶部增加首次启动入口说明，并从 README / docs 明确链接架构图与端到端流程图。
```

- [ ] **Step 3: Run final doc checks**

Run:

```bash
git diff --check
wc -l README.md README.zh-CN.md README.en.md
file docs/assets/screenshots/dashboard-command-center.png docs/assets/screenshots/dashboard-run-detail.png
rg -n "dashboard-command-center|dashboard-run-detail|v2-architecture|v2-flow|getting-started" README.md README.zh-CN.md README.en.md docs/README.md docs/getting-started.zh-CN.md docs/getting-started.md docs/roadmap.md USAGE.md USAGE.zh-CN.md
```

Expected:

- `git diff --check` has no output.
- each README remains under 350 lines.
- both screenshot files are PNG images.
- all required references are present.

- [ ] **Step 4: Commit Task 8**

Run:

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-05-22-issuepilot-open-source-docs-ia-design.md
git commit -m "docs: complete open source docs acceptance"
```

Expected: commit succeeds.

## Self-Review Checklist

- `README.md` and `README.zh-CN.md` are semantically identical.
- `README.en.md` matches the Chinese README section-for-section.
- `docs/getting-started.zh-CN.md` and `docs/getting-started.md` are semantically synced.
- `docs/README.md` makes `docs/superpowers/*` an internal archive, not a first-run path.
- `docs/roadmap.md` explains maturity by capability domain, not commit-by-commit history.
- At least two current dashboard screenshots exist in `docs/assets/screenshots/`.
- No screenshot contains private GitLab hostnames, tokens, usernames or company project names.
- README / docs link both `v2-architecture.svg` and `v2-flow.svg`.
- `USAGE.*.md` clearly points first-time users to Getting Started.
- `git diff --check` passes.
