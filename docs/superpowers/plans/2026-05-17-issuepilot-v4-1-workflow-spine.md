# IssuePilot V4.1 Workflow Spine 实施计划

Phase：V4 Phase 1
状态：待评审
对应 spec：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`（§7 V4.1 Workflow Spine、§9 数据模型、§11 主流程、§16 测试策略、§17 V4.1 验收标准）
依赖：V2.5 Command Center（`docs/superpowers/plans/2026-05-16-issuepilot-v25-command-center.md`，已合入），V2 Phase 1 团队运行时底座（`docs/superpowers/plans/2026-05-15-issuepilot-v2-team-runtime-foundation.md`，已合入）
下一步：V4.2 Task Graph（依赖图执行、局部重试、回退重规划）

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 在现有 V2.x runtime 上叠加一层 Workflow Intelligence Layer，让 IssuePilot 能从一个 GitLab 大 Issue 走完“拆解 → operator 接受 plan → 多个子任务 run → 汇总报告”的端到端最小闭环，并满足 V4.1 验收标准。

**架构：** 保留现有 V2.x runtime（claim、dispatch、reconcile、reports、events）不动，新增 `apps/orchestrator/src/work-items/` 域，承担 Issue 拆解、TaskPlan 状态机、synthetic task run 编排、`WorkItemReport` 汇总和父 Issue 统一 handoff。父 GitLab Issue 仍是唯一 tracker source of truth；synthetic task run 复用现有 runner/workspace/reports，但通过显式 flag 绕过 per-run 父 Issue label writer。Dashboard 在现有指挥中心旁新增 Work Items 路由和 Parent Review Packet。

**技术栈：** TypeScript、Node.js 22、Fastify、Vitest、Next.js App Router、React、Tailwind/shadcn-style 组件、`@issuepilot/shared-contracts`、Codex app-server（通过 `@issuepilot/runner-codex-app-server`）、GitLab REST（通过 `@issuepilot/tracker-gitlab`）。

---

## 范围检查

V4 spec 包含 6 个能力阶段（V4.1–V4.6）。本计划只覆盖 **V4.1 Workflow Spine**。

本计划明确**不做**：

- V4.2 Task Graph（`blocks` / `can_parallelize_with`、推荐执行顺序、局部重试 UI、回退重规划）。本计划只支持 `dependsOn=[]` 的独立任务自动进入 `ready`，依赖未完成的任务保持 `blocked_by_dependency` 并等待 operator。
- V4.3 Review Packet + Evidence 的截图 / 录屏 / Playwright walkthrough 自动索引。本计划只聚合现有 `RunReportArtifact` 中的 diff / validation / risks / CI / review feedback 到 `WorkItemReport`。
- V4.4 Quality Analytics、V4.5 Workflow / Skills Improvement Loop、V4.6 Multi-Agent / Multi-Runner。
- 不引入 child GitLab Issue（spec V4.1 task execution contract）。
- 不引入 Postgres、登录、RBAC、生产 worker、自动 merge（V3 范围）。

下面所有任务都遵守 V4.1 Task execution contract（spec §7.V4.1）：

1. **不创建 child GitLab Issue**；synthetic task run 通过 `parentIssueLabelMode: "suppressed"` 绕过 per-run 父 Issue label writer 和 workpad handoff。
2. **每 task 一 branch / worktree**，base 是 workflow `base_branch`，branch 形态为 `<branch_prefix>/<iid>-<task-slug>`。
3. **每 task 一个独立 MR**，不在 V4.1 合并多个 task MR。
4. **TaskRunLink 是 task ↔ run 的 canonical binding**，不靠 branch 反推。
5. **父 Issue label / handoff note 由 WorkItem 聚合阶段统一写入**，per-task run 不直接改父 Issue label。

## 文件结构

新建：

- `packages/shared-contracts/src/work-item.ts`：`WorkItem` / `TaskPlan` / `TaskNode` / `TaskRunLink` / `WorkItemReport` 类型、状态枚举、type guard、JSON round-trip helpers。
- `packages/shared-contracts/src/__tests__/work-item.test.ts`：状态枚举、必填字段、JSON round-trip、guard 覆盖。
- `apps/orchestrator/src/work-items/store.ts`：file-backed JSON store，写入 `~/.issuepilot/work-items/`、`task-plans/`、`task-run-links/`、`work-item-reports/`。
- `apps/orchestrator/src/work-items/__tests__/store.test.ts`：覆盖 round-trip、index `taskIds`/`runIds`、并发写、缺失文件。
- `apps/orchestrator/src/work-items/plan-validation.ts`：拆解校验（2–5 任务、`dependsOn` 不能形成环、任务标题必填、`taskId` 唯一、`riskLevel` 合法）。
- `apps/orchestrator/src/work-items/__tests__/plan-validation.test.ts`。
- `apps/orchestrator/src/work-items/planner.ts`：`WorkItemPlanner` 接口、`createCodexPlanner` 默认实现（通过现有 runner 调用一次 LLM 让其输出 JSON），统一处理 `planning_failed`。
- `apps/orchestrator/src/work-items/__tests__/planner.test.ts`：用 fake LLM 覆盖成功、JSON 解析失败、超出 2-5 任务、缺验收标准。
- `apps/orchestrator/src/work-items/orchestration.ts`：从 accepted `TaskPlan` 派生 ready `TaskNode`、触发 synthetic task run、监听 run 完成事件、写 `TaskRunLink`、推进 `TaskNode` 状态。
- `apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`：覆盖独立任务并发触发、`dependsOn` blocking、失败/blocked 分支不影响其它任务、重复触发幂等。
- `apps/orchestrator/src/work-items/aggregate.ts`：从所有 `TaskRunLink` + `RunReportArtifact` 聚合出 `WorkItemReport`，决策 `complete` / `partial` / `incomplete`。
- `apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`：覆盖全部成功、部分失败、缺失 report 情况、`recommendedNextActions` 文案。
- `apps/orchestrator/src/work-items/handoff.ts`：渲染父 Issue 级 handoff note Markdown、决定何时切 `human-review`，绑定唯一 marker `<!-- issuepilot:work-item:<id> -->`。
- `apps/orchestrator/src/work-items/__tests__/handoff.test.ts`：完整 / 部分 / 不完整三种情况的 note 内容、label transition 调用集。
- `apps/orchestrator/src/work-items/dispatch-task.ts`：对接 V2.x dispatch 的薄壳，给 `dispatch()` 注入 `parentIssueLabelMode: "suppressed"`、task-aware branch / prompt vars。
- `apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`。
- `apps/dashboard/app/work-items/page.tsx`：Work Items 列表路由。
- `apps/dashboard/app/work-items/[id]/page.tsx`：Work Item detail 路由（Plan editor + Task list + Parent Review Packet）。
- `apps/dashboard/components/work-items/work-items-list.tsx`。
- `apps/dashboard/components/work-items/work-items-list.test.tsx`。
- `apps/dashboard/components/work-items/work-item-detail.tsx`。
- `apps/dashboard/components/work-items/work-item-detail.test.tsx`。
- `apps/dashboard/components/work-items/plan-editor.tsx`：接受 / 编辑 / 重新生成 plan 的客户端组件。
- `apps/dashboard/components/work-items/plan-editor.test.tsx`。
- `apps/dashboard/components/work-items/task-list.tsx`：V4.1 用分组列表展示 task 状态。
- `apps/dashboard/components/work-items/task-list.test.tsx`。
- `apps/dashboard/components/work-items/parent-review-packet.tsx`。
- `apps/dashboard/components/work-items/parent-review-packet.test.tsx`。
- `apps/orchestrator/src/__tests__/work-items-e2e.test.ts`：fake GitLab + fake Codex + 真 work-items store 的端到端测试。

修改：

- `packages/shared-contracts/src/index.ts`：导出 work-item 契约。
- `packages/shared-contracts/src/events.ts`：新增 V4.1 事件类型（见 Task 2）。
- `packages/shared-contracts/src/api.ts`：增加 work-item REST 响应类型。
- `apps/orchestrator/src/reports/render.ts`：暴露一个 reusable `renderTaskFailureSection` / `renderTaskSummarySection` 供 `aggregate.ts` 复用，避免重复 markdown 拼接。
- `apps/orchestrator/src/orchestrator/reconcile.ts`：新增 `parentIssueLabelMode: "active" | "suppressed"`，在 `suppressed` 模式下跳过 `transitionLabels(iid, …)` 和 `findWorkpadNote`/`createNote`/`updateNote` 对父 Issue 的写入；仍写 MR、push 分支、保存 report。
- `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`：覆盖 `suppressed` 模式不调父 Issue label/note 写入但 MR 行为不变。
- `apps/orchestrator/src/daemon.ts`：装配 work-items store、planner、orchestration、aggregate、handoff，并把 synthetic task run 走 dispatch-task 路径，监听其完成事件并触发聚合 / handoff。
- `apps/orchestrator/src/server/index.ts`：新增 work-item 路由（见 Task 12）；保持现有 `/api/runs`、`/api/state`、`/api/reports` 兼容。
- `apps/orchestrator/src/server/__tests__/server.test.ts`：覆盖 work-item 路由。
- `apps/dashboard/lib/api.ts`：增加 `planWorkItem`、`getWorkItem`、`listWorkItems`、`acceptWorkItemPlan`、`regenerateWorkItemPlan`、`skipTask`、`retryTask`、`getWorkItemReport`。
- `apps/dashboard/lib/api.test.ts`：覆盖新方法 URL / header / body 形状。
- `apps/dashboard/components/shell/top-bar.tsx`：在主导航中新增 `Work Items` 入口。
- `apps/dashboard/i18n/messages/zh.json` / `en.json`：新增 work-items / plan editor / parent review packet i18n。
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`：在实现 land 后写入对应 plan 链接。
- `README.md` / `README.zh-CN.md`：在 roadmap 中注明 V4.1 能力。
- `USAGE.md` / `USAGE.zh-CN.md`：新增 `Plan work item` 操作说明。
- `CHANGELOG.md`：按 user rule「每次修改后 记录到 CHANGELOG.md」分段记录。

---

## 任务 1：共享 Work Item 契约

**文件：**

- 新建：`packages/shared-contracts/src/work-item.ts`
- 新建：`packages/shared-contracts/src/__tests__/work-item.test.ts`
- 修改：`packages/shared-contracts/src/index.ts`

按 spec §9.0/9.1/9.2/9.3/9.4/9.5 固定状态枚举和必填字段，避免后续 package 各自定义。

- [ ] **步骤 1：写失败的契约测试**

在 `packages/shared-contracts/src/__tests__/work-item.test.ts` 写：

```ts
import { describe, expect, it } from "vitest";

import {
  WORK_ITEM_STATUS_VALUES,
  TASK_PLAN_STATUS_VALUES,
  TASK_NODE_STATUS_VALUES,
  WORK_ITEM_REPORT_STATUS_VALUES,
  isWorkItemStatus,
  isTaskNodeStatus,
  type WorkItem,
  type TaskPlan,
  type TaskNode,
  type TaskRunLink,
  type WorkItemReport,
} from "../work-item.js";

describe("work-item contracts", () => {
  it("locks the WorkItem status enum", () => {
    expect([...WORK_ITEM_STATUS_VALUES]).toEqual([
      "planning",
      "ready",
      "running",
      "partial",
      "completed",
      "blocked",
    ]);
  });

  it("locks the TaskPlan status enum", () => {
    expect([...TASK_PLAN_STATUS_VALUES]).toEqual([
      "draft",
      "accepted",
      "rejected",
      "superseded",
    ]);
  });

  it("locks the TaskNode status enum", () => {
    expect([...TASK_NODE_STATUS_VALUES]).toEqual([
      "planned",
      "blocked_by_dependency",
      "ready",
      "running",
      "completed",
      "failed",
      "blocked",
      "needs_rework",
      "skipped",
    ]);
  });

  it("locks the WorkItemReport status enum", () => {
    expect([...WORK_ITEM_REPORT_STATUS_VALUES]).toEqual([
      "draft",
      "partial",
      "complete",
      "incomplete",
    ]);
  });

  it("narrows unknown values with isWorkItemStatus", () => {
    expect(isWorkItemStatus("running")).toBe(true);
    expect(isWorkItemStatus("done")).toBe(false);
  });

  it("requires identifier / source / status on WorkItem", () => {
    const wi: WorkItem = {
      workItemId: "wi_01",
      sourceIssue: { projectId: "g/p", iid: 42, url: "https://gl/-/issues/42", title: "Big" },
      title: "Big",
      goal: "Ship",
      acceptanceCriteria: ["AC1", "AC2"],
      status: "ready",
      taskIds: ["t1", "t2"],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:01.000Z",
    };
    const cloned: WorkItem = JSON.parse(JSON.stringify(wi));
    expect(cloned).toEqual(wi);
  });

  it("requires version + accepted timestamp wiring on TaskPlan", () => {
    const plan: TaskPlan = {
      planId: "tp_01",
      workItemId: "wi_01",
      version: 1,
      tasks: [],
      dependencies: [],
      operatorEdits: [],
      status: "accepted",
      acceptedAt: "2026-05-17T00:00:02.000Z",
    };
    expect(plan.status).toBe("accepted");
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("guards TaskNode status", () => {
    expect(isTaskNodeStatus("blocked_by_dependency")).toBe(true);
    expect(isTaskNodeStatus("queued")).toBe(false);
  });

  it("requires canonical TaskRunLink binding", () => {
    const link: TaskRunLink = {
      taskId: "t1",
      runId: "run_aaa",
      attempt: 1,
      status: "completed",
      reportId: "run_aaa",
      branch: "ai/42-task-1",
      startedAt: "2026-05-17T00:00:00.000Z",
      completedAt: "2026-05-17T00:01:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(link))).toEqual(link);
  });

  it("requires WorkItemReport summaries plus evidence index", () => {
    const report: WorkItemReport = {
      workItemId: "wi_01",
      overallStatus: "complete",
      taskSummaries: [],
      validationSummary: "All tests green",
      riskSummary: "No high risks",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: ["Reviewer to look at merged tasks"],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

运行 `pnpm --filter @issuepilot/shared-contracts test -- work-item`。
期望：`Cannot find module '../work-item.js'`。

- [ ] **步骤 3：实现 `work-item.ts`**

在 `packages/shared-contracts/src/work-item.ts`：

```ts
export const WORK_ITEM_STATUS_VALUES = [
  "planning",
  "ready",
  "running",
  "partial",
  "completed",
  "blocked",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUS_VALUES)[number];
export const isWorkItemStatus = (v: unknown): v is WorkItemStatus =>
  typeof v === "string" &&
  (WORK_ITEM_STATUS_VALUES as readonly string[]).includes(v);

export const TASK_PLAN_STATUS_VALUES = [
  "draft",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type TaskPlanStatus = (typeof TASK_PLAN_STATUS_VALUES)[number];

export const TASK_NODE_STATUS_VALUES = [
  "planned",
  "blocked_by_dependency",
  "ready",
  "running",
  "completed",
  "failed",
  "blocked",
  "needs_rework",
  "skipped",
] as const;
export type TaskNodeStatus = (typeof TASK_NODE_STATUS_VALUES)[number];
export const isTaskNodeStatus = (v: unknown): v is TaskNodeStatus =>
  typeof v === "string" &&
  (TASK_NODE_STATUS_VALUES as readonly string[]).includes(v);

export const WORK_ITEM_REPORT_STATUS_VALUES = [
  "draft",
  "partial",
  "complete",
  "incomplete",
] as const;
export type WorkItemReportStatus =
  (typeof WORK_ITEM_REPORT_STATUS_VALUES)[number];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface SourceIssueRef {
  projectId: string;
  iid: number;
  url: string;
  title: string;
}

export interface WorkItem {
  workItemId: string;
  sourceIssue: SourceIssueRef;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  status: WorkItemStatus;
  taskIds: string[];
  summaryReportId?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskNode {
  taskId: string;
  title: string;
  goal: string;
  scope: string;
  nonGoals?: string[];
  dependsOn: string[];
  suggestedValidation: string[];
  status: TaskNodeStatus;
  runIds: string[];
  riskLevel: RiskLevel;
  /** Operator-visible reason when status leaves `ready`. */
  statusReason?: string;
}

export interface TaskPlanEdit {
  taskId: string;
  field: "title" | "goal" | "scope" | "dependsOn" | "suggestedValidation";
  before: unknown;
  after: unknown;
  by: string;
  at: string;
}

export interface TaskPlan {
  planId: string;
  workItemId: string;
  version: number;
  tasks: TaskNode[];
  dependencies: Array<{ from: string; to: string }>;
  operatorEdits: TaskPlanEdit[];
  status: TaskPlanStatus;
  acceptedAt?: string;
  rejectedReason?: string;
}

export interface TaskRunLink {
  taskId: string;
  runId: string;
  attempt: number;
  status: TaskNodeStatus;
  reportId?: string;
  branch: string;
  mergeRequest?: { iid: number; url?: string };
  startedAt: string;
  completedAt?: string;
}

export interface WorkItemEvidenceEntry {
  taskId: string;
  kind: "diff" | "validation" | "risk" | "ci" | "review_feedback";
  label: string;
  href?: string;
  text?: string;
}

export interface WorkItemReport {
  workItemId: string;
  overallStatus: WorkItemReportStatus;
  taskSummaries: Array<{
    taskId: string;
    title: string;
    taskStatus: TaskNodeStatus;
    runId?: string;
    diffSummary?: string;
    validation: string[];
    risks: Array<{ level: RiskLevel; text: string }>;
    followUps: string[];
    mergeRequestUrl?: string;
    ciStatus?: string;
    nextAction?: string;
  }>;
  validationSummary: string;
  riskSummary: string;
  evidence: {
    index: WorkItemEvidenceEntry[];
    byTask: Record<string, WorkItemEvidenceEntry[]>;
  };
  openQuestions: string[];
  recommendedNextActions: string[];
  generatedAt: string;
}
```

- [ ] **步骤 4：导出**

在 `packages/shared-contracts/src/index.ts` 追加 `export * from "./work-item.js";`。

- [ ] **步骤 5：跑测试确认通过**

`pnpm --filter @issuepilot/shared-contracts test`。期望全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/shared-contracts/src/work-item.ts \
        packages/shared-contracts/src/__tests__/work-item.test.ts \
        packages/shared-contracts/src/index.ts
git commit -m "feat(shared-contracts): add V4.1 work item / task plan contracts"
```

---

## 任务 2：V4.1 事件类型扩展

**文件：**

- 修改：`packages/shared-contracts/src/events.ts`
- 修改：`packages/shared-contracts/src/__tests__/events.test.ts`（若不存在则新建）

V4.1 新增事件覆盖：work item 生命周期、planning、operator action、task run 边界、aggregation、parent handoff。

- [ ] **步骤 1：写失败的事件枚举测试**

在 `packages/shared-contracts/src/__tests__/events.test.ts` 追加：

```ts
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPE_VALUES,
  isEventType,
} from "../events.js";

describe("V4.1 work item events", () => {
  const expected = [
    "work_item_created",
    "work_item_plan_drafted",
    "work_item_plan_accepted",
    "work_item_plan_rejected",
    "work_item_plan_regenerated",
    "work_item_planning_failed",
    "task_run_dispatched",
    "task_run_completed",
    "task_run_failed",
    "task_run_skipped",
    "task_run_blocked_by_dependency",
    "work_item_aggregated",
    "work_item_handoff_written",
  ];

  it.each(expected)("registers %s", (type) => {
    expect((EVENT_TYPE_VALUES as readonly string[]).includes(type)).toBe(true);
    expect(isEventType(type)).toBe(true);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

`pnpm --filter @issuepilot/shared-contracts test -- events`。期望 13 个 `expected ... to be true`。

- [ ] **步骤 3：扩 `EVENT_TYPE_VALUES`**

在 `packages/shared-contracts/src/events.ts` 文件最末尾，在 `] as const;` 之前追加 V4.1 分组：

```ts
  // V4.1 work item lifecycle
  "work_item_created",
  "work_item_plan_drafted",
  "work_item_plan_accepted",
  "work_item_plan_rejected",
  "work_item_plan_regenerated",
  "work_item_planning_failed",
  // V4.1 synthetic task runs
  "task_run_dispatched",
  "task_run_completed",
  "task_run_failed",
  "task_run_skipped",
  "task_run_blocked_by_dependency",
  // V4.1 aggregation + parent handoff
  "work_item_aggregated",
  "work_item_handoff_written",
```

- [ ] **步骤 4：跑测试确认通过**

`pnpm --filter @issuepilot/shared-contracts test`。

- [ ] **步骤 5：提交**

```bash
git add packages/shared-contracts/src/events.ts \
        packages/shared-contracts/src/__tests__/events.test.ts
git commit -m "feat(shared-contracts): register V4.1 work item event types"
```

---

## 任务 3：共享 API 契约（work item REST）

**文件：**

- 修改：`packages/shared-contracts/src/api.ts`
- 新建：`packages/shared-contracts/src/__tests__/api-work-item.test.ts`

声明 dashboard 与 orchestrator 共享的 HTTP 响应形状。

- [ ] **步骤 1：写失败的 API 类型测试**

```ts
import { describe, expect, it } from "vitest";

import type {
  WorkItemsListResponse,
  WorkItemDetailResponse,
  PlanWorkItemRequest,
  AcceptWorkItemPlanRequest,
  WorkItemReportResponse,
} from "../api.js";

describe("V4.1 API contracts", () => {
  it("WorkItemsListResponse exposes work items + counts", () => {
    const r: WorkItemsListResponse = {
      workItems: [],
      counters: {
        planning: 0,
        ready: 0,
        running: 0,
        partial: 0,
        completed: 0,
        blocked: 0,
      },
    };
    expect(r.counters.planning).toBe(0);
  });

  it("WorkItemDetailResponse exposes nested plan + tasks + runs", () => {
    const r: WorkItemDetailResponse = {
      workItem: {} as any,
      plan: { current: {} as any, history: [] },
      tasks: [],
      runLinks: [],
      report: undefined,
    };
    expect(r.plan.history).toEqual([]);
  });

  it("PlanWorkItemRequest carries the source issue iid", () => {
    const req: PlanWorkItemRequest = { iid: 42, regenerate: false };
    expect(req.iid).toBe(42);
  });

  it("AcceptWorkItemPlanRequest carries edits", () => {
    const req: AcceptWorkItemPlanRequest = {
      planId: "tp_01",
      edits: [],
      operator: "user",
    };
    expect(req.operator).toBe("user");
  });

  it("WorkItemReportResponse round-trips", () => {
    const r: WorkItemReportResponse = { report: undefined };
    expect(r.report).toBeUndefined();
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

`pnpm --filter @issuepilot/shared-contracts test -- api-work-item`。

- [ ] **步骤 3：实现 API 类型**

在 `packages/shared-contracts/src/api.ts` 文件底部追加：

```ts
import type {
  WorkItem,
  WorkItemStatus,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItemReport,
} from "./work-item.js";

export interface WorkItemsListResponse {
  workItems: WorkItem[];
  counters: Record<WorkItemStatus, number>;
}

export interface WorkItemDetailResponse {
  workItem: WorkItem;
  plan: { current: TaskPlan; history: TaskPlan[] };
  tasks: TaskNode[];
  runLinks: TaskRunLink[];
  report?: WorkItemReport;
}

export interface PlanWorkItemRequest {
  iid: number;
  regenerate?: boolean;
}

export interface AcceptWorkItemPlanRequest {
  planId: string;
  edits: Array<{
    taskId: string;
    field: "title" | "goal" | "scope" | "dependsOn" | "suggestedValidation";
    after: unknown;
  }>;
  operator: string;
}

export interface WorkItemReportResponse {
  report?: WorkItemReport;
}
```

- [ ] **步骤 4：跑测试确认通过 + 提交**

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/api.ts \
        packages/shared-contracts/src/__tests__/api-work-item.test.ts
git commit -m "feat(shared-contracts): add V4.1 work item REST response types"
```

---

## 任务 4：Work Item Store（file-backed JSON）

**文件：**

- 新建：`apps/orchestrator/src/work-items/store.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/store.test.ts`

参考 `apps/orchestrator/src/reports/store.ts` 的 in-memory + JSON file 范式。Store 必须把 `taskIds`/`runIds` 索引保存在内存里，但 canonical 落地路径按 spec §10：

```text
work-items/<workItemId>.json
task-plans/<planId>.json
task-run-links/<taskId>/<runId>.json
work-item-reports/<workItemId>.json
```

- [ ] **步骤 1：写失败的 store 测试**

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkItemStore } from "../store.js";

const baseIssue = {
  projectId: "g/p",
  iid: 42,
  url: "https://gl/-/issues/42",
  title: "Big issue",
};

describe("WorkItemStore", () => {
  it("persists WorkItem JSON under work-items/<id>.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-store-"));
    const store = createWorkItemStore({ rootDir: dir });
    await store.saveWorkItem({
      workItemId: "wi_01",
      sourceIssue: baseIssue,
      title: "Big issue",
      goal: "ship",
      acceptanceCriteria: ["AC1"],
      status: "planning",
      taskIds: [],
      createdAt: "t",
      updatedAt: "t",
    });
    const body = await readFile(
      join(dir, "work-items", "wi_01.json"),
      "utf8",
    );
    expect(JSON.parse(body).workItemId).toBe("wi_01");
  });

  it("looks up by workItemId after fs round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-store-"));
    const a = createWorkItemStore({ rootDir: dir });
    await a.saveWorkItem({
      workItemId: "wi_01",
      sourceIssue: baseIssue,
      title: "T",
      goal: "G",
      acceptanceCriteria: [],
      status: "planning",
      taskIds: [],
      createdAt: "t",
      updatedAt: "t",
    });
    const b = createWorkItemStore({ rootDir: dir });
    const loaded = await b.getWorkItem("wi_01");
    expect(loaded?.title).toBe("T");
  });

  it("stores TaskRunLink under task-run-links/<taskId>/<runId>.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-store-"));
    const store = createWorkItemStore({ rootDir: dir });
    await store.saveTaskRunLink({
      taskId: "t1",
      runId: "run_x",
      attempt: 1,
      status: "running",
      branch: "ai/42-task-1",
      startedAt: "t",
    });
    const body = await readFile(
      join(dir, "task-run-links", "t1", "run_x.json"),
      "utf8",
    );
    expect(JSON.parse(body).runId).toBe("run_x");
  });

  it("lists work items deterministically by createdAt desc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wi-store-"));
    const store = createWorkItemStore({ rootDir: dir });
    await store.saveWorkItem({
      workItemId: "wi_a",
      sourceIssue: baseIssue,
      title: "A",
      goal: "g",
      acceptanceCriteria: [],
      status: "planning",
      taskIds: [],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });
    await store.saveWorkItem({
      workItemId: "wi_b",
      sourceIssue: baseIssue,
      title: "B",
      goal: "g",
      acceptanceCriteria: [],
      status: "ready",
      taskIds: [],
      createdAt: "2026-05-17T01:00:00.000Z",
      updatedAt: "2026-05-17T01:00:00.000Z",
    });
    const list = await store.listWorkItems();
    expect(list.map((wi) => wi.workItemId)).toEqual(["wi_b", "wi_a"]);
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

`pnpm --filter @issuepilot/orchestrator test -- work-items/__tests__/store`。

- [ ] **步骤 3：实现 `store.ts`**

入口形态：

```ts
export interface WorkItemStore {
  saveWorkItem(wi: WorkItem): Promise<void>;
  getWorkItem(id: string): Promise<WorkItem | undefined>;
  listWorkItems(): Promise<WorkItem[]>;
  saveTaskPlan(plan: TaskPlan): Promise<void>;
  getCurrentPlan(workItemId: string): Promise<TaskPlan | undefined>;
  listPlanHistory(workItemId: string): Promise<TaskPlan[]>;
  saveTaskRunLink(link: TaskRunLink): Promise<void>;
  listTaskRunLinks(taskId: string): Promise<TaskRunLink[]>;
  listAllTaskRunLinks(workItemId: string): Promise<TaskRunLink[]>;
  saveReport(report: WorkItemReport): Promise<void>;
  getReport(workItemId: string): Promise<WorkItemReport | undefined>;
}
```

实现要点：
- `redact()` 过滤敏感字段（参考 reports/store）。
- 内存缓存只是一层 fast path，所有写都过 fs；读时若内存缺失，回退磁盘。
- `listAllTaskRunLinks` 通过 WorkItem.taskIds 反查每个 taskId 的目录。

- [ ] **步骤 4：跑测试确认通过 + 提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- work-items/__tests__/store
git add apps/orchestrator/src/work-items/store.ts \
        apps/orchestrator/src/work-items/__tests__/store.test.ts
git commit -m "feat(orchestrator): add file-backed WorkItem/TaskPlan/TaskRunLink store"
```

---

## 任务 5：Plan 校验（依赖图 / 任务数 / 字段）

**文件：**

- 新建：`apps/orchestrator/src/work-items/plan-validation.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/plan-validation.test.ts`

按 spec §16.2：拆解任务数 2–5、`dependsOn` 不能形成环、字段必填、`riskLevel` 合法。

- [ ] **步骤 1：写失败的 validation 测试**

```ts
import { describe, expect, it } from "vitest";

import { validatePlanDraft } from "../plan-validation.js";
import type { TaskNode } from "@issuepilot/shared-contracts";

const baseTask = (over: Partial<TaskNode> = {}): TaskNode => ({
  taskId: "t1",
  title: "Do thing",
  goal: "Make X work",
  scope: "Touch a.ts",
  dependsOn: [],
  suggestedValidation: ["pnpm test"],
  status: "planned",
  runIds: [],
  riskLevel: "low",
  ...over,
});

describe("validatePlanDraft", () => {
  it("accepts a clean two-task plan", () => {
    const r = validatePlanDraft([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("rejects fewer than 2 tasks", () => {
    const r = validatePlanDraft([baseTask({ taskId: "t1" })]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("too_few_tasks");
  });

  it("rejects more than 5 tasks", () => {
    const tasks = Array.from({ length: 6 }, (_, i) =>
      baseTask({ taskId: `t${i}` }),
    );
    const r = validatePlanDraft(tasks);
    expect(r.code).toBe("too_many_tasks");
  });

  it("rejects duplicate taskId", () => {
    const r = validatePlanDraft([
      baseTask({ taskId: "t1" }),
      baseTask({ taskId: "t1" }),
    ]);
    expect(r.code).toBe("duplicate_task_id");
  });

  it("rejects dependency cycles", () => {
    const r = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t2"] }),
      baseTask({ taskId: "t2", dependsOn: ["t1"] }),
    ]);
    expect(r.code).toBe("dependency_cycle");
  });

  it("rejects dependsOn referencing missing task", () => {
    const r = validatePlanDraft([
      baseTask({ taskId: "t1", dependsOn: ["t99"] }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(r.code).toBe("dependency_unknown");
  });

  it("rejects empty title", () => {
    const r = validatePlanDraft([
      baseTask({ taskId: "t1", title: "" }),
      baseTask({ taskId: "t2" }),
    ]);
    expect(r.code).toBe("missing_title");
  });
});
```

- [ ] **步骤 2：跑测试确认失败 → 实现 → 通过**

实现 `validatePlanDraft(tasks: TaskNode[]): { ok: true } | { ok: false; code: string; message: string }`，内部用 DFS 检测环。

- [ ] **步骤 3：提交**

```bash
git add apps/orchestrator/src/work-items/plan-validation.ts \
        apps/orchestrator/src/work-items/__tests__/plan-validation.test.ts
git commit -m "feat(orchestrator): validate work item plan drafts (size / cycles / fields)"
```

---

## 任务 6：Planner（Issue → TaskPlan draft）

**文件：**

- 新建：`apps/orchestrator/src/work-items/planner.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/planner.test.ts`

planner 接口 + 默认 Codex 实现。Codex 调用：用 single-turn 模式（`maxTurns: 1`），让模型按 JSON schema 输出。失败一律走 `planning_failed`。测试只走 fake LLM。

- [ ] **步骤 1：写失败的 planner 测试**

```ts
import { describe, expect, it } from "vitest";

import { createWorkItemPlanner, type RawPlanResponse } from "../planner.js";

const issue = {
  iid: 42,
  title: "Big",
  description: "Goal: ship feature X. AC1, AC2.",
  url: "https://gl/-/issues/42",
  projectId: "g/p",
  labels: ["ai-ready"],
};

describe("createWorkItemPlanner", () => {
  it("parses LLM JSON into a valid plan draft", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () =>
        ({
          tasks: [
            {
              taskId: "t1",
              title: "Add API",
              goal: "POST /x",
              scope: "src/api/x.ts",
              dependsOn: [],
              suggestedValidation: ["pnpm test"],
              riskLevel: "low",
            },
            {
              taskId: "t2",
              title: "Add UI",
              goal: "Render result",
              scope: "src/ui/x.tsx",
              dependsOn: ["t1"],
              suggestedValidation: ["pnpm test"],
              riskLevel: "low",
            },
          ],
        }) as RawPlanResponse,
    });
    const result = await planner.draft({ issue });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.tasks.length).toBe(2);
      expect(result.plan.dependencies).toEqual([{ from: "t1", to: "t2" }]);
    }
  });

  it("emits planning_failed when LLM response is not parsable", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => "not json" as unknown as RawPlanResponse,
    });
    const result = await planner.draft({ issue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("planner_parse_failed");
  });

  it("emits planning_failed when validator rejects", async () => {
    const planner = createWorkItemPlanner({
      callPlannerLlm: async () => ({ tasks: [] }),
    });
    const result = await planner.draft({ issue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("too_few_tasks");
  });
});
```

- [ ] **步骤 2：实现 `planner.ts`**

```ts
import { randomUUID } from "node:crypto";

import type { TaskPlan, TaskNode } from "@issuepilot/shared-contracts";

import { validatePlanDraft } from "./plan-validation.js";

export interface RawPlanResponse {
  tasks: Array<Partial<TaskNode> & { taskId: string; title: string }>;
}

export type DraftResult =
  | { ok: true; plan: TaskPlan }
  | { ok: false; code: string; message: string };

export interface WorkItemPlanner {
  draft(input: {
    issue: {
      iid: number;
      title: string;
      description: string;
      url: string;
      projectId: string;
      labels: string[];
    };
    workItemId?: string;
  }): Promise<DraftResult>;
}

export interface PlannerDeps {
  callPlannerLlm(input: {
    issue: { title: string; description: string; labels: string[] };
  }): Promise<RawPlanResponse | string>;
}

export function createWorkItemPlanner(deps: PlannerDeps): WorkItemPlanner {
  return {
    async draft({ issue, workItemId }) {
      let raw: unknown;
      try {
        raw = await deps.callPlannerLlm({
          issue: {
            title: issue.title,
            description: issue.description,
            labels: issue.labels,
          },
        });
      } catch (err) {
        return {
          ok: false,
          code: "planner_call_failed",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const parsed = typeof raw === "string" ? safeParse(raw) : raw;
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
        return {
          ok: false,
          code: "planner_parse_failed",
          message: "Planner response is not a JSON object with tasks[].",
        };
      }

      const tasks: TaskNode[] = (parsed as RawPlanResponse).tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        goal: t.goal ?? "",
        scope: t.scope ?? "",
        dependsOn: t.dependsOn ?? [],
        suggestedValidation: t.suggestedValidation ?? [],
        nonGoals: t.nonGoals,
        status: "planned",
        runIds: [],
        riskLevel: t.riskLevel ?? "low",
      }));

      const validation = validatePlanDraft(tasks);
      if (!validation.ok) return validation;

      const dependencies = tasks.flatMap((t) =>
        t.dependsOn.map((from) => ({ from, to: t.taskId })),
      );

      return {
        ok: true,
        plan: {
          planId: randomUUID(),
          workItemId: workItemId ?? "",
          version: 1,
          tasks,
          dependencies,
          operatorEdits: [],
          status: "draft",
        },
      };
    },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
```

- [ ] **步骤 3：跑测试通过 + 提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- work-items/__tests__/planner
git add apps/orchestrator/src/work-items/planner.ts \
        apps/orchestrator/src/work-items/__tests__/planner.test.ts
git commit -m "feat(orchestrator): add WorkItemPlanner with JSON-only Codex contract"
```

---

## 任务 7：Reconcile 增加 `parentIssueLabelMode`

**文件：**

- 修改：`apps/orchestrator/src/orchestrator/reconcile.ts`
- 修改：`apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`

按 spec V4.1 task execution contract：synthetic task run 必须绕过 per-run 父 Issue label writer 和 workpad handoff note；MR push / save report 仍正常。

- [ ] **步骤 1：写失败的 reconcile.test.ts 用例**

新增（参考既有 reconcile.test.ts 结构）：

```ts
it("suppresses parent issue label + workpad note when parentIssueLabelMode is 'suppressed'", async () => {
  const calls: string[] = [];
  await reconcile({
    runId: "run_a",
    iid: 42,
    branch: "ai/42-task-1",
    baseBranch: "main",
    workspacePath: "/tmp/ws",
    attempt: 1,
    issueUrl: "https://gl/-/issues/42",
    issueIdentifier: "g/p#42",
    runningLabel: "ai-running",
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
    parentIssueLabelMode: "suppressed",
    git: {
      hasNewCommits: async () => true,
      push: async () => calls.push("push"),
    },
    gitlab: {
      findMergeRequest: async () => null,
      createMergeRequest: async () => {
        calls.push("create-mr");
        return { iid: 7 };
      },
      updateMergeRequest: async () => calls.push("update-mr"),
      findWorkpadNote: async () => {
        calls.push("find-note");
        return null;
      },
      createNote: async () => {
        calls.push("create-note");
        return { id: 0 };
      },
      updateNote: async () => calls.push("update-note"),
      transitionLabels: async () => calls.push("transition-labels"),
    },
    onEvent: () => {},
  });

  expect(calls).toContain("push");
  expect(calls).toContain("create-mr");
  expect(calls).not.toContain("transition-labels");
  expect(calls).not.toContain("find-note");
  expect(calls).not.toContain("create-note");
  expect(calls).not.toContain("update-note");
});

it("defaults to active parent-issue mode (back-compat with V2.x)", async () => {
  const calls: string[] = [];
  await reconcile({
    runId: "run_b",
    iid: 43,
    branch: "ai/43",
    baseBranch: "main",
    workspacePath: "/tmp/ws",
    attempt: 1,
    issueUrl: "u",
    issueIdentifier: "p#43",
    runningLabel: "ai-running",
    handoffLabel: "human-review",
    reworkLabel: "ai-rework",
    git: { hasNewCommits: async () => true, push: async () => {} },
    gitlab: {
      findMergeRequest: async () => null,
      createMergeRequest: async () => ({ iid: 8 }),
      updateMergeRequest: async () => {},
      findWorkpadNote: async () => null,
      createNote: async () => ({ id: 1 }),
      updateNote: async () => {},
      transitionLabels: async () => calls.push("transition-labels"),
    },
    onEvent: () => {},
  });
  expect(calls).toContain("transition-labels");
});
```

- [ ] **步骤 2：在 `ReconcileInput` 增加可选字段**

```ts
export interface ReconcileInput {
  // ... existing fields ...
  /**
   * V4.1: synthetic task runs must NOT write to the parent Issue's labels
   * or workpad handoff note — those are owned by the WorkItem aggregator.
   * Defaults to "active" so V2.x callers see no behaviour change.
   */
  parentIssueLabelMode?: "active" | "suppressed";
}
```

- [ ] **步骤 3：在 reconcile 实现里加门控**

包住 `transitionLabels(iid, …)` 和 `findWorkpadNote/createNote/updateNote(iid, …)` 调用。`parentIssueLabelMode === "suppressed"` 时跳过这几段（其它 MR / push / 报告 / 事件保持不变）。

- [ ] **步骤 4：跑测试 + 提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- reconcile
git add apps/orchestrator/src/orchestrator/reconcile.ts \
        apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts
git commit -m "feat(orchestrator): allow reconcile to suppress parent-issue label writes for V4.1 task runs"
```

---

## 任务 8：Dispatch-task 薄壳

**文件：**

- 新建：`apps/orchestrator/src/work-items/dispatch-task.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`

封装“synthetic task run 用的 dispatch 调用”：

- 自己生成 `runId`，写一条 `RunRecord(status="claimed")` 到 `RuntimeState`，注入 `projectId="default" | <team-project>`、`projectName` 沿用父 Issue 配置。
- branch 用 `<branch_prefix>/<iid>-<task-slug>`（`task-slug` 通过 `slugify(task.title)`），workspace 仍在 `workflow.workspace.root`。
- 把 `parentIssueLabelMode: "suppressed"` 透传给 `reconcile`。
- prompt vars 在 `issue`、`workspace`、`git` 之外追加：
  ```ts
  vars.workItem = { workItemId, taskId, taskTitle, taskGoal, taskScope, suggestedValidation, dependenciesSummary };
  ```
- 通过既有 `dispatch` 完成 mirror / worktree / runAgent / reconcile。

- [ ] **步骤 1：写失败的 dispatch-task 测试**

用 fake `dispatchFn`、fake `state` 验证：

```ts
it("creates a synthetic RunRecord and passes parentIssueLabelMode='suppressed'", async () => {
  const dispatched: any[] = [];
  const state = createRuntimeState();
  await runTaskOnce({
    workItem: workItemFixture,
    task: { taskId: "t1", title: "Add API", goal: "g", scope: "s", suggestedValidation: [], dependsOn: [], runIds: [], status: "ready", riskLevel: "low" },
    workflow: { branchPrefix: "ai", baseBranch: "main" /* ... */ } as any,
    promptTemplate: "issue.title={{issue.title}} workItem.taskId={{workItem.taskId}}",
    state,
    dispatch: async (input, deps) => {
      dispatched.push({ input, parentMode: deps.parentIssueLabelMode });
    },
  });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0].input.branch).toBe("ai/42-add-api");
  expect(dispatched[0].parentMode).toBe("suppressed");
  const runs = state.allRuns();
  expect(runs).toHaveLength(1);
});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/dispatch-task.ts \
        apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts
git commit -m "feat(orchestrator): wire synthetic task run dispatch shim"
```

---

## 任务 9：Orchestration（plan → ready tasks → runs → status update）

**文件：**

- 新建：`apps/orchestrator/src/work-items/orchestration.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`

orchestration 单元：

- `computeReadyTasks(plan, runLinks)`：返回 `dependsOn` 全部 `completed` 的 `planned`/`blocked_by_dependency` 任务。V4.1 内：若某 upstream task 是 `completed` 但其 MR 没合入 `base_branch`，下游仍保持 `blocked_by_dependency`（spec §12.4）。在 V4.1 内 upstream MR 是否合入由 GitLab 实际状态决定，简化口径：`upstream task status === "completed"` 且 `link.mergeRequest.state === "merged"`，否则仍 blocked。
- `tickWorkItem(workItem, plan, runLinks, deps)`：调用 `computeReadyTasks`、对每个 ready task 调 dispatch-task；忽略 `runIds.length > 0 && lastRun.status === "running"` 的 task；写事件 `task_run_dispatched`。
- `applyTaskRunFinal(workItemId, taskId, runId, runReport)`：依据 RunReport 决定 TaskNode `completed` / `failed` / `blocked` / `needs_rework`，更新 `TaskRunLink`，触发 aggregator hook（在 daemon 串起来）。

并发口径：synthetic task run 仍走现有 `dispatch()`，因此共享 `createConcurrencySlots(workflow.agent.maxConcurrentAgents)`。V4.1 不实现 work-item 级独立配额；如果两个 WorkItem 同时有 ready task，先到先得（FIFO）。`tickWorkItem` 在 slot 不足时把多余的 ready task 留到下次 tick，不写 `task_run_dispatched`。

- [ ] **步骤 1：写失败的 orchestration 测试**

```ts
it("dispatches independent tasks in parallel respecting available slots", async () => {/* ... */});
it("keeps downstream task blocked_by_dependency until upstream MR is merged", async () => {/* ... */});
it("treats run.status='blocked' as TaskNode.status='blocked' with reason", async () => {/* ... */});
it("treats run.status='failed' as TaskNode.status='failed'; siblings continue", async () => {/* ... */});
it("treats run.status='completed' as TaskNode.status='completed' and writes TaskRunLink", async () => {/* ... */});
it("does not double-dispatch a task that already has a running TaskRunLink", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/orchestration.ts \
        apps/orchestrator/src/work-items/__tests__/orchestration.test.ts
git commit -m "feat(orchestrator): orchestrate V4.1 task plan into synthetic runs"
```

---

## 任务 10：Aggregate（task RunReports → WorkItemReport）

**文件：**

- 新建：`apps/orchestrator/src/work-items/aggregate.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/aggregate.test.ts`

按 spec §15 / §12.5：从所有 task `RunReportArtifact` 聚合到一个 `WorkItemReport`，决定 `overallStatus`：

- 全部 task `completed` 且 evidence 完整 → `complete`。
- 存在 `failed`/`blocked`/`needs_rework`/`skipped` → `partial`。
- 缺失 RunReportArtifact → `incomplete`。
- 任何情况下都不输出 `ready_to_merge`，最大输出 `needs_human_review`。

`recommendedNextActions` 按 spec §14.3 决定：列出哪些 task 完成、哪些失败、谁需要 review、是否建议进入人工 review / merge。

- [ ] **步骤 1：写失败的 aggregate 测试（happy / partial / incomplete）**

```ts
it("marks complete when all tasks completed and reports present", async () => {/* ... */});
it("marks partial when one task failed", async () => {/* ... */});
it("marks incomplete when at least one task is missing a RunReportArtifact", async () => {/* ... */});
it("does NOT recommend ready_to_merge under any condition", async () => {/* ... */});
it("indexes evidence by taskId with diff/validation/ci/review_feedback kinds", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/aggregate.ts \
        apps/orchestrator/src/work-items/__tests__/aggregate.test.ts
git commit -m "feat(orchestrator): aggregate task RunReports into WorkItemReport"
```

---

## 任务 11：Parent handoff（label + note）

**文件：**

- 新建：`apps/orchestrator/src/work-items/handoff.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/handoff.test.ts`

handoff 单元唯一允许写父 Issue label。

- `renderWorkItemHandoffNoteBody(workItem, plan, report)`：返回 markdown body，带固定 marker `<!-- issuepilot:work-item:<id> -->`。
- `decideParentLabelTransition(prevStatus, currentStatus, workflow)`：按 spec §9.0 表返回 `{ add, remove }`；纯函数，方便测试。
- `writeParentHandoff(deps, workItem, prevStatus, report?)`：在 WorkItem 状态变化时被 daemon 调用；调 `gitlab.findWorkpadNote(iid, marker)` 决定 create / update；按需调 `transitionLabels`；emit `work_item_handoff_written` 事件。

按 spec §9.0 父 Issue label 状态表：

| 触发 | prevStatus → currentStatus | 父 Issue label 行为 | 是否写 note |
| --- | --- | --- | --- |
| 点击 `Plan work item` | (none) → `planning` | 不动 | 否 |
| 接受 plan | `planning` → `ready` | 不动 | 否 |
| 触发第一条 task run | `ready` → `running` | `add: [ai-running], remove: [ai-ready]` | 否（避免和 task run 抖动） |
| 单 task 完成 / 失败 | `running` → `running`/`partial` | 不动 | 否 |
| 所有必需 task 完成 | `running` → `completed` | `add: [human-review], remove: [ai-running]` | 是 |
| 任意阶段 blocked | `*` → `blocked` | 不动 | 是（写 blocked note，保留 label 由 operator 决定） |
| operator 取消 / 重新规划 | `*` → `blocked` | 由 operator 在 UI 触发，handoff 不主动改 label | 是 |

`workflow.tracker.activeLabels` / `runningLabel` / `handoffLabel` / `blockedLabel` 从 daemon 注入，避免硬编码。

- [ ] **步骤 1：写失败的 handoff 测试（覆盖所有状态迁移）**

```ts
it("transitions ready→running adds ai-running and removes ai-ready", async () => {/* ... */});
it("does NOT write a note on the ready→running transition", async () => {/* ... */});
it("transitions running→completed adds human-review and removes ai-running and writes note", async () => {/* ... */});
it("does NOT transition label when running→partial; still writes note", async () => {/* ... */});
it("creates note when marker not found, updates when found", async () => {/* ... */});
it("emits work_item_handoff_written event", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/handoff.ts \
        apps/orchestrator/src/work-items/__tests__/handoff.test.ts
git commit -m "feat(orchestrator): write parent-issue handoff label/note from WorkItemReport"
```

---

## 任务 12：Server 路由

**文件：**

- 修改：`apps/orchestrator/src/server/index.ts`
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`

新增 `WorkItemService` 依赖注入接口：

```ts
export interface WorkItemService {
  planFromIssue(input: { iid: number; regenerate?: boolean; operator: string }):
    Promise<{ workItem: WorkItem; plan: TaskPlan } |
            { error: { code: string; message: string } }>;
  list(): Promise<WorkItem[]>;
  detail(id: string): Promise<WorkItemDetailResponse | undefined>;
  acceptPlan(input: AcceptWorkItemPlanRequest):
    Promise<{ workItem: WorkItem; plan: TaskPlan } |
            { error: { code: string; message: string } }>;
  regeneratePlan(id: string, operator: string):
    Promise<{ workItem: WorkItem; plan: TaskPlan } |
            { error: { code: string; message: string } }>;
  skipTask(workItemId: string, taskId: string, operator: string):
    Promise<{ ok: true } | { error: { code: string; message: string } }>;
  retryTask(workItemId: string, taskId: string, operator: string):
    Promise<{ ok: true } | { error: { code: string; message: string } }>;
  report(id: string): Promise<WorkItemReport | undefined>;
}
```

路由：

- `POST /api/issues/:iid/plan` → `planFromIssue`。
- `GET /api/work-items` → `{ workItems, counters }`。
- `GET /api/work-items/:id` → `WorkItemDetailResponse`。
- `POST /api/work-items/:id/plan/accept` → 接受 plan。
- `POST /api/work-items/:id/plan/regenerate` → 重新生成 plan。
- `POST /api/work-items/:id/tasks/:taskId/skip` → operator 跳过。
- `POST /api/work-items/:id/tasks/:taskId/retry` → operator 重试。
- `GET /api/work-items/:id/report` → `{ report }`。

错误形态参考既有 operator action：`statusFromCode`、`{ ok: false, code }`。

- [ ] **步骤 1：在 server.test.ts 加 fake `WorkItemService`，覆盖每条路由的 happy + 主要错误**

测试至少覆盖：
1. 没注入 `workItems` 时所有路由返回 503 `work_items_unavailable`。
2. `POST /api/issues/:iid/plan` 成功返回 `{ workItem, plan }`。
3. `GET /api/work-items` 返回 counters。
4. `GET /api/work-items/:id` 404 / 200。
5. `POST .../plan/accept` 校验 planId 必传，错误返回 400。
6. `POST .../tasks/:taskId/skip` 成功 / 找不到 → 404。

- [ ] **步骤 2：实现路由**

参照 `operatorActions` 的现有 pattern，注入 `workItems?: WorkItemService`，缺失则全部 503。

- [ ] **步骤 3：跑测试通过 + 提交**

```bash
git add apps/orchestrator/src/server/index.ts \
        apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(orchestrator): expose V4.1 work item REST routes"
```

---

## 任务 13：Daemon 装配

**文件：**

- 修改：`apps/orchestrator/src/daemon.ts`
- 修改：`apps/orchestrator/src/__tests__/daemon.test.ts`

在 daemon 启动时：

1. 实例化 `createWorkItemStore({ rootDir: path.join(workflow.workspace.root, ".issuepilot") })`。
2. 实例化 `createCodexPlanner` 的具体 `callPlannerLlm`：复用 `spawnRpc` + `driveLifecycle`，单 turn + JSON schema 提示。提示模板放在 `apps/orchestrator/src/work-items/planner-prompt.ts`，由 `daemon` 注入。
3. 实例化 `WorkItemService` 实现：把 store / planner / orchestration / aggregate / handoff 串起来。
4. 把 `workItems: workItemServiceImpl` 注入到 `createServer`。
5. 监听内部 event bus：当 `dispatch_completed` / `dispatch_failed` 命中 synthetic task run 时（识别方式：runId 在 `taskRunLinkIndex` 内），更新 TaskRunLink 状态、调用 aggregate、当 WorkItem.status 进入 `completed`/`partial` 时调 handoff（按 spec table）。
6. team-mode daemon `apps/orchestrator/src/team/daemon.ts`：V4.1 暂不接入；仅在 single-workflow daemon 装配。team-mode 启用留给 V4.2。在 `daemon.ts` 增加 README 注释解释这点。

- [ ] **步骤 1：写 daemon 集成测试用例（接 fake GitLab + fake Codex）**

```ts
it("registers POST /api/issues/:iid/plan when workItems service is wired", async () => {/* ... */});
it("listens to dispatch_completed for synthetic task runs and updates TaskRunLink", async () => {/* ... */});
it("does not write parent issue handoff until aggregate marks complete", async () => {/* ... */});
```

- [ ] **步骤 2：实现装配**

注意：synthetic task run 的事件流必须能识别到属于哪个 workItem / task。两条信号：
1. `RunRecord` 在 dispatch-task 写入时带上 metadata：扩展 `RunRecord` 加可选 `workItem?: { workItemId: string; taskId: string }`。需要在 `packages/shared-contracts/src/run.ts` 增加该可选字段（保持向后兼容）。
2. dispatch-task 在 `state.setRun` 时把 `workItem` 写进去。daemon 监听 `dispatch_completed` 时读取 `state.getRun(runId).workItem` 来定位 taskId。

把这个字段加进 `RunRecord` 也要补对应 contract 测试：

```ts
it("RunRecord.workItem carries V4.1 synthetic task metadata", () => {
  const run: RunRecord = { /* ... */, workItem: { workItemId: "wi_01", taskId: "t1" } };
  expect(run.workItem?.taskId).toBe("t1");
});
```

如果改了 `RunRecord` 也要在任务 1 之后单独提交一个小变更，或在本任务里一起做。本计划放在本任务里，让 contract 变更和 daemon 装配一起 commit 边界清晰。

- [ ] **步骤 3：跑测试通过 + 提交**

```bash
git add apps/orchestrator/src/daemon.ts \
        apps/orchestrator/src/__tests__/daemon.test.ts \
        packages/shared-contracts/src/run.ts \
        packages/shared-contracts/src/__tests__/run.test.ts
git commit -m "feat(orchestrator): wire V4.1 work items service into single-workflow daemon"
```

---

## 任务 14：Dashboard API client

**文件：**

- 修改：`apps/dashboard/lib/api.ts`
- 修改：`apps/dashboard/lib/api.test.ts`

按任务 12 路由表，新增：

```ts
export function planWorkItem(iid: number, opts?: { regenerate?: boolean; operator?: string }):
  Promise<{ workItem: WorkItem; plan: TaskPlan }>;
export function listWorkItems(opts?: ApiGetOptions):
  Promise<{ workItems: WorkItem[]; counters: Record<WorkItemStatus, number> }>;
export function getWorkItem(id: string, opts?: ApiGetOptions):
  Promise<WorkItemDetailResponse>;
export function acceptWorkItemPlan(id: string, body: AcceptWorkItemPlanRequest):
  Promise<{ workItem: WorkItem; plan: TaskPlan }>;
export function regenerateWorkItemPlan(id: string, opts?: OperatorActionOptions):
  Promise<{ workItem: WorkItem; plan: TaskPlan }>;
export function skipWorkItemTask(id: string, taskId: string, opts?: OperatorActionOptions):
  Promise<{ ok: true }>;
export function retryWorkItemTask(id: string, taskId: string, opts?: OperatorActionOptions):
  Promise<{ ok: true }>;
export function getWorkItemReport(id: string, opts?: ApiGetOptions):
  Promise<WorkItemReportResponse>;
```

- [ ] **步骤 1：写失败测试覆盖 URL + body 形状**

```ts
it("planWorkItem POSTs /api/issues/:iid/plan with operator header", async () => {/* ... */});
it("acceptWorkItemPlan PUT/POSTs plan accept with edits", async () => {/* ... */});
// etc
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts
git commit -m "feat(dashboard): add V4.1 work item API client"
```

---

## 任务 15：Dashboard Work Items 列表

**文件：**

- 新建：`apps/dashboard/app/work-items/page.tsx`
- 新建：`apps/dashboard/components/work-items/work-items-list.tsx`
- 新建：`apps/dashboard/components/work-items/work-items-list.test.tsx`

类似 `apps/dashboard/app/page.tsx` 的服务器组件 + 内部客户端组件结构：

- `page.tsx`：`await listWorkItems()` → 渲染 `WorkItemsList`，错误态参考 `home.errorTitle` pattern。
- `WorkItemsList`：每行展示 `title`、`sourceIssue.iid`、`status`（用 Status badge）、`taskIds.length` 任务数、`updatedAt` 相对时间。点击进入 `/work-items/<id>`。
- 顶部计数器：用 `summary` 风格展示 counters。
- 空态：提示 operator 在 Command Center 选 issue 用 `Plan work item` 触发拆解（与下一任务的入口一致）。

- [ ] **步骤 1：写失败的组件测试**

测试至少覆盖：
1. counters 显示。
2. 行数 = workItems.length。
3. 空态文案。

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/app/work-items/page.tsx \
        apps/dashboard/components/work-items/work-items-list.tsx \
        apps/dashboard/components/work-items/work-items-list.test.tsx
git commit -m "feat(dashboard): add Work Items list route"
```

---

## 任务 16：Dashboard Work Item 详情 + Task list + Plan editor

**文件：**

- 新建：`apps/dashboard/app/work-items/[id]/page.tsx`
- 新建：`apps/dashboard/components/work-items/work-item-detail.tsx`
- 新建：`apps/dashboard/components/work-items/work-item-detail.test.tsx`
- 新建：`apps/dashboard/components/work-items/task-list.tsx`
- 新建：`apps/dashboard/components/work-items/task-list.test.tsx`
- 新建：`apps/dashboard/components/work-items/plan-editor.tsx`
- 新建：`apps/dashboard/components/work-items/plan-editor.test.tsx`

`work-item-detail` 组合：

- 顶部 WorkItem 元数据（标题、状态、来源 Issue 链接）。
- `PlanEditor`：当 `plan.status === "draft"` 时显示「接受 / 重新生成 / 编辑」按钮；编辑是把 `title`、`goal`、`scope`、`dependsOn`、`suggestedValidation` 改成 inline editable。接受时调 `acceptWorkItemPlan` 并把 edits 数组 POST 出去。
- `TaskList`：按 V4.1 不做图，用分组列表（`ready` / `running` / `completed` / `blocked` / `failed` / `needs_rework` / `skipped`）展示 TaskNode，每行附「Skip / Retry」操作（仅适用状态启用）。
- 底部 `ParentReviewPacket`（下一任务实现），如果 `report` 已存在则展示。

测试要求覆盖：
1. plan draft 状态下 PlanEditor 出现「接受 / 重新生成」按钮。
2. plan accepted 状态下显示 task list。
3. failed task 行出现「Retry」，skipped task 行出现「取消跳过」（V4.1 不实现取消跳过，只 disabled）。
4. operator edit 修改某字段后点接受 → 调 `acceptWorkItemPlan(id, { edits: [...] })`。

- [ ] **步骤 1：写失败的组件测试 → 实现 → 通过**

- [ ] **步骤 2：提交**

```bash
git add apps/dashboard/app/work-items/[id]/page.tsx \
        apps/dashboard/components/work-items/work-item-detail.tsx \
        apps/dashboard/components/work-items/work-item-detail.test.tsx \
        apps/dashboard/components/work-items/task-list.tsx \
        apps/dashboard/components/work-items/task-list.test.tsx \
        apps/dashboard/components/work-items/plan-editor.tsx \
        apps/dashboard/components/work-items/plan-editor.test.tsx
git commit -m "feat(dashboard): add Work Item detail with plan editor + task list"
```

---

## 任务 17：Parent Review Packet 视图

**文件：**

- 新建：`apps/dashboard/components/work-items/parent-review-packet.tsx`
- 新建：`apps/dashboard/components/work-items/parent-review-packet.test.tsx`

按 spec §14.3：

- 总结：拆成了哪些任务、完成 / 失败 / 跳过的状态。
- 每个任务一行 / 一卡：diff summary、validation、风险、MR、CI、next action。
- Evidence index 按 task 折叠。
- 顶部标 `WorkItemReport.overallStatus`（`complete` 绿色、`partial` 琥珀、`incomplete` 红色）。
- 最下面 `recommendedNextActions` 列表。
- 不显示「ready_to_merge」字样；如果 V4.1 报告完整最多说「建议进入人工 review」。

- [ ] **步骤 1：写失败测试覆盖三种 overallStatus + 空态 + Markdown 复制按钮**

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/work-items/parent-review-packet.tsx \
        apps/dashboard/components/work-items/parent-review-packet.test.tsx
git commit -m "feat(dashboard): render Parent Review Packet from WorkItemReport"
```

---

## 任务 18：导航 + i18n 串接 + Command Center 入口

**文件：**

- 修改：`apps/dashboard/components/shell/top-bar.tsx`
- 修改：`apps/dashboard/i18n/messages/zh.json`
- 修改：`apps/dashboard/i18n/messages/en.json`
- 修改：`apps/dashboard/components/command-center/review-packet-inspector.tsx`（在 inspector 里加「Plan work item」按钮，调 `planWorkItem(run.issue.iid)` 然后导航到 `/work-items/<id>`）
- 修改：`apps/dashboard/components/command-center/review-packet-inspector.test.tsx`（如不存在则需在 V2.5 后回填，可选）

实现要点：

1. 顶栏 nav 新增 `t("nav.workItems")` 入口（中文「工作单元」，英文「Work Items」）。
2. zh / en 新增：
   - `nav.workItems`
   - `workItems.title`、`description`、`empty`、`counter.*`、`columns.*`
   - `workItem.plan.title`、`accept`、`regenerate`、`edit`、`field.title`、`field.goal`、`field.scope`、`field.dependsOn`、`field.suggestedValidation`
   - `workItem.task.status.*`（每个状态文案）
   - `workItem.parentReviewPacket.*`
   - `workItem.action.skip`、`workItem.action.retry`、`workItem.action.planWorkItem`
3. Command Center 的 `ReviewPacketInspector`：当当前 run 没有关联 workItem 时，显示一个「Plan work item」按钮，按下后调 `planWorkItem`、导航到 `/work-items/<id>`。

- [ ] **步骤 1：先加 i18n 字符串（zh + en 同时改，避免 missing key 报错）**

- [ ] **步骤 2：top-bar 测试**

```ts
it("renders Work Items nav entry pointing to /work-items", () => {/* ... */});
```

- [ ] **步骤 3：Command Center 入口测试**

```ts
it("Plan work item button calls planWorkItem(iid) and navigates", async () => {/* ... */});
```

- [ ] **步骤 4：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/shell/top-bar.tsx \
        apps/dashboard/i18n/messages/zh.json \
        apps/dashboard/i18n/messages/en.json \
        apps/dashboard/components/command-center/review-packet-inspector.tsx
git commit -m "feat(dashboard): expose V4.1 entry points in nav + Command Center inspector"
```

---

## 任务 19：端到端测试

**文件：**

- 新建：`apps/orchestrator/src/__tests__/work-items-e2e.test.ts`

按 spec §16.5 / §17 的最小验收脚本：

1. 启动一个 in-memory daemon（fake GitLab + fake Codex），workspace 用 `mkdtemp`。
2. 创建一个 fake Issue (`iid=42`, description 含 acceptance criteria)。
3. 调 `POST /api/issues/42/plan` → 期望 `WorkItem(status="planning")` 并立即 `plan` 返回 `tasks.length === 2`。
4. 调 `POST /api/work-items/<id>/plan/accept` → 期望 `WorkItem(status="ready")`, `TaskPlan(status="accepted")`.
5. 让 daemon tick 一次 orchestration → 期望两个 task 各 dispatch 一个 run（fake runner 返回 `status="completed"`）。
6. 期望两个独立 MR 被 fake GitLab 记下；父 Issue label 仍是 `ai-running`（per-task run **不** 切换父 label）。
7. 等 aggregator 跑完 → 期望 `WorkItemReport.overallStatus === "complete"`、父 Issue label 切到 `human-review`、父 Issue note 含 marker `<!-- issuepilot:work-item:` + 任务摘要。
8. 调 `GET /api/work-items/<id>/report` → 验证 evidence index 含两条 task。
9. 再跑一个失败场景：让其中一个 task 失败 → `WorkItem.status === "partial"`, 父 Issue label **不** 切到 `human-review`。
10. 跑一个 dependency 场景：task A 完成（其 MR `state === "opened"`，未合并），task B `dependsOn: ["A"]` → 期望 task B 保持 `blocked_by_dependency`。

- [ ] **步骤 1：写 E2E 测试**

- [ ] **步骤 2：跑测试通过 + 提交**

```bash
git add apps/orchestrator/src/__tests__/work-items-e2e.test.ts
git commit -m "test(orchestrator): V4.1 workflow spine end-to-end (happy + partial + blocked)"
```

---

## 任务 20：跨包 build + lint + typecheck + 全量测试

**目标：** 落地前的整仓库检查，绑定到 V4.1 收口节点。

- [ ] **步骤 1：跑包级 build**

```bash
pnpm -r build
```

期望全部 PASS。任何 TS error 必须修复（不要禁用 strict）。

- [ ] **步骤 2：跑全量 test**

```bash
pnpm -r test
```

- [ ] **步骤 3：跑 lint（如果仓库已有）**

```bash
pnpm -r lint
```

如有未配置项目，跳过。

- [ ] **步骤 4：检查 diff 白名单**

```bash
git diff --check
```

期望无 trailing whitespace / merge conflict 标记。

---

## 任务 21：文档与 CHANGELOG

**文件：**

- 修改：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- 修改：`README.md`
- 修改：`README.zh-CN.md`
- 修改：`USAGE.md`
- 修改：`USAGE.zh-CN.md`
- 修改：`CHANGELOG.md`

按 `AGENTS.md` 文档规则（中文文档 + 代码 / 配置原文 / 双语入口同步）执行。

- [ ] **步骤 1：在 V4 设计 spec 顶部增加一条「实施计划」链接**

在 spec §1 / §17 之后加：

```markdown
## 实施计划

- V4.1 Workflow Spine：`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`
```

- [ ] **步骤 2：README.md + README.zh-CN.md 同步 roadmap**

在 roadmap 一节增加 V4.1 入口（“Work Items / Parent Review Packet for large issues — landed in V4.1”）。

- [ ] **步骤 3：USAGE.md + USAGE.zh-CN.md 增加 `Plan work item` 操作流**

按双语同步：
1. 在 Command Center 选中一个 GitLab 大 Issue → 「Plan work item」。
2. 在 `/work-items/<id>` 接受 / 编辑 / 重新生成 plan。
3. 等待 task run 完成，查看 Parent Review Packet。
4. WorkItem 完成后父 Issue 自动获得 `human-review` 和 handoff note。

- [ ] **步骤 4：CHANGELOG.md 写一条 V4.1 段落**

```markdown
## [Unreleased] V4.1 Workflow Spine

- 新增 Work Item / Task Plan / Task Node / Task Run Link / Work Item Report 数据模型。
- orchestrator 新增 `POST /api/issues/:iid/plan`、`GET /api/work-items`、`GET /api/work-items/:id`、`POST /api/work-items/:id/plan/accept`、`POST /api/work-items/:id/plan/regenerate`、`POST /api/work-items/:id/tasks/:taskId/skip|retry`、`GET /api/work-items/:id/report` 路由。
- reconcile 支持 `parentIssueLabelMode: "suppressed"`，synthetic task run 不再触动父 Issue label / handoff。
- dashboard 增加 `/work-items` 列表 + 详情、Plan editor、Parent Review Packet。
- Command Center inspector 增加 `Plan work item` 入口。
- 父 Issue label / handoff note 仅由 WorkItem aggregator 决策，进入 `human-review` 等价于所有必需 task 均 `completed` 且报告完整。
```

- [ ] **步骤 5：提交**

```bash
git add docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md \
        README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md CHANGELOG.md
git commit -m "docs: announce V4.1 Workflow Spine landing"
```

---

## 任务 22（验收）：V4.1 验收检查清单

**目标：** 在 PR 描述里附上下面的自检清单，对应 spec §17。

- [ ] 一个大 Issue 能被拆成两个子任务（在 E2E 测试里覆盖）。
- [ ] Operator 能在 dashboard 接受或编辑 plan（plan-editor 组件测试覆盖）。
- [ ] 两个子任务各自产生 run report（reportStore 写出两条 RunReportArtifact）。
- [ ] 系统生成一个 `WorkItemReport`（store `getReport(workItemId)` 返回）。
- [ ] Dashboard 能看到子任务状态、验证结果、风险和 Parent Review Packet。
- [ ] Fake GitLab + fake Codex E2E 跑通完整闭环（task 19）。
- [ ] V4.1 task execution contract 全部满足：
  - 不创建 child GitLab Issue（fake GitLab 验证 `createIssue` 调用次数为 0）。
  - 每 task 一 branch / worktree，base = `base_branch`。
  - 每 task 一独立 MR。
  - `TaskRunLink` 是唯一 canonical binding。
  - 父 Issue label 切换 / handoff note 写入仅由 aggregator 触发（reconcile.test.ts 已覆盖 suppressed 模式，daemon.test.ts 覆盖 wiring）。
- [ ] 全量 `pnpm -r build` / `pnpm -r test` 通过。
- [ ] 文档 + CHANGELOG 更新。

---

## 不变量回顾

- V4.1 不能因单 task 失败丢掉整个 WorkItem 状态（aggregate 测试覆盖 `partial`）。
- 所有 AI 生成的拆解 / 汇总都可追溯到输入和 evidence（`TaskPlan.tasks` 含 sourceIssue link，evidence index 按 task 引用 RunReportArtifact）。
- 人保留接受 plan / 编辑 task / 重试 task / 跳过 task 的权力（路由 + UI 覆盖）。
- GitLab note / dashboard / Markdown export 同源于 `WorkItemReport`（handoff.ts 渲染、dashboard 直接渲染）。
- V4 不修改生产权限、部署、存储或审计模型（store 仍是 fs JSON、daemon 仍是单机）。

## 后续阶段（不在本计划范围）

- V4.2 Task Graph：依赖图、并行调度、局部重试 UI、回退重规划，team-mode daemon 接入 V4.1。
- V4.3 Review Packet + Evidence 自动化（截图、录屏、Playwright walkthrough）。
- V4.4 Quality Analytics。
- V4.5 Workflow / Skills Improvement Loop。
- V4.6 Multi-Agent / Multi-Runner Collaboration。
