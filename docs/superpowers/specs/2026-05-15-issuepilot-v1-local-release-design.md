# IssuePilot V1 可安装本地发布设计

日期：2026-05-15
状态：已确认，进入实施计划
关联文档：

- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md`
- `docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`
- `README.md`
- `README.zh-CN.md`

## 1. 背景

IssuePilot P0 已经完成 GitLab Issue 到 Codex app-server run、MR handoff、
human-review closure、事件记录和只读 dashboard 的本地闭环。P0 gap 收口后，
下一个关键目标不只是“从源码 checkout 能跑”，而是让使用者可以通过安装命令获得
`issuepilot` CLI，并用稳定命令启动本地 daemon 和 dashboard。

因此 V1 不再定义为单纯的 source-checkout 稳定版，而是定义为 **可安装的本地发布版**。
source-checkout 仍保留给贡献者开发、调试和紧急回滚，但不是 V1 的主要用户入口。

## 2. 目标

V1 交付一个 installable local release。目标使用路径是：

```bash
# 安装方式可由实现阶段确定为 npm registry、internal registry 或本地 tarball
npm install -g <issuepilot-package>

issuepilot doctor
issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
issuepilot run --workflow /path/to/target-project/WORKFLOW.md
issuepilot dashboard
```

V1 完成后，一个使用者应该能够：

1. 通过安装命令获得 `issuepilot` 可执行命令。
2. 不进入 IssuePilot 源码仓库，也能运行 `issuepilot doctor`、`validate`、`run`。
3. 使用已安装命令启动本地 dashboard。
4. 按 README / 根目录 `USAGE.zh-CN.md` 完成安装、配置、启动和真实 GitLab smoke。
5. 用 `pnpm release:check` 在发布前验证构建、测试、打包和本地安装 smoke。
6. 遇到问题时按文档定位 auth、workflow、daemon、runner、workspace、event logs。
7. 如需回滚，安装上一版本 package 或切回源码 checkout 的上一 tag。

## 3. 非目标

V1 不做以下内容：

- 多项目 workflow 配置。
- 团队共享 daemon 或多用户 dashboard。
- dashboard 写操作，例如 `retry`、`stop`、`archive run`。
- CI 失败自动回流到 `ai-rework`。
- 自动 merge MR。
- 正式的 `~/.issuepilot` 本地状态迁移指南。
- Docker / Kubernetes sandbox。
- Postgres / SQLite run history。

这些能力仍放到 V2 或更后续版本。

## 4. 分发形态

V1 的分发目标是 npm-compatible package tooling。实现阶段可以在以下两种路径中
选择风险更低的一种：

1. **registry package**：发布到 npm 或 internal registry，用户通过
   `npm install -g <package>` 或 `pnpm add -g <package>` 安装。
2. **local tarball**：用 `pnpm pack` 生成 tarball，用户通过
   `npm install -g ./issuepilot-*.tgz` 安装。

V1 必须满足：

- 安装后 PATH 中存在 `issuepilot` 命令。
- `issuepilot --version` 输出 package 版本。
- `issuepilot doctor` 可在任意目录运行。
- `issuepilot run --workflow <path>` 可启动 orchestrator daemon/API。
- dashboard 有安装后启动方式，不要求用户进入源码仓库运行 `pnpm dev:dashboard`。
- source-checkout 仍可作为开发路径，但 README 的 V1 主路径应以安装命令为准。

## 5. CLI 和 Dashboard 边界

当前 `apps/orchestrator` 已经声明 `bin.issuepilot = ./dist/bin.js`。V1 需要把这个能力
从 workspace 内部命令升级成可安装 CLI。

V1 的本地进程模型保持 P0 决策：

- `issuepilot run` 启动 orchestrator daemon/API。
- dashboard 仍是本地只读 UI，不提供写操作。
- dashboard 可以通过 `issuepilot dashboard` 或等价已安装命令启动。
- `issuepilot run` 不强制托管 dashboard 子进程，避免把 Next.js 生命周期、端口冲突、
  日志转发和退出信号耦合进 daemon。

如果实现阶段发现 bundling Next.js dashboard 风险过高，允许 V1 降级为：

```bash
issuepilot dashboard --api http://127.0.0.1:4738
```

该命令内部可以启动预构建 dashboard，也可以启动一个轻量静态 dashboard server；
但用户入口必须是已安装的 `issuepilot` 命令，而不是 `pnpm dev:dashboard`。

## 6. V1 Release Gate

新增统一检查命令：

```bash
pnpm release:check
```

它应该串行执行：

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm build`
5. `pnpm test`
6. package 打包检查，例如 `pnpm pack` 或 publish dry-run。
7. 本地安装 smoke：在临时目录安装打包产物并运行 `issuepilot --version`、
   `issuepilot doctor`、`issuepilot validate --workflow <fixture>`。
8. `pnpm test:smoke`
9. `git diff --check`

真实 GitLab smoke 不进入自动脚本，因为它依赖外部 GitLab sandbox、token、SSH key
和 Codex 登录态。V1 只要求 smoke runbook 提供固定 evidence 字段。

## 7. 版本和变更记录

V1 需要新增或更新：

- `CHANGELOG.md`
- package version，例如 `0.1.0`
- README / README.zh-CN 的安装路径和启动命令
- 根目录 `USAGE.zh-CN.md` / `USAGE.md` 的安装版 quickstart
- smoke runbook 的 release evidence 字段

`CHANGELOG.md` 至少记录：

- `0.1.0` 版本目标
- P0 gap closure 摘要
- V1 installable CLI 支持边界
- 已知非目标
- 验证命令

## 8. 文档边界

V1 文档应保持这些说法一致：

- `WORKFLOW.md` 是目标仓库默认 workflow 文件。
- 用户主入口是安装后的 `issuepilot` 命令。
- IssuePilot CLI 负责启动 orchestrator、dashboard 和本地诊断命令。
- 目标项目仓库负责持有 `WORKFLOW.md` 和被 agent 修改的代码。
- `issuepilot run --workflow ...` 启动 orchestrator daemon，并等待 API ready。
- dashboard 通过已安装命令启动。
- MR merge 由人类完成，IssuePilot 只负责 merged 后收尾。
- V1 不要求本地状态迁移；单人试点期间如遇不可恢复状态，可以停止 daemon 后清理
  具体 workspace 或 repo cache。
- source-checkout 是开发/回滚路径，不是 V1 用户主路径。

## 9. 错误处理和回滚

V1 的回滚策略：

```bash
npm uninstall -g <issuepilot-package>
npm install -g <previous-issuepilot-package>
```

如果使用本地 tarball：

```bash
npm uninstall -g <issuepilot-package>
npm install -g ./issuepilot-previous.tgz
```

如果回滚到源码 checkout：

```bash
git fetch --tags
git checkout <previous-tag-or-commit>
pnpm install
pnpm build
pnpm exec issuepilot run --workflow /path/to/target-project/WORKFLOW.md
```

如果本地 run 卡住或状态异常：

1. 停止 `issuepilot run` / daemon。
2. 检查 `~/.issuepilot/state` 下对应 run record 和 event log。
3. 检查目标 GitLab Issue labels、handoff note、MR 状态。
4. 必要时手动移除 `ai-running`，切回 `ai-ready`、`ai-rework` 或人工处理。
5. 只有明确知道对应 workspace / repo cache 不再需要时，才手动清理相关目录。

这不是正式迁移指南，只是本地单人试点的排障边界。

## 10. 测试策略

V1 需要覆盖四层验证：

1. 自动检查：`pnpm release:check`。
2. 打包检查：package 产物包含 CLI、运行时代码、dashboard 产物和必要 package metadata。
3. 本地安装 smoke：从打包产物安装后运行 `issuepilot --version`、`doctor`、`validate`。
4. 人工真实 smoke：按 runbook 填写固定 evidence。

Release evidence 建议包含：

- 安装命令和版本输出
- Issue URL
- MR URL
- Dashboard run URL
- Handoff note 摘要
- Closing note 摘要
- 本地命令输出摘要
- 最终 labels / issue state
- 已知风险或人工介入点

## 11. 完成标准

V1 完成时应满足：

1. 安装后可以直接运行 `issuepilot --version`、`doctor`、`validate`、`run`。
2. 安装后可以启动本地 dashboard。
3. `package.json` 提供 `pnpm release:check`。
4. README / README.zh-CN / `USAGE.zh-CN.md` / `USAGE.md` 与 V1 安装路径一致。
5. `CHANGELOG.md` 存在并记录 `0.1.0`。
6. smoke runbook 有固定 release evidence 模板。
7. 主设计 spec §20 与本 V1 设计一致。
8. `pnpm release:check` 本地通过。
9. PR 描述包含 V1 release gate 和未进入 V1 的能力清单。
