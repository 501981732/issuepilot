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
