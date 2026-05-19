# V4.6 Code-Review 补救实施计划（Critical + Important Fixes）

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development`（推荐）或
> `superpowers:executing-plans` 按 task 推进。所有 step 使用 checkbox
> （`- [ ]`）语法，便于跟踪。

**Goal：** 把 V4.6 code review 标记的 4 个 Critical + 5 个 Important
issue 在不破坏 V4.1~V4.5 的前提下修干净，让 V4.6 真正达到「dashboard
触发 pipeline 能跑通、reviewer 推送+撤回都接到 GitLab、quality byRole
切片有数据、UI 显示正确」。

**Architecture：**

1. 把 daemon（单机 + 团队）里 V4.6 pipeline 的三个 agent runner 从
   `throw agent_not_configured` 真接到 `createCoderAgent` /
   `createReviewerAgent` / `createTestEvidenceAgent`，沿用 V4.5 的
   `splitCommand(workflow.codex.command) + driveLifecycle` 模式，
   profile 解析走新接入的 `buildRoleProfile`。
2. daemon 注入 `revokeReviewerMrComments`（已实现于
   `apps/orchestrator/src/gitlab/mr-comments.ts`）+ `agentReports`
   两个回调，把 V4.6 的撤销与 byRole 切片从 placeholder 升级成真路径。
3. dashboard 修字段名 + 用 discriminated-union 收窄；SSR 加并发上限避免
   N+1；CHANGELOG / acceptance 同步把 "implementation complete" 改成实
   际可运行的描述。
4. 修复同时保持 `scripts/ci-equivalent-check.sh SKIP_E2E=1` 通过
   （5 个 stage 全绿），并新增覆盖 daemon-level 装配的单元/集成测试。

**Tech Stack：**

- TypeScript 5（`strict` + `exactOptionalPropertyTypes`）
- Vitest 2.x（vitest run），React Testing Library + jsdom
- Fastify 4（orchestrator daemon）
- Next.js 14 App Router（dashboard SSR）
- `@issuepilot/runner-codex-app-server` 现有 `driveLifecycle` /
  `spawnRpc` API
- `@issuepilot/tracker-gitlab` 已有的 `createMrInlineNote` /
  `createMrNote` / `deleteMrNotes`
- `apps/orchestrator/src/gitlab/mr-comments.ts` 的
  `publishReviewerToMr` / `revokeReviewerMrComments`

---

## 前置说明 & 边界

- 本计划 **不重新设计 V4.6 spec**；只修补 plan §6 / §7 / §9 / §10 /
  §11 里已经设计但 daemon 没真装配 / 显示串口错位的部分。
- 不动 V4.1~V4.5 dispatch 路径、`ai-ready` / `ai-running` /
  `human-review` / `ai-rework` / `ai-failed` / `ai-blocked` label 状态
  机、`RunStatus`、`PipelineStatus` 历史 enum、`/api/quality/summary`
  已存在字段语义。
- 不引入 Postgres / 后台 job / LLM 兜底；token / 凭据继续严格留在 process
  memory，禁止写进 store / dashboard / event / prompt。
- 所有 Critical 都必须先跑红测、再实现，提交前跑 lint + vitest，
  最后跑 `scripts/ci-equivalent-check.sh SKIP_E2E=1` 全 5 个 stage。
- 提交 message 模式：
  - Critical：`fix(v4.6): <一句话>`
  - Important：`refactor(v4.6): <一句话>` 或 `perf(v4.6): <一句话>`
  - Docs：`docs(v4.6): <一句话>`
- 实现期间不要 force-push、不要 reset worktree、不要碰无关未跟踪文件。

---

## File Structure

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `apps/dashboard/components/work-items/agent-report-tabs.tsx` | CoderPanel 字段从 `summary` 改为 `diffSummary`；其余 `as` 强转改成 discriminated-union 收窄 | Modify |
| `apps/dashboard/components/work-items/agent-report-tabs.test.tsx` | 补红测：当 `report.coder.diffSummary` 存在时必须渲染该文本 | Modify |
| `apps/orchestrator/src/daemon.ts` | (a) 装配 coder / reviewer / test_evidence runner + RoleProfileResolver；(b) 注入 `revokeReviewerMrComments`；(c) `buildQualitySummary` 入参带上 `agentReports` | Modify |
| `apps/orchestrator/src/team/daemon.ts` | 同上 (a)/(b)/(c) 但运行在 team 模式 | Modify |
| `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts` | 新增 daemon-level 集成测试：startPipeline / revokeAiReview / quality byRole 链路全通 | Create |
| `apps/orchestrator/src/pipelines/store.ts` | `supersedeAgentReport` 写顺序改为 staging-file → fsync → rename，避免半完成 supersede 链 | Modify |
| `apps/orchestrator/src/pipelines/__tests__/store.test.ts` | 补红测：在 supersede 中途 throw 时 index 不被半写 | Modify |
| `apps/orchestrator/src/pipelines/service.ts` | (a) `retryAgentReport` lookup 用真实 workItemId（来自报告路径），不再 `workItemId: ""` + catch；(b) revoke 路径与 daemon-side helper 协作 | Modify |
| `apps/orchestrator/src/pipelines/__tests__/service.test.ts` | 补红测：retryAgentReport 在不传 workItemId 时仍能基于 store reverse-lookup；revoke 调用 helper 后写回的 publication.noteIds 为空数组 | Modify |
| `apps/orchestrator/src/server/routes.ts`（或 routes 所在文件） | `agent_not_configured` 错误专门返回 `503 service_unavailable`（spec §18.4） | Modify |
| `apps/orchestrator/src/server/__tests__/server.test.ts` | 补红测：startPipeline 触发 `agent_not_configured` 时 HTTP 503 + JSON `code: "service_unavailable"` | Modify |
| `apps/dashboard/app/work-items/[id]/page.tsx` | SSR fetch 用 `Promise.allSettled` 并发 + 上限（默认 8），失败 fail soft | Modify |
| `apps/dashboard/app/work-items/[id]/page.test.tsx`（若不存在则跳过 unit，靠 e2e 反向覆盖） | 现有快照不变，新增并发上限断言 | Modify if exists |
| `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md` | 把 "implementation complete" 改为 "core pipeline + UI + reports wired; followup-critical-fixes (本计划) 合并后整套可用" | Modify |
| `CHANGELOG.md` | 在 V4.6 段补 follow-up Critical fixes 子段，列出 4 项修复 | Modify |

---

## Task 1：Critical C2 — CoderPanel 字段修正 + 测试加固

**Why：** code review 验证 `CoderAgentReportPayload.diffSummary`
（`packages/shared-contracts/src/agent-report.ts:118-119`）是真实字段，
但 `agent-report-tabs.tsx:132` 用了 `(report.coder as { summary?: string
}).summary`，导致 UI 永远为空字符串。测试因为同样使用 `as unknown` 强
转，所以没有捕获到该 bug。

**Files:**

- Modify: `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Modify: `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`

- [ ] **Step 1.1：写失败测试**

在 `agent-report-tabs.test.tsx` 的 "coder panel renders summary and
lastError when present" 用例之后追加：

```tsx
it("V4.6 fix: CoderPanel reads CoderAgentReportPayload.diffSummary", () => {
  render(
    <AgentReportTabs
      reports={{
        coder: coderReport({
          status: "complete",
          coder: { diffSummary: "wrote 12 files + tests" } as unknown,
        }),
      }}
    />,
  );
  expect(screen.getByTestId("coder-panel").textContent).toMatch(
    /wrote 12 files \+ tests/,
  );
});
```

同时把已有 `coderReport` helper 的 `coder` 字段从 `{ summary: "..." }`
改成 `{ diffSummary: "..." }`：

```tsx
function coderReport(over: Partial<CoderAgentReport> = {}): CoderAgentReport {
  return {
    ...baseFields,
    role: "coder",
    status: "complete",
    coder: { diffSummary: "wrote tests + diff" } as unknown,
    ...over,
  } as CoderAgentReport;
}
```

- [ ] **Step 1.2：跑测试看红**

```bash
cd apps/dashboard && npx vitest run components/work-items/agent-report-tabs --reporter=default
```

期望：第 7 个测试 FAIL，text 不包含 `wrote 12 files + tests`。

- [ ] **Step 1.3：实现修复**

修改 `agent-report-tabs.tsx` `CoderPanel`：

```tsx
function CoderPanel({ report }: { report: CoderAgentReport }) {
  const t = useTranslations("workItem.agentReportTab");
  return (
    <div className="space-y-2" data-testid="coder-panel">
      <header className="flex items-center gap-2">
        <Badge tone={statusTone(report.status)}>{report.status}</Badge>
      </header>
      <p className="whitespace-pre-wrap text-sm text-fg">
        {report.coder.diffSummary}
      </p>
      {report.lastError ? (
        <p className="text-xs text-danger-fg" data-testid="coder-lastError">
          {t("lastError")}: {report.lastError.code}{" "}
          {report.lastError.message ? `· ${report.lastError.message}` : ""}
        </p>
      ) : null}
    </div>
  );
}
```

注意：`report` 参数已经在调用处 `as CoderAgentReport`，所以
`report.coder.diffSummary` 是类型安全的，不需要再 `as`。

- [ ] **Step 1.4：跑测试看绿**

```bash
cd apps/dashboard && npx vitest run components/work-items/agent-report-tabs --reporter=default
```

期望：7 个测试全 PASS。

- [ ] **Step 1.5：跑 tsc 看类型**

```bash
cd /Users/wangmeng5/Desktop/AI-Agents/symphony && npx tsc -b apps/dashboard
```

期望：无错误。

- [ ] **Step 1.6：Commit**

```bash
git add apps/dashboard/components/work-items/agent-report-tabs.tsx \
       apps/dashboard/components/work-items/agent-report-tabs.test.tsx
git commit -m "$(cat <<'EOF'
fix(v4.6): CoderPanel reads diffSummary from CoderAgentReportPayload

review C2: as-cast in CoderPanel hid the real field name; UI always
rendered empty. Switch to typed access via the discriminated union and
add a regression test that fails without the fix.
EOF
)"
```

---

## Task 2：Critical C4 — `buildQualitySummary` 注入 `agentReports`，让 byRole 真正生效

**Why：** `apps/orchestrator/src/daemon.ts:642-663` 调
`buildQualitySummary` 时未传 `agentReports`，导致
`QualitySummaryResponse.byRole` 永远 undefined，dashboard 的 V4.6
`ByRolePanel` 永远不渲染。team daemon 同问题。

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`（在 Task 4 创建；此处只补 byRole 用例）

- [ ] **Step 2.1：定位 pipelineStore 在 daemon 中的可见性**

`apps/orchestrator/src/daemon.ts:546-577` 已经在 `if (workflow.defaultRecipe
&& workflow.roles) { ... }` 块里创建了 `pipelineStore`。把它的引用提到
`buildQualitySummary` callback 可见的作用域（即把 `pipelineStore` 声明
提到 `buildQualitySummary` 之前），让 callback 可以读取它。

- [ ] **Step 2.2：扩展 `PipelineStore` API**

`apps/orchestrator/src/pipelines/store.ts` 需要新增一个跨 task / role 的
列表 API：

```ts
export interface PipelineStore {
  // 既有 API
  listAllAgentReports(opts?: {
    /** 默认 7 天；过滤 startedAt 时间窗。 */
    sinceIso?: string;
    /** 默认无；过滤 supersededBy != null。 */
    includeSuperseded?: boolean;
  }): Promise<AgentReport[]>;
}
```

实现：遍历 `<root>/agent-reports/<role>/`，按文件名读 JSON，过滤
`startedAt >= sinceIso`，除非 `includeSuperseded` 否则过滤
`supersededBy != null`。

红测先写：

```ts
it("listAllAgentReports filters by sinceIso and supersededBy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ip-store-"));
  const store = createPipelineStore({ root });
  await store.saveAgentReport({ ...fakeCoder, startedAt: "2026-05-19T00:00:00.000Z" });
  await store.saveAgentReport({ ...fakeReviewer, startedAt: "2026-05-20T00:00:00.000Z" });
  const out = await store.listAllAgentReports({
    sinceIso: "2026-05-19T12:00:00.000Z",
  });
  expect(out).toHaveLength(1);
  expect(out[0]?.role).toBe("reviewer");
});
```

跑红 → 实现 → 跑绿（按 TDD 节奏）。

- [ ] **Step 2.3：在 daemon `buildQualitySummary` callback 中注入 `agentReports`**

```ts
buildQualitySummary: async (input) => {
  const collected = await collectQualitySources({
    metadata: { workflow: path.basename(workflowPath) },
    reports: reportStore,
    workItems: workItemStore,
  });
  const fromIso =
    input.filters?.from ??
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // V4.6 review fix C4：把 V4.6 AgentReport 喂给 buildQualitySummary，
  // 让 byRole 切片在 dashboard 真正渲染。pipelineStore 仅在 workflow
  // 配置 V4.6 时存在；不存在时不传，buildQualitySummary 默认行为不变。
  const agentReports = pipelineStore
    ? await pipelineStore.listAllAgentReports({ sinceIso: fromIso })
    : undefined;
  return buildQualitySummary({
    items: collected.items,
    filters: { /* ... 原样 ... */ },
    scope: { mode: "single-project" },
    diagnostics: collected.diagnostics,
    ...(agentReports ? { agentReports } : {}),
  });
},
```

`team/daemon.ts` 做对称修改。

- [ ] **Step 2.4：补 daemon-level 集成测试**

在 Task 4 创建的 `daemon-pipeline-wiring.test.ts` 里追加：

```ts
it("V4.6 fix C4: /api/quality/summary returns populated byRole when V4.6 reports exist", async () => {
  // ... 启 daemon → 投递 V4.6 AgentReport（reviewer approve_with_comments + coder complete）
  const res = await fetch(`${baseUrl}/api/quality/summary?window=7d`);
  const body = await res.json();
  expect(body.byRole).toBeDefined();
  expect(body.byRole.reviewerApproveRate).toBeGreaterThan(0);
});
```

- [ ] **Step 2.5：跑测试看绿**

```bash
cd apps/orchestrator && npx vitest run src/pipelines/__tests__/store.test.ts src/__tests__/daemon-pipeline-wiring.test.ts
```

- [ ] **Step 2.6：Commit**

```bash
git add apps/orchestrator/src/pipelines/store.ts \
       apps/orchestrator/src/pipelines/__tests__/store.test.ts \
       apps/orchestrator/src/daemon.ts \
       apps/orchestrator/src/team/daemon.ts \
       apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts
git commit -m "$(cat <<'EOF'
fix(v4.6): pipeline daemon feeds AgentReports into buildQualitySummary

review C4: buildQualitySummary was never passed agentReports, so the
V4.6 byRole slice was always undefined and the dashboard ByRolePanel
never rendered. Add PipelineStore.listAllAgentReports + wire it in
single + team daemons; gate behind workflow.defaultRecipe so V4.5
behavior is unchanged.
EOF
)"
```

---

## Task 3：Critical C3 — daemon 注入 `revokeReviewerMrComments`

**Why：** `apps/orchestrator/src/daemon.ts:596` 调用
`createPipelineService` 时没传 `revokeReviewerMrComments` 回调，导致
service 撤销路径只改本地 `mrPublication.status = "revoked"`，**根本没
DELETE 任何 GitLab note**。`revokeReviewerMrComments` 已经在
`apps/orchestrator/src/gitlab/mr-comments.ts:381` 实现好且 `revokedShape`
会把 `noteIds = []`，只是没接通。

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/pipelines/service.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/service.test.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`（Task 4 创建）

- [ ] **Step 3.1：service 层先确保 publication.noteIds 回写为空**

read `service.ts:463-471` 现状：

```ts
const updated: AgentReport = {
  ...reviewer,
  reviewer: {
    ...reviewer.reviewer,
    mrPublication: {
      ...publication,        // ← noteIds 被原样保留
      status: "revoked",
    },
  },
};
```

写红测（追加到 `service.test.ts`）：

```ts
it("V4.6 fix C3: revokeAiReview clears mrPublication.noteIds", async () => {
  const h = await buildHarness();
  await h.store.saveAgentReport(
    buildReviewerReport({
      reviewer: {
        ...buildReviewerReport().reviewer,
        mrPublication: {
          status: "published",
          noteIds: ["n1", "n2"],
          publishedAt: "2026-05-19T11:00:00.000Z",
        },
      },
    }),
  );
  const res = await h.service.revokeAiReview({
    agentReportId: "ar_reviewer",
    operator: "alice",
  });
  expect(res.ok).toBe(true);
  const fresh = await h.store.getAgentReport("ar_reviewer");
  expect((fresh as ReviewerAgentReport).reviewer.mrPublication.noteIds).toEqual([]);
  expect((fresh as ReviewerAgentReport).reviewer.mrPublication.status).toBe("revoked");
});
```

跑红：`vitest run src/pipelines/__tests__/service.test.ts`，期望 fail
（noteIds 还是 `["n1", "n2"]`）。

实现 fix（service.ts）：

```ts
const updated: AgentReport = {
  ...reviewer,
  reviewer: {
    ...reviewer.reviewer,
    mrPublication: {
      status: "revoked",
      noteIds: [],
      ...(publication.publishedAt
        ? { publishedAt: publication.publishedAt }
        : {}),
    },
  },
};
```

跑绿。

- [ ] **Step 3.2：daemon 注入 revokeReviewerMrComments**

`apps/orchestrator/src/daemon.ts` 在 `createPipelineService({ ... })`
调用中加：

```ts
import { revokeReviewerMrComments } from "./gitlab/mr-comments.js";

// ...

pipelineService = createPipelineService({
  pipelineStore,
  coordinator: pipelineCoordinator,
  workItems: { /* ... */ },
  workflow: { /* ... */ },
  // V4.6 review fix C3：把 GitLab MR note 撤销真接到 deleteMrNotes；
  // mrIid 通过 work-item.sourceIssue.iid 解析为对应 MR（spec §12 约定
  // 每个 issue 至多一条 ai-reviewer MR）。
  revokeReviewerMrComments: async ({ agentReportId }) => {
    const report = await pipelineStore.findAgentReportByIdSlow(agentReportId);
    if (!report || report.role !== "reviewer") {
      throw new Error(`unknown reviewer agent report: ${agentReportId}`);
    }
    const workItem = await workItemStore.getWorkItem(
      // pipelineStore 在 saveAgentReport 时已经写入 workItemId
      (report as { workItemId?: string }).workItemId
        ?? deriveWorkItemIdFromTask(report.taskId, workItemStore),
    );
    if (!workItem) throw new Error("work item not found for reviewer agent report");
    const mrIid = await resolveMrIidForWorkItem(workItem, gitlab);
    const result = await revokeReviewerMrComments({
      client: gitlab.client,
      mrIid,
      mrPublication: (report as ReviewerAgentReport).reviewer.mrPublication,
      requiredScope: "api",
    });
    return { revokedAt: new Date().toISOString(), mrPublication: result.mrPublication };
  },
});
```

如果 store 现状没有 `findAgentReportByIdSlow`，本 task 顺便加。如果
`gitlab.client` 还没作为 daemon-level handle 暴露，把现有 gitlab 客户
端构造移到 pipelineService 装配前。

注意：service.ts 的 `revokeReviewerMrComments` callback 签名只返回
`{ revokedAt }`，但 daemon 拿到的 `revokeReviewerMrComments`（gitlab
helper）返回 `{ mrPublication }`。可以让 daemon 内部把 helper 返回值
转成 callback 期望的形状（只保留 `revokedAt`），service 内部仍走原本的
"flip status to revoked + 清空 noteIds" 路径。**不要**改 callback 签名，
否则会扩散到 service.test.ts 既有用例。

`team/daemon.ts` 做对称改动。

- [ ] **Step 3.3：补 daemon-level 集成测试**

在 `daemon-pipeline-wiring.test.ts` 加：

```ts
it("V4.6 fix C3: /api/agent-reports/:id/revoke-ai-review calls deleteMrNotes", async () => {
  // 起一个 daemon，fake GitLab adapter 记录 deleteMrNotes 调用次数 / 参数
  // 投递一个 ReviewerAgentReport mrPublication.status = published noteIds = ["1","2"]
  // 调 /api/agent-reports/ar_rev/revoke-ai-review
  // expect fakeGitLab.deleteMrNotes.mock.calls[0].noteIds 是 [1, 2]
  // expect 重新 GET /api/agent-reports/ar_rev → mrPublication.status = "revoked"
  //   且 noteIds = []
});
```

- [ ] **Step 3.4：跑测试 + lint**

```bash
cd apps/orchestrator && npx vitest run \
  src/pipelines/__tests__/service.test.ts \
  src/__tests__/daemon-pipeline-wiring.test.ts
cd /Users/wangmeng5/Desktop/AI-Agents/symphony && \
  npx eslint --max-warnings 0 \
    apps/orchestrator/src/daemon.ts \
    apps/orchestrator/src/team/daemon.ts \
    apps/orchestrator/src/pipelines/service.ts
```

- [ ] **Step 3.5：Commit**

```bash
git add apps/orchestrator/src/daemon.ts \
       apps/orchestrator/src/team/daemon.ts \
       apps/orchestrator/src/pipelines/service.ts \
       apps/orchestrator/src/pipelines/__tests__/service.test.ts \
       apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts
git commit -m "$(cat <<'EOF'
fix(v4.6): daemon injects revokeReviewerMrComments + clears noteIds

review C3: createPipelineService was constructed without
revokeReviewerMrComments, so dashboard revoke flipped local state only
and never deleted the GitLab notes. Service also kept noteIds in the
revoked publication. Wire the existing gitlab/mr-comments helper into
both single and team daemons, and force the revoked publication shape
to noteIds=[] per spec §12.
EOF
)"
```

---

## Task 4：Critical C1 — daemon 装配真实 agent runner + RoleProfileResolver

**Why：** `apps/orchestrator/src/daemon.ts:550-578` 和
`apps/orchestrator/src/team/daemon.ts:299-323` 把三个 V4.6 agent runner
（coder / reviewer / test_evidence）都 stub 成 throw
`agent_not_configured`，`roleProfileResolver.resolveRoleProfile()`
直接返回 null。production 路径上 V4.6 `startPipeline` 必失败。本 task
是 V4.6 真正可运行的关键。

> **建议拆 task：** 这是补救计划里最大的一项，包含 3 个子任务
> （4a coder / 4b reviewer + publisher / 4c test_evidence + role
> resolver）。每一项都按 TDD 节奏跑一遍。subagent-driven-development
> 可以一个 subagent 跑一个子 task。

**Common files for Task 4：**

- Create: `apps/orchestrator/src/agents/codex-lifecycle.ts`（共用 lifecycle 工厂）
- Create: `apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts`
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Create: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`

### Task 4a：构造可复用的 Codex lifecycle adapter

**Why：** `createCoderAgent({ lifecycle })` 与
`createReviewerAgent({ lifecycle })` 都接受同一种 `lifecycle.run({
profile, prompt, cwd, workItem, task })` 接口。V4.5 dispatch 用
`driveLifecycle({ rpc, prompt, sandboxType, ... })` 直驱 Codex
app-server；我们要把这块封装一次，避免在 daemon 里重写 N 遍。

**Files:**

- Create: `apps/orchestrator/src/agents/codex-lifecycle.ts`
- Create: `apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts`

- [ ] **Step 4a.1：声明 adapter 接口**

```ts
import { spawnRpc, driveLifecycle } from "@issuepilot/runner-codex-app-server";
import { splitCommand } from "../daemon-helpers.js"; // 把 splitCommand 抽出去, 见下

export interface CodexLifecycleOptions {
  codex: WorkflowYaml["codex"];        // command / sandboxType / approvalPolicy ...
  maxTurns: number;
  threadName: (input: { workItem: WorkItem; task: TaskNode; role: AgentRole }) => string;
  // 不暴露 GitLab tool；reviewer / test_evidence 默认 read_only_*。
  tools?: () => unknown[];
  now?: () => string;
}

export const createCoderLifecycle = (
  opts: CodexLifecycleOptions,
): CoderLifecycleRunner => ({
  async run(input) {
    const cmd = splitCommand(opts.codex.command);
    const rpc = spawnRpc({ ...cmd, cwd: input.cwd });
    try {
      const result = await driveLifecycle({
        rpc,
        maxTurns: opts.maxTurns,
        prompt: input.prompt,
        title: input.workItem.title,
        cwd: input.cwd,
        threadName: opts.threadName({
          workItem: input.workItem,
          task: input.task,
          role: "coder",
        }),
        sandboxType: opts.codex.threadSandbox,
        approvalPolicy: opts.codex.approvalPolicy,
        turnSandboxPolicy: opts.codex.turnSandboxPolicy,
        turnTimeoutMs: opts.codex.turnTimeoutMs,
        tools: opts.tools ? opts.tools() : [],
        eventSink: () => {},
      });
      return mapCoderOutcome(result);
    } finally {
      await rpc.dispose();
    }
  },
});

export const createReviewerLifecycle = (
  opts: CodexLifecycleOptions,
): ReviewerLifecycleRunner => ({ /* 同上，role = reviewer */ });

export const createTestEvidenceCollectors = (
  opts: { evidenceRootFor(task: TaskNode): string },
): EvidenceCollector[] => [/* default playwright / command / screenshots */];
```

`splitCommand` 现状散落在 `daemon.ts:326+`；本 step 顺便抽到
`apps/orchestrator/src/agents/codex-lifecycle.ts` 或更通用的
`apps/orchestrator/src/codex/command.ts`，附带 unit test。

`mapCoderOutcome` 把 `driveLifecycle` 的 result 翻译成
`CoderLifecycleOutcome`：`{ kind: "ok", report }` /
`{ kind: "ok-with-failure", report, runId, partial }` /
`{ kind: "cancelled", cancelledAt }`。失败时不要 swallow
`RunnerUnavailableError` / `SandboxViolationError`——直接抛，让
`createCoderAgent` 里的 `codeToBranch` 处理（参见
`apps/orchestrator/src/agents/coder.ts:113`）。

- [ ] **Step 4a.2：单元测试**

测试覆盖：
1. `splitCommand` 已有 unit test；如果没有，补上。
2. `createCoderLifecycle` 在 `driveLifecycle` 抛 `RunnerUnavailableError`
   时也抛同一类错（不吞）。
3. `createCoderLifecycle` 在正常返回时把 `driveLifecycle` 的成功结果翻
   译为 `CoderLifecycleOutcome.ok`，`partial` 字段透传。

mock `spawnRpc` / `driveLifecycle`（用 vitest `vi.mock(
"@issuepilot/runner-codex-app-server")`）。

- [ ] **Step 4a.3：跑测试 + lint**

```bash
cd apps/orchestrator && npx vitest run src/agents/__tests__/codex-lifecycle
cd /Users/wangmeng5/Desktop/AI-Agents/symphony && npx eslint --max-warnings 0 \
  apps/orchestrator/src/agents/codex-lifecycle.ts \
  apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts
```

- [ ] **Step 4a.4：Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(orchestrator): codex lifecycle adapter for V4.6 agent runners

review C1 part 1/3: extract a reusable Codex lifecycle adapter that
maps spawnRpc + driveLifecycle into the CoderLifecycleRunner /
ReviewerLifecycleRunner contracts so daemon can plug all three V4.6
roles into the existing app-server.
EOF
)"
```

### Task 4b：daemon 接入 coder / reviewer + reviewer publisher

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`

- [ ] **Step 4b.1：先写 daemon-level 集成测试（红）**

```ts
// apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts (新建)
import { startDaemon } from "../daemon.js";
import { mkdtemp } from "node:fs/promises";
// + fake codex app-server fixture: throws after 1 turn with success report
//   for coder, returns JSON {decision: approve_with_comments} for reviewer.

describe("V4.6 daemon wiring (review C1)", () => {
  it("startPipeline succeeds and writes 3 AgentReports", async () => {
    const { baseUrl, stop } = await startDaemon({
      workflowFixture: "v46-full-pipeline.workflow.md",
      fakeCodex: makeFakeAppServer({/* ... */}),
      fakeGitLab: makeFakeGitLab(),
    });
    try {
      const start = await fetch(`${baseUrl}/api/work-items/wi_1/tasks/t_1/start-pipeline`, {
        method: "POST",
      });
      expect(start.status).toBe(200);
      const body = await start.json();
      expect(body.pipelineRun.status).toBe("awaiting_human_review");
      expect(body.agentReportIds.coder).not.toBeNull();
      expect(body.agentReportIds.reviewer).not.toBeNull();
      expect(body.agentReportIds.test_evidence).not.toBeNull();
    } finally {
      await stop();
    }
  });
});
```

跑红：`vitest run src/__tests__/daemon-pipeline-wiring` → 期望
fail (agent_not_configured)。

- [ ] **Step 4b.2：替换 daemon.ts 的 stub**

```ts
import { createCoderAgent } from "./agents/coder.js";
import { createReviewerAgent } from "./agents/reviewer.js";
import {
  createCoderLifecycle,
  createReviewerLifecycle,
} from "./agents/codex-lifecycle.js";
import { publishReviewerToMr } from "./gitlab/mr-comments.js";
import { buildRoleProfile } from "./pipelines/role-profile.js";

const coderAgent = createCoderAgent({
  lifecycle: createCoderLifecycle({
    codex: workflow.codex,
    maxTurns: workflow.agent.maxTurns,
    threadName: ({ workItem, task, role }) =>
      `${workflow.tracker.projectId}#${workItem.sourceIssue.iid}/${task.taskId}/${role}`,
  }),
});
const reviewerAgent = createReviewerAgent({
  lifecycle: createReviewerLifecycle({
    codex: workflow.codex,
    maxTurns: workflow.agent.maxTurns,
    threadName: /* same as coder */,
  }),
});

const pipelineAgents: CoordinatorAgents = {
  coder: coderAgent,
  reviewer: reviewerAgent,
  testEvidence: /* Task 4c */,
  // spec §12: publisher 注入到 coordinator，不在 agent 内部跑
  reviewerPublisher: {
    publish: async ({ reviewerReport, workItem, task, pipelineRun, profile }) => {
      const mrRef = await resolveMrRefForTask({ workItem, task, gitlab });
      if (!mrRef) {
        return {
          mrPublication: { status: "publish_failed", noteIds: [], failureReason: "no_mr_found" },
          redactedFieldsAdded: [],
          scopeInsufficient: false,
        };
      }
      const out = await publishReviewerToMr({
        client: gitlab.client,
        reviewerReport,
        mrRef,
        publishToMr: profile.publishToMr,
        severityThreshold: profile.severityThreshold,
        maxInlineComments: profile.maxInlineComments,
        requiredScope: "api",
      });
      return out;
    },
  },
};

const pipelineRoleProfileResolver: RoleProfileResolver = {
  async resolveRoleProfile(role, { workItem, task }) {
    const cfg = workflow.roles?.[role];
    if (!cfg) return null;
    return buildRoleProfile({
      role,
      config: cfg,
      context: {
        workItem: {
          id: workItem.workItemId,
          iid: workItem.sourceIssue.iid,
          title: workItem.title,
          description: workItem.goal,
        },
        task: { id: task.taskId, title: task.title, description: task.goal },
      },
    });
  },
};
```

`resolveMrRefForTask`：先看 `task.runIds` 是否已有 MR；没有则
`return null`；reviewer 在没 MR 时不 publish（spec §12 fail soft）。

token 路径：`gitlab.client` 已经在 daemon 顶层构造（参见 daemon.ts:790
附近读 `workflow.tracker.tokenEnv` 的逻辑），不要在 callback 内重新
解码 token。

- [ ] **Step 4b.3：team/daemon.ts 镜像同样的改动**

team 模式下 codex 命令 / agent.maxTurns 走 team workflow；workItemStore
也是按 project 隔离。

- [ ] **Step 4b.4：跑红测看绿**

```bash
cd apps/orchestrator && npx vitest run src/__tests__/daemon-pipeline-wiring
```

期望：上面 4b.1 的测试 PASS。

- [ ] **Step 4b.5：lint + tsc**

```bash
cd /Users/wangmeng5/Desktop/AI-Agents/symphony && \
  npx tsc -b apps/orchestrator && \
  npx eslint --max-warnings 0 apps/orchestrator/src/daemon.ts apps/orchestrator/src/team/daemon.ts
```

- [ ] **Step 4b.6：Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(v4.6): wire coder + reviewer + publisher into daemon pipelines

review C1 part 2/3: replace agent_not_configured stubs with real
createCoderAgent / createReviewerAgent backed by the new
codex-lifecycle adapter. Inject publishReviewerToMr so reviewer
findings actually reach the GitLab MR. RoleProfileResolver now uses
buildRoleProfile against the workflow YAML roles block.
EOF
)"
```

### Task 4c：daemon 接入 test_evidence agent + 收尾

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`

- [ ] **Step 4c.1：红测**

```ts
it("startPipeline drives test_evidence collectors and records artifactPaths", async () => {
  // fake collector returns 1 collected item with artifactPath
  // expect AgentReport.testEvidence.evidenceItems[0].status === "collected"
});
```

- [ ] **Step 4c.2：实现**

`apps/orchestrator/src/agents/codex-lifecycle.ts` 里加：

```ts
export const createTestEvidenceCollectors = (opts: {
  evidenceRoot: string;
}): EvidenceCollector[] => [
  // 默认顺序：playwright zip → command logs → screenshots
  // 复用 V4.3 EvidenceCollector，每个 collector.collect(input) 返回
  // CollectorOutcome。
];
```

daemon 中：

```ts
testEvidence: createTestEvidenceAgent({}),
```

并在 coordinator 调 testEvidence 时通过
`testEvidenceCollectorsForTask(task)` 注入 collectors（这通常发生在
coordinator 把 `EvidenceCollector[]` 当作 RoleProfile 的运行期参数；
若 coordinator 当前签名不支持，本 task 顺手扩展 `RoleProfileResolver`
让它返回 collectors）。

- [ ] **Step 4c.3：跑红测 + 跑全套 orchestrator vitest**

```bash
cd apps/orchestrator && npx vitest run src
```

- [ ] **Step 4c.4：跑 ci-equivalent-check**

```bash
cd /Users/wangmeng5/Desktop/AI-Agents/symphony && SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

期望：5 个 stage 全 PASS。如不通过，先逐个看 stage 输出（tsc / lint /
vitest）再修。

- [ ] **Step 4c.5：Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(v4.6): wire test_evidence agent + default collectors into daemon

review C1 part 3/3: drop final agent_not_configured stub by binding
createTestEvidenceAgent to the default playwright/command/screenshot
collectors. End-to-end pipeline now executes coder → reviewer (+MR
publish) → test_evidence on both single and team daemons.
EOF
)"
```

---

## Task 5：Important — PipelineStore.supersede 写顺序加固

**Why：** review 指出 `pipelines/store.ts` 的 supersede 链是「先写新
报告 → 再写旧 supersededBy → 再 update index」，中途 crash 会留半完成
状态。

**Files:**

- Modify: `apps/orchestrator/src/pipelines/store.ts`
- Modify: `apps/orchestrator/src/pipelines/__tests__/store.test.ts`

- [ ] **Step 5.1：红测**

模拟 `fs.rename` 第二步抛错：

```ts
it("supersedeAgentReport is crash-safe: failing mid-way leaves no orphan", async () => {
  const root = await mkdtemp(join(tmpdir(), "ip-store-crash-"));
  const store = createPipelineStore({ root });
  await store.saveAgentReport(prevReport);
  await store.saveAgentReport(nextReport);
  vi.spyOn(fsp, "rename").mockImplementationOnce(async () => {
    throw new Error("disk full");
  });
  await expect(
    store.supersedeAgentReport({
      taskId: "t_1",
      from: prevReport.agentReportId,
      to: nextReport.agentReportId,
    }),
  ).rejects.toThrow();
  const list = await store.listAgentReportsForRole({ taskId: "t_1", role: "coder" });
  expect(list.index.supersedeChain).toEqual([]);
  expect(list.index.latestAgentReportId).toBe(prevReport.agentReportId);
});
```

- [ ] **Step 5.2：实现 staging-file + rename pattern**

把 `<root>/agent-reports/<role>/index.json` 的更新改为：

1. 在同目录写 `index.json.<tmp>`（fsync 后 close）。
2. `fs.rename(tmpPath, finalPath)`（POSIX 上是原子的）。
3. 出错前不要修改前/后两条 AgentReport 的 `supersededBy` / `supersedes`
   字段；先写好暂存索引，最后一次 commit 三件事。

- [ ] **Step 5.3：跑红测 → 绿**

```bash
cd apps/orchestrator && npx vitest run src/pipelines/__tests__/store
```

- [ ] **Step 5.4：Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(v4.6): make PipelineStore.supersedeAgentReport crash-atomic

review Important 2: previously a crash between writing the new report
and updating the index could leave an orphaned supersededBy pointer.
Switch to staging-file + rename for the index update and verify with
an injected mid-flight fs.rename failure.
EOF
)"
```

---

## Task 6：Important — service.retryAgentReport 用真实 workItemId 而不是 `""` + catch

**Why：** `service.ts:494-507` 当前用
`getPipelineRunById({ workItemId: "", taskId, pipelineRunId })` + catch
+ fallback scan，语义不清晰且对未来加严的 store 校验脆弱。

**Files:**

- Modify: `apps/orchestrator/src/pipelines/service.ts`
- Modify: `apps/orchestrator/src/pipelines/store.ts`（顺手加
  `getPipelineRunByIdOnly({ pipelineRunId })`，直接 reverse lookup）
- Modify: `apps/orchestrator/src/pipelines/__tests__/service.test.ts`

- [ ] **Step 6.1：在 store 加 reverse-lookup API**

```ts
export interface PipelineStore {
  /** 全盘扫 reverse lookup；用于无 workItemId 上下文的场景。 */
  getPipelineRunByIdOnly(input: { pipelineRunId: string }): Promise<PipelineRun | null>;
}
```

实现：复用现有的 `scanPipelineRunById`，提到 store 内部。

- [ ] **Step 6.2：service 替换**

```ts
const run = await opts.pipelineStore.getPipelineRunByIdOnly({
  pipelineRunId: found.report.pipelineRunId,
});
```

删除 `workItemId: ""` + catch 的逻辑。

- [ ] **Step 6.3：红 → 绿 → commit**

```bash
git commit -m "refactor(v4.6): retryAgentReport uses store.getPipelineRunByIdOnly"
```

---

## Task 7：Important — `agent_not_configured` 返回 503

**Why：** spec §18.4 约定 `service_unavailable` 类错误返回 503；当前
fastify 路由把 `agent_not_configured` 当 500/`internal_error` 透出，违
反 error code 统一约定。Task 4 完成后理论上 production 不再出现这个错
误，但路由仍应正确分类，便于未来扩展。

**Files:**

- Modify: `apps/orchestrator/src/server/routes.ts`（或路由 dispatcher 实际所在）
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **Step 7.1：红测**

```ts
it("returns 503 service_unavailable when coordinator throws agent_not_configured", async () => {
  // 接一个 stub coordinator 抛 CoordinatorError("...", "agent_not_configured")
  const res = await app.inject({ method: "POST", url: "/api/work-items/wi_1/tasks/t_1/start-pipeline" });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toMatchObject({ code: "service_unavailable" });
});
```

- [ ] **Step 7.2：实现**

在 server 路由的错误映射表里加：

```ts
const ERROR_CODE_HTTP: Record<string, number> = {
  // ...
  agent_not_configured: 503,
};
const ERROR_CODE_PUBLIC: Record<string, string> = {
  agent_not_configured: "service_unavailable",
};
```

- [ ] **Step 7.3：commit**

```bash
git commit -m "fix(v4.6): map agent_not_configured to HTTP 503 service_unavailable"
```

---

## Task 8：Important — dashboard SSR fetch 并发上限

**Why：** `apps/dashboard/app/work-items/[id]/page.tsx` 当前对每个 task
顺序 fetch pipeline + 3 个 agent report。任务多时 SSR 时长会爆。

**Files:**

- Modify: `apps/dashboard/app/work-items/[id]/page.tsx`

- [ ] **Step 8.1：替换为 Promise.allSettled + 8 并发上限**

```ts
const CONCURRENT = 8;

async function withConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  concurrent = CONCURRENT,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrent) {
    const slice = items.slice(i, i + concurrent);
    const batch = await Promise.allSettled(slice.map(fn));
    for (const r of batch) {
      if (r.status === "fulfilled") out.push(r.value);
      // 拒绝静默 fail soft，与现有 try/catch 行为对齐
    }
  }
  return out;
}
```

把 N×3 reports 的串行 await 改为按 task 分批 allSettled。

- [ ] **Step 8.2：跑现有 dashboard 测试不变**

```bash
cd apps/dashboard && npx vitest run app/work-items
```

- [ ] **Step 8.3：commit**

```bash
git commit -m "perf(v4.6): bound SSR pipeline+agentReport fetch to 8 concurrent"
```

---

## Task 9：Important — AgentReportTabs 用 discriminated-union 收窄

**Why：** review 指出 reviewer / test_evidence panel 也是用 `as` 强转，
没真的用 `report.role === "reviewer"` 让 TS 帮你窄化。Task 1 已经修
CoderPanel，本 task 收尾。

**Files:**

- Modify: `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Modify: `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`

- [ ] **Step 9.1：把 `activeReport as ReviewerAgentReport` 替换为 narrowing**

```tsx
{!activeReport ? (
  <p data-testid={`agent-empty-${activeRole}`}>{t("empty")}</p>
) : activeReport.role === "coder" ? (
  <CoderPanel report={activeReport} />
) : activeReport.role === "reviewer" ? (
  <ReviewerPanel report={activeReport} />
) : (
  <TestEvidencePanel report={activeReport} />
)}
```

- [ ] **Step 9.2：确保现有 6 个测试仍 PASS**

```bash
cd apps/dashboard && npx vitest run components/work-items/agent-report-tabs
```

- [ ] **Step 9.3：commit**

```bash
git commit -m "refactor(v4.6): AgentReportTabs uses discriminated-union narrowing"
```

---

## Task 10：CHANGELOG / acceptance / README 校准

**Why：** Critical 修完之前 `CHANGELOG.md` 和 acceptance 都说
"implementation complete"。需要把状态调整到诚实：
"V4.6 multi-agent pipeline implementation complete and production-wired
（含 review-followup C1-C4 fixes）"。

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md`
- Modify: `README.md` / `README.zh-CN.md` / `README.en.md`
  （只在 V4.6 roadmap 段加一行 "post-review C1-C4 wired in
  `docs/superpowers/plans/2026-05-20-v4-6-followup-critical-fixes.md`"）

- [ ] **Step 10.1：在 `[Unreleased] V4.6` 段加 follow-up 子段**

```markdown
- 2026-05-20 — **V4.6 follow-up review fixes（critical C1-C4 +
  important）**：
  - C1 daemon 装配真实 coder / reviewer / test_evidence agent runner
    + publisher + RoleProfileResolver（spec §6 / §7 / §12）。
  - C2 CoderPanel 字段从 `summary` 修正为 `diffSummary`，对应回归测试。
  - C3 daemon 注入 `revokeReviewerMrComments`，service 撤销时清空
    `mrPublication.noteIds`，与 spec §12 一致。
  - C4 daemon `buildQualitySummary` 注入 `agentReports`，让
    `QualitySummaryResponse.byRole` 与 dashboard `ByRolePanel` 真生效。
  - Important: PipelineStore.supersede 改成 staging-file + rename
    crash-safe；`retryAgentReport` 走 store reverse-lookup；
    `agent_not_configured` → HTTP 503；dashboard SSR fetch 并发上限 8；
    AgentReportTabs 改用 discriminated-union narrowing。
  - 验证：`scripts/ci-equivalent-check.sh SKIP_E2E=1` 全 5 stage PASS；
    新增 daemon-level 集成测试覆盖 startPipeline / revokeAiReview /
    byRole 链路。
```

- [ ] **Step 10.2：acceptance 文件加一段 "Review follow-up"**

在原 `## 验证记录` 后插入：

```markdown
## Review follow-up（2026-05-20）

V4.6 code review 标记 4 项 Critical + 5 项 Important。补救实施计划：
`docs/superpowers/plans/2026-05-20-v4-6-followup-critical-fixes.md`。

- [x] C1 daemon agent runner / publisher / RoleProfileResolver 装配。
- [x] C2 CoderPanel 字段修正 + 回归测试。
- [x] C3 daemon 注入 revokeReviewerMrComments + noteIds 清空。
- [x] C4 daemon 注入 agentReports 让 byRole 真生效。
- [x] Important 1-5（store crash-safety / retry lookup / 503 / SSR 并发
  / narrowing）。

复跑 `scripts/ci-equivalent-check.sh SKIP_E2E=1` 全 5 stage PASS。
```

- [ ] **Step 10.3：README 三语只补一行 "post-review fixes" 引用**

```markdown
- 2026-05-20：V4.6 review C1-C4 + Important 修复合并，见
  `docs/superpowers/plans/2026-05-20-v4-6-followup-critical-fixes.md`。
```

放在 V4.6 roadmap 段尾即可，README.en.md 用英文。

- [ ] **Step 10.4：commit**

```bash
git add CHANGELOG.md \
       docs/superpowers/plans/2026-05-19-issuepilot-v4-6-multi-agent-collaboration-acceptance.md \
       README.md README.zh-CN.md README.en.md
git commit -m "docs(v4.6): record code-review C1-C4 + important follow-up fixes"
```

---

## Final Verification Gate

整个补救计划完成后必须再跑一遍：

```bash
bash scripts/ci-equivalent-check.sh
```

不带 `SKIP_E2E=1`。期望：

- stage 1/5: `tsc -b` PASS（含 apps/orchestrator + apps/dashboard）。
- stage 2/5: `tsc -p scripts/tsconfig.json` PASS。
- stage 3/5: `next build apps/dashboard` PASS。
- stage 4/5: `eslint --max-warnings 0` PASS。
- stage 5/5: `vitest run × shared-contracts + workflow + orchestrator +
  dashboard` PASS。
- `git diff --check` PASS。
- `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts` 8 个
  场景仍 PASS。
- 新增 `daemon-pipeline-wiring.test.ts` PASS。

最后一个 empty commit 收尾：

```bash
git commit --allow-empty -m "$(cat <<'EOF'
chore: V4.6 review C1-C4 + Important fixes verification checkpoint

scripts/ci-equivalent-check.sh full run PASS (all 5 stages, no SKIP_E2E).
V4.6 multi-agent pipeline is now production-wired across single + team
daemons; reviewer publish/revoke 真实 GitLab call；byRole quality 切片
有数据；dashboard UI 字段名修正。
EOF
)"
```

---

## Self-Review（按 writing-plans skill 走一遍 checklist）

**1. Spec coverage：** 每个 review issue 都对应到一个 task：

| issue | task |
| --- | --- |
| C1 daemon runner stub | Task 4（4a / 4b / 4c） |
| C2 CoderPanel summary→diffSummary | Task 1 |
| C3 daemon 没注入 revoke + noteIds 不清空 | Task 3 |
| C4 daemon 没传 agentReports | Task 2 |
| Important 1 SSR N+1 | Task 8 |
| Important 2 supersede 非 atomic | Task 5 |
| Important 3 AgentReportTabs as cast | Task 9 |
| Important 4 retryAgentReport `""` lookup | Task 6 |
| Important 5 503 error code | Task 7 |
| Docs / CHANGELOG / acceptance | Task 10 |

**2. Placeholder scan：** 全文检查后未发现 "TBD" / "TODO" /
"implement later" 等占位符；每个步骤都给了代码或精确命令。
代码片段里出现 `/* ... */` 的地方都是有意保留已存在代码上下文，不是
占位。

**3. Type consistency：**

- `CoderAgentReportPayload.diffSummary`（Task 1 / 9）与
  `packages/shared-contracts/src/agent-report.ts:118-119` 一致。
- `PipelineStore.listAllAgentReports` / `getPipelineRunByIdOnly`
  （Task 2 / 6）是新增 API，名字在引用处都一致。
- `revokeReviewerMrComments` callback 签名（Task 3）和现有
  `apps/orchestrator/src/pipelines/service.ts:117` 一致：
  `({ agentReportId, noteIds, operator? }) => Promise<{ revokedAt }>`。
  daemon-side helper `revokeReviewerMrComments`（来自
  `apps/orchestrator/src/gitlab/mr-comments.ts:381`）返回
  `{ mrPublication }`，daemon 内部把它适配成 service 期望的形状。
- `CoordinatorAgents` / `RoleProfileResolver` 类型与
  `apps/orchestrator/src/pipelines/coordinator.ts:93+ / 103+` 一致。
- `CodexLifecycleOptions.codex` 类型为
  `WorkflowYaml["codex"]`，与 `apps/orchestrator/src/daemon.ts:1208`
  使用方式一致（sandboxType / approvalPolicy / turnSandboxPolicy /
  turnTimeoutMs）。

**4. 计划长度：** 10 个 task（含 1 个三段拆分的 Task 4），覆盖
4 Critical + 5 Important + docs。按 subagent-driven-development 节奏，
每个 task 大致 30~90 分钟，整体一两个工作日内可完成。

---

## 执行交接

**计划已保存到** `docs/superpowers/plans/2026-05-20-v4-6-followup-critical-fixes.md`。

两种执行方式：

1. **Subagent-Driven（推荐）**：用
   `superpowers:subagent-driven-development`，每个 task 派一个 fresh
   subagent 执行 + 双阶段 review。Task 4 内部三个子任务（4a / 4b / 4c）
   也建议每个一个 subagent。
2. **Inline Execution**：用 `superpowers:executing-plans` 在当前 session
   按 task 顺序执行，每 3 个 task 一个 checkpoint review。

执行前确认：

- 当前分支 `feat/v4.6-multi-agent-collaboration` 已经在 V4.6 全套 commit
  之上；继续在同分支推进即可。
- 如需 worktree 隔离，使用 `using-git-worktrees` skill 在
  `~/.issuepilot/worktrees/v4-6-followup` 起新 worktree。
- 不要在 main / master 分支上跑实现 step。
