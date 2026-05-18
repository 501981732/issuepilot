# IssuePilot Agent 指南

本仓库现在作为公司内部 IssuePilot 的工作区使用。它最初是 OpenAI Symphony 的 fork，但内部产品方向是基于 TypeScript 的 IssuePilot。

## 回复语言

- 后续 agent 在本仓库内工作时，默认使用中文回答。
- 代码、命令、配置项、日志字段、API 名称和文件路径保持原文，不强行翻译。
- 如果用户明确要求英文或中英双语，再按用户要求调整。

## 文档语言

- 仓库内 repo-facing 文档默认使用中文，包括 `AGENTS.md`、`docs/superpowers/specs/`、`docs/superpowers/plans/`、runbook、实施计划和验收材料。
- 公开双语入口继续保持中英文同步：修改 `README.md` 时同步 `README.zh-CN.md`，修改 `USAGE.md` 时同步 `USAGE.zh-CN.md`（使用手册已从 `docs/getting-started.*` 提升到根目录）。
- 文档正文使用中文；代码块、命令、配置键、API 路径、日志字段、类型名、函数名、package 名称和文件路径保持原文。

## 事实来源

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md` 是 IssuePilot 的总设计 spec / 产品源头。在规划或实现 IssuePilot 相关工作前必须先阅读它。
- `SPEC.md` 是 OpenAI Symphony 的开源通用 spec，保留作参考和对齐对象，不是 IssuePilot 内部产品架构的直接源头。
- `elixir/` 是 OpenAI Symphony 的 Elixir 参考实现，修改该目录时遵守 `elixir/AGENTS.md`，不要把它当作 TypeScript IssuePilot 的生产实现路线。
- `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md` 是用于对比根 `SPEC.md`、当前实现和 P0 收口差距的补充 spec，不替代总设计 spec。
- `docs/superpowers/plans/` 下的文件是实施计划、runbook 或验收材料，用于执行和追踪，不作为产品源头。
- 如果修改产品行为、架构、workflow labels、runner 行为或路线图范围，必须在同一变更中更新 IssuePilot 设计 spec。

## 项目方向

IssuePilot P0 是：

- GitLab Issue 驱动。
- 基于 label 表达状态：`ai-ready`、`ai-running`、`human-review`、`ai-rework`、`ai-failed`、`ai-blocked`。
- 第一版就使用 Codex app-server。
- 使用 TypeScript 实现，orchestrator 是独立 Node daemon，dashboard 使用 Next.js。
- 使用 `~/.issuepilot` 下的 git worktree workspace。

除非用户明确要求 prototype 工作，否则不要通过扩展 Elixir prototype 来实现内部产品。

## 仓库边界

- 根目录规则适用于整个仓库。
- `elixir/AGENTS.md` 适用于 `elixir/` 内部变更，修改 Symphony Elixir 参考实现时必须遵守。
- 新的 IssuePilot 实现代码应遵循设计 spec 中的目录规划：
  - `apps/orchestrator`
  - `apps/dashboard`
  - `packages/core`
  - `packages/workflow`
  - `packages/tracker-gitlab`
  - `packages/workspace`
  - `packages/runner-codex-app-server`
  - `packages/observability`
  - `packages/shared-contracts`

## 实现规则

- P0 聚焦本地单机闭环，不提前扩展团队服务能力。
- orchestrator 必须独立于 Next.js。Next.js 只负责 dashboard。
- orchestrator HTTP API 使用 Fastify。
- dashboard UI 使用 Tailwind/shadcn。
- 任何涉及 UI、UX、前端交互、页面布局、视觉风格或可用性体验的设计/实现/评审任务，必须先启用 `ui-ux-pro-max` skill（用户写作 `ux-ux-pro-max` 时按同一技能理解），再开始方案或代码修改。
- GitLab 凭据从 `tracker.token_env` 配置的环境变量读取；不要把 token 写入 workflow 文件、日志、dashboard 数据或 prompt。
- mirror、worktree、branch、fetch、push 等 Git 操作优先通过 `execa` 调用真实 Git CLI。
- Codex 的 cwd 和 sandbox 必须限制在当前 issue worktree。
- 失败运行需要保留 workspace 和 event logs，便于排障。

## 验证要求

文档类变更至少运行：

```bash
git diff --check
```

涉及代码（orchestrator / dashboard / packages / tests）的变更，交付前优先运行：

```bash
scripts/ci-equivalent-check.sh
```

该脚本把 V4.3 acceptance 列出的 gate 串成单一入口（`tsc -b`、`tsc -p scripts/tsconfig.json`、`next build`、`eslint --max-warnings 0`、各 package 的 `vitest run`、`git diff --check`），用于在缺少 `pnpm` / `corepack` 或默认 runtime 不能跑 Rollup native binding 的机器上提供与 `pnpm -r build|lint|test` 等价的本地 gate。该脚本会自动尝试 `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`，可通过 `NODE_BIN_DIR=...` 显式指定 Node runtime；快速反馈可用 `SKIP_E2E=1`。

`pnpm -r build|lint|test` 仍是受支持入口；只要本机有 `pnpm` / `corepack` 且默认 Node 能加载 Rollup native module，可以直接用它替代脚本。但发布或合并前必须有一种通过的 gate（脚本或 `pnpm -r`），不能仅以「单测通过」收口。

## Git 规范

- 不要触碰无关的未跟踪文件或用户改动。
- 除非用户明确要求，不要 rewrite history，也不要 reset worktree。
- commit 保持边界清晰：设计/spec 更新和实现代码分开提交。
