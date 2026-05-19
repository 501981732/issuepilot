# IssuePilot V4.5 Improvement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build V4.5 Workflow / Skills Improvement Loop: generate evidence-backed `ImprovementRecommendation` records from V4.4 quality facts, let operators review them in `/reports`, and produce inert patch previews without silently modifying files.

**Architecture:** Add shared contracts in `@issuepilot/shared-contracts`, then implement an orchestrator `improvements` module with focused files for store, templates, engine, patch preview, and service/routes. Wire single-mode and team-mode stores through Fastify, then add dashboard API clients and a compact Recommendations section under the existing Reports / Quality Analytics page.

**Tech Stack:** TypeScript, Fastify, Next.js 14, React 18, next-intl, Tailwind/shadcn-style local primitives, Vitest, `scripts/ci-equivalent-check.sh`.

---

## Scope Check

本计划只实现 `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md` 描述的 V4.5 Improvement Loop。任务粒度与 V4.4 plan
（`docs/superpowers/plans/2026-05-18-issuepilot-v4-4-quality-analytics.md`）保持一致：TDD 节奏（先写失败测试再实现）、每个 task
一个 commit、最终用 `scripts/ci-equivalent-check.sh` 收口。

### In Scope

- Shared contract（`@issuepilot/shared-contracts/src/improvement.ts`）：`ImprovementRecommendation`、`ImprovementPatchPreview`、`ImprovementEvidenceRef`、`ImprovementActionHistoryEntry`、`ImprovementRecommendationStatus`、`ImprovementTargetKind` 及对应 type guard。
- Orchestrator `improvements` 模块（`apps/orchestrator/src/improvements/`）：deterministic 模板、engine、本地 JSON store、patch preview 生成、service 与 Fastify routes。
- `GET /api/improvements/recommendations`、`GET /api/improvements/recommendations/:id`、`POST /api/improvements/recommendations:generate`、`POST /api/improvements/recommendations/:id/{accept,reject,defer}`、`POST /api/improvements/recommendations/:id/patch-preview`。
- Daemon 装配：single 与 team 模式分别注入 `improvements` 与 `improvementsByProject` deps（与 V4.4 quality 同款 resolver pattern）。
- Dashboard：`apps/dashboard/lib/api.ts` 客户端、`/reports` 顶部新增 Improvement Recommendations section、中英 i18n。
- 文档：README 中 / 中-alias / 英三份 V4 roadmap、`USAGE.md` / `USAGE.zh-CN.md`、`CHANGELOG.md` `[Unreleased]`、acceptance 文件。
- 测试：`packages/shared-contracts` contract round-trip、各 improvements 单测、`apps/orchestrator/src/__tests__/improvements-v45-e2e.test.ts` 端到端、dashboard 客户端/UI 单测。

### Out of Scope

- 自动应用 patch、自动 commit、自动改写 `WORKFLOW.md` / `.agents/skills/*` / `AGENTS.md` / 项目规则等文件（保持 V4.5 inert）。
- 引入 LLM 作为第一版分类器或建议生成器；模板与失败模式映射全部 deterministic。
- 任何 Postgres / 外部分析存储 / 后台分析 job；仍走 `~/.issuepilot/<scope>/recommendations/<id>.json` 本地 JSON。
- 修改 `RunStatus` / `PipelineStatus` 枚举、`ai-ready` / `ai-running` / `human-review` / `ai-rework` / `ai-failed` / `ai-blocked` 等 work-item label 状态机、`x-issuepilot-project` header 之外的 team scope 机制。
- 反向修改 V4.4 `apps/orchestrator/src/quality/*` 模块、`/api/quality/summary` 契约、`apps/dashboard/components/reports/quality-analytics.tsx`。
- 任何写 secret / token 到 store、prompt、log、dashboard 状态的行为；`AGENTS.md` 不变量。
- 触碰 `elixir/` 目录（Symphony Elixir 参考实现，不在 IssuePilot 实现路线）。

---

## File Structure

### Shared Contracts

- Create `packages/shared-contracts/src/improvement.ts`
  - Owns stable JSON wire types: target kinds, statuses, evidence refs, patch preview, action history, request/response types.
  - Exports type guards for API parsing: `isImprovementRecommendationStatus()`, `isImprovementTargetKind()`.
- Modify `packages/shared-contracts/src/index.ts`
  - Re-export `./improvement.js`.
- Modify `packages/shared-contracts/src/api.ts`
  - Re-export improvement API request/response types for dashboard/orchestrator callers.
- Create `packages/shared-contracts/src/__tests__/improvement.test.ts`
  - Covers enum guards, stable JSON round-trip, and generated/blocked/stale patch-preview shapes.
- Modify `packages/shared-contracts/src/__tests__/index.test.ts`
  - Verifies `ImprovementRecommendation` exports from package root.

### Orchestrator Improvements Module

- Create `apps/orchestrator/src/improvements/types.ts`
  - Internal candidate types derived from `QualitySummaryResponse`.
- Create `apps/orchestrator/src/improvements/templates.ts`
  - Deterministic `FailurePatternId -> recommendation template` mapping.
- Create `apps/orchestrator/src/improvements/engine.ts`
  - Builds/dedupes recommendations, computes confidence/risk, updates stale/superseded records.
- Create `apps/orchestrator/src/improvements/store.ts`
  - Local JSON store under `recommendations/<id>.json`, redacted before write, with team-mode project scoping through per-project root dirs.
- Create `apps/orchestrator/src/improvements/patch-preview.ts`
  - Generates inert unified-diff-style previews for prompt/project/workflow/skill targets and records `sourceSnapshot.sha256`.
- Create `apps/orchestrator/src/improvements/service.ts`
  - High-level service for list/detail/generate/actions/patch-preview.
- Create `apps/orchestrator/src/improvements/routes.ts`
  - Fastify route registration helper used by `server/index.ts`.
- Add tests:
  - `apps/orchestrator/src/improvements/__tests__/templates.test.ts`
  - `apps/orchestrator/src/improvements/__tests__/engine.test.ts`
  - `apps/orchestrator/src/improvements/__tests__/store.test.ts`
  - `apps/orchestrator/src/improvements/__tests__/patch-preview.test.ts`
  - `apps/orchestrator/src/improvements/__tests__/service.test.ts`

### Orchestrator Wiring

- Modify `apps/orchestrator/src/server/index.ts`
  - Add `ImprovementService` interface and `improvements` / `improvementsByProject` deps.
  - Register `/api/improvements/recommendations*` routes.
  - Preserve team-mode `x-issuepilot-project` isolation and reject `project` query.
- Modify `apps/orchestrator/src/server/__tests__/server.test.ts`
  - Add API route coverage for single mode, team mode, unknown project, action history, and patch preview no-write behavior.
- Modify `apps/orchestrator/src/daemon.ts`
  - Create single-mode improvement store/service using the same `~/.issuepilot` root as reports/work-items.
- Modify `apps/orchestrator/src/team/daemon.ts`
  - Create per-project improvement store/service under each project `workflow.workspace.root/.issuepilot`.

### Dashboard

- Modify `apps/dashboard/lib/api.ts`
  - Add list/detail/generate/action/patch-preview clients with active project header support.
- Modify `apps/dashboard/lib/api.test.ts`
  - Cover query serialization, project headers, operator headers, and action endpoints.
- Create `apps/dashboard/components/reports/recommendations.tsx`
  - Client component for queue, detail, action buttons, and patch preview.
- Create `apps/dashboard/components/reports/recommendations.test.tsx`
  - Covers empty/loading/error states, queue/detail rendering, accept/reject/defer/patch-preview calls, and diff display.
- Modify `apps/dashboard/components/reports/reports-page.tsx`
  - Render Recommendations section directly after `QualityAnalytics`.
- Modify `apps/dashboard/components/reports/reports-page.test.tsx`
  - Verifies recommendations section receives data.
- Modify `apps/dashboard/app/reports/page.tsx`
  - Fetch recommendations in parallel with reports and quality summary.
- Modify `apps/dashboard/app/reports/page.test.tsx`
  - Verifies route passes filters and active project to recommendations API.
- Modify `apps/dashboard/i18n/messages/zh.json` and `apps/dashboard/i18n/messages/en.json`
  - Add `reportsPage.recommendations.*` strings.

### E2E / Docs

- Create `apps/orchestrator/src/__tests__/improvements-v45-e2e.test.ts`
  - Fake seeded quality data -> recommendation generate -> accept -> patch preview -> target file unchanged.
- Create `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md`
  - Records acceptance checklist and verification commands.
- Modify `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
  - Add implementation plan link.
- Modify `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
  - Change V4.5 from "design complete" to "implementation plan ready" once this plan lands.

---

## Task 1: Shared Improvement Contracts

**Files:**
- Create: `packages/shared-contracts/src/improvement.ts`
- Create: `packages/shared-contracts/src/__tests__/improvement.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Modify: `packages/shared-contracts/src/api.ts`
- Modify: `packages/shared-contracts/src/__tests__/index.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Create `packages/shared-contracts/src/__tests__/improvement.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  IMPROVEMENT_RECOMMENDATION_STATUS_VALUES,
  IMPROVEMENT_TARGET_KIND_VALUES,
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  type ImprovementRecommendation,
} from "../improvement.js";

describe("V4.5 improvement contracts", () => {
  it("keeps target kind and status guards strict", () => {
    expect(IMPROVEMENT_TARGET_KIND_VALUES).toEqual([
      "workflow_front_matter",
      "prompt_template",
      "project_rules",
      "skill_instruction",
    ]);
    expect(IMPROVEMENT_RECOMMENDATION_STATUS_VALUES).toEqual([
      "open",
      "accepted",
      "rejected",
      "deferred",
      "blocked",
      "stale",
      "superseded",
    ]);
    expect(isImprovementTargetKind("prompt_template")).toBe(true);
    expect(isImprovementTargetKind("label_state_machine")).toBe(false);
    expect(isImprovementRecommendationStatus("accepted")).toBe(true);
    expect(isImprovementRecommendationStatus("applied")).toBe(false);
  });

  it("round-trips a generated recommendation as JSON", () => {
    const recommendation: ImprovementRecommendation = {
      recommendationId: "rec_1",
      projectId: "platform-web",
      scope: {
        mode: "team-project",
        projectId: "platform-web",
        workflow: "default-web",
        taskType: "frontend",
      },
      problemPattern: "missing-evidence",
      title: "Require UI evidence",
      summary: "UI tasks repeatedly lacked screenshot or command output evidence.",
      target: {
        kind: "prompt_template",
        path: "/repo/WORKFLOW.md",
        description: "Prompt template evidence section",
      },
      evidenceRefs: [
        {
          kind: "quality-drilldown",
          id: "task:wi_1:t_1:missing-evidence",
          href: "/work-items/wi_1?view=evidence",
          reason: "Task had no trusted validation evidence",
        },
      ],
      suggestedChange:
        "Require screenshot or command output evidence for UI behavior changes.",
      patchPreview: {
        status: "generated",
        targetPath: "/repo/WORKFLOW.md",
        targetDescription: "Prompt template evidence section",
        sourceSnapshot: {
          targetPath: "/repo/WORKFLOW.md",
          sha256: "a".repeat(64),
          capturedAt: "2026-05-18T00:00:00.000Z",
        },
        diff: "@@ prompt_template @@\n+ Attach UI evidence.\n",
        rollbackNotes: "Remove the added prompt sentence.",
      },
      confidence: "high",
      risk: "low",
      status: "accepted",
      actionHistory: [
        {
          action: "generated",
          actor: "system",
          at: "2026-05-18T00:00:00.000Z",
        },
        {
          action: "accepted",
          actor: "operator",
          at: "2026-05-18T00:01:00.000Z",
          note: "Looks correct",
        },
      ],
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:01:00.000Z",
    };

    const parsed = JSON.parse(
      JSON.stringify(recommendation),
    ) as ImprovementRecommendation;
    expect(parsed.patchPreview.sourceSnapshot?.sha256).toHaveLength(64);
    expect(parsed.actionHistory.map((e) => e.action)).toEqual([
      "generated",
      "accepted",
    ]);
  });
});
```

- [ ] **Step 2: Run the failing contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts src/__tests__/index.test.ts
```

Expected: FAIL with module/export errors for `../improvement.js` and missing root exports.

- [ ] **Step 3: Add the shared improvement contract file**

Create `packages/shared-contracts/src/improvement.ts`:

```ts
import type {
  FailurePatternId,
  QualityStatusFilter,
  QualityWindow,
} from "./quality.js";

/**
 * V4.5 Improvement Loop wire contract. Keep all values JSON-serialisable.
 * Patch previews are inert records; they never imply filesystem writes.
 */

export const IMPROVEMENT_TARGET_KIND_VALUES = [
  "workflow_front_matter",
  "prompt_template",
  "project_rules",
  "skill_instruction",
] as const;

export type ImprovementTargetKind =
  (typeof IMPROVEMENT_TARGET_KIND_VALUES)[number];

export const isImprovementTargetKind = (
  value: unknown,
): value is ImprovementTargetKind =>
  typeof value === "string" &&
  (IMPROVEMENT_TARGET_KIND_VALUES as readonly string[]).includes(value);

export const IMPROVEMENT_RECOMMENDATION_STATUS_VALUES = [
  "open",
  "accepted",
  "rejected",
  "deferred",
  "blocked",
  "stale",
  "superseded",
] as const;

export type ImprovementRecommendationStatus =
  (typeof IMPROVEMENT_RECOMMENDATION_STATUS_VALUES)[number];

export const isImprovementRecommendationStatus = (
  value: unknown,
): value is ImprovementRecommendationStatus =>
  typeof value === "string" &&
  (IMPROVEMENT_RECOMMENDATION_STATUS_VALUES as readonly string[]).includes(
    value,
  );

export type ImprovementEvidenceKind =
  | "quality-drilldown"
  | "run"
  | "work-item"
  | "task"
  | "evidence"
  | "review-comment";

export interface ImprovementEvidenceRef {
  kind: ImprovementEvidenceKind;
  id: string;
  href?: string;
  reason: string;
}

export interface ImprovementPatchSourceSnapshot {
  targetPath: string;
  sha256: string;
  capturedAt: string;
}

export interface ImprovementPatchPreview {
  status: "not_generated" | "generated" | "blocked" | "stale";
  targetPath?: string;
  targetDescription: string;
  sourceSnapshot?: ImprovementPatchSourceSnapshot;
  diff?: string;
  blockedReason?: string;
  rollbackNotes?: string;
}

export type ImprovementAction =
  | "generated"
  | "accepted"
  | "rejected"
  | "deferred"
  | "patch_preview_generated";

export interface ImprovementActionHistoryEntry {
  action: ImprovementAction;
  actor: "operator" | "system";
  at: string;
  note?: string;
}

export interface ImprovementRecommendation {
  recommendationId: string;
  projectId: string;
  scope: {
    mode: "single-project" | "team-project";
    projectId?: string;
    workflow?: string;
    taskType?: string;
  };
  problemPattern: FailurePatternId;
  title: string;
  summary: string;
  target: {
    kind: ImprovementTargetKind;
    path?: string;
    description: string;
  };
  evidenceRefs: ImprovementEvidenceRef[];
  suggestedChange: string;
  patchPreview: ImprovementPatchPreview;
  confidence: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  status: ImprovementRecommendationStatus;
  actionHistory: ImprovementActionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];
}

export interface ImprovementRecommendationFilters {
  status?: ImprovementRecommendationStatus;
  pattern?: FailurePatternId;
  targetKind?: ImprovementTargetKind;
  workflow?: string;
  taskType?: string;
}

export interface ImprovementGenerateRequest {
  filters?: {
    workflow?: string;
    taskType?: string;
    status?: QualityStatusFilter;
    pattern?: FailurePatternId;
    from?: string;
    to?: string;
    window?: QualityWindow;
  };
}

export interface ImprovementActionRequest {
  operator?: string;
  note?: string;
}

export interface ImprovementPatchPreviewRequest {
  operator?: string;
}

export interface ImprovementRecommendationsListResponse {
  recommendations: ImprovementRecommendation[];
}

export interface ImprovementRecommendationDetailResponse {
  recommendation?: ImprovementRecommendation;
}

export interface ImprovementGenerateResponse {
  recommendations: ImprovementRecommendation[];
  generated: number;
  updated: number;
  skipped: number;
}

export interface ImprovementActionResponse {
  recommendation: ImprovementRecommendation;
}
```

- [ ] **Step 4: Export the shared contract**

Modify `packages/shared-contracts/src/index.ts`:

```ts
export const PACKAGE_NAME = "@issuepilot/shared-contracts";
export const VERSION = "0.0.0";

export * from "./api.js";
export * from "./events.js";
export * from "./improvement.js";
export * from "./issue.js";
export * from "./quality.js";
export * from "./report.js";
export * from "./retention.js";
export * from "./review.js";
export * from "./run.js";
export * from "./state.js";
export * from "./work-item.js";
```

Modify the top of `packages/shared-contracts/src/api.ts` so the improvement responses are exported with the other API contracts:

```ts
import { type IssuePilotEvent } from "./events.js";
export type {
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendationDetailResponse,
  ImprovementRecommendationFilters,
  ImprovementRecommendationsListResponse,
} from "./improvement.js";
```

- [ ] **Step 5: Update root export test**

Open `packages/shared-contracts/src/__tests__/index.test.ts` and add the improvement export assertion to the existing export list:

```ts
import {
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  PACKAGE_NAME,
} from "../index.js";

expect(PACKAGE_NAME).toBe("@issuepilot/shared-contracts");
expect(isImprovementTargetKind("prompt_template")).toBe(true);
expect(isImprovementRecommendationStatus("open")).toBe(true);
```

If the file already imports `PACKAGE_NAME`, add only the two improvement guard imports and expectations.

- [ ] **Step 6: Run contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts src/__tests__/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit shared contracts**

Run:

```bash
git add packages/shared-contracts/src/improvement.ts \
  packages/shared-contracts/src/index.ts \
  packages/shared-contracts/src/api.ts \
  packages/shared-contracts/src/__tests__/improvement.test.ts \
  packages/shared-contracts/src/__tests__/index.test.ts
git commit -m "feat(shared-contracts): add V4.5 improvement contracts"
```

---

## Task 2: Recommendation Store

**Files:**
- Create: `apps/orchestrator/src/improvements/store.ts`
- Create: `apps/orchestrator/src/improvements/__tests__/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `apps/orchestrator/src/improvements/__tests__/store.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { createImprovementStore } from "../store.js";

function rec(over: Partial<ImprovementRecommendation> = {}): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: {
      kind: "prompt_template",
      path: "/repo/WORKFLOW.md",
      description: "Prompt template",
    },
    evidenceRefs: [
      {
        kind: "quality-drilldown",
        id: "task:wi:t:missing-evidence",
        reason: "missing evidence",
      },
    ],
    suggestedChange: "Ask for command output evidence.",
    patchPreview: {
      status: "not_generated",
      targetDescription: "Prompt template",
    },
    confidence: "high",
    risk: "low",
    status: "open",
    actionHistory: [
      {
        action: "generated",
        actor: "system",
        at: "2026-05-18T00:00:00.000Z",
      },
    ],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

describe("createImprovementStore", () => {
  it("saves, loads, and lists recommendations from disk", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    await store.save(rec());

    const reloaded = createImprovementStore({ rootDir });
    await expect(reloaded.get("rec_1")).resolves.toMatchObject({
      recommendationId: "rec_1",
      problemPattern: "missing-evidence",
    });
    await expect(reloaded.list()).resolves.toHaveLength(1);
  });

  it("redacts secret-looking values before writing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    await store.save(
      rec({
        recommendationId: "rec_secret",
        suggestedChange: "Set token to glpat-secret-value",
      }),
    );

    const body = await readFile(
      join(rootDir, "recommendations", "rec_secret.json"),
      "utf8",
    );
    expect(body).not.toContain("glpat-secret-value");
  });

  it("sorts newest recommendations first", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-improvements-"));
    const store = createImprovementStore({ rootDir });
    await store.save(
      rec({ recommendationId: "old", updatedAt: "2026-05-17T00:00:00.000Z" }),
    );
    await store.save(
      rec({ recommendationId: "new", updatedAt: "2026-05-18T00:00:00.000Z" }),
    );

    await expect(store.list()).resolves.toMatchObject([
      { recommendationId: "new" },
      { recommendationId: "old" },
    ]);
  });
});
```

- [ ] **Step 2: Run the failing store tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/store.test.ts
```

Expected: FAIL with module not found for `../store.js`.

- [ ] **Step 3: Implement the store**

Create `apps/orchestrator/src/improvements/store.ts`:

```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "@issuepilot/observability";
import type {
  ImprovementRecommendation,
  ImprovementRecommendationFilters,
} from "@issuepilot/shared-contracts";

export interface ImprovementStore {
  save(recommendation: ImprovementRecommendation): Promise<void>;
  get(id: string): Promise<ImprovementRecommendation | undefined>;
  list(filters?: ImprovementRecommendationFilters): Promise<ImprovementRecommendation[]>;
}

export function createImprovementStore(opts: { rootDir: string }): ImprovementStore {
  const recommendations = new Map<string, ImprovementRecommendation>();
  const dir = join(opts.rootDir, "recommendations");

  async function writeJson(path: string, payload: unknown): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(redact(payload), null, 2)}\n`, "utf8");
  }

  async function loadAllFromDisk(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (recommendations.has(id)) continue;
      try {
        const body = await readFile(join(dir, entry), "utf8");
        recommendations.set(id, JSON.parse(body) as ImprovementRecommendation);
      } catch {
        continue;
      }
    }
  }

  function matches(
    recommendation: ImprovementRecommendation,
    filters: ImprovementRecommendationFilters | undefined,
  ): boolean {
    if (!filters) return true;
    if (filters.status && recommendation.status !== filters.status) return false;
    if (filters.pattern && recommendation.problemPattern !== filters.pattern) return false;
    if (filters.targetKind && recommendation.target.kind !== filters.targetKind) {
      return false;
    }
    if (filters.workflow && recommendation.scope.workflow !== filters.workflow) return false;
    if (filters.taskType && recommendation.scope.taskType !== filters.taskType) return false;
    return true;
  }

  return {
    async save(recommendation) {
      recommendations.set(recommendation.recommendationId, recommendation);
      await writeJson(
        join(dir, `${recommendation.recommendationId}.json`),
        recommendation,
      );
    },
    async get(id) {
      const cached = recommendations.get(id);
      if (cached) return cached;
      try {
        const body = await readFile(join(dir, `${id}.json`), "utf8");
        const parsed = JSON.parse(body) as ImprovementRecommendation;
        recommendations.set(id, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    },
    async list(filters) {
      await loadAllFromDisk();
      return [...recommendations.values()]
        .filter((recommendation) => matches(recommendation, filters))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}
```

- [ ] **Step 4: Run store tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit store**

Run:

```bash
git add apps/orchestrator/src/improvements/store.ts \
  apps/orchestrator/src/improvements/__tests__/store.test.ts
git commit -m "feat(orchestrator): add improvement recommendation store"
```

---

## Task 3: Templates and Recommendation Engine

**Files:**
- Create: `apps/orchestrator/src/improvements/types.ts`
- Create: `apps/orchestrator/src/improvements/templates.ts`
- Create: `apps/orchestrator/src/improvements/engine.ts`
- Create: `apps/orchestrator/src/improvements/__tests__/templates.test.ts`
- Create: `apps/orchestrator/src/improvements/__tests__/engine.test.ts`

- [ ] **Step 1: Write failing template tests**

Create `apps/orchestrator/src/improvements/__tests__/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { templateForPattern } from "../templates.js";

describe("improvement templates", () => {
  it("maps missing-evidence to prompt template guidance", () => {
    expect(templateForPattern("missing-evidence")).toMatchObject({
      targetKind: "prompt_template",
      title: "Require evidence for validation claims",
    });
  });

  it("maps permission issues without suggesting secret writes", () => {
    const template = templateForPattern("permission-issue");
    expect(template.targetKind).toBe("project_rules");
    expect(template.suggestedChange.toLowerCase()).not.toContain("token value");
    expect(template.suggestedChange.toLowerCase()).toContain("token");
  });
});
```

- [ ] **Step 2: Write failing engine tests**

Create `apps/orchestrator/src/improvements/__tests__/engine.test.ts`:

```ts
import type {
  QualityDrilldownItem,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { buildImprovementRecommendations } from "../engine.js";

function item(over: Partial<QualityDrilldownItem>): QualityDrilldownItem {
  return {
    itemId: "task:wi:t:missing-evidence",
    patternIds: ["missing-evidence"],
    reason: "Task had no validation evidence",
    projectId: "proj-a",
    workflow: "default",
    taskType: "frontend",
    workItem: { workItemId: "wi-1", title: "Build UI" },
    task: { taskId: "t1", title: "Add UI" },
    updatedAt: "2026-05-18T00:00:00.000Z",
    target: { kind: "evidence", href: "/work-items/wi-1?view=evidence" },
    ...over,
  };
}

function summary(items: QualityDrilldownItem[]): QualitySummaryResponse {
  return {
    scope: { mode: "single-project" },
    filters: {
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-18T23:59:59.999Z",
      window: "7d",
    },
    metrics: [],
    trends: [],
    failurePatterns: [
      {
        patternId: "missing-evidence",
        label: "Missing evidence",
        count: items.length,
        rate: 100,
        latestReason: "Task had no validation evidence",
        drilldownCount: items.length,
      },
    ],
    drilldown: items,
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
  };
}

describe("buildImprovementRecommendations", () => {
  it("clusters repeated quality drilldown items into one recommendation", () => {
    const recommendations = buildImprovementRecommendations({
      summary: summary([
        item({ itemId: "task:wi-1:t-1:missing-evidence" }),
        item({ itemId: "task:wi-2:t-2:missing-evidence" }),
      ]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      problemPattern: "missing-evidence",
      target: { kind: "prompt_template" },
      confidence: "medium",
      risk: "low",
      status: "open",
    });
    expect(recommendations[0]?.evidenceRefs).toHaveLength(2);
  });

  it("dedupes against existing open recommendations and appends evidence", () => {
    const [existing] = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-1:t-1:missing-evidence" })]),
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const recommendations = buildImprovementRecommendations({
      summary: summary([item({ itemId: "task:wi-2:t-2:missing-evidence" })]),
      existing: [existing!],
      now: () => new Date("2026-05-18T02:00:00.000Z"),
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]?.recommendationId).toBe(existing?.recommendationId);
    expect(recommendations[0]?.evidenceRefs.map((ref) => ref.id)).toEqual([
      "task:wi-1:t-1:missing-evidence",
      "task:wi-2:t-2:missing-evidence",
    ]);
  });
});
```

- [ ] **Step 3: Run failing engine tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/templates.test.ts src/improvements/__tests__/engine.test.ts
```

Expected: FAIL with missing modules.

- [ ] **Step 4: Add internal types**

Create `apps/orchestrator/src/improvements/types.ts`:

```ts
import type {
  FailurePatternId,
  ImprovementTargetKind,
  QualityDrilldownItem,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

export interface ImprovementTemplate {
  patternId: FailurePatternId;
  targetKind: ImprovementTargetKind;
  title: string;
  summary: string;
  suggestedChange: string;
  risk: "low" | "medium" | "high";
}

export interface BuildImprovementRecommendationsInput {
  summary: QualitySummaryResponse;
  existing?: import("@issuepilot/shared-contracts").ImprovementRecommendation[];
  now?: () => Date;
}

export interface PatternCluster {
  patternId: FailurePatternId;
  workflow?: string;
  taskType?: string;
  items: QualityDrilldownItem[];
}
```

- [ ] **Step 5: Add deterministic templates**

Create `apps/orchestrator/src/improvements/templates.ts`:

```ts
import type { FailurePatternId } from "@issuepilot/shared-contracts";

import type { ImprovementTemplate } from "./types.js";

const TEMPLATES: Record<FailurePatternId, ImprovementTemplate> = {
  "missing-evidence": {
    patternId: "missing-evidence",
    targetKind: "prompt_template",
    title: "Require evidence for validation claims",
    summary:
      "Recent tasks reached review without enough trusted validation evidence.",
    suggestedChange:
      "Add prompt guidance that asks agents to attach screenshot, command output, or test evidence when they claim validation is complete.",
    risk: "low",
  },
  "missing-tests": {
    patternId: "missing-tests",
    targetKind: "project_rules",
    title: "Strengthen test evidence expectations",
    summary: "Recent work lacked test output or relied on weak validation claims.",
    suggestedChange:
      "Add project-rule guidance that requires explicit test commands, skipped-test rationale, or reviewer-visible validation evidence.",
    risk: "low",
  },
  "environment-issue": {
    patternId: "environment-issue",
    targetKind: "workflow_front_matter",
    title: "Add environment preflight guidance",
    summary: "Recent runs failed because local setup, workspace, network, or runner prerequisites were unavailable.",
    suggestedChange:
      "Add workflow guidance that requires environment preflight checks and clear blocked notes when prerequisites are missing.",
    risk: "medium",
  },
  "permission-issue": {
    patternId: "permission-issue",
    targetKind: "project_rules",
    title: "Document credential preflight without storing secrets",
    summary: "Recent runs failed because GitLab permissions or credentials were unavailable.",
    suggestedChange:
      "Add project-rule guidance that tells operators which credential environment variable must exist, without writing token values into files or logs.",
    risk: "low",
  },
  "review-rework": {
    patternId: "review-rework",
    targetKind: "prompt_template",
    title: "Structure review feedback rework input",
    summary: "Recent tasks repeatedly entered reviewer-driven rework.",
    suggestedChange:
      "Add prompt guidance that requires the agent to quote reviewer requests as structured constraints and respond with targeted changes plus validation evidence.",
    risk: "low",
  },
  "unclear-requirements": {
    patternId: "unclear-requirements",
    targetKind: "prompt_template",
    title: "Require acceptance criteria before execution",
    summary: "Recent runs were blocked by missing acceptance criteria or unclear scope.",
    suggestedChange:
      "Add planning prompt guidance that asks the agent to stop and request clarification when acceptance criteria or scope boundaries are missing.",
    risk: "low",
  },
  "ci-failure": {
    patternId: "ci-failure",
    targetKind: "workflow_front_matter",
    title: "Clarify CI failure handling",
    summary: "Recent runs reached CI failure paths that need clearer operator and agent behavior.",
    suggestedChange:
      "Add workflow guidance for CI retry boundaries, manual prompt behavior, and evidence required before rework.",
    risk: "medium",
  },
};

export function templateForPattern(patternId: FailurePatternId): ImprovementTemplate {
  return TEMPLATES[patternId];
}
```

- [ ] **Step 6: Implement recommendation engine**

Create `apps/orchestrator/src/improvements/engine.ts`:

```ts
import { createHash } from "node:crypto";

import type {
  FailurePatternId,
  ImprovementEvidenceRef,
  ImprovementRecommendation,
  QualityDrilldownItem,
} from "@issuepilot/shared-contracts";

import { templateForPattern } from "./templates.js";
import type {
  BuildImprovementRecommendationsInput,
  PatternCluster,
} from "./types.js";

function iso(now: () => Date): string {
  return now().toISOString();
}

function stableId(parts: string[]): string {
  return `rec_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

function clusterKey(input: {
  projectId: string;
  workflow?: string;
  taskType?: string;
  patternId: FailurePatternId;
  targetKind: string;
}): string {
  return [
    input.projectId,
    input.workflow ?? "",
    input.taskType ?? "",
    input.targetKind,
    input.patternId,
  ].join("\0");
}

function evidenceRef(item: QualityDrilldownItem): ImprovementEvidenceRef {
  return {
    kind: "quality-drilldown",
    id: item.itemId,
    href: item.target.href,
    reason: item.reason,
  };
}

function confidence(count: number): ImprovementRecommendation["confidence"] {
  if (count >= 5) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function uniqueEvidence(
  refs: ImprovementEvidenceRef[],
): ImprovementEvidenceRef[] {
  const seen = new Set<string>();
  const out: ImprovementEvidenceRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

function clustersFor(
  items: QualityDrilldownItem[],
  patternId: FailurePatternId,
): PatternCluster[] {
  const clusters = new Map<string, PatternCluster>();
  for (const item of items) {
    if (!item.patternIds.includes(patternId)) continue;
    const key = [patternId, item.workflow ?? "", item.taskType ?? ""].join("\0");
    const current =
      clusters.get(key) ??
      ({
        patternId,
        ...(item.workflow ? { workflow: item.workflow } : {}),
        ...(item.taskType ? { taskType: item.taskType } : {}),
        items: [],
      } satisfies PatternCluster);
    current.items.push(item);
    clusters.set(key, current);
  }
  return [...clusters.values()];
}

export function buildImprovementRecommendations(
  input: BuildImprovementRecommendationsInput,
): ImprovementRecommendation[] {
  const now = input.now ?? (() => new Date());
  const timestamp = iso(now);
  const existingByKey = new Map<string, ImprovementRecommendation>();
  for (const recommendation of input.existing ?? []) {
    const key = clusterKey({
      projectId: recommendation.projectId,
      workflow: recommendation.scope.workflow,
      taskType: recommendation.scope.taskType,
      targetKind: recommendation.target.kind,
      patternId: recommendation.problemPattern,
    });
    if (recommendation.status === "open" || recommendation.status === "deferred") {
      existingByKey.set(key, recommendation);
    }
  }

  const next: ImprovementRecommendation[] = [];
  for (const pattern of input.summary.failurePatterns) {
    const template = templateForPattern(pattern.patternId);
    for (const cluster of clustersFor(input.summary.drilldown, pattern.patternId)) {
      if (cluster.items.length === 0) continue;
      const projectId = cluster.items[0]?.projectId ?? "unknown";
      const key = clusterKey({
        projectId,
        workflow: cluster.workflow,
        taskType: cluster.taskType,
        targetKind: template.targetKind,
        patternId: pattern.patternId,
      });
      const existing = existingByKey.get(key);
      const refs = uniqueEvidence([
        ...(existing?.evidenceRefs ?? []),
        ...cluster.items.map(evidenceRef),
      ]);
      const recommendationId =
        existing?.recommendationId ??
        stableId([projectId, cluster.workflow ?? "", cluster.taskType ?? "", key]);
      next.push({
        recommendationId,
        projectId,
        scope: {
          mode: input.summary.scope.mode,
          ...(input.summary.scope.projectId
            ? { projectId: input.summary.scope.projectId }
            : {}),
          ...(cluster.workflow ? { workflow: cluster.workflow } : {}),
          ...(cluster.taskType ? { taskType: cluster.taskType } : {}),
        },
        problemPattern: pattern.patternId,
        title: template.title,
        summary: template.summary,
        target: {
          kind: template.targetKind,
          description: template.title,
        },
        evidenceRefs: refs,
        suggestedChange: template.suggestedChange,
        patchPreview: existing?.patchPreview ?? {
          status: "not_generated",
          targetDescription: template.title,
        },
        confidence: confidence(refs.length),
        risk: template.risk,
        status: existing?.status ?? "open",
        actionHistory: existing?.actionHistory ?? [
          { action: "generated", actor: "system", at: timestamp },
        ],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }
  }
  return next;
}
```

- [ ] **Step 7: Run engine tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/templates.test.ts src/improvements/__tests__/engine.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit engine**

Run:

```bash
git add apps/orchestrator/src/improvements/types.ts \
  apps/orchestrator/src/improvements/templates.ts \
  apps/orchestrator/src/improvements/engine.ts \
  apps/orchestrator/src/improvements/__tests__/templates.test.ts \
  apps/orchestrator/src/improvements/__tests__/engine.test.ts
git commit -m "feat(orchestrator): generate improvement recommendations"
```

---

## Task 4: Inert Patch Preview

**Files:**
- Create: `apps/orchestrator/src/improvements/patch-preview.ts`
- Create: `apps/orchestrator/src/improvements/__tests__/patch-preview.test.ts`

- [ ] **Step 1: Write failing patch-preview tests**

Create `apps/orchestrator/src/improvements/__tests__/patch-preview.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import { generatePatchPreview } from "../patch-preview.js";

function rec(over: Partial<ImprovementRecommendation> = {}): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: {
      kind: "prompt_template",
      path: "/tmp/WORKFLOW.md",
      description: "Prompt template",
    },
    evidenceRefs: [],
    suggestedChange: "Require command output or screenshot evidence.",
    patchPreview: {
      status: "not_generated",
      targetDescription: "Prompt template",
    },
    confidence: "high",
    risk: "low",
    status: "accepted",
    actionHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

describe("generatePatchPreview", () => {
  it("generates a diff and source snapshot without writing the target file", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const targetPath = join(root, "WORKFLOW.md");
    const original = "---\nagent:\n  max_attempts: 2\n---\nRun the task.\n";
    await writeFile(targetPath, original, "utf8");

    const preview = await generatePatchPreview({
      recommendation: rec({ target: { kind: "prompt_template", path: targetPath, description: "Prompt template" } }),
      now: () => new Date("2026-05-18T00:00:00.000Z"),
    });

    expect(preview.status).toBe("generated");
    expect(preview.targetPath).toBe(targetPath);
    expect(preview.sourceSnapshot?.sha256).toHaveLength(64);
    expect(preview.diff).toContain("+ Require command output or screenshot evidence.");
    await expect(readFile(targetPath, "utf8")).resolves.toBe(original);
  });

  it("blocks when the target path is missing", async () => {
    const preview = await generatePatchPreview({
      recommendation: rec({
        target: { kind: "prompt_template", description: "Prompt template" },
      }),
    });

    expect(preview).toMatchObject({
      status: "blocked",
      blockedReason: "target_path_missing",
    });
  });

  it("marks existing generated previews stale when the source hash changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "issuepilot-patch-preview-"));
    const targetPath = join(root, "WORKFLOW.md");
    await writeFile(targetPath, "first\n", "utf8");
    const generated = await generatePatchPreview({
      recommendation: rec({ target: { kind: "prompt_template", path: targetPath, description: "Prompt template" } }),
    });
    await writeFile(targetPath, "second\n", "utf8");

    const stale = await generatePatchPreview({
      recommendation: rec({
        target: { kind: "prompt_template", path: targetPath, description: "Prompt template" },
        patchPreview: generated,
      }),
    });

    expect(stale.status).toBe("stale");
    expect(stale.blockedReason).toBe("source_snapshot_mismatch");
  });
});
```

- [ ] **Step 2: Run failing patch-preview tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/patch-preview.test.ts
```

Expected: FAIL with missing module.

- [ ] **Step 3: Implement patch-preview**

Create `apps/orchestrator/src/improvements/patch-preview.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  ImprovementPatchPreview,
  ImprovementRecommendation,
} from "@issuepilot/shared-contracts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function appendPreviewDiff(input: {
  targetPath: string;
  targetDescription: string;
  suggestedChange: string;
}): string {
  return [
    `--- ${input.targetPath}`,
    `+++ ${input.targetPath} (preview)`,
    `@@ ${input.targetDescription} @@`,
    `+ ${input.suggestedChange}`,
    "",
  ].join("\n");
}

export async function generatePatchPreview(input: {
  recommendation: ImprovementRecommendation;
  now?: () => Date;
}): Promise<ImprovementPatchPreview> {
  const now = input.now ?? (() => new Date());
  const targetPath = input.recommendation.target.path;
  if (!targetPath) {
    return {
      status: "blocked",
      targetDescription: input.recommendation.target.description,
      blockedReason: "target_path_missing",
    };
  }

  let body: string;
  try {
    body = await readFile(targetPath, "utf8");
  } catch {
    return {
      status: "blocked",
      targetPath,
      targetDescription: input.recommendation.target.description,
      blockedReason: "target_file_unreadable",
    };
  }

  const currentHash = sha256(body);
  const snapshot = input.recommendation.patchPreview.sourceSnapshot;
  if (
    input.recommendation.patchPreview.status === "generated" &&
    snapshot &&
    snapshot.sha256 !== currentHash
  ) {
    return {
      ...input.recommendation.patchPreview,
      status: "stale",
      blockedReason: "source_snapshot_mismatch",
    };
  }

  return {
    status: "generated",
    targetPath,
    targetDescription: input.recommendation.target.description,
    sourceSnapshot: {
      targetPath,
      sha256: currentHash,
      capturedAt: now().toISOString(),
    },
    diff: appendPreviewDiff({
      targetPath,
      targetDescription: input.recommendation.target.description,
      suggestedChange: input.recommendation.suggestedChange,
    }),
    rollbackNotes: "Do not apply this preview automatically. If applied manually, remove the added line to roll back.",
  };
}
```

- [ ] **Step 4: Run patch-preview tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/patch-preview.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit patch-preview**

Run:

```bash
git add apps/orchestrator/src/improvements/patch-preview.ts \
  apps/orchestrator/src/improvements/__tests__/patch-preview.test.ts
git commit -m "feat(orchestrator): preview improvement patches safely"
```

---

## Task 5: Improvement Service

**Files:**
- Create: `apps/orchestrator/src/improvements/service.ts`
- Create: `apps/orchestrator/src/improvements/__tests__/service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `apps/orchestrator/src/improvements/__tests__/service.test.ts`:

```ts
import type {
  ImprovementRecommendation,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import type { ImprovementStore } from "../store.js";
import { createImprovementService } from "../service.js";

function memoryStore(): ImprovementStore {
  const records = new Map<string, ImprovementRecommendation>();
  return {
    async save(recommendation) {
      records.set(recommendation.recommendationId, recommendation);
    },
    async get(id) {
      return records.get(id);
    },
    async list(filters) {
      return [...records.values()].filter((r) => {
        if (filters?.status && r.status !== filters.status) return false;
        return true;
      });
    },
  };
}

const quality: QualitySummaryResponse = {
  scope: { mode: "single-project" },
  filters: {
    from: "2026-05-11T00:00:00.000Z",
    to: "2026-05-18T23:59:59.999Z",
    window: "7d",
  },
  metrics: [],
  trends: [],
  failurePatterns: [
    {
      patternId: "missing-evidence",
      label: "Missing evidence",
      count: 1,
      rate: 100,
      drilldownCount: 1,
    },
  ],
  drilldown: [
    {
      itemId: "task:wi:t:missing-evidence",
      patternIds: ["missing-evidence"],
      reason: "missing evidence",
      projectId: "proj-a",
      workflow: "default",
      taskType: "frontend",
      updatedAt: "2026-05-18T00:00:00.000Z",
      target: { kind: "evidence", href: "/work-items/wi?view=evidence" },
    },
  ],
  dimensions: [],
  diagnostics: { invalidReportCount: 0 },
};

describe("createImprovementService", () => {
  it("generates and persists recommendations", async () => {
    const service = createImprovementService({
      store: memoryStore(),
      buildQualitySummary: async () => quality,
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });

    const result = await service.generate({});
    expect(result.generated).toBe(1);
    await expect(service.list({})).resolves.toHaveLength(1);
  });

  it("records accept/reject/defer action history without patch preview side effects", async () => {
    const service = createImprovementService({
      store: memoryStore(),
      buildQualitySummary: async () => quality,
      now: () => new Date("2026-05-18T01:00:00.000Z"),
    });
    const [recommendation] = (await service.generate({})).recommendations;

    const accepted = await service.accept(recommendation!.recommendationId, {
      operator: "alice",
      note: "valid",
    });
    expect(accepted.recommendation.status).toBe("accepted");
    expect(accepted.recommendation.patchPreview.status).toBe("not_generated");
    expect(accepted.recommendation.actionHistory.at(-1)).toMatchObject({
      action: "accepted",
      actor: "operator",
      note: "valid",
    });
  });
});
```

- [ ] **Step 2: Run failing service tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/service.test.ts
```

Expected: FAIL with missing `service.js`.

- [ ] **Step 3: Implement service**

Create `apps/orchestrator/src/improvements/service.ts`:

```ts
import type {
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendation,
  ImprovementRecommendationFilters,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

import { buildImprovementRecommendations } from "./engine.js";
import { generatePatchPreview } from "./patch-preview.js";
import type { ImprovementStore } from "./store.js";

export type ImprovementServiceError = {
  error: { code: string; message: string };
};

export interface ImprovementService {
  list(filters: ImprovementRecommendationFilters): Promise<ImprovementRecommendation[]>;
  detail(id: string): Promise<ImprovementRecommendation | undefined>;
  generate(input: ImprovementGenerateRequest): Promise<ImprovementGenerateResponse>;
  accept(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  reject(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  defer(
    id: string,
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
  patchPreview(
    id: string,
    input: ImprovementPatchPreviewRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError>;
}

export function createImprovementService(deps: {
  store: ImprovementStore;
  buildQualitySummary: (
    input: ImprovementGenerateRequest,
  ) => Promise<QualitySummaryResponse>;
  now?: () => Date;
}): ImprovementService {
  const now = deps.now ?? (() => new Date());

  async function action(
    id: string,
    status: ImprovementRecommendation["status"],
    actionName: "accepted" | "rejected" | "deferred",
    input: ImprovementActionRequest,
  ): Promise<ImprovementActionResponse | ImprovementServiceError> {
    const current = await deps.store.get(id);
    if (!current) {
      return { error: { code: "not_found", message: "recommendation not found" } };
    }
    const next: ImprovementRecommendation = {
      ...current,
      status,
      updatedAt: now().toISOString(),
      actionHistory: [
        ...current.actionHistory,
        {
          action: actionName,
          actor: "operator",
          at: now().toISOString(),
          ...(input.note ? { note: input.note } : {}),
        },
      ],
    };
    await deps.store.save(next);
    return { recommendation: next };
  }

  return {
    list(filters) {
      return deps.store.list(filters);
    },
    detail(id) {
      return deps.store.get(id);
    },
    async generate(input) {
      const summary = await deps.buildQualitySummary(input);
      const existing = await deps.store.list();
      const recommendations = buildImprovementRecommendations({
        summary,
        existing,
        now,
      });
      let generated = 0;
      let updated = 0;
      for (const recommendation of recommendations) {
        if (existing.some((r) => r.recommendationId === recommendation.recommendationId)) {
          updated += 1;
        } else {
          generated += 1;
        }
        await deps.store.save(recommendation);
      }
      return { recommendations, generated, updated, skipped: 0 };
    },
    accept(id, input) {
      return action(id, "accepted", "accepted", input);
    },
    reject(id, input) {
      return action(id, "rejected", "rejected", input);
    },
    defer(id, input) {
      return action(id, "deferred", "deferred", input);
    },
    async patchPreview(id, input) {
      const current = await deps.store.get(id);
      if (!current) {
        return { error: { code: "not_found", message: "recommendation not found" } };
      }
      const preview = await generatePatchPreview({ recommendation: current, now });
      const next: ImprovementRecommendation = {
        ...current,
        patchPreview: preview,
        updatedAt: now().toISOString(),
        actionHistory: [
          ...current.actionHistory,
          {
            action: "patch_preview_generated",
            actor: input.operator ? "operator" : "system",
            at: now().toISOString(),
          },
        ],
      };
      await deps.store.save(next);
      return { recommendation: next };
    },
  };
}
```

- [ ] **Step 4: Run service tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements/__tests__/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit service**

Run:

```bash
git add apps/orchestrator/src/improvements/service.ts \
  apps/orchestrator/src/improvements/__tests__/service.test.ts
git commit -m "feat(orchestrator): add improvement service"
```

---

## Task 6: Improvement API Routes and Server Tests

**Files:**
- Create: `apps/orchestrator/src/improvements/routes.ts`
- Modify: `apps/orchestrator/src/server/index.ts`
- Modify: `apps/orchestrator/src/server/__tests__/server.test.ts`

- [ ] **Step 1: Write failing server route tests**

Append to the existing `describe("V4.4 quality summary route", ...)` neighborhood in `apps/orchestrator/src/server/__tests__/server.test.ts`:

```ts
describe("V4.5 improvement routes", () => {
  function fakeImprovementService() {
    const records = new Map<string, any>();
    return {
      async list() {
        return [...records.values()];
      },
      async detail(id: string) {
        return records.get(id);
      },
      async generate() {
        const recommendation = {
          recommendationId: "rec_1",
          projectId: "proj-a",
          scope: { mode: "single-project", workflow: "default" },
          problemPattern: "missing-evidence",
          title: "Require evidence",
          summary: "Repeated missing evidence",
          target: { kind: "prompt_template", description: "Prompt template" },
          evidenceRefs: [],
          suggestedChange: "Require evidence.",
          patchPreview: { status: "not_generated", targetDescription: "Prompt template" },
          confidence: "high",
          risk: "low",
          status: "open",
          actionHistory: [{ action: "generated", actor: "system", at: "2026-05-18T00:00:00.000Z" }],
          createdAt: "2026-05-18T00:00:00.000Z",
          updatedAt: "2026-05-18T00:00:00.000Z",
        };
        records.set("rec_1", recommendation);
        return { recommendations: [recommendation], generated: 1, updated: 0, skipped: 0 };
      },
      async accept(id: string) {
        const current = records.get(id);
        const next = { ...current, status: "accepted" };
        records.set(id, next);
        return { recommendation: next };
      },
      async reject(id: string) {
        const current = records.get(id);
        const next = { ...current, status: "rejected" };
        records.set(id, next);
        return { recommendation: next };
      },
      async defer(id: string) {
        const current = records.get(id);
        const next = { ...current, status: "deferred" };
        records.set(id, next);
        return { recommendation: next };
      },
      async patchPreview(id: string) {
        const current = records.get(id);
        const next = {
          ...current,
          patchPreview: {
            status: "generated",
            targetDescription: "Prompt template",
            diff: "+ Require evidence.",
          },
        };
        records.set(id, next);
        return { recommendation: next };
      },
    };
  }

  it("generates, lists, accepts, and previews recommendations", async () => {
    const { app } = await buildTestApp(undefined, {
      improvements: fakeImprovementService(),
    });

    const generated = await app.inject({
      method: "POST",
      url: "/api/improvements/recommendations/generate",
      payload: {},
    });
    expect(generated.statusCode).toBe(200);
    expect(generated.json().generated).toBe(1);

    const listed = await app.inject("/api/improvements/recommendations");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().recommendations).toHaveLength(1);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/improvements/recommendations/rec_1/accept",
      headers: { "x-issuepilot-operator": "alice" },
      payload: { note: "valid" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().recommendation.status).toBe("accepted");

    const preview = await app.inject({
      method: "POST",
      url: "/api/improvements/recommendations/rec_1/patch-preview",
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().recommendation.patchPreview.status).toBe("generated");
  });

  it("requires project header for team-mode improvements", async () => {
    const { app } = await buildTestApp(undefined, {
      improvementsByProject: new Map([["proj-a", fakeImprovementService()]]),
    });

    const missing = await app.inject("/api/improvements/recommendations");
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "project_required" });

    const unknown = await app.inject({
      method: "GET",
      url: "/api/improvements/recommendations",
      headers: { "x-issuepilot-project": "missing" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "project_not_found" });
  });
});
```

Extend the `overrides` type in `buildTestApp()` with `improvements?: ServerDeps["improvements"]` and `improvementsByProject?: ServerDeps["improvementsByProject"]`, then pass them through to `createServer()` with the existing conditional spread pattern.

- [ ] **Step 2: Run failing route tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -t "V4.5 improvement routes"
```

Expected: FAIL because `ServerDeps` has no improvements service and routes do not exist.

- [ ] **Step 3: Add route helper**

Create `apps/orchestrator/src/improvements/routes.ts`:

```ts
import {
  isFailurePatternId,
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  type ImprovementActionRequest,
  type ImprovementGenerateRequest,
  type ImprovementPatchPreviewRequest,
  type ImprovementRecommendationFilters,
} from "@issuepilot/shared-contracts";
import type { FastifyInstance } from "fastify";

import type { ImprovementService } from "./service.js";

export type ImprovementRouteContext =
  | { ok: true; service: ImprovementService; projectId?: string }
  | {
      ok: false;
      statusCode: number;
      body: { ok: false; code: string; message?: string };
    };

export function improvementRouteError(code: string, message: string) {
  return { ok: false, code, message };
}

function statusFromImprovementCode(code: string): number {
  if (code === "not_found") return 404;
  if (code === "validation_failed") return 400;
  return 500;
}

function filtersFromQuery(query: Record<string, unknown>): ImprovementRecommendationFilters {
  return {
    ...(isImprovementRecommendationStatus(query["status"])
      ? { status: query["status"] }
      : {}),
    ...(isFailurePatternId(query["pattern"]) ? { pattern: query["pattern"] } : {}),
    ...(isImprovementTargetKind(query["targetKind"])
      ? { targetKind: query["targetKind"] }
      : {}),
    ...(typeof query["workflow"] === "string" && query["workflow"].length > 0
      ? { workflow: query["workflow"] }
      : {}),
    ...(typeof query["taskType"] === "string" && query["taskType"].length > 0
      ? { taskType: query["taskType"] }
      : {}),
  };
}

function operatorFrom(
  headers: Record<string, unknown>,
  body: { operator?: string } | undefined,
): string | undefined {
  if (body?.operator && body.operator.length > 0) return body.operator;
  const raw = headers["x-issuepilot-operator"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function registerImprovementRoutes(
  app: FastifyInstance,
  resolveService: (
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ) => ImprovementRouteContext,
): void {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/improvements/recommendations",
    async (request, reply) => {
      if (request.query?.["project"] !== undefined) {
        return reply
          .code(400)
          .send(improvementRouteError("project_query_unsupported", "project query is not supported; team mode uses x-issuepilot-project"));
      }
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return { recommendations: await ctx.service.list(filtersFromQuery(request.query ?? {})) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/improvements/recommendations/:id",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return { recommendation: await ctx.service.detail(request.params.id) };
    },
  );

  app.post<{ Body?: ImprovementGenerateRequest }>(
    "/api/improvements/recommendations/generate",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      return ctx.service.generate(request.body ?? {});
    },
  );

  for (const action of ["accept", "reject", "defer"] as const) {
    app.post<{ Params: { id: string }; Body?: ImprovementActionRequest }>(
      `/api/improvements/recommendations/:id/${action}`,
      async (request, reply) => {
        const ctx = resolveService(request.headers as Record<string, unknown>);
        if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
        const body = request.body ?? {};
        const input = {
          ...body,
          ...(operatorFrom(request.headers as Record<string, unknown>, body)
            ? { operator: operatorFrom(request.headers as Record<string, unknown>, body) }
            : {}),
        };
        const result = await ctx.service[action](request.params.id, input);
        if ("error" in result) {
          return reply
            .code(statusFromImprovementCode(result.error.code))
            .send({ ok: false, ...result.error });
        }
        return result;
      },
    );
  }

  app.post<{ Params: { id: string }; Body?: ImprovementPatchPreviewRequest }>(
    "/api/improvements/recommendations/:id/patch-preview",
    async (request, reply) => {
      const ctx = resolveService(request.headers as Record<string, unknown>);
      if (!ctx.ok) return reply.code(ctx.statusCode).send(ctx.body);
      const result = await ctx.service.patchPreview(request.params.id, request.body ?? {});
      if ("error" in result) {
        return reply
          .code(statusFromImprovementCode(result.error.code))
          .send({ ok: false, ...result.error });
      }
      return result;
    },
  );
}
```

- [ ] **Step 4: Wire routes into server**

Modify `apps/orchestrator/src/server/index.ts` imports:

```ts
import {
  improvementRouteError,
  registerImprovementRoutes,
  type ImprovementRouteContext,
} from "../improvements/routes.js";
import type { ImprovementService } from "../improvements/service.js";
```

Add to `ServerDeps`:

```ts
  /**
   * V4.5 Improvement Loop: single-project recommendation service.
   */
  improvements?: ImprovementService;
  /**
   * V4.5 Improvement Loop: team-mode recommendation services keyed by project id.
   */
  improvementsByProject?: Map<string, ImprovementService>;
```

Inside `createServer()`, near the work item/quality resolver helpers, add:

```ts
  function resolveImprovementService(
    headers: Record<string, unknown>,
    queryProject?: unknown,
  ): ImprovementRouteContext {
    if (deps.improvementsByProject && deps.improvementsByProject.size > 0) {
      const raw = headers["x-issuepilot-project"] ?? queryProject;
      const project = Array.isArray(raw) ? raw[0] : raw;
      if (typeof project !== "string" || project.length === 0) {
        return {
          ok: false,
          statusCode: 400,
          body: improvementRouteError(
            "project_required",
            "x-issuepilot-project header is required for improvements in team mode",
          ),
        };
      }
      const service = deps.improvementsByProject.get(project);
      if (!service) {
        return {
          ok: false,
          statusCode: 404,
          body: improvementRouteError("project_not_found", `Unknown project: ${project}`),
        };
      }
      return { ok: true, service, projectId: project };
    }
    if (!deps.improvements) {
      return {
        ok: false,
        statusCode: 503,
        body: improvementRouteError(
          "improvements_unavailable",
          "Improvement recommendation service is not configured",
        ),
      };
    }
    return { ok: true, service: deps.improvements };
  }

  registerImprovementRoutes(app, resolveImprovementService);
```

- [ ] **Step 5: Run route tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/server/__tests__/server.test.ts -t "V4.5 improvement routes"
```

Expected: PASS.

- [ ] **Step 6: Commit API routes**

Run:

```bash
git add apps/orchestrator/src/improvements/routes.ts \
  apps/orchestrator/src/server/index.ts \
  apps/orchestrator/src/server/__tests__/server.test.ts
git commit -m "feat(orchestrator): expose improvement recommendation api"
```

---

## Task 7: Daemon and Team-Mode Wiring

**Files:**
- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Create: `apps/orchestrator/src/__tests__/improvements-v45-e2e.test.ts`

- [ ] **Step 1: Write failing wiring/E2E test**

Create `apps/orchestrator/src/__tests__/improvements-v45-e2e.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildQualitySummary } from "../quality/aggregate.js";
import { createImprovementService } from "../improvements/service.js";
import { createImprovementStore } from "../improvements/store.js";

describe("V4.5 improvement loop e2e", () => {
  it("quality facts generate recommendation and inert patch preview", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-v45-"));
    const workflowPath = join(rootDir, "WORKFLOW.md");
    const original = "---\nagent:\n  max_attempts: 2\n---\nRun the task.\n";
    await writeFile(workflowPath, original, "utf8");
    const store = createImprovementStore({ rootDir });
    const service = createImprovementService({
      store,
      buildQualitySummary: async () =>
        buildQualitySummary({
          items: [
            {
              kind: "task",
              projectId: "proj-a",
              workflow: "default",
              taskType: "frontend",
              workItemId: "wi-1",
              workItemTitle: "Build UI",
              taskId: "t1",
              taskTitle: "Add widget",
              taskStatus: "completed",
              checklistReasons: ["missing-evidence"],
              evidenceCount: 0,
              validationEvidenceCount: 0,
              trustedValidationEvidenceCount: 0,
              aiClaimValidationEvidenceCount: 0,
              updatedAt: "2026-05-18T00:00:00.000Z",
            },
          ],
          filters: {
            from: "2026-05-11T00:00:00.000Z",
            to: "2026-05-18T23:59:59.999Z",
            window: "7d",
          },
          scope: { mode: "single-project" },
          diagnostics: { invalidReportCount: 0 },
        }),
    });

    const generated = await service.generate({});
    const recommendation = generated.recommendations[0]!;
    await service.accept(recommendation.recommendationId, { operator: "alice" });

    const accepted = (await service.detail(recommendation.recommendationId))!;
    await store.save({
      ...accepted,
      target: { ...accepted.target, path: workflowPath },
    });
    const preview = await service.patchPreview(recommendation.recommendationId, {
      operator: "alice",
    });

    expect(preview.recommendation.patchPreview.status).toBe("generated");
    expect(preview.recommendation.patchPreview.diff).toContain("+");
    await expect(readFile(workflowPath, "utf8")).resolves.toBe(original);
  });
});
```

- [ ] **Step 2: Run failing E2E test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/__tests__/improvements-v45-e2e.test.ts
```

Expected: PASS if earlier service modules are complete. If it fails, fix the service before daemon wiring.

- [ ] **Step 3: Wire single-mode daemon**

Modify `apps/orchestrator/src/daemon.ts` imports:

```ts
import { createImprovementService } from "./improvements/service.js";
import { createImprovementStore } from "./improvements/store.js";
import { buildQualitySummary } from "./quality/aggregate.js";
import { collectQualitySources } from "./quality/collect.js";
```

Near existing `reportStore` / `workItemStore` creation, add:

```ts
  const improvementStore = createImprovementStore({
    rootDir: workflow.workspace.root,
  });
  const improvementService = createImprovementService({
    store: improvementStore,
    buildQualitySummary: async (input) => {
      const collected = await collectQualitySources({
        metadata: {
          workflow: path.basename(workflow.source.path, path.extname(workflow.source.path)),
        },
        reports: reportStore,
        workItems: workItemStore,
      });
      return buildQualitySummary({
        items: collected.items,
        filters: {
          from:
            input.filters?.from ??
            new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: input.filters?.to ?? new Date().toISOString(),
          window: input.filters?.window ?? "7d",
          ...(input.filters?.workflow ? { workflow: input.filters.workflow } : {}),
          ...(input.filters?.taskType ? { taskType: input.filters.taskType } : {}),
          ...(input.filters?.status ? { status: input.filters.status } : {}),
          ...(input.filters?.pattern ? { pattern: input.filters.pattern } : {}),
        },
        scope: { mode: "single-project" },
        diagnostics: collected.diagnostics,
      });
    },
  });
```

Pass `improvements: improvementService` into `createServerImpl(...)`.

- [ ] **Step 4: Wire team-mode daemon**

Modify `apps/orchestrator/src/team/daemon.ts` imports:

```ts
import { createImprovementService } from "../improvements/service.js";
import { createImprovementStore } from "../improvements/store.js";
import { buildQualitySummary } from "../quality/aggregate.js";
import { collectQualitySources } from "../quality/collect.js";
```

Inside `startTeamDaemon`, add a map beside `qualityByProject`:

```ts
  const improvementsByProject = new Map<string, ReturnType<typeof createImprovementService>>();
```

Inside the project loop, after `qualityByProject.set(...)`, add:

```ts
    const improvementStore = createImprovementStore({
      rootDir: path.join(project.workflow.workspace.root, ".issuepilot"),
    });
    const qualityDeps = qualityByProject.get(project.id)!;
    improvementsByProject.set(
      project.id,
      createImprovementService({
        store: improvementStore,
        buildQualitySummary: async (input) => {
          const collected = await collectQualitySources(qualityDeps);
          return buildQualitySummary({
            items: collected.items,
            filters: {
              from:
                input.filters?.from ??
                new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
              to: input.filters?.to ?? new Date().toISOString(),
              window: input.filters?.window ?? "7d",
              ...(input.filters?.workflow ? { workflow: input.filters.workflow } : {}),
              ...(input.filters?.taskType ? { taskType: input.filters.taskType } : {}),
              ...(input.filters?.status ? { status: input.filters.status } : {}),
              ...(input.filters?.pattern ? { pattern: input.filters.pattern } : {}),
            },
            scope: { mode: "team-project", projectId: project.id },
            diagnostics: collected.diagnostics,
          });
        },
      }),
    );
```

Pass `improvementsByProject` into `createServerImpl(...)`.

- [ ] **Step 5: Run orchestrator tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit daemon wiring**

Run:

```bash
git add apps/orchestrator/src/daemon.ts \
  apps/orchestrator/src/team/daemon.ts \
  apps/orchestrator/src/__tests__/improvements-v45-e2e.test.ts
git commit -m "feat(orchestrator): wire V4.5 improvements into daemons"
```

---

## Task 8: Dashboard API Client

**Files:**
- Modify: `apps/dashboard/lib/api.ts`
- Modify: `apps/dashboard/lib/api.test.ts`

- [ ] **Step 1: Write failing dashboard API tests**

Append to `apps/dashboard/lib/api.test.ts`:

```ts
import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import {
  acceptImprovementRecommendation,
  deferImprovementRecommendation,
  generateImprovementRecommendations,
  getImprovementRecommendation,
  listImprovementRecommendations,
  previewImprovementPatch,
  rejectImprovementRecommendation,
} from "./api";

const improvement: ImprovementRecommendation = {
  recommendationId: "rec_1",
  projectId: "proj-a",
  scope: { mode: "single-project" },
  problemPattern: "missing-evidence",
  title: "Require evidence",
  summary: "Repeated missing evidence",
  target: { kind: "prompt_template", description: "Prompt template" },
  evidenceRefs: [],
  suggestedChange: "Require evidence.",
  patchPreview: { status: "not_generated", targetDescription: "Prompt template" },
  confidence: "high",
  risk: "low",
  status: "open",
  actionHistory: [],
  createdAt: "2026-05-18T00:00:00.000Z",
  updatedAt: "2026-05-18T00:00:00.000Z",
};

it("listImprovementRecommendations serializes filters and project header", async () => {
  mockFetchJson({ recommendations: [improvement] });
  await listImprovementRecommendations(
    { status: "open", pattern: "missing-evidence", targetKind: "prompt_template" },
    { project: "proj-a" },
  );
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/improvements/recommendations?"),
    expect.objectContaining({
      headers: expect.objectContaining({ "x-issuepilot-project": "proj-a" }),
    }),
  );
});

it("calls improvement action endpoints with operator headers", async () => {
  mockFetchJson({ recommendation: improvement });
  await acceptImprovementRecommendation("rec_1", {
    operator: "alice",
    note: "valid",
  });
  await rejectImprovementRecommendation("rec_1", { operator: "alice" });
  await deferImprovementRecommendation("rec_1", { operator: "alice" });
  await previewImprovementPatch("rec_1", { operator: "alice" });
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/improvements/recommendations/rec_1/accept"),
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-issuepilot-operator": "alice" }),
    }),
  );
});

it("gets detail and generates recommendations", async () => {
  mockFetchJson({ recommendation: improvement });
  await getImprovementRecommendation("rec_1");
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/improvements/recommendations/rec_1"),
    expect.any(Object),
  );

  mockFetchJson({ recommendations: [improvement], generated: 1, updated: 0, skipped: 0 });
  await generateImprovementRecommendations({ filters: { pattern: "missing-evidence" } });
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining("/api/improvements/recommendations/generate"),
    expect.objectContaining({ method: "POST" }),
  );
});
```

Adapt `mockFetchJson` to the existing helper in `api.test.ts`.

- [ ] **Step 2: Run failing API tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts -t "Improvement"
```

Expected: FAIL with missing API client exports.

- [ ] **Step 3: Add dashboard API clients**

Modify `apps/dashboard/lib/api.ts` imports:

```ts
import type {
  ImprovementActionRequest,
  ImprovementActionResponse,
  ImprovementGenerateRequest,
  ImprovementGenerateResponse,
  ImprovementPatchPreviewRequest,
  ImprovementRecommendationDetailResponse,
  ImprovementRecommendationFilters,
  ImprovementRecommendationsListResponse,
} from "@issuepilot/shared-contracts";
```

Add helpers after `getQualitySummary()`:

```ts
function searchFromRecord(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) search.set(key, value);
  }
  return search.toString();
}

export function listImprovementRecommendations(
  filters: ImprovementRecommendationFilters = {},
  opts: ApiGetOptions = {},
): Promise<ImprovementRecommendationsListResponse> {
  const query = searchFromRecord({
    status: filters.status,
    pattern: filters.pattern,
    targetKind: filters.targetKind,
    workflow: filters.workflow,
    taskType: filters.taskType,
  });
  return apiGet<ImprovementRecommendationsListResponse>(
    `/api/improvements/recommendations${query ? `?${query}` : ""}`,
    opts,
  );
}

export function getImprovementRecommendation(
  id: string,
  opts: ApiGetOptions = {},
): Promise<ImprovementRecommendationDetailResponse> {
  return apiGet<ImprovementRecommendationDetailResponse>(
    `/api/improvements/recommendations/${encodeURIComponent(id)}`,
    opts,
  );
}

function improvementPost<TResponse, TBody>(
  path: string,
  body: TBody,
  opts: OperatorActionOptions = {},
): Promise<TResponse> {
  return apiPost<TResponse, TBody>(path, body, opts);
}

export function generateImprovementRecommendations(
  body: ImprovementGenerateRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementGenerateResponse> {
  return improvementPost(
    "/api/improvements/recommendations/generate",
    body,
    opts,
  );
}

export function acceptImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  return improvementPost(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/accept`,
    body,
    opts,
  );
}

export function rejectImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  return improvementPost(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/reject`,
    body,
    opts,
  );
}

export function deferImprovementRecommendation(
  id: string,
  body: ImprovementActionRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  return improvementPost(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/defer`,
    body,
    opts,
  );
}

export function previewImprovementPatch(
  id: string,
  body: ImprovementPatchPreviewRequest = {},
  opts: OperatorActionOptions = {},
): Promise<ImprovementActionResponse> {
  return improvementPost(
    `/api/improvements/recommendations/${encodeURIComponent(id)}/patch-preview`,
    body,
    opts,
  );
}
```

If `apiPost` does not currently accept `OperatorActionOptions`, extend it to forward `x-issuepilot-operator` and `x-issuepilot-project` in the same way existing run/work-item action clients do.

- [ ] **Step 4: Run dashboard API tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit dashboard API**

Run:

```bash
git add apps/dashboard/lib/api.ts apps/dashboard/lib/api.test.ts
git commit -m "feat(dashboard): add improvement recommendation api client"
```

---

## Task 9: Recommendations UI

**Files:**
- Create: `apps/dashboard/components/reports/recommendations.tsx`
- Create: `apps/dashboard/components/reports/recommendations.test.tsx`
- Modify: `apps/dashboard/i18n/messages/zh.json`
- Modify: `apps/dashboard/i18n/messages/en.json`

- [ ] **Step 1: Write failing component tests**

Create `apps/dashboard/components/reports/recommendations.test.tsx`:

```tsx
import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import messages from "../../i18n/messages/en.json";
import { Recommendations } from "./recommendations";

const actions = {
  onGenerate: vi.fn(),
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onDefer: vi.fn(),
  onPreview: vi.fn(),
};

function rec(over: Partial<ImprovementRecommendation> = {}): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: { kind: "prompt_template", description: "Prompt template" },
    evidenceRefs: [
      {
        kind: "quality-drilldown",
        id: "task:wi:t:missing-evidence",
        href: "/work-items/wi?view=evidence",
        reason: "missing evidence",
      },
    ],
    suggestedChange: "Require evidence.",
    patchPreview: {
      status: "generated",
      targetDescription: "Prompt template",
      diff: "+ Require evidence.",
      rollbackNotes: "Remove the added line.",
    },
    confidence: "high",
    risk: "low",
    status: "open",
    actionHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

function renderRecommendations(recommendations: ImprovementRecommendation[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Recommendations recommendations={recommendations} {...actions} />
    </NextIntlClientProvider>,
  );
}

describe("Recommendations", () => {
  it("renders an empty state and generate action", () => {
    renderRecommendations([]);
    expect(screen.getByText("Recommendations")).toBeInTheDocument();
    expect(screen.getByText("No recommendations yet.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate recommendations" }));
    expect(actions.onGenerate).toHaveBeenCalled();
  });

  it("shows queue, evidence, and patch preview", () => {
    renderRecommendations([rec()]);
    fireEvent.click(screen.getByRole("button", { name: /Require evidence/ }));
    expect(screen.getByText("missing-evidence")).toBeInTheDocument();
    expect(screen.getByText("Prompt template")).toBeInTheDocument();
    expect(screen.getByText("+ Require evidence.")).toBeInTheDocument();
    expect(screen.getByText("Remove the added line.")).toBeInTheDocument();
  });

  it("calls accept, reject, defer, and preview handlers", async () => {
    renderRecommendations([rec()]);
    fireEvent.click(screen.getByRole("button", { name: /Require evidence/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Defer" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate patch preview" }));
    await waitFor(() => expect(actions.onAccept).toHaveBeenCalledWith("rec_1"));
    expect(actions.onReject).toHaveBeenCalledWith("rec_1");
    expect(actions.onDefer).toHaveBeenCalledWith("rec_1");
    expect(actions.onPreview).toHaveBeenCalledWith("rec_1");
  });
});
```

- [ ] **Step 2: Run failing component tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/recommendations.test.tsx
```

Expected: FAIL with missing component and missing i18n keys.

- [ ] **Step 3: Add i18n strings**

Add under `reportsPage` in `apps/dashboard/i18n/messages/en.json`:

```json
"recommendations": {
  "title": "Recommendations",
  "description": "Evidence-backed workflow, prompt, project-rule, and skill suggestions generated from Quality Analytics.",
  "generate": "Generate recommendations",
  "empty": "No recommendations yet.",
  "evidence": "Evidence",
  "patchPreview": "Patch preview",
  "rollback": "Rollback",
  "accept": "Accept",
  "reject": "Reject",
  "defer": "Defer",
  "preview": "Generate patch preview",
  "confidence": "Confidence: {value}",
  "risk": "Risk: {value}",
  "status": "Status: {value}",
  "target": "Target: {value}",
  "evidenceCount": "{count} evidence refs"
}
```

Add under `reportsPage` in `apps/dashboard/i18n/messages/zh.json`:

```json
"recommendations": {
  "title": "改进建议",
  "description": "从 Quality Analytics 生成带证据的 workflow、prompt、项目规则和 skill 改进建议。",
  "generate": "生成改进建议",
  "empty": "暂无改进建议。",
  "evidence": "证据",
  "patchPreview": "Patch 预览",
  "rollback": "回滚说明",
  "accept": "接受",
  "reject": "拒绝",
  "defer": "延后",
  "preview": "生成 patch 预览",
  "confidence": "置信度：{value}",
  "risk": "风险：{value}",
  "status": "状态：{value}",
  "target": "目标：{value}",
  "evidenceCount": "{count} 条证据"
}
```

- [ ] **Step 4: Implement the Recommendations component**

Create `apps/dashboard/components/reports/recommendations.tsx`:

```tsx
"use client";

import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";

interface RecommendationsProps {
  recommendations: ImprovementRecommendation[];
  onGenerate: () => Promise<void> | void;
  onAccept: (id: string) => Promise<void> | void;
  onReject: (id: string) => Promise<void> | void;
  onDefer: (id: string) => Promise<void> | void;
  onPreview: (id: string) => Promise<void> | void;
}

export function Recommendations({
  recommendations,
  onGenerate,
  onAccept,
  onReject,
  onDefer,
  onPreview,
}: RecommendationsProps) {
  const t = useTranslations("reportsPage.recommendations");
  const [selectedId, setSelectedId] = useState<string | undefined>(
    recommendations[0]?.recommendationId,
  );
  const selected = useMemo(
    () =>
      recommendations.find((r) => r.recommendationId === selectedId) ??
      recommendations[0],
    [recommendations, selectedId],
  );

  return (
    <section aria-label={t("title")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-fg">
            {t("title")}
          </h2>
          <p className="max-w-2xl text-xs text-fg-muted">{t("description")}</p>
        </div>
        <Button size="sm" onClick={() => void onGenerate()}>
          {t("generate")}
        </Button>
      </div>

      {recommendations.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-fg-subtle">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <ul className="flex flex-col gap-2">
            {recommendations.map((recommendation) => (
              <li key={recommendation.recommendationId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(recommendation.recommendationId)}
                  className="flex w-full flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-medium text-fg">
                    {recommendation.title}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    <Badge tone="warning">{recommendation.problemPattern}</Badge>
                    <Badge tone="neutral">{recommendation.target.kind}</Badge>
                    <Badge tone="info">{recommendation.status}</Badge>
                  </span>
                  <span className="text-xs text-fg-subtle">
                    {t("evidenceCount", {
                      count: recommendation.evidenceRefs.length,
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <Card>
              <CardContent className="flex flex-col gap-3 py-4">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-semibold text-fg">
                    {selected.title}
                  </h3>
                  <p className="text-sm text-fg-muted">{selected.summary}</p>
                  <p className="font-mono text-[11px] text-fg-subtle">
                    {t("target", { value: selected.target.description })}
                  </p>
                  <p className="font-mono text-[11px] text-fg-subtle">
                    {t("confidence", { value: selected.confidence })} ·{" "}
                    {t("risk", { value: selected.risk })} ·{" "}
                    {t("status", { value: selected.status })}
                  </p>
                </div>

                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                    {t("evidence")}
                  </h4>
                  <ul className="flex flex-col gap-1 text-xs text-fg-muted">
                    {selected.evidenceRefs.map((ref) => (
                      <li key={ref.id}>
                        {ref.href ? <Link href={ref.href}>{ref.reason}</Link> : ref.reason}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-fg-subtle">
                    {t("patchPreview")}
                  </h4>
                  <pre className="max-h-56 overflow-auto rounded-md border border-border bg-surface-2 p-3 text-xs text-fg">
                    {selected.patchPreview.diff ?? selected.patchPreview.status}
                  </pre>
                  {selected.patchPreview.rollbackNotes ? (
                    <p className="text-xs text-fg-subtle">
                      {t("rollback")}: {selected.patchPreview.rollbackNotes}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void onAccept(selected.recommendationId)}>
                    {t("accept")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void onDefer(selected.recommendationId)}>
                    {t("defer")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void onReject(selected.recommendationId)}>
                    {t("reject")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void onPreview(selected.recommendationId)}>
                    {t("preview")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Run component tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run components/reports/recommendations.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Recommendations component**

Run:

```bash
git add apps/dashboard/components/reports/recommendations.tsx \
  apps/dashboard/components/reports/recommendations.test.tsx \
  apps/dashboard/i18n/messages/en.json \
  apps/dashboard/i18n/messages/zh.json
git commit -m "feat(dashboard): render improvement recommendations"
```

---

## Task 10: Reports Page Integration

**Files:**
- Modify: `apps/dashboard/app/reports/page.tsx`
- Modify: `apps/dashboard/app/reports/page.test.tsx`
- Modify: `apps/dashboard/components/reports/reports-page.tsx`
- Modify: `apps/dashboard/components/reports/reports-page.test.tsx`

- [ ] **Step 1: Write failing page integration tests**

In `apps/dashboard/components/reports/reports-page.test.tsx`, update the test fixture so `ReportsPage` receives `recommendations`. Add:

```tsx
it("renders recommendations below quality analytics", () => {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReportsPage
        reports={[]}
        quality={qualitySummary()}
        recommendations={[
          {
            recommendationId: "rec_1",
            projectId: "proj-a",
            scope: { mode: "single-project" },
            problemPattern: "missing-evidence",
            title: "Require evidence",
            summary: "Repeated missing evidence",
            target: { kind: "prompt_template", description: "Prompt template" },
            evidenceRefs: [],
            suggestedChange: "Require evidence.",
            patchPreview: {
              status: "not_generated",
              targetDescription: "Prompt template",
            },
            confidence: "high",
            risk: "low",
            status: "open",
            actionHistory: [],
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z",
          },
        ]}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText("Recommendations")).toBeInTheDocument();
  expect(screen.getByText("Require evidence")).toBeInTheDocument();
});
```

In `apps/dashboard/app/reports/page.test.tsx`, mock and assert `listImprovementRecommendations`:

```ts
vi.mocked(listImprovementRecommendations).mockResolvedValue({
  recommendations: [],
});

expect(listImprovementRecommendations).toHaveBeenCalledWith(
  expect.objectContaining({ pattern: "missing-evidence" }),
  expect.any(Object),
);
```

- [ ] **Step 2: Run failing page tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run app/reports/page.test.tsx components/reports/reports-page.test.tsx
```

Expected: FAIL because `ReportsPage` and route do not pass recommendations.

- [ ] **Step 3: Integrate route fetch**

Modify `apps/dashboard/app/reports/page.tsx`:

```ts
import {
  getQualitySummary,
  listImprovementRecommendations,
  listReports,
} from "../../lib/api";
```

Inside `ReportsRoute`, change the fetch:

```tsx
    const [{ reports }, quality, { recommendations }] = await Promise.all([
      listReports(opts),
      getQualitySummary(qualityParams, opts),
      listImprovementRecommendations(
        {
          ...(qualityParams.pattern ? { pattern: qualityParams.pattern } : {}),
          ...(qualityParams.workflow ? { workflow: qualityParams.workflow } : {}),
          ...(qualityParams.taskType ? { taskType: qualityParams.taskType } : {}),
        },
        opts,
      ),
    ]);
    return (
      <ReportsPage
        reports={reports}
        quality={quality}
        recommendations={recommendations}
      />
    );
```

- [ ] **Step 4: Integrate ReportsPage component**

Modify `apps/dashboard/components/reports/reports-page.tsx` imports:

```ts
import type {
  ImprovementRecommendation,
  QualitySummaryResponse,
  RunReportSummary,
} from "@issuepilot/shared-contracts";
```

Import the API actions and component:

```ts
"use client";

import { useRouter } from "next/navigation";

import {
  acceptImprovementRecommendation,
  deferImprovementRecommendation,
  generateImprovementRecommendations,
  previewImprovementPatch,
  rejectImprovementRecommendation,
} from "../../lib/api";
import { Recommendations } from "./recommendations";
```

> Use `useRouter().refresh()`（Next.js 14 App Router）来在 mutation 之后让
> 服务端 `app/reports/page.tsx` 重新拉取
> `getImprovementRecommendations()`；不要用 `window.location.reload()`，
> 它会丢失局部 state、quality filter、滚动位置，并且与 V4.4
> `apps/dashboard/components/reports/quality-analytics.tsx` 的「server
> component 数据 + 局部 client interaction」基线不一致（参见
> `AGENTS.md`「实现规则」节）。

Update props:

```ts
interface ReportsPageProps {
  reports: RunReportSummary[];
  quality: QualitySummaryResponse;
  recommendations: ImprovementRecommendation[];
}
```

Update component signature and render after `<QualityAnalytics summary={quality} />`:

```tsx
export function ReportsPage({
  reports,
  quality,
  recommendations,
}: ReportsPageProps) {
  const t = useTranslations("reportsPage");
  const tCommon = useTranslations("common");
  const dash = tCommon("dash");
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("updatedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  return (
    <div className="flex flex-col gap-6">
      <QualityAnalytics summary={quality} />
      <Recommendations
        recommendations={recommendations}
        onGenerate={() =>
          generateImprovementRecommendations({ filters: quality.filters }).then(
            () => router.refresh(),
          )
        }
        onAccept={(id) =>
          acceptImprovementRecommendation(id).then(() => router.refresh())
        }
        onReject={(id) =>
          rejectImprovementRecommendation(id).then(() => router.refresh())
        }
        onDefer={(id) =>
          deferImprovementRecommendation(id).then(() => router.refresh())
        }
        onPreview={(id) =>
          previewImprovementPatch(id).then(() => router.refresh())
        }
      />
      {/* existing report table */}
    </div>
  );
}
```

Use the actual JSX shape in `reports-page.tsx`; insert the `Recommendations` block directly after the existing `QualityAnalytics` block without changing the report table layout. If `ReportsPage` was previously a server component, mark it `"use client"` here because of `useRouter()`; the server boundary moves up to `app/reports/page.tsx`, which already does the data fetch.

- [ ] **Step 5: Run page integration tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run app/reports/page.test.tsx components/reports/reports-page.test.tsx components/reports/recommendations.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit page integration**

Run:

```bash
git add apps/dashboard/app/reports/page.tsx \
  apps/dashboard/app/reports/page.test.tsx \
  apps/dashboard/components/reports/reports-page.tsx \
  apps/dashboard/components/reports/reports-page.test.tsx
git commit -m "feat(dashboard): wire recommendations into reports"
```

---

## Task 11: Acceptance Docs and Roadmap Links

**Files:**
- Create: `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md`
- Modify: `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Create acceptance document**

Create `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md`:

```md
# IssuePilot V4.5 Workflow / Skills Improvement Loop 验收清单

日期：2026-05-18
状态：implementation in progress

关联文档：

- 设计 spec：`docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md`
- 实施计划：`docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`
- V4 总设计：`docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`

## 验收标准

- [ ] 能从 V4.4 quality facts 生成 `ImprovementRecommendation`。
- [ ] 每条 recommendation 都有 evidence trace。
- [ ] Reports 能展示 recommendation queue 和详情。
- [ ] Operator 能 `accept` / `reject` / `defer`。
- [ ] `accept` 不自动生成 patch preview，也不写文件。
- [ ] `patch-preview` 能生成 inert diff，并记录 `sourceSnapshot.sha256`。
- [ ] Team mode 下 recommendation 按 project 隔离。
- [ ] 重复建议能 dedupe 或 supersede。
- [ ] 缺少 evidence、target 不存在、source stale 时 fail closed。
- [ ] `scripts/ci-equivalent-check.sh` 或等价 gate 通过。

## 验证命令

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/recommendations.test.tsx components/reports/reports-page.test.tsx app/reports/page.test.tsx
scripts/ci-equivalent-check.sh
git diff --check
```

## 验证记录

等待 implementation closeout 填写实际命令输出。
```

- [ ] **Step 2: Confirm implementation plan links in specs**

Confirm `docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md` contains this section after the linked docs:

```md
## 实施计划

- V4.5 Workflow / Skills Improvement Loop：
  `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`
```

Confirm `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md` contains this V4.5 bullet:

```md
- V4.5 Workflow / Skills Improvement Loop：
  `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`
  （实施计划已完成，覆盖 V4.5 recommendation queue、patch preview 和 human apply gate）。
```

- [ ] **Step 3: Update README and changelog landing text**

In `README.md` and `README.zh-CN.md`, change `_V4.5 设计中_` to `_V4.5 实施中_` and add the plan path after the design spec line:

```md
实施计划：
`docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`。
```

In `README.en.md`, change `*in V4.5 design*` to `*in V4.5 implementation*` and add:

```md
Implementation plan:
`docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop.md`.
```

At the top of `CHANGELOG.md`, add:

```md
## [Unreleased] V4.5 Workflow / Skills Improvement Loop

- Added the V4.5 implementation plan for evidence-backed improvement recommendations, operator review actions, and inert patch previews.
```

- [ ] **Step 4: Run documentation check**

Run:

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md \
  docs/superpowers/specs/2026-05-18-issuepilot-v4-5-improvement-loop-design.md \
  docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md \
  README.md README.zh-CN.md README.en.md CHANGELOG.md
git commit -m "docs: track V4.5 improvement loop acceptance"
```

---

## Task 12: Full Validation and Closeout

**Files:**
- Modify: `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md`

- [ ] **Step 1: Run focused shared-contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts src/__tests__/quality.test.ts src/__tests__/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused orchestrator tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run focused dashboard tests**

Run:

```bash
pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/recommendations.test.tsx components/reports/reports-page.test.tsx app/reports/page.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run repository gate**

Run:

```bash
scripts/ci-equivalent-check.sh
```

Expected: PASS. If local runtime needs the bundled Node, use:

```bash
NODE_BIN_DIR="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin" scripts/ci-equivalent-check.sh
```

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: PASS.

- [ ] **Step 6: Update acceptance record**

Modify `docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md` under `## 验证记录` with the actual command results:

```md
## 验证记录

- `pnpm --filter @issuepilot/shared-contracts exec vitest run src/__tests__/improvement.test.ts src/__tests__/quality.test.ts src/__tests__/index.test.ts` → PASS.
- `pnpm --filter @issuepilot/orchestrator exec vitest run src/improvements src/server/__tests__/server.test.ts src/__tests__/improvements-v45-e2e.test.ts` → PASS.
- `pnpm --filter @issuepilot/dashboard exec vitest run lib/api.test.ts components/reports/recommendations.test.tsx components/reports/reports-page.test.tsx app/reports/page.test.tsx` → PASS.
- `scripts/ci-equivalent-check.sh` → PASS.
- `git diff --check` → PASS.
```

If any command needs runtime caveats, record the exact runtime path and skipped stages rather than simplifying the evidence.

- [ ] **Step 7: Commit validation closeout**

Run:

```bash
git add docs/superpowers/plans/2026-05-18-issuepilot-v4-5-improvement-loop-acceptance.md
git commit -m "docs: record V4.5 improvement loop acceptance"
```

---

## Self-Review

### Spec Coverage

- Spec §1-§5 product boundary: covered by Tasks 1, 3, 5, 9, 10.
- Spec §6 architecture: covered by Tasks 2-7.
- Spec §7 target kinds: covered by Tasks 1, 3, 4.
- Spec §8 data model: covered by Task 1 and store/service tasks.
- Spec §9 deterministic recommendation engine: covered by Task 3.
- Spec §10 patch preview safety: covered by Task 4 and Task 7 E2E.
- Spec §11 API: covered by Tasks 6 and 8.
- Spec §12 UI workflow: covered by Tasks 9 and 10.
- Spec §13 error handling: covered by Tasks 4, 5, 6, 7.
- Spec §14-§15 testing and acceptance: covered by Tasks 11 and 12.
- Spec §16 later boundary: preserved; no task implements apply-to-disk, auto-commit, LLM classification, or multi-agent roles.

### Placeholder Scan

This plan intentionally avoids open placeholders. Any code that depends on current test helpers names the expected adaptation point explicitly, for example `buildTestApp()` server overrides and the dashboard `mockFetchJson` helper.

### Type Consistency

- `ImprovementRecommendation`, `ImprovementPatchPreview`, `ImprovementActionHistoryEntry`, request/response names are defined in Task 1 and reused unchanged in later tasks.
- API paths match spec §11 and are reused consistently across server and dashboard tasks.
- `accept` semantics stay explicit: accept changes status/action history only; patch preview is a separate endpoint/action.
