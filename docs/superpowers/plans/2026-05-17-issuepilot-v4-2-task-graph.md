# IssuePilot V4.2 Task Graph 实施计划

Phase：V4 Phase 2
状态：待评审
对应 spec：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`（§7 V4.2 Task Graph、§9 数据模型、§11 主流程、§12.3/12.4 错误处理、§14.2 Task Graph UI、§16 测试策略）
依赖：V4.1 Workflow Spine（`docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`，已落地并通过验收 `…v4-1-workflow-spine-acceptance.md`）
下一步：V4.3 Review Packet + Evidence（自动索引截图 / 录屏 / Playwright walkthrough、CI / 测试结果聚合）

> **给执行 agent：** 执行本计划时必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每个任务最后一步是 commit，请勿合并多任务到一个 commit；步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 在 V4.1 Workflow Spine 之上让 IssuePilot 支持「依赖图执行 + 并行调度 + Task Graph 可视化 + 局部重试 / 跳过 / 取消跳过 / 打回重规划 + 上游未合并时的 branch chaining + team-mode daemon 接入工作单元」，使大 Issue 在多 project / 多 workflow 团队机器上能以最少 operator 介入完成多子任务编排。

**架构：** 不替换 V4.1 已有的 `apps/orchestrator/src/work-items/` 域。本阶段做四件增量：

1. **数据 / 契约层**：`TaskPlan` 加版本继承字段 `replanOf`、`TaskNode` 加 `needsReworkReason`，事件枚举新增 `task_marked_needs_rework` / `task_replanned` / `task_unskipped` / `task_graph_recomputed`，API 契约增加 replan / mark-rework / unskip / graph。
2. **Orchestration 层**：`computeReadyTasks` 加入 branch chaining 判定（线性链允许下游在上游 `completed` 但 MR 未合并时进入 `ready`，base 设为上游 task branch），`dispatch-task` 接受 `baseOverride`。
3. **Service 层**：新增 `replanTask` / `markNeedsRework` / `unskipTask` / `computeTaskGraph` 操作；它们都通过 `reconcileWorkItem` 推父 Issue label 状态。
4. **Team-mode 接入**：把 V4.1 service 装配到 `apps/orchestrator/src/team/daemon.ts`，server 新增 `x-issuepilot-project` header 选择当前 work-items namespace；保留 V1 single-project daemon 行为不变。

Dashboard 在 `apps/dashboard/app/work-items/[id]` 详情页增量加 Task Graph 视图、replan / mark-rework / unskip UI、project switcher。

**技术栈：** TypeScript、Node.js 22、Fastify、Vitest、Next.js App Router、React、Tailwind/shadcn-style 组件、`@issuepilot/shared-contracts`、Codex app-server（通过 `@issuepilot/runner-codex-app-server`）、GitLab REST（通过 `@issuepilot/tracker-gitlab`）。**第一版不引入 reactflow / dagre** —— Task Graph 用 topology grouped SVG 视图（按 dependency level 分层），避免 dashboard bundle 增长。reactflow 升级留给 V4.3。

---

## 范围检查

V4 spec 包含 6 个能力阶段（V4.1–V4.6）。本计划只覆盖 **V4.2 Task Graph**。

本计划明确**做**（用户已确认六项全部）：

1. **依赖图执行**：`dependsOn` 完成后下游自动解 blocked，可并行 dispatch 独立 task（在 V4.1 已部分支持的基础上加 branch chaining）。
2. **Dashboard Task Graph 可视化**：dependency-level 分层 SVG 视图 + 与 grouped list 的 view toggle。
3. **局部重试 / 跳过 / 取消跳过 UI**：V4.1 已有 retry / skip API，第一版只做客户端 UX 完整化 + 新增 unskip。
4. **单 task 重规划**：保留 plan version 模型，新 plan 仅替换被 replan 的 task，其余 task 继承 status / runIds。
5. **team-mode daemon 接入**：`apps/orchestrator/src/team/daemon.ts` 装配 per-project work-items service。
6. **依赖 task 之间的 branch chaining**：上游 `completed` 且 MR `state === "opened"` 时，下游 task base = 上游 task branch（线性链，单上游依赖时启用；多上游依赖回退为「等所有上游 merged」）。

本计划明确**不做**：

- V4.3 Review Packet + Evidence 截图 / 录屏 / Playwright walkthrough 索引（仍只聚合 `RunReportArtifact`）。
- V4.4 Quality Analytics、V4.5 Workflow / Skills Improvement Loop、V4.6 Multi-Agent / Multi-Runner。
- 不引入 reactflow / dagre / d3 等图形库；第一版 SVG 自绘。
- 不支持「同时多个上游依赖时的 branch chaining」（自动 rebase 风险高，留给 V4.3）。
- 不支持「跨 WorkItem 的依赖」；`dependsOn` 仍限同一 WorkItem 内。
- 不修改生产权限 / 部署 / 存储；team-mode 仍是单机文件存储。

下面所有任务遵守 V4.1 task execution contract（spec §7.V4.1）：

1. **不创建 child GitLab Issue**；replan / unskip / mark-rework 也只动 IssuePilot 本地状态，不在 GitLab 上新建 Issue。
2. **每 task 一 branch / worktree**：branch chaining 只换 base，仍 push 独立 branch、开独立 MR，`<branch_prefix>/<iid>-<task-slug>` 形态不变。
3. **TaskRunLink 是 task ↔ run 的 canonical binding**，replan 后旧 TaskRunLink 仍保留为历史证据；新 plan version 不复用旧 runId。
4. **父 Issue label / handoff note 由 WorkItem 聚合阶段统一写入**；replan / mark-rework / unskip 都通过 `reconcileWorkItem` 经由 `decideWorkItemStatus + writeParentHandoff` 触发，不绕过 aggregator。

## 文件结构

新建：

- `apps/orchestrator/src/work-items/branch-chain.ts`：根据 plan + links 计算每个 task 的 effective base branch（单上游依赖且未 merged 时返回 `origin/<upstream-branch>`，否则 `workflow.git.baseBranch`）。
- `apps/orchestrator/src/work-items/__tests__/branch-chain.test.ts`：覆盖单上游已 merged / 单上游未 merged / 多上游 / 上游缺 runLink 等情况。
- `apps/orchestrator/src/work-items/graph.ts`：纯函数，把 `TaskPlan` 加 `TaskRunLink` 输出成「分层 DAG + edges + critical path 候选」。
- `apps/orchestrator/src/work-items/__tests__/graph.test.ts`。
- `apps/orchestrator/src/work-items/__tests__/replan.test.ts`：service 层 replan 行为单测（独立成一个文件，避免 `service.test.ts` 膨胀）。
- `apps/orchestrator/src/work-items/__tests__/mark-rework.test.ts`：service 层 mark-rework 行为单测。
- `apps/orchestrator/src/work-items/__tests__/unskip.test.ts`：service 层 unskip 行为单测。
- `apps/orchestrator/src/team/__tests__/work-items.test.ts`：team daemon 装配 work-items 的集成测试。
- `apps/orchestrator/src/__tests__/work-items-v42-e2e.test.ts`：V4.2 端到端 fake GitLab + fake Codex，覆盖 branch chaining / replan / mark-rework / unskip。
- `apps/dashboard/components/work-items/task-graph.tsx`：dependency-level 分层 SVG 视图。
- `apps/dashboard/components/work-items/task-graph.test.tsx`。
- `apps/dashboard/components/work-items/view-toggle.tsx`：list / graph 切换。
- `apps/dashboard/components/work-items/view-toggle.test.tsx`。
- `apps/dashboard/components/work-items/replan-task-dialog.tsx`：operator 触发单 task replan 的对话框（让 operator 写 replan reason，可选附加 hint）。
- `apps/dashboard/components/work-items/replan-task-dialog.test.tsx`。
- `apps/dashboard/components/work-items/mark-rework-dialog.tsx`：operator 把 task 推回 `needs_rework` 时填 reason。
- `apps/dashboard/components/work-items/mark-rework-dialog.test.tsx`。
- `apps/dashboard/components/work-items/project-switcher.tsx`：team-mode 下顶部下拉，写 `x-issuepilot-project` header 给后续 API。
- `apps/dashboard/components/work-items/project-switcher.test.tsx`。

修改：

- `packages/shared-contracts/src/work-item.ts`：`TaskNode` 加 `needsReworkReason?: string`、`TaskPlan` 加 `replanOf?: { planId: string; taskId: string }`，并扩展 `TaskPlanEdit.field` 支持 `"replan"`。
- `packages/shared-contracts/src/__tests__/work-item.test.ts`：覆盖新字段 round-trip 和 type guards。
- `packages/shared-contracts/src/events.ts`：追加 `task_marked_needs_rework` / `task_replanned` / `task_unskipped` / `task_graph_recomputed`。
- `packages/shared-contracts/src/__tests__/events.test.ts`。
- `packages/shared-contracts/src/api.ts`：新增 `ReplanTaskRequest` / `MarkTaskReworkRequest` / `UnskipTaskRequest` / `WorkItemGraphResponse` 类型。
- `packages/shared-contracts/src/__tests__/api-work-item.test.ts`。
- `apps/orchestrator/src/work-items/orchestration.ts`：`computeReadyTasks` 接受 `branchChain` 决策，下游链式 ready 也允许；`tickWorkItem` 调 `branch-chain.ts` 派生 `baseOverride` 注入到 `dispatchTask`；`OrchestrationDeps.dispatchTask` 签名增加可选 `baseOverride`。
- `apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`：新增 branch chaining + needs_rework 排除用例。
- `apps/orchestrator/src/work-items/dispatch-task.ts`：`RunTaskOnceOptions` 增加可选 `baseOverride?: string`；构造 `DispatchInput.baseBranch` 时优先用 override。
- `apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`：覆盖 `baseOverride` 注入。
- `apps/orchestrator/src/work-items/service.ts`：新增 `replanTask` / `markNeedsRework` / `unskipTask` / `graph` 方法；扩展 `decideWorkItemStatus` 让 `needs_rework` 与 `partial` 等价；`acceptPlan` 在 `replanOf` 上保留前一 plan 的 task 状态继承。
- `apps/orchestrator/src/work-items/__tests__/service.test.ts`：补 `replanOf` 继承场景。
- `apps/orchestrator/src/server/index.ts`：新增 4 条路由 + `x-issuepilot-project` header 解析 + `WorkItemService` 接口扩展。
- `apps/orchestrator/src/server/__tests__/server.test.ts`：覆盖新路由 + project header。
- `apps/orchestrator/src/team/daemon.ts`：装配 per-project work-items service / store / planner，按 `x-issuepilot-project` header 选择。
- `apps/orchestrator/src/team/__tests__/daemon.test.ts`：增加「team daemon 暴露 work-items 路由」的集成断言。
- `apps/orchestrator/src/daemon.ts`：把 `runTaskOnce` 的 dispatch 调用接受 `baseOverride`；其它 wiring 不变。
- `apps/orchestrator/src/__tests__/daemon.test.ts`：补 chaining 注入断言。
- `apps/dashboard/lib/api.ts`：新增 `replanWorkItemTask` / `markWorkItemTaskRework` / `unskipWorkItemTask` / `getWorkItemGraph`；所有 API 在 team-mode 下自动带 `x-issuepilot-project` header。
- `apps/dashboard/lib/api.test.ts`：覆盖新方法 + project header 拼装。
- `apps/dashboard/components/work-items/task-list.tsx`：每行新增 `Replan` / `Mark rework` / `Unskip` 操作（按状态启用）；现有 `Skip` / `Retry` 行为保持。
- `apps/dashboard/components/work-items/task-list.test.tsx`：新增按钮可见性 + 调用断言。
- `apps/dashboard/components/work-items/work-item-detail.tsx`：把 grouped list 用 `ViewToggle` 包起来，graph 视图调 `TaskGraph` 渲染。
- `apps/dashboard/components/work-items/work-item-detail.test.tsx`：覆盖 toggle 行为。
- `apps/dashboard/components/work-items/work-items-list.tsx`：team-mode 下加 `ProjectSwitcher` + 状态计数器按 project 维度拉取。
- `apps/dashboard/components/work-items/work-items-list.test.tsx`。
- `apps/dashboard/components/shell/top-bar.tsx`：把 `ProjectSwitcher` 渲染在 nav 右侧（team-mode 才显示）。
- `apps/dashboard/i18n/messages/zh.json` / `en.json`：新增 V4.2 字符串（graph / replan / mark-rework / unskip / project switcher / branch chaining 提示）。
- `apps/orchestrator/src/orchestrator/__tests__/reconcile.test.ts`：补充「在 `parentIssueLabelMode: 'suppressed'` + 自定义 `baseBranch` 下，push 仍走分支」的回归。
- `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`：实施计划段加 V4.2 链接。
- `README.md` / `README.zh-CN.md`：roadmap 标 V4.2 已落地。
- `USAGE.md` / `USAGE.zh-CN.md`：新增 §5.8「Task Graph、单 task 重规划、team-mode 切换 project」操作说明。
- `CHANGELOG.md`：按 user rule 写一段 V4.2 段落。

---

## 任务 1：扩展 Work Item 契约（needsReworkReason / replanOf）

**文件：**

- 修改：`packages/shared-contracts/src/work-item.ts`
- 修改：`packages/shared-contracts/src/__tests__/work-item.test.ts`

`TaskNode` 已有 `statusReason`（V4.1 review 留下的字段，表 dispatched-side 失败原因）。V4.2 单独引入 `needsReworkReason` 是为了把「operator 主动打回」与「runtime failure」区分开，后续 V4.4 Quality Analytics 也要靠它统计返工率。

- [ ] **步骤 1：写失败的契约测试（追加到现有 describe 里）**

```ts
import { describe, expect, it } from "vitest";

import type {
  TaskNode,
  TaskPlan,
  TaskPlanEdit,
} from "../work-item.js";

describe("V4.2 contract extensions", () => {
  it("TaskNode carries optional needsReworkReason", () => {
    const t: TaskNode = {
      taskId: "t1",
      title: "T1",
      goal: "g",
      scope: "s",
      dependsOn: [],
      suggestedValidation: [],
      status: "needs_rework",
      runIds: ["run_a"],
      riskLevel: "low",
      needsReworkReason: "Reviewer flagged missing tests",
    };
    expect(JSON.parse(JSON.stringify(t)).needsReworkReason).toBe(
      "Reviewer flagged missing tests",
    );
  });

  it("TaskPlan exposes replanOf provenance", () => {
    const plan: TaskPlan = {
      planId: "tp_02",
      workItemId: "wi_01",
      version: 2,
      tasks: [],
      dependencies: [],
      operatorEdits: [],
      status: "draft",
      replanOf: { planId: "tp_01", taskId: "t2" },
    };
    expect(JSON.parse(JSON.stringify(plan)).replanOf?.taskId).toBe("t2");
  });

  it("TaskPlanEdit.field accepts 'replan'", () => {
    const edit: TaskPlanEdit = {
      taskId: "t2",
      field: "replan",
      before: { title: "Old" },
      after: { title: "New", goal: "Re-do" },
      by: "alice",
      at: "2026-05-17T00:00:00.000Z",
    };
    expect(edit.field).toBe("replan");
  });
});
```

- [ ] **步骤 2：跑测试确认失败**

运行 `pnpm --filter @issuepilot/shared-contracts test -- work-item`。
期望：3 个新用例编译失败（`needsReworkReason` 不存在、`replanOf` 不存在、`field` 不接受 `"replan"`）。

- [ ] **步骤 3：实现**

在 `work-item.ts`：

```ts
export interface TaskNode {
  // ... existing fields ...
  /**
   * V4.2: human-driven reason when operator pushes a task back to
   * `needs_rework`. Separate from `statusReason` (which records
   * runtime-side failure reasons) so quality analytics in V4.4 can
   * count true review-driven rework without false positives.
   */
  needsReworkReason?: string;
}

export interface TaskPlanEdit {
  taskId: string;
  field:
    | "title"
    | "goal"
    | "scope"
    | "dependsOn"
    | "suggestedValidation"
    | "replan";
  // ... rest unchanged ...
}

export interface TaskPlan {
  // ... existing fields ...
  /**
   * V4.2: when a plan is the result of a *single-task replan* (not a
   * full plan regeneration), records which previous plan + task this
   * plan derives from. The non-replanned tasks inherit status / runIds
   * from the previous plan so an in-flight workflow does not reset.
   */
  replanOf?: { planId: string; taskId: string };
}
```

- [ ] **步骤 4：跑测试确认通过 + 提交**

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/work-item.ts \
        packages/shared-contracts/src/__tests__/work-item.test.ts
git commit -m "feat(shared-contracts): add V4.2 needsReworkReason + replanOf"
```

---

## 任务 2：扩展事件枚举

**文件：**

- 修改：`packages/shared-contracts/src/events.ts`
- 修改：`packages/shared-contracts/src/__tests__/events.test.ts`

V4.2 新增 4 个事件，覆盖 operator action 与 graph 重算两条边。

- [ ] **步骤 1：在 events.test.ts 增加用例**

```ts
describe("V4.2 work item events", () => {
  const expected = [
    "task_marked_needs_rework",
    "task_replanned",
    "task_unskipped",
    "task_graph_recomputed",
  ];
  it.each(expected)("registers %s", (type) => {
    expect((EVENT_TYPE_VALUES as readonly string[]).includes(type)).toBe(true);
    expect(isEventType(type)).toBe(true);
  });
});
```

- [ ] **步骤 2：实现**

在 `EVENT_TYPE_VALUES` 末尾追加：

```ts
  // V4.2 task graph + operator actions
  "task_marked_needs_rework",
  "task_replanned",
  "task_unskipped",
  "task_graph_recomputed",
```

- [ ] **步骤 3：跑测试 + 提交**

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/events.ts \
        packages/shared-contracts/src/__tests__/events.test.ts
git commit -m "feat(shared-contracts): register V4.2 task graph events"
```

---

## 任务 3：扩展 API 契约（replan / mark-rework / unskip / graph）

**文件：**

- 修改：`packages/shared-contracts/src/api.ts`
- 修改：`packages/shared-contracts/src/__tests__/api-work-item.test.ts`

API 设计：

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `POST /api/work-items/:id/tasks/:taskId/replan` | `ReplanTaskRequest { reason: string; hint?: string }` | `{ workItem, plan }` 或 `{ error }`（新 plan version, status: "draft"） |
| `POST /api/work-items/:id/tasks/:taskId/mark-rework` | `MarkTaskReworkRequest { reason: string }` | `{ ok: true }` 或 `{ error }` |
| `POST /api/work-items/:id/tasks/:taskId/unskip` | `UnskipTaskRequest { operator?: string }` | `{ ok: true }` 或 `{ error }` |
| `GET /api/work-items/:id/graph` | — | `WorkItemGraphResponse { levels, edges, criticalPathTaskIds }` |

- [ ] **步骤 1：写失败的 API 类型测试**

```ts
import { describe, expect, it } from "vitest";

import type {
  ReplanTaskRequest,
  MarkTaskReworkRequest,
  UnskipTaskRequest,
  WorkItemGraphResponse,
} from "../api.js";

describe("V4.2 API contracts", () => {
  it("ReplanTaskRequest requires a human-readable reason", () => {
    const req: ReplanTaskRequest = { reason: "Sub-task was too broad" };
    expect(req.reason.length).toBeGreaterThan(0);
  });

  it("MarkTaskReworkRequest mirrors review-driven rework", () => {
    const req: MarkTaskReworkRequest = { reason: "Reviewer asked for tests" };
    expect(req.reason.length).toBeGreaterThan(0);
  });

  it("UnskipTaskRequest may omit operator (server falls back to header)", () => {
    const req: UnskipTaskRequest = {};
    expect(req.operator).toBeUndefined();
  });

  it("WorkItemGraphResponse exposes layered DAG + critical path", () => {
    const r: WorkItemGraphResponse = {
      levels: [["t1"], ["t2", "t3"]],
      edges: [{ from: "t1", to: "t2" }, { from: "t1", to: "t3" }],
      criticalPathTaskIds: ["t1", "t2"],
    };
    expect(r.levels.length).toBe(2);
  });
});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

在 `api.ts` 文件底部追加：

```ts
export interface ReplanTaskRequest {
  reason: string;
  hint?: string;
}

export interface MarkTaskReworkRequest {
  reason: string;
}

export interface UnskipTaskRequest {
  operator?: string;
}

export interface WorkItemGraphResponse {
  levels: string[][];
  edges: Array<{ from: string; to: string }>;
  criticalPathTaskIds: string[];
}
```

```bash
pnpm --filter @issuepilot/shared-contracts test
git add packages/shared-contracts/src/api.ts \
        packages/shared-contracts/src/__tests__/api-work-item.test.ts
git commit -m "feat(shared-contracts): add V4.2 replan/mark-rework/unskip/graph API types"
```

---

## 任务 4：Branch chain 计算

**文件：**

- 新建：`apps/orchestrator/src/work-items/branch-chain.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/branch-chain.test.ts`

Branch chaining 决策表（spec §12.4）：

| 上游 task 数 | 上游 task 状态 | 上游 MR 状态 | 下游 effective base | 决策 |
| --- | --- | --- | --- | --- |
| 0 | n/a | n/a | `workflow.git.baseBranch` | 直接 ready |
| 1 | `completed` | `merged` | `workflow.git.baseBranch` | 直接 ready（base 不变） |
| 1 | `completed` | `opened` | `origin/<upstream-branch>` | 链式 ready |
| 1 | `completed` | 缺失（无 MR） | `origin/<upstream-branch>` | 链式 ready |
| 1 | 非 `completed` | n/a | n/a | 仍 blocked_by_dependency |
| ≥ 2 | 所有都 `completed`+`merged` | n/a | `workflow.git.baseBranch` | 直接 ready |
| ≥ 2 | 其中任一未 merged | n/a | n/a | 仍 blocked_by_dependency（不做多上游 chaining） |

返回类型：

```ts
export type EffectiveBaseDecision =
  | { kind: "default-base"; baseBranch: string }
  | { kind: "chain-from-upstream"; baseBranch: string; upstreamTaskId: string }
  | { kind: "blocked"; reason: "non-linear" | "upstream-not-completed" };
```

- [ ] **步骤 1：写失败的 branch-chain 测试**

```ts
import { describe, expect, it } from "vitest";

import type {
  TaskNode,
  TaskRunLink,
  RunReportArtifact,
} from "@issuepilot/shared-contracts";

import { decideEffectiveBase } from "../branch-chain.js";

const baseTask = (over: Partial<TaskNode> = {}): TaskNode => ({
  taskId: "t",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "planned",
  runIds: [],
  riskLevel: "low",
  ...over,
});

const completedLink = (over: Partial<TaskRunLink> = {}): TaskRunLink => ({
  taskId: "t1",
  runId: "run_a",
  attempt: 1,
  status: "completed",
  reportId: "run_a",
  branch: "ai/42-add-api",
  startedAt: "t",
  completedAt: "t",
  ...over,
});

const reportFor = (
  runId: string,
  mrState: "opened" | "merged" | "closed",
  branch = "ai/42-add-api",
): RunReportArtifact =>
  ({
    workItemId: "wi_01",
    run: {
      runId,
      attempt: 1,
      status: "completed",
      branch,
      startedAt: "t",
      endedAt: "t",
    },
    mergeRequest: {
      iid: 1,
      url: "u",
      state: mrState,
      branch,
      baseBranch: "main",
    },
  }) as unknown as RunReportArtifact;

describe("decideEffectiveBase", () => {
  it("returns default base for tasks with no dependencies", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t1" }),
      plan: { tasks: [baseTask({ taskId: "t1" })] } as any,
      links: [],
      getRunReport: async () => undefined,
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });

  it("uses default base when single upstream is completed AND merged", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      plan: { tasks: [baseTask({ taskId: "t1" }), baseTask({ taskId: "t2", dependsOn: ["t1"] })] } as any,
      links: [completedLink({ taskId: "t1", branch: "ai/42-up" })],
      getRunReport: async () => reportFor("run_a", "merged", "ai/42-up"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });

  it("chains from upstream branch when single upstream is completed but MR is opened", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      plan: { tasks: [baseTask({ taskId: "t1" }), baseTask({ taskId: "t2", dependsOn: ["t1"] })] } as any,
      links: [completedLink({ taskId: "t1", branch: "ai/42-up" })],
      getRunReport: async () => reportFor("run_a", "opened", "ai/42-up"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({
      kind: "chain-from-upstream",
      baseBranch: "origin/ai/42-up",
      upstreamTaskId: "t1",
    });
  });

  it("returns blocked when single upstream is not completed", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t2", dependsOn: ["t1"] }),
      plan: { tasks: [baseTask({ taskId: "t1", status: "running" }), baseTask({ taskId: "t2", dependsOn: ["t1"] })] } as any,
      links: [],
      getRunReport: async () => undefined,
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "blocked", reason: "upstream-not-completed" });
  });

  it("returns non-linear blocked when ≥2 upstreams and at least one is not merged", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] }),
      plan: { tasks: [
        baseTask({ taskId: "t1" }),
        baseTask({ taskId: "t2" }),
        baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] }),
      ] } as any,
      links: [completedLink({ taskId: "t1", branch: "ai/42-up1", runId: "run_a" })],
      getRunReport: async (id) => (id === "run_a" ? reportFor("run_a", "opened", "ai/42-up1") : undefined),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "blocked", reason: "non-linear" });
  });

  it("returns default base when ≥2 upstreams are all completed + merged", async () => {
    const r = await decideEffectiveBase({
      task: baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] }),
      plan: { tasks: [
        baseTask({ taskId: "t1" }),
        baseTask({ taskId: "t2" }),
        baseTask({ taskId: "t3", dependsOn: ["t1", "t2"] }),
      ] } as any,
      links: [
        completedLink({ taskId: "t1", branch: "ai/42-a", runId: "run_a" }),
        completedLink({ taskId: "t2", branch: "ai/42-b", runId: "run_b" }),
      ],
      getRunReport: async (id) =>
        id === "run_a"
          ? reportFor("run_a", "merged", "ai/42-a")
          : reportFor("run_b", "merged", "ai/42-b"),
      defaultBaseBranch: "main",
    });
    expect(r).toEqual({ kind: "default-base", baseBranch: "main" });
  });
});
```

- [ ] **步骤 2：跑测试确认失败 → 实现 → 通过**

`decideEffectiveBase` 的实现：先看 `dependsOn`，分零 / 一 / 多 三个分支；查每个上游的最新 `completed` TaskRunLink；查报告判断 MR 是否 merged；按上表决策。

- [ ] **步骤 3：提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- branch-chain
git add apps/orchestrator/src/work-items/branch-chain.ts \
        apps/orchestrator/src/work-items/__tests__/branch-chain.test.ts
git commit -m "feat(orchestrator): compute V4.2 effective base branch with linear chaining"
```

---

## 任务 5：Orchestration 接入 branch chaining + 排除 needs_rework

**文件：**

- 修改：`apps/orchestrator/src/work-items/orchestration.ts`
- 修改：`apps/orchestrator/src/work-items/__tests__/orchestration.test.ts`

变更点：

1. `OrchestrationDeps.dispatchTask` 的签名扩为 `(task, options?: { baseOverride?: string })`。
2. `tickWorkItem` 在 dispatch 前调 `decideEffectiveBase`：
   - `default-base` → 不传 baseOverride；
   - `chain-from-upstream` → 传 `baseOverride: "<branch>"`，并 emit `task_run_dispatched` 时 detail 增加 `chainedFrom: "<upstreamTaskId>"`；
   - `blocked` → 不 dispatch，进入 `blockedByDependency`。
3. `computeReadyTasks` **从 ready 集合中明确排除 `needs_rework`**：currently V4.1 implementation already excludes 之，但当前实现把 `needs_rework` 排除在 `isStatusEligibleForReady` 之外仅是隐式行为，加单测固化（防回归）。
4. 通过 `branchChain` 决策更新 `computeReadyTasks` 的 `upstreamMerged` 签名为 `upstreamMergedOrChainable`：上游 `completed` 即视为「可链」，但只在线性单依赖时启用链式 ready；多上游仍要求全部 merged。

> 单测口径：在 `tickWorkItem` 集成测试里把 `decideEffectiveBase` 用 fake injectable 注入，避免单测被 `branch-chain.ts` 内部细节绑死。

- [ ] **步骤 1：增 orchestration 测试**

```ts
it("dispatches a chained task with baseOverride when upstream MR is opened", async () => {/* ... */});
it("keeps a chained task blocked when there are 2+ upstreams and any is unmerged", async () => {/* ... */});
it("never dispatches a task in needs_rework, even when dependencies are clear", async () => {/* ... */});
it("emits task_run_dispatched.detail.chainedFrom when chaining", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

修改 `OrchestrationDeps`：

```ts
export interface OrchestrationDeps {
  // ... existing ...
  dispatchTask(
    task: TaskNode,
    options?: { baseOverride?: string; chainedFrom?: string },
  ): Promise<{ runId: string; branch: string }>;
  /**
   * V4.2: hand off effective-base decision so tests can fake it. The
   * daemon wires this to {@link decideEffectiveBase}.
   */
  decideEffectiveBase(input: {
    task: TaskNode;
    plan: TaskPlan;
    links: TaskRunLink[];
  }): Promise<{
    kind: "default-base" | "chain-from-upstream" | "blocked";
    baseBranch?: string;
    upstreamTaskId?: string;
    reason?: string;
  }>;
}
```

`tickWorkItem`：

- 把 `computeReadyTasks` 的 `upstreamMerged` 改成 `upstreamReadyForChaining`：单上游时 `completed` 就算 ready；多上游时仍要求全部 merged。
- 对每个 ready task 调 `decideEffectiveBase`，根据结果决定 dispatch / 留 blocked。
- 链式 dispatch 时给 `dispatchTask` 传 `baseOverride`，并把 `chainedFrom` 写进 `task_run_dispatched.detail`。

```bash
pnpm --filter @issuepilot/orchestrator test -- orchestration
git add apps/orchestrator/src/work-items/orchestration.ts \
        apps/orchestrator/src/work-items/__tests__/orchestration.test.ts
git commit -m "feat(orchestrator): orchestrate V4.2 linear branch chaining"
```

---

## 任务 6：Dispatch-task 支持 baseOverride

**文件：**

- 修改：`apps/orchestrator/src/work-items/dispatch-task.ts`
- 修改：`apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts`

`RunTaskOnceOptions` 增加 `baseOverride?: string`；构造 `DispatchInput.baseBranch` 时优先用 override；同时把 `chainedFrom` 写进 `extraPromptVars.workItem.chainedFrom`，prompt 模板就能感知「我是基于上游分支」。

- [ ] **步骤 1：增 dispatch-task 测试**

```ts
it("uses workflow.git.baseBranch by default", async () => {/* ... */});
it("uses baseOverride when provided", async () => {
  const captured: DispatchInput[] = [];
  await runTaskOnce({
    workItem,
    task,
    workflow: { git: { repoUrl: "u", baseBranch: "main", branchPrefix: "ai" }, /* ... */ } as any,
    promptTemplate: "{{ workItem.chainedFrom }}",
    state: createRuntimeState(),
    dispatch: async (input) => { captured.push(input); },
    baseOverride: "origin/ai/42-up",
    chainedFrom: "t1",
  });
  expect(captured[0].baseBranch).toBe("origin/ai/42-up");
  expect(captured[0].extraPromptVars?.workItem).toMatchObject({ chainedFrom: "t1" });
});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/dispatch-task.ts \
        apps/orchestrator/src/work-items/__tests__/dispatch-task.test.ts
git commit -m "feat(orchestrator): pass baseOverride + chainedFrom through dispatch-task"
```

---

## 任务 7：Graph 投影（topology levels + critical path）

**文件：**

- 新建：`apps/orchestrator/src/work-items/graph.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/graph.test.ts`

`computeTaskGraph(plan, links)` 输出：

```ts
export interface TaskGraphProjection {
  levels: string[][];
  edges: Array<{ from: string; to: string }>;
  criticalPathTaskIds: string[];
}
```

定义：

- `levels`：拓扑分层，level 0 = `dependsOn.length === 0` 的 task，依次推。环检测应该在 `plan-validation.ts` 已挡住；这里如果还碰到环就抛错（caller 是 V4.2 service，已校验过 plan）。
- `edges`：从 `tasks[i].dependsOn[j]` 派生，与 `plan.dependencies` 一致。
- `criticalPathTaskIds`：当前一次「最长」路径上的 task；以 task 数为长度（不引入耗时估算）。若多条等长，取字典序首条。

- [ ] **步骤 1：写失败的 graph 测试**

```ts
it("layers tasks by topological depth", () => {/* ... */});
it("returns edges that match plan.dependencies", () => {/* ... */});
it("returns the longest path (by node count) as criticalPathTaskIds", () => {/* ... */});
it("handles a fully parallel plan (single level, no edges)", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/graph.ts \
        apps/orchestrator/src/work-items/__tests__/graph.test.ts
git commit -m "feat(orchestrator): project work item plan into layered graph"
```

---

## 任务 8：Service.replanTask

**文件：**

- 修改：`apps/orchestrator/src/work-items/service.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/replan.test.ts`

逻辑：

1. 验证 `workItem` / 当前 plan / target task 存在；当前 plan 必须是 `accepted`（draft 阶段 operator 应直接 `regeneratePlan` 全量重做）。
2. 调用 `planner.draft` 时传 `{ replanScope: { taskId, reason, hint } }`，要求 LLM 只输出 **替换该 task 的单条 task object**；planner 在 V4.2 第一版用一个最小适配：内部把 prompt 改成「only return JSON for task with id = <taskId>」。
3. planner 输出校验：只接受单 task object；若返回 multi-task，写 `planning_failed` + `code: "replan_returned_multi"`。
4. 把当前 plan 标 `superseded`，emit `work_item_plan_regenerated` 已被 V4.1 用过；这里 emit 一个新的 `task_replanned` 事件。
5. 构造新 `TaskPlan`：
   - `planId` 重新生成；
   - `version` = 当前 version + 1；
   - `tasks` = 当前 tasks 复制，把 `taskId === replanTaskId` 的那一项替换为 LLM 输出，**保留其 `runIds`**（runIds 是历史证据）；其它 task 的 `status` / `runIds` / `needsReworkReason` 全部继承；
   - `dependencies` 重算；
   - `operatorEdits` 复制 + 追加一条 `{ field: "replan", before, after, by: operator, at }`；
   - `replanOf: { planId: previousPlan.planId, taskId: replanTaskId }`；
   - `status: "draft"` —— operator 仍需 accept 一次，避免「单 task 偷换」。
6. WorkItem.status 不立即变（保留当前 `ready` / `running` / `partial`）；accept 后走原 `acceptPlan` 路径。

- [ ] **步骤 1：写失败的 replan 测试**

```ts
describe("WorkItemService.replanTask", () => {
  it("creates a new TaskPlan version 2 with replanOf and inherited statuses", async () => {/* ... */});
  it("supersedes the previous accepted plan", async () => {/* ... */});
  it("returns validation_failed when planner returns multiple tasks", async () => {/* ... */});
  it("returns not_found when the task is missing", async () => {/* ... */});
  it("records a 'replan' operatorEdit pointing at the replaced task", async () => {/* ... */});
});
```

- [ ] **步骤 2：实现**

`service.ts` 加：

```ts
async replanTask(workItemId, taskId, { reason, hint, operator }): Promise<…> {/* ... */}
```

并扩 `WorkItemPlanner.draft` 选项：

```ts
draft(input: {
  issue: { ... };
  workItemId?: string;
  /** V4.2: replan scope. When set, the planner must return JSON
   *  containing exactly one task replacing the named task. */
  replanScope?: { taskId: string; reason: string; hint?: string };
}): Promise<DraftResult>;
```

`planner.ts` 默认实现接收 `replanScope` 时把 prompt 重写为单 task 模式；fake planner（测试用）按 `replanScope` 决定返回结构。

- [ ] **步骤 3：通过 + 提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- replan
git add apps/orchestrator/src/work-items/service.ts \
        apps/orchestrator/src/work-items/planner.ts \
        apps/orchestrator/src/work-items/__tests__/replan.test.ts \
        apps/orchestrator/src/work-items/__tests__/planner.test.ts
git commit -m "feat(orchestrator): support single-task replan that produces a new plan version"
```

---

## 任务 9：Service.markNeedsRework

**文件：**

- 修改：`apps/orchestrator/src/work-items/service.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/mark-rework.test.ts`

逻辑：

1. 校验 `workItem` / plan / task 存在。
2. 仅当 task.status ∈ {`completed`, `failed`, `blocked`} 时允许；其它状态返回 `invalid_status`。
3. 把 task.status → `needs_rework`，写 `needsReworkReason: reason`。
4. emit `task_marked_needs_rework`。
5. 调 `reconcileWorkItem(workItemId)`：aggregate 重算后 WorkItem.status 从 `completed` 退回 `partial`；handoff 按 V4.1 §9.0 表写父 Issue label（不会从 `human-review` 退回 `ai-running`，spec 留给 V4.5；V4.2 第一版只在父 Issue 写一条「needs_rework」note 提醒 reviewer）。
6. 注意 V4.2 第一版**不重新 dispatch**：operator 需要点 `Retry` 才会让 task 重 dispatch（task-list UI 在 needs_rework 状态显示 Retry 按钮）。

- [ ] **步骤 1：写失败的 mark-rework 测试**

```ts
it("rejects mark-rework on tasks that are not completed/failed/blocked", async () => {/* ... */});
it("sets needsReworkReason and status=needs_rework", async () => {/* ... */});
it("emits task_marked_needs_rework", async () => {/* ... */});
it("calls reconcileWorkItem so WorkItem.status leaves 'completed'", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/service.ts \
        apps/orchestrator/src/work-items/__tests__/mark-rework.test.ts
git commit -m "feat(orchestrator): operator-driven markNeedsRework with reason"
```

---

## 任务 10：Service.unskipTask

**文件：**

- 修改：`apps/orchestrator/src/work-items/service.ts`
- 新建：`apps/orchestrator/src/work-items/__tests__/unskip.test.ts`

逻辑：

1. 校验 task.status === `skipped`，否则 `invalid_status`。
2. 把 task.status → `ready`；清掉 `statusReason`。
3. emit `task_unskipped`。
4. 调 `tick(workItem)` 触发 dispatch（dependencies 仍按 V4.2 chaining 决策）。

- [ ] **步骤 1：写失败的 unskip 测试 + 实现 + 通过 + 提交**

```ts
it("rejects unskip on a task that is not skipped", async () => {/* ... */});
it("transitions skipped task back to ready and ticks orchestration", async () => {/* ... */});
```

```bash
git add apps/orchestrator/src/work-items/service.ts \
        apps/orchestrator/src/work-items/__tests__/unskip.test.ts
git commit -m "feat(orchestrator): operator-driven unskipTask"
```

---

## 任务 11：Service.graph

**文件：**

- 修改：`apps/orchestrator/src/work-items/service.ts`

`service.graph(id)` 返回 `WorkItemGraphResponse | { error }`。内部直接调 `computeTaskGraph(plan, links)`，并在调用前 emit `task_graph_recomputed`（detail 包含 levels.length, edges.length）。

- [ ] **步骤 1：写 service 单测 case「graph 在 plan 存在时返回 levels」、「plan 不存在时返回 not_found」**

可以加到 `service.test.ts` 里现成 describe。

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/work-items/service.ts \
        apps/orchestrator/src/work-items/__tests__/service.test.ts
git commit -m "feat(orchestrator): expose work item graph projection via service"
```

---

## 任务 12：Server 路由扩展

**文件：**

- 修改：`apps/orchestrator/src/server/index.ts`
- 修改：`apps/orchestrator/src/server/__tests__/server.test.ts`

变更：

1. `WorkItemService` 接口增加 4 个方法（与 service.ts 对齐）。
2. 路由：
   - `POST /api/work-items/:id/tasks/:taskId/replan` → `replanTask`；body `{ reason, hint? }`，校验 `reason.length > 0`，否则 400 `validation_failed`。
   - `POST /api/work-items/:id/tasks/:taskId/mark-rework` → `markNeedsRework`；body `{ reason }`。
   - `POST /api/work-items/:id/tasks/:taskId/unskip` → `unskipTask`。
   - `GET /api/work-items/:id/graph` → `service.graph`。
3. **`x-issuepilot-project` header**：所有 work-item 路由（包括 V4.1 已有的）在 team-mode 下，server 把 header 解出来，从 `workItemsByProject(projectId)` 选对应的 service；single-mode daemon 保持单一 service（header 被忽略）。
4. 错误形态延续 V4.1（`not_found` / `invalid_iid` / `validation_failed` / `planner_failed` / `invalid_status` / `work_items_unavailable`）。

- [ ] **步骤 1：增加 server 路由测试**

```ts
it("POST /api/work-items/:id/tasks/:taskId/replan returns new draft plan", async () => {/* ... */});
it("POST .../replan rejects empty reason with 400 validation_failed", async () => {/* ... */});
it("POST .../mark-rework records the reason", async () => {/* ... */});
it("POST .../unskip succeeds on skipped task", async () => {/* ... */});
it("GET .../graph returns levels/edges/criticalPathTaskIds", async () => {/* ... */});
it("routes to per-project workItems service when x-issuepilot-project header is set", async () => {/* ... */});
it("falls back to the default workItems service when the header is absent", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- server
git add apps/orchestrator/src/server/index.ts \
        apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(orchestrator): expose V4.2 work item routes and per-project routing"
```

---

## 任务 13：Daemon 注入 decideEffectiveBase + dispatch chain

**文件：**

- 修改：`apps/orchestrator/src/daemon.ts`
- 修改：`apps/orchestrator/src/__tests__/daemon.test.ts`

让 single-project daemon 把 `decideEffectiveBase` 注入到 orchestration deps；`dispatchTask` 闭包接受 `options?.baseOverride` 并透传给 `runTaskOnce`。

- [ ] **步骤 1：daemon 测试**

```ts
it("daemon wires decideEffectiveBase from branch-chain.ts", async () => {/* ... */});
it("daemon dispatch closure forwards baseOverride into runTaskOnce", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/daemon.ts \
        apps/orchestrator/src/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): wire branch-chain decisions into the single-project daemon"
```

---

## 任务 14：Team daemon 装配 work-items

**文件：**

- 修改：`apps/orchestrator/src/team/daemon.ts`
- 新建：`apps/orchestrator/src/team/__tests__/work-items.test.ts`
- 修改：`apps/orchestrator/src/team/__tests__/daemon.test.ts`

实现要点：

1. `registry` 已经按 project 持有 `WorkflowDefinition`；对每个 project 实例化独立的 `WorkItemStore`（rootDir 加 project namespace）+ planner + service。
2. `createServer` 的 `workItems` 注入改成 `workItemsByProject?: Map<string, WorkItemService>`（同时保留 V1 单一 `workItems?` 入参）。
3. 路由层根据 `x-issuepilot-project` header 选择对应 service；header 缺失时：
   - team-mode 下返回 400 `project_header_required`（避免误改错 project）；
   - single-mode 下保留 V1 行为。
4. team-mode 仍**不**自动 poll GitLab（与现有团队 daemon Phase 1 一致）；work-items 完全靠 operator 手动 trigger plan / accept / dispatch（spec 没要求 team-mode 自动 poll）。把这点写进 daemon.ts 顶部注释。
5. team-mode workspace 仍走 V4.1 dispatch-task 路径，但 worktree root 用对应 project 的 `workspace.root`；同时仍维持 `parentIssueLabelMode: "suppressed"`。

- [ ] **步骤 1：写 team daemon work-items 集成测试**

```ts
it("team daemon exposes /api/work-items routes for each enabled project", async () => {/* ... */});
it("team daemon returns 400 when x-issuepilot-project header is missing", async () => {/* ... */});
it("team daemon scopes WorkItemStore directory per project", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/orchestrator/src/team/daemon.ts \
        apps/orchestrator/src/team/__tests__/daemon.test.ts \
        apps/orchestrator/src/team/__tests__/work-items.test.ts
git commit -m "feat(orchestrator): wire V4.1/V4.2 work items into the team daemon"
```

---

## 任务 15：Dashboard API client 扩展

**文件：**

- 修改：`apps/dashboard/lib/api.ts`
- 修改：`apps/dashboard/lib/api.test.ts`

新增：

```ts
export function replanWorkItemTask(
  id: string,
  taskId: string,
  body: ReplanTaskRequest,
  opts?: OperatorActionOptions,
): Promise<{ workItem: WorkItem; plan: TaskPlan }>;

export function markWorkItemTaskRework(
  id: string,
  taskId: string,
  body: MarkTaskReworkRequest,
  opts?: OperatorActionOptions,
): Promise<{ ok: true }>;

export function unskipWorkItemTask(
  id: string,
  taskId: string,
  opts?: OperatorActionOptions,
): Promise<{ ok: true }>;

export function getWorkItemGraph(
  id: string,
  opts?: ApiGetOptions,
): Promise<WorkItemGraphResponse>;
```

`OperatorActionOptions` 已经存在；增加可选 `project?: string`，在 fetch 选项里写 `x-issuepilot-project: <project>` header。client 也提供一个 module-level setter `setActiveWorkItemsProject(project)` 让 `ProjectSwitcher` 设置默认 project；API 调用时优先级：`opts.project` > 默认 `activeProject` > 不带 header。

- [ ] **步骤 1：写 api.test.ts 用例**

```ts
it("replanWorkItemTask POSTs /api/work-items/:id/tasks/:taskId/replan", async () => {/* ... */});
it("propagates x-issuepilot-project header when activeProject is set", async () => {/* ... */});
it("opts.project overrides activeProject", async () => {/* ... */});
it("getWorkItemGraph GETs /api/work-items/:id/graph", async () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts
git commit -m "feat(dashboard): add V4.2 work item API client + project header"
```

---

## 任务 16：Dashboard TaskGraph 组件（topology SVG）

**文件：**

- 新建：`apps/dashboard/components/work-items/task-graph.tsx`
- 新建：`apps/dashboard/components/work-items/task-graph.test.tsx`

实现：

- 接入 `WorkItemGraphResponse`；不依赖图形库，纯 SVG。
- 每个 task 渲染为一个固定宽度 box（标题、status badge），按 `levels[i]` 横向排列、行间距固定。
- `edges` 用 SVG `<path d="M ...">` 绘制，弯折成 orthogonal 二段折线，便于 a11y 测试断言（每条 path 有 `data-from` / `data-to` 属性）。
- `criticalPathTaskIds` 上的 node 用 ring border 强调；`task_run_blocked_by_dependency` 的 edge 用红色虚线。
- 不引入 reactflow / d3。CSS 用现有 Tailwind tokens。

- [ ] **步骤 1：写组件测试**

```ts
it("renders one box per task with status badge", () => {/* ... */});
it("renders one path per edge with data-from / data-to", () => {/* ... */});
it("highlights tasks on the critical path with a 'critical' class", () => {/* ... */});
it("renders an empty placeholder when graph has no tasks", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/work-items/task-graph.tsx \
        apps/dashboard/components/work-items/task-graph.test.tsx
git commit -m "feat(dashboard): render WorkItem task graph as topology SVG"
```

---

## 任务 17：Task-list 操作扩展（replan / mark-rework / unskip / retry needs_rework）

**文件：**

- 修改：`apps/dashboard/components/work-items/task-list.tsx`
- 修改：`apps/dashboard/components/work-items/task-list.test.tsx`
- 新建：`apps/dashboard/components/work-items/replan-task-dialog.tsx`
- 新建：`apps/dashboard/components/work-items/replan-task-dialog.test.tsx`
- 新建：`apps/dashboard/components/work-items/mark-rework-dialog.tsx`
- 新建：`apps/dashboard/components/work-items/mark-rework-dialog.test.tsx`

每个 task 行的按钮可见性表（V4.2）：

| status | Skip | Retry | Mark rework | Replan | Unskip |
| --- | --- | --- | --- | --- | --- |
| `planned` | ✓ | — | — | ✓ | — |
| `ready` | ✓ | — | — | ✓ | — |
| `running` | — | — | — | ✓ | — |
| `completed` | — | — | ✓ | ✓ | — |
| `failed` | — | ✓ | ✓ | ✓ | — |
| `blocked` | — | ✓ | ✓ | ✓ | — |
| `blocked_by_dependency` | ✓ | — | — | ✓ | — |
| `needs_rework` | — | ✓ | — | ✓ | — |
| `skipped` | — | — | — | ✓ | ✓ |

> Replan 全程可点：它生成新 plan version，由 operator 再 accept。

`replan-task-dialog`：弹出 modal，必填 `reason: string`（最少 3 字符），可选 `hint`；点击 `Replan` 调 `replanWorkItemTask`，成功后导航到该 WorkItem 详情页（因为新的 plan 是 draft，需要重新 accept）。
`mark-rework-dialog`：弹出 modal，必填 `reason`；点击 `Mark` 调 `markWorkItemTaskRework`，成功后刷新当前页。

- [ ] **步骤 1：写组件测试（替换 V4.1 现有按钮表的断言）**

```ts
it("shows Replan on all statuses", () => {/* ... */});
it("hides Skip on completed / running / failed / blocked / needs_rework / skipped", () => {/* ... */});
it("shows Unskip only on skipped tasks", () => {/* ... */});
it("ReplanTaskDialog requires a reason ≥ 3 chars before enabling the submit", () => {/* ... */});
it("MarkReworkDialog calls markWorkItemTaskRework with reason and refreshes", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/work-items/task-list.tsx \
        apps/dashboard/components/work-items/task-list.test.tsx \
        apps/dashboard/components/work-items/replan-task-dialog.tsx \
        apps/dashboard/components/work-items/replan-task-dialog.test.tsx \
        apps/dashboard/components/work-items/mark-rework-dialog.tsx \
        apps/dashboard/components/work-items/mark-rework-dialog.test.tsx
git commit -m "feat(dashboard): wire V4.2 replan/mark-rework/unskip task actions"
```

---

## 任务 18：View toggle（list / graph）

**文件：**

- 新建：`apps/dashboard/components/work-items/view-toggle.tsx`
- 新建：`apps/dashboard/components/work-items/view-toggle.test.tsx`
- 修改：`apps/dashboard/components/work-items/work-item-detail.tsx`
- 修改：`apps/dashboard/components/work-items/work-item-detail.test.tsx`

`ViewToggle`：两个 button (`List` / `Graph`)，受控组件，状态存在 URL search param `view=list|graph`（默认 list）。
`work-item-detail`：根据 `view` 渲染 `TaskList` 或 `TaskGraph`；切到 graph 时调 `getWorkItemGraph(id)` 拉数据；切回 list 时不再请求。

- [ ] **步骤 1：组件测试覆盖**

```ts
it("ViewToggle reflects ?view= query param", () => {/* ... */});
it("WorkItemDetail renders TaskList by default", () => {/* ... */});
it("WorkItemDetail renders TaskGraph when view=graph and graph data is ready", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/work-items/view-toggle.tsx \
        apps/dashboard/components/work-items/view-toggle.test.tsx \
        apps/dashboard/components/work-items/work-item-detail.tsx \
        apps/dashboard/components/work-items/work-item-detail.test.tsx
git commit -m "feat(dashboard): add list/graph view toggle for Work Item detail"
```

---

## 任务 19：Project switcher（team-mode）

**文件：**

- 新建：`apps/dashboard/components/work-items/project-switcher.tsx`
- 新建：`apps/dashboard/components/work-items/project-switcher.test.tsx`
- 修改：`apps/dashboard/components/shell/top-bar.tsx`
- 修改：`apps/dashboard/components/work-items/work-items-list.tsx`
- 修改：`apps/dashboard/components/work-items/work-items-list.test.tsx`

`ProjectSwitcher` 行为：

- 通过 `/api/state` 已暴露的 `runtime.mode` 判断 team-mode；single-mode 时组件不渲染。
- 从 `/api/state` 的 `projects` 字段取 project 列表；下拉显示 `projectId`（`group/project` 形态）。
- 选中后写 `localStorage["issuepilot.workItems.activeProject"] = projectId`，并调 `setActiveWorkItemsProject(projectId)`（任务 15 的 api 客户端 setter）。
- 切换后 work-items-list 自动重新 fetch。

- [ ] **步骤 1：组件 + work-items-list 测试**

```ts
it("ProjectSwitcher hides in single-mode", () => {/* ... */});
it("ProjectSwitcher renders options from /api/state projects in team-mode", () => {/* ... */});
it("selecting a project triggers setActiveWorkItemsProject and reloads list", () => {/* ... */});
```

- [ ] **步骤 2：实现 + 通过 + 提交**

```bash
git add apps/dashboard/components/work-items/project-switcher.tsx \
        apps/dashboard/components/work-items/project-switcher.test.tsx \
        apps/dashboard/components/shell/top-bar.tsx \
        apps/dashboard/components/work-items/work-items-list.tsx \
        apps/dashboard/components/work-items/work-items-list.test.tsx
git commit -m "feat(dashboard): add team-mode project switcher for work items"
```

---

## 任务 20：i18n 补丁

**文件：**

- 修改：`apps/dashboard/i18n/messages/zh.json`
- 修改：`apps/dashboard/i18n/messages/en.json`

新增 keys（必须 zh / en 同步，否则 `next-intl` 报 missing key）：

- `workItem.view.list` / `workItem.view.graph`
- `workItem.graph.empty`、`workItem.graph.critical`、`workItem.graph.edge.chained`
- `workItem.action.replan`、`workItem.action.markRework`、`workItem.action.unskip`
- `workItem.dialog.replan.title` / `.reasonLabel` / `.hintLabel` / `.submit` / `.cancel` / `.minReason`
- `workItem.dialog.markRework.title` / `.reasonLabel` / `.submit` / `.cancel`
- `workItem.projectSwitcher.label` / `.placeholder` / `.noProjects`
- `workItem.chaining.banner`（task graph 上下游 chain 时的提示）

- [ ] **步骤 1：补全 keys，使所有 component 测试不再报 missing key**

- [ ] **步骤 2：提交**

```bash
git add apps/dashboard/i18n/messages/zh.json apps/dashboard/i18n/messages/en.json
git commit -m "feat(dashboard): add V4.2 i18n strings (zh + en)"
```

---

## 任务 21：V4.2 端到端

**文件：**

- 新建：`apps/orchestrator/src/__tests__/work-items-v42-e2e.test.ts`

按 spec §16.5 风格写四个 E2E case（共用 fake GitLab + fake Codex + 真 work-items store + 真 daemon wiring）：

1. **Chaining happy path**：plan 包含 T1 → T2 → T3 的线性链。T1 完成、MR `opened`（未 merged）→ T2 应该自动 `ready` 并 dispatch，dispatch 时 `DispatchInput.baseBranch === "origin/<T1-branch>"`；T2 完成后 T3 同理 chain from T2。最后 reviewer 触发 GitLab merge T1 / T2 / T3 → WorkItem complete。
2. **Single-task replan**：plan 接受 → T1 / T2 run 完成 → operator 对 T2 调 `replanTask`：
   - 期望 plan version 从 1 → 2、`replanOf.taskId === "t2"`、新 plan status `draft`。
   - 期望 operator accept v2 后 T1 不会重 dispatch（status / runIds 继承）、T2 重 dispatch（runIds 保留为历史链）。
3. **Mark rework + retry**：所有 task 完成 → operator 在 T2 上调 `markNeedsRework`：
   - 期望 WorkItem.status 从 `completed` 回到 `partial`。
   - 父 Issue label 不主动切回（保持 `human-review`，spec §9.0），但写一条 marker 含 `needs_rework` 的 note。
   - operator 调 `retryTask(t2)` → 期望 T2 重 dispatch，重 dispatch run 在新的 attempt 编号下绑定新 TaskRunLink。
4. **Unskip**：plan 接受 → operator skip T1 → operator 后悔 → 调 `unskipTask(t1)` → 期望 T1 status `ready`、`tickWorkItem` 触发 dispatch。

每个 case 都要断言：

- 没有调用 `gitlab.createIssue`（保留 V4.1 contract）。
- TaskRunLink 在 fs 上的副本与内存一致。
- emit 的 event type 序列包含期望的 V4.2 事件。

- [ ] **步骤 1：写 E2E 测试 → 实现到通过**

> 注意：E2E 测试依赖前面任务 4-14 已经合入；建议在合入顺序上把这个任务排到最后再执行，不要边写边迁。

- [ ] **步骤 2：提交**

```bash
pnpm --filter @issuepilot/orchestrator test -- work-items-v42-e2e
git add apps/orchestrator/src/__tests__/work-items-v42-e2e.test.ts
git commit -m "test(orchestrator): V4.2 e2e (chaining, replan, mark-rework, unskip)"
```

---

## 任务 22：Team-mode E2E

**文件：**

- 修改：`apps/orchestrator/src/team/__tests__/work-items.test.ts`

在任务 14 的集成测试上加一条 end-to-end：

1. team config 含两个 project；
2. 对 project A 触发 plan + accept + tick → 看 work-items dir 在 project A 的 namespace 下；
3. 对 project B 调相同 API（带 `x-issuepilot-project: B`）→ 看不到 project A 的 WorkItem，反之亦然；
4. 不带 header → 400 `project_header_required`。

- [ ] **步骤 1：补 case 到通过**

- [ ] **步骤 2：提交**

```bash
git add apps/orchestrator/src/team/__tests__/work-items.test.ts
git commit -m "test(orchestrator): team daemon isolates work items per project"
```

---

## 任务 23：跨包 build + lint + typecheck + 全量测试

**目标：** 收口前的整仓库 gate，与 V4.1 plan 任务 20 等价。

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

记录测试数：orchestrator 现有 384 + e2e 51；V4.2 至少新增 ~60+ 用例，预计 orchestrator ≥ 440、e2e ≥ 65。

- [ ] **步骤 4：diff 卫生**

```bash
git diff --check
```

---

## 任务 24：文档 + CHANGELOG

**文件：**

- 修改：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- 修改：`README.md`
- 修改：`README.zh-CN.md`
- 修改：`USAGE.md`
- 修改：`USAGE.zh-CN.md`
- 修改：`CHANGELOG.md`

按 `AGENTS.md`：中文文档 + 双语入口同步；命令 / 配置 / 字段保持原文。

- [ ] **步骤 1：spec 实施计划段加 V4.2 链接**

```markdown
- V4.2 Task Graph：`docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`
```

- [ ] **步骤 2：README.md + README.zh-CN.md roadmap**

在 V4.1 条目下面增加 V4.2 已落地条目，包含：依赖图执行、Task Graph 视图、单 task replan、branch chaining、team-mode 接入。

- [ ] **步骤 3：USAGE 增加 §5.8**

英文 + 中文同步：

1. 打开 `/work-items/<id>?view=graph` 看到 Task Graph。
2. 在 task 行点击 `Replan` 提供 reason，新 plan version 出现在 plan history。
3. 在 reviewer 流程里把 task `Mark rework` 反弹回 `needs_rework`，再点 `Retry`。
4. 单 task 跳过后可用 `Unskip` 恢复。
5. team-mode 启动后顶栏使用 Project Switcher 切换 project；所有 work-item API 自动带 `x-issuepilot-project`。

- [ ] **步骤 4：CHANGELOG.md**

```markdown
## [Unreleased] V4.2 Task Graph

- 数据模型：`TaskNode.needsReworkReason`、`TaskPlan.replanOf`、`TaskPlanEdit.field` 增加 `"replan"`。
- 事件：新增 `task_marked_needs_rework` / `task_replanned` / `task_unskipped` / `task_graph_recomputed`。
- orchestrator 新增路由：`POST /api/work-items/:id/tasks/:taskId/replan|mark-rework|unskip`、`GET /api/work-items/:id/graph`。
- 所有 work-item 路由支持 `x-issuepilot-project` header；team daemon 装配 per-project work-items service。
- orchestration 支持单上游 branch chaining：上游 `completed` 且 MR 未 merged 时下游 base = `origin/<上游分支>`，多上游回退为「等所有上游 merged」。
- dashboard 新增 Task Graph SVG 视图、list/graph 切换、单 task replan 对话框、mark rework 对话框、unskip 操作、team-mode project switcher。
- 不变量保持：父 Issue label / handoff note 仍只由 aggregator 经 `decideWorkItemStatus` + `writeParentHandoff` 写入；replan / unskip / mark-rework 都通过 `reconcileWorkItem` 经过同一路径。
```

- [ ] **步骤 5：提交**

```bash
git add docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md \
        README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md CHANGELOG.md
git commit -m "docs: announce V4.2 Task Graph landing"
```

---

## 任务 25（验收）：V4.2 验收检查清单

**目标：** 在 PR 描述里附上下面的自检清单，对应 spec §7 V4.2 + §12.3 + §12.4 + §14.2。该清单还会单独沉淀为 `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph-acceptance.md`（在合入时由实现 agent 落盘，跟 V4.1 acceptance 同源）。

- [ ] 依赖图执行：T1 → T2 链式 dispatch，T2 dispatch 时 `DispatchInput.baseBranch === "origin/<T1-branch>"`（E2E 覆盖）。
- [ ] 多上游依赖回退：T3 dependsOn T1 + T2，其中 T2 未 merged → T3 保持 `blocked_by_dependency`（branch-chain 单测 + E2E 覆盖）。
- [ ] Operator 可以在 dashboard 触发单 task replan，生成新 plan version；非 replan task 的 status / runIds 继承；旧 plan 标 `superseded`。
- [ ] Operator 可以 mark rework / unskip / retry needs_rework，且 WorkItem.status / 父 Issue handoff note 都按 aggregator 路径更新（不绕过 `reconcileWorkItem`）。
- [ ] Dashboard 详情页可在 list / graph 之间切换；graph 视图渲染 levels + edges + critical path 高亮（组件测试覆盖）。
- [ ] team daemon 装配 work-items service：两个 project 互不可见、缺 `x-issuepilot-project` header 400。
- [ ] 全量 `pnpm -r build` / `pnpm -r lint` / `pnpm -r test` 通过；`git diff --check` 干净。
- [ ] 文档 + CHANGELOG 已更新。
- [ ] V4.1 task execution contract 仍然成立（fake GitLab `createIssue` 调用次数为 0；TaskRunLink 是唯一 canonical binding；synthetic task run `parentIssueLabelMode === "suppressed"`；父 Issue label 仍只由 aggregator 写）。

---

## 不变量回顾

- V4.2 不能因为引入 chaining / replan 而让 V4.1 不变量退化：
  - 父 Issue label / handoff note 仍只由 aggregator 路径写。
  - TaskRunLink 是唯一 canonical task ↔ run binding；replan 不复用 runId，旧 link 留作历史证据。
  - 不创建 child GitLab Issue；replan / mark rework / unskip 都只动 IssuePilot 本地状态。
  - synthetic task run 的 `parentIssueLabelMode` 仍是 `suppressed`。
- 单上游 branch chaining 必须能安全 fallback：上游 task 失败或被 mark rework → 已 dispatch 的下游链回到 `blocked_by_dependency` 等 operator 决策，不自动取消下游 in-flight run（in-flight 仍跑完，结果由 aggregator 反映）。
- Task Graph 视图必须能在缺 graph 数据时不阻塞 list 视图加载。
- team-mode work-items namespace 不允许互相穿透；`x-issuepilot-project` 缺失时禁止默认走任一 project。

## 后续阶段（不在本计划范围）

- V4.3 Review Packet + Evidence：自动索引截图 / 录屏 / Playwright walkthrough、CI / 测试结果聚合到 `WorkItemReport.evidence`，并可能引入 reactflow 升级 graph 视图。
- V4.4 Quality Analytics：基于 V4.2 数据出成功率 / 返工率 / branch chaining 命中率指标。
- V4.5 Workflow / Skills Improvement Loop：从 needs_rework / replan 模式出建议 patch。
- V4.6 Multi-Agent / Multi-Runner Collaboration。
