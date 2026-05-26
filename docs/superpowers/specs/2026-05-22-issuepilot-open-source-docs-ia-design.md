# IssuePilot Open Source Docs IA 设计

日期：2026-05-22
状态：实施完成

关联文档：

- `README.md`
- `README.zh-CN.md`
- `README.en.md`
- `USAGE.md`
- `USAGE.zh-CN.md`
- `CHANGELOG.md`
- `docs/superpowers/specs/2026-05-11-issuepilot-design.md`
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

## 1. 决策

IssuePilot 当前的文档问题不是内容不足，而是入口层级不清。开源读者进入仓库后，
会先看到内部路线图、V2/V4 phase 细节和 `docs/superpowers/*` 归档材料，无法快速
判断：

1. IssuePilot 是什么？
2. 为什么值得试？
3. 怎样 5 分钟启动本地开发环境？
4. 怎样 30 分钟跑通第一个 GitLab Issue？
5. 哪些内容是用户指南，哪些只是内部设计/验收历史？

因此第一轮文档重构采用 **开源入口重构 + 内部设计归档保留**。

不删除 `docs/superpowers/specs/`、`docs/superpowers/plans/`、`SPEC.md` 或
`elixir/`。这些仍是设计源、历史验收和参考实现，但不再作为开源读者的第一层入口。

## 2. 目标

第一轮重构完成后：

- `README.md` / `README.zh-CN.md` / `README.en.md` 像开源项目首页，而不是内部进度报告。
- 新读者能在 README 前 1-2 屏内理解产品定位、核心价值、当前成熟度和启动路径。
- `docs/README.md` 成为文档中心，清楚区分 Getting Started、Guides、Operations、
  Reference、Roadmap、Internal Design Archive。
- README 和 docs 首页要有真实 dashboard 截图、架构图和端到端流程图入口，让读者
  在第一屏就能看到产品实际长什么样。
- 启动文档独立成 `docs/getting-started.*.md`，避免用户在 1200 行使用手册里找启动命令。
- `USAGE.md` / `USAGE.zh-CN.md` 从全量长手册降级为用户指南索引或保留为深度 guide，
  但 README 不再把它当作唯一入口。
- Roadmap 从 README 抽到 `docs/roadmap.md`，README 只保留短状态和下一步。
- `CHANGELOG.md` 不再被 README 当作主导航入口；历史流水账后续可再归档。

## 3. 非目标

第一轮不做：

- 不引入 Docusaurus、VitePress、Mintlify 或其他 docs site。
- 不重写所有 `docs/superpowers/*` 历史 spec / plan。
- 不删除 OpenAI Symphony `SPEC.md` 或 `elixir/`。
- 不改变产品行为、CLI、API、dashboard UI 或 roadmap 决策。
- 不把文档改成纯营销页；README 必须仍然给出真实成熟度和当前限制。
- 不一次性拆完 `USAGE.md` 的所有章节；第一轮只做入口和启动路径收敛。

## 4. 信息架构

### 4.1 第一层：仓库根入口

根目录保留：

| 文件 | 角色 |
| --- | --- |
| `README.md` | 中文默认开源首页 |
| `README.zh-CN.md` | 中文别名，与 `README.md` 语义同步 |
| `README.en.md` | 英文开源首页 |
| `USAGE.md` | 英文用户指南索引或深度用户手册入口 |
| `USAGE.zh-CN.md` | 中文用户指南索引或深度用户手册入口 |
| `CHANGELOG.md` | 版本变更摘要，不承担产品介绍 |
| `SPEC.md` | OpenAI Symphony language-agnostic reference spec |
| `AGENTS.md` | agent 工作规则，不面向普通开源读者 |

### 4.2 第二层：公开 docs 目录

新增或重写：

```text
docs/
  README.md
  getting-started.md
  getting-started.zh-CN.md
  roadmap.md
  assets/
    screenshots/
      dashboard-command-center.png
      dashboard-run-detail.png
      dashboard-work-item-review-packet.png
      dashboard-reports.png
  guides/
    single-project.md
    team-mode.md
    workflow.md
  operations/
    troubleshooting.md
  reference/
    cli.md
    http-api.md
  superpowers/
    specs/
    plans/
    runbooks/
    diagrams/
```

第一轮必须新增：

- `docs/README.md`
- `docs/getting-started.md`
- `docs/getting-started.zh-CN.md`
- `docs/roadmap.md`
- `docs/assets/screenshots/` 下至少 2 张 IssuePilot dashboard 真实截图

第一轮可以先不创建 `guides/`、`operations/`、`reference/` 的所有拆分文件；如果实现时
需要降低 `USAGE` 篇幅，可以从 `USAGE` 中拆出其中 1-2 个最明显的章节。

### 4.3 第三层：内部设计归档

`docs/superpowers/` 保留为内部设计和 agent 工作流归档：

- `docs/superpowers/specs/`：设计 spec 和产品源头。
- `docs/superpowers/plans/`：实施计划、验收记录、历史 runbook。
- `docs/superpowers/runbooks/`：操作员 SOP。
- `docs/superpowers/diagrams/`：图源和渲染产物。

`docs/README.md` 必须明确这层不是新读者第一入口，而是深入设计和历史验收材料。

## 5. README 新结构

README 第一轮目标长度：约 220-320 行。

建议结构：

1. **Hero**
   - 一句话：IssuePilot turns GitLab Issues into isolated, reviewable AI engineering runs.
   - 中文 README 用中文表达，技术名词保留英文。
   - 3 个快速链接：Get started、Docs、Roadmap。
   - Hero 下方放一张真实 dashboard 截图或截图拼图，优先展示 Command Center /
     Run Detail / Review Packet，而不是抽象插画。
2. **Why IssuePilot**
   - 说明痛点：团队不该监督 agent 会话，而应该管理 Issue/MR/Review。
3. **How it works**
   - 6 步流程：`ai-ready` → worktree → Codex runner → MR → human-review → close Issue。
4. **Core capabilities**
   - Issue-driven orchestration。
   - Isolated workspace。
   - GitLab MR handoff。
   - Review Packet / Evidence。
   - Review feedback / rework plan。
   - Local-first / team-machine mode。
5. **Current maturity**
   - P0/V1/V2/V4 一句话状态。
   - 明确限制：not SaaS、not automatic merge、V3 production platform 未开始。
6. **Quick start**
   - 源码开发启动：`corepack enable`、`pnpm install`、`pnpm build`、`pnpm dev:orchestrator`、`pnpm dev:dashboard`。
   - 安装态启动指向 `docs/getting-started.*.md`。
7. **Documentation**
   - `docs/README.md`
   - Getting Started
   - User Guide
   - Roadmap
   - Architecture / diagrams
8. **Contributing**
   - 简短贡献说明和 gate。
9. **License**

README 不再内嵌完整 roadmap、V2/V4 phase 细节、长 implementation status 或内部 spec/plan 列表。

## 6. Visual Assets / Screenshots

开源文档必须让读者看到真实产品界面。第一轮至少补齐：

| 资产 | 目标位置 | 用途 |
| --- | --- | --- |
| `docs/assets/screenshots/dashboard-command-center.png` | README hero、`docs/README.md` | 展示 IssuePilot 的 List / Board / service health 第一印象 |
| `docs/assets/screenshots/dashboard-run-detail.png` | `docs/getting-started.*.md` | 展示一次 run 的 timeline、MR、events、review feedback |
| `docs/assets/screenshots/dashboard-work-item-review-packet.png` | `docs/roadmap.md` 或 `docs/README.md` | 展示 V4 Review Packet / Evidence 能力 |
| `docs/assets/screenshots/dashboard-reports.png` | `docs/roadmap.md` | 展示 Reports / quality analytics / review workflow |
| `docs/superpowers/diagrams/v4-architecture-handdrawn.svg` | README / docs / roadmap | 面向新读者的 V4.10 手绘架构教育信息图 |
| `docs/superpowers/diagrams/v4-flow-handdrawn.svg` | README / docs / roadmap | 面向新读者的 V4.10 手绘端到端流程教育信息图 |
| `docs/superpowers/diagrams/v4-architecture.svg` | README / docs | 当前 V4.10 架构图入口 |
| `docs/superpowers/diagrams/v4-flow.svg` | README / docs | 当前 V4.10 端到端流程图入口 |
| `docs/superpowers/diagrams/v2-architecture.svg` | docs / roadmap | 历史 V2 runtime foundation 架构图 |
| `docs/superpowers/diagrams/v2-flow.svg` | docs / roadmap | 历史 V2 lifecycle 流程图 |

截图要求：

- 必须来自当前 TypeScript IssuePilot dashboard，不使用旧 `.github/media/elixir-screenshot.png`
  或 OpenAI Symphony prototype 截图。
- 使用本地 fixture / demo data / seeded state；敏感信息、真实 token、真实公司项目名、
  私有 GitLab URL 必须脱敏。
- 图片放在 `docs/assets/screenshots/`，README 使用相对路径引用并写清 alt text。
- 截图宽度建议 1440px；若要展示移动端，单独补 mobile 截图，不把 desktop 图硬压缩。
- README 默认链接当前 V4.10 手绘信息图和精确 Mermaid 架构图 / 流程图；V2 图作为
  historical diagrams 保留在 docs / roadmap 中，避免把旧图误认为最新全貌。
- 如果本地 dashboard 无法启动，第一轮 implementation plan 必须先记录 blocker；
  不能用假图或 stock-like 图片替代。

## 7. Getting Started 文档

`docs/getting-started.zh-CN.md` 和 `docs/getting-started.md` 是启动文档，不是全量用户手册。

必须覆盖：

- 环境要求：Node.js 22、pnpm 10、Git、Codex CLI、GitLab 测试项目。
- 从源码启动：
  - `corepack enable`
  - `pnpm install`
  - `pnpm build`
  - `pnpm exec issuepilot doctor`
  - `pnpm dev:orchestrator`
  - `pnpm dev:dashboard`
- 安装本地 tarball：
  - `pnpm release:pack`
  - `npm install -g ./dist/release/issuepilot-*.tgz`
  - `issuepilot doctor`
- 第一个 `WORKFLOW.md` 最小示例。
- GitLab label 准备。
- 启动 V1 single-project run。
- 启动 dashboard 后的预期截图或截图链接，帮助用户确认“我启动对了”。
- 常见启动失败：
  - dashboard unreachable。
  - GitLab token missing / 401 / 403。
  - Codex app-server unavailable。
  - SSH cannot push。
  - workspace cleanup / state path。

不放：

- V4.1-V4.10 每个能力的 API。
- 长 team config 示例。
- 完整 HTTP API 速查。
- 内部 acceptance 历史。

## 8. Roadmap 文档

新增 `docs/roadmap.md`，把 README 中当前 roadmap 压缩搬迁。

结构：

1. Current status。
2. Completed local/team runtime。
3. V4 intelligent workbench。
4. V4 pilot hardening。
5. V3 production execution platform。
6. Non-goals / deferred work。
7. Source-of-truth links。

Roadmap 用开源读者能理解的能力域写，不再逐条展开所有 commit/acceptance 记录。详细设计仍链接到 `docs/superpowers/specs/`。

## 9. USAGE 收敛

第一轮有两种可接受落地方式：

### 方式 A：保留长 USAGE，但 README 降权

`USAGE.md` / `USAGE.zh-CN.md` 暂不大改，只在顶部加说明：

- 如果第一次启动，先看 `docs/getting-started.*.md`。
- 本文件是完整用户手册，包含 V1/V2/V4 深度操作。
- 文档导航看 `docs/README.md`。

### 方式 B：把 USAGE 改成索引

把 `USAGE.md` / `USAGE.zh-CN.md` 改成 150-250 行的用户指南入口，把深度章节迁移到
`docs/guides/`、`docs/operations/`、`docs/reference/`。

第一轮推荐方式 A。理由：风险低、改动可控、能快速改善开源第一印象。方式 B 可以作为第二轮。

## 10. 语言同步规则

- `README.md` 和 `README.zh-CN.md` 语义同步，中文为主。
- `README.en.md` 与中文 README 语义同步，但不要求逐字句式一致。
- `docs/getting-started.zh-CN.md` 与 `docs/getting-started.md` 语义同步。
- `docs/README.md` 可以用英文优先或中英混合；第一轮建议中文为主，英文链接清晰。
- 技术名词、命令、配置字段、API 路径、label、runner kind 保持原文。

## 11. 验收标准

第一轮文档重构完成时：

- README 三语版本不超过 350 行/文件。
- 根 README 前 100 行能说明产品定位、核心价值和当前成熟度。
- `docs/README.md` 提供清晰文档地图。
- `docs/getting-started.*.md` 能独立指导本地启动。
- `docs/roadmap.md` 承接 README 中的长 roadmap。
- README 或 `docs/README.md` 至少展示 1 张真实 dashboard 截图。
- `docs/assets/screenshots/` 至少包含 2 张当前 IssuePilot dashboard 截图。
- README / docs 明确链接当前 V4 架构图和端到端流程图，并把 V2 图标注为历史图。
- `USAGE.*.md` 顶部明确自己不是第一次启动入口。
- `git diff --check` 通过。
- 若只改 markdown，不需要 `scripts/ci-equivalent-check.sh`。

## 12. 回滚

文档重构主要是内容和入口重排。

如果重构后发现信息丢失：

- 优先从 commit diff 恢复被删段落到 `docs/roadmap.md` 或 `USAGE.*.md`。
- 不把内部 `docs/superpowers/*` 删除作为第一轮动作。
- README 只保留短入口，不能重新膨胀回内部进度报告。
- 如果截图生成失败，保留文字重构，但不要提交旧图或无关图片；把截图 blocker 写进
  implementation acceptance。

## 13. 下一步

用户确认本 spec 后，写 implementation plan：

`docs/superpowers/plans/2026-05-22-issuepilot-open-source-docs-ia.md`

计划应拆为：

1. 新建 `docs/README.md`。
2. 新建 `docs/getting-started.zh-CN.md` / `docs/getting-started.md`。
3. 新建 `docs/roadmap.md`。
4. 生成 / 放置 dashboard 截图，并接入 README / docs。
5. 重写 README 三语版本。
6. 给 `USAGE.*.md` 增加启动文档入口和定位说明。
7. 文档自检和 `git diff --check`。
