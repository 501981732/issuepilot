# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

> 开发项目管理常常需要监督编码代理：盯任务进度、催 PR、查 CI 状态、来回手动
> 协调验收，效率被切碎在一次次"代理报告进度"上。
>
> **IssuePilot 把项目工作转化为隔离的自主实现 run，让团队回到管理工作本身，
> 而不是监督编码代理。** 每个 GitLab Issue 都会被转成一次有边界的 run：独立
> worktree、独立 prompt、独立事件流、可审计的工作证明，最终以 Merge Request
> 的形式交付给人工 Review，而不是让工程师在每一轮 agent 对话里轮值。

IssuePilot 是一个开源的本地 AI 工程调度器，用 GitLab Issue 驱动 Codex
实现工作。

它会监听 GitLab Issue，通过 label 认领任务，创建隔离的 git worktree，
通过 app-server 协议运行 Codex，记录可审计事件轨迹，并把结果以 Merge
Request 的形式交给人工 Review；人工 merge 该 MR 后，IssuePilot 会自动关闭
对应的 GitLab Issue。

## 产品定位

IssuePilot 的定位是和 Harness Engineer 互补的研发流程层。有 Harness Engineer
的项目里，Harness Engineer 继续负责仓库内的工程规则、代码约束、验证矩阵、
实现纪律和局部执行质量；IssuePilot 负责跨 Issue / 多 run 的流程编排、状态
管理、报告、证据、review feedback 和持续改进闭环。

没有 Harness Engineer 的项目也可以直接使用 IssuePilot。此时
`issuepilot-config/`、workflow profile、repo-local rules 和 skills 构成最小
工程约束层，IssuePilot 仍然提供任务拆解、编排、Review Packet 和可审计证据。

### 核心亮点

- **Issue 驱动的工作认领**：监听 GitLab Issue 看板，自动认领带 `ai-ready`
  label 的 Issue 并生成隔离 run，工程师无需逐条派发。
- **完整的工作证明**：每次 run 输出 CI 状态、MR 描述与 review 链接、reconciliation
  事件流、JSONL event store 与 dashboard timeline，关键节点可追溯、可回放。
- **可信交付边界**：失败 / 阻塞自动落到 `ai-failed` / `ai-blocked`，workspace
  与日志原地保留供取证；secret 不会泄露到日志、事件、API 响应或 prompt。
- **人工 Review 后自动收尾**：IssuePilot 不自动 merge 代码；人类 merge 生成的
  MR 后，daemon 会写 final note、移除 `human-review`，并关闭 GitLab Issue。
- **零手工 token 维护**：内置 `issuepilot auth login` 走 GitLab OAuth 2.0
  Device Flow，token 加密存放在 `~/.issuepilot/credentials`（`0600`）并自动
  refresh；遇到 401 daemon 静默换发新 token 并重试一次。仍兼容 PAT/Group Token
  via `tracker.token_env` 的环境变量路径。
- **本地单机闭环**:`~/.issuepilot` 下落盘的 worktree + JSONL + run record，
  daemon 重启可恢复 reconciliation，不依赖外部数据库。
- **与 Harness Engineer 互补**：既能和已有 Harness Engineer 的成熟项目配合，
  也能作为没有 Harness Engineer 项目的本地流程平台直接使用。
- **公开 SPEC + 参考实现**:`SPEC.md` 与 Symphony Elixir 参考实现保留在仓库
  内，便于团队按需要自建其他语言版本。

本项目起源于 OpenAI Symphony 的 fork。当前产品方向是 TypeScript 优先、
GitLab 优先；原 Symphony spec 和 Elixir 实现仍保留在仓库中，作为参考材料。

> [!WARNING]
> IssuePilot 已闭合 P0 本地闭环、锁定 V1 本地 tarball，并将 V2 Phase 1–5
> （团队模式、dashboard retry/stop/archive、CI 自动回流、review feedback
> sweep、workspace retention）全部合入 `main`。release tag、真实 smoke
> evidence 归档以及本地 API / CLI 的稳定兼容窗口仍在锁定中；V2 team
> daemon 暂未自动开启 workspace cleanup loop——具体见下文 V2 路线图中
> 的 Phase 5 follow-up。

## 为什么需要 IssuePilot？

Coding agent 最适合从工程师已经在管理的工作单元开始执行。IssuePilot 把
Issue Tracker 当作控制平面：

- 工程师在 GitLab Issue 中描述工作。
- label 表达状态：ready、running、review、rework、failed、blocked。
- 每次运行都发生在 `~/.issuepilot` 下独立的 worktree 中。
- Codex 收到有边界的 prompt，并被限制在当前 workspace 内。
- orchestrator 写入事件、日志、Issue note、分支和 Merge Request。
- 人类 Review MR，而不是盯着每一轮 agent 会话。
- MR 被人工 merge 后，IssuePilot 会把 GitLab Issue reconcile 到 closed 终态。

P0 的目标是跑通本地单机闭环，不是提供托管的多租户服务。

## 与 OpenAI Symphony 的异同

IssuePilot 起源于 OpenAI Symphony 的 fork，因此 **整体架构思路是一脉相承
的**：都把 Issue Tracker 当作控制平面、都用 per-issue workspace 隔离 agent、
都通过 Codex app-server 协议执行实现工作、都把工作流策略以仓库内文件的形式
做版本化、都通过 ticket / 文件系统驱动重启恢复，而不是依赖外部数据库。

差异主要发生在**目标场景**与**实现选择**：

| 维度          | OpenAI Symphony（参考实现，Elixir）              | IssuePilot（本仓库的产品方向）                                                  |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 定位          | 公开的 prototype，鼓励 fork 自建加固版           | 公司内部的 P0 生产方向，目标是落地到内部工程团队日常使用                        |
| Issue Tracker | Linear                                           | GitLab（Group Access Token / Personal Token，本地 SaaS / Self-managed 都支持）  |
| 状态机表达    | 基于 Linear issue **status**（state-based）      | 基于 GitLab **label**（`ai-ready` / `ai-running` / `human-review` / …）         |
| 工作流契约    | `WORKFLOW.md`（仓库根）                          | `WORKFLOW.md`（YAML front matter + Markdown prompt）                            |
| 实现语言      | Elixir / OTP                                     | TypeScript / Node.js 22 LTS                                                     |
| 运行形态      | 单进程 Elixir 服务 + 可选 status surface         | orchestrator（Fastify daemon）+ 只读 Next.js dashboard（Tailwind/shadcn）       |
| 工作区策略    | 每 Issue 独立 workspace                          | bare mirror + git worktree（`~/.issuepilot/{repos,workspaces,state}`）          |
| 事件 / 日志   | 结构化日志 + 可选 status surface                 | JSONL event store + 原子 run record + SSE 实时流 + pino structured logging      |
| MR/PR 处理    | 由 agent 通过 workflow 内的 tools 自行 push / 写 | adapter 直接 push / 创建 MR，并提供 orchestrator post-run reconciliation 兜底   |
| 重启恢复      | tracker + 文件系统驱动                           | label 状态 + handoff note marker（`<!-- issuepilot:run:<runId> -->`）驱动       |
| 安全姿态      | 实现自行声明 trust posture                       | 拒绝 `danger-full-access` sandbox、token 全链路 redact、Codex cwd 限定 worktree |
| 公开 SPEC     | `SPEC.md` v1 (language-agnostic)                 | `SPEC.md` 保留为参考；产品 spec 见 `docs/superpowers/specs/`                    |
| 当前状态      | 评估用 prototype，建议自行加固后使用             | V1 本地试点可用，release lock 仍待 evidence / tag 归档                          |

如果你需要的是 Linear + Elixir 路线的参考实现，请直接看
[`elixir/`](elixir/README.md) 与 [`SPEC.md`](SPEC.md)。如果你需要的是
GitLab + TypeScript 路线、并打算在内部团队范围内试运行，那么本仓库根目录
的 IssuePilot 实现就是你要的版本。

## 当前状态

本仓库已经实现：

- 基于 pnpm、Turborepo、Vitest、ESLint、Prettier 的 TypeScript monorepo。
- workflow 解析、校验、默认值、环境变量检查和 prompt 渲染。
- GitLab issue、label、note、Merge Request、pipeline adapter 边界。
- 通过 `execa` 调用真实 `git` 命令的 workspace 管理。
- Codex app-server JSON-RPC client 组件和动态 GitLab tool 契约。
- observability 基础能力：redaction、event bus、event store、run store、logger。
- orchestrator 模块：claim、dispatch、retry、reconcile、runtime state、HTTP API、
  SSE、CLI scaffold。
- human-review reconciliation：MR 仍 open 时保持 Review，MR merged 后关闭
  Issue，MR closed 但未 merge 时回流到配置的 rework label。
- 只读 dashboard：overview、run detail、SSE 刷新、timeline、tool calls 和 log tail
  展示。
- V2.5 Command Center：Linear 风格的 List / Board 首页，运行详情页的 Review
  Packet（handoff + checks + merge readiness），以及 `/reports` 聚合页用
  来呈现本地报告产物。
- V2.6 dashboard shell + 布局重构：把常驻的左侧 sidebar 换成 sticky
  **顶部水平导航栏**（logo + 主导航 + locale / theme / mode tag 工具区，
  并提供 `跳到主内容` 跳转链接），让 1280–1440px 笔记本上的 board 视图
  6 栏不再被压成 x-overflow。Command Center 改用 **混合 inspector**：list
  视图保留 split-pane Review Packet，但只在选中 run 时才占位；board 视图
  把 Review Packet 收成按需弹出的右侧 **Sheet** 抽屉（Esc / 点遮罩 /
  ✕ 关闭，关闭后焦点恢复，自动遵循 `prefers-reduced-motion`）。原本 5
  张大 KPI 卡片折叠成单卡的 **横向 stacked health bar** + 5 列紧凑数字 chip。
- Swiss Modernism 2.0 设计系统：light + dark 两套 HSL design tokens、
  Fira Sans / Fira Code 字体、顶部导航壳 + 主题切换、语义化
  `StatusDot` / `StatusPill`（颜色 + 文字 + 圆点），以及 reports 页用
  纯 SVG 渲染的 sparkline / mini-bar / donut 图表（零图表库依赖）。
- dashboard 中英双语 i18n：`next-intl` 驱动，cookie `issuepilot-locale`
  控制 locale，顶部工具区提供 EN / 中 toggle，message catalog
  （`apps/dashboard/i18n/messages/{en,zh}.json`）按 surface 分 namespace。
  状态码与产品名按 IssuePilot AGENTS 规则保持英文 —
  `running` / `retrying` / `completed` / `failed` / `blocked` /
  `human-review` / `ai-ready` / `ai-running` / `ai-rework` / `ai-failed` /
  `ai-blocked` / `ready` / `not-ready` / `unknown` / `success` 与
  `IssuePilot` / `Codex` / `GitLab` / `MR` / `Workflow` / `Workspace` /
  `Review Packet` / run id / branch / path / cmd 等技术名词都不翻译，
  其它描述性 UI 文案在两种语言间切换。服务端 (`getTranslations`) 与
  客户端 (`useTranslations`) 都已接入，locale toggle 通过
  `window.location.reload()` 触发完整刷新，确保 SSR 立即读到新的
  cookie。
- 端到端测试 harness（`tests/e2e`）：内置带状态的 fake GitLab + 可脚本化的 fake
  Codex app-server，覆盖 happy path、retry 路径（`turn/timeout` → ai-failed
  耗尽 `max_attempts`）、failure 路径（`turn/failed` → ai-failed + 结构化
  failure note）、permission/escalation 路径（claim 401/403 → ai-blocked +
  结构化 blocked note + `claim_failed` 事件）和 approval 自动批准路径。
  happy path 同时覆盖人工 merge MR 后写入结构化 closing note 并自动关闭 Issue。
- 真实 GitLab smoke runbook + `pnpm smoke` wrapper：拉起 orchestrator、轮询
  `/api/state` 至 ready、打印 API + dashboard URL、转发 SIGINT/SIGTERM 并在 5s
  内升级 SIGKILL 兜底。

当前 V1 进度：

- V1 本地 CLI 打包已经可通过 `pnpm release:pack` 生成；生成的 tarball 会安装
  `issuepilot` 可执行命令，供本地试点使用。
- `pnpm release:check` 已通过，覆盖 format、lint、typecheck、build、unit
  tests、fake E2E、安装态 smoke、smoke runner 和 `git diff --check`。
- 安装态 `issuepilot --version`、`issuepilot doctor`、`issuepilot validate`、
  `issuepilot run` 与 `issuepilot dashboard` 已完成本机验证。
- 真实 GitLab smoke 已由操作者确认通过；Issue / MR / dashboard evidence 链接待归档。
- 当前仍是本地 tarball release，还不是发布到 npm registry 的公开包。

## 工作方式

```text
GitLab issue 带 ai-ready label
  -> IssuePilot 用 ai-running 认领
  -> IssuePilot 创建或复用隔离 worktree
  -> Codex app-server 在该 worktree 内运行
  -> 代码被 commit 并 push 到分支
  -> GitLab Merge Request 被创建或更新
  -> Issue 收到 handoff note
  -> label 切换到 human-review、ai-failed 或 ai-blocked
  -> 人工 Review 并手动 merge MR
  -> IssuePilot 写 closing note，移除 human-review，并关闭 Issue
```

P0 labels：

| Label          | 含义                                                     |
| -------------- | -------------------------------------------------------- |
| `ai-ready`     | IssuePilot 可以拾取的候选 Issue。                        |
| `ai-running`   | 已认领，并且有活跃 run。                                 |
| `human-review` | MR 已准备好等待人工 Review。                             |
| `ai-rework`    | 人工 Review 后要求 AI 再跑一轮，或 MR 被关闭但未 merge。 |
| `ai-failed`    | 运行失败，需要人工介入。                                 |
| `ai-blocked`   | 缺少信息、权限或 secret。                                |

## 仓库结构

```text
apps/
  orchestrator/                  本地 daemon、CLI、HTTP API 和 run loop
  dashboard/                     只读 Next.js dashboard

packages/
  core/                          共享领域基础类型
  workflow/                      WORKFLOW.md parser 和 renderer
  tracker-gitlab/                GitLab issue、label、note、MR、pipeline adapter
  workspace/                     mirror、worktree、branch、hook、cleanup 逻辑
  runner-codex-app-server/       Codex app-server JSON-RPC 集成
  observability/                 redaction、events、run store、logging
  shared-contracts/              orchestrator 和 dashboard 共享类型

docs/superpowers/
  specs/                         产品和架构 spec
  plans/                         实现计划

elixir/                          原 Symphony 参考实现
SPEC.md                          原 Symphony 语言无关 spec
```

## 快速开始

> 详细步骤见 **[使用指南（中文）](USAGE.zh-CN.md)**，以下是最短路径。

**第一步：构建并安装本地 V1 包**

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
```

**第二步：检查本机环境**

```bash
issuepilot doctor
```

期望全部 `[OK]`：Node.js ≥22、git、codex app-server、`~/.issuepilot/state` 可写。

**第三步：在目标项目里创建 `WORKFLOW.md`**

拷贝 [`.agents/workflow.example.md`](.agents/workflow.example.md) 到目标项目的 `WORKFLOW.md`，把 `gitlab.example.com`、`group/project` 等占位符替换成实际值，并 commit 推送。

**第四步：验证 workflow 配置**

```bash
export GITLAB_TOKEN="<your-token>"
issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
```

**第五步：启动 daemon + dashboard**

```bash
# 终端 A — 启动 orchestrator（自动等 ready 后打印 API / Dashboard URL）
issuepilot run --workflow /path/to/target-project/WORKFLOW.md

# 终端 B — 启动 dashboard
issuepilot dashboard
```

打开 `http://localhost:3000`，给目标项目的某个 Issue 打上 `ai-ready` label，IssuePilot 即自动接管。

---

## 环境要求

- Node.js `>=22 <23`
- pnpm `10.x`
- Git
- 真实运行需要 GitLab project 和 token
- 真实运行需要支持 app-server 的 Codex

根目录 `.npmrc` 开启了严格 engine 检查。

## 开发设置

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

常用命令：

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm release:check
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test
```

贡献者开发时，也可以继续从 workspace 根目录运行 CLI：

```bash
pnpm build
pnpm exec issuepilot doctor
pnpm exec issuepilot validate --workflow path/to/workflow.md
```

## Workflow 文件

IssuePilot 期望每个目标仓库提供一个 agent 契约文件：

```text
WORKFLOW.md
```

该文件由两部分组成：YAML front matter 作为机器可读配置，Markdown body
作为传给 agent 的 prompt。

最小结构：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels: ["ai-ready", "ai-rework"]
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

workspace:
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  repo_cache_root: "~/.issuepilot/repos"

git:
  repo_url: "git@gitlab.example.com:group/project.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 10
  max_attempts: 2
  retry_backoff_ms: 30000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 10000
---

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

{{ issue.description }}
```

secret 从 `tracker.token_env` 指定的环境变量读取，不能提交到 workflow 文件中。

## 安全模型

IssuePilot 面向可信本地开发环境。

P0 的重要边界：

- GitLab token 从环境变量读取。
- 类 token 值在写入日志、事件、store 或 API response 前会被 redacted。
- Codex 使用 workflow 定义的 sandbox，但 workflow 文件不能请求
  `danger-full-access` 或 `dangerFullAccess`。
- Codex 的工作目录限制在当前 Issue worktree 内。
- 失败 run 会保留 workspace 数据和 event logs，便于排障。

合并前仍然需要 Review 生成的代码。IssuePilot 创建的是可 Review 的 Merge
Request，不替代代码审查。

## Roadmap

下面是 IssuePilot 的版本路线图。完整内容以
[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
§20 为准；本节只做摘要，便于先快速判断"现在能用到什么、未来会扩到哪里"。

当前路线原则：**先把本地版 / 团队机器版的研发流程能力打磨到足够完备，再做生产可用版本**。
登录、权限、预算、生产部署、集中存储、审计和观测等生产环境因素统一后置到 V3；
V4 优先在现有 V2.x runtime 上补齐流程智能和体验闭环。

### P0 — 本地单机闭环（已闭合）

已完成本地单机闭环：

- ✅ 本地 daemon（orchestrator）+ Fastify HTTP API + SSE。
- ✅ GitLab Issue label 驱动的状态机（`ai-ready` → `ai-running` →
  `human-review` / `ai-failed` / `ai-blocked` / `ai-rework`）。
- ✅ Codex app-server runner（thread/turn 生命周期 + 14 类标准化事件）。
- ✅ bare mirror + git worktree workspace，失败 run 现场保留。
- ✅ MR 自动创建/更新 + 带 marker 的结构化 handoff note 恢复机制。
- ✅ 结构化 failure / blocked note：包含状态、run、branch、原因和下一步动作。
- ✅ human-review 自动收尾：人工 merge MR 后关闭 GitLab Issue；MR closed 但
  未 merge 时回流到配置的 rework label。
- ✅ 结构化 closing note：IssuePilot 移除 `human-review` 并关闭 Issue 时写入。
- ✅ 只读 Next.js dashboard（overview + run detail + SSE timeline）。
- ✅ fake GitLab + fake Codex 全闭环 E2E + 真实 GitLab smoke runbook。
- ✅ 可安装本地 CLI tarball，支持安装态 `issuepilot run` 与
  `issuepilot dashboard` 启动路径。
- ✅ `pnpm release:check` 作为 release evidence 门禁。
- ✅ 真实 GitLab smoke 已由操作者确认通过，固定 evidence 链接待归档。
- ✅ source-checkout 方式继续作为贡献者开发和紧急回滚路径保留。

### V1 — 稳定本地发布

目标：不改变单机执行模型，把当前闭环变成可安装、可重复、适合内部试点团队使用
的稳定版本。

- ✅ 通过 npm-compatible package tooling 提供可安装 CLI 分发，安装后暴露
  `issuepilot` 可执行命令。
- ✅ 安装后的本地启动路径：`issuepilot run --workflow ...` 启动 daemon/API，并提供
  已安装的 dashboard 启动命令。
- ✅ release gate 组合单测、fake E2E、smoke wrapper、安装态 CLI smoke 和
  `git diff --check`。
- ✅ 安装态 daemon / dashboard 启动路径和真实 GitLab smoke 已通过本地试点验证。
- ✅ auth refresh、token rotation、日志脱敏、failed / blocked run 排障的运维文档。
- 🚧 版本化 tag，包含 release notes、回滚说明和本地闭环兼容性预期。
- 🚧 本地闭环所需的 workflow schema、event contract、CLI 命令和 dashboard API
  稳定下来。
- ✅ source-checkout 继续作为贡献者开发和紧急回滚路径保留。

### V2 — 团队可运营版本

目标：从"个人单机"升级到"团队共享"，能在内网或团队机器上跑日常工作。

状态：**V2 Phase 1–5 已全部合入 `main`。** 一台 daemon 可以同时管理多个
GitLab 项目，dashboard 提供 retry / stop / archive，orchestrator 自动处理
CI 回流、review feedback 与 workspace 清理。视觉版本：

- 架构图：[`docs/superpowers/diagrams/v2-architecture.svg`](docs/superpowers/diagrams/v2-architecture.svg)
- 端到端流程图：[`docs/superpowers/diagrams/v2-flow.svg`](docs/superpowers/diagrams/v2-flow.svg)
- V2 总设计与逐 Phase 进度：[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- 团队模式上手：[`USAGE.zh-CN.md` — Part 5](USAGE.zh-CN.md#part-5--v2-团队模式共享机器--多项目)

- ✅ Phase 1 — Team Runtime Foundation：`issuepilot run --config
  /path/to/issuepilot.team.yaml` team mode，用于多项目加载、lease-backed
  调度和 project-aware dashboard state。
- ✅ 单 daemon 支持多项目；并发可在 1–5 之间配置，配套全局 + per-project
  租约槽位。
- ✅ dashboard 基础操作 `retry` / `stop` / `archive run` 已交付（V2 Phase 2，
  stop 走真实 Codex `turn/interrupt`）。
- ✅ CI 状态读取 + CI 失败自动回流到 `ai-rework`（V2 Phase 3；通过 `WORKFLOW.md`
  的 `ci.enabled: true` 显式开启）。注意：scanner 只在 daemon 启动时按 `ci.enabled`
  决定是否注入 loop，运行中修改 `ci.enabled` 需要重启 `issuepilot run` 才会生效。
- ✅ Review feedback sweep（V2 Phase 4）：orchestrator 持续轮询 `human-review`
  MR 上的人工评论，将其结构化为 `ReviewFeedbackSummary` 写入 run 记录；当
  issue 被打回 `ai-rework` 时，新一轮 run 会自动继承上一轮的 summary，并以
  统一的 `## Review feedback` markdown 区段拼接到 agent prompt 之前。该 sweep
  始终开启，无需 workflow 开关。dashboard 的 run 详情页面新增 `Latest review
  feedback` 面板，可直接跳转到 MR 上的每条评论。
- ✅ Workspace retention（V2 Phase 5）：orchestrator 按 `retention.cleanup_interval_ms`
  周期清理 `~/.issuepilot/workspaces`，成功 run 默认 7 天到期、失败 run 默认
  保留 30 天供取证，active run 永远不删；总容量超出 `max_workspace_gb` 时
  也只允许从已过期的 terminal run 里挑，保留期内的 failure 现场不会被强删。
  配置通过 `issuepilot.team.yaml` 或 workflow front matter 的 `retention`
  块覆盖。操作员可用 `issuepilot doctor --workspace --workflow <path>`
  做 dry-run 预览；dashboard service header 新增 `Workspace usage` /
  `Next cleanup` 两列；每次 sweep emit `workspace_cleanup_planned` /
  `_completed` / `_failed` 事件，详细 SOP 见
  `docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`。
  - **限制**：V2 team daemon 目前只会解析 `retention` schema，**不会自动跑
    cleanup loop**。团队场景需要自动清理，目前的做法是用 V1 入口
    `issuepilot run --workflow ...` 逐项目启动 daemon；team-mode wiring 列在
    Phase 5 follow-up。

延后到 V2 之后处理（不阻塞 V2）：

- 可选自动 merge 策略下沉到 V3，在生产权限、approval、audit 和回滚控制下
  设计；P0 / V2 默认仍由人类控制 merge。

### V2.5 — Command Center

目标：把"概览页 + 运行详情页"合并成 Linear 风格的 Command Center，让运维人员
在一个屏幕里完成 triage、review 和质量观察；GitLab notes 与 dashboard
共用同一份事实。

- ✅ `RunReportArtifact` 持久化在 `~/.issuepilot/.../reports/<runId>.json`，
  与 JSONL 事件存储并排，claim 时初始化，并在 reconcile、CI 扫描、review
  扫描、failure 路径上更新。
- ✅ Command Center 首页支持 **List 视图** 与 **Board 视图**（按 workflow
  label 分栏），并提供内联 Review Packet 检查器。
- ✅ 运行详情页的 **Review Packet** 直接从报告渲染结构化 handoff summary、
  validation、risks、follow-ups、checks（CI / approvals / review
  feedback / risks）以及 merge-readiness 判定结果。
- ✅ **Reports 页面** (`/reports`) 聚合本地报告产物的质量与耗时指标
  （ready-to-merge / blocked / failed 计数器，以及 report summary 列表）。
- ✅ **Merge readiness 仅做 dry-run**：评估 CI、approval、review feedback
  和 risks 是否就绪，**不会调用** GitLab 的 merge API；真正的自动 merge
  仍在范围之外。
- ✅ Handoff / failure / closing 等 GitLab notes 都从同一个
  `RunReportArtifact` 渲染，保证 dashboard、notes 以及未来的 Markdown
  导出保持一致。

### V2.6 — Dashboard shell + 布局重构

目标：在 V2.5 内容堆完之后，借助 `ui-ux-pro-max` 系统化评估，给 Command
Center 减负、把信息密度调到合理区间。

第二轮抛光（用户 dog-food 之后）：

- ✅ Command Center / Reports / Run Detail 三页 `max-w` 统一为 1440px，
  在 topbar 下切换页面时主容器宽度不再抖动。
- ✅ board 视图的 inspector Sheet 改成 **GitLab 风纯 overlay**：去遮罩、
  不锁 body 滚动、`role` 从 `dialog` 改成 `complementary`；sheet 是 fixed
  positioned 浮在看板右侧上方，**主内容布局完全不让位**（没有
  `lg:pr-[440px]` "把页面挤回去"），board 保持原始的 `min-w-[1080px]` /
  `minmax(180px, 1fr)` 列宽，被覆盖的两栏可以横向滚动看——和 GitLab issue
  看板的右侧详情面板观感一致。**点 sheet 之外的卡片直接换 inspector
  内容，不用先 Esc**。
- ✅ board 卡片去掉冗长的 runId 行（仍走 `title=` 和 `aria-label`），
  hover / 选中加 `-translate-y-0.5` + `shadow-2` 微动效，标题 `line-clamp-2`
  避免高度爆炸。
- ✅ ServiceHeader 把 `Last config reload` / `Workspace usage` /
  `Next cleanup` 收进 "更多详情" disclosure，默认折叠，service strip 更
  紧凑。
- ✅ Reports 4 张 Counter（Total / Ready / Blocked / Median duration）全部
  接上 7 日 inline sparkline，复用同一个 `bucketByDay` predicate + 新增
  `medianDurationByDay` helper。

首轮（顶部导航 + 抽屉化 + 健康条）：

- ✅ **顶部水平导航壳**替换 232px 左侧 sidebar。主导航 + locale / theme /
  mode tag 工具区收成 sticky 的横向条（`max-w-[1440px]`、
  `bg-surface/95 backdrop-blur`），首焦点是 `跳到主内容`。这一步让出
  ~232px 横向空间，board 视图 6 栏在 1280px 笔记本上不再 x-overflow。
- ✅ **混合 Review Packet inspector**。list 视图保留 split-pane，但只在
  选中 run 时才把右侧 320–420px 列展开；board 视图把 inspector 收成按需
  滑入的 **右侧 Sheet 抽屉**，让 kanban 保持全宽。Sheet 严格遵循 Apple HIG
  和 Material 的 modal escape 规则：Esc 关闭、点遮罩关闭、✕ 关闭、
  打开期间锁 `body.overflow:hidden`、关闭后焦点恢复，并通过 `globals.css`
  的全局规则尊重 `prefers-reduced-motion`。
- ✅ **横向 stacked health bar**。5 张大 KPI 卡（running / retrying /
  human-review / failed / blocked）合并成单卡：标题 + 共 N 条 + 一根 2px
  高的横向堆叠条 + 一行 chip 数字。运维一眼就能判断"队列是否健康"，不再
  需要心算 5 个独立数字。
- ✅ **Workflow 长路径修复**。service strip 用 `bdo` + `dir="rtl"`
  组合实现"从头截断"，文件名（`WORKFLOW.md`）始终可见，完整路径走原生
  `title=` tooltip。
- ✅ **Section header 减负**。原本满屏的 `text-[11px] uppercase
  tracking-[0.18em]` micro-label 改回普通 `text-base font-semibold`；
  `font-mono` micro-label 风格只保留给页面级 overhead label 和 `dt`
  metadata 标签 —— 它们才是真正的 kicker，在那里读起来自然。

后续执行顺序：**先做 V4 智能研发工作台，再做 V3 生产化执行平台**。这里的
V3 / V4 是能力域编号，不表示必须按数字顺序交付；当前判断是先验证研发流程智能
是否真正提升交付质量，再把已经验证的能力平台化。

### V4 — 智能研发工作台

目标：先在现有 V2.x 本地 / 团队 runtime 上，超越"单 Issue 单 run"模型，
成为能理解、拆解、编排和改进研发流程的智能工作台。V4 不负责部署、权限、
预算这些平台底座，而是专注研发流程智能；等能力验证清楚后，再由 V3 把这些
能力生产化。

- **大 Issue 拆解与编排**：自动把大 Issue 拆成可执行子任务，识别顺序、
  并行度、共享上下文和回滚边界。
- **跨 Issue 依赖分析**：发现 blocker、重复工作、上下游依赖和可合并任务，
  在 dashboard 中形成研发工作图谱。
- **多 agent 协作**：实现 coding agent、reviewer agent、test/evidence
  agent 等角色分工，支持子任务级协作和汇总。
- **智能 review 工作流**：自动总结 MR 风险、归类 review 评论、生成返工计划，
  并把 review 反馈转成下一轮 agent 的结构化输入。
- **验收材料自动生成**：产出截图、录屏、Playwright walkthrough video、
  测试证据、风险清单和可直接贴到 MR / Issue 的验收报告。
- **质量与过程分析**：分析成功率、返工率、CI 通过率、review 命中率、耗时
  瓶颈和高风险 workflow。
- **workflow / skills 持续改进**：根据失败模式推荐 workflow、skills、prompt
  和项目规则调整，形成可审计的改进闭环。
- **多执行器生态**：支持 Claude Code、内部 coding agent 或其他 runner
  adapter，并用统一报告和审计模型管理其输出。

### V3 — 生产化执行平台

目标：把 V2.x 的本地/团队机器能力，以及 V4 已验证的研发流程智能，升级成可正式
部署、治理、审计和扩容的内部 AI 工程执行平台。V3 不追求重新发明更聪明的工作流，
而是让已经验证的能力在生产环境可控、可观测、可恢复。

- **部署形态**：提供 Docker / Compose / Kubernetes 部署路径，明确 API server、
  dashboard、worker、storage 的进程边界和升级方式。
- **多 worker 执行**：支持 local / SSH / container worker，带 worker
  heartbeat、容量上报、任务派发、失败恢复和队列回收。
- **生产 sandbox**：用 Docker / Kubernetes sandbox 替代单机 sandbox 模型，
  为不同项目提供隔离的 filesystem、network 和 secret 注入策略。
- **身份与权限**：接入登录态，建立项目级、团队级、管理员级权限；所有
  dashboard 操作和自动动作都写入带操作者身份的 audit log。
- **预算与配额**：按项目 / 团队限制 token、运行时长、并发、成本和重试次数，
  超限时进入可解释的 blocked / approval 流程。
- **持久化存储**：Postgres 作为生产 run history、reports、leases、audit
  和配置状态存储；SQLite / JSONL 仅保留为本地开发或单机模式。
- **Webhook + poll 混合调度**：GitLab webhook 用于实时触发，poll 作为兜底，
  减少延迟同时保留可恢复性。
- **GitLab 审计与 secret 治理**：集中 credential store、token rotation、
  最小权限访问、全链路 redaction 和敏感字段泄漏测试。
- **生产合并策略**：在 V2.5 merge-readiness dry run 基础上，增加带权限、
  approval、CI 和 audit 约束的可选自动 merge。
- **观测与运维**：OpenTelemetry、结构化日志、metrics、trace、Grafana /
  Loki 或内部观测平台集成；提供 backup / restore、migration、升级 / 回滚
  runbook。

> Roadmap 内容会随实际进展调整，每次较大变更都会同步更新 design spec 和
> `CHANGELOG.md`，请以 spec 为准。

## 文档

- **[使用指南（中文）](USAGE.zh-CN.md)** — 第一次跑 IssuePilot？从这里开始。30 分钟内跑通你第一个 ai-ready Issue 的端到端流程；Part 5 是 V2 团队模式。
- [User Guide — English](USAGE.md) — 英文版使用手册（与 `USAGE.zh-CN.md` 同步）。
- **[V2 架构图](docs/superpowers/diagrams/v2-architecture.svg)** — V2 团队可运营 runtime 的可视化（config → registry → scheduler → loop → adapters → events → dashboard）。
- **[V2 端到端流程图](docs/superpowers/diagrams/v2-flow.svg)** — Issue 从 `ai-ready` 走到关闭/失败/打回的完整生命周期，覆盖 CI 回流 / review feedback / workspace cleanup。
- [图源文件](docs/superpowers/diagrams/) — Mermaid 源与渲染命令说明。
- [IssuePilot V2 路线图和文档矩阵](docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md) — V2 当前阶段、执行顺序、spec/plan 对应关系（Phase 1–5 已合入）。
- [Workspace cleanup runbook](docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md) — V2 Phase 5 retention 操作员 SOP。
- [IssuePilot 真实 Smoke Runbook](docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) — 真实 GitLab + Codex 的端到端验证清单。
- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md) — 架构、协议、状态机细节。
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md) — 8 Phase 实施计划与 Task 清单。
- [Original Symphony spec](SPEC.md)
- [Elixir reference implementation](elixir/README.md)

## 贡献

项目仍处于早期，欢迎贡献。当前最有价值的贡献包括：

- 带有明确命令、日志和环境信息的 bug report。
- 收紧 workflow、GitLab、workspace、runner 或 orchestrator 契约的测试。
- 让本地设置更容易复现的文档修正。
- 聚焦的 PR，并且将 TypeScript 实现改动和设计 spec 更新保持清晰边界。

提交 PR 前，请运行与变更相关的检查：

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

如果变更影响产品行为、架构、workflow labels、runner 行为或 roadmap 范围，
请在同一个 PR 中更新 IssuePilot design spec。

## License

IssuePilot 使用 [Apache License 2.0](LICENSE) 授权。
