# IssuePilot 使用手册

[English](./USAGE.md) | 简体中文

本手册面向**首次使用 IssuePilot 的工程师**。目标是把一个 GitLab Issue
自动跑成一条分支、一个 Merge Request 和一条 Issue 回写说明；并把一台
共享机器升级成可同时管理多个项目、自动回流 CI / review 反馈、自动清理
workspace 的团队 daemon。

> **覆盖版本**：V1 单项目本地闭环 + V2 团队可运营版本（Phase 1–5 已合入 main）。
> **维护规则**：根目录公开双语入口，与 [`USAGE.md`](./USAGE.md) 同步。

视觉版本：

- 架构图：[`docs/superpowers/diagrams/v2-architecture.svg`](./docs/superpowers/diagrams/v2-architecture.svg)
- 端到端流程图：[`docs/superpowers/diagrams/v2-flow.svg`](./docs/superpowers/diagrams/v2-flow.svg)

---

## 目录

- [Part 1 — 总览](#part-1--总览)
  - [1.1 IssuePilot 做什么](#11-issuepilot-做什么)
  - [1.2 V1 单项目 vs V2 团队模式](#12-v1-单项目-vs-v2-团队模式)
  - [1.3 仓库与目录角色](#13-仓库与目录角色)
- [Part 2 — 快速跑通（约 30 分钟）](#part-2--快速跑通约-30-分钟)
  - [2.1 环境要求](#21-环境要求)
  - [2.2 安装 IssuePilot](#22-安装-issuepilot)
  - [2.3 第一次跑通核对清单](#23-第一次跑通核对清单)
- [Part 3 — 准备目标 GitLab 项目](#part-3--准备目标-gitlab-项目)
  - [3.1 创建 workflow labels](#31-创建-workflow-labels)
  - [3.2 SSH 能 push 到目标项目](#32-ssh-能-push-到目标项目)
  - [3.3 撰写 `WORKFLOW.md`](#33-撰写-workflowmd)
  - [3.4 配置 GitLab 凭据](#34-配置-gitlab-凭据)
  - [3.5 校验配置](#35-校验配置)
- [Part 4 — V1 单项目模式：个人开发机](#part-4--v1-单项目模式个人开发机)
  - [4.1 启动 orchestrator + dashboard](#41-启动-orchestrator--dashboard)
  - [4.2 跑第一个 Issue](#42-跑第一个-issue)
  - [4.3 6 个 label 状态对应该做什么](#43-6-个-label-状态对应该做什么)
- [Part 5 — V2 团队模式：共享机器 + 多项目](#part-5--v2-团队模式共享机器--多项目)
  - [5.1 中心化 team config](#51-中心化-team-config)
  - [5.2 校验、render、启动](#52-校验render启动)
  - [5.3 Phase 2 — Dashboard 操作（retry / stop / archive）](#53-phase-2--dashboard-操作retry--stop--archive)
  - [5.4 Phase 3 — CI 状态自动回流](#54-phase-3--ci-状态自动回流)
  - [5.5 Phase 4 — Review feedback sweep](#55-phase-4--review-feedback-sweep)
  - [5.6 Phase 5 — Workspace retention 自动清理](#56-phase-5--workspace-retention-自动清理)
  - [5.7 V4.1 Workflow Spine — 大 Issue 端到端走一圈](#57-v41-workflow-spine--大-issue-端到端走一圈)
  - [5.8 V2 当前的边界与未覆盖](#58-v2-当前的边界与未覆盖)
- [Part 6 — 日常运维与排障](#part-6--日常运维与排障)
  - [6.1 在哪里看什么](#61-在哪里看什么)
  - [6.2 失败 / blocked run 取证](#62-失败--blocked-run-取证)
  - [6.3 FAQ](#63-faq)
- [Part 7 — 参考](#part-7--参考)
  - [7.1 CLI 速查表](#71-cli-速查表)
  - [7.2 HTTP API 端点速查](#72-http-api-端点速查)
  - [7.3 文档导航](#73-文档导航)

---

## Part 1 — 总览

### 1.1 IssuePilot 做什么

IssuePilot 是本地单机 / 团队共享机器上跑的 orchestrator。一次完整运行：

1. 轮询 GitLab，找到带 `ai-ready` label 的 Issue。
2. 为每个 Issue 在 `~/.issuepilot` 下创建独立 git worktree。
3. 在 worktree 里启动 `codex app-server`，让 Codex 完成代码修改。
4. 推送分支，创建或更新 MR，给 Issue 写 handoff note。
5. 把 Issue label 从 `ai-running` 切到 `human-review` / `ai-failed` / `ai-blocked`。
6. 在 `human-review` 阶段周期性扫 MR pipeline、扫 reviewer 评论、按 retention
   policy 清理过期 worktree（V2）。
7. MR 被人工 merge 后，IssuePilot 自动写 closing note，移除 `human-review`，
   关闭 Issue。

IssuePilot 不是 SaaS、不是集群、**不会自动 merge MR**。

### 1.2 V1 单项目 vs V2 团队模式

| 维度 | V1 单项目 | V2 团队模式 |
| --- | --- | --- |
| 适合场景 | 个人开发机，一台 daemon 服务一个项目 | 团队共享机器，一台 daemon 同时管多个 GitLab 项目 |
| 入口 | `issuepilot run --workflow /path/to/WORKFLOW.md` | `issuepilot run --config /path/to/issuepilot.team.yaml` |
| 配置事实来源 | 各项目业务仓库根目录的 `WORKFLOW.md` | 中心化 `issuepilot-config/` 目录：`issuepilot.team.yaml` + `projects/*.yaml` + `workflows/*.md` |
| 并发 | 单 run，1 个 worktree | 1–5，全局 + per-project lease 防重复 claim |
| Dashboard 操作 | retry / stop / archive 可用 | retry / stop / archive 暂未装配（返回 `503 actions_unavailable`） |
| CI 回流 | ✅ | ✅ |
| Review feedback sweep | ✅ | ✅ |
| Workspace cleanup loop | ✅ | ⚠ schema 已解析但 cleanup loop 暂未自动跑（follow-up） |
| Dashboard 项目视图 | 单项目 | 按 team config 顺序列出所有项目 |

两个入口**互斥**，同时传给 CLI 会报错退出。两种模式可以共存：团队场景下
若要 Phase 5 自动清理，目前的兜底是用 V1 入口逐项目启动。

### 1.3 仓库与目录角色

```text
/path/to/issuepilot                       本仓库；只在这里构建或安装本地包
  pnpm release:pack                       生成 ./dist/release/issuepilot-*.tgz

/path/to/target-project                   被 AI 修改的业务仓库
  WORKFLOW.md                             V1 单项目入口：业务仓库根的 prompt + 契约

/path/to/issuepilot-config                V2 团队模式入口（见 §5.1）
  issuepilot.team.yaml                    server / scheduler / projects roster
  projects/<id>.yaml                      各项目事实（tracker / git / 可选 agent 覆盖）
  workflows/<name>.md                     可复用 workflow profile（prompt + 运行护栏）

~/.issuepilot/                            本地落盘的运行时
  repos/                                  bare git mirror
  workspaces/<project>/<iid>/             每 Issue 一个 git worktree
  state/leases-*.json                     V2 lease store
  state/runs/                             run record（JSON）
  state/events/                           JSONL event store（每 Issue 一个文件）
  state/logs/issuepilot.log               pino 结构化日志
  credentials                             OAuth token（0600）

安装后的 CLI
  issuepilot doctor                       环境自检
  issuepilot validate                     校验 workflow / team config
  issuepilot run --workflow ...           V1 单项目入口
  issuepilot run --config ...             V2 团队模式入口
  issuepilot dashboard                    启动只读 dashboard（默认 :3000）
```

---

## Part 2 — 快速跑通（约 30 分钟）

下面是"安装 → 第一个 Issue 进入 `human-review`"的最短路径。

### 2.1 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | `>=22 <23` |
| pnpm | `10.x`（通过 corepack 使用） |
| Git | `>=2.40` |
| Codex CLI | 能执行 `codex app-server` 且已登录 |
| GitLab | 一个测试项目，支持 API / label / Issue / MR |
| SSH key | 能 push 到目标项目 |

### 2.2 安装 IssuePilot

在 **IssuePilot 仓库**里：

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
issuepilot doctor
```

期望：`doctor` 输出里 Node.js / Git / Codex app-server / `~/.issuepilot/state`
四项都是 `[OK]`。

> **贡献者兜底**（在本仓库源码里跑，不安装全局 CLI）：
> ```bash
> pnpm build
> pnpm exec issuepilot doctor
> pnpm exec issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
> ```

### 2.3 第一次跑通核对清单

```text
[ ] Part 3.1   目标 GitLab 项目里建好 6 个 label
[ ] Part 3.2   ssh -T 能通到 GitLab 主机
[ ] Part 3.3   目标项目根目录有 WORKFLOW.md 并已提交
[ ] Part 3.4   OAuth 已登录，或环境变量 token 已 export
[ ] Part 3.5   issuepilot validate --workflow 输出 Validation passed
[ ] Part 4.1   终端 A 跑 issuepilot run --workflow ...，终端 B 跑 issuepilot dashboard
[ ] Part 4.2   在 GitLab 建一个简单 Issue 并打 ai-ready
[ ] Part 4.2   ~10 秒后 dashboard 出现 run，~几分钟后 label 翻到 human-review
```

---

## Part 3 — 准备目标 GitLab 项目

以下步骤都在**目标项目**（被 AI 修改的业务仓库）对应的 GitLab project
里完成，一次性配置。§3.1、§3.2、§3.4 对 V1 和 V2 通用；§3.3（业务仓库根
的 `WORKFLOW.md`）和 §3.5（`validate --workflow`）**仅 V1 单项目入口**
使用 —— V2 团队模式由中心化配置接管 workflow（见
[§5.1](#51-中心化-team-config)，并改用 `issuepilot validate --config`）。

### 3.1 创建 workflow labels

| Label | 含义 |
| --- | --- |
| `ai-ready` | 候选 Issue，IssuePilot 会自动认领 |
| `ai-running` | IssuePilot 已认领，正在跑 |
| `human-review` | MR 已生成，等待人工 review |
| `ai-rework` | 人工 review 后要求 AI 再跑一轮 |
| `ai-failed` | 运行失败，需人工排障 |
| `ai-blocked` | 缺信息、权限或密钥 |

### 3.2 SSH 能 push 到目标项目

`workflow.git.repo_url` 推荐使用 SSH 地址。IssuePilot 的 Git push 走本机
SSH key，不走 GitLab API token。

```bash
ssh -T git@gitlab.example.com
# 公司有两套 GitLab 时分别测：
ssh -T git@gitlab.chehejia.com
ssh -T git@gitlabee.chehejia.com
```

### 3.3 撰写 `WORKFLOW.md`

在**目标项目仓库根目录**创建 `WORKFLOW.md`，并提交到默认分支。

```bash
cd /path/to/target-project
$EDITOR WORKFLOW.md
```

最小模板：

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked
  rework_label: ai-rework

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

你是这个仓库的 AI 工程师。

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

要求：

1. 先阅读相关代码再开始改。
2. 工作只能落在提供的 workspace 内。
3. 完成 Issue 描述里的修改。
4. 提交代码，并通过 `gitlab_create_merge_request` 创建或更新 MR。
5. 用 `gitlab_create_issue_note` 给 Issue 回写实现、验证、风险和 MR 链接。
6. 完成后让 orchestrator 把 Issue 转到 `human-review`。
7. 缺信息、权限或密钥时，调 `gitlab_transition_labels` 打 `ai-blocked` 并说明原因。
```

提交：

```bash
git add WORKFLOW.md
git commit -m "chore(issuepilot): add workflow"
git push origin main
```

关键字段速查：

| 字段 | 怎么填 |
| --- | --- |
| `tracker.kind` | 固定 `gitlab`，不要写 `gitlabee` |
| `tracker.base_url` | GitLab 实例地址 |
| `tracker.project_id` | 项目路径或数字 ID |
| `tracker.token_env` | **仅环境变量 token 模式才填**；值是变量名，不是 token 值 |
| `git.repo_url` | 目标项目 SSH clone 地址 |
| `git.base_branch` | MR target branch（一般是 `main`） |
| `agent.max_concurrent_agents` | 先用 `1`，稳定后再调大 |
| `codex.approval_policy` | P0 推荐 `never` |
| `poll_interval_ms` | 默认 10000ms；越小响应越快、GitLab API 压力越大 |

⚠ workflow 拒绝 `danger-full-access` / `dangerFullAccess` sandbox；不要写
明文 token，全程通过环境变量或 OAuth credentials 注入。

### 3.4 配置 GitLab 凭据

两条路径任选其一。个人开发机推荐 **OAuth**；CI 或团队共享环境推荐 **环境
变量 token**。

#### 方式 A：OAuth 登录（推荐）

前置：每个 GitLab 实例需要管理员先注册一个 OAuth Application。

- 入口：`https://<gitlab-host>/admin/applications`
- Name：`IssuePilot`
- Confidential：**不勾选**（必须是 public application）
- Scopes：`api`、`read_repository`、`write_repository`
- 如果有 Device Authorization Grant 开关，勾选
- 保存后复制 **Application ID**，它就是下面的 `--client-id`

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

登录成功后 token 落到 `~/.issuepilot/credentials`（`0600`），daemon 401
时会自动 refresh + 重试一次。**使用 OAuth 时 workflow 里不要写
`tracker.token_env`**；写了就会强制要求对应环境变量存在。

公司多套 GitLab：

```bash
issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
```

#### 方式 B：环境变量 token

如果已经有 PAT / Group Access Token / Project Access Token，可以直接走环境
变量。这时 workflow 的 `tracker` 段**必须**额外加 `token_env`：

```yaml
tracker:
  base_url: "https://gitlab.chehejia.com"
  token_env: "GITLAB_TOKEN"

tracker:
  base_url: "https://gitlabee.chehejia.com"
  token_env: "GITLABEE_TOKEN"
```

启动 daemon 前：

```bash
export GITLAB_TOKEN="<gitlab.chehejia.com token>"
export GITLABEE_TOKEN="<gitlabee.chehejia.com token>"
```

token 严禁出现在 `WORKFLOW.md`、Issue、prompt 或日志里。

### 3.5 校验配置

不启动 daemon、不连 GitLab，先校验 workflow 是否合法：

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot validate --workflow "$WORKFLOW_PATH"
```

期望：

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

常见失败：

| 错误 | 处理方式 |
| --- | --- |
| `WorkflowConfigError: tracker` | 检查 workflow front matter 字段名和缩进 |
| `WorkflowConfigError: tracker.token_env` | workflow 写了 `token_env` 但 shell 没有对应环境变量；要么 export，要么删掉 `token_env` 并走 OAuth |
| `GitLabError(category="auth")` | token 错误、过期，或 OAuth credentials 不存在 |
| `GitLabError(category="permission")` | token 缺 `api` scope，或无目标项目权限 |

---

## Part 4 — V1 单项目模式：个人开发机

### 4.1 启动 orchestrator + dashboard

需要两个终端。

**终端 A — orchestrator：**

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

ready 后日志会打印 `API: http://127.0.0.1:4738`。

> 贡献者源码兜底：`pnpm exec issuepilot run --workflow "$WORKFLOW_PATH"`。

**终端 B — dashboard：**

```bash
issuepilot dashboard
```

打开 `http://localhost:3000`。dashboard 默认连 `http://127.0.0.1:4738`；若
orchestrator 用了其他端口：

```bash
issuepilot dashboard --api-url http://127.0.0.1:4839
```

如果页面显示 `IssuePilot orchestrator unreachable` / `fetch failed`：
先确认终端 A 的 orchestrator 还在跑，且 dashboard 连的是同一端口。

首页就是 **V2.5 Command Center**：单屏内提供 **List 视图** 与 **Board
视图**（右上角切换），点 run 行即可打开内联的 Review Packet 检查器；点击
run ID 进入完整的运行详情页，开头是 **Review Packet** 区块，按运行报告
统一展示 handoff summary、validation、risks、follow-ups 以及 merge
readiness 判定结果。聚合页地址是
`http://127.0.0.1:3000/reports`，会用本地报告产物汇总 ready-to-merge /
blocked / failed 计数器，并列出每个 run 的报告摘要。

> **Merge readiness 仅做 dry-run**：只是告诉你 CI、approval、review
> feedback 和 risks 是否看起来已经就绪，IssuePilot 不会调用任何 GitLab
> merge API；真正的 merge 决策仍由人类掌握。

Dashboard 支持中英双语：sidebar 底部的 **EN / 中** toggle 可以一键切换，
选择写入 `issuepilot-locale` cookie，Command Center、Reports、Run detail
所有页面同步生效。技术 token 在两种语言下都保持英文 —
状态码（`running` / `retrying` / `completed` / `failed` / `blocked` /
`human-review` / `ai-ready` / `ai-running` / `ai-rework` / `ai-failed` /
`ai-blocked`）、readiness（`ready` / `not-ready` / `blocked` / `unknown`）、
CI 状态、run id、branch、路径，以及 `IssuePilot` / `Codex` / `GitLab` /
`MR` / `Workflow` / `Workspace` 这些产品名词，按 AGENTS 规则不翻。

### 4.2 跑第一个 Issue

在目标 GitLab 项目里：

1. 新建一个简单 Issue（例：「在 README 末尾加一行 `Hello from IssuePilot`」）。
2. 给 Issue 打 `ai-ready` label，**不需要** assign 给自己。

约 10 秒后，IssuePilot 应该：

```text
1. Issue label 从 ai-ready → ai-running
2. dashboard 出现一条 run，状态 running
3. ~/.issuepilot/workspaces/<project>/<iid> 下出现 worktree
4. Codex 在 worktree 内修改文件、commit
5. push 出 ai/<iid>-<slug> 分支
6. 创建 draft MR
7. Issue 上出现 handoff note：## IssuePilot handoff ...
8. Issue label 切到 human-review
```

随后由人类 review MR：

- **合并 MR** → IssuePilot 自动写 closing note + 移除 `human-review` + 关闭 Issue。
- **想让 AI 再改一轮** → 把 label 改成 `ai-rework`（Phase 4 review feedback sweep
  会把你的 MR 评论结构化注入到下一轮 prompt）。
- **关闭 MR 不合并** → IssuePilot 把 label 回退到 `ai-rework`。

### 4.3 6 个 label 状态对应该做什么

| 当前 label | 你该做什么 |
| --- | --- |
| `ai-ready` | 等 IssuePilot 拾取（每 `poll_interval_ms` 一次） |
| `ai-running` | 看 dashboard 等结果；不要手工改 label |
| `human-review` | 去 GitLab review MR；可选等 CI 状态自动更新 |
| `ai-rework` | 等 IssuePilot 再跑一轮 |
| `ai-failed` | 看 dashboard timeline + 失败 note；修复后用 dashboard Retry，或人工把 label 改回 `ai-ready` |
| `ai-blocked` | 补信息、权限或密钥，解决后把 label 改回 `ai-ready` |

---

## Part 5 — V2 团队模式：共享机器 + 多项目

V2 不破坏 V1 入口，新增 `--config` 团队入口和 4 组配套能力：dashboard 操作、
CI 失败回流、review feedback sweep、workspace retention 自动清理。V1 / V2
选型见 [§1.2](#12-v1-单项目-vs-v2-团队模式)；两个入口**互斥**，同时传会
报错退出。

### 5.1 中心化 team config

V2 团队模式**不读**业务仓库里的 `WORKFLOW.md`，而是用一个独立的
`issuepilot-config/` 目录集中管理三类文件：

1. `issuepilot.team.yaml` —— server / scheduler / projects roster。
2. `projects/<id>.yaml` —— 每项目一份，**仅项目事实**（tracker 目标、
   repo URL、base branch、可选小颗粒 agent 覆盖）。
3. `workflows/<name>.md` —— 可复用的 workflow profile（prompt + 运行
   护栏，如 sandbox / runner / 并发）。多个项目可以共用同一个 profile。

```text
issuepilot-config/
  issuepilot.team.yaml
  projects/
    platform-web.yaml
    infra-tools.yaml
  workflows/
    default-web.md
    default-node-lib.md
```

`issuepilot-config/issuepilot.team.yaml`：

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

projects:
  - id: platform-web
    name: Platform Web
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md
    enabled: true
  - id: infra-tools
    name: Infra Tools
    project: ./projects/infra-tools.yaml
    workflow_profile: ./workflows/default-node-lib.md
    enabled: true

# 可选：team 级 CI override。配了就覆盖 profile 的 ci；projects[].ci 又会
# 覆盖这里。任何 override 必须三键齐发。
# ci:
#   enabled: true
#   on_failure: ai-rework        # 或 human-review
#   wait_for_pipeline: true

# 可选：workspace retention 默认值（目前仅 V1 cleanup loop 真正执行；team
# daemon 解析但暂未启用，详见 §5.6）。
# retention:
#   successful_run_days: 7
#   failed_run_days: 30
#   max_workspace_gb: 50
#   cleanup_interval_ms: 3600000
```

`projects/platform-web.yaml` —— 仅记录项目事实，不含 token、不含 runner、
不含 prompt：

```yaml
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web

git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai

# 可选 per-project agent 覆盖；其余字段由 profile 兜底。
# agent:
#   max_turns: 10
#   max_attempts: 2
```

`workflows/default-web.md` —— 可被多个同类项目复用的 prompt + 运行护栏。
profile 是设置 runner / Codex sandbox / hooks 的**唯一位置**，project 文件
无法提升这些字段。

```md
---
agent:
  runner: codex-app-server
  max_concurrent_agents: 1

codex:
  approval_policy: never
  thread_sandbox: workspace-write

ci:
  enabled: true
  on_failure: ai-rework
  wait_for_pipeline: true
---

你正在处理 GitLab 项目 `{{ project.tracker.project_id }}` 的 issue。
目标仓库 `{{ project.git.repo_url }}`，默认分支 `{{ project.git.base_branch }}`。
```

字段约束（违反会启动失败并报具体 dotted path）：

| 字段 | 约束 |
| --- | --- |
| `version` | 固定 `1` |
| `scheduler.max_concurrent_runs` | `1..5` |
| `scheduler.lease_ttl_ms` | `>= 60000` |
| `scheduler.poll_interval_ms` | `>= 1000` |
| `projects[].id` | 小写字母数字 + 中划线；同一 config 不能重复 |
| `projects[].project` / `projects[].workflow_profile` | 都必填；相对路径基于 team config 目录解析为绝对路径 |
| `ci`（precedence） | `projects[].ci > team ci > workflow profile ci`；任何 override 必须三键齐发 |

`projects[].workflow`（旧的单文件指针）在 team 模式下**已不再支持**，
loader 会用可操作的 dotted-path 错误（明确指向需要替换为的字段）拒绝加载。

### 5.2 校验、render、启动

```bash
# 1. schema 校验（不连 GitLab、不启 daemon）
issuepilot validate --config /path/to/issuepilot-config/issuepilot.team.yaml

# 2. 查看某个项目编译后的 effective workflow（敏感字段已脱敏，可贴到
#    review 工单或与上一次 render 做 diff）。编译产物永远不落盘。
issuepilot render-workflow \
  --config  /path/to/issuepilot-config/issuepilot.team.yaml \
  --project platform-web

# 3. 启动 team daemon
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml

# 4. 另起终端跑 dashboard
issuepilot dashboard --api-url http://127.0.0.1:4738
```

`validate --config` 与 daemon 启动走同一条 `loadTeamConfig` 管道，YAML 错和
zod schema 错都按 dotted path 报出来。V2 模式下 dashboard 顶部 `Projects`
区按 team config 顺序列出每个项目；`enabled: false` 显示中性 `disabled`
badge；workflow 编译失败的项目显示红色 `load error` badge + 错误摘要。

### 5.3 Phase 2 — Dashboard 操作（retry / stop / archive）

dashboard 的 runs 列表与 detail 页提供三个按钮，所有操作都会写
`operator_action_*` 事件到 event store。

| 操作 | 适用状态 | 行为 | 备注 |
| --- | --- | --- | --- |
| **Retry** | `ai-failed` / `ai-blocked` / `ai-rework` / archived failed run | issue label 翻 `ai-rework`，dashboard run 状态置 `claimed` | V2 team daemon 暂未装配，返回 `503 actions_unavailable`；V1 入口可用 |
| **Stop** | active `ai-running` run | 通过 Codex `turn/interrupt` 真实取消 turn；5s 超时升级 `stopping`，最终走 `turnTimeoutMs` 收敛 | 不直接动 GitLab labels；失败 emit `operator_action_failed { code: cancel_timeout / cancel_threw / not_registered }` |
| **Archive** | terminal run（`completed` / `failed` / `blocked`） | run record 写 `archivedAt`，dashboard 默认隐藏 | 列表顶部有 `Show archived` toggle |

操作者身份默认 server 端 `"system"` 兜底；HTTP `x-issuepilot-operator`
header 留作 V3 RBAC 接入口。

### 5.4 Phase 3 — CI 状态自动回流

在 `WORKFLOW.md` 或 team config 打开 `ci.enabled`，orchestrator 在
`human-review` 阶段会按 `poll_interval_ms` 轮询 MR pipeline：

```yaml
ci:
  enabled: true
  on_failure: ai-rework        # 或 human-review
  wait_for_pipeline: true
```

行为矩阵：

| pipeline 状态 | `on_failure` | 行为 |
| --- | --- | --- |
| `success` | — | 保持 `human-review`，dashboard 标记可 review |
| `failed` | `ai-rework` | label 翻 `ai-rework` + 写带 `<!-- issuepilot:ci-feedback:<runId> -->` marker 的 note |
| `failed` | `human-review` | 不动 labels，仅写一条 marker note + emit `ci_status_observed { action: "noop" }` |
| `running` / `pending` / `unknown` | — | 保持 `human-review`，等下一轮 poll，不写 note |
| `canceled` / `skipped` | — | 写一条提示人工 review 的 marker note + emit `ci_status_observed { action: "manual" }` |

约束：

- scanner 只在 daemon 启动时按 `ci.enabled` 注入 loop；**改 `ci.enabled` 必须
  重启 `issuepilot run`** 才生效。
- 自动 merge 不在 V2 范围内。

### 5.5 Phase 4 — Review feedback sweep

每轮 poll 在 `human-review` 阶段，orchestrator 会扫对应 MR 的人类评论（自动
跳过 GitLab system note 与自己写的 marker note），结构化为
`ReviewFeedbackSummary` 写回 run record。

- dashboard run detail 页底部新增 `Latest review feedback` 面板：展示 MR
  链接、最近 sweep 时间、每条评论的 author / time / resolved badge / 截断
  body，并附跳回 MR note 的深链接。
- issue 被人工打回 `ai-rework` 后，下一轮 dispatch 会把 summary 拼成标准化
  的 `## Review feedback` markdown 块注入到 prompt 之前；reviewer 内容用
  `<<<REVIEWER_BODY id=N>>> ... <<<END_REVIEWER_BODY>>>` envelope 包起来，
  防 prompt injection。
- **始终开启**；没 MR / 没评论时是 no-op，不需要 workflow 开关。
- 不会触发自动 merge，也不替代 Phase 3 CI 回流。

### 5.6 Phase 5 — Workspace retention 自动清理

默认 retention policy（可在 workflow 或 team config 顶层 `retention` 节覆盖）：

| Run 状态 | 默认保留 |
| --- | --- |
| active / running / stopping / claimed / retrying | 永不自动清理 |
| successful / closed | 7 天 |
| failed / blocked | 30 天 |
| archived terminal | 按原终态保留期计算 |

约束：

- 总 workspace 超过 `max_workspace_gb`（默认 50）时**只允许**清理已过期的
  terminal run；容量压力不会成为删除 active 或未过期失败现场的理由。
- 失败 worktree 会保留 `.issuepilot/failed-at-*` marker；marker 默认不删。
- cleanup 三段式事件：`workspace_cleanup_planned` → `workspace_cleanup_completed`
  / `workspace_cleanup_failed`，落到 sentinel `runId=workspace-cleanup`，
  可通过 `/api/events?runId=workspace-cleanup` 或 dashboard timeline 查到。
- **限制：V2 team daemon 目前只解析 `retention` schema，不会自动跑 cleanup
  loop。** 团队场景下若想启用 cleanup，目前的做法是用 V1 入口逐项目启动
  daemon；team-mode wiring 列在 Phase 5 follow-up。

**dry-run 预览**（无需启动 daemon）：

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

输出示例（无 daemon 时 run state 不可读，所有目录默认 `unknown`，planner
拒删；真实预览应 tail `workspace_cleanup_planned` 事件）：

```text
Workspace cleanup dry-run
  workspace root: ~/.issuepilot/workspaces
  entries: 14
  total usage: 2.471 GB (cap 50 GB)
  will delete: 0
  keep failure markers: 3
```

**操作 runbook**（误删 / 清理失败诊断 / 临时禁用）：
[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md)。

### 5.7 V4.1 Workflow Spine — 大 Issue 端到端走一圈

V4.1 把 IssuePilot 从「一个 Issue 一个 run」升级成可以把一个大 GitLab
Issue 拆成 2–5 个有顺序的子任务、为每个子任务派发一个 synthetic task
run（独立分支 + 独立 MR），最后回写一份 Parent Review Packet 到父
Issue 的工作台。

Operator 操作流：

1. 在 **Command Center** (`/`) 选中一个 `issue.iid` 指向你想拆解的大
   Issue 的 run，点击右侧 inspector 的 **Plan work item**。orchestrator
   会 POST `/api/issues/:iid/plan`，让 LLM 起草一份 `TaskPlan`，
   dashboard 会硬跳转到 `/work-items/<id>`。
2. 在 **Work item detail** 页 (`/work-items/<id>`) 审阅 plan。当
   `plan.status === "draft"` 时可以：
   - 点 **Edit** 直接修改每个任务的 `title` / `goal` / `scope` /
     `dependsOn` / `suggestedValidation`。
   - 点 **Accept plan** — 只 POST operator 实际改过的字段，
     `WorkItem.status` 切到 `ready`，orchestration 会立即派发所有依赖
     已满足且 concurrency slot 还有余量的 task。
   - 点 **Regenerate** — orchestrator 把当前 draft 标记 `superseded`，
     向 planner 请求一份新版本作为新的 draft。
3. 每个 synthetic task run 落地后，**Tasks** 区会按生效状态分组
   （`ready` / `running` / `completed` / `failed` / `blocked` /
   `needs_rework` / `blocked_by_dependency` / `skipped`）。每行带 MR
   链接；failed / needs-rework / blocked 行有 **Retry**，blocked /
   blocked-by-dependency / failed 行有 **Skip**。
4. 等所有 task 都 settle 后，**Parent Review Packet** 卡片会渲染
   `WorkItemReport`：validation summary、风险摘要、按任务的卡片
   （diff、validation、风险、follow-ups、CI、MR、next action）、
   evidence index 和 recommended next actions。可以用
   **Copy as Markdown** 一键复制成 Markdown 贴到 Slack / code review
   线程里。
5. orchestrator 会在父 Issue 写**单条** workpad note，note 里带
   marker `<!-- issuepilot:work-item:<id> -->`，每次 reconcile 都更新
   同一条 note。当 *所有* 必需 task 都 `completed` 时，IssuePilot 把
   父 Issue label 从 `ai-running` 切到 `human-review`；部分失败 /
   失败 / 阻塞场景下父 label 不动，由 operator 决定下一步。

CLI / 直接 HTTP 调用（脚本和 CI 校验时方便）：

```bash
# 为某个 GitLab Issue iid 起草 plan
curl -X POST -H 'content-type: application/json' \
  -d '{"iid": 42}' \
  http://127.0.0.1:4738/api/issues/42/plan

# 列出所有 WorkItem 及其状态计数
curl http://127.0.0.1:4738/api/work-items

# 读取最新聚合的 WorkItemReport
curl http://127.0.0.1:4738/api/work-items/<id>/report
```

V4.1 的几个不变量（operator 视角）：

- IssuePilot **绝不**创建子 GitLab Issue；父 Issue 是唯一被追踪的
  对象，每个 task 自己有一条 MR。
- synthetic task run **绝不**直接改父 Issue label，那是 aggregator
  的职责。看到 task run 改了父 label 请提 bug —— 说明
  `parentIssueLabelMode: "suppressed"` 没生效。
- dashboard **不会**对一个 work item 给出 `ready_to_merge` 推荐；
  V4.1 给出的最强推荐就是「请进入人工 review」。auto-merge 留给后续
  阶段。

### 5.8 V2 当前的边界与未覆盖

V2 主体已完成，**显式不在 V2 范围**的能力（会在 V3 / V4 处理）：

- 多用户 RBAC、token / 预算 / 配额。
- 远程 worker、Docker / K8s sandbox。
- 自动 merge、跨 issue 依赖规划、auto-decomposition。
- Postgres / SQLite 作为强依赖的长期 run history。
- 多 tracker 插件化、GitLab 之外的 issue tracker。
- 远端 `ai/*` 分支清理与 MR 自动归档。

未闭环的 follow-up（不阻塞日常使用）：

- V2 team daemon 装配 workspace cleanup loop。
- V2 team daemon 装配 operator actions（dashboard retry/stop/archive 目前
  返回 `503 actions_unavailable`）。

---

## Part 6 — 日常运维与排障

### 6.1 在哪里看什么

| 想看什么 | 去哪里 |
| --- | --- |
| 当前 daemon 状态 / 并发 / pollIntervalMs | dashboard service header 或 `GET /api/state` |
| 所有 run 列表 / 状态分布 | dashboard `/`（默认隐藏 archived） |
| 单个 run 的时间线 / tool calls / log tail / review feedback | dashboard `/runs/<runId>` |
| 实时事件流 | `GET /api/events/stream?runId=<runId>`（SSE） |
| 单个 Issue 的事件历史 | `~/.issuepilot/state/events/<project-slug>-<iid>.jsonl` |
| 单个 run 的元数据 | `~/.issuepilot/state/runs/<project-slug>-<iid>.json` |
| daemon 全局日志 | `~/.issuepilot/state/logs/issuepilot.log` |
| Workspace cleanup 历史 | `/api/events?runId=workspace-cleanup` |

### 6.2 失败 / blocked run 取证

失败 / blocked run 不会被清理。排障路径：

```bash
~/.issuepilot/state/logs/issuepilot.log
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl
~/.issuepilot/state/runs/<project-slug>-<iid>.json
~/.issuepilot/workspaces/<project-slug>/<iid>/
~/.issuepilot/workspaces/<project-slug>/<iid>/.issuepilot/failed-at-<iso>
```

其中 `.issuepilot/failed-at-*` 是 dispatcher 写的失败 context（含 cause
分类、retry 决策、错误链）。修复后可用 dashboard `Retry` 或人工把 issue
label 改回 `ai-ready` / `ai-rework`。

### 6.3 FAQ

**`codex app-server not found`**

```bash
which codex
codex app-server --help
```

如果 Codex 不在 PATH 里，在 workflow 里把 `codex.command` 改成绝对路径。

**`auth login failed ... category=invalid_client`**

GitLab 上没有注册匹配的 OAuth Application，或没启用 Device Authorization
Grant。按 [§3.4](#34-配置-gitlab-凭据) 重新注册 Application 后重试：

```bash
issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

检查 token 是否 export 到启动 daemon 的同一个 shell、是否有 `api` scope、
是否能访问目标项目。修复后重启 orchestrator。

**dashboard 显示 `orchestrator unreachable`**

dashboard 只是前端，必须另开终端启 orchestrator。如果 orchestrator 不在
`4738`，用 `NEXT_PUBLIC_API_BASE` 或 `--api-url` 指定地址。

**怎么知道 IssuePilot 写的 note 对应哪个 run？**

Issue note 第一行有 marker `<!-- issuepilot:run:<runId> -->`；最终 handoff
note 以 `## IssuePilot handoff` 开头，包含 branch、MR、实现摘要、验证结果、
风险 / 后续事项、给人工 reviewer 的下一步动作。

**改了 `ci.enabled` 没生效**

scanner 只在 daemon 启动时按 `ci.enabled` 注入 loop，必须重启
`issuepilot run`。

**V2 团队模式 dashboard 按钮显示 503**

V2 team daemon 暂未装配 operator actions，retry/stop/archive 在 team 模式
下会返回 `503 actions_unavailable`（[§5.7](#57-v2-当前的边界与未覆盖)
follow-up）。临时方案：用 V1 入口启动该项目。

**V2 团队模式磁盘越用越满**

V2 team daemon 暂未自动跑 workspace cleanup loop（[§5.6](#56-phase-5--workspace-retention-自动清理)
limitation）。手动定期跑：

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

或对该项目改用 V1 入口启动（V1 入口已激活 cleanup loop）。

---

## Part 7 — 参考

### 7.1 CLI 速查表

```bash
# 环境自检
issuepilot doctor

# Workspace cleanup dry-run（V2 Phase 5）
issuepilot doctor --workspace --workflow /path/to/WORKFLOW.md

# OAuth 登录管理
issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
issuepilot auth status --hostname <gitlab-host>
issuepilot auth logout --hostname <gitlab-host>
issuepilot auth logout --all

# 校验配置
issuepilot validate --workflow /path/to/WORKFLOW.md
issuepilot validate --config /path/to/issuepilot.team.yaml

# 渲染某个 team-mode 项目编译后的 effective workflow
# （敏感字段 / 时间戳已脱敏；可在多次配置间做 diff）
issuepilot render-workflow --config /path/to/issuepilot.team.yaml --project <id>

# 启动 orchestrator
issuepilot run --workflow /path/to/WORKFLOW.md                    # V1 单项目
issuepilot run --config /path/to/issuepilot.team.yaml             # V2 团队
issuepilot run --workflow ... --port 4738 --host 127.0.0.1

# 启动 dashboard
issuepilot dashboard
issuepilot dashboard --port 3000 --api-url http://127.0.0.1:4738
```

### 7.2 HTTP API 端点速查

```text
GET  /api/state                              orchestrator + service header
GET  /api/runs?status=...&includeArchived=true 列出 run
GET  /api/runs/:runId                        run detail
GET  /api/events?runId=...                   单 run 事件历史
GET  /api/events/stream?runId=...            SSE 实时事件流
POST /api/runs/:runId/retry                  V2 Phase 2（V1 入口可用）
POST /api/runs/:runId/stop                   V2 Phase 2（V1 入口可用）
POST /api/runs/:runId/archive                V2 Phase 2（V1 入口可用）
```

`Operator` 身份通过 HTTP header `x-issuepilot-operator` 传递；缺省为 `"system"`。

### 7.3 文档导航

- **架构图与流程图**：[`docs/superpowers/diagrams/`](./docs/superpowers/diagrams/)
- **V2 总设计与 Phase 1–5 进度**：[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- **P0 设计 spec**：[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- **Workspace cleanup runbook**：[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md)
- **真实 GitLab smoke runbook**：[`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- **CHANGELOG**：[`CHANGELOG.md`](./CHANGELOG.md)
