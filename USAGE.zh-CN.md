# IssuePilot 快速使用

[English](./USAGE.md) | 简体中文

这是仓库里唯一的 getting-started 入口。第一次使用按顺序做；需要背景材料时再看
[文档中心](./docs/README.md) 和 [Roadmap](./docs/roadmap.md)。

## 第一步：准备环境

确认本机有这些工具：

| 工具 | 要求 |
| --- | --- |
| Node.js | `>=22 <23` |
| pnpm | `10.x`，通过 `corepack` 启用 |
| Git | 能 clone、fetch、push 目标项目 |
| Codex CLI | 已登录，并能执行 `codex app-server` |
| GitLab | 一个可测试的项目，能创建 Issue、label 和 Merge Request |

IssuePilot 会把运行状态、mirror、worktree、event logs 放在 `~/.issuepilot`。

## 第二步：安装 IssuePilot

在 IssuePilot 仓库里执行：

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-*.tgz
issuepilot doctor
```

`issuepilot doctor` 里 Node.js、Git、Codex app-server、`~/.issuepilot/state`
都显示 `[OK]` 后再继续。

如果只是贡献代码、不想全局安装，可以在源码仓库里用：

```bash
pnpm build
pnpm exec issuepilot doctor
```

后面所有 `issuepilot ...` 命令都可以临时替换成 `pnpm exec issuepilot ...`。

## 第三步：准备目标项目

以下操作在要让 AI 修改的 GitLab 项目里完成。

先创建 6 个 label：

```text
ai-ready
ai-running
human-review
ai-rework
ai-failed
ai-blocked
```

再确认本机 SSH key 能 push：

```bash
ssh -T git@gitlab.example.com
```

然后在目标项目根目录提交 `WORKFLOW.md`：

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
4. 提交代码，并创建或更新 Merge Request。
5. 给 Issue 回写实现、验证、风险和 MR 链接。
6. 缺信息、权限或密钥时，把 Issue 标成 `ai-blocked` 并说明原因。
```

`tracker.project_id` 可以填项目路径或数字 ID；`git.repo_url` 推荐用 SSH
地址。不要把 token 写进 `WORKFLOW.md`。

## 第四步：配置 GitLab 凭据

个人机器推荐 OAuth：

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

如果使用 PAT / Group Access Token / Project Access Token，就在 `WORKFLOW.md`
的 `tracker` 段加环境变量名：

```yaml
tracker:
  base_url: "https://gitlab.example.com"
  token_env: "GITLAB_TOKEN"
```

启动前 export：

```bash
export GITLAB_TOKEN="<gitlab token>"
```

`token_env` 的值只能是环境变量名，不能是 token 本身。

## 第五步：校验配置

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot validate --workflow "$WORKFLOW_PATH"
```

看到下面输出说明配置可用：

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

## 第六步：启动 IssuePilot

开两个终端。

终端 A 启动 orchestrator：

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH" --host 127.0.0.1 --port 4738
```

终端 B 启动 dashboard：

```bash
issuepilot dashboard
```

打开：

```text
http://localhost:3000
```

如果从源码启动 dashboard：

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

## 第七步：跑第一个 Issue

1. 在目标 GitLab 项目里创建一个很小的测试 Issue。
2. 给它加 `ai-ready` label。
3. 在 dashboard 看 run 是否出现。
4. 等 IssuePilot 创建 branch 和 MR。
5. 检查 MR、handoff note、验证结果和风险说明。
6. 能合并就人工 merge；需要返工就把 Issue 标成 `ai-rework`。

IssuePilot 不会自动 merge MR。

## 多项目启动

如果一台机器要同时管理多个项目，准备一个中心化配置目录，然后使用：

```bash
issuepilot validate --config /path/to/issuepilot.team.yaml
issuepilot run --config /path/to/issuepilot.team.yaml --host 127.0.0.1 --port 4738
issuepilot dashboard
```

中心化配置的设计背景见
[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| dashboard 显示 `GET /api/state failed` | 确认 orchestrator 正在跑，dashboard 连的是 `http://127.0.0.1:4738` |
| GitLab 返回 401 / 403 | 检查 OAuth 登录态，或确认 `token_env` 指向的环境变量已经 export |
| Codex runner 不可用 | 重新登录 Codex CLI，再跑 `issuepilot doctor` |
| 无法 push branch | 检查 `git.repo_url`、SSH key、目标项目权限 |
| workspace 状态混乱 | 停掉 daemon 后检查 `~/.issuepilot/workspaces` 和 `~/.issuepilot/state/events` |

## 文档导航

- [文档中心](./docs/README.md)
- [Roadmap](./docs/roadmap.md)
- [IssuePilot 总设计 spec](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [V4 架构图](./docs/superpowers/diagrams/v4-architecture.svg)
- [V4 端到端流程图](./docs/superpowers/diagrams/v4-flow.svg)
