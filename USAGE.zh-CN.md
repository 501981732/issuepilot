# IssuePilot 快速使用

[English](./USAGE.md) | 简体中文

这是仓库里唯一的 getting-started 入口。第一次使用按顺序做；需要背景材料时再看
[文档中心](./docs/README.md) 和 [Roadmap](./docs/roadmap.md)。

先区分两件事：

1. 安装 IssuePilot：在当前 IssuePilot 源码仓库里执行。
2. 运行 IssuePilot：在中心化配置目录执行，默认读取 `./issuepilot.team.yaml`。

安装完成后的常见启动方式是：

```bash
cd /path/to/issuepilot-config
issuepilot validate
issuepilot run
```

然后另开一个终端：

```bash
issuepilot dashboard
```

这里的 `/path/to/issuepilot-config` 是中心化配置目录，不是目标项目目录。
目标项目路径、GitLab project、workflow profile 都写在中心化配置里。

如果不想切到配置目录，也可以显式指定：

```bash
issuepilot validate --config /path/to/issuepilot-config/issuepilot.team.yaml
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml
```

下面的步骤会从安装、GitLab 凭据、中心化配置到启动顺序完整走一遍。

## 第一步：准备环境

确认本机有这些工具：

| 工具      | 要求                                                   |
| --------- | ------------------------------------------------------ |
| Node.js   | `>=22 <23`                                             |
| pnpm      | `10.x`，通过 `corepack` 启用                           |
| Git       | 能 clone、fetch、push 目标项目                         |
| Codex CLI | 已登录，并能执行 `codex app-server`                    |
| GitLab    | 一个可测试的项目，能创建 Issue、label 和 Merge Request |

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

## 第三步：准备中心化配置

准备一个配置目录，例如：

```text
issuepilot-config/
  issuepilot.team.yaml
  projects/
    platform-web.yaml
  workflows/
    default-web.md
```

`issuepilot.team.yaml`：

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

projects:
  - id: platform-web
    name: Platform Web
    enabled: true
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md
```

`projects/platform-web.yaml`：

```yaml
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/platform-web"

git:
  repo_url: "git@gitlab.example.com:group/platform-web.git"
  base_branch: main
  branch_prefix: ai
```

`workflows/default-web.md`：

```md
---
agent:
  runner: codex-app-server
  max_turns: 10
  max_attempts: 2
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
```

## 第四步：准备目标项目

在要让 AI 修改的 GitLab 项目里创建 6 个 label：

```text
ai-ready
ai-running
human-review
ai-rework
ai-failed
ai-blocked
```

确认本机 SSH key 能 push：

```bash
ssh -T git@gitlab.example.com
```

不要把 token 写进任何配置文件。

## 第五步：配置 GitLab 凭据

个人机器使用 OAuth：

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

中心化 project file 不写 `tracker.token_env`，也不要保存 token 值。

## 第六步：校验并启动

```bash
cd /path/to/issuepilot-config
issuepilot validate
```

开两个终端。

终端 A 启动 orchestrator：

```bash
issuepilot run
```

终端 B 启动 dashboard：

```bash
issuepilot dashboard
```

打开：

```text
http://localhost:3000
```

如果不在配置目录，可以传 `--config`：

```bash
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml
```

## 第七步：跑第一个 Issue

1. 在目标 GitLab 项目里创建一个很小的测试 Issue。
2. 给它加 `ai-ready` label。
3. 在 dashboard 看 run 是否出现。
4. 等 IssuePilot 创建 branch 和 MR。
5. 检查 MR、handoff note、验证结果和风险说明。
6. 能合并就人工 merge；需要返工就把 Issue 标成 `ai-rework`。

IssuePilot 不会自动 merge MR。

## 兼容：单项目 `WORKFLOW.md`

`--workflow` 不是中心化配置路径的必填参数。它只用于旧的单项目 `WORKFLOW.md`
方式：

```bash
issuepilot run --workflow /path/to/target-project/WORKFLOW.md
```

中心化配置的设计背景见
[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)。

## 常见问题

| 问题                                   | 处理                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| dashboard 显示 `GET /api/state failed` | 确认 orchestrator 正在跑，dashboard 连的是 `http://127.0.0.1:4738`            |
| GitLab 返回 401 / 403                  | 检查 OAuth 登录态和目标项目权限                                               |
| Codex runner 不可用                    | 重新登录 Codex CLI，再跑 `issuepilot doctor`                                  |
| 无法 push branch                       | 检查 `git.repo_url`、SSH key、目标项目权限                                    |
| workspace 状态混乱                     | 停掉 daemon 后检查 `~/.issuepilot/workspaces` 和 `~/.issuepilot/state/events` |

## 文档导航

- [文档中心](./docs/README.md)
- [Roadmap](./docs/roadmap.md)
- [IssuePilot 总设计 spec](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [V4 架构图](./docs/superpowers/diagrams/v4-architecture.svg)
- [V4 端到端流程图](./docs/superpowers/diagrams/v4-flow.svg)
