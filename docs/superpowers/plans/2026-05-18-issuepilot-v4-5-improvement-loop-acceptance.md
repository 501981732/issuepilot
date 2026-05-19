# IssuePilot V4.5 Workflow / Skills Improvement Loop 验收清单

日期：2026-05-18
状态：implementation complete

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`
- V4 总设计：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

## 验收标准

- [x] 能从 V4.4 quality facts 生成 `ImprovementRecommendation`。
- [x] 每条 recommendation 都有 evidence trace。
- [x] Reports 能展示 recommendation queue 和详情。
- [x] Operator 能 `accept` / `reject` / `defer`。
- [x] `accept` 不自动生成 patch preview，也不写文件。
- [x] `patch-preview` 能生成 inert diff，并记录 `sourceSnapshot.sha256`。
- [x] Team mode 下 recommendation 按 project 隔离。
- [x] 重复建议能 dedupe 或 supersede。
- [x] 缺少 evidence、target 不存在、source stale 时 fail closed。
- [x] `scripts/ci-equivalent-check.sh` 或等价 gate 通过。

## 验证命令

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/recommendations.test.tsx components/reports/reports-page.test.tsx app/reports/page.test.tsx
scripts/ci-equivalent-check.sh
git diff --check
```

## 验证记录

- `pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts src/__tests__/quality.test.ts src/__tests__/index.test.ts` → PASS.
- `pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts` → PASS.
- `pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/recommendations.test.tsx components/reports/reports-page.test.tsx app/reports/page.test.tsx` → PASS.
- `scripts/ci-equivalent-check.sh` → PASS。首次执行因 `src/daemon.ts` / `src/team/daemon.ts` 的
  `import/order` 警告（lint stage `--max-warnings 0`）失败，运行
  `pnpm --filter @issuepilot/orchestrator exec eslint --fix src/daemon.ts src/team/daemon.ts`
  自动调整 import 顺序后复跑通过。
- `git diff --check` → PASS（由 `scripts/ci-equivalent-check.sh` 最后一阶段执行）。
