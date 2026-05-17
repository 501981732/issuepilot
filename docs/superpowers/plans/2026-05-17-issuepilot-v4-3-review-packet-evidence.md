# IssuePilot V4.3 Review Packet + Evidence 实施计划

Phase：V4 Phase 3
状态：待评审
对应 spec：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`（§7 V4.3 Review Packet + Evidence、§9.5 WorkItemReport、§11 主流程、§12.5 汇总报告不完整、§13 关键不变量、§14.3 Parent Review Packet、§14.4 Evidence、§15 报告分层、§16.4 Report tests、§16.5 E2E tests、§16.6 UI tests）
依赖：
- V4.1 Workflow Spine（`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md` 与 acceptance），WorkItem / TaskPlan / TaskRunLink / WorkItemReport 已落地。
- V4.2 Task Graph（`docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md` 与 acceptance），dependency chaining / replan / mark-rework / unskip / team-mode project 隔离已落地。

下一步（不在本计划范围）：V4.4 Quality Analytics、V4.5 Workflow / Skills Improvement Loop、V4.6 Multi-Agent / Multi-Runner。

> **给执行 agent：** 执行本计划必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每个任务最后一步是 commit，请勿把多任务合并为一个 commit；步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 在 V4.1 / V4.2 已聚合 `WorkItemReport` 的基础上，把 Parent Review Packet 升级为「reviewer 可据此判断整个大 Issue 是否可交付」的核心产物：
1. 引入 5 类新 evidence kind（`screenshot` / `recording` / `playwright` / `command_output` / `test_result`），通过 **worktree evidence 目录约定** 收集 + RunReportArtifact 显式声明合并。
2. 为每条 evidence / claim 标注 confidence（`ai-claim` / `system-derived` / `human-confirmed`），并新增 `humanReviewChecklist`，让 dashboard 明确「哪些是 AI 判断、哪些必须人确认」。
3. 把 GitLab handoff note、dashboard 渲染、Markdown export 合并到 **同一份共享渲染器**，使三处文案不再各自漂移。
4. 增加 dashboard `EvidenceTab`（按 task / kind 聚合，支持图片缩略图、视频/playwright/command_output 链接、人工确认勾选）。
5. 守住 V4.1/V4.2 task execution contract 与父 Issue label 不变量。

**架构：** 不替换 V4.1/V4.2 已有的 `apps/orchestrator/src/work-items/` 域。本阶段做五件增量：

1. **数据 / 契约层**：扩展 `WorkItemEvidenceEntry.kind` 与 `confidence`，新增 `WorkItemReport.humanReviewChecklist`、`WorkItemReport.ciSummary`、`WorkItemReport.testSummary`、`RunReportArtifact.evidence`；新增 `ConfirmEvidenceRequest` / `WorkItemEvidenceResponse` API。`report.md` 返回 raw `text/markdown`，不建 JSON wrapper。
2. **Evidence 扫描层**：`apps/orchestrator/src/work-items/evidence-scanner.ts` 由 daemon 在 dispatch closure（reportStore.save 已完成、`RunReportArtifact.run.workspacePath` 已回填）之后调用，扫描 `<taskWorktreePath>/.issuepilot/evidence/<runId>/`（约定目录），合并 `RunReportArtifact.evidence` 显式声明，把 normalized `ReportEvidence[]` patch 回 reportStore。dispatch-task 不直接持有 reportStore；scanner hook 是 daemon-level 责任。
3. **聚合层增强**：`aggregate.ts` 从 `RunReportArtifact.evidence` + `checks` + `handoff.validation` 构造 `WorkItemEvidenceEntry`；按规则生成 `humanReviewChecklist`（任何 risk≥medium、`needs_rework` 任务、`partial` overallStatus、缺失 evidence 的 task 自动入 checklist）。
4. **统一渲染器**：新增 `apps/orchestrator/src/work-items/render-report.ts`，导出 `renderWorkItemReportMarkdown()`；`handoff.ts`、新的 `GET /api/work-items/:id/report.md` 路由、dashboard `Copy as Markdown` 全部走同一函数。
5. **Server + Dashboard 接入**：新增 4 条路由（report.md / evidence index / evidence file / confirm evidence）；dashboard 新增 `EvidenceTab` + `HumanReviewChecklist` + AI/Human confidence pill。

**技术栈：** TypeScript、Node.js 22、Fastify、Vitest、Next.js App Router、React、Tailwind/shadcn-style 组件、`@issuepilot/shared-contracts`、Codex app-server（通过 `@issuepilot/runner-codex-app-server`）、GitLab REST（通过 `@issuepilot/tracker-gitlab`）。**第一版不引入** 图片缩略图生成器（直接用原图 + CSS `max-h`）、视频转码器、Playwright trace viewer 二进制。Evidence 文件不离开 task worktree，dashboard 通过 orchestrator 的受限静态文件路由读取；路由必须同时校验 path traversal、`runId` 属于当前 WorkItem、team-mode project 隔离。

---

## 范围检查

V4 spec 包含 6 个能力阶段（V4.1–V4.6）。本计划只覆盖 **V4.3 Review Packet + Evidence**。

### 明确做（按 spec §7 V4.3 + §14.3 + §14.4 + §15）

1. **截图 / 录屏 / Playwright walkthrough / 命令输出 / 测试结果 evidence 索引**：`evidence-scanner.ts` 扫描 worktree evidence 目录 + 解析 `RunReportArtifact.evidence` 声明 → 写入 `WorkItemEvidenceEntry`。
2. **CI / 测试结果聚合**：把 `RunReportArtifact.checks` 中 `name/status/durationMs/details` 聚合到 `WorkItemReport.testSummary` 与 `evidence.kind = "test_result"`；`RunReportArtifact.ci` 聚合到 `WorkItemReport.ciSummary`。
3. **AI 判断 vs 人确认区分**：`WorkItemEvidenceEntry.confidence` 三态枚举 + `humanReviewChecklist`；新增 `confirmTaskEvidence` API 允许 operator 把单条 evidence 标 `human-confirmed`。
4. **统一渲染**：GitLab handoff note、`GET /api/work-items/:id/report.md`、dashboard `Copy as Markdown` 三处共用 `renderWorkItemReportMarkdown()`；除 `audience` 允许的标题差异外，核心章节同源一致。
5. **Dashboard EvidenceTab**：在 WorkItem 详情页 graph/list 切换栏旁加 `Evidence` 标签；新组件按 task / kind 分组，图片缩略图渲染、视频/playwright/command 文本块、`Confirm` 按钮。
6. **Markdown export 路由**：`GET /api/work-items/:id/report.md`，与 GitLab handoff note 同源。

### 明确不做

- 不做 V4.4 Quality Analytics（成功率 / 返工率 / 趋势）。
- 不做 V4.5 Workflow / Skills 改进建议。
- 不做 V4.6 Multi-Agent / Multi-Runner。
- 不引入图片缩略图生成器；图片直接使用原图，最大渲染高度 240px。
- 不做视频转码 / OCR / Playwright trace 内嵌渲染；只显示链接与元数据。
- 不引入 Postgres / 对象存储；evidence 文件保留在 task worktree `.issuepilot/evidence/<runId>/`，orchestrator 静态服务限制在该目录。
- 不修改 V4.1/V4.2 已有的父 Issue label state machine；`humanReviewChecklist` 只展示，不驱动 label 转换。
- 不修改 `RunReportArtifact` 现有 5 个 evidence kind（diff/validation/risk/ci/review_feedback）的来源逻辑；只**追加** 5 个新 kind。
- 不做 evidence 跨 WorkItem 引用；evidence 始终绑定 `taskId + runId`。
- 不引入 GraphQL；保持 REST + JSON。
- **第一版 `humanReviewChecklist` 是 read-only**：人工确认只走 evidence 级（`POST .../evidence/:evidenceId/confirm`）。`HumanReviewChecklistItem.confirmed` 在 V4.3 永远为 `false`；checklist 级 confirm endpoint 留 V4.4。

### V4.1 / V4.2 task execution contract 仍然成立

1. **不创建 child GitLab Issue**；evidence 聚合也只动 IssuePilot 本地状态。
2. **每 task 一 branch / worktree**；evidence 目录跟随 task 的 worktree。
3. **TaskRunLink 是 task ↔ run 的 canonical binding**；evidence entry 通过 `runId` 反向定位 task。
4. **父 Issue label / handoff note 由 WorkItem 聚合阶段统一写入**，本阶段对 `writeParentHandoff` 的修改仅限渲染体；label state machine 与触发条件保持 V4.2 acceptance C2 已定的形态。
5. **synthetic task run `parentIssueLabelMode === "suppressed"`** 不变。

## 文件结构

每个文件单一职责；evidence 收集、normalization、渲染、UI 之间清晰分层。

### 新建

- `packages/shared-contracts/src/__tests__/evidence.test.ts`：新 evidence kind / confidence / RunReportArtifact.evidence / humanReviewChecklist 的 contract 测试。
- `apps/orchestrator/src/work-items/evidence-scanner.ts`：扫描 `<taskWorktreePath>/.issuepilot/evidence/<runId>/` 并合并 RunReport 显式声明。
- `apps/orchestrator/src/work-items/__tests__/evidence-scanner.test.ts`。
- `apps/orchestrator/src/work-items/evidence-merge.ts`：daemon-level 合并 helper（`mergeReportEvidence` + `appendOversizedFollowUps`），由 single daemon 的 dispatch closure 使用；team daemon 当前尚无 dispatch runner，后续接入 team dispatch runner 时复用。
- `apps/orchestrator/src/work-items/__tests__/evidence-merge.test.ts`。
- `apps/orchestrator/src/work-items/evidence-id.ts`：pure helper `deriveEvidenceId({ taskId, kind, runId, seed })`，sha1 + base64url，让 aggregator + sidecar + dashboard 共享同一份稳定 id 规则。
- `apps/orchestrator/src/work-items/__tests__/evidence-id.test.ts`。
- `apps/orchestrator/src/work-items/render-report.ts`：导出 `renderWorkItemReportMarkdown(workItem, plan, report, options)`。
- `apps/orchestrator/src/work-items/__tests__/render-report.test.ts`。
- `apps/orchestrator/src/work-items/evidence-file-server.ts`：把 `GET /api/work-items/:id/evidence/file` 的路径解析、白名单校验、stream 逻辑抽出，便于单测；路由层负责先校验 `runId` 属于当前 WorkItem 的 `TaskRunLink`。
- `apps/orchestrator/src/work-items/__tests__/evidence-file-server.test.ts`。
- `apps/dashboard/components/work-items/evidence-tab.tsx`：按 task / kind 渲染 evidence；图片缩略图、视频 / playwright / command_output 链接；`Confirm` 按钮。
- `apps/dashboard/components/work-items/evidence-tab.test.tsx`。
- `apps/dashboard/components/work-items/human-review-checklist.tsx`：渲染 `WorkItemReport.humanReviewChecklist`（**第一版 read-only**，无 `onConfirm` prop）。
- `apps/dashboard/components/work-items/human-review-checklist.test.tsx`。
- `apps/dashboard/components/work-items/confidence-pill.tsx`：`ai-claim` / `system-derived` / `human-confirmed` 三态 pill。
- `apps/dashboard/components/work-items/confidence-pill.test.tsx`。
- `apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`：V4.3 端到端 fake GitLab + fake Codex，覆盖 evidence 扫描 / 渲染统一 / checklist / confirm。

### 修改

- `packages/shared-contracts/src/work-item.ts`：
  - `WorkItemEvidenceEntry.kind` 追加 `"screenshot" | "recording" | "playwright" | "command_output" | "test_result"`。
  - `WorkItemEvidenceEntry` 增加 `confidence: "ai-claim" | "system-derived" | "human-confirmed"`、`mediaType?: string`、`thumbnailHref?: string`、`capturedAt?: string`、`source?: { runId: string; relPath?: string }`、`confirmedBy?: string`、`confirmedAt?: string`。
  - `WorkItemReport` 增加 `humanReviewChecklist: HumanReviewChecklistItem[]`、`ciSummary?: WorkItemCiSummary`、`testSummary?: WorkItemTestSummary`。
  - 导出新接口：`HumanReviewChecklistItem`、`WorkItemCiSummary`、`WorkItemTestSummary`、`ReportEvidence`（即 RunReportArtifact.evidence 的元素类型）。
- `packages/shared-contracts/src/report.ts`：`RunReportArtifact` 增加可选 `evidence?: ReportEvidence[]`。
- `packages/shared-contracts/src/__tests__/work-item.test.ts` / `report.test.ts`：补 round-trip / type-guard 用例。
- `packages/shared-contracts/src/events.ts`：追加 `work_item_evidence_indexed` / `work_item_evidence_confirmed` / `work_item_report_rendered`。
- `packages/shared-contracts/src/__tests__/events.test.ts`。
- `packages/shared-contracts/src/api.ts`：新增 `ConfirmEvidenceRequest` / `ConfirmEvidenceResponse` / `WorkItemEvidenceResponse`。`GET /report.md` 返回 raw `text/markdown`，不新增 `WorkItemReportMarkdownResponse`。
- `packages/shared-contracts/src/__tests__/api-work-item.test.ts`。
- `apps/orchestrator/src/work-items/aggregate.ts`：**breaking change** — 返回类型从 `Promise<WorkItemReport>` 改为 `Promise<AggregateResult>`（携带 `missing[]`）；合并 `RunReportArtifact.evidence`；构造 `humanReviewChecklist` / `ciSummary` / `testSummary`；为每条 evidence 写 `confidence`（默认 `ai-claim`；从 `checks.status` / `ci.status` 派生的 `system-derived`；命中 `getEvidenceConfirmations` overlay 的 `human-confirmed`）。`AggregateDeps` 新增 `getEvidenceConfirmations?`。
- `apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`。
- `apps/orchestrator/src/orchestrator/reconcile.ts`：跟随 aggregate breaking change，调用点改成 `const { report } = await aggregateWorkItem(...)`；行为不变。
- `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`。
- `apps/orchestrator/src/work-items/service.ts`：跟随 aggregate breaking change；新增 `confirmTaskEvidence(workItemId, taskId, evidenceId, operator)`、`getReportMarkdown(workItemId)`、`getEvidence(workItemId)` 三个方法；service 闭包内把 `store.loadEvidenceConfirmations` 注入 aggregate deps。
- `apps/orchestrator/src/work-items/__tests__/service.test.ts`：补 confirm + markdown + evidence index 用例。
- `apps/orchestrator/src/daemon.ts`（任务 5）：
  - 在 dispatch closure（worktree 仍存在、reportStore.save 已完成）之后调 `scanRunEvidence` + `mergeReportEvidence` + `reportStore.save` 二次落盘；emit `work_item_evidence_indexed`。
  - `report.md` / dashboard URL helper 只生成 evidence file 链接；真正 serve 文件时由 server 通过 `workItemId + runId` 解析 `RunReportArtifact.run.workspacePath`。
  - 注入 `getEvidenceConfirmations: (workItemId) => store.loadEvidenceConfirmations(workItemId)` 给 aggregate deps。
  - dispatch-task.ts 本阶段**不直接修改**，保持 V4.1/V4.2 行为；scanner hook 只是 daemon 的额外 step。
- `apps/orchestrator/src/team/daemon.ts`（任务 12）：team-mode 当前没有 dispatch runner；本阶段只接 per-project `WorkItemStore` / `ReportStore`、aggregation deps 与 evidence file routing，保证不跨 project 读取 task worktree。team dispatch runner 落地后再复用 single daemon 的 scan hook。
- `apps/orchestrator/src/work-items/handoff.ts`：`renderWorkItemHandoffNoteBody` 内部委托给 `renderWorkItemReportMarkdown(..., { audience: "gitlab" })`；保留 marker / state machine 不变。
- `apps/orchestrator/src/work-items/__tests__/handoff.test.ts`：补「note body 与 markdown export 一致」用例。
- `apps/orchestrator/src/server/index.ts`：新增 4 条路由：
  - `GET /api/work-items/:id/report.md` → `service.getReportMarkdown`。
  - `GET /api/work-items/:id/evidence` → `service.getEvidence`。
  - `GET /api/work-items/:id/evidence/file` → `evidence-file-server.serve`。
  - `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` → `service.confirmTaskEvidence`。
- `apps/orchestrator/src/server/__tests__/server.test.ts`。
- `apps/orchestrator/src/daemon.ts`：接入 daemon-level evidence scan hook。
- `apps/orchestrator/src/team/daemon.ts`：team-mode 每 project 使用各自 store / reportStore 解析 task worktree；不声明已存在 team dispatch scan hook。
- `apps/orchestrator/src/__tests__/daemon.test.ts` / `apps/orchestrator/src/team/__tests__/work-items.test.ts`。
- `apps/dashboard/lib/api.ts`：新增 `getWorkItemEvidence(id)`、`getWorkItemReportMarkdown(id)`、`confirmWorkItemTaskEvidence(id, taskId, evidenceId)`、`buildEvidenceFileUrl(id, runId, relPath)`。
- `apps/dashboard/lib/api.test.ts`。
- `apps/dashboard/components/work-items/parent-review-packet.tsx`：把客户端 `renderMarkdown` 删除，改成 `Copy as Markdown` 调 `getWorkItemReportMarkdown`；在 evidence section 增加 `<ConfidencePill>`；在顶部增加 `<HumanReviewChecklist>`。
- `apps/dashboard/components/work-items/parent-review-packet.test.tsx`。
- `apps/dashboard/components/work-items/work-item-detail.tsx`：扩展 `ViewToggle` 为三态 `list | graph | evidence`；evidence 视图调用 `getWorkItemEvidence`；并通过 URL `?view=evidence` 保持同源 share-link 行为。
- `apps/dashboard/components/work-items/work-item-detail.test.tsx`。
- `apps/dashboard/components/work-items/view-toggle.tsx`：扩展为三态；保留旧 `list`/`graph` 测试。
- `apps/dashboard/components/work-items/view-toggle.test.tsx`。
- `apps/dashboard/i18n/messages/zh.json` / `en.json`：新增 V4.3 字符串（evidence / confidence / checklist / markdown export / confirm 按钮 / 缺失 evidence 提示）。
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`：实施计划段加 V4.3 链接。
- `README.md` / `README.zh-CN.md`：roadmap 标 V4.3 已落地。
- `USAGE.md` / `USAGE.zh-CN.md`：新增 §5.9「Evidence tab、Human review checklist、Markdown export、evidence 目录约定」操作说明。
- `CHANGELOG.md`：按 user rule 写 V4.3 段落。
- `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence-acceptance.md`：在合入时由实现 agent 落盘，与 V4.1/V4.2 acceptance 同源。

### Worktree evidence 目录约定（产品契约，写入 USAGE）

```
<taskWorktreePath>/.issuepilot/evidence/<runId>/
  screenshots/*.png|*.jpg|*.webp
  recordings/*.mp4|*.webm
  playwright/*-trace.zip
  commands/*.txt|*.log
  tests/*.json
  manifest.json   (可选；显式声明，等价于 RunReportArtifact.evidence)
```

- 文件命名不强约束；scanner 按子目录类型识别 kind。
- `manifest.json` 是显式声明入口；如果同时存在自动扫描结果与显式声明，**显式声明优先**（label / confidence / capturedAt 以 manifest 为准）。
- 下文所有 `relPath` 都相对 `<taskWorktreePath>/.issuepilot/evidence/<runId>/`，例如 `screenshots/login.png`；不要写成相对 worktree root 的路径。
- 单文件大小限制：第一版 50MB；超大文件被 scanner 标 `oversized` 并写入 `WorkItemReport.openQuestions`，不进 evidence index（防止 dashboard 把内存撑爆）。

---

## 任务 1：扩展 EvidenceKind / confidence / RunReportArtifact.evidence 契约

**文件：**

- 修改：`packages/shared-contracts/src/work-item.ts`
- 修改：`packages/shared-contracts/src/report.ts`
- 新建：`packages/shared-contracts/src/__tests__/evidence.test.ts`
- 修改：`packages/shared-contracts/src/__tests__/work-item.test.ts`
- 修改：`packages/shared-contracts/src/__tests__/report.test.ts`（如不存在则新建）

设计要点：

- `WorkItemEvidenceEntry.kind` 从 5 种扩展为 10 种：`diff | validation | risk | ci | review_feedback | screenshot | recording | playwright | command_output | test_result`。
- `WorkItemEvidenceEntry.confidence` 三态：
  - `ai-claim`：来自 LLM 输出（handoff.validation / handoff.risks / diff.summary / RunReportArtifact.evidence 没标 confidence 时）。
  - `system-derived`：从机器可验证信号派生（`checks.status` / `ci.status` / `mergeRequest.state`）。
  - `human-confirmed`：operator 在 dashboard 显式 confirm 过。
- `WorkItemEvidenceEntry` 新增字段：`evidenceId: string`（aggregate 时自动派生，**稳定 hash**：`<taskId>:<kind>:<runId>:<base64url(sha1(relPath || href || label || text))>`，retry / replan / re-aggregate 间稳定，避免 perTask 计数变化把已 confirm 的 sidecar 错位）、`mediaType?: string`、`thumbnailHref?: string`、`capturedAt?: string`、`source?: { runId: string; relPath?: string }`、`confirmedBy?: string`、`confirmedAt?: string`。
- `RunReportArtifact.evidence?: ReportEvidence[]` 新增可选字段，元素结构：
  ```ts
  export interface ReportEvidence {
    kind:
      | "screenshot"
      | "recording"
      | "playwright"
      | "command_output"
      | "test_result";
    label: string;
    relPath?: string;
    href?: string;
    mediaType?: string;
    capturedAt?: string;
    confidence?: "ai-claim" | "system-derived";
  }
  ```

- [ ] **步骤 1：写失败的 contract 测试 `evidence.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import type {
  HumanReviewChecklistItem,
  ReportEvidence,
  WorkItemCiSummary,
  WorkItemEvidenceEntry,
  WorkItemReport,
  WorkItemTestSummary,
} from "../work-item.js";
import { isWorkItemReportStatus } from "../work-item.js";
import type { RunReportArtifact } from "../report.js";

describe("V4.3 evidence contracts", () => {
  it("accepts the 5 new evidence kinds", () => {
    const entries: WorkItemEvidenceEntry["kind"][] = [
      "screenshot",
      "recording",
      "playwright",
      "command_output",
      "test_result",
    ];
    expect(entries).toHaveLength(5);
  });

  it("requires confidence on WorkItemEvidenceEntry", () => {
    const e: WorkItemEvidenceEntry = {
      taskId: "t1",
      kind: "screenshot",
      evidenceId: "t1:screenshot:0",
      label: "Login form",
      confidence: "ai-claim",
      mediaType: "image/png",
      capturedAt: "2026-05-17T08:00:00.000Z",
      source: { runId: "run_a", relPath: "screenshots/login.png" },
    };
    expect(JSON.parse(JSON.stringify(e)).confidence).toBe("ai-claim");
  });

  it("supports a human-confirmed evidence stamp", () => {
    const e: WorkItemEvidenceEntry = {
      taskId: "t1",
      kind: "screenshot",
      evidenceId: "t1:screenshot:0",
      label: "Login form",
      confidence: "human-confirmed",
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T09:00:00.000Z",
    };
    expect(e.confirmedBy).toBe("alice");
  });

  it("RunReportArtifact carries optional evidence array", () => {
    const ev: ReportEvidence = {
      kind: "playwright",
      label: "Checkout walkthrough",
      relPath: "playwright/checkout-trace.zip",
      mediaType: "application/zip",
      capturedAt: "2026-05-17T08:00:00.000Z",
    };
    const r = { evidence: [ev] } as Partial<RunReportArtifact>;
    expect(r.evidence?.[0].kind).toBe("playwright");
  });

  it("WorkItemReport carries humanReviewChecklist + ciSummary + testSummary", () => {
    const item: HumanReviewChecklistItem = {
      itemId: "t1:risk",
      taskId: "t1",
      label: "Confirm risk: data migration is reversible",
      reason: "ai-risk-medium",
      confirmed: false,
    };
    const ci: WorkItemCiSummary = {
      overall: "passed",
      perTask: { t1: { status: "passed", pipelineUrl: "https://gitlab/p" } },
    };
    const tests: WorkItemTestSummary = {
      passed: 4,
      failed: 0,
      skipped: 1,
      unknown: 0,
      perTask: { t1: { passed: 4, failed: 0, skipped: 1, unknown: 0 } },
    };
    const r: Partial<WorkItemReport> = {
      humanReviewChecklist: [item],
      ciSummary: ci,
      testSummary: tests,
    };
    expect(r.humanReviewChecklist?.[0].confirmed).toBe(false);
    expect(r.ciSummary?.overall).toBe("passed");
    expect(r.testSummary?.passed).toBe(4);
  });

  it("isWorkItemReportStatus remains exhaustive", () => {
    for (const s of ["draft", "partial", "complete", "incomplete"]) {
      expect(isWorkItemReportStatus(s)).toBe(true);
    }
    expect(isWorkItemReportStatus("ready_to_merge")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试确认 5 个用例编译失败**

Run: `pnpm --filter @issuepilot/shared-contracts test -- evidence`
Expected: 5 个用例编译失败（新字段不存在）。

- [ ] **步骤 3：实现**

修改 `packages/shared-contracts/src/work-item.ts`：

```ts
export type WorkItemEvidenceKind =
  | "diff"
  | "validation"
  | "risk"
  | "ci"
  | "review_feedback"
  | "screenshot"
  | "recording"
  | "playwright"
  | "command_output"
  | "test_result";

export type WorkItemEvidenceConfidence =
  | "ai-claim"
  | "system-derived"
  | "human-confirmed";

export interface WorkItemEvidenceEntry {
  taskId: string;
  kind: WorkItemEvidenceKind;
  /**
   * V4.3: stable id derived as
   * `<taskId>:<kind>:<runId>:<base64url(sha1(relPath || href || label || text))>`
   * so dashboard can address a single evidence (e.g. for `confirm`)
   * and human-confirmed sidecar stays valid across retry / replan /
   * re-aggregate. NEVER an array index — that would shift on rerun.
   * Derived by `apps/orchestrator/src/work-items/evidence-id.ts`.
   */
  evidenceId: string;
  label: string;
  href?: string;
  text?: string;
  /** V4.3: how trustworthy the entry is. Drives the AI-vs-human pill. */
  confidence: WorkItemEvidenceConfidence;
  mediaType?: string;
  thumbnailHref?: string;
  capturedAt?: string;
  source?: { runId: string; relPath?: string };
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface HumanReviewChecklistItem {
  itemId: string;
  taskId?: string;
  label: string;
  /** Codified reason — drives dashboard grouping + USAGE docs. */
  reason:
    | "ai-risk-medium"
    | "ai-risk-high"
    | "needs-rework"
    | "partial-overall"
    | "missing-evidence"
    | "skipped-task"
    | "ci-failed";
  confirmed: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface WorkItemCiSummary {
  /** Worst CI status across the constituent task reports. */
  overall: "passed" | "failed" | "running" | "unknown";
  perTask: Record<
    string,
    { status: string; pipelineUrl?: string }
  >;
}

export interface WorkItemTestSummary {
  passed: number;
  failed: number;
  skipped: number;
  unknown: number;
  perTask: Record<
    string,
    { passed: number; failed: number; skipped: number; unknown: number }
  >;
}

export interface WorkItemReport {
  workItemId: string;
  overallStatus: WorkItemReportStatus;
  taskSummaries: WorkItemTaskSummary[];
  validationSummary: string;
  riskSummary: string;
  evidence: {
    index: WorkItemEvidenceEntry[];
    byTask: Record<string, WorkItemEvidenceEntry[]>;
  };
  openQuestions: string[];
  recommendedNextActions: string[];
  generatedAt: string;
  /** V4.3 §14.3: items the human reviewer must confirm before merge. */
  humanReviewChecklist: HumanReviewChecklistItem[];
  /** V4.3 §14.4: optional CI roll-up across all constituent runs. */
  ciSummary?: WorkItemCiSummary;
  /** V4.3 §14.4: optional test result roll-up. */
  testSummary?: WorkItemTestSummary;
}
```

修改 `packages/shared-contracts/src/report.ts`：

```ts
export interface ReportEvidence {
  kind:
    | "screenshot"
    | "recording"
    | "playwright"
    | "command_output"
    | "test_result";
  label: string;
  relPath?: string;
  href?: string;
  mediaType?: string;
  capturedAt?: string;
  confidence?: "ai-claim" | "system-derived";
}

export interface RunReportArtifact {
  // ...existing fields unchanged...
  /**
   * V4.3: structured evidence references collected via the worktree
   * evidence directory contract (see USAGE.md §5.9) or written by the
   * agent through Codex tooling. The aggregator hoists these into
   * WorkItemReport.evidence.
   */
  evidence?: ReportEvidence[];
}
```

- [ ] **步骤 4：跑测试确认通过 + commit**

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/work-item.ts \
        packages/shared-contracts/src/report.ts \
        packages/shared-contracts/src/__tests__/evidence.test.ts \
        packages/shared-contracts/src/__tests__/work-item.test.ts \
        packages/shared-contracts/src/__tests__/report.test.ts
git commit -m "feat(shared-contracts): add V4.3 evidence kinds, confidence and report rollups"
```

---

## 任务 2：扩展事件枚举

**文件：**

- 修改：`packages/shared-contracts/src/events.ts`
- 修改：`packages/shared-contracts/src/__tests__/events.test.ts`

V4.3 新增 3 个事件。

- [ ] **步骤 1：在 events.test.ts 增加用例**

```ts
describe("V4.3 review packet events", () => {
  const expected = [
    "work_item_evidence_indexed",
    "work_item_evidence_confirmed",
    "work_item_report_rendered",
  ];
  it.each(expected)("registers %s", (type) => {
    expect((EVENT_TYPE_VALUES as readonly string[]).includes(type)).toBe(true);
    expect(isEventType(type)).toBe(true);
  });
});
```

- [ ] **步骤 2：实现**

```ts
// V4.3 review packet + evidence
"work_item_evidence_indexed",
"work_item_evidence_confirmed",
"work_item_report_rendered",
```

- [ ] **步骤 3：跑测试 + commit**

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/events.ts \
        packages/shared-contracts/src/__tests__/events.test.ts
git commit -m "feat(shared-contracts): register V4.3 evidence + report events"
```

---

## 任务 3：扩展 API 契约（evidence index / report.md / confirm）

**文件：**

- 修改：`packages/shared-contracts/src/api.ts`
- 修改：`packages/shared-contracts/src/__tests__/api-work-item.test.ts`

API 设计：

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/work-items/:id/report.md` | — | `text/markdown` raw body（contracts 不建模 JSON wrapper） |
| `GET /api/work-items/:id/evidence` | — | `WorkItemEvidenceResponse { byTask, index, missing }` |
| `GET /api/work-items/:id/evidence/file?runId=...&path=...` | — | binary file stream（不在 contracts 中建模） |
| `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` | `ConfirmEvidenceRequest { operator?: string }` | `ConfirmEvidenceResponse { evidenceId: string; confirmedAt: string; report: WorkItemReport }` |

- [ ] **步骤 1：写失败的 API 契约测试**

```ts
import { describe, expect, it } from "vitest";

import type {
  ConfirmEvidenceRequest,
  ConfirmEvidenceResponse,
  WorkItemEvidenceResponse,
} from "../api.js";
import type { WorkItemEvidenceEntry } from "../work-item.js";

describe("V4.3 API contracts", () => {
  it("ConfirmEvidenceRequest can omit operator (server uses header)", () => {
    const req: ConfirmEvidenceRequest = {};
    expect(req.operator).toBeUndefined();
  });

  it("ConfirmEvidenceResponse echoes evidenceId + report", () => {
    const r: ConfirmEvidenceResponse = {
      evidenceId: "t1:screenshot:0",
      confirmedAt: "2026-05-17T10:00:00.000Z",
      report: {
        workItemId: "wi",
        overallStatus: "complete",
        taskSummaries: [],
        validationSummary: "",
        riskSummary: "",
        evidence: { index: [], byTask: {} },
        openQuestions: [],
        recommendedNextActions: [],
        generatedAt: "2026-05-17T10:00:00.000Z",
        humanReviewChecklist: [],
      },
    };
    expect(r.evidenceId).toBe("t1:screenshot:0");
  });

  it("WorkItemEvidenceResponse exposes both grouped + missing", () => {
    const r: WorkItemEvidenceResponse = {
      index: [] as WorkItemEvidenceEntry[],
      byTask: {},
      missing: [
        { taskId: "t2", reason: "no-run-report" },
      ],
    };
    expect(r.missing).toHaveLength(1);
  });

  // report.md is intentionally not modeled here: the server route returns
  // raw text/markdown so browser copy/download and GitLab note comparisons
  // read the exact same string.
});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```ts
export interface ConfirmEvidenceRequest {
  operator?: string;
}

export interface ConfirmEvidenceResponse {
  evidenceId: string;
  confirmedAt: string;
  report: WorkItemReport;
}

export interface WorkItemEvidenceResponse {
  index: WorkItemEvidenceEntry[];
  byTask: Record<string, WorkItemEvidenceEntry[]>;
  /** Tasks for which the aggregator could not gather evidence. */
  missing: Array<{
    taskId: string;
    reason: "no-run-report" | "no-link" | "incomplete-report";
  }>;
}
```

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/api.ts \
        packages/shared-contracts/src/__tests__/api-work-item.test.ts
git commit -m "feat(shared-contracts): add V4.3 evidence + report.md API types"
```

---

## 任务 4：Evidence scanner（worktree 约定目录）

**文件：**

- 新建：`apps/orchestrator/src/work-items/evidence-scanner.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/evidence-scanner.test.ts`

`scanRunEvidence({ taskWorktreePath, runId, oversizedLimitBytes = 50 * 1024 * 1024 })` 行为：

1. 检查 `<taskWorktreePath>/.issuepilot/evidence/<runId>/`；不存在则返回 `{ entries: [], oversized: [], manifestUsed: false }`。
2. 如果存在 `manifest.json`，优先解析（schema：`{ entries: ReportEvidence[] }`），把 manifest 项作为权威列表；scanner 仍扫描目录用于 `oversized` 检测。
3. 否则按子目录映射 kind：
   - `screenshots/*.(png|jpg|jpeg|webp)` → `screenshot` + `mediaType` 推断。
   - `recordings/*.(mp4|webm|mov)` → `recording`。
   - `playwright/*-trace.zip` 或 `playwright/*.zip` → `playwright`。
   - `commands/*.(txt|log)` → `command_output`。
   - `tests/*.json` → `test_result`。
4. 每条 entry 的 `label = path.basename(relPath)`、`relPath` 相对 `<taskWorktreePath>/.issuepilot/evidence/<runId>/`。
5. 单文件超过 `oversizedLimitBytes`：不放进 `entries`，写入 `oversized: { relPath, sizeBytes }`。
6. 返回值供 daemon 在 dispatch closure 结束后 patch `RunReportArtifact.evidence` 使用。

设计说明：scanner 是纯文件 IO，**不**改 reportStore，也不构造 `WorkItemEvidenceEntry`（那是 aggregator 的事）。

> `relPath` 字段约定：scanner 输出 / `ReportEvidence.relPath` / `WorkItemEvidenceEntry.source.relPath` / dashboard `buildEvidenceFileUrl` / `GET /api/work-items/:id/evidence/file?path=...` **全部相对 `<taskWorktreePath>/.issuepilot/evidence/<runId>/`**（例如 `screenshots/login.png`），保证 file server 可以安全 `path.resolve(taskWorktreePath, ".issuepilot", "evidence", runId, relPath)`。

- [ ] **步骤 1：写失败的 scanner 测试**

```ts
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { scanRunEvidence } from "../evidence-scanner.js";

async function makeWorktree(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ipv43-evidence-"));
}

describe("scanRunEvidence", () => {
  it("returns empty when no evidence dir exists", async () => {
    const r = await scanRunEvidence({
      taskWorktreePath: await makeWorktree(),
      runId: "run_a",
    });
    expect(r.entries).toEqual([]);
    expect(r.manifestUsed).toBe(false);
  });

  it("infers screenshot from screenshots/*.png", async () => {
    const root = await makeWorktree();
    const dir = join(root, ".issuepilot/evidence/run_a/screenshots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "login.png"), Buffer.from([0x89, 0x50, 0x4e]));
    const r = await scanRunEvidence({ taskWorktreePath: root, runId: "run_a" });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      kind: "screenshot",
      mediaType: "image/png",
      relPath: "screenshots/login.png",
    });
  });

  it("infers playwright from playwright/*-trace.zip", async () => {/* ... */});
  it("infers command_output from commands/*.log", async () => {/* ... */});
  it("infers test_result from tests/*.json", async () => {/* ... */});

  it("prefers manifest.json over directory inference", async () => {
    const root = await makeWorktree();
    const evDir = join(root, ".issuepilot/evidence/run_a");
    await mkdir(join(evDir, "screenshots"), { recursive: true });
    await writeFile(join(evDir, "screenshots/login.png"), "fake");
    await writeFile(
      join(evDir, "manifest.json"),
      JSON.stringify({
        entries: [
          {
            kind: "screenshot",
            label: "Login form (manifest)",
            relPath: "screenshots/login.png",
            mediaType: "image/png",
            capturedAt: "2026-05-17T08:00:00.000Z",
          },
        ],
      }),
    );
    const r = await scanRunEvidence({ taskWorktreePath: root, runId: "run_a" });
    expect(r.manifestUsed).toBe(true);
    expect(r.entries[0].label).toBe("Login form (manifest)");
  });

  it("flags oversized files instead of returning them", async () => {
    const root = await makeWorktree();
    const dir = join(root, ".issuepilot/evidence/run_a/recordings");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "big.mp4"), Buffer.alloc(51 * 1024 * 1024));
    const r = await scanRunEvidence({
      taskWorktreePath: root,
      runId: "run_a",
      oversizedLimitBytes: 50 * 1024 * 1024,
    });
    expect(r.entries).toEqual([]);
    expect(r.oversized[0].relPath).toBe("recordings/big.mp4");
  });

  it("rejects manifest entries with relPath escaping the evidence dir", async () => {
    const root = await makeWorktree();
    const evDir = join(root, ".issuepilot/evidence/run_a");
    await mkdir(evDir, { recursive: true });
    await writeFile(
      join(evDir, "manifest.json"),
      JSON.stringify({
        entries: [
          { kind: "screenshot", label: "x", relPath: "../../../etc/passwd" },
        ],
      }),
    );
    const r = await scanRunEvidence({ taskWorktreePath: root, runId: "run_a" });
    expect(r.entries).toEqual([]);
    expect(r.oversized).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });
});
```

- [ ] **步骤 2：实现 → 通过**

实现要点：用 `fs.promises.readdir` + `fs.stat` 遍历五个子目录；扩展名映射 mediaType；manifest 中 `relPath` 必须 `path.relative(path.join(taskWorktreePath, ".issuepilot", "evidence", runId), resolved).startsWith("..") === false` 否则 reject。

- [ ] **步骤 3：commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- evidence-scanner
git add apps/orchestrator/src/work-items/evidence-scanner.ts \
        apps/orchestrator/src/work-items/__tests__/evidence-scanner.test.ts
git commit -m "feat(orchestrator): scan worktree evidence directory into ReportEvidence[]"
```

---

## 任务 5：Daemon 端 evidence scanner 接入 hook

**架构决策：** V4.1/V4.2 实际架构下 `runTaskOnce` 通过注入的 `dispatch` closure 触发 run，**reportStore.save 是 daemon 在 dispatch closure 内完成的**。因此 evidence scanner 必须接到 **daemon 层**（dispatch closure return 之后、worktree 仍存在时），不进 dispatch-task；这样 dispatch-task 单测保持纯（V4.2 已有结构不动）。

**文件：**

- 修改：`apps/orchestrator/src/daemon.ts`（single-project daemon）
- 修改：`apps/orchestrator/src/__tests__/daemon.test.ts`

**行为：**

1. 在 daemon 现有 work-items dispatch closure（V4.1 task dispatch 路径）里，紧接最终 `reportStore.save(finalReport)` 之后，从 `finalReport.run.workspacePath` 读取真实 task worktree 路径；如果为空，跳过扫描并 emit `work_item_evidence_index_skipped`（避免误扫 workspace root）：
   ```ts
   const taskWorktreePath = finalReport.run.workspacePath;
   if (!taskWorktreePath) {
     eventBus.emit({
       type: "work_item_evidence_index_skipped",
       runId: opts.runId,
       ts: now(),
       detail: { reason: "missing-workspace-path" },
     });
     return;
   }
   const scan = await scanRunEvidence({
     taskWorktreePath,
     runId: opts.runId,
   });
   const finalEvidence = mergeReportEvidence(finalReport.evidence ?? [], scan);
   const patched: RunReportArtifact = {
     ...finalReport,
     evidence: finalEvidence,
     handoff: {
       ...finalReport.handoff,
       followUps: appendOversizedFollowUps(
         finalReport.handoff.followUps,
         scan.oversized,
         scan.rejected,
       ),
     },
   };
   await reportStore.save(patched);
   eventBus.emit({
     type: "work_item_evidence_indexed",
     runId: opts.runId,
     ts: now(),
     detail: {
       count: finalEvidence.length,
       oversizedCount: scan.oversized.length,
       rejectedCount: scan.rejected.length,
       manifestUsed: scan.manifestUsed,
     },
   });
   ```
2. `mergeReportEvidence(existing, scan)`：scanner.manifestUsed → `scan.entries`（manifest 权威）；否则 `scan.entries ∪ existing` 按 `(relPath || label)` 去重，scan 项优先（带 mediaType/capturedAt）。`mergeReportEvidence` 是 daemon-local helper（也可放 `work-items/evidence-merge.ts` 复用到 team daemon）。
3. `appendOversizedFollowUps` 把每个 oversized / rejected 写一行 `evidence oversized: <relPath> (<MB>MB)` / `evidence rejected: <relPath> escapes evidence dir`，aggregator 任务 6 会把这些 followUps 映射进 `openQuestions`。
4. **不**改 dispatch-task.ts；scanner 调用全在 single daemon 里。team daemon 当前尚无 synthetic task dispatch runner，任务 12 只补 project-scoped report/file routing；后续 team dispatch runner 落地时必须复用同一 scanner hook。

- [ ] **步骤 1：抽出 helper + 写失败测试**

新建 `apps/orchestrator/src/work-items/evidence-merge.ts`，导出 `mergeReportEvidence(existing, scan)` 与 `appendOversizedFollowUps(followUps, oversized, rejected)`，并配套 `evidence-merge.test.ts`：

```ts
it("returns scan entries as authoritative when manifest is used", () => {/* ... */});
it("dedupes by relPath when scanner overlaps with existing", () => {/* ... */});
it("appends oversized + rejected findings as one followUp per file", () => {/* ... */});
```

修改 `daemon.test.ts` 增加：

```ts
it("daemon patches reportStore with scanned evidence after dispatch closure", async () => {
  // arrange a fake worktree with screenshots/login.png
  // run a stub work-item dispatch that produces a report
  // assert reportStore.save called twice: once by the closure (no evidence),
  // and a second time with the scanned screenshot in report.evidence.
});
it("daemon emits work_item_evidence_indexed once per task dispatch", async () => {/* ... */});
it("daemon does not patch reportStore when the task worktree has no evidence dir", async () => {/* ... */});
it("daemon skips evidence scan when finalReport.run.workspacePath is empty", async () => {/* ... */});
```

- [ ] **步骤 2：实现 → 通过**

`daemon.ts` 把 closure 包成一个 `withEvidenceScan(...)` 装饰函数；helper 文件位于 `work-items/evidence-merge.ts`，便于后续 team dispatch runner 复用。

- [ ] **步骤 3：commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- 'evidence-merge|daemon'
git add apps/orchestrator/src/work-items/evidence-merge.ts \
        apps/orchestrator/src/work-items/__tests__/evidence-merge.test.ts \
        apps/orchestrator/src/daemon.ts \
        apps/orchestrator/src/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): daemon-level evidence scan hook patches reportStore"
```

> Team daemon 当前尚无 synthetic task dispatch runner；team-mode scan hook 留到 team dispatch runner 落地时接线。任务 12 只处理 project-aware report/file routing 隔离。

---

## 任务 6：aggregate 把 RunReport.evidence + checks 注入 WorkItemEvidenceEntry

**文件：**

- 修改：`apps/orchestrator/src/work-items/aggregate.ts`
- 修改：`apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`

改动点：

1. 现有 5 种 kind 保持原有派生路径，但每条 entry 现在必须显式写 `confidence`：
   - `diff` / `validation` / `risk` / `review_feedback` → `ai-claim`。
   - `ci` → `system-derived`（来自实际 pipeline 状态）。
2. 新增 5 种 kind 派生：
   - `screenshot` / `recording` / `playwright` / `command_output` → 直接来自 `report.evidence[]`；`confidence` 默认 `ai-claim`，除非 `ReportEvidence.confidence === "system-derived"`。
   - `test_result` → 同时来自：
     - `report.checks[]`（每条 check 一个 entry，`confidence = "system-derived"`）；
     - `report.evidence` 中 `kind === "test_result"` 的项（`ai-claim`，比如 LLM 写的「我手动 curl 验证了」）。
3. 每条 entry 写 `evidenceId = <taskId>:<kind>:<runId>:<base64url(sha1(seed))>`，`seed = entry.source?.relPath ?? entry.href ?? entry.label ?? entry.text ?? ""`。**稳定 hash** 保证 retry / replan / re-aggregate 间同一物理 evidence 拿到同一 id，已确认的 sidecar 不会因 ordering 变化而错位。新增小工具 `apps/orchestrator/src/work-items/evidence-id.ts` + 单测 `evidence-id.test.ts`（pure 函数，方便测试）。
4. 如果 evidence 对应 `evidenceId` 在 sidecar `evidence-confirmations/<workItemId>.json` 中存在（confirmation 已写过），aggregate 时把 evidence 的 `confidence` 升级为 `human-confirmed` 并 reuse `confirmedBy` / `confirmedAt`。**实现层面**：aggregator 通过 `deps.getEvidenceConfirmations(workItemId)` 拉取「evidenceId → { confirmedBy, confirmedAt }」覆盖层。
5. **`AggregateDeps` 扩展**：
   ```ts
   export interface AggregateDeps {
     getRunReport(runId: string): Promise<RunReportArtifact | undefined>;
     /** V4.3: evidence confirmation overlay; see store sidecar. */
     getEvidenceConfirmations?(
       workItemId: string,
     ): Promise<Record<string, { confirmedBy: string; confirmedAt: string }>>;
     now?(): string;
   }
   ```
   未提供 `getEvidenceConfirmations` 时视为空 overlay（向后兼容旧调用方）。
6. 派生 `WorkItemCiSummary`：取所有 task report 的 `ci.status`；`overall = "failed"` 如果任一 `failed`，否则 `running`/`unknown` 优先级递减。
7. 派生 `WorkItemTestSummary`：把 `report.checks[]` 按 status 计数 + 按 task 拆分。
8. **派生独立 `missing[]` 数组**（spec §12.5），与 checklist 解耦：
   - `link` 缺失 + 非 operator-driven（skipped/needs_rework）→ `{ taskId, reason: "no-link" }`。
   - `link.status === "completed"` 但 `report` 不存在 → `{ taskId, reason: "no-run-report" }`。
   - `report` 存在但缺关键字段（无 `diff` / 无 `handoff` / 无 `checks` 数组等旧合同必需结构）→ `{ taskId, reason: "incomplete-report" }`。
   - **不要**因为 `report.evidence` 缺失就判 `incomplete-report`：`RunReportArtifact.evidence` 是 V4.3 新增可选字段，旧 report 仍可由 `diff` / `handoff` / `ci` / `reviewFeedback` 派生 evidence。
   - aggregator 内部把 `missing[]` 暴露在 `WorkItemReport.evidence` 的隐藏副产物里？为避免污染契约，把 `missing[]` 作为 aggregator 的**额外返回值**：
     ```ts
     export interface AggregateResult {
       report: WorkItemReport;
       missing: Array<{
         taskId: string;
         reason: "no-run-report" | "no-link" | "incomplete-report";
       }>;
     }
     export async function aggregateWorkItem(...): Promise<AggregateResult>;
     ```
     调用方（reconcile.ts / service.getEvidence）按需取 `missing[]`。**这是 breaking change**：现有调用方 `service.ts` / `reconcile.ts` 必须改成 `const { report, missing } = await aggregateWorkItem(...)` 并把 `report` 透传到原有路径。任务 6 在实现里同时更新调用点（一处 reconcile，一处 service）。
9. 派生 `humanReviewChecklist`，规则：
   - 任意 risk `level === "medium"` → 一条 `reason: "ai-risk-medium"`。
   - 任意 risk `level === "high"` → 一条 `reason: "ai-risk-high"`。
   - 任意 task `effectiveTaskStatus === "needs_rework"` → 一条 `reason: "needs-rework"`。
   - 任意 task `effectiveTaskStatus === "skipped"` → 一条 `reason: "skipped-task"`。
   - `overallStatus === "partial"` → 一条 `reason: "partial-overall"`。
   - 每个 missing[] 条目 → 一条 `reason: "missing-evidence"`（注意是从 missing[] 派生，不是反推）。
   - `ciSummary.overall === "failed"` → 一条 `reason: "ci-failed"`。
   - 每条 `itemId = <reason>:<taskId|workItem>`，**`confirmed` 永远为 `false`**。
10. **checklist 第一版只读**（spec §14.3 「明确哪些是 AI 判断，哪些需要人确认」第一版只到「明确」级别）：
    - 不读 sidecar。
    - 不存在 `POST /api/checklist/:itemId/confirm` endpoint。
    - 人工确认通过 evidence 级 `confirmTaskEvidence` 表达；checklist 行为留到 V4.4。
    - 这条决策写进「不变量回顾」+「不做」+「后续阶段」。

- [ ] **步骤 1：写失败的 aggregate 测试（在现有 describe 末尾追加）**

```ts
describe("V4.3 aggregator extensions", () => {
  it("returns AggregateResult { report, missing } shape", async () => {/* ... */});
  it("hoists RunReportArtifact.evidence screenshots into byTask + index", async () => {/* ... */});
  it("annotates ci entries with confidence=system-derived", async () => {/* ... */});
  it("derives ciSummary.overall as the worst per-task status", async () => {/* ... */});
  it("derives testSummary from RunReportArtifact.checks", async () => {/* ... */});
  it("builds humanReviewChecklist for medium risks", async () => {/* ... */});
  it("builds humanReviewChecklist for needs_rework tasks", async () => {/* ... */});
  it("builds humanReviewChecklist for ci-failed", async () => {/* ... */});
  it("checklist items always have confirmed=false (V4.3 read-only)", async () => {/* ... */});
  it("upgrades evidence confidence to human-confirmed when deps.getEvidenceConfirmations returns its id", async () => {/* ... */});
  it("preserves confirmedBy / confirmedAt from getEvidenceConfirmations", async () => {/* ... */});
  it("returns missing=[{taskId,reason:'no-link'}] when a non-operator-driven task has no TaskRunLink", async () => {/* ... */});
  it("returns missing=[{taskId,reason:'no-run-report'}] when link.status='completed' but reportStore is empty", async () => {/* ... */});
  it("returns missing=[{taskId,reason:'incomplete-report'}] when report exists but has no diff/handoff", async () => {/* ... */});
  it("does not mark a report incomplete only because RunReportArtifact.evidence is undefined", async () => {/* ... */});
  it("emits checklist 'missing-evidence' items derived from missing[]", async () => {/* ... */});
});
```

> **注意：** aggregator 签名从 `Promise<WorkItemReport>` → `Promise<AggregateResult>` 是 breaking change。任务 6 同步更新所有 caller：
> - `apps/orchestrator/src/orchestrator/reconcile.ts`（V4.1 引入）
> - `apps/orchestrator/src/work-items/service.ts`（多处）
> - `apps/orchestrator/src/__tests__/work-items-e2e.test.ts` / `work-items-v42-e2e.test.ts`（如果直接调 aggregator）
>
> 调用方 idiom 改为 `const { report } = await aggregateWorkItem(...)`，把 `report` 透传到原 V4.1/V4.2 路径，不影响行为。

- [ ] **步骤 2：实现 + 调通现有 aggregate 测试**

注意：旧的 5 种 kind 测试可能因为 `confidence` 新字段而需要更新断言；保留旧覆盖、用 `expect.objectContaining` 避免硬绑定整个 entry 对象。

- [ ] **步骤 3：commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- aggregate
git add apps/orchestrator/src/work-items/aggregate.ts \
        apps/orchestrator/src/work-items/__tests__/aggregate.test.ts
git commit -m "feat(orchestrator): aggregate V4.3 evidence + checklist + summaries"
```

---

## 任务 7：renderWorkItemReportMarkdown 统一渲染器

**文件：**

- 新建：`apps/orchestrator/src/work-items/render-report.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/render-report.test.ts`

签名：

```ts
export interface RenderReportOptions {
  /** "gitlab" omits clipboard hints; "markdown" adds the file header. */
  audience: "gitlab" | "markdown";
  /** Optional base href for evidence file links (dashboard / orchestrator). */
  evidenceBaseHref?: string;
}

export function renderWorkItemReportMarkdown(
  workItem: WorkItem,
  plan: TaskPlan,
  report: WorkItemReport,
  options: RenderReportOptions,
): string;
```

渲染章节顺序：

1. 顶部 `# Parent Review Packet — <title>`（`markdown`）或 `## IssuePilot work item handoff — <title>`（`gitlab`）。**renderer 不输出 marker**；`handoff.ts` 继续独占 `workItemHandoffMarker()` 拼接，避免 marker 重复。
2. `**Status:**` / `**Plan version:**` / `**Tasks:**` / `**Generated at:**`。
3. `## Human review checklist`：每条 `- [ ] <label>`，已确认的渲染 `- [x] <label> _(confirmed by ... at ...)_`。
4. `## Task summary`：复用 V4.1 handoff body 列表格式。
5. `## Validation`、`## Risks`、`## CI` / `## Tests`（如果 ciSummary / testSummary 存在）。
6. `## Evidence`：按 task 分组；每条带 `(<confidence>)` 后缀；带 `href` 时渲染 `[label](href)`，没有则 `label — text`。
7. `## Open questions`、`## Recommended next actions`。
8. 底部 `_Generated at <ts>._`。

特殊不变量：renderer 必须输出 **deterministic**（排序 stable，evidence 内部按 `evidenceId` 升序），方便测试。`audience` 只允许影响顶层标题和复制/导出提示，不能让 task summary / validation / risks / CI / tests / evidence / open questions / next actions 漂移。

- [ ] **步骤 1：写失败的 render-report 测试**

```ts
it("does not emit a GitLab marker line in audience=gitlab", () => {/* ... */});
it("emits Parent Review Packet H1 in audience=markdown", () => {/* ... */});
it("renders [ ] for unconfirmed checklist items and [x] for confirmed", () => {/* ... */});
it("renders evidence link [label](evidenceBaseHref?...) when entry has source.relPath", () => {/* ... */});
it("groups evidence by task in stable order", () => {/* ... */});
it("keeps core sections identical between audience=gitlab and audience=markdown", () => {/* ... */});
it("renders ciSummary + testSummary when present", () => {/* ... */});
it("omits ciSummary section when ciSummary is undefined", () => {/* ... */});
it("never outputs 'ready_to_merge' in next actions", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- render-report
git add apps/orchestrator/src/work-items/render-report.ts \
        apps/orchestrator/src/work-items/__tests__/render-report.test.ts
git commit -m "feat(orchestrator): shared WorkItemReport markdown renderer"
```

---

## 任务 8：Service.getReportMarkdown / getEvidence / confirmTaskEvidence

**文件：**

- 修改：`apps/orchestrator/src/work-items/service.ts`
- 修改：`apps/orchestrator/src/work-items/store.ts`：新增 `loadEvidenceConfirmations(workItemId)` / `saveEvidenceConfirmation(workItemId, evidenceId, { confirmedBy, confirmedAt })`，sidecar 文件 `evidence-confirmations/<workItemId>.json`（与现有 `work-items/<workItemId>.json` 单文件结构并排，不要把 `work-items/<id>/` 改成目录，否则会和现有 `WorkItemStore` 路径冲突）。
- 修改：`apps/orchestrator/src/work-items/__tests__/service.test.ts`
- 修改：`apps/orchestrator/src/work-items/__tests__/store.test.ts`

`getReportMarkdown(workItemId)`：

1. `getWorkItemDetail(workItemId)` 已经计算了 report；如果 `report` 不存在（`planning` / `ready` 且未跑过 task），返回 `{ error: "report_not_ready" }`。
2. 调 `renderWorkItemReportMarkdown(workItem, plan, report, { audience: "markdown", evidenceBaseHref })`。
3. emit `work_item_report_rendered`。

`getEvidence(workItemId)`：

1. 调 `aggregateWorkItem(...)` 拿 `{ report, missing }`。
2. 返回 `{ index: report.evidence.index, byTask: report.evidence.byTask, missing }`，直接透传 aggregator 派生的 `missing[]`（不要从 checklist 反推）。

`confirmTaskEvidence(workItemId, taskId, evidenceId, { operator })`：

1. 校验 work item / task / 当前 plan 存在。
2. 校验 `evidenceId` 在 aggregate 后的 evidence index 中确实存在，且该 evidence 的 `taskId` 等于 URL 里的 `taskId`；否则 `not_found`。
3. 把 confirmation 写到 store（sidecar 文件）。
4. 触发 `reconcileWorkItem(workItemId)`（aggregate 重算，handoff note 重写，label 不动）。
5. emit `work_item_evidence_confirmed`，detail 包含 `evidenceId`、`taskId`、`confirmedBy`、`confirmedAt`。
6. 返回 `{ evidenceId, confirmedAt, report }`。

- [ ] **步骤 1：写失败的 service / store 测试**

```ts
// store.test.ts
it("persists evidence confirmations under evidence-confirmations/<workItemId>.json", async () => {/* ... */});

// service.test.ts
it("getReportMarkdown delegates to renderWorkItemReportMarkdown", async () => {/* ... */});
it("getReportMarkdown returns report_not_ready when no plan accepted", async () => {/* ... */});
it("getEvidence exposes missing tasks", async () => {/* ... */});
it("confirmTaskEvidence rejects unknown evidenceId", async () => {/* ... */});
it("confirmTaskEvidence rejects an evidenceId that belongs to another task", async () => {/* ... */});
it("confirmTaskEvidence stamps confirmedBy + confirmedAt and emits work_item_evidence_confirmed", async () => {/* ... */});
it("confirmTaskEvidence triggers reconcileWorkItem so handoff note re-renders", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- 'service|store'
git add apps/orchestrator/src/work-items/service.ts \
        apps/orchestrator/src/work-items/store.ts \
        apps/orchestrator/src/work-items/__tests__/service.test.ts \
        apps/orchestrator/src/work-items/__tests__/store.test.ts
git commit -m "feat(orchestrator): expose V4.3 evidence + report.md + confirm service"
```

---

## 任务 9：handoff.ts 复用 renderWorkItemReportMarkdown

**文件：**

- 修改：`apps/orchestrator/src/work-items/handoff.ts`
- 修改：`apps/orchestrator/src/work-items/__tests__/handoff.test.ts`

行为：

1. 删除 `renderWorkItemHandoffNoteBody` 中的 inline body 拼装代码（保留 marker / 状态机 / I/O wrapper）。
2. 改为 `renderWorkItemHandoffNoteBody(workItem, plan, report) => workItemHandoffMarker(...) + "\n" + renderWorkItemReportMarkdown(workItem, plan, report, { audience: "gitlab" })`；`renderWorkItemReportMarkdown(..., { audience: "gitlab" })` 自身不得输出 marker。
3. 保留 marker 在 first line，保证 `findWorkpadNote(markerPrefix)` 仍能命中。

- [ ] **步骤 1：补 handoff 测试「note body 与 markdown export 一致（除 marker 前缀外）」**

```ts
it("renderWorkItemHandoffNoteBody equals exactly one marker + renderWorkItemReportMarkdown(gitlab)", () => {/* ... */});
it("decideParentLabelTransition behaviour is unchanged", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- handoff
git add apps/orchestrator/src/work-items/handoff.ts \
        apps/orchestrator/src/work-items/__tests__/handoff.test.ts
git commit -m "refactor(orchestrator): handoff note shares renderWorkItemReportMarkdown"
```

---

## 任务 10：Evidence file server（受限静态服务）

**文件：**

- 新建：`apps/orchestrator/src/work-items/evidence-file-server.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/evidence-file-server.test.ts`

签名：

```ts
export interface ServeEvidenceFileInput {
  taskWorktreePath: string;
  runId: string;
  relPath: string;
}

export interface ServeEvidenceFileResult {
  ok: true;
  absPath: string;
  mediaType: string;
  sizeBytes: number;
} | { ok: false; error: "not_found" | "forbidden" | "oversized" };
```

行为：

1. `expectedRoot = path.resolve(taskWorktreePath, ".issuepilot", "evidence", runId)`；`requested = path.resolve(expectedRoot, relPath)`。
2. 必须满足 `requested.startsWith(expectedRoot + path.sep)`，否则 `forbidden`。
3. 必须 `fs.stat` 存在且为文件；否则 `not_found`。
4. `sizeBytes > 50 * 1024 * 1024` → `oversized`（保护 dashboard）。
5. `mediaType` 推断（mime db 简化版即可，限定在 V4.3 五种 kind 涉及的扩展名）。

`server/index.ts` 在路由层先用 `workItemId` 查询当前 WorkItem 的 `TaskRunLink`，确认 query `runId` 属于该 WorkItem；再从对应 `RunReportArtifact.run.workspacePath` 取 `taskWorktreePath`，传给 `serveEvidenceFile(...)` + Fastify stream。禁止只按全局 evidence root + runId serve 文件。

- [ ] **步骤 1：写失败的 evidence-file-server 测试**

```ts
it("returns absPath for a file inside <taskWorktreePath>/.issuepilot/evidence/<runId>/", async () => {/* ... */});
it("returns forbidden when relPath escapes via ../../", async () => {/* ... */});
it("returns not_found when file does not exist", async () => {/* ... */});
it("returns oversized when file size > 50MB", async () => {/* ... */});
it("infers image/png for .png", async () => {/* ... */});
it("infers video/mp4 for .mp4", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- evidence-file-server
git add apps/orchestrator/src/work-items/evidence-file-server.ts \
        apps/orchestrator/src/work-items/__tests__/evidence-file-server.test.ts
git commit -m "feat(orchestrator): sandboxed static server for evidence files"
```

---

## 任务 11：Server 路由扩展

**文件：**

- 修改：`apps/orchestrator/src/server/index.ts`
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`

新增路由：

1. `GET /api/work-items/:id/report.md` → text/markdown；调 `service.getReportMarkdown`；错误 → 404 `report_not_ready` / 404 `not_found`。
2. `GET /api/work-items/:id/evidence` → JSON `WorkItemEvidenceResponse`。
3. `GET /api/work-items/:id/evidence/file?runId=<>&path=<>` → stream；调 `evidence-file-server`；错误码 403 / 404 / 413 `oversized`。
4. `POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` → JSON `ConfirmEvidenceResponse`；body `{ operator? }`。

所有路由继续遵循 V4.2 的 `x-issuepilot-project` header 解析；`evidence/file` 额外支持 `?project=` query 作为 `<img>` / `<video>` 等浏览器资源请求的 fallback，并复用同一套 project service resolution。

- [ ] **步骤 1：增 server 路由测试**

```ts
it("GET /api/work-items/:id/report.md returns markdown body", async () => {/* ... */});
it("GET .../report.md returns 404 report_not_ready when no plan accepted", async () => {/* ... */});
it("GET /api/work-items/:id/evidence returns grouped + missing", async () => {/* ... */});
it("GET /api/work-items/:id/evidence/file streams png and infers content-type", async () => {/* ... */});
it("GET .../evidence/file returns 403 when path tries to escape via ../", async () => {/* ... */});
it("POST .../evidence/:evidenceId/confirm stamps confirmedBy + returns report", async () => {/* ... */});
it("POST .../confirm returns 404 when evidenceId is unknown", async () => {/* ... */});
it("GET .../evidence/file returns 403/404 when runId is not linked to this WorkItem", async () => {/* ... */});
it("POST .../confirm returns 404 when evidenceId belongs to another task", async () => {/* ... */});
it("routes go through x-issuepilot-project header or ?project= fallback in team mode", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- server
git add apps/orchestrator/src/server/index.ts \
        apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(orchestrator): expose V4.3 report.md + evidence + confirm routes"
```

---

## 任务 12：daemon evidence scan hook 与 team project-aware file routing

**文件：**

- 修改：`apps/orchestrator/src/daemon.ts`
- 修改：`apps/orchestrator/src/__tests__/daemon.test.ts`
- 修改：`apps/orchestrator/src/team/daemon.ts`
- 修改：`apps/orchestrator/src/team/__tests__/work-items.test.ts`

接线：

- 不再把 `workflow.workspace.root/.issuepilot/evidence` 当作全局 evidenceRoot。Evidence 文件在每个 task worktree 内，file route 必须通过 `TaskRunLink.runId -> RunReportArtifact.run.workspacePath` 找到真实 `taskWorktreePath`。
- single daemon 的 evidence scan hook 从 patched `RunReportArtifact.run.workspacePath` 调 `scanRunEvidence({ taskWorktreePath, runId })`。
- team daemon 对每个 project 使用对应 project 的 reportStore / WorkItemStore 解析 `runId`，并保持 project 隔离；`?project=<id>` 仅用于 `<img>` / `<video>` 等不能携带 header 的浏览器请求 fallback。
- service 在 `getReportMarkdown` 调用时把 `evidenceBaseHref = /api/work-items/:id/evidence/file?runId=<>&path=<>` 拼装给 renderer；team-mode 由 dashboard URL helper 追加 `project` query。
- **team dispatch scan hook 不在 V4.3 本任务内声明完成**：当前 team daemon 只有 project registry + server shell，尚无 synthetic task dispatch runner，`tick` 仍是 no-op。因此任务 12 只要求 team-mode 的 per-project `ReportStore` / `WorkItemStore` / aggregation deps / file route lookup 隔离。后续 team dispatch runner 落地时，必须在每个 project 的 dispatch closure 完成后复用 `scanRunEvidence` + `mergeReportEvidence` + `reportStore.save`。
- `WorkItemService` 接口与 daemon wiring 把 `getEvidenceConfirmations` 注入到 aggregator（service 内闭包从 `store.loadEvidenceConfirmations(workItemId)` 派生）。

- [ ] **步骤 1：daemon 测试**

```ts
it("single daemon scans evidence from RunReportArtifact.run.workspacePath", async () => {/* ... */});
it("team daemon scopes evidence file routing by project report store", async () => {/* ... */});
it("team daemon uses project-scoped report stores for work item aggregation", async () => {/* ... */});
it("team daemon documents that dispatch scan hook waits for team dispatch runner", async () => {/* ... */});
it("daemon wires getEvidenceConfirmations from store.loadEvidenceConfirmations into aggregate deps", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- 'daemon|team'
git add apps/orchestrator/src/daemon.ts \
        apps/orchestrator/src/__tests__/daemon.test.ts \
        apps/orchestrator/src/team/daemon.ts \
        apps/orchestrator/src/team/__tests__/work-items.test.ts
git commit -m "feat(orchestrator): wire V4.3 single-daemon evidence and team project reports"
```

---

## 任务 13：Dashboard API client 扩展

**文件：**

- 修改：`apps/dashboard/lib/api.ts`
- 修改：`apps/dashboard/lib/api.test.ts`

新增：

```ts
export function getWorkItemEvidence(
  id: string,
  opts?: ApiGetOptions,
): Promise<WorkItemEvidenceResponse>;

export function getWorkItemReportMarkdown(
  id: string,
  opts?: ApiGetOptions,
): Promise<string>;

export function confirmWorkItemTaskEvidence(
  id: string,
  taskId: string,
  evidenceId: string,
  opts?: OperatorActionOptions,
): Promise<ConfirmEvidenceResponse>;

export function buildEvidenceFileUrl(
  id: string,
  runId: string,
  relPath: string,
  opts?: { project?: string },
): string;
```

`buildEvidenceFileUrl` 注意 `relPath` 需要 `encodeURIComponent`，并在 team-mode 下附带 `project` query（因为 `<img>` / `<video>` 不能塞 `x-issuepilot-project` header；orchestrator 路由要在没有 header 时回退 query）。

- [ ] **步骤 1：api.test.ts 用例**

```ts
it("getWorkItemEvidence GETs /api/work-items/:id/evidence", async () => {/* ... */});
it("getWorkItemReportMarkdown GETs /api/work-items/:id/report.md and returns raw text/markdown", async () => {/* ... */});
it("confirmWorkItemTaskEvidence POSTs the correct path", async () => {/* ... */});
it("buildEvidenceFileUrl encodes relPath and appends project query in team mode", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/dashboard test -- api
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts
git commit -m "feat(dashboard): add V4.3 evidence + report.md client + URL helper"
```

> 注：实现完后，orchestrator 端要把 `evidence/file` 路由也接受 `?project=` 作为 header 的 fallback。这一项在任务 11 实现时已经加入，单测同步覆盖。

---

## 任务 14：Dashboard ConfidencePill 组件

**文件：**

- 新建：`apps/dashboard/components/work-items/confidence-pill.tsx`
- 新建：`apps/dashboard/components/work-items/confidence-pill.test.tsx`

行为：

- 接收 `confidence: WorkItemEvidenceConfidence`，渲染对应 i18n label + tone：
  - `ai-claim` → warning tone（黄）。
  - `system-derived` → info tone（蓝）。
  - `human-confirmed` → success tone（绿）。
- a11y：使用 `<span role="status">` + `aria-label="<localized label>"`。
- 不引入新 tone token；复用现有 Tailwind tokens（`bg-warning-soft text-warning-fg`等）。

- [ ] **步骤 1：组件测试**

```ts
it("renders 'AI 推断' label for ai-claim in zh locale", () => {/* ... */});
it("renders the success tone for human-confirmed", () => {/* ... */});
it("renders aria-label for screen readers", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/dashboard test -- confidence-pill
git add apps/dashboard/components/work-items/confidence-pill.tsx \
        apps/dashboard/components/work-items/confidence-pill.test.tsx
git commit -m "feat(dashboard): confidence pill for evidence entries"
```

---

## 任务 15：Dashboard HumanReviewChecklist 组件

**文件：**

- 新建：`apps/dashboard/components/work-items/human-review-checklist.tsx`
- 新建：`apps/dashboard/components/work-items/human-review-checklist.test.tsx`

行为：

- props: `{ items: HumanReviewChecklistItem[] }`。**V4.3 第一版 checklist 是 read-only**（spec §14.3 第一版：把 AI claim 暴露给 reviewer；人工确认仍走 evidence 级），所以**没有** `onConfirm` prop。
- 渲染列表，每项 `<li>`：`aria-checked="false"` checkbox 视觉 + label + 小字 `reason` i18n 描述。
- 列表顶部 `<p>` 提示「逐条 evidence 确认请到 Evidence 标签页」（i18n: `workItem.checklist.confirmHint`），引导用户到 evidence-tab confirm 按钮。
- a11y：`<ul role="list">`；视觉 checkbox 用 `<span role="checkbox" aria-checked="false">` 而非真实 input（避免误以为可点）。
- 第一版 `confirmed` 字段在 V4.3 总是 `false`（aggregator R3 决策），但组件仍然支持渲染 `confirmed: true`（带 `(confirmed by ... at ...)` 后缀）以便 V4.4 启用 checklist confirm 时无需改组件。

- [ ] **步骤 1：组件测试**

```ts
it("renders all items as unconfirmed [ ] in V4.3 (always confirmed=false from aggregator)", () => {/* ... */});
it("would render [x] with confirmedBy/At suffix if confirmed=true (future-proof for V4.4)", () => {/* ... */});
it("renders the localized hint pointing operators to the Evidence tab", () => {/* ... */});
it("renders the localized reason label for each checklist reason", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/dashboard test -- human-review-checklist
git add apps/dashboard/components/work-items/human-review-checklist.tsx \
        apps/dashboard/components/work-items/human-review-checklist.test.tsx
git commit -m "feat(dashboard): render WorkItemReport humanReviewChecklist"
```

---

## 任务 16：Dashboard EvidenceTab 组件

**文件：**

- 新建：`apps/dashboard/components/work-items/evidence-tab.tsx`
- 新建：`apps/dashboard/components/work-items/evidence-tab.test.tsx`

行为：

1. props：`{ workItemId, evidence: WorkItemEvidenceResponse, onConfirm: (taskId, evidenceId) => Promise<void> }`。
2. 顶部 selector：`All | Screenshots | Recordings | Playwright | Commands | Tests | Diff | Validation | Risk | CI | Review`。
3. 按 task 分组渲染卡片；每张卡片头部显示 `taskId / title / status`；内部按 kind 分 section。
4. `screenshot`：`<img src={buildEvidenceFileUrl(...)} className="max-h-60" alt={label}/>` + `ConfidencePill`。
5. `recording`：`<a href>` + 文件大小（如果 capturedAt 已提供则展示）。
6. `playwright`：`<a href>Open Playwright trace</a>` 提示「在本地用 `npx playwright show-trace` 打开」。
7. `command_output` / `test_result` / `validation` / `risk` 等：渲染 label + text/inline；带 `href` 时变链接。
8. 每条 evidence 旁有 `Confirm` 按钮（onConfirm 调用后乐观更新 confidence → `human-confirmed`，pill 立刻变色，失败时回滚）。
9. 缺失 evidence 的 task：渲染独立卡片 `Missing evidence — task <taskId> has a TaskRunLink but no report`。

- [ ] **步骤 1：组件测试**

```ts
it("groups entries by task and kind", () => {/* ... */});
it("renders <img> for screenshot entries with the orchestrator file URL", () => {/* ... */});
it("renders <a> for recordings / playwright", () => {/* ... */});
it("filters by kind via the top selector", () => {/* ... */});
it("calls onConfirm and optimistically renders the pill as human-confirmed", () => {/* ... */});
it("rolls back optimistic pill change when onConfirm rejects", () => {/* ... */});
it("renders the missing-evidence card for tasks in evidence.missing", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
pnpm --filter @issuepilot/dashboard test -- evidence-tab
git add apps/dashboard/components/work-items/evidence-tab.tsx \
        apps/dashboard/components/work-items/evidence-tab.test.tsx
git commit -m "feat(dashboard): EvidenceTab with kind filter + confirm action"
```

---

## 任务 17：ViewToggle 扩为三态 list | graph | evidence

**文件：**

- 修改：`apps/dashboard/components/work-items/view-toggle.tsx`
- 修改：`apps/dashboard/components/work-items/view-toggle.test.tsx`

`WorkItemView` 类型从 `"list" | "graph"` 扩为 `"list" | "graph" | "evidence"`；新增 `Evidence` 按钮；URL `?view=` 三态。

- [ ] **步骤 1：补三态测试**

```ts
it("reflects ?view=evidence", () => {/* ... */});
it("calls onChange('evidence') when the evidence button is clicked", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
git add apps/dashboard/components/work-items/view-toggle.tsx \
        apps/dashboard/components/work-items/view-toggle.test.tsx
git commit -m "feat(dashboard): three-state view toggle list/graph/evidence"
```

---

## 任务 18：work-item-detail 接入 EvidenceTab + Checklist

**文件：**

- 修改：`apps/dashboard/components/work-items/work-item-detail.tsx`
- 修改：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
- 修改：`apps/dashboard/components/work-items/parent-review-packet.tsx`
- 修改：`apps/dashboard/components/work-items/parent-review-packet.test.tsx`

行为：

1. `work-item-detail.tsx`：在 `planAccepted` 分支里把 `ViewToggle` 三态接好；`view === "evidence"` 时 fetch `getWorkItemEvidence` 并渲染 `EvidenceTab`；`onConfirm` → `confirmWorkItemTaskEvidence` + `reload()`。
2. `parent-review-packet.tsx`：
   - 顶部增加 `<HumanReviewChecklist items={report.humanReviewChecklist} />`（注意：组件不接收 `onConfirm`，read-only）。
   - Evidence section 的每条 entry 加 `<ConfidencePill confidence={entry.confidence} />`。
   - 删除内嵌 `renderMarkdown(report)` 以及对应的旧测试用例（不要留 dead code）；`Copy as Markdown` 按钮改为 `await getWorkItemReportMarkdown(workItemId)` 后写入剪贴板（保留 `document.execCommand("copy")` fallback）。

- [ ] **步骤 1：补测试**

```ts
// work-item-detail.test.tsx
it("fetches evidence when view=evidence", async () => {/* ... */});
it("passes onConfirm to EvidenceTab and reloads after confirm", async () => {/* ... */});

// parent-review-packet.test.tsx
it("renders HumanReviewChecklist when report.humanReviewChecklist is non-empty", () => {/* ... */});
it("renders ConfidencePill for each evidence entry", () => {/* ... */});
it("Copy as Markdown fetches /api/work-items/:id/report.md", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + commit**

```bash
git add apps/dashboard/components/work-items/work-item-detail.tsx \
        apps/dashboard/components/work-items/work-item-detail.test.tsx \
        apps/dashboard/components/work-items/parent-review-packet.tsx \
        apps/dashboard/components/work-items/parent-review-packet.test.tsx
git commit -m "feat(dashboard): wire V4.3 evidence tab + checklist + markdown export"
```

---

## 任务 19：i18n 补丁

**文件：**

- 修改：`apps/dashboard/i18n/messages/zh.json`
- 修改：`apps/dashboard/i18n/messages/en.json`

新增 keys（zh / en 必须同步）：

- `workItem.view.evidence`、`workItem.evidence.title`、`workItem.evidence.empty`、`workItem.evidence.missing`、`workItem.evidence.filter.all`、`workItem.evidence.filter.screenshot` / `.recording` / `.playwright` / `.commandOutput` / `.testResult` / `.diff` / `.validation` / `.risk` / `.ci` / `.review`。
- `workItem.evidence.confirmAction`、`workItem.evidence.confirmedBy`。
- `workItem.confidence.aiClaim`、`.systemDerived`、`.humanConfirmed`。
- `workItem.checklist.title`、`.empty`、`.reason.aiRiskMedium`、`.reason.aiRiskHigh`、`.reason.needsRework`、`.reason.partialOverall`、`.reason.missingEvidence`、`.reason.skippedTask`、`.reason.ciFailed`、`.confirmHint`、`.confirmAction`。
- `workItem.parentReviewPacket.copyFromServer`（用于失败回退提示）。

- [ ] **步骤 1：补全 keys，使所有组件测试不再报 missing key**

- [ ] **步骤 2：commit**

```bash
git add apps/dashboard/i18n/messages/zh.json apps/dashboard/i18n/messages/en.json
git commit -m "feat(dashboard): add V4.3 evidence + checklist i18n strings (zh + en)"
```

---

## 任务 20：V4.3 端到端

**文件：**

- 新建：`apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts`

按 spec §16.5 风格写四个 E2E case（共用 fake GitLab + fake Codex + 真 work-items store + 真 daemon wiring）：

1. **Evidence happy path**：plan 接受 → T1 / T2 各产出一个 RunReportArtifact + worktree 下放 1 张截图 / 1 个 playwright zip / 1 个 commands log → aggregate 后 `WorkItemReport.evidence.byTask.T1` 包含 4 类 entry（diff + screenshot + playwright + command_output）；`humanReviewChecklist` 至少有 1 条（risk-medium）；handoff note body（去掉 marker）等于 `renderWorkItemReportMarkdown(..., { audience: "gitlab" })`，`GET /api/work-items/<id>/report.md` 等于 `renderWorkItemReportMarkdown(..., { audience: "markdown" })`，两者核心章节一致。
2. **Confirm flow**：随便取一条 T1 的 screenshot evidence → `POST .../confirm` → 重新拉 `getEvidence` 期望 `confidence === "human-confirmed"`、`confirmedBy / confirmedAt` 写入；handoff note 重写后 evidence 行从 `(ai-claim)` 变 `(human-confirmed)`；emit 序列含 `work_item_evidence_confirmed` + `work_item_report_rendered`。
3. **Oversized + path traversal**：worktree 下放 1 个 51MB recording + 1 个 manifest 含 `relPath: "../../etc/passwd"` → aggregate 后 evidence 不包含这两条，`openQuestions` 暴露 `oversized` 提示，`evidence/file` 路由对 `path=../../etc/passwd` 返回 403。
4. **Missing evidence**：T2 dispatch 后 reportStore 故意丢失对应 report（模拟磁盘损坏）→ `getEvidence` 返回 `missing: [{ taskId: "T2", reason: "no-run-report" }]`；`humanReviewChecklist` 含 `reason: "missing-evidence"`；`WorkItemReport.overallStatus === "incomplete"`，handoff note 不输出 `human-review` 字样。

每个 case 都要断言：

- 没有调用 `gitlab.createIssue`（保留 V4.1 contract）。
- TaskRunLink 仍是唯一 task↔run binding。
- 父 Issue label 由 aggregator 路径写（V4.2 acceptance C2 仍然成立）。
- 渲染统一：`renderWorkItemReportMarkdown` 调用次数与 emit `work_item_report_rendered` 次数匹配。

- [ ] **步骤 1：写 E2E 测试 → 实现到通过**

> 注意：此任务必须在任务 4–18 完成之后做。

- [ ] **步骤 2：commit**

```bash
pnpm --filter @issuepilot/orchestrator test -- work-items-v43-e2e
git add apps/orchestrator/src/__tests__/work-items-v43-e2e.test.ts
git commit -m "test(orchestrator): V4.3 e2e (evidence, confirm, oversized, missing)"
```

---

## 任务 21：跨包 build + lint + typecheck + 全量测试

**目标：** 收口前的整仓库 gate，与 V4.1 / V4.2 收口任务等价。

- [ ] **步骤 1：build**

```bash
pnpm -r build
```

期望全部 PASS；任何 TS error 必须修复，不要禁用 strict。

- [ ] **步骤 2：lint**

```bash
pnpm -r lint -- --max-warnings 0
```

- [ ] **步骤 3：test**

```bash
pnpm -r test -- --maxWorkers=1 --minWorkers=1
```

记录测试数：V4.2 已有 orchestrator 448 + tests/e2e 51；V4.3 至少新增 ~70+ 用例，预计 orchestrator ≥ 510、e2e ≥ 55。

- [ ] **步骤 4：diff 卫生**

```bash
git diff --check
```

---

## 任务 22：文档 + CHANGELOG + acceptance

**文件：**

- 修改：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- 修改：`README.md`
- 修改：`README.zh-CN.md`
- 修改：`USAGE.md`
- 修改：`USAGE.zh-CN.md`
- 修改：`CHANGELOG.md`
- 新建：`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence-acceptance.md`

按 `AGENTS.md`：中文文档 + 双语入口同步；命令 / 配置 / 字段保持原文。

- [ ] **步骤 1：spec 实施计划段加 V4.3 链接**

```markdown
- V4.3 Review Packet + Evidence：`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`
```

- [ ] **步骤 2：README.md + README.zh-CN.md roadmap**

在 V4.2 条目下加 V4.3 已落地条目，包含：evidence kinds、AI vs human confirmation、统一 markdown 渲染、EvidenceTab、Human review checklist。

- [ ] **步骤 3：USAGE 增加 §5.9**

英文 + 中文同步，包含：

1. worktree evidence 目录约定（5 个子目录 + manifest.json + 大小限制）。
2. dashboard 上 `?view=evidence` 入口与 kind 过滤器。
3. Human review checklist 出现条件与确认方式（在 evidence tab 上单条 confirm）。
4. Markdown export：`/api/work-items/:id/report.md` + dashboard `Copy as Markdown`。
5. team-mode：evidence 文件链接通过 `?project=<id>` query 透传。

- [ ] **步骤 4：CHANGELOG.md**

```markdown
## [Unreleased] V4.3 Review Packet + Evidence

- 数据模型：`WorkItemEvidenceEntry.kind` 增加 `screenshot/recording/playwright/command_output/test_result`，新增 `confidence` 三态、`evidenceId`、`source`、`confirmedBy/At` 字段；`RunReportArtifact.evidence` 新增可选数组；`WorkItemReport` 增加 `humanReviewChecklist`、`ciSummary`、`testSummary`。
- 事件：新增 `work_item_evidence_indexed` / `work_item_evidence_confirmed` / `work_item_report_rendered`。
- orchestrator：task worktree `.issuepilot/evidence/<runId>/` 目录约定 + manifest 优先 + 50MB 安全上限；evidence scanner 接入 daemon-level dispatch closure；aggregate 派生 checklist + CI/test summary；新增统一 markdown renderer，GitLab handoff note 与 dashboard markdown export 共用同一渲染源；新增 `GET /api/work-items/:id/report.md`、`GET /api/work-items/:id/evidence`、受限静态 `GET /api/work-items/:id/evidence/file`、`POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm` 路由；team daemon 按 project 独立解析 task worktree。
- dashboard：新增 `Evidence` 视图（list/graph/evidence 三态切换），按 task / kind 分组渲染图片缩略图 / 录屏 / playwright / 命令输出 / 测试结果；新增 `ConfidencePill` 与 `HumanReviewChecklist`；`Copy as Markdown` 改为请求 orchestrator 同源 markdown。
- 不变量保持：父 Issue label / handoff note 仍只由 aggregator 经 `decideWorkItemStatus` + `writeParentHandoff` 写入；TaskRunLink 仍是唯一 canonical task↔run binding；synthetic task run `parentIssueLabelMode === "suppressed"`；不创建 child GitLab Issue；evidence 文件不离开 worktree。
```

- [ ] **步骤 5：落 acceptance 文档**

`docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence-acceptance.md`：与 V4.2 acceptance 同源，列出本计划末尾的验收清单 + 对应证据文件路径。

- [ ] **步骤 6：commit**

```bash
git add docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md \
        README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md CHANGELOG.md \
        docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence-acceptance.md
git commit -m "docs: announce V4.3 Review Packet + Evidence landing"
```

---

## 任务 23（验收）：V4.3 验收检查清单

**目标：** 在 PR 描述里附上下面的自检清单，对应 spec §7 V4.3 + §14.3 + §14.4 + §15。

- [ ] **新的 5 类 evidence kind 全部被 aggregator 派生**：单测 + E2E 至少各覆盖一次 `screenshot` / `recording` / `playwright` / `command_output` / `test_result`。
- [ ] **evidence 来源契约**：task worktree `.issuepilot/evidence/<runId>/` 目录扫描 + manifest 优先 + 50MB / path-traversal 安全上限（scanner 单测 + evidence-file-server 单测 + E2E §oversized）。
- [ ] **AI vs human 区分**：`WorkItemEvidenceEntry.confidence` 三态，dashboard `ConfidencePill` 三色；`POST .../confirm` 把 `ai-claim` 升级为 `human-confirmed` 并触发 aggregator 重算（E2E §confirm 覆盖）。
- [ ] **evidenceId 稳定性**：retry / replan / re-aggregate 后同一物理 evidence 的 `evidenceId` 不变（`<taskId>:<kind>:<runId>:<base64url(sha1(seed))>`），E2E §confirm + §missing 覆盖。
- [ ] **aggregator breaking change 已传递**：`aggregateWorkItem` 返回 `AggregateResult { report, missing }`；所有 caller（reconcile.ts / service.ts / e2e）均已更新且 V4.1/V4.2 行为不退化。
- [ ] **统一渲染**：handoff note body、`GET /api/work-items/:id/report.md`、dashboard `Copy as Markdown` 三处共用 renderer；除 audience-specific 标题 / 导出提示外核心章节一致（render-report 单测 + handoff 同源单测 + E2E happy path）。
- [ ] **Human review checklist**：medium/high risk、`needs_rework`、`skipped` 任务、`partial` overall、缺失 evidence、CI failed 七种 reason 都能触发 checklist 项；dashboard 顶部渲染。**第一版 read-only**：所有项 `confirmed: false`，没有 checklist confirm endpoint；人工确认走 evidence 级。
- [ ] **CI + 测试 summary**：`ciSummary.overall` 等于最差 task CI 状态；`testSummary.passed/failed/skipped/unknown` 由 `report.checks[]` 派生。
- [ ] **Dashboard 三态视图**：`?view=list|graph|evidence` 通过 URL 持久化；`EvidenceTab` 支持 kind filter + 单条 confirm。
- [ ] **Markdown export 路由 + evidence file 路由**：404 / 403 / 413 错误码覆盖；team-mode 通过 `?project=` query 透传。
- [ ] **全量 `pnpm -r build` / `pnpm -r lint` / `pnpm -r test` 通过；`git diff --check` 干净**。
- [ ] **文档 + CHANGELOG + acceptance 已更新**。
- [ ] **V4.1 / V4.2 task execution contract 仍然成立**：
  - Fake GitLab `createIssue` 调用次数为 0。
  - TaskRunLink 仍是唯一 canonical binding。
  - synthetic task run `parentIssueLabelMode === "suppressed"`。
  - 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - 不创建 child GitLab Issue。
- [ ] **不引入图片缩略图生成器 / 视频转码器 / Playwright viewer 二进制**（验收时检查依赖图）。

---

## 不变量回顾

- V4.3 不能因为引入新 evidence kind 或统一渲染器而退化 V4.1/V4.2 已固化的不变量：
  - 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - TaskRunLink 是唯一 canonical task↔run binding。
  - synthetic task run `parentIssueLabelMode === "suppressed"`。
  - 不创建 child GitLab Issue。
- Evidence 文件留在 worktree；orchestrator 静态服务严格沙箱化，禁止跨 runId / 跨 workItem / 跨 project 访问。
- `humanReviewChecklist` 仅是 advisory；**第一版 read-only**（aggregator 永远输出 `confirmed: false`，没有 confirm endpoint）；不驱动父 Issue label 转换；checklist 状态也不会触发 `ready_to_merge`。人工确认全部走 evidence 级 `POST .../evidence/:evidenceId/confirm`。
- aggregate 必须保持 deterministic：相同输入 ↔ 相同 evidence ordering ↔ 相同 markdown 输出，保证测试与 PR diff 稳定。
- evidence size 上限 50MB 仅是 V4.3 第一版的 dashboard 保护值，未来 V4.4 / V3 引入对象存储后可放宽，但 path-traversal 校验永远不能放宽。

## 后续阶段（不在本计划范围）

- V4.4 Quality Analytics：基于 humanReviewChecklist / confirm 率 / oversized 触发率出趋势指标。
- V4.5 Workflow / Skills Improvement Loop：把「频繁出现 missing-evidence 的 task / workflow」反馈为 prompt / skill 改进建议。
- V4.6 Multi-Agent / Multi-Runner Collaboration：evidence 来源扩展到 reviewer agent、test agent。
- V3：把 evidence 持久化迁移到对象存储 + 引入 Postgres，把 50MB 大小限制放宽并改用流式上传。
