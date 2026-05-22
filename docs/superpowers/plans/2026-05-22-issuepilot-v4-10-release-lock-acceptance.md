# IssuePilot V4.10 Release Lock / Dog-food Closure 验收记录

日期：2026-05-22
状态：执行中

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

- [ ] CLI availability checked
- [ ] real CLI smoke run or environment blocker recorded

## Single Daemon / Team Daemon Matrix

| 能力 | single daemon | team daemon | V4.10 结论 |
| --- | --- | --- | --- |
| `claude_code` adapter registry | 待验证 | 待验证 | 待记录 |
| mixed-runner reviewer provenance | 待验证 | 待验证 | 待记录 |
| review workflow service | 待验证 | 待验证 | 待记录 |
| dashboard project-scoped review plan | 待验证 | 待验证 | 待记录 |

## Final Gate

- [ ] `git diff --check`
- [ ] 如涉及代码：`SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`

## 结论

V4.10 尚未完成 release lock。
