# IssuePilot V4.10 Release Lock / Dog-food Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 V4.1-V4.9 从“功能已实现”收口成“可以对内试点”的状态，并在进入 V3 前锁定 V4.8 / V4.9 的真实 dog-food、team-mode 能力矩阵和 roadmap 文档状态。

**Architecture:** V4.10 不新增产品能力，按 release-lock 路径执行。先建立 V4.10 acceptance 事实源，再分别跑 V4.9 review-rework dog-food 和 V4.8 `claude_code` CLI dog-food，随后把 single daemon / team daemon 能力矩阵、README / CHANGELOG / V4 总 spec 状态和最终 gate 汇总到同一份验收记录。

**Tech Stack:** Markdown docs、Git、pnpm workspace、Vitest、`scripts/ci-equivalent-check.sh`、可选本机 Claude Code CLI、IssuePilot V4.8 / V4.9 已有测试与 acceptance 文档。

---

## Scope Check

本计划只实现 `docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`。

**In scope:**

- 新建 V4.10 acceptance 记录。
- 用已有 V4.9 E2E / dashboard / quality 测试证明 review-rework dog-food 链路仍可复现。
- 根据本机 CLI / 登录态状态运行或阻塞记录 V4.8 `claude_code` 真实 smoke。
- 写清 single daemon / team daemon 对 V4.8 / V4.9 的能力矩阵。
- 同步 V4 总 spec、README 三语版本、CHANGELOG、V4.8 / V4.9 acceptance。
- 运行文档 gate；若执行中修改代码，升级到 `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`。

**Out of scope:**

- 不新增 review planner、runner adapter、dashboard layout 或 GitLab API 能力。
- 不做自动 merge、GitLab discussion resolve 双向同步或 webhook。
- 不做 V3 platform 能力：RBAC、Postgres、多 worker、production sandbox、预算配额和 OpenTelemetry。
- 不把 `claude_code` 扩展到 coder write role。
- 不静默改 workflow、skills、prompt 或项目规则。

## Current Code Facts

- V4.10 design spec 已提交：`docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`。
- V4.8 acceptance 当前状态是“默认 gate 已通过；真实 Claude Code 自用验证待本机 CLI / 登录态确认”：
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`。
- V4.9 acceptance 当前状态是“实施完成，待用户验收”：
  `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`。
- V4.9 focused E2E 路径：
  `apps/orchestrator/src/__tests__/v4-9-review-rework-e2e.test.ts` 和
  `apps/orchestrator/src/__tests__/v4-9-mixed-runner-source-ref.test.ts`。
- V4.8 real CLI smoke 路径：
  `apps/orchestrator/src/__tests__/v4-8-claude-code-dogfood.test.ts`，并且只有
  `ISSUEPILOT_CLAUDE_CODE_E2E=1` 时运行真实 smoke。
- single daemon 已在 `apps/orchestrator/src/daemon.ts` 接入 `reviewWorkflowService`；team daemon 的 review workflow service 绑定在 V4.9 acceptance 中明确属于后续 multi-project 服务化范畴。

## File Structure

- Create: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
  - V4.10 唯一验收记录，记录 preflight、V4.9 dog-food、V4.8 CLI dog-food、能力矩阵、最终 gate。
- Modify: `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`
  - 追加 V4.10 用户验收 / dog-food 结果。
- Modify: `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
  - 追加 V4.10 真实 CLI dog-food 结果或环境 blocker。
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
  - V4.10 完成后把状态从“设计待评审”推进到 release-lock 结果。
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
  - V4.10 完成后同步 roadmap 状态。
- Modify: `CHANGELOG.md`
  - 追加 V4.10 Plan / Acceptance / Result 条目。

## Task 1: Acceptance Skeleton And Preflight

**Files:**

- Create: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Verify branch hygiene**

Run:

```bash
git status --short --branch
```

Expected:

```text
## main...origin/main [ahead 1]
```

If local output shows unrelated user changes, do not touch those files. Continue only with the files listed in this plan.

- [ ] **Step 2: Create the V4.10 acceptance skeleton**

Create `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md` with:

```markdown
# IssuePilot V4.10 Release Lock / Dog-food Closure 验收记录

日期：2026-05-22
状态：执行中

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-22-issuepilot-v4-10-release-lock-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock.md`
- V4.8 验收记录：`docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
- V4.9 验收记录：`docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`

## Preflight

- [ ] `git status --short --branch`
- [ ] `git log --oneline -5`

## V4.9 Review-Rework Dog-food

- [ ] focused orchestrator E2E
- [ ] dashboard review workflow components
- [ ] review workflow facts are visible in Run Detail / Parent Review Packet / Reports paths through existing tests

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
```

- [ ] **Step 3: Add the V4.10 plan entry to CHANGELOG**

In `CHANGELOG.md`, under `## [Unreleased] V4.10 Release Lock / Dog-food Closure（设计待评审）`, add:

```markdown
### Plan

- 2026-05-22 — 新增 V4.10 Release Lock / Dog-food Closure 实施计划：
  `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock.md`。
  计划按 release-lock 执行，而不是新增产品功能：先建立 V4.10 acceptance 事实源，
  再分别完成 V4.9 review-rework dog-food、V4.8 `claude_code` 真实 CLI dog-food
  或 blocker 记录、single daemon / team daemon 能力矩阵、roadmap 状态同步和最终 gate。
```

- [ ] **Step 4: Verify doc hygiene**

Run:

```bash
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add CHANGELOG.md docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md
git commit -m "docs(v4.10): add release lock acceptance skeleton"
```

Expected: commit succeeds.

## Task 2: V4.9 Review-Rework Dog-food

**Files:**

- Modify: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
- Modify: `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`

- [ ] **Step 1: Run focused orchestrator review-rework E2E**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts
```

Expected: Vitest reports both files passing. This proves planner → accept → dispatch injection and V4.8 mixed-runner source provenance.

- [ ] **Step 2: Run dispatch and sweep review workflow tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/review-workflow
```

Expected: Vitest reports dispatch fallback/injection, sweep → planner, and review-workflow service/store/routes/classifier tests passing.

- [ ] **Step 3: Run dashboard review workflow tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx
```

Expected: Vitest reports all three dashboard review workflow component suites passing.

- [ ] **Step 4: Update the V4.10 acceptance record**

In `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`, replace the V4.9 section with:

```markdown
## V4.9 Review-Rework Dog-food

- [x] `pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/review-workflow`
- [x] `pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx`

结论：

- accepted `ReviewReworkPlan` 会 prepend `## Review rework plan` 到下一轮 `ai-rework` prompt。
- planner 失败或没有 accepted plan 时仍 fallback 到 V2 `## Review feedback`。
- `claude_code` reviewer finding 经 V4.9 planner 后保留 `runnerKind` provenance。
- Run Detail、Parent Review Packet 和 Reports 的 review workflow 展示路径均有 focused test 覆盖。
```

- [ ] **Step 5: Append V4.10 dog-food evidence to the V4.9 acceptance record**

Append to `docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md`:

```markdown
## V4.10 用户验收 / Dog-food 复核（2026-05-22）

- [x] `pnpm --filter @issuepilot/orchestrator test -- src/__tests__/v4-9-review-rework-e2e.test.ts src/__tests__/v4-9-mixed-runner-source-ref.test.ts`
- [x] `pnpm --filter @issuepilot/orchestrator test -- src/orchestrator/__tests__/dispatch.test.ts src/orchestrator/__tests__/review-feedback.test.ts src/review-workflow`
- [x] `pnpm --filter @issuepilot/dashboard test -- components/detail/review-rework-plan-panel.test.tsx components/work-items/review-rework-summary.test.tsx components/reports/review-workflow-card.test.tsx`

V4.10 复核结论：V4.9 review-rework 链路可作为 release-lock 的可复现 dog-food 场景。accepted plan 注入、fallback、mixed-runner provenance 和 dashboard/report 展示路径均有 focused gate 覆盖。
```

- [ ] **Step 6: Verify and commit Task 2**

Run:

```bash
git diff --check
git add docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md
git commit -m "docs(v4.10): record review rework dogfood"
```

Expected: `git diff --check` has no output and commit succeeds.

## Task 3: V4.8 Claude Code CLI Dog-food

**Files:**

- Modify: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
- Modify: `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`

- [ ] **Step 1: Check CLI availability**

Run:

```bash
command -v claude
claude --version
```

Expected if available: both commands exit 0 and print a path plus version.

Expected if unavailable: `command -v claude` exits non-zero. Continue with Step 4 blocker path.

- [ ] **Step 2: Run default skipped smoke**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts
```

Expected: Vitest completes with the real CLI case skipped unless `ISSUEPILOT_CLAUDE_CODE_E2E=1` is set.

- [ ] **Step 3: Run real CLI smoke when CLI is available**

Run:

```bash
ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts
```

Expected if CLI and login are usable: Vitest reports the smoke test passing.

Expected if login, permission, CLI protocol, or environment blocks the run: Vitest fails with a concrete CLI or auth error. Continue with Step 4 blocker path.

- [ ] **Step 4: Record V4.8 outcome**

If Step 3 passes, append this to both V4.10 acceptance and V4.8 acceptance:

```markdown
## V4.10 Claude Code CLI Dog-food 复核（2026-05-22）

- [x] `command -v claude`
- [x] `claude --version`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`
- [x] `ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`

结论：`claude_code` 第二 runner 已完成真实 CLI dog-food，可继续限制在 reviewer read-only role 作为显式 opt-in。V4.10 不把它扩展到 coder write role。
```

If Step 1 or Step 3 is blocked, append this to both V4.10 acceptance and V4.8 acceptance:

```markdown
## V4.10 Claude Code CLI Dog-food 复核（2026-05-22）

- [x] `command -v claude`
- [x] `pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`
- [ ] `ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`

结论：真实 CLI dog-food 仍受本机 Claude Code CLI / 登录态 / 环境状态阻塞。V4.10 release lock 采用保守降级：保留 `claude_code` adapter contract 和默认 gate 结果，但 README 只声明默认 runner 仍是 `codex_app_server`，`claude_code` 继续限制为显式 opt-in reviewer read-only role。
```

- [ ] **Step 5: Verify and commit Task 3**

Run:

```bash
git diff --check
git add docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md
git commit -m "docs(v4.10): record claude code dogfood status"
```

Expected: `git diff --check` has no output and commit succeeds.

## Task 4: Single Daemon / Team Daemon Matrix

**Files:**

- Modify: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

- [ ] **Step 1: Verify runner wiring tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/runners/__tests__/claude-code.test.ts src/__tests__/daemon-pipeline-wiring.test.ts src/team/__tests__/daemon.test.ts
```

Expected: Vitest reports runner adapter and single/team daemon runner wiring tests passing.

- [ ] **Step 2: Verify review workflow team limitation source**

Run:

```bash
rg -n "team.*review workflow|review workflow service|multi-project 服务化|reviewWorkflowService|reviewWorkflow" apps/orchestrator/src/team apps/orchestrator/src/daemon.ts docs/superpowers/plans/2026-05-21-issuepilot-v4-9-intelligent-review-workflow-acceptance.md
```

Expected:

- `apps/orchestrator/src/daemon.ts` shows `reviewWorkflowService` wiring for single daemon.
- V4.9 acceptance records that team daemon review workflow service binding belongs to later multi-project service work.
- `apps/orchestrator/src/team` does not falsely prove full V4.9 team-mode review workflow service binding.

- [ ] **Step 3: Replace the matrix in V4.10 acceptance**

Replace the `Single Daemon / Team Daemon Matrix` section with:

```markdown
## Single Daemon / Team Daemon Matrix

| 能力 | single daemon | team daemon | V4.10 结论 |
| --- | --- | --- | --- |
| `claude_code` adapter registry | 已接入并有 focused tests | 已接入并有 focused tests | V4.8 contract 可 release-lock；真实 CLI 状态见上一节 |
| mixed-runner reviewer provenance | 已由 V4.9 mixed-runner source-ref test 覆盖 | contract / wiring 已覆盖，仍需真实 team dog-food | 不宣称 team dog-food 已完成 |
| review workflow service | 已在 V4.9 single daemon 路径接入 | 属于后续 multi-project 服务化 follow-up | README / V4 spec 不声明 team mode 已完整可用 |
| dashboard project-scoped review plan | single project 可用 | 依赖 team review workflow service binding | V4.10 记录为 release follow-up |

结论：V4.10 release lock 可以覆盖 single daemon dog-food 和 runner contract；team daemon 的 V4.9 review workflow service binding 不作为已完成能力宣称，进入后续 multi-project 服务化 follow-up。
```

- [ ] **Step 4: Update V4 master spec with the matrix conclusion**

In `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`, under `### V4.10：Release Lock / Dog-food Closure（设计待评审）`, add:

```markdown
V4.10 的 team-mode 结论必须保守：`claude_code` runner registry 和 mixed-runner
contract wiring 可以 release-lock；V4.9 review workflow service 在 team daemon
中的完整 project-scoped binding 仍作为后续 multi-project 服务化 follow-up，不在
V4.10 中宣称已完成。
```

- [ ] **Step 5: Verify and commit Task 4**

Run:

```bash
git diff --check
git add docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md
git commit -m "docs(v4.10): lock daemon capability matrix"
```

Expected: `git diff --check` has no output and commit succeeds.

## Task 5: Roadmap Status Sync

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

- [ ] **Step 1: Update V4.10 status after acceptance**

In README Chinese files, change:

```markdown
**Release Lock / Dog-food Closure**（V4.10 设计待评审）
```

to:

```markdown
**Release Lock / Dog-food Closure**（V4.10 执行完成，V4 对内试点边界已锁定）
```

In `README.en.md`, change:

```markdown
**Release Lock / Dog-food Closure** (V4.10 design pending review)
```

to:

```markdown
**Release Lock / Dog-food Closure** (V4.10 complete; V4 internal-pilot boundary locked)
```

- [ ] **Step 2: Update V4 master spec status**

In `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`, change the V4.10 heading:

```markdown
### V4.10：Release Lock / Dog-food Closure（设计待评审）
```

to:

```markdown
### V4.10：Release Lock / Dog-food Closure（执行完成）
```

Also change the implementation-plan bullet text from `设计待评审` to `执行完成，V4 对内试点边界已锁定`.

- [ ] **Step 3: Add CHANGELOG acceptance entry**

Under `## [Unreleased] V4.10 Release Lock / Dog-food Closure（设计待评审）`, add:

```markdown
### Acceptance

- 2026-05-22 — V4.10 release lock 验收记录：
  `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`。
  记录 V4.9 review-rework dog-food、V4.8 `claude_code` CLI dog-food 状态、
  single daemon / team daemon 能力矩阵、roadmap 状态同步和最终 gate。
```

Then update the heading to:

```markdown
## [Unreleased] V4.10 Release Lock / Dog-food Closure（执行完成）
```

- [ ] **Step 4: Verify status wording**

Run:

```bash
rg -n "V4\\.10.*设计待评审|V4\\.9.*设计待评审|能力（设计中）|V4\\.5 实施中|in V4\\.5 implementation" README.md README.zh-CN.md README.en.md docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md CHANGELOG.md
```

Expected: no output.

- [ ] **Step 5: Verify and commit Task 5**

Run:

```bash
git diff --check
git add README.md README.zh-CN.md README.en.md CHANGELOG.md docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md
git commit -m "docs(v4.10): sync release lock roadmap status"
```

Expected: `git diff --check` has no output and commit succeeds.

## Task 6: Final Gate And Closeout

**Files:**

- Modify: `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`

- [ ] **Step 1: Run final docs gate**

Run:

```bash
git diff --check
```

Expected: no output, exit code 0.

- [ ] **Step 2: Run full gate if code changed**

If `git diff --name-only HEAD~5..HEAD` includes `apps/`, `packages/`, `tests/`, or `scripts/`, run:

```bash
SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

Expected:

```text
[ci-equivalent] all stages passed.
```

If only docs changed, record that full gate was not required because V4.10 execution did not modify code.

- [ ] **Step 3: Mark V4.10 acceptance complete**

In `docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md`, change:

```markdown
状态：执行中
```

to:

```markdown
状态：执行完成
```

Change the conclusion to:

```markdown
## 结论

V4.10 release lock 已完成。V4.9 review-rework dog-food、V4.8 第二 runner 状态、
single daemon / team daemon 能力矩阵和 roadmap 状态已经收口。V4 可以进入对内
试点边界；V3 生产化执行平台仍作为下一阶段独立规划，不在本轮混入。
```

- [ ] **Step 4: Commit Task 6**

Run:

```bash
git diff --check
git add docs/superpowers/plans/2026-05-22-issuepilot-v4-10-release-lock-acceptance.md
git commit -m "docs(v4.10): complete release lock acceptance"
```

Expected: commit succeeds.

- [ ] **Step 5: Final status**

Run:

```bash
git status --short --branch
git log --oneline -8
```

Expected: working tree clean, branch ahead of `origin/main` by the V4.10 design and execution commits.

## Self-Review Checklist

- Spec coverage: Task 1 creates the acceptance source, Task 2 covers V4.9 dog-food, Task 3 covers V4.8 CLI dog-food, Task 4 covers single/team daemon matrix, Task 5 covers roadmap status sync, Task 6 covers final gate and closure.
- Completion scan: This plan avoids unresolved markers; environment-dependent dog-food has explicit pass and blocked paths.
- Type consistency: No new TypeScript types are introduced in V4.10. Existing names are `ReviewReworkPlan`, `reviewWorkflowService`, `claude_code`, `RunnerKind`, and `QualitySummaryResponse.reviewWorkflow`.
- Scope control: V4.10 does not add product functionality. Any code fix found during dog-food must be split into a separate implementation commit and verified with `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`.
