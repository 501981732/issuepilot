# IssuePilot V4.4 Quality Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V4.4 Reports-first Quality Analytics so `/reports` can show success, failure, rework, CI, review, missing-evidence trends and drill down to the exact run / work item / task / evidence behind each signal.

**Architecture:** Add a shared quality analytics contract, a focused orchestrator aggregator under `apps/orchestrator/src/quality/`, a single `GET /api/quality/summary` route, and dashboard components that render the server-derived summary without recomputing facts client-side. Keep storage local-first: consume existing `ReportStore`, `WorkItemStore`, `RunReportArtifact`, `WorkItemReport`, `TaskPlan`, and `TaskRunLink`; do not introduce Postgres or LLM classification.

**Tech Stack:** TypeScript, Node.js 22, Fastify, Vitest, Next.js App Router, React, Tailwind/shadcn-style local components, `@issuepilot/shared-contracts`, existing dashboard i18n JSON.

---

## Scope Check

This plan implements only V4.4 Quality Analytics from `docs/superpowers/specs/2026-05-18-issuepilot-v4-4-quality-analytics-design.md`.

### In Scope

- Shared contract types for `QualitySummaryResponse`, metrics, trends, patterns, dimensions, diagnostics, and drill-down items.
- Pure analytics aggregation from local reports and work-item stores.
- Stable rule-based failure pattern classification.
- `GET /api/quality/summary` with `workflow`, `taskType`, `from`, `to`, `window`, `pattern`, and normalized `status` filters.
- Team-mode project scoping through existing `x-issuepilot-project` / Project Switcher semantics.
- `/reports` Quality Analytics section with summary strip, metric trend selector, failure patterns, and drill-down table.
- Docs and acceptance checklist updates.

### Out of Scope

- V4.5 workflow / skills / prompt improvement recommendations.
- Any automatic patch generation.
- Postgres, external analytics storage, background analytics jobs, or BI-style saved views.
- LLM-based failure classification.
- Changing run status enums or pipeline status enums.
- Changing existing work-item label transitions.

## File Structure

### New Files

- `packages/shared-contracts/src/quality.ts`
  Shared JSON wire contract and type guards for V4.4 quality analytics.

- `packages/shared-contracts/src/__tests__/quality.test.ts`
  Contract tests for metric ids, pattern ids, status filters, response round-trip, and type guards.

- `apps/orchestrator/src/quality/types.ts`
  Internal normalized source item types used by collector, filters, patterns, and aggregator.

- `apps/orchestrator/src/quality/collect.ts`
  Reads `ReportStore` and optional `WorkItemStore` into normalized analytics source items. This file performs no metric math.

- `apps/orchestrator/src/quality/filters.ts`
  Parses query filters and applies project scope, date window, workflow, task type, normalized status, and pattern filters.

- `apps/orchestrator/src/quality/patterns.ts`
  Deterministic failure pattern classifiers.

- `apps/orchestrator/src/quality/aggregate.ts`
  Computes metrics, trends, dimensions, failure pattern summaries, diagnostics, and drill-down items.

- `apps/orchestrator/src/quality/__tests__/collect.test.ts`
- `apps/orchestrator/src/quality/__tests__/filters.test.ts`
- `apps/orchestrator/src/quality/__tests__/patterns.test.ts`
- `apps/orchestrator/src/quality/__tests__/aggregate.test.ts`

- `apps/dashboard/components/reports/quality-analytics.tsx`
  Client component for the Quality Analytics section.

- `apps/dashboard/components/reports/quality-analytics.test.tsx`

- `docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics-acceptance.md`
  Acceptance checklist generated when implementation finishes.

### Modified Files

- `packages/shared-contracts/src/index.ts`
  Re-export `quality.ts`.

- `packages/shared-contracts/src/api.ts`
  Export `QualitySummaryResponse` from the API surface if existing tests expect all HTTP contracts to be reachable from this file.

- `apps/orchestrator/src/reports/store.ts`
  Add `all(): Promise<RunReportArtifact[]>` to `ReportStore` so quality aggregation can read full artifacts rather than summaries.

- `apps/orchestrator/src/server/index.ts`
  Add quality service deps and `GET /api/quality/summary`; enforce team project scope exactly as the spec says.

- `apps/orchestrator/src/server/__tests__/server.test.ts`
  Cover the quality route, project scope, unsupported `project` query, and empty-store behavior.

- `apps/orchestrator/src/daemon.ts`
  Wire single-mode quality aggregation deps into the server.

- `apps/orchestrator/src/team/daemon.ts`
  Wire per-project quality aggregation deps into the server.

- `apps/orchestrator/src/__tests__/daemon.test.ts`
- `apps/orchestrator/src/team/__tests__/daemon.test.ts`

- `apps/dashboard/lib/api.ts`
  Add `getQualitySummary(params, opts)`.

- `apps/dashboard/lib/api.test.ts`

- `apps/dashboard/app/reports/page.tsx`
  Fetch `listReports()` and `getQualitySummary()` together; pass both into `ReportsPage`.

- `apps/dashboard/components/reports/reports-page.tsx`
  Render `QualityAnalytics` above the current per-run table and preserve existing reports UI.

- `apps/dashboard/components/reports/reports-page.test.tsx`

- `apps/dashboard/i18n/messages/en.json`
- `apps/dashboard/i18n/messages/zh.json`

- `README.md`
- `README.zh-CN.md`
- `USAGE.md`
- `USAGE.zh-CN.md`
- `CHANGELOG.md`

---

## Task 1: Shared Quality Contract

**Files:**

- Create: `packages/shared-contracts/src/quality.ts`
- Create: `packages/shared-contracts/src/__tests__/quality.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Modify: `packages/shared-contracts/src/api.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that lock the enum values and response shape:

```ts
import {
  FAILURE_PATTERN_ID_VALUES,
  QUALITY_METRIC_ID_VALUES,
  QUALITY_STATUS_FILTER_VALUES,
  isQualityMetricId,
  isQualityStatusFilter,
  type QualitySummaryResponse,
} from "../quality.js";

describe("quality analytics contracts", () => {
  it("enumerates metric ids", () => {
    expect(new Set(QUALITY_METRIC_ID_VALUES)).toEqual(
      new Set([
        "success-rate",
        "failure-rate",
        "rework-rate",
        "ci-pass-rate",
        "review-hit-rate",
        "missing-evidence-rate",
        "median-duration",
      ]),
    );
    expect(isQualityMetricId("success-rate")).toBe(true);
    expect(isQualityMetricId("cancelled")).toBe(false);
  });

  it("enumerates normalized status filters", () => {
    expect(new Set(QUALITY_STATUS_FILTER_VALUES)).toEqual(
      new Set([
        "run-completed",
        "run-failed",
        "run-blocked",
        "task-needs-rework",
        "task-skipped",
        "report-incomplete",
      ]),
    );
    expect(isQualityStatusFilter("run-failed")).toBe(true);
    expect(isQualityStatusFilter("failed")).toBe(false);
  });

  it("round-trips the summary response", () => {
    const response: QualitySummaryResponse = {
      scope: { mode: "team-project", projectId: "proj-a" },
      filters: {
        from: "2026-05-12T00:00:00.000Z",
        to: "2026-05-18T23:59:59.999Z",
        window: "7d",
        status: "run-failed",
        pattern: "permission-issue",
      },
      metrics: [],
      trends: [],
      failurePatterns: [],
      drilldown: [],
      dimensions: [],
      diagnostics: { invalidReportCount: 0 },
    };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);
  });

  it("enumerates failure pattern ids", () => {
    expect(new Set(FAILURE_PATTERN_ID_VALUES)).toEqual(
      new Set([
        "missing-tests",
        "unclear-requirements",
        "permission-issue",
        "environment-issue",
        "review-rework",
        "ci-failure",
        "missing-evidence",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the failing contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/quality.test.ts
```

Expected: fails because `quality.ts` does not exist.

- [ ] **Step 3: Implement `quality.ts`**

Create the contract with literal arrays and interfaces:

```ts
export const QUALITY_METRIC_ID_VALUES = [
  "success-rate",
  "failure-rate",
  "rework-rate",
  "ci-pass-rate",
  "review-hit-rate",
  "missing-evidence-rate",
  "median-duration",
] as const;

export type QualityMetricId = (typeof QUALITY_METRIC_ID_VALUES)[number];

export const isQualityMetricId = (
  value: unknown,
): value is QualityMetricId =>
  typeof value === "string" &&
  (QUALITY_METRIC_ID_VALUES as readonly string[]).includes(value);

export const FAILURE_PATTERN_ID_VALUES = [
  "missing-tests",
  "unclear-requirements",
  "permission-issue",
  "environment-issue",
  "review-rework",
  "ci-failure",
  "missing-evidence",
] as const;

export type FailurePatternId = (typeof FAILURE_PATTERN_ID_VALUES)[number];

export const QUALITY_STATUS_FILTER_VALUES = [
  "run-completed",
  "run-failed",
  "run-blocked",
  "task-needs-rework",
  "task-skipped",
  "report-incomplete",
] as const;

export type QualityStatusFilter =
  (typeof QUALITY_STATUS_FILTER_VALUES)[number];

export const isQualityStatusFilter = (
  value: unknown,
): value is QualityStatusFilter =>
  typeof value === "string" &&
  (QUALITY_STATUS_FILTER_VALUES as readonly string[]).includes(value);

export type QualityWindow = "7d" | "30d";
export type QualityDirection = "up" | "down" | "flat" | "unknown";

export interface QualitySummaryFilters {
  workflow?: string;
  taskType?: string;
  status?: QualityStatusFilter;
  pattern?: FailurePatternId;
  from: string;
  to: string;
  window: QualityWindow;
}

export interface QualityMetric {
  id: QualityMetricId;
  label: string;
  value: number;
  unit: "percent" | "count" | "duration-ms";
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
  previousValue?: number;
  delta?: number;
  direction: QualityDirection;
}

export interface QualityTrendPoint {
  metricId: QualityMetricId;
  bucketStart: string;
  bucketEnd: string;
  value: number;
  numerator?: number;
  denominator?: number;
  unknownCount?: number;
}

export interface FailurePatternSummary {
  patternId: FailurePatternId;
  label: string;
  count: number;
  rate: number;
  topProject?: string;
  topWorkflow?: string;
  latestReason?: string;
  drilldownCount: number;
}

export interface QualityDrilldownItem {
  itemId: string;
  patternIds: FailurePatternId[];
  reason: string;
  projectId: string;
  workflow?: string;
  taskType?: string;
  issue?: { iid: number; title: string; url?: string };
  workItem?: { workItemId: string; title: string };
  task?: { taskId: string; title: string };
  run?: { runId: string; status: string };
  evidenceId?: string;
  updatedAt: string;
  target:
    | { kind: "run"; href: string }
    | { kind: "work-item"; href: string }
    | { kind: "evidence"; href: string };
}

export interface QualityDimension {
  kind: "workflow" | "task-type" | "status" | "pattern";
  value: string;
  label: string;
  count: number;
}

export interface QualitySummaryResponse {
  scope: { mode: "single-project" | "team-project"; projectId?: string };
  filters: QualitySummaryFilters;
  metrics: QualityMetric[];
  trends: QualityTrendPoint[];
  failurePatterns: FailurePatternSummary[];
  drilldown: QualityDrilldownItem[];
  dimensions: QualityDimension[];
  diagnostics: { invalidReportCount: number };
}
```

Export from `packages/shared-contracts/src/index.ts`:

```ts
export * from "./quality.js";
```

If needed, add to `api.ts`:

```ts
export type { QualitySummaryResponse } from "./quality.js";
```

- [ ] **Step 4: Run contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/quality.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-contracts/src/quality.ts packages/shared-contracts/src/__tests__/quality.test.ts packages/shared-contracts/src/index.ts packages/shared-contracts/src/api.ts
git commit -m "feat(contracts): add quality analytics contract"
```

---

## Task 2: ReportStore Full Artifact Listing

**Files:**

- Modify: `apps/orchestrator/src/reports/store.ts`
- Modify: `apps/orchestrator/src/reports/__tests__/store.test.ts`

- [ ] **Step 1: Write failing store test**

Add a test proving full reports are listed from memory and disk:

```ts
it("lists full report artifacts from memory and disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "issuepilot-report-"));
  const store = createReportStore({ rootDir: root });
  const report = createInitialReport({
    runId: "run-1",
    issue: {
      projectId: "proj-a",
      iid: 1,
      title: "Issue",
      url: "https://gitlab.example/1",
      labels: ["human-review"],
    },
    attempt: 1,
    branch: "issuepilot/1",
    workspacePath: root,
    startedAt: "2026-05-18T00:00:00.000Z",
  });
  await store.save(report);

  await expect(store.all()).resolves.toEqual([report]);
  const fresh = createReportStore({ rootDir: root });
  await expect(fresh.all()).resolves.toEqual([report]);
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/reports/__tests__/store.test.ts
```

Expected: fails because `ReportStore.all()` is absent.

- [ ] **Step 3: Implement `ReportStore.all()`**

Update the interface:

```ts
export interface ReportStore {
  save(report: RunReportArtifact): Promise<void>;
  get(runId: string): Promise<RunReportArtifact | undefined>;
  summary(runId: string): RunReportSummary | undefined;
  allSummaries(): RunReportSummary[];
  all(): Promise<RunReportArtifact[]>;
}
```

Implement by reading `reports/*.json` into the cache:

```ts
async function loadAllFromDisk(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const runId = entry.slice(0, -".json".length);
    if (reports.has(runId)) continue;
    try {
      const body = await readFile(join(dir, entry), "utf8");
      const parsed = JSON.parse(body) as RunReportArtifact;
      reports.set(runId, parsed);
    } catch {
      // V4.4 diagnostics count invalid JSON in the quality collector.
    }
  }
}
```

Use `readdir` from `node:fs/promises`.

- [ ] **Step 4: Run store tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/reports/__tests__/store.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/reports/store.ts apps/orchestrator/src/reports/__tests__/store.test.ts
git commit -m "feat(orchestrator): expose full report artifacts"
```

---

## Task 3: Quality Source Collection

**Files:**

- Create: `apps/orchestrator/src/quality/types.ts`
- Create: `apps/orchestrator/src/quality/collect.ts`
- Create: `apps/orchestrator/src/quality/__tests__/collect.test.ts`

- [ ] **Step 1: Write failing collector tests**

Cover run-only data and work-item task data:

```ts
it("collects run report sources", async () => {
  const report = runReportFixture({
    runId: "run-1",
    projectId: "proj-a",
    status: "completed",
    ciStatus: "success",
  });
  const result = await collectQualitySources({
    reports: { all: async () => [report] },
  });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    kind: "run",
    projectId: "proj-a",
    runId: "run-1",
    runStatus: "completed",
    ciStatus: "success",
  });
});

it("collects work item task sources with effective task status", async () => {
  const workItem = workItemFixture({
    workItemId: "wi-1",
    projectId: "proj-a",
  });
  const plan = planFixture({
    workItemId: "wi-1",
    tasks: [
      taskFixture({
        taskId: "t1",
        status: "needs_rework",
        needsReworkReason: "Reviewer requested tests",
      }),
    ],
  });
  const link = linkFixture({ taskId: "t1", runId: "run-1", status: "completed" });
  const report = workItemReportFixture({
    workItemId: "wi-1",
    overallStatus: "partial",
  });
  const result = await collectQualitySources({
    reports: { all: async () => [] },
    workItems: fakeWorkItemStore({ workItem, plan, links: [link], report }),
  });
  expect(result.items).toContainEqual(
    expect.objectContaining({
      kind: "task",
      projectId: "proj-a",
      workItemId: "wi-1",
      taskId: "t1",
      taskStatus: "needs_rework",
      needsReworkReason: "Reviewer requested tests",
    }),
  );
});
```

- [ ] **Step 2: Run failing collector tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/collect.test.ts
```

Expected: fails because the files do not exist.

- [ ] **Step 3: Implement internal types**

In `types.ts`, define:

```ts
import type {
  PipelineStatus,
  RunReportArtifact,
  RunStatus,
  TaskNodeStatus,
  WorkItemReportStatus,
} from "@issuepilot/shared-contracts";

export type QualitySourceItem =
  | QualityRunSourceItem
  | QualityTaskSourceItem;

export interface QualityRunSourceItem {
  kind: "run";
  projectId: string;
  workflow: string;
  taskType: string;
  runId: string;
  runStatus: RunStatus;
  issue: RunReportArtifact["issue"];
  ciStatus?: PipelineStatus;
  checks: RunReportArtifact["checks"];
  reviewFeedback?: RunReportArtifact["reviewFeedback"];
  risks: RunReportArtifact["handoff"]["risks"];
  lastError?: RunReportArtifact["run"]["lastError"];
  totalMs?: number;
  updatedAt: string;
}

export interface QualityTaskSourceItem {
  kind: "task";
  projectId: string;
  workflow: string;
  taskType: string;
  workItemId: string;
  workItemTitle: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskNodeStatus;
  runId?: string;
  reportStatus?: WorkItemReportStatus;
  needsReworkReason?: string;
  checklistReasons: string[];
  evidenceCount: number;
  updatedAt: string;
}

export interface QualityCollectionResult {
  items: QualitySourceItem[];
  diagnostics: { invalidReportCount: number };
}
```

- [ ] **Step 4: Implement collector**

`collectQualitySources` should accept:

```ts
export interface QualityCollectorDeps {
  reports?: Pick<ReportStore, "all">;
  workItems?: Pick<
    WorkItemStore,
    | "listWorkItems"
    | "getCurrentPlan"
    | "listAllTaskRunLinks"
    | "getReport"
  >;
}
```

Implementation rules:

- Use `reports?.all()` for full `RunReportArtifact[]`.
- For workflow and task type, use `"unknown"` until a durable source exists.
- For task status, use `effectiveTaskStatus(task, latestLink)`.
- For task type, start with `"unknown"`; do not infer from task title.
- For checklist reasons, read `report.humanReviewChecklist`.
- For evidence count, count `report.evidence.byTask[taskId]?.length ?? 0`.
- Return empty arrays when stores are absent.

- [ ] **Step 5: Run collector tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/collect.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/quality/types.ts apps/orchestrator/src/quality/collect.ts apps/orchestrator/src/quality/__tests__/collect.test.ts
git commit -m "feat(orchestrator): collect quality analytics sources"
```

---

## Task 4: Quality Filters

**Files:**

- Create: `apps/orchestrator/src/quality/filters.ts`
- Create: `apps/orchestrator/src/quality/__tests__/filters.test.ts`

- [ ] **Step 1: Write failing filter tests**

Cover default window, invalid filters, normalized status, and pattern composition:

```ts
it("defaults to a 7d window", () => {
  const parsed = parseQualityQuery({}, { now: "2026-05-18T12:00:00.000Z" });
  expect(parsed.filters.window).toBe("7d");
  expect(parsed.filters.to).toBe("2026-05-18T12:00:00.000Z");
  expect(parsed.filters.from).toBe("2026-05-12T12:00:00.000Z");
});

it("rejects unsupported status", () => {
  const result = parseQualityQuery({ status: "failed" }, { now: NOW });
  expect(result.error).toMatchObject({
    code: "invalid_status",
  });
});

it("filters run-failed without treating cancelled as a run status", () => {
  const items = applyQualityFilters(
    [
      runSource({ runId: "a", runStatus: "failed" }),
      runSource({ runId: "b", runStatus: "completed" }),
    ],
    { ...baseFilters, status: "run-failed" },
  );
  expect(items.map((i) => i.kind === "run" && i.runId)).toEqual(["a"]);
});

it("filters task-needs-rework", () => {
  const items = applyQualityFilters(
    [
      taskSource({ taskId: "a", taskStatus: "needs_rework" }),
      taskSource({ taskId: "b", taskStatus: "completed" }),
    ],
    { ...baseFilters, status: "task-needs-rework" },
  );
  expect(items).toHaveLength(1);
});
```

- [ ] **Step 2: Run failing filter tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/filters.test.ts
```

Expected: fails because filters do not exist.

- [ ] **Step 3: Implement query parsing**

`parseQualityQuery` should:

- Accept `{ workflow?: string; taskType?: string; from?: string; to?: string; window?: string; pattern?: string; status?: string; project?: string }`.
- Reject `project` query with `{ code: "project_query_unsupported" }`.
- Support `window=7d|30d`.
- Use explicit `from` / `to` when provided and valid ISO strings.
- Echo `status` and `pattern` into `QualitySummaryResponse.filters`.
- Validate `status` with `isQualityStatusFilter`.
- Validate `pattern` with a new `isFailurePatternId` helper from Task 1. If not present, add it to `quality.ts`.

- [ ] **Step 4: Implement filter application**

`applyQualityFilters(items, filters, opts)` should:

- Filter by date using `updatedAt >= from && updatedAt <= to`.
- Filter workflow / taskType exact string match.
- Filter status according to the table in the spec.
- Filter pattern after pattern classification. To avoid circular imports, accept an optional map:

```ts
export function applyQualityFilters(
  items: QualitySourceItem[],
  filters: QualitySummaryFilters,
  opts: { patternIdsByItemId?: Map<string, FailurePatternId[]> } = {},
): QualitySourceItem[] {
  // ...
}
```

- [ ] **Step 5: Run filter tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/filters.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-contracts/src/quality.ts packages/shared-contracts/src/__tests__/quality.test.ts apps/orchestrator/src/quality/filters.ts apps/orchestrator/src/quality/__tests__/filters.test.ts
git commit -m "feat(orchestrator): add quality analytics filters"
```

---

## Task 5: Failure Pattern Classification

**Files:**

- Create: `apps/orchestrator/src/quality/patterns.ts`
- Create: `apps/orchestrator/src/quality/__tests__/patterns.test.ts`

- [ ] **Step 1: Write failing pattern tests**

Cover every pattern:

```ts
it("classifies permission issues", () => {
  const patterns = classifyQualityPatterns(
    runSource({
      runId: "run-1",
      runStatus: "failed",
      lastError: {
        code: "gitlab_403",
        message: "403 access denied",
        classification: "failed",
      },
    }),
  );
  expect(patterns).toContainEqual(
    expect.objectContaining({
      patternId: "permission-issue",
      reason: expect.stringContaining("403"),
    }),
  );
});

it("classifies missing tests", () => {
  expect(
    classifyQualityPatterns(
      runSource({ checks: [], risks: [], runStatus: "completed" }),
    ).map((p) => p.patternId),
  ).toContain("missing-tests");
});

it("classifies review rework", () => {
  expect(
    classifyQualityPatterns(
      taskSource({
        taskStatus: "needs_rework",
        needsReworkReason: "Reviewer requested unit tests",
      }),
    ).map((p) => p.patternId),
  ).toContain("review-rework");
});
```

Also cover:

- `unclear-requirements`
- `environment-issue`
- `ci-failure`
- `missing-evidence`
- Multiple patterns per item.

- [ ] **Step 2: Run failing pattern tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/patterns.test.ts
```

Expected: fails because `patterns.ts` does not exist.

- [ ] **Step 3: Implement `classifyQualityPatterns`**

Use deterministic string matching:

```ts
export interface ClassifiedPattern {
  patternId: FailurePatternId;
  reason: string;
}

export function classifyQualityPatterns(
  item: QualitySourceItem,
): ClassifiedPattern[] {
  const patterns: ClassifiedPattern[] = [];
  // run and task branches
  return dedupePatterns(patterns);
}
```

Rules:

- `missing-tests`: `run.checks.length === 0`, all checks are `unknown` / `skipped`, or task `evidenceCount === 0`.
- `unclear-requirements`: text contains `acceptance criteria`, `insufficient context`, `scope unclear`, `需求不清`, `验收标准`.
- `permission-issue`: text contains `token`, `credential`, `permission`, `401`, `403`, `access denied`, `unauthorized`.
- `environment-issue`: text contains `workspace`, `mirror`, `dependency`, `install`, `runner`, `codex app-server`, `network`, `timeout`, `dns`.
- `review-rework`: task `needs_rework`, `needsReworkReason`, or run `reviewFeedback.unresolvedCount > 0`.
- `ci-failure`: run `ciStatus === "failed" || ciStatus === "canceled"`.
- `missing-evidence`: task checklist includes `missing-evidence`, report incomplete, or task evidence count is 0.

- [ ] **Step 4: Run pattern tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/patterns.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/quality/patterns.ts apps/orchestrator/src/quality/__tests__/patterns.test.ts
git commit -m "feat(orchestrator): classify quality failure patterns"
```

---

## Task 6: Quality Aggregator

**Files:**

- Create: `apps/orchestrator/src/quality/aggregate.ts`
- Create: `apps/orchestrator/src/quality/__tests__/aggregate.test.ts`

- [ ] **Step 1: Write failing aggregation tests**

Cover metrics exactly:

```ts
it("computes core quality metrics", async () => {
  const result = await buildQualitySummary({
    items: [
      runSource({ runId: "ok", runStatus: "completed", ciStatus: "success" }),
      runSource({ runId: "fail", runStatus: "failed", ciStatus: "failed" }),
      runSource({ runId: "blocked", runStatus: "blocked" }),
      taskSource({ taskId: "t1", taskStatus: "needs_rework" }),
      taskSource({
        taskId: "t2",
        taskStatus: "completed",
        checklistReasons: ["missing-evidence"],
        evidenceCount: 0,
      }),
    ],
    filters: baseFilters,
    scope: { mode: "single-project" },
    diagnostics: { invalidReportCount: 0 },
  });

  expect(metric(result, "success-rate")).toMatchObject({
    numerator: 1,
    denominator: 3,
    value: 33,
  });
  expect(metric(result, "failure-rate")).toMatchObject({
    numerator: 2,
    denominator: 3,
    value: 67,
  });
  expect(metric(result, "ci-pass-rate")).toMatchObject({
    numerator: 1,
    denominator: 2,
    value: 50,
    unknownCount: 1,
  });
  expect(metric(result, "rework-rate").numerator).toBe(1);
  expect(metric(result, "missing-evidence-rate").numerator).toBe(1);
});
```

Also cover:

- Previous-window delta.
- 7d / 30d trend bucket count.
- Pattern summary counts and latest reason.
- Drill-down targets for run, work item, and evidence.
- Empty data stable response.
- `status` and `pattern` filter composition.

- [ ] **Step 2: Run failing aggregation tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/aggregate.test.ts
```

Expected: fails because aggregator does not exist.

- [ ] **Step 3: Implement `buildQualitySummary`**

Signature:

```ts
export interface BuildQualitySummaryInput {
  items: QualitySourceItem[];
  filters: QualitySummaryFilters;
  scope: QualitySummaryResponse["scope"];
  diagnostics: QualitySummaryResponse["diagnostics"];
}

export function buildQualitySummary(
  input: BuildQualitySummaryInput,
): QualitySummaryResponse;
```

Implementation notes:

- Classify all source items before applying `pattern` filter.
- Compute terminal run set from `runStatus` in `completed | failed | blocked`.
- Do not introduce `cancelled` run status; classify cancelled attempts via `lastError.classification`.
- Percent values should be rounded to whole numbers for V4.4 first version.
- Empty denominator yields `value: 0`, `direction: "unknown"`.
- `median-duration` unit is `duration-ms`.
- Generate dimensions for workflow, task-type, status, and pattern.
- Sort failure patterns by `count desc`, then `patternId asc`.
- Sort drill-down by `updatedAt desc`, then `itemId asc`.

- [ ] **Step 4: Run aggregation tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality/__tests__/aggregate.test.ts
```

Expected: pass.

- [ ] **Step 5: Run quality unit suite**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/quality apps/orchestrator/src/quality/__tests__
git commit -m "feat(orchestrator): aggregate quality analytics"
```

---

## Task 7: Quality API Route

**Files:**

- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **Step 1: Write failing server tests**

Add tests near existing reports/work-item route tests:

```ts
it("GET /api/quality/summary returns quality summary", async () => {
  const app = buildServer({
    reports: reportStoreWith([
      runReportFixture({ runId: "ok", status: "completed" }),
      runReportFixture({ runId: "bad", status: "failed" }),
    ]),
  });
  const resp = await app.inject({
    method: "GET",
    url: "/api/quality/summary?window=7d",
  });
  expect(resp.statusCode).toBe(200);
  const body = JSON.parse(resp.body);
  expect(body.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "success-rate" }),
    ]),
  );
});

it("rejects project query to avoid scope ambiguity", async () => {
  const app = buildServer({ reports: reportStoreWith([]) });
  const resp = await app.inject({
    method: "GET",
    url: "/api/quality/summary?project=proj-a",
  });
  expect(resp.statusCode).toBe(400);
  expect(JSON.parse(resp.body)).toMatchObject({
    code: "project_query_unsupported",
  });
});

it("requires x-issuepilot-project in team mode", async () => {
  const app = buildServer({
    reportsByProject: new Map([["proj-a", reportStoreWith([])]]),
  });
  const resp = await app.inject({
    method: "GET",
    url: "/api/quality/summary",
  });
  expect(resp.statusCode).toBe(400);
  expect(JSON.parse(resp.body)).toMatchObject({ code: "project_required" });
});

it("routes team quality summary to the selected project", async () => {
  const app = buildServer({
    reportsByProject: new Map([
      ["proj-a", reportStoreWith([runReportFixture({ projectId: "proj-a" })])],
      ["proj-b", reportStoreWith([runReportFixture({ projectId: "proj-b" })])],
    ]),
  });
  const resp = await app.inject({
    method: "GET",
    url: "/api/quality/summary",
    headers: { "x-issuepilot-project": "proj-b" },
  });
  expect(resp.statusCode).toBe(200);
  expect(JSON.parse(resp.body).scope).toEqual({
    mode: "team-project",
    projectId: "proj-b",
  });
});
```

- [ ] **Step 2: Run failing server tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -- -t "quality"
```

Expected: fails because the route is absent.

- [ ] **Step 3: Add server deps**

Extend `ServerDeps`:

```ts
quality?: {
  reports?: ReportStore;
  workItems?: WorkItemStore;
};
qualityByProject?: Map<
  string,
  {
    reports?: ReportStore;
    workItems?: WorkItemStore;
  }
>;
```

If importing `WorkItemStore` into `server/index.ts` causes dependency cycles, define a small local interface with only the methods `collectQualitySources` needs.

- [ ] **Step 4: Implement route**

Add route:

```ts
app.get<{ Querystring: QualityQuerystring }>(
  "/api/quality/summary",
  async (request, reply) => {
    if (request.query.project !== undefined) {
      return reply
        .code(400)
        .send(routeError("project_query_unsupported", "project query is not supported"));
    }
    const scoped = resolveQualityScope(request.headers["x-issuepilot-project"]);
    if ("error" in scoped) return reply.code(scoped.status).send(scoped.error);
    const parsed = parseQualityQuery(request.query, { now: new Date().toISOString() });
    if (parsed.error) return reply.code(400).send(routeError(parsed.error.code, parsed.error.message));
    const collection = await collectQualitySources(scoped.deps ?? {});
    const summary = buildQualitySummary({
      items: collection.items,
      filters: parsed.filters,
      scope: scoped.scope,
      diagnostics: collection.diagnostics,
    });
    return reply.code(200).send(summary);
  },
);
```

Scope rules:

- Single mode: use `deps.quality ?? { reports: deps.reports, workItems: deps.workItemsStoreIfWired }`.
- Team mode: if `qualityByProject` exists, require `x-issuepilot-project`; unknown id returns 404 `project_not_found`.
- Do not use `project` query.

- [ ] **Step 5: Run server tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -- -t "quality"
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/server/index.ts apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(orchestrator): expose quality summary api"
```

---

## Task 8: Daemon Wiring

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon.test.ts`
- Modify: `apps/orchestrator/src/team/__tests__/daemon.test.ts`

- [ ] **Step 1: Write failing daemon wiring tests**

Add tests that server creation receives quality deps:

```ts
it("wires quality summary deps in single daemon", async () => {
  const serverDeps = await captureServerDepsFromDaemon();
  expect(serverDeps.quality?.reports).toBeDefined();
  expect(serverDeps.quality?.workItems).toBeDefined();
});

it("wires quality deps per project in team daemon", async () => {
  const serverDeps = await captureServerDepsFromTeamDaemon();
  expect(serverDeps.qualityByProject?.has("project-a")).toBe(true);
  expect(serverDeps.qualityByProject?.has("project-b")).toBe(true);
});
```

Use the existing daemon test helpers and spy patterns rather than inventing new launch machinery.

- [ ] **Step 2: Run failing daemon tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/daemon.test.ts src/team/__tests__/daemon.test.ts -- -t "quality"
```

Expected: fails until deps are wired.

- [ ] **Step 3: Wire single daemon**

When `createServer` is called, pass:

```ts
quality: {
  reports: reportStore,
  workItems: workItemStore,
},
```

Use the same `reportStore` and `workItemStore` already used for work-item aggregation.

- [ ] **Step 4: Wire team daemon**

When building per-project services/stores, also build:

```ts
const qualityByProject = new Map<string, QualityServerDeps>();
qualityByProject.set(project.id, {
  reports: projectReportStore,
  workItems: projectWorkItemStore,
});
```

Pass `qualityByProject` to `createServer`.

- [ ] **Step 5: Run daemon tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/daemon.test.ts src/team/__tests__/daemon.test.ts -- -t "quality"
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/daemon.ts apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/__tests__/daemon.test.ts apps/orchestrator/src/team/__tests__/daemon.test.ts
git commit -m "feat(orchestrator): wire quality analytics stores"
```

---

## Task 9: Dashboard API Client

**Files:**

- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/lib/api.test.ts`

- [ ] **Step 1: Write failing API client tests**

Add tests:

```ts
it("getQualitySummary sends query params", async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(qualitySummaryFixture()));
  await getQualitySummary({
    window: "30d",
    status: "run-failed",
    pattern: "permission-issue",
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "http://127.0.0.1:4738/api/quality/summary?window=30d&status=run-failed&pattern=permission-issue",
    expect.objectContaining({ method: "GET" }),
  );
});

it("getQualitySummary uses active project header", async () => {
  setActiveWorkItemsProject("proj-a");
  fetchMock.mockResolvedValueOnce(jsonResponse(qualitySummaryFixture()));
  await getQualitySummary();
  expect(fetchMock).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      headers: expect.objectContaining({ "x-issuepilot-project": "proj-a" }),
    }),
  );
});
```

- [ ] **Step 2: Run failing API tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts -- -t "Quality"
```

Expected: fails because `getQualitySummary` is absent.

- [ ] **Step 3: Implement client**

Add:

```ts
export interface GetQualitySummaryParams {
  workflow?: string;
  taskType?: string;
  from?: string;
  to?: string;
  window?: "7d" | "30d";
  pattern?: FailurePatternId;
  status?: QualityStatusFilter;
}

export function getQualitySummary(
  params: GetQualitySummaryParams = {},
  opts: ApiGetOptions = {},
): Promise<QualitySummaryResponse> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return apiGet<QualitySummaryResponse>(
    `/api/quality/summary${query ? `?${query}` : ""}`,
    opts,
  );
}
```

- [ ] **Step 4: Run API tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts -- -t "Quality"
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts
git commit -m "feat(dashboard): add quality summary client"
```

---

## Task 10: Reports Page Data Flow

**Files:**

- Modify: `apps/dashboard/app/reports/page.tsx`
- Modify: `apps/dashboard/components/reports/reports-page.tsx`
- Modify: `apps/dashboard/components/reports/reports-page.test.tsx`

- [ ] **Step 1: Write failing page/component tests**

Update `ReportsPage` tests so the component requires a `quality` prop:

```ts
render(
  <ReportsPage
    reports={[reportSummaryFixture()]}
    quality={qualitySummaryFixture({
      metrics: [
        metricFixture({ id: "success-rate", label: "Success", value: 50 }),
      ],
    })}
  />,
);
expect(screen.getByText(/Quality Analytics/i)).toBeInTheDocument();
expect(screen.getByText("Success")).toBeInTheDocument();
```

For the route, mock `listReports` and `getQualitySummary` and assert both are called.

- [ ] **Step 2: Run failing dashboard tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/reports-page.test.tsx
```

Expected: fails because `ReportsPage` has no `quality` prop.

- [ ] **Step 3: Update route**

Fetch both APIs in parallel:

```tsx
const [{ reports }, quality] = await Promise.all([
  listReports(),
  getQualitySummary(),
]);
return <ReportsPage reports={reports} quality={quality} />;
```

Preserve the existing error path.

- [ ] **Step 4: Update `ReportsPage` props**

Change:

```ts
interface ReportsPageProps {
  reports: RunReportSummary[];
  quality: QualitySummaryResponse;
}
```

Render a placeholder `<QualityAnalytics summary={quality} />` after Task 11 creates it. Until then, add a temporary minimal section in this task only if needed to make tests compile; Task 11 replaces it.

- [ ] **Step 5: Run dashboard tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/reports-page.test.tsx
```

Expected: pass. If `QualityAnalytics` is not implemented yet, create a minimal skeleton component in this task that renders the section title and accepts the final prop shape; Task 11 will fill in the full UI. Do not leave tests skipped.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/app/reports/page.tsx apps/dashboard/components/reports/reports-page.tsx apps/dashboard/components/reports/reports-page.test.tsx
git commit -m "feat(dashboard): load quality analytics on reports page"
```

---

## Task 11: Quality Analytics UI

**Files:**

- Create: `apps/dashboard/components/reports/quality-analytics.tsx`
- Create: `apps/dashboard/components/reports/quality-analytics.test.tsx`
- Modify: `apps/dashboard/components/reports/reports-page.tsx`
- Modify: `apps/dashboard/i18n/messages/en.json`
- Modify: `apps/dashboard/i18n/messages/zh.json`

- [ ] **Step 1: Write failing UI tests**

Cover summary, trends, patterns, drill-down, and empty state:

```ts
it("renders quality summary metrics", () => {
  render(<QualityAnalytics summary={qualitySummaryFixture()} />);
  expect(screen.getByText(/Quality Analytics/i)).toBeInTheDocument();
  expect(screen.getByText(/Success/i)).toBeInTheDocument();
  expect(screen.getByText(/Failure/i)).toBeInTheDocument();
});

it("filters drilldown when a pattern is selected", async () => {
  const user = userEvent.setup();
  render(<QualityAnalytics summary={qualitySummaryFixture()} />);
  await user.click(screen.getByRole("button", { name: /permission/i }));
  expect(window.location.search).toContain("pattern=permission-issue");
});

it("links drilldown rows to their target", () => {
  render(<QualityAnalytics summary={qualitySummaryFixture()} />);
  expect(screen.getByRole("link", { name: /open source/i })).toHaveAttribute(
    "href",
    "/runs/run-1",
  );
});
```

- [ ] **Step 2: Run failing UI tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/quality-analytics.test.tsx
```

Expected: fails because component does not exist.

- [ ] **Step 3: Implement component**

Implementation guidance:

- Keep layout dense and operator-oriented.
- Do not wrap page sections in nested cards. Use one unframed section with small cards only for repeated metrics/pattern rows.
- Use existing `Card`, `Badge`, `StatusDot`, `MiniBars`, and `Sparkline` helpers.
- Use a segmented control for metric trend selection with native `button`s.
- Use table for drill-down.
- Write URL query using `history.replaceState` so filters are shareable.
- Long project/workflow/task strings should wrap or truncate with `title`.
- Use visible text for non-color status meaning.

Skeleton:

```tsx
export function QualityAnalytics({ summary }: { summary: QualitySummaryResponse }) {
  const t = useTranslations("reportsPage.quality");
  const [metricId, setMetricId] = useState<QualityMetricId>("success-rate");
  const activeTrend = summary.trends.filter((p) => p.metricId === metricId);
  return (
    <section aria-label={t("aria")} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-fg">
          {t("title")}
        </h2>
        <span className="font-mono text-[11px] text-fg-subtle">
          {summary.filters.window}
        </span>
      </div>
      {/* metrics, trend panel, patterns, drilldown */}
    </section>
  );
}
```

- [ ] **Step 4: Add i18n strings**

Add under `reportsPage.quality` in both `en.json` and `zh.json`:

- `aria`
- `title`
- `description`
- `empty`
- `trendTitle`
- `patternsTitle`
- `drilldownTitle`
- `diagnostics`
- `openSource`
- labels for each metric and pattern.

- [ ] **Step 5: Wire into ReportsPage**

In `reports-page.tsx`, render:

```tsx
<QualityAnalytics summary={quality} />
```

Place it after existing counters and before the current daily/report table sections.

- [ ] **Step 6: Run UI tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/quality-analytics.test.tsx components/reports/reports-page.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/components/reports/quality-analytics.tsx apps/dashboard/components/reports/quality-analytics.test.tsx apps/dashboard/components/reports/reports-page.tsx apps/dashboard/components/reports/reports-page.test.tsx apps/dashboard/i18n/messages/en.json apps/dashboard/i18n/messages/zh.json
git commit -m "feat(dashboard): show quality analytics on reports"
```

---

## Task 12: Integration and E2E Coverage

**Files:**

- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`
- Modify: `tests/e2e` only if an existing fake reports/work-items E2E helper already fits; otherwise create `apps/orchestrator/src/__tests__/quality-v44-e2e.test.ts`.

- [ ] **Step 1: Add integration fixture**

Build a fixture with:

- Two run reports:
  - `completed`, CI success, checks passed.
  - `failed`, CI failed, lastError permission issue.
- One work item report:
  - task `t1` completed.
  - task `t2` `needs_rework`.
  - checklist reason `missing-evidence`.
  - evidence link to `/work-items/wi-1?view=evidence`.

- [ ] **Step 2: Write failing integration test**

```ts
it("summarizes V4.4 quality from reports and work items", async () => {
  const app = buildServerWithQualityFixture();
  const resp = await app.inject({
    method: "GET",
    url: "/api/quality/summary?window=7d",
  });
  const body = JSON.parse(resp.body) as QualitySummaryResponse;
  expect(metric(body, "success-rate")).toMatchObject({
    numerator: 1,
    denominator: 2,
  });
  expect(body.failurePatterns.map((p) => p.patternId)).toEqual(
    expect.arrayContaining([
      "permission-issue",
      "ci-failure",
      "review-rework",
      "missing-evidence",
    ]),
  );
  expect(body.drilldown).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        target: { kind: "evidence", href: "/work-items/wi-1?view=evidence" },
      }),
    ]),
  );
});
```

- [ ] **Step 3: Run failing integration test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -- -t "V4.4"
```

Expected: fails until fixture helpers and route behavior are complete.

- [ ] **Step 4: Implement missing fixture helpers**

Keep helpers local to the test file unless shared tests already use equivalent fixture builders.

- [ ] **Step 5: Run integration tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -- -t "V4.4"
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/quality-analytics.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator/src/server/__tests__/server.test.ts tests/e2e apps/orchestrator/src/__tests__
git commit -m "test: cover v4.4 quality analytics flow"
```

If `tests/e2e` is untouched, omit it from `git add`.

---

## Task 13: Documentation and Acceptance

**Files:**

- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `USAGE.md`
- Modify: `USAGE.zh-CN.md`
- Modify: `CHANGELOG.md`
- Create: `docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics-acceptance.md`

- [ ] **Step 1: Write documentation updates**

Update:

- README V4 roadmap: mark V4.4 Quality Analytics as landed after implementation.
- USAGE reports section: explain Quality Summary, Trend, Failure Patterns, Drill-Down, project scope, and that V4.4 does not auto-modify workflow/skills.
- CHANGELOG `[Unreleased]`: add V4.4 Added / Tests entries.
- Acceptance file: checklist mirroring spec §12 and exact validation commands.

- [ ] **Step 2: Run docs check**

Run:

```bash
git diff --check
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md USAGE.md USAGE.zh-CN.md CHANGELOG.md docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics-acceptance.md
git commit -m "docs: document v4.4 quality analytics"
```

---

## Task 14: Final Validation

**Files:**

- No new source files unless validation exposes a bug.

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/quality.test.ts
pnpm --filter @issuepilot/orchestrator exec vitest run src/quality src/server/__tests__/server.test.ts
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/quality-analytics.test.tsx components/reports/reports-page.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run repo gate**

Run:

```bash
scripts/ci-equivalent-check.sh
```

Expected: all stages pass.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only intentional V4.4 implementation changes; no whitespace errors.

- [ ] **Step 4: Update acceptance evidence if needed**

If validation output differs from the acceptance file, update:

```text
docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics-acceptance.md
```

Record exact commands, pass/fail status, and caveats.

- [ ] **Step 5: Commit validation evidence if changed**

```bash
git add docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics-acceptance.md
git commit -m "docs: add v4.4 quality analytics acceptance"
```

Skip this commit if the acceptance doc was already final in Task 13.

---

## Execution Notes

- Do not touch `.superpowers/`; it is a local visual companion artifact and must remain untracked.
- Keep commits task-sized. Do not squash during implementation unless the user asks.
- Keep V4.4 classification deterministic; do not add LLM calls.
- Do not add `cancelled` to `RunStatus`; stopped/cancelled attempts stay `failed` with `lastError.classification === "cancelled"`.
- Do not add `skipped` to `PipelineStatus`; GitLab skipped remains represented by existing tracker coarse status `canceled`.
- Do not add a `project` query parameter. Project scope is only `x-issuepilot-project` in team mode and single-project mode otherwise.
- Use `scripts/ci-equivalent-check.sh` as the final gate.
