# IssuePilot V4.8 第二 Runner 自用验证验收记录

日期：2026-05-21
状态：默认 gate 已通过；真实 Claude Code 自用验证待本机 CLI / 登录态确认

## 默认 gate

- [x] `pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/runner.test.ts src/__tests__/agent-report.test.ts`
- [x] `pnpm --filter @issuepilot/shared-contracts exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/workflow exec vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts`
- [x] `pnpm --filter @issuepilot/workflow exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/runners/__tests__/claude-code.test.ts src/runners/__tests__/codex-app-server.test.ts src/agents/__tests__/coder.test.ts src/agents/__tests__/reviewer.test.ts src/agents/__tests__/test-evidence.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/pipelines/__tests__/coordinator.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`（默认跳过真实 CLI smoke）
- [x] `pnpm --filter @issuepilot/orchestrator exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/orchestrator lint`
- [x] `pnpm --filter @issuepilot/dashboard exec vitest run components/work-items/agent-report-tabs.test.tsx`
- [x] `pnpm --filter @issuepilot/dashboard typecheck`
- [x] `pnpm --filter @issuepilot/dashboard lint`
- [x] `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`

汇总 gate 结果：

```text
[ci-equivalent] stage 1/5: ✓ ok
[ci-equivalent] stage 2/5: ✓ ok
[ci-equivalent] stage 3/5: ✓ ok
[ci-equivalent] stage 4/5: ✓ ok
[ci-equivalent] stage 5/5: ✓ ok
[ci-equivalent] git diff --check
[ci-equivalent] all stages passed.
```

## Code review follow-up gate

- [x] `pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/runner.test.ts src/__tests__/agent-report.test.ts`
- [x] `pnpm --filter @issuepilot/workflow exec vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/runners/__tests__/claude-code.test.ts src/__tests__/daemon-pipeline-wiring.test.ts src/team/__tests__/daemon.test.ts`
- [x] `pnpm --filter @issuepilot/shared-contracts exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/workflow exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/orchestrator exec tsc --noEmit`
- [x] `pnpm --filter @issuepilot/orchestrator lint`
- [x] `git diff --check`
- [x] `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`

Code review follow-up 修复点：

- shared runner contract 的 `RunnerDescriptor.options` guard 改为 per-kind unknown-key fail closed。
- `claude_code.options.max_turns` 已从 allowlist 移除；当前本机 `claude --help` 未暴露稳定 `--max-turns` 参数。
- `claude_code.options.turn_timeout_ms` 已接入 adapter timeout。
- `driver.start()` 同步异常已映射为 `RunnerResultFailed` / `runner_unavailable`。
- timeout kill 改为不阻塞 adapter 返回，并在 default driver 中加入 bounded termination。
- single daemon / team daemon 增加 `claude_code` adapter 注册覆盖。

## 真实 Claude Code 自用验证

- [ ] `ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`

当前未运行原因：

```text
需要确认本机 Claude Code CLI 已安装并具备可用登录态；默认 gate 不依赖该本机状态。
```

## 覆盖点

- `RunnerKind` 已支持 `claude_code`，`AgentReport.runnerKind` guard 已同步。
- workflow parser / resolver 已支持 `claude_code` 静态 descriptor，并对敏感 / 越界 options fail closed。
- Codex adapter 已把 `tool_call_failed` 映射为标准 `RunnerEventType`。
- `claude_code` adapter 已具备 fake-driver 单测覆盖 completed / failed / cancelled / timeout / redaction。
- agent factories 已按实际 adapter descriptor 写入 `runnerKind`。
- single daemon / team daemon 已按 workflow runner descriptors 注册 `codex_app_server` 和 `claude_code` adapters。
- dashboard runner trace 已展示 `claude_code` i18n label。
- mixed-runner pipeline fixture 已覆盖 Codex coder + Claude reviewer + Codex test/evidence 的 trace。
