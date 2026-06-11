# IssuePilot Agent 指南

本仓库现在作为公司内部 IssuePilot 的工作区使用。它最初是 OpenAI Symphony 的 fork，但内部产品方向是基于 TypeScript 的 IssuePilot。

## 回复语言

- 后续 agent 在本仓库内工作时，默认使用中文回答。
- 代码、命令、配置项、日志字段、API 名称和文件路径保持原文，不强行翻译。
- 如果用户明确要求英文或中英双语，再按用户要求调整。

## 文档语言

- 仓库内 repo-facing 文档默认使用中文，包括 `AGENTS.md`、`docs/superpowers/specs/`、`docs/superpowers/plans/`、runbook、实施计划和验收材料。
- 公开入口默认中文：`README.md` 是 GitHub 默认展示的中文首页，`README.zh-CN.md` 保留为中文别名，`README.en.md` 是英文版；修改 README 内容时保持三者语义同步。修改 `USAGE.md` 时同步 `USAGE.zh-CN.md`（使用手册已从 `docs/getting-started.*` 提升到根目录）。
- 文档正文使用中文；代码块、命令、配置键、API 路径、日志字段、类型名、函数名、package 名称和文件路径保持原文。

## 事实来源

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md` 是 IssuePilot 的总设计 spec / 产品源头。在规划或实现 IssuePilot 相关工作前必须先阅读它。
- `SPEC.md` 是 OpenAI Symphony 的开源通用 spec，保留作参考和对齐对象，不是 IssuePilot 内部产品架构的直接源头。
- 历史 Elixir 参考实现已从本仓库移除；当前生产路线只维护 TypeScript IssuePilot。
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

除非用户明确要求恢复历史 prototype，否则不要引入新的 Elixir 实现路线。

## 仓库边界

- 根目录规则适用于整个仓库。
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

## Cursor Cloud specific instructions

### 环境概览

- **运行时**：Node.js >=22 <23、pnpm 10.x（`packageManager` 字段锁定版本）、Git。
- **Monorepo 工具**：Turborepo（`turbo.json`），workspace 定义在 `pnpm-workspace.yaml`（`apps/*`、`packages/*`、`tests/*`）。
- **不需要 Docker** — TypeScript 产品的开发和测试不依赖任何容器服务。
- `elixir/` 目录是旧 Symphony 参考实现，需要 Elixir/OTP，与 IssuePilot TypeScript 开发无关。

### 常用命令

标准开发命令见 `README.md` "Development Setup" 和 `package.json` scripts，这里只列出非显而易见的要点：

| 用途 | 命令 |
|---|---|
| 安装依赖 | `pnpm install` |
| 构建全部 | `pnpm build`（Turborepo 按依赖拓扑编译） |
| 类型检查 | `pnpm typecheck` |
| Lint | `pnpm lint` |
| 格式检查 | `pnpm format:check` |
| 全量测试 | `pnpm test`（含 E2E + smoke） |
| 单 package 测试 | `pnpm --filter @issuepilot/<pkg> test` |
| Dashboard 开发 | `pnpm dev:dashboard`（Next.js dev，默认端口 3000） |
| Orchestrator 开发 | 先 `pnpm build`，再 `node apps/orchestrator/dist/bin.js run --workflow <path>` |
| CLI 验证 | `node apps/orchestrator/dist/bin.js doctor` / `validate --workflow <path>` |
| 完整发布门控 | `pnpm release:check` |

### 注意事项

- **必须先 build 再启动 orchestrator**：`pnpm dev:orchestrator` 内部执行 `pnpm build && node dist/bin.js`，直接运行 `node apps/orchestrator/dist/bin.js` 前需确保 `pnpm build` 已完成。
- **Orchestrator 启动需要 workflow 文件**：`issuepilot run --workflow <path>`。若 workflow 中配置了 `tracker.token_env`，对应环境变量（如 `GITLAB_TOKEN`）必须存在；否则会尝试 OAuth 凭据（需先 `issuepilot auth login`）。
- **esbuild 构建脚本警告**：`pnpm install` 时可能提示 `Ignored build scripts: esbuild@*`。esbuild 是间接依赖，当前构建和测试不受影响，无需 `pnpm approve-builds`。
- **E2E 测试偶现 flaky**：`tests/e2e/ci-feedback.test.ts` 中 `failed pipeline transitions to ai-rework` 偶尔因竞态条件失败，重跑通常通过。
- **Dashboard 连接 orchestrator**：Dashboard 默认从 `http://127.0.0.1:4738` 读取 API。若 orchestrator 使用其他地址/端口，需在 dashboard 环境变量或 `--api-url` 参数中指定。
- **Codex app-server 不可用是预期的**：`issuepilot doctor` 中 Codex check 标记为 FAIL 是正常的——Cloud VM 不安装 Codex CLI。这不影响开发、测试或 dashboard 展示。
