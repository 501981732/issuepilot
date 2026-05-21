# IssuePilot V4.7 Runner Adapter Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 V4.6 三角色 pipeline 从 Codex-specific lifecycle 迁移到稳定的本地 Runner Adapter Contract，让 Coder / Reviewer / Test Evidence 都通过 workflow `runners:` registry 选择 `codex_app_server` adapter，并在 `AgentReport` 中保留 runner 追溯字段。

**Architecture:** `packages/shared-contracts` 定义 runner contract、type guard 和 `AgentReport` 追溯字段；`packages/workflow` 解析并 resolve 静态 `runners:` registry 与 `roles.<role>.runner`；`apps/orchestrator` 新增 runner registry / adapter 层，把现有 Codex app-server lifecycle 收束为 `RunnerAdapter`，agent factory 继续负责把标准 `RunnerResult` 转为 role-specific `AgentReport`。V4.7 不接第二 runner、不做动态 discovery、不改变 V4.6 `PipelineCoordinator` 状态机。

**Tech Stack:** TypeScript 5 (`strict` + `exactOptionalPropertyTypes`), Zod, YAML, Vitest, Fastify 4, Next.js 14 App Router, `@issuepilot/runner-codex-app-server`, `scripts/ci-equivalent-check.sh`

---

## Current Code Facts

- V4.6 `AgentReport` contract 在 `packages/shared-contracts/src/agent-report.ts`；目前只有 `runId`，没有 `runnerId` / `runnerKind` / `runnerRunId`。
- V4.6 role YAML contract 在 `packages/shared-contracts/src/workflow-role.ts`；`WorkflowRoleConfigBase` 目前没有 `runner` 字段。
- Workflow parser 在 `packages/workflow/src/parse.ts`，resolver 在 `packages/workflow/src/resolve.ts`；当前只 resolve role prompt hash。
- Codex lifecycle 入口在 `apps/orchestrator/src/agents/codex-lifecycle.ts`，目前输出 `CoderLifecycleOutcome` / `ReviewerLifecycleOutcome`，不是标准 `RunnerResult`。
- Agent factory 在 `apps/orchestrator/src/agents/coder.ts`、`reviewer.ts`、`test-evidence.ts`；这些文件继续负责业务报告，不允许 runner adapter 直接写 `AgentReport`。
- Pipeline coordinator 在 `apps/orchestrator/src/pipelines/coordinator.ts`，依赖注入三类 `AgentRunner`；V4.7 不改它的状态机，只替换 agent runner 的底层执行器。
- Dashboard 的 role report 展示在 `apps/dashboard/components/work-items/agent-report-tabs.tsx`；V4.7 只增加紧凑的 runner trace metadata，不做页面重构。

## File Structure

### Shared Contracts

- Create `packages/shared-contracts/src/runner.ts`
  - 定义 `RunnerKind`、`RunnerCapability`、`RunnerDescriptor`、`RunnerRunInput`、`RunnerResult`、`RunnerEvent`、`RunnerErrorCode`。
  - 提供 `isRunnerKind`、`isRunnerDescriptor`、`isRunnerResult`、`isRunnerEvent`、capability helper。
  - 不 import workflow loader、orchestrator、Codex RPC 或 filesystem store。
- Modify `packages/shared-contracts/src/agent-report.ts`
  - `AgentReportBase` 新增 `runnerId: string`、`runnerKind: RunnerKind`、`runnerRunId?: string | null`。
  - `isAgentReport()` 要求新字段存在；V4.7 开发期 fixture 直接升级，不做旧 report lazy migration。
- Modify `packages/shared-contracts/src/workflow-role.ts`
  - `WorkflowRoleConfigBase` 新增 `runner: string`。
  - `parseRoleConfig()` 解析 YAML `roles.<role>.runner`，缺省为 `codex_app_server`。
- Modify `packages/shared-contracts/src/index.ts`
  - 导出 `./runner.js`。
- Test `packages/shared-contracts/src/__tests__/runner.test.ts`
- Test `packages/shared-contracts/src/__tests__/agent-report.test.ts`
- Test `packages/shared-contracts/src/__tests__/workflow-role.test.ts`

### Workflow

- Modify `packages/workflow/src/types.ts`
  - `WorkflowConfig` 新增 `runners: Record<string, RunnerDescriptor>`。
- Modify `packages/workflow/src/parse.ts`
  - `WorkflowFrontMatterSchema` 新增 `runners` raw object。
  - 新增 `buildRunnersConfig()`，解析 YAML snake_case options 到 TS camelCase。
  - 缺 `runners:` 时注入内置 `codex_app_server` descriptor，并 emit warning。
  - 拒绝 unknown `codex_app_server.options`、secret-like options、sandbox escalation、unsupported runner kind。
- Modify `packages/workflow/src/resolve.ts`
  - `resolveWorkflow()` 调用 `resolveRunnerRegistry()`，校验 runner id、kind、capability、role sandbox / tools。
  - mixed V4.7 `runners:` + 旧式 per-role runner override 字段 fail closed。
- Modify `packages/workflow/src/index.ts`
  - 如需供 daemon 直接使用，导出 resolver error 类型。
- Test `packages/workflow/src/__tests__/parse.test.ts`
- Test `packages/workflow/src/__tests__/resolve.test.ts`
- Test `packages/workflow/src/__tests__/loader.test.ts`

### Orchestrator Runner Layer

- Create `apps/orchestrator/src/runners/types.ts`
  - 定义 orchestrator 内部 `RunnerAdapter`、`RunnerRegistry`、`RunnerEventSink`。
- Create `apps/orchestrator/src/runners/registry.ts`
  - 从 resolved workflow descriptors + adapter instances 构造 registry。
  - `getRunnerForRole(profile)` 在 run 前 fail closed。
- Create `apps/orchestrator/src/runners/failure-mapping.ts`
  - `RunnerErrorCode` → `LastErrorCode` 映射。
- Create `apps/orchestrator/src/runners/codex-app-server.ts`
  - 把 `spawnRpc` / `driveLifecycle` 封装为 `RunnerAdapter.run(input): Promise<RunnerResult>`。
  - 把 Codex events 映射为 sanitized `RunnerEvent`。
  - 保留 git diff / branch / GitLab MR tool result 的 extraction helper，但通过 `RunnerResult.artifacts` 输出，不直接写 `AgentReport`。
- Modify `apps/orchestrator/src/agents/codex-lifecycle.ts`
  - 删除或缩成临时 compatibility shim；daemon 和新 agent factory 不再依赖 `createCoderLifecycle` / `createReviewerLifecycle`。
- Test `apps/orchestrator/src/runners/__tests__/registry.test.ts`
- Test `apps/orchestrator/src/runners/__tests__/failure-mapping.test.ts`
- Test `apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts`
- Modify tests `apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts` only while deleting compatibility surface.

### Agent Factory / Pipeline Wiring

- Modify `apps/orchestrator/src/pipelines/role-profile.ts`
  - `BaseRoleProfile` 新增 `runnerId: string`，从 `WorkflowRoleConfig.runner` 透传。
- Modify `apps/orchestrator/src/agents/coder.ts`
  - `createCoderAgent()` 改为依赖 runner registry / role runner。
  - `RunnerResult.completed.finalMessage` + artifacts 转为 `CoderAgentReport`。
  - 所有 report 写 `runnerId`、`runnerKind`、`runnerRunId`。
- Modify `apps/orchestrator/src/agents/reviewer.ts`
  - 从 `RunnerResult.completed.finalMessage` 解析 reviewer JSON。
  - runner failed / timeout / cancelled 映射到当前 reviewer report semantics。
- Modify `apps/orchestrator/src/agents/test-evidence.ts`
  - Test Evidence 也通过 runner registry 启动一次 role run；collector 仍负责落 evidence item。
  - runner artifact 只作为可选 evidence link，不替代现有 collector。
- Modify `apps/orchestrator/src/daemon.ts`
  - 使用 resolved workflow runners 创建 `RunnerRegistry`。
  - 注入 `codex_app_server` adapter，而不是直接拼 Codex lifecycle runner。
- Modify `apps/orchestrator/src/team/daemon.ts`
  - team mode 按 project context 创建 project-scoped registry / adapter。
- Modify `apps/orchestrator/src/pipelines/routes.ts` and `apps/orchestrator/src/pipelines/service.ts`
  - `validateWorkflowRoles` 同时返回 runner capability validation。
- Test `apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts`
- Test `apps/orchestrator/src/agents/__tests__/coder.test.ts`
- Test `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`
- Test `apps/orchestrator/src/agents/__tests__/test-evidence.test.ts`
- Test `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
- Test `apps/orchestrator/src/team/__tests__/daemon.test.ts`
- Test `apps/orchestrator/src/pipelines/__tests__/routes.test.ts`

### Dashboard / API Traceability

- Modify `apps/dashboard/components/work-items/agent-report-tabs.tsx`
  - 在每个 role panel header 附近展示 `runnerId`、`runnerKind`、`runnerRunId`（若存在）。
  - UI 约束：使用现有 badge / metadata 风格；不新增页面、不新增大卡片、不改变 tab hierarchy。
- Modify `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`
  - 覆盖 runner metadata 可见、缺 `runnerRunId` 时不显示空值。
- Modify `apps/dashboard/lib/api.test.ts` only if generated examples / fixtures need runner fields.
- Modify `apps/dashboard/app/work-items/[id]/page.test.tsx` only if fixtures need runner fields.

### Docs / Fixtures / Acceptance

- Modify V4.6 / V4.7 fake workflow fixtures under `tests/e2e/fixtures/` and package tests that construct workflow YAML.
- Modify AgentReport fixtures across orchestrator / dashboard tests to include runner fields.
- Create `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`
  - 记录 acceptance checklist 与 verification record。
- Modify `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`
  - 把实施计划指向本文件。
- Modify `README.md`, `README.zh-CN.md`, `README.en.md`, `CHANGELOG.md`
  - implementation 完成后再把 V4.7 状态从 "plan written" 推到 "landed"。

---

## Task 1: Shared Runner Contract

**Files:**

- Create: `packages/shared-contracts/src/runner.ts`
- Modify: `packages/shared-contracts/src/agent-report.ts`
- Modify: `packages/shared-contracts/src/workflow-role.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Test: `packages/shared-contracts/src/__tests__/runner.test.ts`
- Test: `packages/shared-contracts/src/__tests__/agent-report.test.ts`
- Test: `packages/shared-contracts/src/__tests__/workflow-role.test.ts`

- [ ] **Step 1.1: Write failing runner contract tests**

Add `packages/shared-contracts/src/__tests__/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  isRunnerDescriptor,
  isRunnerEvent,
  isRunnerKind,
  isRunnerResult,
  runnerCapabilityForRole,
  type RunnerDescriptor,
  type RunnerEvent,
  type RunnerResult,
} from "../runner.js";

describe("runner contract (V4.7)", () => {
  it("accepts only codex_app_server as V4.7 runner kind", () => {
    expect(isRunnerKind("codex_app_server")).toBe(true);
    expect(isRunnerKind("local_command")).toBe(false);
    expect(isRunnerKind("claude_code")).toBe(false);
  });

  it("validates RunnerDescriptor with adapter-specific options", () => {
    const descriptor: RunnerDescriptor = {
      runnerId: "codex_app_server",
      kind: "codex_app_server",
      displayName: "Codex App Server",
      capabilities: [
        "roles.coder",
        "roles.reviewer",
        "roles.test_evidence",
        "events.streaming",
        "cancel",
        "artifacts",
        "gitlab.tools",
        "filesystem.worktree_write",
      ],
      defaultTimeoutSeconds: 1800,
      options: {
        command: "codex app-server",
        maxTurns: 20,
        turnTimeoutMs: 3_600_000,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
      },
    };

    expect(isRunnerDescriptor(descriptor)).toBe(true);
    expect(runnerCapabilityForRole("coder")).toBe("roles.coder");
  });

  it("rejects invalid runner result and accepts completed result", () => {
    const ok: RunnerResult = {
      status: "completed",
      finalMessage: "done",
      runId: "turn-1",
      artifacts: [{ kind: "text", summary: "summary" }],
    };

    expect(isRunnerResult(ok)).toBe(true);
    expect(isRunnerResult({ status: "success" })).toBe(false);
  });

  it("requires sanitized runner events with correlation fields", () => {
    const event: RunnerEvent = {
      type: "runner_started",
      at: "2026-05-20T00:00:00.000Z",
      runnerId: "codex_app_server",
      pipelineRunId: "pipe-1",
      workItemId: "wi-1",
      taskId: "task-1",
      role: "coder",
      data: { turn: 1, ok: true, note: null },
      redactedFields: [],
    };

    expect(isRunnerEvent(event)).toBe(true);
    expect(
      isRunnerEvent({ ...event, data: { raw: { nested: "not allowed" } } }),
    ).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run:

```bash
npx vitest run packages/shared-contracts/src/__tests__/runner.test.ts
```

Expected: FAIL because `../runner.js` does not exist.

- [ ] **Step 1.3: Add `runner.ts` minimal implementation**

Implement:

```ts
import {
  type AgentRole,
  isAgentRole,
} from "./agent-report.js";
import {
  type WorkflowSandbox,
  type WorkflowToolGrant,
} from "./workflow-role.js";

export const RUNNER_KIND_VALUES = ["codex_app_server"] as const;
export type RunnerKind = (typeof RUNNER_KIND_VALUES)[number];

export const RUNNER_CAPABILITY_VALUES = [
  "roles.coder",
  "roles.reviewer",
  "roles.test_evidence",
  "events.streaming",
  "cancel",
  "artifacts",
  "gitlab.tools",
  "filesystem.readonly",
  "filesystem.worktree_write",
] as const;
export type RunnerCapability = (typeof RUNNER_CAPABILITY_VALUES)[number];

export interface CodexAppServerRunnerOptions {
  command?: string;
  maxTurns?: number;
  turnTimeoutMs?: number;
  approvalPolicy?: "never";
  threadSandbox?: "workspace-write";
}

export interface RunnerDescriptor {
  runnerId: string;
  kind: RunnerKind;
  displayName?: string;
  capabilities: RunnerCapability[];
  defaultTimeoutSeconds?: number;
  options?: CodexAppServerRunnerOptions;
}

export interface RunnerRunInput {
  runnerId: string;
  role: AgentRole;
  prompt: string;
  cwd: string;
  workItemId: string;
  taskId: string;
  pipelineRunId: string;
  roleProfileId: string;
  timeoutSeconds?: number;
  toolAllow: WorkflowToolGrant[];
  sandbox: WorkflowSandbox;
  metadata: Record<string, string | number | boolean>;
}

export interface RunnerArtifact {
  kind: "text" | "diff" | "evidence" | "log" | "tool_result";
  path?: string;
  mimeType?: string;
  summary?: string;
}

export const RUNNER_ERROR_CODE_VALUES = [
  "runner_unavailable",
  "runner_timeout",
  "sandbox_violation",
  "capability_missing",
  "tool_denied",
  "output_unparseable",
  "artifact_collection_failed",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODE_VALUES)[number];

export interface RunnerError {
  code: RunnerErrorCode;
  message: string;
  hint?: string;
}

export interface RunnerResultBase {
  redactedFields?: string[];
}

export type RunnerResult =
  | (RunnerResultBase & { status: "completed"; finalMessage?: string; runId?: string; artifacts?: RunnerArtifact[] })
  | (RunnerResultBase & { status: "failed"; error: RunnerError; runId?: string; artifacts?: RunnerArtifact[] })
  | (RunnerResultBase & { status: "cancelled"; cancelledAt: string; runId?: string })
  | (RunnerResultBase & { status: "timeout"; error: RunnerError; runId?: string });

export const RUNNER_EVENT_TYPE_VALUES = [
  "runner_started",
  "turn_started",
  "tool_call_started",
  "tool_call_completed",
  "runner_message",
  "runner_completed",
  "runner_failed",
  "runner_cancelled",
] as const;
export type RunnerEventType = (typeof RUNNER_EVENT_TYPE_VALUES)[number];

export interface RunnerEvent {
  type: RunnerEventType;
  at: string;
  runnerId: string;
  runnerRunId?: string;
  pipelineRunId: string;
  workItemId: string;
  taskId: string;
  role: AgentRole;
  message?: string;
  data?: Record<string, string | number | boolean | null>;
  redactedFields: string[];
}
```

Also implement type guards:

```ts
const includes = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && values.includes(value);

export const isRunnerKind = (value: unknown): value is RunnerKind =>
  includes(RUNNER_KIND_VALUES, value);

export const isRunnerCapability = (value: unknown): value is RunnerCapability =>
  includes(RUNNER_CAPABILITY_VALUES, value);

export const runnerCapabilityForRole = (role: AgentRole): RunnerCapability =>
  role === "test_evidence" ? "roles.test_evidence" : `roles.${role}`;
```

Keep the guard implementation strict: arrays must be arrays, `data` values must be primitive or null, `local_command` must be rejected.

- [ ] **Step 1.4: Add AgentReport runner trace fields and tests**

Update test helper objects in `packages/shared-contracts/src/__tests__/agent-report.test.ts`:

```ts
runnerId: "codex_app_server",
runnerKind: "codex_app_server",
runnerRunId: "turn-1",
```

Add an explicit test:

```ts
it("V4.7 requires runner trace fields", () => {
  const report = buildCoderReport();
  expect(isAgentReport(report)).toBe(true);
  const withoutRunner = { ...report };
  delete (withoutRunner as Record<string, unknown>).runnerId;
  expect(isAgentReport(withoutRunner)).toBe(false);
});
```

Update `AgentReportBase`:

```ts
import { type RunnerKind, isRunnerKind } from "./runner.js";

export interface AgentReportBase {
  agentReportId: string;
  workItemId?: string;
  pipelineRunId: string;
  taskId: string;
  role: AgentRole;
  roleProfileId: string;
  runnerId: string;
  runnerKind: RunnerKind;
  runnerRunId?: string | null;
  status: AgentReportStatus;
  // existing fields...
}
```

Update `hasCommonAgentReportFields()` to require `typeof value.runnerId === "string"` and `isRunnerKind(value.runnerKind)`.

- [ ] **Step 1.5: Add `roles.<role>.runner` contract**

In `workflow-role.ts`, update `WorkflowRoleConfigBase`:

```ts
runner: string;
```

In `parseRoleConfig()`:

```ts
const runner =
  typeof raw.runner === "string" && raw.runner.length > 0
    ? raw.runner
    : "codex_app_server";

const base: WorkflowRoleConfigBase = {
  role,
  runner,
  promptTemplate: raw.prompt_template,
  sandbox: raw.sandbox,
  // existing fields...
};
```

Add test:

```ts
it("defaults role runner to codex_app_server and parses explicit runner", () => {
  expect(parseRoleConfig({ role: "coder", raw: baseRaw() }).runner).toBe(
    "codex_app_server",
  );
  expect(
    parseRoleConfig({
      role: "coder",
      raw: { ...baseRaw(), runner: "codex-fast" },
    }).runner,
  ).toBe("codex-fast");
});
```

- [ ] **Step 1.6: Export contract**

Add to `packages/shared-contracts/src/index.ts`:

```ts
export * from "./runner.js";
```

- [ ] **Step 1.7: Run shared-contracts tests**

Run:

```bash
npx vitest run packages/shared-contracts/src/__tests__/runner.test.ts packages/shared-contracts/src/__tests__/agent-report.test.ts packages/shared-contracts/src/__tests__/workflow-role.test.ts
```

Expected: PASS.

- [ ] **Step 1.8: Commit**

```bash
git add packages/shared-contracts/src
git commit -m "feat(contracts): add V4.7 runner adapter contract"
```

## Task 2: Workflow Runner Registry Parsing And Resolve

**Files:**

- Modify: `packages/workflow/src/types.ts`
- Modify: `packages/workflow/src/parse.ts`
- Modify: `packages/workflow/src/resolve.ts`
- Modify: `packages/workflow/src/index.ts`
- Test: `packages/workflow/src/__tests__/parse.test.ts`
- Test: `packages/workflow/src/__tests__/resolve.test.ts`
- Test: `packages/workflow/src/__tests__/loader.test.ts`

- [ ] **Step 2.1: Write failing parse tests for `runners:`**

Add tests in `packages/workflow/src/__tests__/parse.test.ts`:

```ts
it("V4.7 parses runners registry and role runner refs", () => {
  const cfg = parseWorkflowString(
    workflowYaml(`
runners:
  codex_app_server:
    kind: codex_app_server
    display_name: Codex App Server
    capabilities:
      - roles.coder
      - roles.reviewer
      - roles.test_evidence
      - events.streaming
      - cancel
      - artifacts
      - gitlab.tools
      - filesystem.worktree_write
    timeout_seconds: 1800
    options:
      command: codex app-server
      max_turns: 20
      turn_timeout_ms: 3600000
      approval_policy: never
      thread_sandbox: workspace-write
roles:
  coder:
    runner: codex_app_server
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
  reviewer:
    runner: codex_app_server
    prompt_template: prompts/reviewer.md
    sandbox: read_only_worktree
  test_evidence:
    runner: codex_app_server
    prompt_template: prompts/test-evidence.md
    sandbox: read_only_source_write_evidence
`),
    "/tmp/WORKFLOW.md",
  );

  expect(cfg.runners.codex_app_server?.kind).toBe("codex_app_server");
  expect(cfg.runners.codex_app_server?.defaultTimeoutSeconds).toBe(1800);
  expect(cfg.runners.codex_app_server?.options?.maxTurns).toBe(20);
  expect(cfg.roles.coder?.runner).toBe("codex_app_server");
});

it.each(["env", "token", "secret", "credential", "cwd", "workspace_root"])(
  "V4.7 rejects forbidden codex option %s",
  (field) => {
    expect(() =>
      parseWorkflowString(
        workflowYaml(`
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.coder]
    options:
      ${field}: nope
`),
        "/tmp/WORKFLOW.md",
      ),
    ).toThrow(/runners\.codex_app_server\.options/);
  },
);

it("V4.7 rejects unsupported runner kinds", () => {
  expect(() =>
    parseWorkflowString(
      workflowYaml(`
runners:
  local:
    kind: local_command
    capabilities: [roles.coder]
`),
      "/tmp/WORKFLOW.md",
    ),
  ).toThrow(/unsupported runner kind/i);
});
```

- [ ] **Step 2.2: Run parse tests to verify failure**

Run:

```bash
npx vitest run packages/workflow/src/__tests__/parse.test.ts
```

Expected: FAIL because `WorkflowConfig.runners` and runner parser do not exist.

- [ ] **Step 2.3: Add workflow `runners` type and parser**

In `packages/workflow/src/types.ts`:

```ts
import type { RunnerDescriptor } from "@issuepilot/shared-contracts";

export interface WorkflowConfig {
  // existing fields...
  runners: Record<string, RunnerDescriptor>;
}
```

In `parse.ts`, add default descriptor:

```ts
const DEFAULT_RUNNERS_CONFIG: Record<string, RunnerDescriptor> = {
  codex_app_server: {
    runnerId: "codex_app_server",
    kind: "codex_app_server",
    displayName: "Codex App Server",
    capabilities: [
      "roles.coder",
      "roles.reviewer",
      "roles.test_evidence",
      "events.streaming",
      "cancel",
      "artifacts",
      "gitlab.tools",
      "filesystem.worktree_write",
    ],
    defaultTimeoutSeconds: 1800,
    options: {
      command: "codex app-server",
      maxTurns: 20,
      turnTimeoutMs: 3_600_000,
      approvalPolicy: "never",
      threadSandbox: "workspace-write",
    },
  },
};
```

Add zod schema only for raw object shape, then validate manually so error messages can point to `runners.<id>`:

```ts
const RunnerRawSchema = z.record(z.string(), z.record(z.string(), z.unknown())).optional();

const WorkflowFrontMatterSchema = z.object({
  // existing fields...
  runners: RunnerRawSchema,
});
```

Implement `buildRunnersConfig(raw, warnings)`:

```ts
function buildRunnersConfig(
  raw: WorkflowFrontMatter["runners"],
  warnings: WorkflowConfigWarning[],
): Record<string, RunnerDescriptor> {
  if (!raw) {
    warnings.push({
      code: "runner_default_used",
      path: "runners.codex_app_server",
      message: "runners 未声明，已 fallback 到内置 codex_app_server descriptor。",
    });
    return structuredClone(DEFAULT_RUNNERS_CONFIG);
  }
  const out: Record<string, RunnerDescriptor> = {};
  for (const [runnerId, value] of Object.entries(raw)) {
    out[runnerId] = parseRunnerDescriptorFromYaml(runnerId, value);
  }
  return out;
}
```

`parseRunnerDescriptorFromYaml()` rules:

- `kind` must be `"codex_app_server"`.
- `capabilities` must be an array of known `RunnerCapability`.
- `timeout_seconds` maps to `defaultTimeoutSeconds`.
- `display_name` maps to `displayName`.
- `options.max_turns` maps to `maxTurns`, `turn_timeout_ms` maps to `turnTimeoutMs`, `approval_policy` maps to `approvalPolicy`, `thread_sandbox` maps to `threadSandbox`.
- Unknown options or forbidden names throw `WorkflowConfigError` at `runners.<runnerId>.options`.

- [ ] **Step 2.4: Write failing resolve tests for capability and runner refs**

In `packages/workflow/src/__tests__/resolve.test.ts`:

```ts
it("V4.7 rejects unknown role runner id", async () => {
  const cfg = parseWorkflowString(workflowYaml(`
roles:
  coder:
    runner: missing
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
`), workflowPath);

  await expect(resolveWorkflow(cfg, root)).rejects.toMatchObject({
    path: "roles.coder.runner",
  });
});

it("V4.7 rejects capability missing before runner starts", async () => {
  const cfg = parseWorkflowString(workflowYaml(`
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.reviewer]
roles:
  coder:
    runner: codex_app_server
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
`), workflowPath);

  await expect(resolveWorkflow(cfg, root)).rejects.toThrow(/capability_missing/);
});

it("V4.7 injects default codex runner when runners and role runner are omitted", async () => {
  const cfg = parseWorkflowString(workflowYaml(""), workflowPath);
  const resolved = await resolveWorkflow(cfg, root);
  expect(resolved.runners.codex_app_server?.kind).toBe("codex_app_server");
  expect(resolved.roles.coder?.runner).toBe("codex_app_server");
});

it("V4.7 rejects legacy per-role runner override when runners registry is declared", () => {
  expect(() =>
    parseWorkflowString(
      workflowYaml(`
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.coder, filesystem.worktree_write]
roles:
  coder:
    runner: codex_app_server
    runner_kind: codex-app-server
    codex:
      max_turns: 10
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
`),
      workflowPath,
    ),
  ).toThrow(/legacy role runner override/i);
});

it("V4.7 still accepts top-level historical agent and codex blocks", () => {
  const cfg = parseWorkflowString(
    workflowYaml(`
agent:
  runner: codex-app-server
  max_turns: 5
codex:
  command: codex app-server
  approval_policy: on-request
  thread_sandbox: read-only
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.coder, filesystem.worktree_write]
roles:
  coder:
    runner: codex_app_server
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
`),
    workflowPath,
  );

  expect(cfg.agent.runner).toBe("codex-app-server");
  expect(cfg.codex.approvalPolicy).toBe("on-request");
  expect(cfg.roles.coder?.runner).toBe("codex_app_server");
});
```

- [ ] **Step 2.5: Implement runner resolver**

In `resolve.ts`, add:

```ts
export class RunnerConfigInvalidError extends Error {
  override readonly name = "RunnerConfigInvalidError";
  constructor(
    message: string,
    public readonly path: string,
    public readonly code: "runner_missing" | "unsupported_runner_kind" | "capability_missing",
  ) {
    super(message);
  }
}
```

Implement:

```ts
function assertRunnerCapabilities(cfg: WorkflowConfig): void {
  for (const role of ["coder", "reviewer", "test_evidence"] as const) {
    const profile = cfg.roles[role];
    if (!profile) continue;
    const runner = cfg.runners[profile.runner];
    if (!runner) {
      throw new RunnerConfigInvalidError(
        `roles.${role}.runner references unknown runner ${profile.runner}`,
        `roles.${role}.runner`,
        "runner_missing",
      );
    }
    if (runner.kind !== "codex_app_server") {
      throw new RunnerConfigInvalidError(
        `unsupported runner kind ${runner.kind}`,
        `runners.${profile.runner}.kind`,
        "unsupported_runner_kind",
      );
    }
    const required = requiredCapabilitiesForRole(profile);
    for (const capability of required) {
      if (!runner.capabilities.includes(capability)) {
        throw new RunnerConfigInvalidError(
          `capability_missing: ${profile.runner} lacks ${capability}`,
          `runners.${profile.runner}.capabilities`,
          "capability_missing",
        );
      }
    }
  }
}
```

Capability mapping:

- Always require `runnerCapabilityForRole(role)`.
- `read_write_worktree` requires `filesystem.worktree_write`.
- `read_only_worktree` requires `filesystem.readonly` or `filesystem.worktree_write`.
- `read_only_source_write_evidence` requires `artifacts` and either filesystem capability.
- `gitlab.*` tools require `gitlab.tools`.
- Runner should not be started if validation fails.

Cutover rule implementation:

- Add a role raw-key guard before `parseRoleConfig()` accepts a role object.
- Allowed role keys are `runner`, `prompt_template`, `sandbox`, `tools`, `timeout_seconds`, `token_scope_requirements`, plus reviewer-only `publish_to_mr`, `severity_threshold`, `max_inline_comments`.
- If `runners:` is present and a role contains legacy runner override keys such as `runner_kind`, `runner_options`, `codex`, `agent`, `command`, `max_turns`, or `turn_timeout_ms`, throw `WorkflowConfigError("legacy role runner override ...", "roles.<role>")`.
- Do not reject top-level historical `agent:` / `codex:` blocks because V1 single-run runtime still parses them; V4.7 role pipeline simply must not use those blocks as runner source of truth.

Call it from `resolveWorkflow()` after prompt hashes:

```ts
const roles = await resolveRolePromptHashes(expanded, configRoot);
const resolved = { ...expanded, roles };
assertRunnerCapabilities(resolved);
return resolved;
```

- [ ] **Step 2.6: Update loader tests**

In `packages/workflow/src/__tests__/loader.test.ts`, ensure `loadWorkflow()` returns resolved `roles.*.promptTemplateHash` and `runners.codex_app_server`. Add one test where omitted `runners:` still yields default.

- [ ] **Step 2.7: Run workflow tests**

Run:

```bash
npx vitest run packages/workflow/src/__tests__/parse.test.ts packages/workflow/src/__tests__/resolve.test.ts packages/workflow/src/__tests__/loader.test.ts
```

Expected: PASS.

- [ ] **Step 2.8: Commit**

```bash
git add packages/workflow/src packages/shared-contracts/src
git commit -m "feat(workflow): resolve V4.7 runner registry"
```

## Task 3: Orchestrator Runner Registry And Failure Mapping

**Files:**

- Create: `apps/orchestrator/src/runners/types.ts`
- Create: `apps/orchestrator/src/runners/registry.ts`
- Create: `apps/orchestrator/src/runners/failure-mapping.ts`
- Test: `apps/orchestrator/src/runners/__tests__/registry.test.ts`
- Test: `apps/orchestrator/src/runners/__tests__/failure-mapping.test.ts`

- [ ] **Step 3.1: Write failing registry tests**

Create `apps/orchestrator/src/runners/__tests__/registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createRunnerRegistry } from "../registry.js";

describe("RunnerRegistry (V4.7)", () => {
  it("returns adapter by role profile runner id", () => {
    const adapter = {
      descriptor: {
        runnerId: "codex_app_server",
        kind: "codex_app_server",
        capabilities: ["roles.coder"],
      },
      run: vi.fn(),
    } as const;

    const registry = createRunnerRegistry({
      descriptors: { codex_app_server: adapter.descriptor },
      adapters: [adapter],
    });

    expect(
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" }),
    ).toBe(adapter);
  });

  it("fails closed for unregistered adapter", () => {
    const registry = createRunnerRegistry({
      descriptors: {
        codex_app_server: {
          runnerId: "codex_app_server",
          kind: "codex_app_server",
          capabilities: ["roles.coder"],
        },
      },
      adapters: [],
    });

    expect(() =>
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" }),
    ).toThrow(/runner_unavailable/);
  });
});
```

- [ ] **Step 3.2: Write failing failure mapping tests**

Create `apps/orchestrator/src/runners/__tests__/failure-mapping.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { runnerErrorToLastErrorCode } from "../failure-mapping.js";

describe("runnerErrorToLastErrorCode", () => {
  it.each([
    ["runner_unavailable", "runner_unavailable"],
    ["runner_timeout", "runner_unavailable"],
    ["sandbox_violation", "sandbox_violation"],
    ["capability_missing", "runner_unavailable"],
    ["tool_denied", "runner_unavailable"],
    ["output_unparseable", "parse_failed"],
    ["artifact_collection_failed", "evidence_unavailable"],
  ] as const)("%s -> %s", (runnerCode, lastErrorCode) => {
    expect(runnerErrorToLastErrorCode(runnerCode)).toBe(lastErrorCode);
  });
});
```

- [ ] **Step 3.3: Implement internal runner types**

`apps/orchestrator/src/runners/types.ts`:

```ts
import type {
  AgentRole,
  RunnerDescriptor,
  RunnerEvent,
  RunnerResult,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";

export interface RunnerEventSink {
  emit(event: RunnerEvent): void | Promise<void>;
}

export interface RunnerAdapter {
  readonly descriptor: RunnerDescriptor;
  run(input: RunnerRunInput, ctx?: { events?: RunnerEventSink }): Promise<RunnerResult>;
}

export interface RunnerLookupInput {
  role: AgentRole;
  runnerId: string;
}

export interface RunnerRegistry {
  getForRole(input: RunnerLookupInput): RunnerAdapter;
}
```

- [ ] **Step 3.4: Implement registry**

`apps/orchestrator/src/runners/registry.ts`:

```ts
import type { RunnerDescriptor } from "@issuepilot/shared-contracts";

import type { RunnerAdapter, RunnerLookupInput, RunnerRegistry } from "./types.js";

export class RunnerRegistryError extends Error {
  override readonly name = "RunnerRegistryError";
  constructor(
    message: string,
    public readonly code: "runner_unavailable" | "capability_missing",
  ) {
    super(message);
  }
}

export function createRunnerRegistry(input: {
  descriptors: Record<string, RunnerDescriptor>;
  adapters: RunnerAdapter[];
}): RunnerRegistry {
  const adapters = new Map(input.adapters.map((a) => [a.descriptor.runnerId, a]));
  return {
    getForRole(lookup: RunnerLookupInput): RunnerAdapter {
      if (!input.descriptors[lookup.runnerId]) {
        throw new RunnerRegistryError(
          `runner ${lookup.runnerId} is not declared`,
          "runner_unavailable",
        );
      }
      const adapter = adapters.get(lookup.runnerId);
      if (!adapter) {
        throw new RunnerRegistryError(
          `runner ${lookup.runnerId} has no registered adapter`,
          "runner_unavailable",
        );
      }
      return adapter;
    },
  };
}
```

- [ ] **Step 3.5: Implement failure mapping**

`apps/orchestrator/src/runners/failure-mapping.ts`:

```ts
import type { LastErrorCode, RunnerErrorCode } from "@issuepilot/shared-contracts";

export const runnerErrorToLastErrorCode = (
  code: RunnerErrorCode,
): LastErrorCode => {
  switch (code) {
    case "sandbox_violation":
      return "sandbox_violation";
    case "output_unparseable":
      return "parse_failed";
    case "artifact_collection_failed":
      return "evidence_unavailable";
    case "runner_unavailable":
    case "runner_timeout":
    case "capability_missing":
    case "tool_denied":
      return "runner_unavailable";
  }
};
```

- [ ] **Step 3.6: Run runner registry tests**

Run:

```bash
npx vitest run apps/orchestrator/src/runners/__tests__/registry.test.ts apps/orchestrator/src/runners/__tests__/failure-mapping.test.ts
```

Expected: PASS.

- [ ] **Step 3.7: Commit**

```bash
git add apps/orchestrator/src/runners
git commit -m "feat(orchestrator): add runner registry"
```

## Task 4: Codex App Server Runner Adapter

**Files:**

- Create: `apps/orchestrator/src/runners/codex-app-server.ts`
- Test: `apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts`
- Modify: `apps/orchestrator/src/agents/codex-lifecycle.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts`
- Modify: `packages/runner-codex-app-server/src/lifecycle.ts` only if the current `DriveResult` lacks fields needed by `RunnerResult`.
- Test: `packages/runner-codex-app-server/src/__tests__/lifecycle.test.ts` only if lifecycle package changes.

- [ ] **Step 4.1: Write failing Codex adapter tests**

Mock `spawnRpc` and `driveLifecycle` in `apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts`:

```ts
import { driveLifecycle, spawnRpc } from "@issuepilot/runner-codex-app-server";
import { describe, expect, it, vi } from "vitest";

import { createCodexAppServerAdapter } from "../codex-app-server.js";

vi.mock("@issuepilot/runner-codex-app-server", () => ({
  spawnRpc: vi.fn(),
  driveLifecycle: vi.fn(),
}));

describe("CodexAppServerRunnerAdapter (V4.7)", () => {
  it("maps completed lifecycle to RunnerResult", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      lastTurnId: "turn-1",
      finalMessage: "done",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    await expect(adapter.run(baseInput())).resolves.toMatchObject({
      status: "completed",
      finalMessage: "done",
      runId: "turn-1",
    });
  });

  it("maps blocked lifecycle to explicit runner error, not raw blocked status", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "blocked",
      lastTurnId: "turn-2",
      failureReason: "tool denied by policy",
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    await expect(adapter.run(baseInput())).resolves.toMatchObject({
      status: "failed",
      error: { code: "tool_denied" },
      runId: "turn-2",
    });
  });

  it("emits sanitized RunnerEvent instead of raw Codex payload", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockImplementation(async (input: never) => {
      const onEvent = (input as { onEvent: (type: string, data: unknown) => void }).onEvent;
      onEvent("codex_notification", { message: "hello", token: "SECRET" });
      return { status: "completed", lastTurnId: "turn-1", finalMessage: "done" } as never;
    });
    const events: unknown[] = [];
    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    await adapter.run(baseInput(), { events: { emit: (event) => events.push(event) } });

    expect(events[0]).toMatchObject({
      type: "runner_message",
      runnerId: "codex_app_server",
      pipelineRunId: "pipe-1",
      workItemId: "wi-1",
      taskId: "task-1",
      role: "coder",
    });
    expect(JSON.stringify(events[0])).not.toContain("SECRET");
  });

  it("uses descriptor options as the V4.7 role-pipeline source of truth", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      lastTurnId: "turn-1",
      finalMessage: "done",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: {
        ...codexDescriptor(),
        options: {
          command: "codex app-server",
          maxTurns: 3,
          turnTimeoutMs: 1234,
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
        },
      },
      codex: {
        ...codexConfig(),
        approvalPolicy: "on-request",
        threadSandbox: "read-only",
      },
    });

    await adapter.run(baseInput());

    expect(driveLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 3,
        turnTimeoutMs: 1234,
        approvalPolicy: "never",
        sandboxType: "workspace-write",
      }),
    );
  });

  it("redacts finalMessage and artifact summaries before returning RunnerResult", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "completed",
      lastTurnId: "turn-secret",
      finalMessage: "token=SECRET_TOKEN",
      completedToolCalls: [
        {
          tool: "gitlab_create_merge_request",
          result: {
            ok: true,
            data: {
              iid: 7,
              webUrl: "https://gitlab/mr/7?token=SECRET_TOKEN",
              state: "opened",
            },
          },
        },
      ],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());

    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(result).toMatchObject({
      status: "completed",
      redactedFields: expect.arrayContaining([
        "finalMessage",
        "artifacts[0].summary",
      ]),
    });
  });

  it("redacts runner error messages before returning failed RunnerResult", async () => {
    vi.mocked(spawnRpc).mockReturnValue({ close: vi.fn() } as never);
    vi.mocked(driveLifecycle).mockResolvedValue({
      status: "failed",
      lastTurnId: "turn-failed",
      failureReason: "runner crashed with token=SECRET_TOKEN",
      completedToolCalls: [],
    } as never);

    const adapter = createCodexAppServerAdapter({
      descriptor: codexDescriptor(),
      codex: codexConfig(),
    });

    const result = await adapter.run(baseInput());

    expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN");
    expect(result).toMatchObject({
      status: "failed",
      error: { message: expect.not.stringContaining("SECRET_TOKEN") },
      redactedFields: expect.arrayContaining(["error.message"]),
    });
  });
});
```

- [ ] **Step 4.2: Implement `createCodexAppServerAdapter`**

Use existing helpers from `apps/orchestrator/src/agents/codex-lifecycle.ts` as source material, but move the standard adapter into `apps/orchestrator/src/runners/codex-app-server.ts`:

```ts
export function createCodexAppServerAdapter(opts: {
  descriptor: RunnerDescriptor;
  codex: WorkflowConfig["codex"];
  tools?: (input: RunnerRunInput) => ToolSchema[];
  now?: () => string;
  onTurnActive?: (cancel: () => Promise<void>) => void;
}): RunnerAdapter {
  return {
    descriptor: opts.descriptor,
    async run(input, ctx) {
      const cmd = splitCommand(
        opts.descriptor.options?.command ?? opts.codex.command,
      );
      const rpc = spawnRpc({ ...cmd, cwd: input.cwd });
      try {
        const result = await driveLifecycle({
          rpc,
          maxTurns: opts.descriptor.options?.maxTurns ?? 20,
          prompt: input.prompt,
          title: `${input.workItemId}/${input.taskId}/${input.role}`,
          cwd: input.cwd,
          threadName: `${input.workItemId}/${input.taskId}/${input.role}`,
          sandboxType: opts.descriptor.options?.threadSandbox ?? "workspace-write",
          approvalPolicy: opts.descriptor.options?.approvalPolicy ?? "never",
          turnSandboxPolicy: opts.codex.turnSandboxPolicy,
          turnTimeoutMs:
            opts.descriptor.options?.turnTimeoutMs ?? opts.codex.turnTimeoutMs,
          tools: opts.tools ? opts.tools(input) : [],
          onEvent: (type, data) => {
            const event = toRunnerEvent(type, data, input, opts.now?.() ?? new Date().toISOString());
            if (event) void ctx?.events?.emit(event);
          },
          ...(opts.onTurnActive ? { onTurnActive: opts.onTurnActive } : {}),
        });
        return mapDriveResultToRunnerResult(result, input.cwd);
      } finally {
        await rpc.close();
      }
    },
  };
}
```

Implementation requirements:

- `completed` → `RunnerResult.status = "completed"`, `runId = lastTurnId`, `finalMessage = finalMessage`.
- `failed` → `RunnerResult.status = "failed"`, `error.code = "runner_unavailable"` unless the failure text clearly maps to sandbox/tool denial.
- `timeout` → `RunnerResult.status = "timeout"`, `error.code = "runner_timeout"`.
- `cancelled` → `RunnerResult.status = "cancelled"`, no `RunnerError`.
- `blocked` → never expose raw `blocked`; map to `tool_denied`, `sandbox_violation`, or `runner_unavailable`.
- V4.7 role-pipeline execution uses `descriptor.options.approvalPolicy` and `descriptor.options.threadSandbox` as source of truth, with safe defaults `never` / `workspace-write`; it must not inherit broader legacy `workflow.codex.approvalPolicy` or `workflow.codex.threadSandbox`.
- Extract coder metadata into artifacts:
  - `{ kind: "diff", summary: "<finalMessage>\n<git diff --stat>" }`
  - `{ kind: "tool_result", summary: "merge_request:<iid>:<url>" }` for `gitlab_create_merge_request`.
- Sanitize event `data` to primitive fields only and redact secret-like keys.
- Redact `finalMessage`, `RunnerArtifact.summary`, `RunnerError.message`, and emitted `RunnerEvent.message` before returning / emitting. Populate `RunnerResult.redactedFields[]` with field paths such as `finalMessage`, `artifacts[0].summary`, and `error.message`.
- The adapter redaction helper must run after artifact extraction, not only on raw lifecycle notification data; otherwise tool-result artifacts can leak URL query tokens or secret-like snippets.

- [ ] **Step 4.3: Keep or remove legacy `codex-lifecycle.ts` surface**

If no production code still imports `createCoderLifecycle` / `createReviewerLifecycle` after Task 5, delete or reduce `apps/orchestrator/src/agents/codex-lifecycle.ts`. If tests still need it temporarily, make it a thin compatibility shim over `createCodexAppServerAdapter` and mark it internal.

Do not leave daemon wiring on legacy lifecycle wrappers after Task 6.

- [ ] **Step 4.4: Run adapter tests**

Run:

```bash
npx vitest run apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts apps/orchestrator/src/agents/__tests__/codex-lifecycle.test.ts
```

Expected: PASS, or `codex-lifecycle.test.ts` removed with the legacy file.

- [ ] **Step 4.5: Commit**

```bash
git add apps/orchestrator/src/runners apps/orchestrator/src/agents packages/runner-codex-app-server/src
git commit -m "feat(orchestrator): adapt Codex lifecycle to RunnerResult"
```

## Task 5: Agent Factories Consume RunnerResult

**Files:**

- Modify: `apps/orchestrator/src/pipelines/role-profile.ts`
- Modify: `apps/orchestrator/src/agents/coder.ts`
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/agents/test-evidence.ts`
- Test: `apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts`
- Test: `apps/orchestrator/src/agents/__tests__/coder.test.ts`
- Test: `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`
- Test: `apps/orchestrator/src/agents/__tests__/test-evidence.test.ts`

- [ ] **Step 5.1: Write failing role-profile test**

In `role-profile.test.ts`:

```ts
it("V4.7 carries role runner id into RoleProfile", async () => {
  const profile = await buildRoleProfile({
    role: {
      role: "coder",
      runner: "codex_app_server",
      promptTemplate: promptPath,
      promptTemplateHash: "a".repeat(64),
      sandbox: "read_write_worktree",
    },
    workItem: workItemCtx(),
    task: taskCtx(),
  });

  expect(profile.runnerId).toBe("codex_app_server");
});
```

- [ ] **Step 5.2: Add `runnerId` to `BaseRoleProfile`**

In `role-profile.ts`:

```ts
export interface BaseRoleProfile {
  role: AgentRole;
  roleProfileId: string;
  runnerId: string;
  prompt: string;
  // existing fields...
}
```

In `buildBase()`:

```ts
runnerId: cfg.runner,
```

- [ ] **Step 5.3: Write failing coder agent tests**

In `coder.test.ts`, replace lifecycle mocks with runner mocks:

```ts
it("V4.7 writes runner trace fields on completed coder report", async () => {
  const runner = {
    descriptor: {
      runnerId: "codex_app_server",
      kind: "codex_app_server",
      capabilities: ["roles.coder"],
    },
    run: vi.fn().mockResolvedValue({
      status: "completed",
      runId: "turn-1",
      finalMessage: "implemented",
      artifacts: [
        { kind: "diff", summary: "src/a.ts | 2 +-" },
        { kind: "tool_result", summary: "merge_request:7:https://gitlab/mr/7" },
      ],
    }),
  } satisfies RunnerAdapter;

  const agent = createCoderAgent({ runnerRegistry: registryWith(runner) });
  const result = await agent.run(baseInput({ profile: coderProfile() }));

  expect(result.kind).toBe("report");
  expect(result.report).toMatchObject({
    runnerId: "codex_app_server",
    runnerKind: "codex_app_server",
    runnerRunId: "turn-1",
    runId: "turn-1",
    coder: {
      diffSummary: "src/a.ts | 2 +-",
      mergeRequest: { iid: 7, url: "https://gitlab/mr/7", state: "opened" },
    },
  });
});

it("V4.7 maps runner timeout to failed coder report", async () => {
  const agent = createCoderAgent({
    runnerRegistry: registryWith(runnerResult({
      status: "timeout",
      runId: "turn-timeout",
      error: { code: "runner_timeout", message: "timed out" },
    })),
  });

  const result = await agent.run(baseInput());
  expect(result.kind).toBe("report");
  expect(result.report.status).toBe("failed");
  expect(result.report.lastError?.code).toBe("runner_unavailable");
});

it("V4.7 propagates runner redaction audit into coder AgentReport", async () => {
  const agent = createCoderAgent({
    runnerRegistry: registryWith(runnerResult({
      status: "completed",
      runId: "turn-redacted",
      finalMessage: "[REDACTED]",
      artifacts: [{ kind: "diff", summary: "[REDACTED]" }],
      redactedFields: ["finalMessage", "artifacts[0].summary"],
    })),
  });

  const result = await agent.run(baseInput());

  expect(result.kind).toBe("report");
  expect(result.report.redactedFields).toEqual(
    expect.arrayContaining([
      "runner.finalMessage",
      "runner.artifacts[0].summary",
    ]),
  );
});

it("V4.7 propagates runner error redaction audit into failed coder AgentReport", async () => {
  const agent = createCoderAgent({
    runnerRegistry: registryWith(runnerResult({
      status: "failed",
      runId: "turn-failed",
      error: { code: "runner_unavailable", message: "[REDACTED]" },
      redactedFields: ["error.message"],
    })),
  });

  const result = await agent.run(baseInput());

  expect(result.kind).toBe("report");
  expect(result.report.redactedFields).toContain("runner.error.message");
});
```

- [ ] **Step 5.4: Implement coder runner consumption**

Change `createCoderAgent()` deps:

```ts
export const createCoderAgent = (deps: {
  runnerRegistry: RunnerRegistry;
  events?: RunnerEventSink;
  now?: () => string;
  newId?: () => string;
}): CoderAgent => { /* ... */ };
```

Build `RunnerRunInput`:

```ts
const adapter = deps.runnerRegistry.getForRole({
  role: "coder",
  runnerId: input.profile.runnerId,
});
const outcome = await adapter.run({
  runnerId: input.profile.runnerId,
  role: "coder",
  prompt: input.profile.prompt,
  cwd: input.cwd,
  workItemId: input.workItem.workItemId,
  taskId: input.task.taskId,
  pipelineRunId: input.pipelineRun.pipelineRunId,
  roleProfileId: input.profile.roleProfileId,
  timeoutSeconds: input.profile.timeoutSeconds,
  toolAllow: input.profile.toolAllow,
  sandbox: input.profile.sandbox,
  metadata: { agentReportRole: "coder" },
}, { events: deps.events });
```

Report mapping:

- completed → `status: "complete"`, `runnerRunId = outcome.runId ?? null`, `runId = outcome.runId`.
- failed / timeout → `status: "failed"`, `lastError.code = runnerErrorToLastErrorCode(outcome.error.code)`.
- cancelled → return `{ kind: "cancelled", cancelledAt }`.
- Registry errors → failed report with `lastError.code = "runner_unavailable"` and no `runnerRunId`.
- Propagate runner redaction audit into `AgentReport.redactedFields[]`. At minimum, redacted `finalMessage`, artifact summaries, or runner error messages must be visible as `runner.finalMessage`, `runner.artifacts[*].summary`, or `runner.error.message` entries.

- [ ] **Step 5.5: Write and implement reviewer agent runner mapping**

Test in `reviewer.test.ts`:

```ts
it("V4.7 parses reviewer JSON from RunnerResult.finalMessage and records runner trace", async () => {
  const agent = createReviewerAgent({
    runnerRegistry: registryWith(runnerResult({
      status: "completed",
      runId: "turn-review",
      finalMessage: "```json\n{\"summary\":\"ok\",\"decision\":\"approve_with_comments\",\"confidence\":0.9,\"findings\":[],\"risks\":[],\"evidenceRequest\":[],\"inlineComments\":[]}\n```",
    })),
  });
  const result = await agent.run(baseReviewerInput());
  expect(result.kind).toBe("report");
  expect(result.report.status).toBe("complete");
  expect(result.report.runnerRunId).toBe("turn-review");
});
```

Implementation mirrors coder, but uses `parseReviewerMessage(result.finalMessage ?? "")`. A completed runner with unparseable reviewer JSON still maps to `status = "failed"` + `lastError.code = "parse_failed"`; runner adapter must not decide reviewer business semantics.

- [ ] **Step 5.6: Write and implement test-evidence runner mapping**

Test in `test-evidence.test.ts`:

```ts
it("V4.7 starts test_evidence through runner before collectors", async () => {
  const collector = fakeCollector({ kind: "item", item: collectedEvidence() });
  const runner = runnerAdapter({
    status: "completed",
    runId: "turn-evidence",
    finalMessage: "collect requested evidence",
  });
  const agent = createTestEvidenceAgent({ runnerRegistry: registryWith(runner) });

  const result = await agent.run(baseEvidenceInput({ collectors: [collector] }));

  expect(runner.run).toHaveBeenCalledWith(
    expect.objectContaining({ role: "test_evidence" }),
    expect.anything(),
  );
  expect(result.kind).toBe("report");
  expect(result.report.runnerRunId).toBe("turn-evidence");
  expect(result.report.status).toBe("complete");
});
```

Implementation requirements:

- Run adapter first with role `test_evidence`.
- If runner failed / timeout, return failed `TestEvidenceAgentReport` before collectors with `lastError` mapped through `runnerErrorToLastErrorCode()` except `artifact_collection_failed` → `evidence_unavailable`.
- If runner completed, run existing collectors unchanged.
- Add runner artifact summaries to `evidenceLinks` only when they are safe links (`path` present or `evidence://` path generated); do not store raw logs.
- Propagate runner redaction audit into the report as in coder / reviewer.

- [ ] **Step 5.7: Run targeted agent tests**

Run:

```bash
npx vitest run apps/orchestrator/src/pipelines/__tests__/role-profile.test.ts apps/orchestrator/src/agents/__tests__/coder.test.ts apps/orchestrator/src/agents/__tests__/reviewer.test.ts apps/orchestrator/src/agents/__tests__/test-evidence.test.ts
```

Expected: PASS.

- [ ] **Step 5.8: Commit**

```bash
git add apps/orchestrator/src/pipelines/role-profile.ts apps/orchestrator/src/agents apps/orchestrator/src/runners
git commit -m "feat(agents): route V4.6 roles through runner adapters"
```

## Task 6: Daemon And Team Wiring

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/pipelines/service.ts`
- Modify: `apps/orchestrator/src/pipelines/routes.ts`
- Test: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
- Test: `apps/orchestrator/src/team/__tests__/daemon.test.ts`
- Test: `apps/orchestrator/src/pipelines/__tests__/service.test.ts`
- Test: `apps/orchestrator/src/pipelines/__tests__/routes.test.ts`

- [ ] **Step 6.1: Write failing daemon wiring test**

In `daemon-pipeline-wiring.test.ts`, add:

```ts
it("V4.7 daemon builds agents from runner registry, not direct Codex lifecycle", async () => {
  const harness = await startDaemonHarness({
    workflow: workflowWithRunners({
      runners: { codex_app_server: codexDescriptor() },
      roles: {
        coder: { runner: "codex_app_server" },
        reviewer: { runner: "codex_app_server" },
        test_evidence: { runner: "codex_app_server" },
      },
    }),
  });

  await harness.acceptPlanAndTick();

  const reports = await harness.pipelineStore.listAllAgentReports();
  expect(reports.every((r) => r.runnerId === "codex_app_server")).toBe(true);
  expect(harness.codexDriveLifecycle).toHaveBeenCalledTimes(3);
});
```

If no existing harness exposes `codexDriveLifecycle`, assert through `AgentReport.runnerId` and absence of `agent_not_configured`.

- [ ] **Step 6.2: Implement single daemon registry construction**

In `daemon.ts`, when resolved workflow is available:

```ts
const runnerRegistry = createRunnerRegistry({
  descriptors: workflow.runners,
  adapters: Object.values(workflow.runners)
    .filter((descriptor) => descriptor.kind === "codex_app_server")
    .map((descriptor) =>
      createCodexAppServerAdapter({
        descriptor,
        codex: workflow.codex,
        tools: (input) => buildToolSchemasForRole(input.role, input),
        onTurnActive: registerCancelForCurrentRun,
      }),
    ),
});
```

This supports registry ids such as `codex_fast` / `codex_readonly` as long as
their descriptor `kind` is `codex_app_server`. V4.7 still rejects non-Codex
`kind` values; it does not instantiate second-runner implementations.

Do not hard-code `workflow.runners.codex_app_server` except when asserting that
the default descriptor exists in tests.

Legacy top-level `workflow.codex` remains the compatibility source for process
defaults and `turnSandboxPolicy`, but V4.7 role pipeline source-of-truth for
`approvalPolicy`, `threadSandbox`, `maxTurns`, `turnTimeoutMs`, and command is
the selected runner descriptor options.

If a descriptor omits an option, adapter applies the safe V4.7 default for
role-pipeline execution (`approvalPolicy: "never"`,
`threadSandbox: "workspace-write"`) or the existing command/timeout fallback
where explicitly allowed by Task 4.

Previous hard-coded anti-pattern to avoid:

```ts
const codexDescriptor = workflow.runners.codex_app_server;
createCodexAppServerAdapter({
  descriptor: codexDescriptor,
      codex: workflow.codex,
});
```

Then create agents:

```ts
const agents = {
  coder: createCoderAgent({ runnerRegistry, events: runnerEventSink }),
  reviewer: createReviewerAgent({ runnerRegistry, events: runnerEventSink }),
  testEvidence: createTestEvidenceAgent({ runnerRegistry, events: runnerEventSink }),
  reviewerPublisher,
};
```

Requirements:

- No daemon path should call `createCoderLifecycle()` / `createReviewerLifecycle()` directly.
- `runnerEventSink` must convert `RunnerEvent` into existing internal event append with sanitized data.
- Codex cwd stays current issue worktree; workflow runner options cannot override cwd.

- [ ] **Step 6.3: Implement team daemon registry construction**

In `team/daemon.ts`, build registry per project / effective workflow:

```ts
function createProjectRunnerRegistry(ctx: ProjectContext): RunnerRegistry {
  const workflow = ctx.workflow;
  return createRunnerRegistry({
    descriptors: workflow.runners,
    adapters: Object.values(workflow.runners)
      .filter((descriptor) => descriptor.kind === "codex_app_server")
      .map((descriptor) =>
      createCodexAppServerAdapter({
        descriptor,
        codex: workflow.codex,
        tools: (input) => buildTeamToolSchemas(ctx, input),
      }),
    ),
  });
}
```

Ensure project A cannot reuse project B tracker/tools or worktree context.

- [ ] **Step 6.4: Extend workflow roles validation endpoint**

`validateWorkflowRoles` should include runner validation errors:

```ts
{
  valid: false,
  errors: [
    {
      code: "capability_missing",
      path: "runners.codex_app_server.capabilities",
      message: "codex_app_server lacks roles.reviewer"
    }
  ]
}
```

Do not start runner during validation.

- [ ] **Step 6.5: Run wiring tests**

Run:

```bash
npx vitest run apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts apps/orchestrator/src/team/__tests__/daemon.test.ts apps/orchestrator/src/pipelines/__tests__/service.test.ts apps/orchestrator/src/pipelines/__tests__/routes.test.ts
```

Expected: PASS.

- [ ] **Step 6.6: Commit**

```bash
git add apps/orchestrator/src
git commit -m "feat(daemon): wire V4.7 runner registry into pipelines"
```

## Task 7: Dashboard Runner Trace Metadata

**Files:**

- Modify: `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Modify: `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`
- Modify: `apps/dashboard/app/work-items/[id]/page.test.tsx`
- Modify: `apps/dashboard/lib/api.test.ts`

- [ ] **Step 7.1: Write failing dashboard test**

In `agent-report-tabs.test.tsx`:

```tsx
it("V4.7 shows compact runner trace metadata", () => {
  render(
    <AgentReportTabs
      reports={{
        coder: coderReport({
          runnerId: "codex_app_server",
          runnerKind: "codex_app_server",
          runnerRunId: "turn-1",
        }),
      }}
    />,
  );

  expect(screen.getByText("codex_app_server")).toBeInTheDocument();
  expect(screen.getByText("turn-1")).toBeInTheDocument();
});

it("V4.7 does not render an empty runnerRunId placeholder", () => {
  render(
    <AgentReportTabs
      reports={{ coder: coderReport({ runnerRunId: null }) }}
    />,
  );

  expect(screen.queryByText("runnerRunId")).not.toBeInTheDocument();
});
```

- [ ] **Step 7.2: Implement metadata UI**

In `agent-report-tabs.tsx`, add a small metadata row reused by role panels:

```tsx
function RunnerTrace({ report }: { report: AgentReport }) {
  return (
    <dl className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
      <div>
        <dt className="font-medium text-foreground">Runner</dt>
        <dd className="break-all">{report.runnerId}</dd>
      </div>
      <div>
        <dt className="font-medium text-foreground">Kind</dt>
        <dd>{report.runnerKind}</dd>
      </div>
      {report.runnerRunId ? (
        <div>
          <dt className="font-medium text-foreground">Run</dt>
          <dd className="break-all">{report.runnerRunId}</dd>
        </div>
      ) : null}
    </dl>
  );
}
```

UI guardrails:

- Reuse existing text scale and muted metadata style.
- Do not add a nested card.
- Keep labels visible text, not hover-only.
- Ensure long ids wrap (`break-all`) and do not cause horizontal scroll.

- [ ] **Step 7.3: Update dashboard fixtures**

All `coderReport()` / `reviewerReport()` / `testEvidenceReport()` helpers must include:

```ts
runnerId: "codex_app_server",
runnerKind: "codex_app_server",
runnerRunId: "turn-1",
```

Use role-specific `turn-coder`, `turn-reviewer`, `turn-test-evidence` when tests assert display.

- [ ] **Step 7.4: Run dashboard tests**

Run:

```bash
npx vitest run apps/dashboard/components/work-items/agent-report-tabs.test.tsx apps/dashboard/app/work-items/[id]/page.test.tsx apps/dashboard/lib/api.test.ts
```

Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add apps/dashboard
git commit -m "feat(dashboard): show V4.7 runner trace metadata"
```

## Task 8: V4.7 E2E Fixtures And Acceptance Record

**Files:**

- Modify: `tests/e2e/fixtures/codex.happy.json`
- Modify: relevant workflow fixtures under `tests/e2e/fixtures/`
- Modify: `apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts`
- Create: `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`
- Modify: `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 8.1: Update workflow fixtures to V4.7 shape**

Every V4 pipeline workflow fixture should declare:

```yaml
runners:
  codex_app_server:
    kind: codex_app_server
    display_name: Codex App Server
    capabilities:
      - roles.coder
      - roles.reviewer
      - roles.test_evidence
      - events.streaming
      - cancel
      - artifacts
      - gitlab.tools
      - filesystem.worktree_write
    timeout_seconds: 1800
    options:
      command: codex app-server
      max_turns: 20
      turn_timeout_ms: 3600000
      approval_policy: never
      thread_sandbox: workspace-write
```

And every role should include:

```yaml
roles:
  coder:
    runner: codex_app_server
    prompt_template: prompts/coder.md
    sandbox: read_write_worktree
```

- [ ] **Step 8.2: Add E2E assertion for runner trace**

In the V4.6 multi-agent E2E suite, after pipeline completes:

```ts
expect(agentReports.map((r) => [r.role, r.runnerId, r.runnerKind])).toEqual([
  ["coder", "codex_app_server", "codex_app_server"],
  ["reviewer", "codex_app_server", "codex_app_server"],
  ["test_evidence", "codex_app_server", "codex_app_server"],
]);
expect(agentReports.every((r) => r.runnerRunId)).toBe(true);
```

- [ ] **Step 8.3: Create V4.7 acceptance checklist**

Create `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`:

```md
# IssuePilot V4.7 Runner Adapter Contract 验收清单

日期：2026-05-20
状态：实施中

- [ ] Shared runner contract exported and tested.
- [ ] Workflow `runners:` registry parse / resolve / capability fail-closed tested.
- [ ] Codex app-server runs through `RunnerAdapter`.
- [ ] Coder / Reviewer / Test Evidence `AgentReport` include runner trace fields.
- [ ] Daemon and team daemon no longer construct Codex lifecycle runners directly.
- [ ] Runner events persisted only after sanitization / redaction.
- [ ] Runner final messages, artifact summaries, and error messages are redacted before persistence; `AgentReport.redactedFields[]` records the affected fields.
- [ ] Dashboard shows runner trace metadata without layout regression.
- [ ] V4.6 full pipeline E2E still passes with default `codex_app_server`.
- [ ] `scripts/ci-equivalent-check.sh` passes.
```

- [ ] **Step 8.4: Update V4.7 spec and README status**

In `docs/superpowers/specs/2026-05-20-issuepilot-v4-7-runner-adapter-contract-design.md`, link this implementation plan and acceptance checklist.

In README files, add a concise V4.7 roadmap bullet only after implementation:

```md
- **Runner Adapter Contract** — _V4.7 已落地_。V4.6 三角色 pipeline 通过
  `runners:` registry 选择 `codex_app_server` adapter；`AgentReport`
  记录 runner trace，后续第二 runner 可在同一 contract 上接入。
```

Before implementation completes, use `_V4.7 实施中_` and do not claim second-runner support.

- [ ] **Step 8.5: Run E2E and gate**

Run targeted E2E first:

```bash
npx vitest run apps/orchestrator/src/__tests__/v4-6-multi-agent-e2e.test.ts
```

Then full gate:

```bash
scripts/ci-equivalent-check.sh
```

Expected: PASS. If local runtime cannot run the full gate, record exact command, exit code, and error text in the acceptance checklist; do not mark V4.7 landed.

- [ ] **Step 8.6: Final whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 8.7: Commit**

```bash
git add tests apps packages docs README.md README.zh-CN.md README.en.md CHANGELOG.md
git commit -m "feat(v4.7): complete runner adapter contract"
```

## Task 9: Final Review And Handoff

**Files:**

- Modify: `docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 9.1: Run full verification**

Run:

```bash
scripts/ci-equivalent-check.sh
```

Expected:

- `tsc -b` PASS
- scripts tsc PASS
- Next build PASS
- eslint PASS
- all package Vitest suites PASS
- `tests/e2e` PASS
- `git diff --check` PASS

- [ ] **Step 9.2: Confirm no V4.7 scope creep**

Use `rg` to verify V4.7 did not introduce unsupported runner kinds or dynamic discovery:

```bash
rg -n "local_command|claude_code|dynamic discovery|worker pool|remote runner|runner sdk|plugin marketplace" packages apps docs
```

Expected: only spec future-work / non-goal text mentions those terms; no production code accepts them.

- [ ] **Step 9.3: Update acceptance record**

Append a verification record:

```md
## Verification record (YYYY-MM-DD)

- `npx vitest run ...` PASS
- `scripts/ci-equivalent-check.sh` PASS
- `git diff --check` PASS

Notes:

- V4.7 still only supports `codex_app_server`.
- No dynamic runner discovery, second runner, worker pool, remote runner service, or SDK was added.
```

- [ ] **Step 9.4: Final commit**

```bash
git add docs/superpowers/plans/2026-05-20-issuepilot-v4-7-runner-adapter-contract-acceptance.md CHANGELOG.md
git commit -m "docs(v4.7): record runner adapter acceptance"
```

---

## Risk Controls

| Risk | Control |
| --- | --- |
| Runner adapter starts writing business `AgentReport` directly | Keep `RunnerResult` in shared contract and agent factory mapping in `apps/orchestrator/src/agents/*`; review imports to ensure runner layer does not import `PipelineStore`. |
| Workflow options leak secrets | `codex_app_server.options` allowlist rejects `env`, `token`, `secret`, `credential`, `cwd`, `workspaceRoot`, unknown fields. |
| Capability missing silently falls back to broader runner | `resolveWorkflow()` and `RunnerRegistry.getForRole()` fail closed; no fallback to another runner. |
| TestEvidence remains collector-only and bypasses runner contract | Task 5 requires test_evidence starts through runner registry before collectors and records runner trace. |
| Dashboard layout gets noisier | Task 7 limits UI to compact metadata row inside existing panel, uses wrapping text and no nested cards. |
| V4.7 accidentally becomes V3 worker platform | Scope checks reject `local_command`, dynamic discovery, worker pool, remote runner service, and SDK. |

## Implementation Notes

- Commit after each task; keep contract/workflow/orchestrator/dashboard/docs commits separate.
- When a test fixture creates `AgentReport`, add `runnerId`, `runnerKind`, and usually `runnerRunId`; V4.7 intentionally does not keep old report compatibility.
- Do not update README to "V4.7 landed" until full gate passes.
- If V4.5 improvement-loop implementation files are absent on the target branch, do not add a new dependency on them; V4.7 only needs current `AgentReport.lastError` / quality consumption to keep working.
