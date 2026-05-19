# IssuePilot V4.6 Multi-Agent Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IssuePilot V4 智能工作台之上实现 V4.6 三角色 pipeline（Coder
→ Reviewer → Test/Evidence），由单个 Codex app-server 多 role profile
驱动，落地 PipelineRun + AgentReport 数据层、TaskNode 状态机扩展、
reviewer findings → GitLab MR inline comments 闭环（六条护栏 +
`max_inline_comments` 额外约束）、recipe 配置、`auto_advance`、UI 入口、
V4.4 / V4.5 联动，全程 TDD，不破坏现有 V4.1-V4.5 行为。

**Architecture:** 在 `@issuepilot/shared-contracts` 新增 AgentReport /
PipelineRun / Workflow YAML 扩展契约；在 `apps/orchestrator/src/pipelines`
新增 store / coordinator / recipe 解析 / role profile 加载 /
auto_advance 引擎；在 `apps/orchestrator/src/agents/{coder,reviewer,
test-evidence}` 落地三角色专属逻辑（reviewer 还要带 findings 转换、
MR publisher、redaction、revoke）；通过 `apps/orchestrator/src/server`
暴露 V4.6 HTTP API；扩展 V4.4 quality 与 V4.5 improvement 模块吸收
by-role / new pattern；在 `apps/dashboard/components/work-items/` 新增
pipeline progress bar 与 AgentReport 三 tab，复用 V4.3 evidence tab；
i18n 中英补齐。

**Tech Stack:** TypeScript, Fastify, Next.js 14, React 18, next-intl,
Tailwind/shadcn-style local primitives, Vitest, Playwright (复用 V4.3
evidence walkthrough), `scripts/ci-equivalent-check.sh`, Codex app-server
runner via `@issuepilot/runner-codex-app-server`。

---

## Scope Check

本计划只实现
`docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md`
（V4.6 设计 spec）。任务粒度和 V4.4 / V4.5 plan
保持一致：TDD 节奏（先写失败测试再实现）、每个 task 一个 commit、
最终用 `scripts/ci-equivalent-check.sh` 收口（必要时 `SKIP_E2E=0` 跑全套）。

### In Scope

- Shared contracts（`@issuepilot/shared-contracts/src/agent-report.ts`、
  `pipeline.ts`、`workflow-role.ts`）：`AgentReport`（discriminated union：
  coder / reviewer / testEvidence）、`PipelineRun`、`PipelineRunStatus`、
  `AgentRole`、`AgentReportStatus`、reviewer findings / inline comments /
  MR publication 类型、`AgentLastError`（含 `LastErrorCode` 单一 truth
  source）、`WorkflowRoleConfig` / `WorkflowRecipe` / 升级版
  `WorkflowToolGrant`，对应 type guard 与 stable JSON round-trip 测试。
- `TaskNodeStatus` 枚举扩展（在 `work-item.ts`）：新增
  `running_coding` / `running_reviewer` / `running_test_evidence` /
  `awaiting_human_review` 四态，保留旧 `running` 作为兼容值；新增
  `TaskNode.pendingRecipe` / `pendingRecipeSource` / `last_cancelled_at`
  / `roleFailureReason` 等字段（spec §8.0 / §8.3）。
- 上下游 contract 升级：`WorkItemReport.taskSummaries[]` 新增
  `agentReports[]` 摘要 + `evidenceStatus` 扩展枚举；`ReviewFeedback`
  / `RunReportArtifact` 保持向后兼容，新增 `mrPublication` 子结构。
- Orchestrator `pipelines` 模块（`apps/orchestrator/src/pipelines/`）：
  `store.ts`（`~/.issuepilot/<scope>/pipelines/<wid>/<pid>.json`、
  `agent-reports/<wid>/<rid>.json` 持久化 + redact wrapper）、
  `recipe.ts`（workflow YAML 解析 + per-task override + pendingRecipe
  搬运）、`coordinator.ts`（按 recipe 串行调度 coder → reviewer →
  test_evidence、写 AgentReport、推 TaskNode 状态机、运行 ID supersede）、
  `auto-advance.ts`（监听 AgentReport 完成事件 + `last_cancelled_at`
  抑制），`role-profile.ts`（加载 sandbox / tools / prompt template /
  timeout / token_scope_requirements），`failure-mapping.ts`（lastError
  → TaskNode roleFailureReason / event key 的单一 truth source 实现）。
- Orchestrator `agents/coder.ts` / `agents/reviewer.ts` /
  `agents/test-evidence.ts`：每个 role 对接 `@issuepilot/runner-codex-app-server`
  的 `lifecycle.ts`（共享 worktree，按 spec §15 给定 sandbox）；reviewer
  额外做 prompt 渲染、findings 解析、`mrPublication` 写入、`max_inline_comments`
  截断、`severity_threshold` 过滤、prefix 注入、redaction（沿用
  `@issuepilot/observability/redact`）、revoke。
- Orchestrator `gitlab/mr-comments.ts` + tracker-gitlab notes API
  扩展：1 主 note + N inline 推送 / 通过 noteIds 撤回；尊重
  `tracker.token_scope_requirements`，缺 scope → reviewer
  `cannot_review` event。
- Orchestrator HTTP API（沿用 `apps/orchestrator/src/server`）：
  - `GET /api/work-items/:wid/tasks/:tid/pipeline` 返回最新 PipelineRun
    + `pendingRecipe`。
  - `GET /api/pipelines/:pid`、`GET /api/work-items/:wid/tasks/:tid/agent-reports`
    、`GET /api/pipelines/:pid/agent-reports`。
  - `POST /api/work-items/:wid/tasks/:tid/recipe-override`（`planned`
    / `blocked_by_dependency` 写 `pendingRecipe`，`ready` 写
    `PipelineRun.recipe`，`running_coding` 之后 409 `recipe_override_locked`）。
  - `POST /api/agent-reports/:rid/revoke-ai-review`（仅
    `mrPublication.status = published` 时可调用；非 reviewer role → 400
    `role_mismatch`）。
  - 所有路由都尊重 single / team 模式的 `x-issuepilot-project` header
    与 active project 校验，沿用 V4.4 / V4.5 模式。
- Daemon wiring：
  - `apps/orchestrator/src/daemon.ts` 与
    `apps/orchestrator/src/team/daemon.ts` 注入 `pipelineService`
    / `pipelinesByProject`、`pipeline coordinator` 通过 V4.2 既有
    dispatch 钩子和 V4.3 evidence collector 协作；team 模式按 project
    维度隔离持久化目录。
- V4.4 联动：扩展 `apps/orchestrator/src/quality/types.ts` +
  `aggregate.ts` + `patterns.ts`，吸收 V4.6 `FailurePatternId` 增量
  （`reviewer_unavailable` / `reviewer_requested_changes` /
  `reviewer_cannot_review` / `evidence_unavailable` / `evidence_partial`
  / `pipeline_cancelled` / `pipeline_init_failed` / `role_profile_invalid`
  / `runner_unavailable` / `coding_failed` / `sandbox_violation` /
  `redaction_failed` / `storage_full`），by-role 切片（`coder.success_rate`
  / `reviewer.approve_rate` / `reviewer.cannot_review_rate` /
  `reviewer.unavailable_rate` / `test_evidence.evidence_complete_rate`
  / `test_evidence.partial_rate`）。
- V4.5 联动：升级
  `packages/shared-contracts/src/improvement.ts:ImprovementTargetKind`
  增加 `role_configuration`；engine 在 V4.6 patterns 上分桶生成新建议；
  patch preview 支持 reviewer / test_evidence prompt 模板的 inert diff。
- Dashboard：
  - `apps/dashboard/components/work-items/pipeline-progress.tsx` +
    `agent-report-tabs.tsx`（含 coder / reviewer / test_evidence
    三 tab）、`recipe-selector.tsx`（含 pendingRecipe 视图）、
    `revoke-ai-review-button.tsx`，全部带 `*.test.tsx` 单测。
  - `apps/dashboard/lib/api.ts` 新增 `getPipeline` / `getAgentReports`
    / `setRecipeOverride` / `revokeAiReview` 客户端方法。
  - `/work-items/[id]` 详情页面新增 pipeline & AgentReport 入口；
    `/reports` 页面 by-role / by-pattern 切片扩展。
- i18n（`apps/dashboard/i18n/messages/{en,zh}.json`）：新增所有
  pipeline / AgentReport / recipe / decision / lastError / TaskNode 新
  状态 / dashboard hint 的 key（详见 spec §17.6）。
- 测试：
  - shared-contracts contract round-trip。
  - `apps/orchestrator/src/pipelines/__tests__/*`、
    `apps/orchestrator/src/agents/__tests__/*`、`gitlab/__tests__/*`。
  - server / route 测试覆盖 200 / 400 / 404 / 409。
  - dashboard 组件 / api / 页面测试。
  - 新建 `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts`
    覆盖 spec §22.7 七大场景（full pipeline / request_changes 返工 /
    test_evidence partial / cannot_review / sandbox_violation / cancel
    mid-pipeline / `coding_only` recipe）。
- 文档：
  - 在 V4.6 spec 与 V4.5 spec 中同步交叉引用本计划。
  - 更新 `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
    实施计划节，把 V4.6 状态推进到「实施计划已写」。
  - README.md / README.zh-CN.md / README.en.md / USAGE.md /
    USAGE.zh-CN.md 中 V4.6 段补「pipeline / AgentReport / recipe」简介。
  - `CHANGELOG.md [Unreleased]` V4.6 段在每个阶段结束时追加。
  - 新增 acceptance 文件
    `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`，
    沿用 V4.4 / V4.5 acceptance 格式。

### Out of Scope（与 spec §4 / §5 / §19 一致）

- 多个 Codex app-server / 多 runner（M+1 runner 拆分留给 V4.7+）；本期
  所有 role 在同一 Codex app-server 上跑，靠 role profile 区分。
- 自动跨 task 协作或并行 pipeline；本期仍是 V4.2 单 task 串行 + 单
  pipeline 串行 coder → reviewer → test_evidence。
- 不引入 LLM 作为 reviewer decision / improvement engine 的兜底；
  reviewer decision 由 reviewer prompt 自身输出，dashboard / V4.4 /
  V4.5 仍 deterministic 处理。
- 不改 `RunStatus` / `PipelineStatus` 全局枚举（V4.6 引入的
  `PipelineRun.status` 是独立 enum，不复用 V4.2 `RunStatus`）。
- 不修改 `ai-ready` / `ai-running` / `human-review` / `ai-rework` /
  `ai-failed` / `ai-blocked` 等 work-item label 状态机；human-review
  通道由 V4.3 现有逻辑承接。
- 不引入 Postgres / 外部分析存储 / 后台分析 job；本期所有 V4.6 数据走
  `~/.issuepilot/<scope>/{pipelines,agent-reports}/...` 本地 JSON。
- 不触碰 `elixir/`（Symphony Elixir 参考实现，不在 IssuePilot 实现路线）。
- 不写 token / 凭据到 store / dashboard / event / prompt（沿用 V4.x
  既有 redact 不变量）。
- 不实现 reviewer 自动重试或自动回滚 patch；retry / replan / revoke
  全部要 operator 显式触发。

---

## File Structure

> 所有路径都是仓库根的相对路径。新建文件标 `(new)`，修改既有文件标
> `(modify)`，避免后续 task 误判。

### Shared Contracts

- `packages/shared-contracts/src/agent-report.ts` (new)
  - `AgentRole`、`AgentReportStatus`、`AgentLastError`、`LastErrorCode`
    枚举（单一 truth source）、`CoderAgentReport`、`ReviewerAgentReport`
    （含 `findings` / `inlineComments` / `mrPublication`）、
    `TestEvidenceAgentReport`、`AgentReport` discriminated union、type
    guards。
- `packages/shared-contracts/src/pipeline.ts` (new)
  - `PipelineRunStatus`（`draft`/`running`/`awaiting_rework`/`partial`
    /`succeeded`/`failed`/`cancelled`）、`WorkflowRecipe`（默认
    `full_pipeline` / `coding_plus_reviewer` / `coding_only`）、
    `PipelineRun` 结构、type guards、stable JSON round-trip helpers。
- `packages/shared-contracts/src/workflow-role.ts` (new)
  - `WorkflowRoleConfig`（promptTemplate / sandbox / tools / timeout /
    token_scope_requirements）、升级版 `WorkflowToolGrant`（`tools[]`
    支持 `{ name, allow[] }`）、`WorkflowRolesConfig` map、type guards。
- `packages/shared-contracts/src/work-item.ts` (modify)
  - 扩 `TaskNodeStatus`：新增 `running_coding` /
    `running_reviewer` / `running_test_evidence` /
    `awaiting_human_review`；保留 `running` 但标 `@deprecated` 注释，
    提供 `legacyRunningStateToV46(status)` helper。
  - `TaskNode` interface 新增 `pendingRecipe?` / `pendingRecipeSource?`
    / `last_cancelled_at?` / `roleFailureReason?`；
    `effectiveTaskStatus` 与 `WorkItemTaskSummary` 同步更新。
- `packages/shared-contracts/src/report.ts` (modify)
  - `WorkItemReport.taskSummaries[]` 新增 `agentReports?[]`（摘要）和
    `evidenceStatus` 枚举扩展（保留向后兼容）。
- `packages/shared-contracts/src/review.ts` (modify)
  - `ReviewerDecision`（`approve` / `request_changes` / `cannot_review`）
    + `ReviewerFinding` / `ReviewerInlineComment` + `MrPublication`。
- `packages/shared-contracts/src/index.ts` (modify)
  - 重新导出 `./agent-report.js` / `./pipeline.js` / `./workflow-role.js`。
- `packages/shared-contracts/src/api.ts` (modify)
  - 暴露 V4.6 API request / response 类型供 dashboard / orchestrator
    复用（`GetPipelineResponse`、`SetRecipeOverrideRequest` 等）。
- `packages/shared-contracts/src/__tests__/agent-report.test.ts` (new)
- `packages/shared-contracts/src/__tests__/pipeline.test.ts` (new)
- `packages/shared-contracts/src/__tests__/workflow-role.test.ts` (new)
- `packages/shared-contracts/src/__tests__/work-item.test.ts` (modify)
- `packages/shared-contracts/src/__tests__/review.test.ts` (modify)
- `packages/shared-contracts/src/__tests__/report.test.ts` (modify)
- `packages/shared-contracts/src/__tests__/index.test.ts` (modify)

### Workflow Loader

- `packages/workflow/src/types.ts` (modify)
  - 把 `default_recipe` + `roles:` block + tools `allow[]` 写入
    `WorkflowConfig` schema。
- `packages/workflow/src/parse.ts` (modify)
  - YAML schema 校验、role profile fallback、tools allow normalization、
    `tracker.token_scope_requirements` 可选解析。
- `packages/workflow/src/resolve.ts` (modify)
  - workflow load 时把 role profile 中的 prompt template path 解析成
    绝对路径并 sha256 化（`promptTemplateHash`），写入 `WorkflowRoleConfig`。
- `packages/workflow/src/render.ts` (modify)
  - 输出 V4.6 角色配置到 dashboard view（在 reports 中渲染 role 摘要
    时复用）。
- `packages/workflow/src/__tests__/parse.test.ts` (modify)
  - 覆盖 `default_recipe` 合法 / 非法、roles fallback、tools.allow `*`
    禁用、token_scope_requirements 解析。
- `packages/workflow/src/__tests__/resolve.test.ts` (modify)
  - prompt template hash 稳定 + 缺失时报 `role_profile_invalid`。

### Orchestrator Pipelines Module

- `apps/orchestrator/src/pipelines/types.ts` (new)
  - 内部类型与 stable persistence shape。
- `apps/orchestrator/src/pipelines/store.ts` (new)
  - `~/.issuepilot/<scope>/pipelines/<workItemId>/<pipelineRunId>.json`、
    `~/.issuepilot/<scope>/agent-reports/<workItemId>/<reportId>.json`
    双目录持久化，写入前过 redact wrapper；提供 supersede
    `supersededBy` 链。
- `apps/orchestrator/src/pipelines/recipe.ts` (new)
  - 解析 workflow `default_recipe` + `TaskNode.pendingRecipe` + per-task
    override；输出最终生效 recipe 字符串与一份角色列表。
- `apps/orchestrator/src/pipelines/role-profile.ts` (new)
  - 从 workflow 配置 + 当前 task / work item 上下文构造每个 role 的
    sandbox / tools / prompt 模板渲染参数。
- `apps/orchestrator/src/pipelines/coordinator.ts` (new)
  - 串行调度 coder → reviewer → test_evidence；维护
    `running_coding` / `running_reviewer` / `running_test_evidence`
    / `awaiting_human_review` 状态机；写 AgentReport；记录
    `PipelineRun.status` 与 `PipelineRun.events`。
- `apps/orchestrator/src/pipelines/auto-advance.ts` (new)
  - 监听 AgentReport 完成事件 + `last_cancelled_at` 抑制 + recipe-final
    判断（哪个 role 是末端）。
- `apps/orchestrator/src/pipelines/failure-mapping.ts` (new)
  - `LastErrorCode` → `TaskNode.roleFailureReason` / event key /
    `FailurePatternId` 的双向 truth source；唯一允许新增 lastError
    code 的入口（编译期检查）。
- `apps/orchestrator/src/pipelines/service.ts` (new)
  - 对外的高层 service：list / get / setRecipeOverride / revokeAiReview
    / startNextRole 等；与 work-items orchestration / cancel registry
    协作。
- `apps/orchestrator/src/pipelines/routes.ts` (new)
  - Fastify route registration helper（被 `server/index.ts` 装载）。
- `apps/orchestrator/src/pipelines/__tests__/{recipe,role-profile,
  coordinator,auto-advance,failure-mapping,service,store}.test.ts` (new)

### Orchestrator Agents

- `apps/orchestrator/src/agents/coder.ts` (new)
  - 调用 `@issuepilot/runner-codex-app-server` lifecycle 启动 coder
    role；写 `CoderAgentReport`；失败映射到 `coding_failed` /
    `runner_unavailable` 等 lastError code。
- `apps/orchestrator/src/agents/reviewer.ts` (new)
  - 读 coder 输出 + worktree diff；调用 lifecycle 启动 reviewer role；
    解析 reviewer prompt structured output → `findings[]` /
    `inlineComments[]` / `decision` / `confidence` / `risks` /
    `evidenceRequest[]`；写 `ReviewerAgentReport`；按 spec §11 / §12 与
    `gitlab/mr-comments.ts` 协作。
- `apps/orchestrator/src/agents/test-evidence.ts` (new)
  - 沿用 V4.3 evidence walkthrough + Playwright recipe；写
    `TestEvidenceAgentReport`；evidence 写入 `worktree/.issuepilot/evidence/<taskId>/`。
- `apps/orchestrator/src/agents/__tests__/{coder,reviewer,test-evidence}.test.ts` (new)

### Orchestrator GitLab MR Hooks

- `apps/orchestrator/src/gitlab/mr-comments.ts` (new)
  - 把 reviewer `findings` / `inlineComments` 转成 1 主 note + N inline，
    带 `[issuepilot-bot]` prefix，过 redact，应用 `max_inline_comments`
    截断和 `severity_threshold` 过滤。
- `apps/orchestrator/src/gitlab/__tests__/mr-comments.test.ts` (new)
- `packages/tracker-gitlab/src/notes.ts` (modify)
  - 暴露 `createMrInlineNote` / `deleteMrNotes` 两个最小封装，复用现有
    `client.ts`；spec scope 不足时抛 `gitlab_scope_missing`（被 reviewer
    转成 `cannot_review`）。
- `packages/tracker-gitlab/src/__tests__/notes.test.ts` (modify)

### Quality & Improvement Wiring

- `apps/orchestrator/src/quality/types.ts` (modify)
  - 加入 V4.6 `FailurePatternId` 增量、by-role 切片字段。
- `apps/orchestrator/src/quality/patterns.ts` (modify)
- `apps/orchestrator/src/quality/aggregate.ts` (modify)
- `apps/orchestrator/src/quality/__tests__/*.test.ts` (modify)
- `apps/orchestrator/src/improvements/templates.ts` (modify)
  - 新增 `role_configuration` 模板与 reviewer / test_evidence prompt
    targeting（V4.5 已落地的话；如未落地，本计划仅新增 enum + 占位
    模板）。
- `apps/orchestrator/src/improvements/__tests__/*.test.ts` (modify)
- `packages/shared-contracts/src/improvement.ts` (modify)
  - `ImprovementTargetKind` 加 `role_configuration`；
    `ImprovementRecommendation.scope.target` 接受新 enum；type guard
    更新；附 stable JSON round-trip 测试。

### Server / Daemon Wiring

- `apps/orchestrator/src/server/index.ts` (modify)
  - 注入 `pipelines` / `pipelinesByProject` deps；注册
    `/api/work-items/:wid/tasks/:tid/pipeline` /
    `/api/pipelines/:pid` / `/api/work-items/:wid/tasks/:tid/agent-reports`
    / `/api/pipelines/:pid/agent-reports`
    / `/api/work-items/:wid/tasks/:tid/recipe-override` /
    `/api/agent-reports/:rid/revoke-ai-review` 路由；尊重
    `x-issuepilot-project` header。
- `apps/orchestrator/src/server/__tests__/server.test.ts` (modify)
  - 新增 V4.6 routes 的 200 / 400 / 404 / 409 测试。
- `apps/orchestrator/src/daemon.ts` (modify)
  - single 模式：从 `~/.issuepilot` 根加载 pipeline store + agent
    report store + coordinator + auto-advance；和 reports / work-items
    共用 redact / event-bus / observability stack。
- `apps/orchestrator/src/team/daemon.ts` (modify)
  - team 模式：按 project 维护 `pipelinesByProject` / `coordinatorByProject`，
    沿用 V4.4 / V4.5 资源初始化模式。
- `apps/orchestrator/src/work-items/orchestration.ts` (modify)
  - V4.2 既有 dispatch 钩子改用 `pipelines/coordinator.ts`，老的单
    coder 调度改成 recipe-driven pipeline；保持 V4.1-V4.5 行为兼容
    （`coding_only` recipe ≈ 旧行为，新枚举写在 TaskNode 状态机表里）。

### Dashboard UI

- `apps/dashboard/lib/api.ts` (modify)
  - 新增 `getPipeline` / `getAgentReports` / `setRecipeOverride` /
    `revokeAiReview` / 列出 by-role 切片的 helper。
- `apps/dashboard/lib/api.test.ts` (modify)
  - 覆盖 query / project header / 错误码、`recipe-override` 三种允许
    状态、`revoke-ai-review` 错误路径。
- `apps/dashboard/components/work-items/pipeline-progress.tsx` (new)
- `apps/dashboard/components/work-items/pipeline-progress.test.tsx` (new)
- `apps/dashboard/components/work-items/agent-report-tabs.tsx` (new)
- `apps/dashboard/components/work-items/agent-report-tabs.test.tsx` (new)
- `apps/dashboard/components/work-items/recipe-selector.tsx` (new)
- `apps/dashboard/components/work-items/recipe-selector.test.tsx` (new)
- `apps/dashboard/components/work-items/revoke-ai-review-button.tsx` (new)
- `apps/dashboard/components/work-items/revoke-ai-review-button.test.tsx` (new)
- `apps/dashboard/components/work-items/work-item-detail.tsx` (modify)
  - 在 task 详情下方插入 pipeline progress + 三 tab + recipe 选择 +
    revoke 按钮；保留旧 evidence tab。
- `apps/dashboard/components/work-items/work-item-detail.test.tsx` (modify)
- `apps/dashboard/app/work-items/[id]/page.tsx` (modify)
  - 在并行 fetch 里加 `getPipeline` 与 `getAgentReports`。
- `apps/dashboard/app/work-items/[id]/page.test.tsx` (modify)
- `apps/dashboard/components/reports/quality-analytics.tsx` (modify)
  - by-role 切片渲染：`coder.success_rate` / `reviewer.approve_rate`
    / `reviewer.cannot_review_rate` / `reviewer.unavailable_rate` /
    `test_evidence.evidence_complete_rate` / `test_evidence.partial_rate`。
- `apps/dashboard/components/reports/quality-analytics.test.tsx` (modify)
- `apps/dashboard/i18n/messages/zh.json` (modify)
- `apps/dashboard/i18n/messages/en.json` (modify)

### E2E / Docs

- `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts` (new)
  - fake Codex + fake GitLab 跑完 spec §22.7 七大场景。
- `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md` (new)
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md` (modify)
- `README.md` / `README.zh-CN.md` / `README.en.md` (modify)
- `USAGE.md` / `USAGE.zh-CN.md` (modify)
- `CHANGELOG.md` (modify)

---

## Phases Overview

| Phase | 目的 | 主要交付 | 关键依赖 |
| --- | --- | --- | --- |
| **Phase 1** | Shared contracts 基础 | `agent-report.ts` / `pipeline.ts` / `workflow-role.ts` / `work-item.ts` 扩展、type guards、round-trip | 无 |
| **Phase 2** | Workflow YAML 扩展 | `workflow/parse.ts` / `resolve.ts` 解析 `default_recipe` / `roles:` / `tools[].allow[]` / `token_scope_requirements` | Phase 1 |
| **Phase 3** | Pipeline store + AgentReport store | `pipelines/store.ts`、redact、supersede | Phase 1 |
| **Phase 4** | Recipe + role profile + failure mapping | `pipelines/recipe.ts` / `role-profile.ts` / `failure-mapping.ts` | Phase 2 |
| **Phase 5** | Pipeline coordinator + auto_advance | `pipelines/coordinator.ts` / `auto-advance.ts` + TaskNode 状态机迁移 | Phase 3 / Phase 4 |
| **Phase 6** | Coder agent 接线 | `agents/coder.ts` + V4.2 dispatch 切换到 coordinator | Phase 5 |
| **Phase 7** | Reviewer agent + GitLab MR | `agents/reviewer.ts`、`gitlab/mr-comments.ts`、`tracker-gitlab/notes.ts` | Phase 5 |
| **Phase 8** | Test/Evidence agent | `agents/test-evidence.ts` + V4.3 evidence 通道复用 | Phase 5 |
| **Phase 9** | HTTP API + daemon wiring | `server/index.ts`、`daemon.ts`、`team/daemon.ts`、`pipelines/service.ts` + `pipelines/routes.ts` | Phase 5-8 |
| **Phase 10** | V4.4 by-role + V4.5 role_configuration | quality patterns / aggregate、improvements templates、ImprovementTargetKind | Phase 5-9 |
| **Phase 11** | Dashboard UI + i18n | pipeline progress、AgentReport tabs、recipe selector、revoke 按钮、reports by-role 切片 | Phase 9-10 |
| **Phase 12** | E2E、acceptance、docs、CHANGELOG | `v4-6-multi-agent-e2e.test.ts`、acceptance 文件、README / USAGE 更新 | 全部 |

每个 Phase 内部按 TDD 切成 task；每个 task 一个 commit。Phase 之间在
sub-agent 模式下建议夹一次 code-reviewer。

---

## Phase 1：Shared Contracts 基础

### Task 1.1：新增 `agent-report.ts` 契约

**Files:**

- Create: `packages/shared-contracts/src/agent-report.ts`
- Test: `packages/shared-contracts/src/__tests__/agent-report.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared-contracts/src/__tests__/agent-report.test.ts` 写
枚举 round-trip + discriminated union 类型守卫的失败用例：

```typescript
import { describe, it, expect } from "vitest";
import {
  AGENT_ROLE_VALUES,
  AGENT_REPORT_STATUS_VALUES,
  LAST_ERROR_CODE_VALUES,
  isAgentRole,
  isAgentReportStatus,
  isLastErrorCode,
  type AgentReport,
} from "../agent-report.js";

describe("agent-report contracts", () => {
  it("AGENT_ROLE_VALUES 至少包含 coder / reviewer / test_evidence", () => {
    expect(AGENT_ROLE_VALUES).toEqual(["coder", "reviewer", "test_evidence"]);
  });

  it("AGENT_REPORT_STATUS_VALUES 覆盖 running/complete/failed/cancelled/incomplete", () => {
    expect(new Set(AGENT_REPORT_STATUS_VALUES)).toEqual(
      new Set(["running", "complete", "failed", "cancelled", "incomplete"]),
    );
  });

  it("isLastErrorCode 接受 reviewer_cannot_review，拒绝未知字符串", () => {
    expect(isLastErrorCode("reviewer_cannot_review")).toBe(true);
    expect(isLastErrorCode("totally_unknown")).toBe(false);
  });

  it("AgentReport discriminated union by role", () => {
    const r: AgentReport = {
      reportId: "r1",
      pipelineRunId: "p1",
      workItemId: "w1",
      taskId: "t1",
      role: "reviewer",
      status: "complete",
      attempt: 1,
      createdAt: "2026-05-19T00:00:00Z",
      updatedAt: "2026-05-19T00:00:10Z",
      runId: "run1",
      promptTemplateHash: "abc",
      decision: "approve",
      confidence: 0.91,
      risks: [],
      evidenceRequest: [],
      findings: [],
      inlineComments: [],
    } as const;
    expect(r.role).toBe("reviewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @issuepilot/shared-contracts test -- agent-report`
Expected: FAIL with `Cannot find module '../agent-report.js'`。

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared-contracts/src/agent-report.ts`：定义
`AGENT_ROLE_VALUES` / `AGENT_REPORT_STATUS_VALUES` /
`LAST_ERROR_CODE_VALUES` / `isAgentRole` / `isAgentReportStatus` /
`isLastErrorCode` / `AgentLastError` / `CoderAgentReport` /
`ReviewerAgentReport`（含 `findings` 与 `inlineComments` 与
`mrPublication`）/ `TestEvidenceAgentReport` / 顶层 `AgentReport`
discriminated union；导出 `AgentReportBase` 公共字段：`reportId`、
`pipelineRunId`、`workItemId`、`taskId`、`role`、`status`、`attempt`、
`createdAt`、`updatedAt`、`runId?`、`promptTemplateHash?`、`lastError?`。

参考 spec §8.2 / §11 / §16.2，严格按表写枚举。

- [ ] **Step 4: Re-export from `index.ts`**

```typescript
export * from "./agent-report.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm -F @issuepilot/shared-contracts test -- agent-report`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/shared-contracts/src/agent-report.ts \
  packages/shared-contracts/src/__tests__/agent-report.test.ts \
  packages/shared-contracts/src/index.ts
git commit -m "feat(shared-contracts): add AgentReport contracts and enums"
```

### Task 1.2：新增 `pipeline.ts` 契约

**Files:**

- Create: `packages/shared-contracts/src/pipeline.ts`
- Test: `packages/shared-contracts/src/__tests__/pipeline.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - `PIPELINE_RUN_STATUS_VALUES = ["draft","running","awaiting_rework","partial","succeeded","failed","cancelled"]`。
  - `WORKFLOW_RECIPE_VALUES = ["full_pipeline","coding_plus_reviewer","coding_only"]`。
  - `isPipelineRunStatus` / `isWorkflowRecipe` 拒绝未知值。
  - `PipelineRun` 字段：`pipelineRunId`、`workItemId`、`taskId`、
    `recipe`、`status`、`steps[]`（每步 `role` + `agentReportId?` +
    `status`）、`createdAt` / `updatedAt` / `supersededBy?`、`source`
    （`auto` / `operator`）。
- [ ] **Step 2: Run test** Expected: FAIL。
- [ ] **Step 3: Implement** `pipeline.ts`。
- [ ] **Step 4: Re-export from `index.ts`**。
- [ ] **Step 5: Run test** Expected: PASS。
- [ ] **Step 6: Commit**：`feat(shared-contracts): add PipelineRun contract and recipe enum`。

### Task 1.3：新增 `workflow-role.ts` 契约

**Files:**

- Create: `packages/shared-contracts/src/workflow-role.ts`
- Test: `packages/shared-contracts/src/__tests__/workflow-role.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - `WorkflowRoleConfig`：必填 `promptTemplate` / `sandbox`，可选
    `tools[]` / `timeoutSeconds` / `tokenScopeRequirements[]`。
  - `WorkflowToolGrant`：`{ name: string, allow?: string[] }`，并断言
    `allow` 中 `"*"` 必须配 `name`（非空），不允许顶层通配。
  - `WORKFLOW_SANDBOX_VALUES = ["workspace-write","read-only-source-write-evidence","read-only-source"]`。
- [ ] **Step 2-6**：同样 TDD 五步。
- [ ] commit 信息：`feat(shared-contracts): add workflow role / tool / sandbox enums`。

### Task 1.4：扩展 `work-item.ts` 的 TaskNodeStatus 与 TaskNode 字段

**Files:**

- Modify: `packages/shared-contracts/src/work-item.ts`
- Test: `packages/shared-contracts/src/__tests__/work-item.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - 新增 4 个 status `running_coding` / `running_reviewer` /
    `running_test_evidence` / `awaiting_human_review` 在
    `TASK_NODE_STATUS_VALUES` 里。
  - `legacyRunningStateToV46("running")` 返回 `"running_coding"`，对其
    他状态返回原值。
  - `TaskNode` 接收 `pendingRecipe?` / `pendingRecipeSource?` /
    `last_cancelled_at?` / `roleFailureReason?` 不报错；旧字段全部
    保留。
  - `effectiveTaskStatus` 把 `running_coding` / `running_reviewer` /
    `running_test_evidence` 映射到旧 `running`（向后兼容 UI）。
- [ ] **Step 2-5**：实现 + 测试。
- [ ] **Step 6: Commit**：
  `feat(shared-contracts): extend TaskNodeStatus and TaskNode fields for V4.6`。

### Task 1.5：扩展 `review.ts`：ReviewerDecision / Finding / InlineComment / MrPublication

**Files:**

- Modify: `packages/shared-contracts/src/review.ts`
- Test: `packages/shared-contracts/src/__tests__/review.test.ts`

- [ ] **Step 1**：写测试覆盖
  - `REVIEWER_DECISION_VALUES = ["approve","request_changes","cannot_review"]`。
  - `ReviewerFinding`：`{ id, severity, category, file?, line?, summary, suggestion?, status }`，其中
    `severity ∈ ["info","minor","major","blocker"]`。
  - `ReviewerInlineComment`：`{ findingId, file, line, body, gitlabNoteId? }`。
  - `MrPublication`：`{ status: "skipped"|"queued"|"published"|"publish_failed"|"revoked", noteIds?[], publishedAt?, error? }` + helper `isMrPublicationPublished`。
- [ ] **Step 2-6**：TDD 五步 + commit
  `feat(shared-contracts): add reviewer findings/inline comments/MR publication types`。

### Task 1.6：扩展 `report.ts`：WorkItemReport agentReports 摘要

**Files:**

- Modify: `packages/shared-contracts/src/report.ts`
- Test: `packages/shared-contracts/src/__tests__/report.test.ts`

- [ ] **Step 1**：写测试覆盖
  - `WorkItemTaskSummary.agentReports?` 是 `Array<{ reportId, role, status, decision?, evidenceStatus? }>`。
  - `WorkItemReport.taskSummaries[].evidenceStatus` 新增
    `skipped_by_recipe` 选项，旧值向后兼容。
- [ ] **Step 2-6**：TDD + commit。

### Task 1.7：扩展 `api.ts` 的 V4.6 request / response

**Files:**

- Modify: `packages/shared-contracts/src/api.ts`
- Test: `packages/shared-contracts/src/__tests__/api.test.ts`（如不存在则
  create）

- [ ] **Step 1**：写测试断言以下类型可被 import：
  - `GetPipelineResponse`、`GetAgentReportsResponse`、
    `SetRecipeOverrideRequest`、`SetRecipeOverrideResponse`、
    `RevokeAiReviewRequest`、`RevokeAiReviewResponse`、
    `PipelineRouteErrors`（统一 error code）。
- [ ] **Step 2-6**：实现 + commit。

### Task 1.8：`index.ts` 总导出测试 + Phase 1 收口

**Files:**

- Modify: `packages/shared-contracts/src/__tests__/index.test.ts`

- [ ] **Step 1**：在现有 index test 中追加 spec：
  - `import * as contracts from "../index.js"`，断言 `AgentReport` /
    `PipelineRun` / `WorkflowRoleConfig` / `ReviewerFinding` 等类型
    全部从 root re-export 可达。
- [ ] **Step 2**：跑测试 PASS。
- [ ] **Step 3: Commit**：`test(shared-contracts): re-export V4.6 types from root index`。
- [ ] **Step 4: Run `tsc -b`**：

```bash
pnpm -F @issuepilot/shared-contracts build
```

Expected: 编译通过。

- [ ] **Step 5: Phase checkpoint commit (空 commit 标记 phase 完成)**：

```bash
git commit --allow-empty -m "chore: V4.6 phase 1 (shared contracts) checkpoint"
```

---

## Phase 2：Workflow YAML 扩展

### Task 2.1：解析 `default_recipe`

**Files:**

- Modify: `packages/workflow/src/types.ts`
- Modify: `packages/workflow/src/parse.ts`
- Test: `packages/workflow/src/__tests__/parse.test.ts`

- [ ] **Step 1: Write failing test** 在 parse.test.ts 加用例：
  - YAML 顶层带 `default_recipe: full_pipeline`，parse 后输出
    `config.defaultRecipe === "full_pipeline"`。
  - 缺省时默认 `coding_only`（向后兼容 V4.1-V4.5）。
  - 非法 `default_recipe: nope` → 抛 `WorkflowParseError` 且 message
    含 `default_recipe`。
- [ ] **Step 2: Run test** Expected: FAIL。
- [ ] **Step 3-4**：在 `types.ts` 加字段，在 `parse.ts` 写 schema 校验
  + helper。
- [ ] **Step 5**：Run test PASS。
- [ ] **Step 6: Commit**：`feat(workflow): parse default_recipe with safe fallback`。

### Task 2.2：解析 `roles:` block + sandbox / tools.allow[]

**Files:**

- Modify: `packages/workflow/src/types.ts`
- Modify: `packages/workflow/src/parse.ts`
- Test: `packages/workflow/src/__tests__/parse.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - `roles: { coder: { promptTemplate: ..., sandbox: workspace-write }, reviewer: {...}, test_evidence: {...} }` 全部 parsed。
  - 缺 role → fallback 到一份内置默认 profile，并 emit warning（
    `result.warnings[]`）。
  - `tools: [{ name: run.command, allow: ["pnpm", "git"] }]` 解析；
    顶层 `tools: ["*"]` → 抛 `WorkflowParseError` (`global_wildcard_disallowed`)。
- [ ] **Step 2-5**：TDD 实现。
- [ ] **Step 6: Commit**：`feat(workflow): parse roles config and tool allow lists`。

### Task 2.3：`tracker.token_scope_requirements` 可选解析

**Files:**

- Modify: `packages/workflow/src/types.ts`、`parse.ts`
- Test: `packages/workflow/src/__tests__/parse.test.ts`

- [ ] **Step 1**：写测试覆盖
  - `tracker.token_scope_requirements: ["api", "write_repository"]` 解析
    成数组；不存在时为 `undefined`。
  - 非数组 / 非 string → 抛 `WorkflowParseError`。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(workflow): parse tracker.token_scope_requirements`。

### Task 2.4：`resolve.ts` 中给 prompt template 计算 sha256

**Files:**

- Modify: `packages/workflow/src/resolve.ts`
- Test: `packages/workflow/src/__tests__/resolve.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - 给一份带 `promptTemplate: ./templates/reviewer.md` 的 workflow，把
    模板文件落到临时目录，断言 `resolveWorkflow().roles.reviewer.promptTemplateHash`
    是稳定 sha256（同一文件两次 resolve 输出一致）。
  - 模板缺失时抛 `RoleProfileInvalidError`（message 带 path）。
- [ ] **Step 2-5**：实现，hash 用 `crypto.createHash("sha256")`。
- [ ] **Step 6: Commit**：`feat(workflow): hash role prompt templates and surface invalid profiles`。

### Task 2.5：Phase 2 checkpoint commit

- [ ] 跑 `pnpm -F @issuepilot/workflow test`，确保新旧用例都过。
- [ ] `git commit --allow-empty -m "chore: V4.6 phase 2 (workflow yaml) checkpoint"`。

---

## Phase 3：Pipeline Store + AgentReport Store

### Task 3.1：定义 store 持久化目录与 redact wrapper

**Files:**

- Create: `apps/orchestrator/src/pipelines/types.ts`
- Create: `apps/orchestrator/src/pipelines/store.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/store.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - `PipelineStore.savePipelineRun()` 把 JSON 写到
    `<root>/pipelines/<workItemId>/<pipelineRunId>.json`；写之前过
    redact，断言任意被注入的 `xxx-token` 字符串都被替换成
    `[redacted]`。
  - `PipelineStore.saveAgentReport()` 把 JSON 写到
    `<root>/agent-reports/<workItemId>/<reportId>.json`。
  - `PipelineStore.listForTask({ workItemId, taskId })` 返回按
    `createdAt` 倒序的 PipelineRun，并把 `supersededBy` 链最新一条
    标 `latest: true`。
  - 读出错（损坏 JSON）→ 抛 `PipelineStoreReadError`（带文件路径，
    不暴露内部 trace）。
- [ ] **Step 2: Run test** Expected: FAIL。
- [ ] **Step 3-4**：实现 store.ts；reuse
  `@issuepilot/observability/redact`。
- [ ] **Step 5: Run test** PASS。
- [ ] **Step 6: Commit**：`feat(orchestrator): add pipeline + agent-report store with redact`。

### Task 3.2：supersede 链

**Files:**

- Modify: `apps/orchestrator/src/pipelines/store.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/store.test.ts`

- [ ] **Step 1**：写测试覆盖
  - 写入 pipelineRun#1，再调 `supersede(prevId, nextId)`，断言
    pipelineRun#1.supersededBy = nextId，pipelineRun#2 没有
    supersededBy。
  - `latestForTask()` 返回最新一条。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): chain pipeline runs via supersededBy`。

### Task 3.3：team 模式下的 store factory

**Files:**

- Modify: `apps/orchestrator/src/pipelines/store.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/store.test.ts`

- [ ] **Step 1**：写测试覆盖
  - `createPipelineStore({ root })` 单实例；
    `createPipelineStoresByProject({ projects })` 给每个 project 一个
    隔离的目录（`workflow.workspace.root/.issuepilot/{pipelines,agent-reports}`）。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): support per-project pipeline stores`。

### Task 3.4：Phase 3 checkpoint

- [ ] `pnpm -F @issuepilot/orchestrator test -- pipelines/store`。
- [ ] empty commit 标记。

---

## Phase 4：Recipe + Role Profile + Failure Mapping

### Task 4.1：`recipe.ts` 解析 effective recipe

**Files:**

- Create: `apps/orchestrator/src/pipelines/recipe.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/recipe.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from "vitest";
import { resolveEffectiveRecipe } from "../recipe.js";

describe("resolveEffectiveRecipe", () => {
  it("workflow default + 无 task override → 用 workflow default", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: undefined,
        pipelineRecipe: undefined,
      }),
    ).toEqual({ recipe: "full_pipeline", source: "workflow_default" });
  });

  it("pendingRecipe 覆盖 workflow default（PipelineRun 未创建）", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: "coding_only",
        pipelineRecipe: undefined,
      }),
    ).toEqual({ recipe: "coding_only", source: "task_pending" });
  });

  it("pipelineRecipe 一旦写入则成为 truth", () => {
    expect(
      resolveEffectiveRecipe({
        workflowDefault: "full_pipeline",
        pendingRecipe: "coding_plus_reviewer",
        pipelineRecipe: "coding_only",
      }),
    ).toEqual({ recipe: "coding_only", source: "pipeline_locked" });
  });

  it("未知 recipe → 抛 UnknownRecipeError", () => {
    expect(() =>
      resolveEffectiveRecipe({
        workflowDefault: "weird_recipe" as any,
        pendingRecipe: undefined,
        pipelineRecipe: undefined,
      }),
    ).toThrow(/Unknown recipe/);
  });
});
```

- [ ] **Step 2-5**：实现 `resolveEffectiveRecipe` 与 `recipeRoles(recipe)`
  返回有序 `["coder","reviewer","test_evidence"]` / `["coder","reviewer"]`
  / `["coder"]`。
- [ ] **Step 6: Commit**：`feat(orchestrator): resolve effective pipeline recipe`。

### Task 4.2：`role-profile.ts` 组装 role 运行参数

**Files:**

- Create: `apps/orchestrator/src/pipelines/role-profile.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 给一份 reviewer role config，`buildRoleProfile({ workflow, role: "reviewer", task, workItem })`
    返回包含：渲染好的 prompt 文本（用 task / workItem 上下文替换占位），
    sandbox 字符串、tools allow 列表、`promptTemplateHash`、超时
    `timeoutSeconds`、`tokenScopeRequirements`。
  - 缺 prompt → 抛 `RoleProfileInvalidError`。
- [ ] **Step 2-5**：实现，模板渲染先用最小 Mustache 风格替换或 V4.5
  既有 helper（看现状决定）。
- [ ] **Step 6: Commit**：`feat(orchestrator): build per-role runtime profile`。

### Task 4.3：`failure-mapping.ts` 单一 truth source

**Files:**

- Create: `apps/orchestrator/src/pipelines/failure-mapping.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/failure-mapping.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 给定 `(role, lastErrorCode)`，`failureMapping.toTaskNodeReason()`
    返回 spec §16.2 表中对应值；不存在的组合 → `UnsupportedFailureMapping`。
  - `failureMapping.toEventKey()` / `toFailurePatternId()` 同样按表。
  - `runner_unavailable` 在 coder 上 → `roleFailureReason = "coding_failed"`、
    `eventKey = "runner_unavailable"`、`patternId = "runner_unavailable"`，
    与 spec §14.6 footnote 完全一致。
- [ ] **Step 2-5**：实现 mapping 表（用 `as const` + record type）。
- [ ] **Step 6: Commit**：`feat(orchestrator): centralize lastError → TaskNode / event / pattern mapping`。

### Task 4.4：Phase 4 checkpoint

- [ ] 跑 pipelines / failure-mapping 测试。
- [ ] empty commit 标记 phase 完成。

---

## Phase 5：Pipeline Coordinator + Auto Advance + TaskNode 迁移

### Task 5.1：TaskNode 状态机迁移工具

**Files:**

- Modify: `apps/orchestrator/src/work-items/store.ts`
- Modify: `apps/orchestrator/src/work-items/__tests__/store.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - 给定一个 v0 旧 TaskNode (`status: "running"`)，`migrateTaskNode()`
    转成 `running_coding` 并写回。
  - `TaskNode.last_cancelled_at` / `pendingRecipe` 字段经持久化往返
    不丢。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): migrate TaskNode store to V4.6 status fields`。

### Task 5.2：coordinator scaffolding（只能跑 coder）

**Files:**

- Create: `apps/orchestrator/src/pipelines/coordinator.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/coordinator.test.ts`

- [ ] **Step 1**：写测试覆盖：
  - `coordinator.startPipeline({ workItem, task })` 当 recipe =
    `coding_only` 时，创建 PipelineRun（status `running`，steps =
    `[coder]`），调 mock `agents.coder.run()`；mock 返回 success → 写
    CoderAgentReport，PipelineRun.status → `succeeded`，TaskNode →
    `awaiting_human_review`。
  - mock coder 失败 → PipelineRun.status `failed`，TaskNode `failed`
    reason `coding_failed`。
  - mock coder cancel → PipelineRun.status `cancelled`，TaskNode
    `needs_rework` + `last_cancelled_at` 写入。
- [ ] **Step 2-5**：实现 coordinator 与上述 happy / fail / cancel 分支。
  注意把 agents 通过依赖注入（factory）传入，方便 mock。
- [ ] **Step 6: Commit**：`feat(orchestrator): coordinator runs coder-only pipeline`。

### Task 5.3：coordinator 跑 coder → reviewer 串行

**Files:**

- Modify: `apps/orchestrator/src/pipelines/coordinator.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/coordinator.test.ts`

- [ ] **Step 1**：写测试覆盖：
  - recipe = `coding_plus_reviewer`，mock coder success + reviewer
    approve → 两份 AgentReport，TaskNode `awaiting_human_review`。
  - reviewer `request_changes` → TaskNode `needs_rework`，PipelineRun
    `awaiting_rework`。
  - reviewer `cannot_review` → TaskNode `blocked`，PipelineRun
    `failed`，roleFailureReason `reviewer_cannot_review`。
  - reviewer unavailable (runner) → TaskNode `blocked` 
    roleFailureReason `reviewer_unavailable`，PipelineRun `failed`。
- [ ] **Step 2-5**：扩展 coordinator。
- [ ] **Step 6: Commit**：`feat(orchestrator): extend coordinator to coder→reviewer pipeline`。

### Task 5.4：coordinator 跑完整三步（含 test_evidence）

**Files:**

- Modify: `apps/orchestrator/src/pipelines/coordinator.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/coordinator.test.ts`

- [ ] **Step 1**：写测试覆盖
  - recipe = `full_pipeline`，全部 success → 3 份 AgentReport，
    PipelineRun.status `succeeded`，TaskNode `awaiting_human_review`，
    `WorkItemReport.taskSummaries[].evidenceStatus = "complete"`。
  - test_evidence `incomplete` 时 PipelineRun `partial`，TaskNode
    `awaiting_human_review`（不阻塞 human review），
    `evidenceStatus = "partial"`。
  - test_evidence `failed (sandbox_violation)` 时 TaskNode `failed`
    reason `sandbox_violation`。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): coordinator drives coder→reviewer→test-evidence`。

### Task 5.5：`auto-advance.ts` 监听 + cancel 抑制

**Files:**

- Create: `apps/orchestrator/src/pipelines/auto-advance.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/auto-advance.test.ts`

- [ ] **Step 1**：写测试覆盖
  - 已结束的 coder AgentReport 通过 EventBus 触发
    `auto-advance.onAgentReportFinalized(report)` → 调
    `coordinator.startNextRole(...)`；当 recipe 已到末端则不调。
  - 当 `TaskNode.last_cancelled_at > now - 0`（任何最新值）→ 抑制
    auto advance，直到 operator 显式触发新一轮。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): auto-advance pipeline with cancel inhibition`。

### Task 5.6：Phase 5 checkpoint

- [ ] 跑 `apps/orchestrator/src/pipelines/__tests__`、`work-items` 测试。
- [ ] empty commit。

---

## Phase 6：Coder Agent

### Task 6.1：`agents/coder.ts` 包装 codex run

**Files:**

- Create: `apps/orchestrator/src/agents/coder.ts`
- Create: `apps/orchestrator/src/agents/__tests__/coder.test.ts`

- [ ] **Step 1: Write failing test** 覆盖：
  - 给定 mock `codexLifecycle.run({ profile, prompt, cwd })`，
    `coder.run({ workItem, task, profile })` 写一份
    `CoderAgentReport`：包含 `runId`、`promptTemplateHash`、
    `summary`、`patchSnapshotRef`、`status` 等。
  - lifecycle 抛 `RunnerUnavailableError` → AgentReport
    `status = "failed"` `lastError.code = "runner_unavailable"`。
  - sandbox 拒绝写源码 → 不可能（coder 是 workspace-write），但
    sandbox_violation event 由 lifecycle 抛出时，coder 仍尝试落
    AgentReport `status = "failed"` `lastError.code = "sandbox_violation"`。
- [ ] **Step 2-5**：实现 coder.ts，DI mock runner。
- [ ] **Step 6: Commit**：`feat(orchestrator): coder agent writes CoderAgentReport`。

### Task 6.2：V4.2 dispatch 切换到 coordinator

**Files:**

- Modify: `apps/orchestrator/src/work-items/dispatch-task.ts`
- Modify: `apps/orchestrator/src/work-items/orchestration.ts`
- Modify: `apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`
- Modify: `apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 当 workflow `default_recipe = "coding_only"` + task 无 override，
    dispatch 走 coordinator.startPipeline，结果与旧路径在
    `WorkItemReport.taskSummaries[]` 上的输出兼容（status / lastError
    走 V4.6 但旧 UI 字段仍能读出）。
  - 当 task 没有 V4.6 字段（兼容性 fallback）时旧路径保留。
- [ ] **Step 2-5**：替换 dispatch 入口为 coordinator；保持其余 V4.2
  invariant。
- [ ] **Step 6: Commit**：`feat(orchestrator): route dispatch through V4.6 coordinator`。

### Task 6.3：Phase 6 checkpoint

- [ ] 跑 `apps/orchestrator/src/agents/__tests__/coder` +
  `work-items/__tests__`。
- [ ] empty commit。

---

## Phase 7：Reviewer Agent + GitLab MR 推送

### Task 7.1：reviewer prompt 输出 schema 与解析

**Files:**

- Create: `apps/orchestrator/src/agents/reviewer.ts`
- Create: `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - mock lifecycle 返回带 JSON 输出 fence 的 reviewer message，
    `reviewer.run()` 解析出 `decision = "approve"` + `confidence = 0.91`
    + `findings = []` + `inlineComments = []`。
  - 解析失败 → AgentReport `status = "failed"`
    `lastError.code = "reviewer_cannot_review"`，
    message 注明 `prompt_output_schema_mismatch`。
- [ ] **Step 2-5**：实现 parser + reviewer.ts；`confidence` 字段
  序列化到两位小数（spec §11.1）。
- [ ] **Step 6: Commit**：`feat(orchestrator): reviewer agent parses structured output`。

### Task 7.2：findings + inline comments + severity threshold

**Files:**

- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 给定 reviewer 输出 6 个 finding（含 1 个 info / 2 minor / 2 major
    / 1 blocker），`severity_threshold = "minor"` 时 inline 列表过滤
    出 5 个；`max_inline_comments = 3` 时 inline 截断到 3，主 note
    中带聚合 `+2 more findings hidden`。
- [ ] **Step 2-5**：实现 reviewer 内部 findings → inlineComments 转换
  helper。
- [ ] **Step 6: Commit**：`feat(orchestrator): apply severity_threshold and max_inline_comments`。

### Task 7.3：GitLab notes 客户端

**Files:**

- Modify: `packages/tracker-gitlab/src/notes.ts`
- Modify: `packages/tracker-gitlab/src/__tests__/notes.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - `createMrInlineNote({ projectId, mrIid, body, position })` POST
    到 `/projects/:id/merge_requests/:iid/notes` 并返回 noteId。
  - `deleteMrNotes({ projectId, mrIid, noteIds })` 逐条 DELETE。
  - 403 / 401 错误 → 抛 `GitLabScopeMissingError`（带 missing scope
    名）。
- [ ] **Step 2-5**：实现，复用 `client.ts` HTTP layer。
- [ ] **Step 6: Commit**：`feat(tracker-gitlab): support MR inline notes create/delete with scope detection`。

### Task 7.4：`gitlab/mr-comments.ts` 推送 + revoke

**Files:**

- Create: `apps/orchestrator/src/gitlab/mr-comments.ts`
- Create: `apps/orchestrator/src/gitlab/__tests__/mr-comments.test.ts`

- [ ] **Step 1**：写失败测试覆盖（fake GitLab + redact）
  - `publishReviewerToMr({ reviewerReport, mrRef, options })` 推 1 主
    note + N inline，全部带 `[issuepilot-bot]` prefix；返回的
    `MrPublication` 包含 `noteIds`，`publishedAt`。
  - body 中的 token / key / URL 在 publish 前全部 redact。
  - publish 失败 → `MrPublication.status = "publish_failed"` +
    `error`；reviewer AgentReport 不报 failed（fail soft），但记录
    error 供 UI 提示。
  - `revokeReviewerMrComments({ noteIds })` 删除全部 note；如果某
    noteId 已被删除 → 视为成功（idempotent）。
  - GitLab scope 不足 → 转成 `cannot_review` 让 reviewer 写
    AgentReport `failed lastError.code = "reviewer_cannot_review"`。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): publish reviewer findings to GitLab MR with six safety rails`。

### Task 7.5：reviewer 与 coordinator 接线

**Files:**

- Modify: `apps/orchestrator/src/pipelines/coordinator.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/coordinator.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - coordinator 跑 reviewer 时通过 DI 拿到 `reviewer.run()` +
    `publishReviewerToMr()`；成功后 `MrPublication.status = "published"`
    被写进 ReviewerAgentReport。
  - publish_failed 时 AgentReport 仍 `complete`，但
    `MrPublication.status = "publish_failed"`，coordinator 不阻断
    auto_advance。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): wire reviewer publish flow into coordinator`。

### Task 7.6：Phase 7 checkpoint

- [ ] 跑 orchestrator reviewer / gitlab tests + tracker-gitlab tests。
- [ ] empty commit。

---

## Phase 8：Test/Evidence Agent

### Task 8.1：`agents/test-evidence.ts` 复用 V4.3 evidence 通道

**Files:**

- Create: `apps/orchestrator/src/agents/test-evidence.ts`
- Create: `apps/orchestrator/src/agents/__tests__/test-evidence.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 给定 mock evidence collector，`testEvidence.run({ task, workItem })`
    跑 CI (mock pnpm test) + Playwright walkthrough（mock screenshot），
    把产物写到 `<worktree>/.issuepilot/evidence/<taskId>/`；写一份
    `TestEvidenceAgentReport`：`status = "complete"`、`evidenceItems[]`。
  - mock screenshot 失败但 CI 成功 → `status = "incomplete"`、
    `lastError.code = "evidence_partial"`。
  - mock 写源码 → sandbox 抛 violation → `status = "failed"`、
    `lastError.code = "sandbox_violation"`，evidence 字段写已收集到的
    那部分。
- [ ] **Step 2-5**：实现，复用 V4.3 evidence collector helper（如
  `work-items/evidence-scanner.ts` / `evidence-merge.ts`）。
- [ ] **Step 6: Commit**：`feat(orchestrator): test-evidence agent runs CI + walkthrough and writes evidence`。

### Task 8.2：coordinator 接 test_evidence + supersede

**Files:**

- Modify: `apps/orchestrator/src/pipelines/coordinator.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/coordinator.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - 完整 full_pipeline happy path + evidence partial path 已经在
    Task 5.4 部分覆盖，本步加 retry 串：当 operator retry test_evidence
    单独这一步时，AgentReport supersede 链上 attempt = 2 且
    pipelineRunId 复用。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): support retrying test-evidence within same pipeline run`。

### Task 8.3：Phase 8 checkpoint

- [ ] 跑 test-evidence + coordinator 测试。
- [ ] empty commit。

---

## Phase 9：HTTP API + Daemon Wiring

### Task 9.1：`pipelines/service.ts` 高层方法

**Files:**

- Create: `apps/orchestrator/src/pipelines/service.ts`
- Create: `apps/orchestrator/src/pipelines/__tests__/service.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - `service.getPipelineForTask({ workItemId, taskId })` 返回最新
    PipelineRun + `pendingRecipe` + agentReports 摘要。
  - `service.setRecipeOverride({ workItemId, taskId, recipe })`：
    - task `planned` / `blocked_by_dependency` → 写 `pendingRecipe`。
    - task `ready` → 在最新 PipelineRun 中写 `recipe`（如还没创建
      PipelineRun 就 lazy 创建 draft）。
    - task `running_coding` 之后 → 抛 `RecipeOverrideLockedError`。
  - `service.revokeAiReview({ reportId, operator })`：
    - 不是 reviewer role → 抛 `RoleMismatchError`。
    - `mrPublication.status != "published"` → 抛 `NotRevocableError`。
    - 成功 → 调 `revokeReviewerMrComments`、AgentReport
      `mrPublication.status = "revoked"`。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): pipelines service exposes get/override/revoke`。

### Task 9.2：Fastify routes

**Files:**

- Create: `apps/orchestrator/src/pipelines/routes.ts`
- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **Step 1**：写失败测试覆盖（V4.6 routes 全部 200 / 400 / 404 / 409）：
  - `GET /api/work-items/:wid/tasks/:tid/pipeline` → 200，缺 task →
    404。
  - `GET /api/pipelines/:pid` / `GET /api/work-items/:wid/tasks/:tid/agent-reports`
    / `GET /api/pipelines/:pid/agent-reports` → 200 / 404。
  - `POST /api/work-items/:wid/tasks/:tid/recipe-override` body =
    `{ recipe: "coding_plus_reviewer" }`：
    - 任务 `planned` → 200 + `pendingRecipe` updated。
    - 任务 `ready` 且 PipelineRun draft 存在 → 200 + PipelineRun.recipe
      updated。
    - 任务 `running_coding` → 409 `recipe_override_locked`。
    - 未知 recipe → 400 `unknown_recipe`。
  - `POST /api/agent-reports/:rid/revoke-ai-review`：
    - reviewer role + published → 200。
    - 非 reviewer role → 400 `role_mismatch`。
    - 非 published → 409 `not_revocable`。
  - team 模式：缺 `x-issuepilot-project` → 400 `project_required`；显式
    传 `project` query → 400 `project_query_not_allowed`。
- [ ] **Step 2-5**：实现 routes + server wiring。
- [ ] **Step 6: Commit**：`feat(orchestrator): expose V4.6 pipeline routes via Fastify`。

### Task 9.3：daemon 注入

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon.test.ts`
- Modify: `apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - single daemon：从 `~/.issuepilot` 加 pipeline store + coordinator
    + service + service 注册到 server。
  - team daemon：每个 project 一份独立 store / coordinator。
  - 启动失败（缺 workflow 配置）→ daemon emit 友好 log，不 crash 进程。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(orchestrator): wire pipeline service into single + team daemons`。

### Task 9.4：Phase 9 checkpoint

- [ ] 跑 server + daemon + pipelines/service 测试。
- [ ] empty commit。

---

## Phase 10：V4.4 Quality + V4.5 Improvements 接入

### Task 10.1：V4.4 增量 FailurePatternId

**Files:**

- Modify: `apps/orchestrator/src/quality/types.ts`
- Modify: `apps/orchestrator/src/quality/patterns.ts`
- Modify: `apps/orchestrator/src/quality/__tests__/patterns.test.ts`
- Modify: `packages/shared-contracts/src/quality.ts`
- Modify: `packages/shared-contracts/src/__tests__/quality.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - `FailurePatternId` 新增枚举值（reviewer_unavailable /
    reviewer_requested_changes / reviewer_cannot_review /
    evidence_unavailable / evidence_partial / pipeline_cancelled /
    pipeline_init_failed / role_profile_invalid / runner_unavailable /
    coding_failed / sandbox_violation / redaction_failed / storage_full）。
  - `classifyFailure({ taskNode, latestAgentReport })` 给一个
    reviewer AgentReport `lastError = reviewer_cannot_review` →
    返回 `pattern: "reviewer_cannot_review"` + `bucket: "configuration"`。
- [ ] **Step 2-5**：实现，复用 `pipelines/failure-mapping.ts` 中的表
  保持双向一致；patterns.ts import failure-mapping。
- [ ] **Step 6: Commit**：`feat(quality): classify V4.6 reviewer/evidence/sandbox failure patterns`。

### Task 10.2：V4.4 by-role 切片

**Files:**

- Modify: `apps/orchestrator/src/quality/aggregate.ts`
- Modify: `apps/orchestrator/src/quality/__tests__/aggregate.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - mock report set 含 5 reviewer report，其中 3 approve / 1
    request_changes / 1 cannot_review，aggregate 返回
    `coder.success_rate` / `reviewer.approve_rate = 0.6` /
    `reviewer.cannot_review_rate = 0.2` / `reviewer.unavailable_rate = 0` /
    `test_evidence.evidence_complete_rate` / `partial_rate`，与 spec
    §17.4 计算公式一致。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(quality): aggregate by-role slice for V4.6 reports`。

### Task 10.3：V4.5 `ImprovementTargetKind` 加 `role_configuration`

**Files:**

- Modify: `packages/shared-contracts/src/improvement.ts`
- Modify: `packages/shared-contracts/src/__tests__/improvement.test.ts`
- Modify: `apps/orchestrator/src/improvements/templates.ts`
- Modify: `apps/orchestrator/src/improvements/engine.ts`
- Modify: `apps/orchestrator/src/improvements/__tests__/templates.test.ts`
- Modify: `apps/orchestrator/src/improvements/__tests__/engine.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - contract：`ImprovementTargetKind` 接受 `role_configuration`，
    type guard 同步更新；旧值仍合法。
  - templates：reviewer prompt / test_evidence prompt / role profile
    sandbox 三个 deterministic 模板各覆盖一条 V4.6 pattern。
  - engine：给定 quality summary 中 `reviewer_cannot_review` 出现 ≥3
    次 → 输出一条 `target.kind = "role_configuration"` 的
    `ImprovementRecommendation`。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(improvements): support role_configuration target for V4.6 patterns`。

### Task 10.4：Phase 10 checkpoint

- [ ] 跑 quality + improvements 测试。
- [ ] empty commit。

---

## Phase 11：Dashboard UI + i18n

### Task 11.1：`api.ts` 客户端方法

**Files:**

- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/lib/api.test.ts`

- [ ] **Step 1**：写失败测试覆盖
  - `getPipeline({ workItemId, taskId })` GET 正确 URL，带
    `x-issuepilot-project` header；错误时抛带 code 的 ApiError。
  - `getAgentReports({ workItemId, taskId | pipelineId })` 两种形式
    都覆盖。
  - `setRecipeOverride({ workItemId, taskId, recipe })` POST + body。
  - `revokeAiReview({ reportId })` POST。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): add V4.6 pipeline / agent-report / recipe / revoke API helpers`。

### Task 11.2：`pipeline-progress.tsx`

**Files:**

- Create: `apps/dashboard/components/work-items/pipeline-progress.tsx`
- Create: `apps/dashboard/components/work-items/pipeline-progress.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - render 三步进度条（coder / reviewer / test_evidence），每步带
    icon + label + status badge。
  - `recipe = coding_only` 时 reviewer / test_evidence 节点显示
    `skipped_by_recipe` 灰态，accessible via screen reader 的 aria
    描述齐全。
  - dark mode 与 light mode 两套 className 都覆盖（用
    `data-theme` toggle）。
- [ ] **Step 2-5**：实现，使用 Tailwind/shadcn 本地 primitives；进度条
  hover/click 展开详细信息（spec §17.2 / §23）。
- [ ] **Step 6: Commit**：`feat(dashboard): add PipelineProgress component`。

### Task 11.3：`agent-report-tabs.tsx`

**Files:**

- Create: `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Create: `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - render 三 tab（coder / reviewer / test_evidence），按 role 加载
    AgentReport，缺 report 时显示空态文案。
  - reviewer tab 展示 findings 表格（按 severity 排序）+ inline
    comments 折叠面板 + decision badge + revoke 按钮（仅 published 显示
    可点）。
  - test_evidence tab 复用 V4.3 evidence 列表（import 既有
    `evidence-tab.tsx`）；evidenceStatus = `skipped_by_recipe` 时显示
    灰态。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): add AgentReport tabs with reviewer findings + evidence view`。

### Task 11.4：`recipe-selector.tsx`

**Files:**

- Create: `apps/dashboard/components/work-items/recipe-selector.tsx`
- Create: `apps/dashboard/components/work-items/recipe-selector.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - 三个 recipe 选项 + 当前选中态（默认从 workflow default）；
    `pendingRecipe` 存在时 selector 显示 pending badge。
  - `running_coding` 之后调用 `setRecipeOverride` → 显示 disabled +
    tooltip `recipe_override_locked`。
  - i18n key 渲染。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): add recipe selector with pendingRecipe support`。

### Task 11.5：`revoke-ai-review-button.tsx`

**Files:**

- Create: `apps/dashboard/components/work-items/revoke-ai-review-button.tsx`
- Create: `apps/dashboard/components/work-items/revoke-ai-review-button.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - 仅 reviewer role 且 `mrPublication.status = "published"` 时按钮可见
    + 可点。
  - happy: 点击 → 调 `revokeAiReview` → 成功 → toast + button 变
    `revoked` 灰态。
  - 失败：API 抛 409 not_revocable → toast 提示。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): add RevokeAiReviewButton with confirmation flow`。

### Task 11.6：把上述组件挂到 `work-item-detail.tsx`

**Files:**

- Modify: `apps/dashboard/components/work-items/work-item-detail.tsx`
- Modify: `apps/dashboard/components/work-items/work-item-detail.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - 当前 task 详情下方先 PipelineProgress，再 RecipeSelector + Recipe
    helper tooltip，再 AgentReportTabs。
  - 若 task 没有 V4.6 数据（旧 task） → 渲染回退到旧 evidence tab
    + 提示「V4.6 数据不可用」。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): integrate V4.6 pipeline section into work-item detail`。

### Task 11.7：`app/work-items/[id]/page.tsx` 并行 fetch

**Files:**

- Modify: `apps/dashboard/app/work-items/[id]/page.tsx`
- Modify: `apps/dashboard/app/work-items/[id]/page.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - 页面 SSR 时并行调 `getWorkItem` / `getPipeline` /
    `getAgentReports`，把数据传给 `WorkItemDetail`。
  - team 模式：active project header 正确传递。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): fetch pipeline + agent reports on work item route`。

### Task 11.8：Reports 页面 by-role 切片渲染

**Files:**

- Modify: `apps/dashboard/components/reports/quality-analytics.tsx`
- Modify: `apps/dashboard/components/reports/quality-analytics.test.tsx`

- [ ] **Step 1**：写失败测试覆盖
  - 当 summary 含 by-role 字段时，渲染 6 个 metric tile +
    by-pattern table 中带 V4.6 新增 patternId。
- [ ] **Step 2-5**：实现。
- [ ] **Step 6: Commit**：`feat(dashboard): render V4.6 by-role metrics in reports page`。

### Task 11.9：i18n 中英 key

**Files:**

- Modify: `apps/dashboard/i18n/messages/zh.json`
- Modify: `apps/dashboard/i18n/messages/en.json`
- Modify: 之前 task 中各组件的 test（覆盖 i18n key 渲染）

- [ ] **Step 1**：写失败测试覆盖
  - `workItemPage.pipeline.recipe.full_pipeline` 等 spec §17.6 列出的
    全部 key 中英文都存在（用 vitest snapshot）。
  - 缺 key → 测试 fail。
- [ ] **Step 2-5**：补齐 key。
- [ ] **Step 6: Commit**：`feat(i18n): add V4.6 dashboard strings (zh + en)`。

### Task 11.10：Phase 11 checkpoint

- [ ] 跑 dashboard test。
- [ ] empty commit。

---

## Phase 12：E2E、Acceptance、Docs、CHANGELOG

### Task 12.1：`v4-6-multi-agent-e2e.test.ts`

**Files:**

- Create: `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts`

- [ ] **Step 1**：写失败测试覆盖 spec §22.7 七个场景：
  1. full_pipeline happy path → 三 AgentReport + awaiting_human_review。
  2. reviewer request_changes 返工 → coder retry → reviewer approve。
  3. test_evidence partial → evidenceStatus = partial。
  4. reviewer cannot_review (token scope) → blocked + dashboard 指引。
  5. sandbox_violation → failed + audit log。
  6. cancel mid-pipeline → needs_rework + last_cancelled_at + auto_advance
     skip。
  7. coding_only recipe → coder only + WorkItemReport.evidenceStatus
     = skipped_by_recipe。
- [ ] **Step 2-5**：用 fake codex lifecycle + fake GitLab adapter，
  share fixtures 与 V4.3 / V4.4 / V4.5 e2e。
- [ ] **Step 6: Commit**：`test(orchestrator): V4.6 multi-agent pipeline e2e suite`。

### Task 12.2：Acceptance 文件

**Files:**

- Create: `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`

- [ ] **Step 1**：按 V4.4 / V4.5 acceptance 文件格式，列出：
  - spec §24 全部 10 条验收项的勾选 checklist。
  - 验证命令清单（`scripts/ci-equivalent-check.sh` / 单测 / e2e）。
  - 视觉验证（dashboard 截图脚本，复用 `scripts/release/` 路径）。
- [ ] **Step 2: Commit**：`docs(v4.6): acceptance checklist`。

### Task 12.3：更新 V4 总 spec 实施计划节

**Files:**

- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

- [ ] **Step 1**：把 V4.6 状态从「spec 已制定」推进到「实施计划已写」并
  链向本 plan。
- [ ] **Step 2: Commit**：`docs(v4): mark V4.6 plan written in roadmap section`。

### Task 12.4：README / USAGE 同步

**Files:**

- Modify: `README.md`、`README.zh-CN.md`、`README.en.md`
- Modify: `USAGE.md`、`USAGE.zh-CN.md`

- [ ] **Step 1**：在 V4 roadmap 段加 V4.6 简述（pipeline / AgentReport
  / recipe / MR 推送 / revoke 按钮）。
- [ ] **Step 2: Commit**：`docs: surface V4.6 multi-agent pipeline in README / USAGE`。

### Task 12.5：CHANGELOG 终稿

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1**：在 `[Unreleased] V4.6 Multi-Agent Collaboration`
  段下补 Plan / Tests / Notes 子段：
  - **Plan**：本 plan 文件路径 + acceptance 文件路径。
  - **Tests**：列出 spec §22 7 个 suite + e2e 覆盖范围。
  - **Notes**：明确「不破坏现有 V4.1-V4.5」、「reviewer publish 默认
    开但失败 fail soft」、「V4.6 仅本地单机闭环」。
- [ ] **Step 2: Commit**：`docs(changelog): finalize V4.6 implementation entry`。

### Task 12.6：CI gate

- [ ] 跑 `bash scripts/ci-equivalent-check.sh`（或 `pnpm -r build && pnpm -r lint && pnpm -r test`）。
- [ ] 跑 `git diff --check`。
- [ ] empty commit `chore: V4.6 phase 12 (verification) checkpoint`，并把
  `bash scripts/ci-equivalent-check.sh` 输出贴到 PR 描述。

---

## Verification Gate

整套实现完成后，必须跑通：

```bash
bash scripts/ci-equivalent-check.sh
```

期望：

- `pnpm -F @issuepilot/shared-contracts test`、`@issuepilot/workflow test`、
  orchestrator pipelines / agents / quality / improvements / server /
  daemon 全部通过。
- dashboard `vitest run`、`tsc -b`、`next build` 通过。
- `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts` 与既有
  V4.3 / V4.4 / V4.5 e2e 同时通过。
- `git diff --check` 无白空格冲突。

如果机器上有 `pnpm` + 默认 Node 能加载 Rollup native module，也可以直接：

```bash
pnpm -r build && pnpm -r lint && pnpm -r test
```

发布或合并前必须有一种通过的 gate。

---

## Out-of-Scope Reminders（在每个 task 开头都自检）

- 不修改 `RunStatus` / `PipelineStatus` 等历史 enum（V4.6 `PipelineRunStatus`
  是独立 enum，禁止改写旧 enum）。
- 不修改 `ai-ready` / `ai-running` / `human-review` / `ai-rework` /
  `ai-failed` / `ai-blocked` label 状态机。
- 不引入 Postgres / 后台 job / LLM 兜底。
- 不写 token / 凭据到 store / dashboard / event / prompt。
- 不触碰 `elixir/` 目录。
- 不直接修改 V4.4 `apps/orchestrator/src/quality/*` 行为以外的语义
  （例如 not changing `/api/quality/summary` 已存在字段语义；只在
  schema 上做新增）。

---

## Risks & Mitigations

| 风险 | 缓解 |
| --- | --- |
| `WORKFLOW.md` 默认值仓库内已有大量 deployment，升级 `default_recipe` 可能让旧 task 突然全部跑 reviewer | Task 2.1 给 `default_recipe` 缺省 = `coding_only`；workflow YAML 解析输出 `warnings[]` 提示运维者可以选择切到 `full_pipeline` |
| reviewer prompt 输出 schema 难一次性命中 | Task 7.1 解析失败 fallback 到 `cannot_review`，coordinator 不会因此 crash；改 prompt 后下一轮自然恢复 |
| GitLab MR API rate limit / 网络错误 | Task 7.4 publish fail soft，写 `publish_failed`；revoke 按钮 idempotent；fail 时 reviewer AgentReport 仍 `complete` |
| `auto_advance` 与 cancel 竞态 | Task 5.5 用 `last_cancelled_at` 抑制 + coordinator 内 mutex 保证一次只一个 role 在跑 |
| 旧 task store 不带 V4.6 字段 | Task 5.1 在 store 读路径写 lazy migration + tests，保证 V4.1-V4.5 数据兼容 |
| 端到端测试覆盖面大 | Task 12.1 单独立 spec suite，复用 V4.3 / V4.4 / V4.5 fixtures，避免重复造数据 |

---

## Reference Skills

- `@superpowers:subagent-driven-development`：推荐执行方式，每个 task 派一个
  subagent 跑，task 之间夹 code review。
- `@superpowers:executing-plans`：另一种执行方式，inline 批量跑。
- `@superpowers:test-driven-development`：每个 task 内部循环依赖 TDD。
- `@superpowers:verification-before-completion`：在每个 phase checkpoint
  跑完整测试再 commit。
- `@superpowers:requesting-code-review`：每 1-2 个 phase 调用 code-reviewer。
- `@superpowers:receiving-code-review`：处理 reviewer 反馈时遵循。
- `ui-ux-pro-max`：Phase 11 UI 组件设计时遵循
  `progressive-disclosure` / `truncation-strategy` / `input-helper-text` /
  `success-feedback` / `error-clarity` 原则（spec §23）。
- `.codex/skills/commit/SKILL.md`：每次 commit 时遵循的提交规范（IssuePilot
  仓库内置）。
- `.codex/skills/push/SKILL.md` / `.codex/skills/land/SKILL.md`：完成实现
  后推 PR / 合并阶段使用。
