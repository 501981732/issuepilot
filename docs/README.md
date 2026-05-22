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
