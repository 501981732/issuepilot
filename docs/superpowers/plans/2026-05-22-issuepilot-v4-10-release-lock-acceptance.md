# IssuePilot V4.10 Release Lock / Dog-food Closure 验收记录

日期：2026-05-22
状态：执行完成

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock.md`
- V4.8 验收记录：`docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
- V4.9 验收记录：`docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`

## Preflight

- [x] `git status --short --branch` → `## main...origin/main [ahead 2]`
- [x] `git log --oneline -5`

## V4.9 Review-Rework Dog-food

- [x] `pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts`
  - Result: 88 test files passed, 1 skipped; 1003 tests passed, 1 skipped.
- [x] `pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/review-workflow`
  - Result: 88 test files passed, 1 skipped; 1003 tests passed, 1 skipped.
- [x] `pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx`
  - Result: 47 test files passed; 295 tests passed.

结论：

- accepted `ReviewReworkPlan` 会 prepend `## Review rework plan` 到下一轮 `ai-rework` prompt。
- planner 失败或没有 accepted plan 时仍 fallback 到 V2 `## Review feedback`。
- `claude_code` reviewer finding 经 V4.9 planner 后保留 `runnerKind` provenance。
- Run Detail、Parent Review Packet 和 Reports 的 review workflow 展示路径均有 focused gate 覆盖。

## V4.8 Claude Code CLI Dog-food

- [x] `command -v claude` → `/Users/wangmeng5/.local/bin/claude`
- [x] `claude --version` → `2.1.145 (Claude Code)`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`
  - Result: 1 test skipped, as expected without `ISSUEPILOT_CLAUDE_CODE_E2E=1`.
- [ ] `ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`
  - Result: failed. The real CLI smoke timed out after 5000ms in `runs reviewer role through local Claude Code CLI`.

结论：本机 Claude Code CLI 已安装并可报告版本，但真实 CLI dog-food 仍受本机 CLI / 登录态 / 测试超时环境阻塞。V4.10 release lock 采用保守降级：保留 `claude_code` adapter contract 和默认 gate 结果，但 README 只声明默认 runner 仍是 `codex_app_server`，`claude_code` 继续限制为显式 opt-in reviewer read-only role。

## Single Daemon / Team Daemon Matrix

- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/runners/__tests__/claude-code.test.ts src/__tests__/daemon-pipeline-wiring.test.ts src/team/__tests__/daemon.test.ts`
  - Result: 3 test files passed; 20 tests passed.
- [x] `rg -n "team.*review workflow|review workflow service|multi-project 服务化|reviewWorkflowService|reviewWorkflow" apps/orchestrator/src/team apps/orchestrator/src/daemon.ts docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`
  - Result: single daemon shows `reviewWorkflowService` wiring; V4.9 acceptance records team daemon review workflow binding as later multi-project 服务化 work.

| 能力 | single daemon | team daemon | V4.10 结论 |
| --- | --- | --- | --- |
| `claude_code` adapter registry | 已接入并有 focused tests | 已接入并有 focused tests | V4.8 contract 可 release-lock；真实 CLI 状态见上一节 |
| mixed-runner reviewer provenance | 已由 V4.9 mixed-runner source-ref test 覆盖 | contract / wiring 已覆盖，仍需真实 team dog-food | 不宣称 team dog-food 已完成 |
| review workflow service | 已在 V4.9 single daemon 路径接入 | 属于后续 multi-project 服务化 follow-up | README / V4 spec 不声明 team mode 已完整可用 |
| dashboard project-scoped review plan | single project 可用 | 依赖 team review workflow service binding | V4.10 记录为 release follow-up |

结论：V4.10 release lock 可以覆盖 single daemon dog-food 和 runner contract；team daemon 的 V4.9 review workflow service binding 不作为已完成能力宣称，进入后续 multi-project 服务化 follow-up。

## Final Gate

- [x] `git diff --check`
- [x] `git diff --name-only HEAD~5..HEAD`
  - Result: 本轮 V4.10 execution commits 只修改 docs / README / CHANGELOG；未修改 `apps/`、`packages/`、`tests/` 或 `scripts/`。
- [x] `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`
  - Result: not required for this execution because no code files changed.

## 结论

V4.10 release lock 已完成。V4.9 review-rework dog-food、V4.8 第二 runner 状态、
single daemon / team daemon 能力矩阵和 roadmap 状态已经收口。V4 可以进入对内
试点边界；V3 生产化执行平台仍作为下一阶段独立规划，不在本轮混入。
