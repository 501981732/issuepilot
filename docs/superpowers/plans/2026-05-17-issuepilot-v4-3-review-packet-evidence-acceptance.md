# IssuePilot V4.3 Review Packet + Evidence 验收检查清单

日期：2026-05-17（首版） / 2026-05-18（review 收口）
状态：**已对齐 review fix 后通过——2026-05-18 完成 reviewer 报告里全部
Important / Minor 项的修复，重新跑过完整 ci-equivalent gate。本轮新增
`scripts/ci-equivalent-check.sh` 把所有等价 gate 串成单一入口，缺 `pnpm`
/ `corepack` 的开发机也能一次跑完。**

对应 spec：
`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
§7 V4.3 + §14.3 + §14.4 + §15。
对应实施计划：
`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
（任务 23）。

把本清单复制到 PR 描述里作为自检清单。

## V4.3 验收标准

- [x] **Evidence 自动索引**：task worktree 下
      `.issuepilot/evidence/<runId>/` 支持 `screenshots`、`recordings`、
      `playwright`、`commands`、`tests` 五类目录；`manifest.json`
      优先；超过 50MB 的文件不进入可服务索引；path traversal entry
      被拒绝。
  - 证据 1：`apps/orchestrator/src/work-items/evidence-scanner.ts`
    实现目录推断、manifest 解析、50MB 上限、path traversal 校验。
  - 证据 2：`apps/orchestrator/src/work-items/__tests__/evidence-scanner.test.ts`
    覆盖目录推断、manifest 优先、oversized 和 rejected entry。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    覆盖 task run 产出截图、Playwright zip、command log 后被聚合进
    `WorkItemReport.evidence.byTask`。

- [x] **AI vs human 区分**：`WorkItemEvidenceEntry.confidence` 支持
      `ai-claim`、`system-derived`、`human-confirmed`；dashboard
      `ConfidencePill` 可视化；confirm API 把单条 evidence 升级为
      human-confirmed。
  - 证据 1：`packages/shared-contracts/src/evidence.ts` 定义 confidence
    与确认字段。
  - 证据 2：`apps/orchestrator/src/work-items/store.ts` 持久化
    evidence confirmation sidecar；
    `apps/orchestrator/src/work-items/service.ts` 的
    `confirmTaskEvidence` 校验 task/evidence 归属、写入
    `confirmedBy` / `confirmedAt` 并触发 `reconcileWorkItem`。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    §confirm flow 断言 confidence 从 `ai-claim` 变为
    `human-confirmed`，并重新渲染 handoff note。
  - 证据 4：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 confirm 按钮和 optimistic reload 路径。

- [x] **统一 Parent Review Packet 渲染**：GitLab handoff note 与 dashboard
      Markdown export 共用 renderer；`GET /api/work-items/:id/report.md`
      返回 raw `text/markdown`，不是 JSON wrapper。
  - 证据 1：`apps/orchestrator/src/work-items/render-report.ts` 同时支持
    `audience: "gitlab"` 与 `audience: "markdown"`。
  - 证据 2：`apps/orchestrator/src/work-items/handoff.ts` 继续独占 marker
    拼接，避免 renderer 输出重复 marker。
  - 证据 3：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`
    断言 handoff note body 与 `renderWorkItemReportMarkdown(...,
    { audience: "gitlab" })` 一致，`report.md` 与 markdown renderer 一致。
  - 证据 4：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
    覆盖 `Copy as Markdown` 从 orchestrator 拉取 `report.md`。

- [x] **Human review checklist**：Parent Review Packet 会把 medium/high
      risk、`needs_rework`、partial overall status、missing evidence、
      skipped task、CI failed 派生成 checklist；V4.3 checklist 只读，
      单条确认仍走 evidence tab。
  - 证据 1：`apps/orchestrator/src/work-items/aggregate.ts` 从 run report、
    risk、CI/test/evidence 缺口派生 `humanReviewChecklist`。
  - 证据 2：`apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`
    覆盖 checklist reason 与 confirmed=false。
  - 证据 3：`apps/dashboard/components/work-items/human-review-checklist.test.tsx`
    覆盖只读 checklist、localized hint 和 confirmed 渲染兼容。

- [x] **Dashboard 三态视图**：`?view=list|graph|evidence` 通过 URL
      持久化；`EvidenceTab` 支持 kind filter、图片缩略图、文件链接和单条
      confirm。
  - 证据 1：`apps/dashboard/components/work-items/view-toggle.test.tsx`
    覆盖 list / graph / evidence 三态按钮。
  - 证据 2：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 grouped entries、kind filter、截图渲染、confirm action。
  - 证据 3：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
    覆盖 `view=evidence` 初始态、EvidenceTab 接入、confirm 后 reload。

- [x] **Team-mode project 隔离**：Evidence index、`report.md`、file route
      和 confirm route 均保持 project-scoped；媒体链接通过 `project` query
      传递项目上下文。
  - 证据 1：`apps/orchestrator/src/server/__tests__/server.test.ts`
    覆盖 work-item routes 的 `x-issuepilot-project` 分发、400/404 错误码。
  - 证据 2：`apps/orchestrator/src/team/__tests__/work-items.test.ts`
    覆盖 per-project `WorkItemService` 与 ReportStore 隔离。
  - 证据 3：`apps/dashboard/lib/api.test.ts` 覆盖
    `buildEvidenceFileUrl` 的 `project` query。
  - 证据 4：`apps/dashboard/components/work-items/evidence-tab.test.tsx`
    覆盖 project-scoped evidence file links。

- [x] **不变量保持**。
  - 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - `TaskRunLink` 仍是唯一 canonical task-to-run binding。
  - synthetic task run 的 `parentIssueLabelMode === "suppressed"`。
  - 不创建 child GitLab Issue。
  - evidence 文件不离开 task worktree。
  - 证据：V4.1/V4.2 既有 e2e 全部通过，V4.3 新增
    `work-items-v43-e2e.test.ts` 使用真实 `tickWorkItem` /
    `settleTaskRunFinal` / `scanRunEvidence` 路径验证同一不变量。

- [x] **验证 gate（带环境说明）**。
  - 默认入口：`scripts/ci-equivalent-check.sh`。脚本会自动尝试
    `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`
    下的 Codex bundled Node runtime（解决默认 Codex.app Node 跑 Rollup
    native binding 失败的问题），并依次执行 `tsc -b` /
    `tsc -p scripts/tsconfig.json` / `next build`（`apps/dashboard`）/
    `eslint --max-warnings 0` / 各 package 的 `vitest run` /
    `git diff --check`。在缺 `pnpm` / `corepack` 的开发机上，这是
    `pnpm -r build|lint|test` 的等价替代。
  - 2026-05-18 review fix 后再次执行该脚本结果：所有 stage 通过。
    Vitest 数：`apps/orchestrator` 551、`apps/dashboard` 212、
    `tests/e2e` 51；V4.3 e2e suite 自身从 4 case 扩到 6 case
    （新增 invariants helper、symlink case、runTaskOnce 不变量 case）。
  - 若机器有 `pnpm` / `corepack` 且默认 Node 能加载 Rollup native，
    `pnpm -r build|lint|test` 仍是受支持入口，可以替代脚本。但发布或
    合并前必须有一种通过的 gate（脚本或 `pnpm -r`），不能仅以「单测
    通过」收口（参见 `AGENTS.md` §「验证要求」）。

- [x] **文档 + CHANGELOG 已更新**。
  - `CHANGELOG.md` 顶部新增 `[Unreleased] V4.3 Review Packet + Evidence`，
    并在同一段补 `Security` / `Fixed` / `Tests` / `CI / Tooling` /
    `Known limitations` 子段落，记录 2026-05-18 review fix。
  - `README.md` / `README.zh-CN.md` roadmap V4 段落新增 V4.3 已落地条目。
  - `USAGE.md` / `USAGE.zh-CN.md` 新增 §5.9
    *V4.3 Review Packet + Evidence*；原边界章节顺延为 §5.10。
  - `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
    顶部「实施计划」加入 V4.3 链接。
  - 本文件即任务 23 的输出。

## 2026-05-18 Review fix 摘要

`requesting-code-review` 子 agent 报告里全部 Important + 取舍后的 Minor
项均已修复并补测。

| 报告项 | 修复 | 主要变更 |
| --- | --- | --- |
| Important #1 evidence-file-server symlink bypass | ✅ | `evidence-file-server.ts` 增加 `realpath(taskWorktreePath)` 二次校验；`evidence-file-server.test.ts` + `work-items-v43-e2e.test.ts` 各加 1 条 symlink 攻击 case。 |
| Important #2 + #7 V4.3 e2e 缺正面不变量 + 数量低于预期 | ✅ | 新增 `assertV4Invariants` helper 在 4 个现有 case 末尾正面 assert（`createIssue` 调用次数 0 / per-task 唯一 `TaskRunLink`）；新增「runTaskOnce 路径 `parentIssueLabelMode === "suppressed"`」与「`<runId>` 子目录是 symlink」两条 e2e case，suite 从 4 → 6 case。 |
| Important #3 EvidenceTab 乐观更新中间态 | ✅ | `evidence-tab.tsx` 让 pill 与按钮共享 in-flight 收尾，confirm 期间 pill 不抢跑变绿；`evidence-tab.test.tsx` 同步更新 3 条相关 case。 |
| Important #4 `?view=` URL 不持久化 | ✅ | `work-item-detail.tsx` 通过 `history.replaceState` 把 view 写回 URL；`work-item-detail.test.tsx` 加 1 条往返 case。 |
| Important #5 `render-report.test.ts` 非法 `kind: "artifact"` | ✅ | fixture 改为 `kind: "command_output"` 与 `WorkItemEvidenceKind` 枚举一致。 |
| Important #6 CI gate 未脚本化 | ✅ | 新增 `scripts/ci-equivalent-check.sh`；更新 `AGENTS.md` §「验证要求」段落。 |
| Minor manifest entries 未防 OOM | ✅ | `evidence-scanner.ts` 给 `manifest.json.entries` 加 1000 条上限，超出量记 `manifest-overflow` rejected → `openQuestions`；新增对应 scanner 单测。 |
| Minor `buildEvidenceFileUrl` `+`/`%2B` 一致性 | ✅ | `lib/api.test.ts` 加往返单测，固化 client `URLSearchParams` 与 server form-decode 在 `+` / `%2B` / 空格 上的对称约定。 |
| Minor `ConfidencePill` role 残留 | ✅ | `confidence-pill.test.tsx` 显式断言 pill 不带 `role="status"` / `aria-live`。 |
