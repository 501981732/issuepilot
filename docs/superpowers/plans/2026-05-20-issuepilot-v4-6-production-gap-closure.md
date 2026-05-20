# V4.6 Production Gap Closure 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` 按 task 顺序推进。若拆给多个 agent，必须保证
> 写入文件互不重叠，并在每个 task 后更新本计划 checkbox。所有 step 使用
> `- [ ]` 语法，便于跟踪。

**Goal：** 把 V4.6 从“基础实现与 review follow-up 已合并”推进到“单机
production path 可真实闭环”：dashboard / work-item acceptance 能启动
`PipelineRun`，workflow roles 能稳定生成 profile hash，coder / reviewer /
test_evidence 能从真实 Codex lifecycle 产出可解析报告，reviewer inline
comments 能发布并撤回，quality / dashboard 不隐藏 500 / 503 和失败模式。

**Architecture：**

1. `WorkItemService` / `work-items/orchestration` 在 V4.6 可用时走
   `PipelineCoordinator.startPipeline`，旧 `dispatchTask` 路径保留为 V4.5
   fallback。
2. Workflow loader 在生产入口直接调用 `resolveWorkflow()`，让
   `roles.*.promptTemplateHash` 在 daemon 装配前就已存在。
3. Codex app-server lifecycle adapter 捕获最终 agent 输出和必要的 git diff /
   branch 元数据，`createCoderAgent` / `createReviewerAgent` 不再依赖空
   `rawMessage`。
4. `@issuepilot/tracker-gitlab` 读取 MR `diff_refs`，daemon 注入
   `publishReviewerToMr` / `revokeReviewerMrComments`，MR publish / revoke 走
   同一套持久化 `noteIds`。
5. Quality aggregate 同时读取旧 evidence items 和 V4.6 `AgentReport`，dashboard
   SSR 对 500 / 503 保持可见，避免把生产装配问题静默吞掉。

**Tech Stack：**

- TypeScript 5（`strict` + `exactOptionalPropertyTypes`）
- Vitest 2.x
- Fastify 4 orchestrator API
- Next.js 14 App Router dashboard SSR
- `@issuepilot/workflow` 的 `resolveWorkflow`
- `@issuepilot/runner-codex-app-server` 的 RPC lifecycle
- `@issuepilot/tracker-gitlab` GitLab REST adapter
- `scripts/ci-equivalent-check.sh`

---

## 当前结论

- `docs/superpowers/plans/2026-05-20-v4-6-followup-critical-fixes.md` 中的
  review follow-up 变更已经以 commit 形式落地，`SKIP_E2E=1
  scripts/ci-equivalent-check.sh` 已通过。
- 但 2026-05-20 复审确认 V4.6 **还不是 production-ready**。当前问题不是单测
  或 UI 拼装，而是生产入口、workflow 解析、Codex lifecycle 输出、GitLab
  `diff_refs`、team revoke、quality failure drilldown 与 dashboard error
  honesty 还没有形成真实闭环。
- 本计划收口这些缺口。完成本计划前，不应在 README / CHANGELOG / acceptance 中
  再声明 V4.6 “production-wired” 或 “已完整覆盖”。

## Task 1：文档状态校正，停止过度宣称 V4.6 已完成

**Why：** README / CHANGELOG / acceptance 当前把上一轮 follow-up 描述成
“production-wired / 已完整覆盖”，但 reviewer publisher、生产启动入口和
Codex final output 尚未闭环。这会误导后续执行者。

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`
- Modify:
  `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`

- [x] Step 1.1：把 “V4.6 已交付 / production-wired / 已完整覆盖” 改为
  “V4.6 基础实现已落地，production gap closure 进行中”。
- [x] Step 1.2：在 acceptance 的 review follow-up 后增加
  “Production gap review（2026-05-20）” 小节，列出本计划的 blocking gaps。
- [x] Step 1.3：同步中英文 README；英文 README 不新增与中文不同的承诺。
- [x] Step 1.4：运行 `git diff --check`。

**Expected output：** 文档只声明已验证事实，并指向本计划作为下一轮生产闭环来源。

## Task 2：Workflow loader 生产入口生成 role prompt hash

**Why：** `buildRoleProfile` 要求 `role.promptTemplateHash` 存在，但
`createWorkflowLoader().loadWorkflow()` 目前只 parse / expand / validate，
没有调用 `resolveWorkflow()`。生产 daemon 直接加载 workflow 时会在 role
profile 阶段失败。

**Files:**

- Modify: `packages/workflow/src/loader.ts`
- Modify: `packages/workflow/src/resolve.ts`（仅在需要导出辅助类型时修改）
- Modify: `packages/workflow/src/__tests__/loader.test.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts`

- [x] Step 2.1：写红测：workflow YAML 只声明 role prompt template，不显式写
  `promptTemplateHash`，`loadWorkflow()` 返回后每个 role 都有稳定 hash。
- [x] Step 2.2：在 loader 内调用 `resolveWorkflow()`，避免 daemon 调用方各自补。
- [x] Step 2.3：补一条 role-profile 测试，确认 loader 返回值可直接
  `buildRoleProfile()`。
- [x] Step 2.4：运行 `npx vitest run packages/workflow
  apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts`。

**Expected output：** daemon 装配 V4.6 roles 不再因缺 hash 抛错。

## Task 3：生产 work-item 路径启动 PipelineRun

**Why：** `PipelineCoordinator.startPipeline()` 已存在，但生产
`WorkItemService.acceptPlan()` / `tickWorkItem()` 仍只调用 legacy
`dispatchTask`。dashboard API 即使有 pipeline route，也不会从真实
work-item acceptance 进入 V4.6 pipeline。

**Files:**

- Modify: `apps/orchestrator/src/work-items/service.ts`
- Modify: `apps/orchestrator/src/work-items/orchestration.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
- Modify: `apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`

- [x] Step 3.1：给 orchestration deps 增加可选 `startPipelineForTask`，
  保留 `dispatchTask` fallback。
- [x] Step 3.2：当 task recipe / workflow role config 表明 V4.6 可用时，调用
  `startPipelineForTask({ workItemId, taskId, recipe })`。
- [x] Step 3.3：daemon 注入真实 coordinator start 方法，team daemon 使用项目级
  store / workflow / tracker 上下文。
- [x] Step 3.4：写集成测试：accept plan 后 task 进入 `PipelineRun`，
  coordinator 写入 coder / reviewer / test_evidence `AgentReport`。
- [x] Step 3.5：确认 legacy tests 仍能在无 pipeline deps 时通过。

**Expected output：** operator 从 dashboard / work-item accept plan 触发的是真实
V4.6 pipeline，而不是只存在于测试里的 coordinator。

## Task 4：Codex lifecycle adapter 捕获最终输出与 coder diff

**Why：** 当前 reviewer agent 从 lifecycle adapter 拿到的 `rawMessage` 为空，
`parseReviewerOutput()` 必然 `parse_failed`。Coder report 也缺少真实 diff /
branch 来源，导致 dashboard 与 parent handoff 只能显示空摘要。

**Files:**

- Modify: `packages/runner-codex-app-server/src/lifecycle.ts`
- Modify: `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts`
- Modify: `apps/orchestrator/src/agents/codex-lifecycle.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts`
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/agents/coder.ts`
- Modify: `tests/e2e/fixtures/codex.happy.json`

- [x] Step 4.1：用红测证明 completed reviewer lifecycle 能返回 JSON fenced
  final message，并被 `parseReviewerOutput()` 解析为 findings。
- [x] Step 4.2：扩展 `DriveResult`，捕获最后一条 assistant / notification
  文本；如果协议只有 notification，明确用最后一条非空 message。
- [x] Step 4.3：coder agent 在 cwd 内读取当前 branch 与 diff summary；失败时
  fail soft 写入 `lastError`，不吞掉 agent 完成状态。
- [x] Step 4.4：更新 fake Codex fixture，让 e2e 覆盖非空 reviewer JSON 和
  coder diff summary。
- [x] Step 4.5：运行 runner lifecycle + orchestrator agent tests。

**Expected output：** reviewer agent 可产生 `decision/findings/inlineComments`，
coder report 有可读 `diffSummary` 和 branch 信息。

## Task 5：GitLab MR `diff_refs` 接入并注入 reviewer publisher

**Why：** `publishReviewerToMr()` 需要 `baseSha/startSha/headSha` 才能创建 inline
position。当前 GitLab adapter 的 MR summary 不返回 `diff_refs`，daemon 因此只
能 defer publisher injection。

**Files:**

- Modify: `packages/tracker-gitlab/src/types.ts`
- Modify: `packages/tracker-gitlab/src/merge-requests.ts`
- Modify: `packages/tracker-gitlab/src/__tests__/merge-requests.test.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/gitlab/__tests__/mr-comments.test.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`

- [x] Step 5.1：扩展 `MergeRequestSummary`，映射 GitLab REST `diff_refs` 为
  `baseSha/startSha/headSha`。
- [x] Step 5.2：在单 daemon 注入 `reviewerPublisher`，调用
  `publishReviewerToMr()` 并持久化返回 `noteIds`。
- [x] Step 5.3：在 team daemon 注入同等 publisher，按 project context 选
  GitLab client 和 MR。
- [x] Step 5.4：写测试覆盖 inline note 成功、`scope_insufficient`、publish
  fail soft、redaction 写入 `redactedFields[]`。
- [x] Step 5.5：确认 publisher 缺失时仍保持 explicit `skipped_by_config`，
  不伪装成功。

**Expected output：** reviewer findings 能真实发布到 GitLab MR inline comments，
并记录可撤回的 note ids。

## Task 6：Team daemon revoke 接真实 GitLab 删除路径

**Why：** 单 daemon 已有 revoke helper，team daemon 仍有未接线 callback。
team 模式下点击 revoke 不能保证删除 GitLab notes。

**Files:**

- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/service.test.ts`

- [x] Step 6.1：复用 Task 5 的 team GitLab client / MR diff refs 解析路径。
- [x] Step 6.2：team revoke 调 `revokeReviewerMrComments()`，成功后清空
  `mrPublication.noteIds`。
- [x] Step 6.3：测试 team mode 下 revoke 删除全部 `[ai-reviewer]` note ids，
  部分删除失败时保留可重试错误。

**Expected output：** 单机和 team 模式 revoke 语义一致。

## Task 7：AgentReport failure 纳入 quality failure patterns / drilldown

**Why：** `classifyAgentFailure()` 已支持 V4.6 失败类型，但
`buildQualitySummary()` 当前只从旧 `input.items` 分类失败；AgentReports 只进入
`byRole`，不会进入 failure pattern 和 drilldown。

**Files:**

- Modify: `apps/orchestrator/src/quality/aggregate.ts`
- Modify: `apps/orchestrator/src/quality/__tests__/aggregate.test.ts`
- Modify: `apps/dashboard/components/reports/quality-dashboard.tsx`

- [x] Step 7.1：写红测：failed reviewer report with `lastError.code =
  "scope_insufficient"` 出现在 `failurePatterns` 和 drilldown rows。
- [x] Step 7.2：aggregate 遍历 `agentReports`，调用 `classifyAgentFailure()`，
  并保留 role / reportId / workItemId / taskId drilldown refs。
- [x] Step 7.3：dashboard drilldown 展示 role/report 维度，不破坏旧 run rows。

**Expected output：** `/reports` 能看到 V4.6 reviewer / coder / test_evidence
失败模式，不只看到 by-role 计数。

## Task 8：API / Dashboard error honesty

**Why：** `GET /api/agent-reports/:id` 在 pipeline service 不可用时返回 503，但
body code 仍是 `agent_report_not_found`；dashboard SSR 又吞掉所有 `ApiError`，
导致生产装配失败在页面上表现为“没有 report”。

**Files:**

- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`
- Modify: `apps/dashboard/app/work-items/[id]/page.tsx`
- Modify: `apps/dashboard/components/work-items/work-item-detail.tsx`
- Modify: `apps/dashboard/app/work-items/[id]/page.test.tsx`（若存在）

- [x] Step 8.1：503 body code 改为 `service_unavailable` 或
  `pipelines_unavailable`，message 明确 pipeline service missing。
- [x] Step 8.2：dashboard agent-report SSR 只对 400 / 404 fail soft；500 / 503
  继续抛出或进入明确 error state。
- [x] Step 8.3：`pipelineRun: null` 时不渲染空 V4.6 panel。
- [x] Step 8.4：补 SSR 测试覆盖 404 soft、503 visible failure、null pipeline no
  section。

**Expected output：** 生产装配错误不会被 dashboard 静默隐藏。

## Task 9：端到端验收与状态发布

**Why：** 只有从 workflow load → work-item accept → PipelineRun →
AgentReports → MR publish / revoke → quality drilldown → dashboard SSR 全链路
跑通，才可以把 V4.6 状态改成 production-ready。

**Files:**

- Modify:
  `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`

- [x] Step 9.1：新增 fake Codex + fake GitLab end-to-end test，覆盖 start /
  reviewer publish / revoke / quality / dashboard data shape。
- [x] Step 9.2：运行 `scripts/ci-equivalent-check.sh`。若因本机环境无法跑完整
  e2e，必须记录具体失败原因；不能用单测替代 production-ready 结论。
- [x] Step 9.3：只有完整 gate 通过后，才把 README / CHANGELOG / acceptance
  改成 V4.6 production-ready。
- [x] Step 9.4：最终 `git diff --check`。

**Expected output：** V4.6 release note 有完整证据链；否则保持
“production gap closure in progress”。

**Verification record（2026-05-20）：**

- Targeted tests PASS：orchestrator `daemon-task4b-wiring` / `team/daemon` /
  `server` / `quality/aggregate`，shared-contracts `api`，dashboard
  work-item SSR / detail / quality analytics。
- `scripts/ci-equivalent-check.sh` PASS：`tsc -b`、scripts tsc、Next build、
  eslint、per-package vitest（含 `tests/e2e` 51 tests）、`git diff --check`。

**Post-review repair（2026-05-20）：**

复审发现 V4.6 production gap closure 仍有 5 个闭环缺口，本轮已补齐：

- coder lifecycle 现在会记录 `gitlab_create_merge_request` tool result，写入
  `coder.mergeRequest`；单 daemon / team daemon 给 V4.6 coder 注入真实
  GitLab tools。
- V4.6 `PipelineRun` 完成后会生成 `RunReportArtifact`、`TaskRunLink` 和
  `TaskNode` 状态，work-item aggregate / handoff / downstream dependency 不再
  只感知旧 `RunReport`。
- reviewer publish / revoke 按同一 `pipelineRun.agentReportIds.coder` 查找 MR，
  不再误用同 task 的最新 coder report。
- V4.6 `AgentReport` 增加 `workItemId`，quality drilldown 跳转到真实
  `/work-items/:id?agentReport=...`。
- quality status filter 会保留匹配的 V4.6 `AgentReport.lastError` failure
  rows，不再在 `run-failed` / `run-blocked` 等筛选下隐藏 agent failures。

Post-review targeted verification PASS：

- `npx vitest run src/__tests__/lifecycle.test.ts`
  （`packages/runner-codex-app-server`）
- `npx vitest run src/agents/__tests__/codex-lifecycle.test.ts
  src/work-items/__tests__/orchestration.test.ts
  src/quality/__tests__/aggregate.test.ts
  src/__tests__/daemon-task4b-wiring.test.ts
  src/__tests__/daemon-pipeline-wiring.test.ts
  src/server/__tests__/server.test.ts`（`apps/orchestrator`）
- `npx vitest run components/reports/quality-analytics.test.tsx`
  （`apps/dashboard`）
- `npx tsc -b packages/shared-contracts packages/runner-codex-app-server
  packages/workflow packages/tracker-gitlab apps/orchestrator apps/dashboard`
- `git diff --check`
- `bash scripts/ci-equivalent-check.sh` 全 stage PASS：`tsc -b`、scripts
  tsc、Next build、eslint、per-package vitest（含 orchestrator 78 files /
  928 tests、dashboard 44 files / 281 tests、`tests/e2e` 51 tests）、
  `git diff --check`。
