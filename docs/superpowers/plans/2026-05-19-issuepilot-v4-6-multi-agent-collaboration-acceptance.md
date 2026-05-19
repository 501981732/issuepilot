# IssuePilot V4.6 Multi-Agent Collaboration 验收清单

日期：2026-05-19
状态：implementation complete（待 PR 入主干前最终 CI gate）

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration.md`
- V4 总设计：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- 兼容前提：V4.1~V4.5 acceptance 清单（同目录）。

## 验收标准（spec §24）

> 与 design spec §24 一一对齐。任意一条未完成不得进入 release。

- [x] **(1) Coder → Reviewer → Test/Evidence pipeline**：coordinator
  按 recipe 顺序串联三个 role，单一 Codex app-server 多 role profile
  驱动；`pipelines/coordinator.ts` + 8 个 unit suite 覆盖（success / failed
  / cancelled / partial / publish / scope_insufficient / supersede /
  retry）。
- [x] **(2) AgentReport 三角色独立持久化**：`PipelineStore` 写入
  `agent-reports/<role>/<agent_report_id>.json` + `index.json`，supersede
  双向链；`pipelines/store.ts` 全套测试覆盖 round trip / supersede chain。
- [x] **(3) WorkflowRolesConfig 可校验**：`packages/workflow` 在 YAML
  解析阶段 fail closed（缺 role / prompt-template hash 校验失败 / sandbox
  非白名单 → `warnings[]`），并由 `/api/workflows/_validate-roles` 暴露给
  dashboard。
- [x] **(4) Recipe 三档**：`full_pipeline` / `coding_plus_reviewer` /
  `coding_only`；`workflowDefault` + operator `pendingRecipe`（写入 task
  `pendingRecipe` 字段并由 dashboard `RecipeSelector` 操作）；启动后 lock。
- [x] **(5) PipelineRun 状态机**：覆盖 9 个 status（pending /
  running_coding / running_reviewer / running_test_evidence /
  awaiting_human_review / awaiting_rework / partial / failed /
  cancelled），TaskNode 对应增加 `running_coding` / `running_reviewer`
  / `running_test_evidence` / `awaiting_human_review`，dashboard
  `task-list` / `task-graph` 全部上色。
- [x] **(6) Reviewer publish 默认开 + fail soft**：`reviewerPublisher`
  注入 GitLab MR 推送；publish 失败/scope 不足时 reviewer 报告依然
  `complete`（spec §16.3），inline comments 与 summary 不被丢；dashboard
  显示 `mr.published / publish_failed / scope_insufficient` 状态。
- [x] **(7) Revoke AI Review**：`POST /api/agent-reports/:id/revoke-ai-review`
  幂等地把 reviewer 在 GitLab MR 上的 note 删除并写
  `mrPublication.status = revoked`；dashboard `RevokeAiReviewButton`
  根据 `mrPublication.status` 启用/禁用并显示原因（i18n 全覆盖）。
- [x] **(8) Cancel + last_cancelled_at**：cancel 写入 task
  `last_cancelled_at`，下一次 startPipeline 自动清零；`auto_advance` 在
  `last_cancelled_at` 存在时被抑制；`pipelines/__tests__/auto-advance.test.ts`
  + e2e `cancel mid-pipeline` 覆盖。
- [x] **(9) V4.4 quality + V4.5 improvements 接入**：`FailurePatternId`
  增加 13 个 V4.6 值（reviewer_* / evidence_* / pipeline_* /
  role_profile_invalid / sandbox_violation / coding_failed / redaction_failed
  / storage_full）；`QualitySummaryResponse.byRole` 切片；`ImprovementTargetKind`
  新增 `role_configuration`；dashboard `ByRolePanel` 渲染 6 个 metric tile。
- [x] **(10) 不破坏现有 V4.1-V4.5**：旧工作单元在 store 读取 lazy
  migration；dashboard `V46PipelineSections` 仅在 SSR 传入
  `pipelinesByTask` 时渲染；orchestrator 旧 V4.2 dispatch 路径保留；e2e
  suite 与 V4.3 / V4.4 / V4.5 e2e 并存通过。

## 验证命令

```bash
# Shared contracts
pnpm --filter @issuepilot/shared-contracts exec vitest run

# Orchestrator: pipeline + quality + improvements + e2e
pnpm --filter @issuepilot/orchestrator exec vitest run \
  src/pipelines \
  src/quality \
  src/improvements \
  src/server/__tests__/server.test.ts \
  src/__tests__/v4-6-multi-agent-e2e.test.ts

# Dashboard: lib + components + reports + work-items
pnpm --filter @issuepilot/dashboard exec vitest run

# 项目级别 gate（任选其一，发布前必须有一种通过）
bash scripts/ci-equivalent-check.sh
# 或
pnpm -r build && pnpm -r lint && pnpm -r test

# 白空格检查
git diff --check
```

## 验证记录

- 2026-05-19：`@issuepilot/shared-contracts` 全测通过（含 13 个新
  `FailurePatternId` / `role_configuration` / `QualityByRoleSlice`
  断言）。
- 2026-05-19：`@issuepilot/orchestrator` 全测通过：
  - 8 个 V4.6 pipeline unit suite（coordinator / store / service /
    routes / recipe / role-profile / auto-advance / failure-mapping）
    全绿；
  - `quality/__tests__/patterns.test.ts` + `aggregate.test.ts` 新增
    `classifyAgentFailure` + `buildByRoleSlice` 用例全绿；
  - `improvements/__tests__/templates.test.ts` 新增
    `role_configuration` 模板用例全绿；
  - `src/__tests__/v4-6-multi-agent-e2e.test.ts`（本次新增）8 个 e2e
    场景全绿，覆盖 spec §22.7 全部 7 个核心 + 2 个 plan 补充场景；
  - server / daemon 测试 PASS；
- 2026-05-19：`@issuepilot/dashboard` 全测通过（44 文件 / 276 用例），
  含 V4.6 新增 6 个 agent-report-tabs 用例 / 9 个 revoke 用例 / 12 个
  recipe 用例 / pipeline-progress 用例 / quality by-role 用例。
- 2026-05-19：`tsc -b apps/dashboard` 与 `tsc -b apps/orchestrator`
  PASS；`eslint --max-warnings 0` 覆盖新增 / 修改文件 PASS。
- 2026-05-19：`git diff --check` PASS（commit 前）。
- 待发布前：在 CI host 上跑 `bash scripts/ci-equivalent-check.sh`，
  把输出贴到 PR 描述。

## 视觉验证

- 启动本地 daemon + dashboard 后，打开任意进入 V4.6 pipeline 的工作单元
  详情页，应能看到：
  1. `PipelineProgress` 三步可视化（Coder → Reviewer → Test/Evidence），
     当前 running role 高亮 + recipe badge。
  2. `RecipeSelector` 在 task 启动前可切换三档；启动后 lock 并显示
     pending recipe（如果有）。
  3. `AgentReportTabs` 三 tab：reviewer 面板含 decision badge、findings
     表格（按 severity 排序）、inline 评论列表、MR publication 状态、
     `RevokeAiReviewButton`；test_evidence 面板列 evidenceItems。
- 进入 `/reports` 页面，`ByRolePanel` 渲染 6 个 V4.6 metric tile（含
  coder success / reviewer approve / cannot_review / unavailable /
  test_evidence complete / partial），未提供字段以 `—` 占位。
- 截图脚本仍走 `scripts/release/screenshots.sh`（与 V4.5 acceptance
  一致），新增 `v4-6-pipeline.png` / `v4-6-reports-by-role.png` 两张
  对照截图。

## Out-of-Scope 自检

- ✅ 没改 `RunStatus` / `PipelineStatus` 历史 enum；V4.6 `PipelineRunStatus`
  为独立 enum。
- ✅ 没改 `ai-ready` / `ai-running` / `human-review` / `ai-rework` /
  `ai-failed` / `ai-blocked` label 状态机。
- ✅ 没引入 Postgres / 后台 job / LLM 兜底。
- ✅ 没把 token / 凭据写入 store / dashboard / event / prompt。
- ✅ 没触碰 `elixir/` 目录。
- ✅ `/api/quality/summary` 已存在字段语义未变；只在 schema 上新增
  `byRole` 切片字段（可选）。
