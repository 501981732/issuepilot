# IssuePilot V4.7 Runner Adapter Contract 验收清单

> 关联文档
> - Spec: `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`
> - 实施计划: `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract.md`

日期：2026-05-20
状态：实施完成 + full gate verification 通过 + post-merge code review 三轮 fix 闭环

## 范围声明

V4.7 只完成了把 V4.6 三角色 pipeline 从 Codex-specific lifecycle 抽象到稳定的本地 Runner Adapter Contract。明确的非目标：

- 不接第二种 runner kind；`codex_app_server` 仍是 V4.7 唯一支持的 kind。
- 不引入动态 runner discovery、worker pool、远程 runner service 或 SDK。
- 不修改 `PipelineCoordinator` 状态机或 V4.6 业务语义。

## 验收清单

- [x] Shared runner contract 在 `packages/shared-contracts/src/runner.ts` 导出并通过 type guard 测试。
- [x] `AgentReportBase` 包含 `runnerId` / `runnerKind` / `runnerRunId` 字段；`isAgentReport()` 拒绝缺失这些字段的旧 fixture。
- [x] Workflow `runners:` registry 在 `packages/workflow/src/parse.ts` 解析；`runners` 缺失时 fallback 到内置 `codex_app_server` descriptor 并 emit warning。
- [x] `runners.codex_app_server.options` 拒绝 `env` / `token` / `secret` / `credential` / `cwd` / `workspace_root` / unknown keys。
- [x] `resolveWorkflow()` 在 `packages/workflow/src/resolve.ts` 静态校验 runner id / kind / capability / role sandbox；fail closed。
- [x] orchestrator `RunnerRegistry` 在 `apps/orchestrator/src/runners/registry.ts` 仅按 `runnerId` 查找 adapter，缺失时抛 `runner_unavailable`。
- [x] `RunnerErrorCode → LastErrorCode` 映射在 `apps/orchestrator/src/runners/failure-mapping.ts` 表驱动并测试覆盖。
- [x] Codex app-server 通过 `createCodexAppServerAdapter` 实现 `RunnerAdapter`；`completed` / `failed` / `cancelled` / `timeout` / `blocked` 全部映射到标准 `RunnerResult`；`blocked` 不会以原状暴露给上游。
- [x] adapter 在 emit / return 之前 redact `finalMessage`、`RunnerArtifact.summary`、`RunnerError.message` 与 `RunnerEvent.message`；`RunnerResult.redactedFields[]` 记录被改写的字段路径。
- [x] **post-merge review B1 修复**：`NOTIFICATION_EVENT_TYPE` 对齐到 `packages/runner-codex-app-server/src/lifecycle.ts` 实际 emit 的内部下划线事件名（`session_started` / `turn_started` / `tool_call_started` / `tool_call_completed` / `tool_call_failed` / `notification` / `turn_failed` / `turn_cancelled` / `turn_timeout` / `turn_completed`），生产环境流式 `RunnerEvent` 现在能真实到达 daemon `RunnerEventSink` 与下游事件存储；`apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts` 新增 B1+M1 回归用例验证真名链路。
- [x] **post-merge review H1+H2 修复**：adapter 在 `completed` 路径用 `execa("git", ["rev-parse", "--abbrev-ref", "HEAD"])` / `execa("git", ["diff", "--stat", "HEAD"])` 真实采集 worktree 状态，并以 `kind: "diff"` artifact（头部 `branch:<name>\n`）输出；agent factory 拆头部回填 `CoderAgentReport.coder.branch`，剩余部分作为 `diffSummary`，不再用 `kind: "text"` 兜底，杜绝 Codex `final_message` 散文污染 dashboard 与 RunReport.diff。`report-artifact.ts` 把 branch / diff fallback 改为 `||` 让空字符串也走 `pipeline:<id>` / `"not available"`。
- [x] **post-merge review M1 修复**：`run()` 在 `onEvent("turn_started", { turnId })` 时立刻缓存 `lastTurnId`，streaming 中的 `tool_call_*` / `runner_message` 事件都能带正确的 `RunnerEvent.runnerRunId`，不再等 `driveLifecycle` resolve。
- [x] **post-merge review M2 修复**：`apps/orchestrator/src/agents/__tests__/{coder,reviewer,test-evidence}.test.ts`、`apps/orchestrator/src/__tests__/{daemon-pipeline-wiring,daemon-task4b-wiring}.test.ts` 中 fixture 的 `RunnerDescriptor.capabilities` 从过期 sandbox 名（`filesystem.read_write_worktree` 等）切回 V4.7 真值（`filesystem.worktree_write` / `filesystem.readonly`），并移除已弃用的 `runnerProfileHash` / `config` 字段，让测试 fixture 与 `packages/shared-contracts/src/runner.ts` 的 `RUNNER_CAPABILITY_VALUES` 保持一致。
- [x] **post-merge review N2 修复**：dashboard `RunnerTrace` 的 label 与 runner kind display name 走 `workItem.agentReportTab.runnerTrace.*` i18n，zh/en bundle 同步补全 `runner` / `kind` / `run` / `kinds.codex_app_server` key；未列入白名单的 runner kind 回退到原 enum 值以避免 next-intl 4.x missing-key 抛错。
- [x] **三轮 review N-1 修复**：`readWorkspaceGitSummary` 把 `git rev-parse` / `git diff --stat` 拆成独立 timeout（2s / 15s）；每条命令的非零退出 / 异常都通过 `console.warn("[runner] git rev-parse|diff degraded ...")` surface，cwd 路径在日志里只保留尾部 60 字符防泄漏，杜绝 H1 在生产边界静默退回到空 branch。
- [x] **三轮 review N-2 修复**：新增 `packages/observability/src/event-store-batching.ts` 的 `createBatchedEventStore`，把同一 `(projectSlug, issueIid)` 的多次 `append` 在 250ms 内 / 50 条以内合并成单次 `fs.appendFile`；daemon 默认包裹 batched store 并在 `stop()` 调 `dispose()` drain。7 个 vitest 用例覆盖合并写、size flush、跨 key 顺序、read-after-write、`dispose()` 后兜底、redact 透传、`onError`。
- [x] **三轮 review N-3 修复**：`tool_call_failed` 改映射到 `runner_message`（不再借用 `tool_call_completed`），dashboard 能按事件 type 区分失败的工具调用；codex-app-server adapter 测试加 N-3 regression。
- [x] **三轮 review N-4 修复**：adapter 在 `mapDriveResultToRunnerResult` 返回前 emit 一次终态事件（`TERMINAL_EVENT_TYPE_BY_STATUS` 把 `DriveResult.status` 映射到 `runner_completed` / `runner_failed` / `runner_cancelled`），让 V4.7 contract 里的终态 enum 不再是 dead value；同步去掉 `turn_completed → runner_message` 映射（避免多 turn 误以为 LLM 又输出散文）。
- [x] **三轮 review N-5 修复**：`agent-report-tabs.tsx` 的 `KNOWN_RUNNER_KINDS` 复用 `RUNNER_KIND_VALUES`，消除与 contract 的 dual source of truth；V4.8 加 second runner 时类型系统会主动提醒补 case。
- [x] **三轮 review N-6 修复**：`runnerKindLabel(kind, t)` 用 switch exhaustive 替换 `as` cast，TypeScript `never` 兜底分支保证 `RUNNER_KIND_VALUES` 扩容时不漏 case。
- [x] **三轮 review follow-up 修复**：`buildFailureArtifacts` 在 failed / cancelled / timeout 路径下也抽 MR artifact；`RunnerResultCancelled` / `RunnerResultTimeout` contract 加 optional `artifacts?`；`coder.ts` failed / timeout 分支也读 `parseArtifacts(...).mergeRequest` 回填 `CoderAgentReport.coder.mergeRequest`，让"pipeline 后期失败但 MR 已建好"场景不再丢 MR iid。
- [x] Coder / Reviewer / Test Evidence agent factory 通过 `runnerRegistry.getForRole()` 获取 adapter，并把 runner 追溯字段写进 `AgentReport`；runner 失败时通过 `runnerErrorToLastErrorCode()` 映射到 `lastError.code`。
- [x] 单机 `daemon.ts` 与 team `team/daemon.ts` 不再直接构造 Codex lifecycle，统一通过 `createRunnerRegistry` + `createCodexAppServerAdapter` 装配。
- [x] daemon 通过 `currentWorkItemByCallKey` 把 `WorkItem` 上下文限定到具体 pipeline run / task / role，避免跨 issue 污染 tools 或 event。
- [x] `apps/dashboard/components/work-items/agent-report-tabs.tsx` 在每个 role panel 内紧凑展示 runner trace；`runnerRunId` 缺失时不渲染空槽位。
- [x] V4.6 multi-agent e2e 在 `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts` 新增断言：persisted `AgentReport` 必须包含 `runnerId` / `runnerKind` = `codex_app_server`。
- [x] V1 E2E fixture `tests/e2e/fixtures/workflow.fake.md.tpl` 增加 `runners:` 声明，向前兼容 V4.7 schema。
- [x] `scripts/ci-equivalent-check.sh` 全量通过（`SKIP_E2E=1`，无 `pnpm` 环境下使用 `NODE_BIN_DIR=...`）；下面 verification record 给出确切的 exit code = 0 与各 stage 输出摘要。

## 受影响的关键文件

```
packages/shared-contracts/src/runner.ts                     # 新建
packages/shared-contracts/src/agent-report.ts               # +runnerId/kind/runId
packages/shared-contracts/src/workflow-role.ts              # +runner
packages/workflow/src/parse.ts / resolve.ts / types.ts      # runners registry / capability validation
apps/orchestrator/src/runners/{registry,failure-mapping,codex-app-server,types}.ts
apps/orchestrator/src/agents/{coder,reviewer,test-evidence}.ts
apps/orchestrator/src/daemon.ts
apps/orchestrator/src/team/daemon.ts
apps/orchestrator/src/pipelines/role-profile.ts
apps/dashboard/components/work-items/agent-report-tabs.tsx
apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts
tests/e2e/fixtures/workflow.fake.md.tpl
```

## Verification record (2026-05-20)

- `cd apps/orchestrator && npx vitest run` → 80 files, 942 tests PASS
- `cd apps/dashboard && npx vitest run` → 44 files, 283 tests PASS
- `cd packages/workflow && npx vitest run` → PASS (Task 2 完成时记录)
- `cd packages/shared-contracts && npx vitest run` → PASS (Task 1 完成时记录)
- `cd packages/runner-codex-app-server && npx vitest run` → PASS (Task 4 完成时记录)
- `npx vitest run apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts` → 9 tests PASS（含 V4.7 runner trace 断言）
- `git diff --check` → PASS
- `SKIP_E2E=1 NODE_BIN_DIR=... bash scripts/ci-equivalent-check.sh` → exit 0；5 stage 全绿：
  - stage 1/5 `tsc -b` ✓
  - stage 2/5 `tsc -p scripts/tsconfig.json` ✓
  - stage 3/5 `next build (apps/dashboard)` ✓
  - stage 4/5 `eslint --max-warnings 0` ✓（0 errors, 0 warnings）
  - stage 5/5 `pnpm -r` 等价的各 package vitest（orchestrator 80 文件 / 942 用例、dashboard 44 文件 / 283 用例、workflow / shared-contracts / runner-codex-app-server 全绿）

## Scope creep audit

`rg -n "local_command|claude_code|dynamic discovery|worker pool|remote runner|runner sdk|plugin marketplace" packages apps` 仅在以下位置匹配，均为「拒绝该值」的负面测试或反例 fixture，不存在生产代码接受这些不受支持的值：

- `packages/shared-contracts/src/__tests__/runner.test.ts`：`isRunnerKind("local_command")` / `isRunnerKind("claude_code")` 均 expect false。
- `packages/shared-contracts/src/__tests__/agent-report.test.ts`：`isAgentReport({ ..., runnerKind: "claude_code" })` expect false。
- `packages/workflow/src/__tests__/parse.test.ts`：`kind: local_command` fixture 用于断言 parser 拒绝 unsupported runner kind。

## V4.7 显式非目标

- V4.7 仍只支持 `codex_app_server`。
- 未引入 dynamic runner discovery、second runner、worker pool、remote runner service 或外部 SDK。
- 不改 `PipelineCoordinator` 状态机。
- 不更改 V4.3 evidence 视图或 V4.5 improvement-loop（缺失时也不引入新依赖）。
