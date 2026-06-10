# IssuePilot

[English](README.en.md) | [简体中文](README.md)

IssuePilot 是一个本地运行的 GitLab Issue AI 执行器。你给 GitLab Issue 打上
`ai-ready`，IssuePilot 会创建隔离 worktree，调用 Codex app-server 完成修改，
然后提交 branch、创建 Merge Request，并把结果交给人工 review。

一句话理解：

```text
GitLab Issue -> IssuePilot 本机调度 -> Codex 改代码 -> GitLab MR -> 人工 review
```

IssuePilot 不会自动 merge MR，也不是 SaaS。它适合先在个人电脑或团队机器上试点。

![IssuePilot Command Center](./docs/assets/screenshots/dashboard-command-center.png)

## 你需要先知道的几个目录

新手最容易混淆的是“在哪个目录执行命令”。先记住这三个概念：

| 目录                | 用途                                                           | 你是否必须进去                                  |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------- |
| IssuePilot 源码仓库 | 也就是当前这个 `symphony` checkout，用来安装或开发 IssuePilot  | 安装时进去                                      |
| 中心化配置目录      | 放 `issuepilot.team.yaml`、`projects/*.yaml`、`workflows/*.md` | 进入该目录启动，或用 `--config` 指定            |
| 目标项目            | 你希望 AI 修改的真实 GitLab 项目                               | 不需要进去，配置里写 GitLab project 和 repo URL |
| `~/.issuepilot`     | IssuePilot 自动创建的 mirror、worktree、日志和状态目录         | 一般不用手动进去                                |

所以，安装 IssuePilot 和运行某个业务项目是两件事：

1. 在当前仓库安装 `issuepilot` 命令。
2. 准备一个中心化配置目录。
3. 启动 IssuePilot，让它读取 `issuepilot.team.yaml`。

## 最短安装路径

在当前 IssuePilot 源码仓库里执行：

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-*.tgz
issuepilot doctor
```

`issuepilot doctor` 全部显示 `[OK]` 后，说明本机安装完成。

如果只是开发源码、不想全局安装，可以用：

```bash
pnpm build
pnpm exec issuepilot doctor
```

## 最短使用路径

准备中心化配置后启动：

```bash
cd /path/to/issuepilot-config
issuepilot validate
issuepilot run
```

另开一个终端启动 dashboard：

```bash
issuepilot dashboard
```

打开：

```text
http://localhost:3000
```

## 第一次接入目标项目要做什么

目标项目是 IssuePilot 真正要操作的 GitLab 仓库。第一次接入时需要准备：

1. 一个可 push 的 GitLab 项目。
2. 6 个 label：`ai-ready`、`ai-running`、`human-review`、`ai-rework`、`ai-failed`、`ai-blocked`。
3. 中心化配置里的项目文件和 workflow profile。
4. GitLab OAuth 或 token 环境变量。
5. 一个带 `ai-ready` label 的测试 Issue。

完整示例见 [快速使用](./USAGE.zh-CN.md)。

## 它会做什么

1. 轮询带 `ai-ready` 或 `ai-rework` 的 GitLab Issue。
2. 为每个任务创建隔离 worktree。
3. 在 worktree 内启动 Codex app-server runner。
4. 创建或更新 branch 和 Merge Request。
5. 写回 Issue handoff note、验证结果、风险说明和 MR 链接。
6. 在 dashboard 展示 run、work item、review packet 和 reports。

![IssuePilot Run Detail](./docs/assets/screenshots/dashboard-run-detail.png)

## 继续阅读

- [快速使用中文](./USAGE.zh-CN.md)：从安装到跑第一个 Issue。
- [Quick Start English](./USAGE.md)：英文快速使用。
- [文档中心](./docs/README.md)：设计、路线图和架构材料。
- [Roadmap](./docs/roadmap.md)：版本规划。
- [IssuePilot 总设计 spec](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)：产品和架构源头。

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

见 [LICENSE](./LICENSE)。
