# IssuePilot V4.8 第二 Runner 自用验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 V4.7 Runner Adapter Contract 上接入第二个真实本地 runner kind：`claude_code`，用 reviewer-first mixed-runner pipeline 验证 contract，而不提前进入 V3 runner 平台化。

**Architecture:** 先把 `@issuepilot/shared-contracts` 的 runner kind、options 和 event contract 扩到多 kind；再让 `@issuepilot/workflow` 解析 `claude_code` 静态 descriptor 并 fail closed；随后在 orchestrator 新增 `claude_code` driver/adapter，并让 daemon/team daemon 按 workflow descriptor 注册 adapter。Agent factory 只消费标准 `RunnerResult`，写入真实 `adapter.descriptor.kind`，dashboard 只扩现有 runner trace 和 reports 维度。

**Tech Stack:** TypeScript 5（`strict` + `exactOptionalPropertyTypes`）、Vitest、Fastify 4、Next.js 14 App Router、React、next-intl、`@issuepilot/shared-contracts`、`@issuepilot/workflow`、真实本地 Claude Code CLI（opt-in smoke）、`scripts/ci-equivalent-check.sh`。

---

## Scope Check

本计划只实现 `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`。

**In scope:**

- `RunnerKind` 新增 `claude_code`。
- `RunnerDescriptor.options` 改成按 `kind` 分支的 allowlist。
- `RunnerEventType` 新增标准 `tool_call_failed`，Codex adapter 也同步映射。
- workflow `runners:` 支持 `claude_code` descriptor，禁止 secret / cwd / shell / args / script / env 等危险字段。
- 新增 `claude_code` adapter 和 fake-driver 单测；真实 CLI 自用验证走 opt-in smoke。
- daemon / team daemon 按 descriptor 注册 `codex_app_server` 与 `claude_code` adapters。
- reviewer role 支持 `runnerKind=claude_code` 的 `ReviewerAgentReport`。
- dashboard runner trace i18n 支持 `claude_code`，unknown kind fallback 保持可用。
- 新增 V4.8 acceptance 文档，记录默认 gate 与真实 CLI dog-food 结果或精确跳过原因。

**Out of scope:**

- 不做 dynamic discovery、runner SDK、插件市场、worker pool、remote runner service。
- 不把 `claude_code` 设为默认 runner。
- 不做自动 runner selection 或 A/B benchmark 产品化。
- 不做 production sandbox、RBAC、预算、审计平台或 Postgres。
- 不允许 workflow 持久化 token、secret、env、cwd、shell snippet、任意 CLI args。

## Current Code Facts

- `packages/shared-contracts/src/runner.ts` 当前 `RUNNER_KIND_VALUES = ["codex_app_server"]`，`RunnerDescriptor.options` 只有 `CodexAppServerRunnerOptions`。
- `packages/shared-contracts/src/runner.ts` 当前 `RUNNER_EVENT_TYPE_VALUES` 没有 `tool_call_failed`；`apps/orchestrator/src/runners/codex-app-server.ts` 把 lifecycle `tool_call_failed` 临时映射为 `runner_message`。
- `packages/workflow/src/parse.ts` 当前所有 `runners.*.options` 都走 `parseCodexAppServerOptions()`。
- `packages/workflow/src/resolve.ts` 当前显式拒绝 `runner.kind !== "codex_app_server"`。
- `apps/orchestrator/src/runners/` 已有 `types.ts`、`registry.ts`、`codex-app-server.ts` 和 failure mapping。
- `apps/orchestrator/src/agents/{coder,reviewer,test-evidence}.ts` 当前在 `AgentReport.runnerKind` 上硬编码 `codex_app_server`，V4.8 必须改成来自 `adapter.descriptor.kind`。
- `apps/dashboard/components/work-items/agent-report-tabs.tsx` 的 `runnerKindLabel()` 是 exhaustive switch，目前只有 `codex_app_server`。
- i18n 文件为 `apps/dashboard/i18n/messages/zh.json` 和 `apps/dashboard/i18n/messages/en.json`。

## File Structure

### Shared Contracts

- Modify `packages/shared-contracts/src/runner.ts`
  - `RUNNER_KIND_VALUES` 加 `claude_code`。
  - 新增 `ClaudeCodeRunnerOptions`、`RunnerOptionsByKind`、`RunnerDescriptorByKind` 或等价 discriminated union。
  - `RunnerDescriptor.options` 按 `kind` 收窄。
  - `RUNNER_EVENT_TYPE_VALUES` 加 `tool_call_failed`。
- Modify `packages/shared-contracts/src/__tests__/runner.test.ts`
  - 覆盖 `claude_code` kind、options guard、`tool_call_failed` event guard。

### Workflow

- Modify `packages/workflow/src/parse.ts`
  - 新增 `parseRunnerOptionsByKind(runnerId, kind, raw)`。
  - 新增 `parseClaudeCodeOptions()`，只允许 `command`、`model`、`max_turns`、`turn_timeout_ms`。
  - forbidden keys 对所有 kind 生效。
- Modify `packages/workflow/src/resolve.ts`
  - 移除 hard-coded `codex_app_server` kind 拒绝。
  - 对 `claude_code` 保持 role capability / sandbox / tool grants fail closed。
  - reviewer read-only mixed-runner 配置通过；coder + `claude_code` 只有 descriptor 显式声明 `roles.coder` 且 `filesystem.worktree_write` 时才通过。
- Modify `packages/workflow/src/__tests__/parse.test.ts`
- Modify `packages/workflow/src/__tests__/resolve.test.ts`

### Orchestrator Runner Layer

- Create `apps/orchestrator/src/runners/claude-code-driver.ts`
  - 封装 local CLI process driver 接口和默认实现。
- Create `apps/orchestrator/src/runners/claude-code.ts`
  - 实现 `createClaudeCodeAdapter()`。
- Create `apps/orchestrator/src/runners/__tests__/claude-code.test.ts`
  - fake driver 覆盖 completed / failed / cancelled / timeout / redaction / event emission。
- Modify `apps/orchestrator/src/runners/codex-app-server.ts`
  - `tool_call_failed` 映射回标准 `RunnerEventType`。
- Modify `apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts`

### Agent Factories

- Modify `apps/orchestrator/src/agents/coder.ts`
- Modify `apps/orchestrator/src/agents/reviewer.ts`
- Modify `apps/orchestrator/src/agents/test-evidence.ts`
  - `AgentReport.runnerKind` 使用实际 `adapter.descriptor.kind`。
  - registry 未命中时保留 `codex_app_server` fallback 仅用于失败报告，或从 workflow descriptor lookup 注入 expected kind。
- Modify tests:
  - `apps/orchestrator/src/agents/__tests__/coder.test.ts`
  - `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`
  - `apps/orchestrator/src/agents/__tests__/test-evidence.test.ts`

### Daemon / Team Wiring

- Modify `apps/orchestrator/src/daemon.ts`
- Modify `apps/orchestrator/src/team/daemon.ts`
  - 从 resolved workflow descriptors 创建 adapters：`codex_app_server` -> `createCodexAppServerAdapter()`，`claude_code` -> `createClaudeCodeAdapter()`。
- Modify tests:
  - `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
  - `apps/orchestrator/src/team/__tests__/daemon-pipeline-wiring.test.ts` 或现有 team daemon test 文件。

### Dashboard / Reports

- Modify `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Modify `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`
- Modify `apps/dashboard/i18n/messages/zh.json`
- Modify `apps/dashboard/i18n/messages/en.json`
- Modify quality/report tests only if existing quality aggregation treats runner kind as fixed.

### Docs

- Create `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
- Modify:
  - `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
  - `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`
  - `README.md`
  - `README.zh-CN.md`
  - `README.en.md`
  - `CHANGELOG.md`

## Task 1: Shared Runner Contract

**Files:**

- Modify: `packages/shared-contracts/src/runner.ts`
- Modify: `packages/shared-contracts/src/__tests__/runner.test.ts`

- [x] **Step 1.1: Write failing tests for `claude_code` kind and `tool_call_failed`**

Add tests:

```ts
it("V4.8: accepts claude_code as a runner kind", () => {
  expect(isRunnerKind("codex_app_server")).toBe(true);
  expect(isRunnerKind("claude_code")).toBe(true);
  expect([...RUNNER_KIND_VALUES]).toEqual(["codex_app_server", "claude_code"]);
});

it("V4.8: validates claude_code descriptor options", () => {
  const descriptor: RunnerDescriptor = {
    runnerId: "claude_reviewer",
    kind: "claude_code",
    displayName: "Claude Code Reviewer",
    capabilities: ["roles.reviewer", "events.streaming", "cancel", "artifacts", "filesystem.readonly"],
    options: { command: "claude", model: "sonnet", maxTurns: 3, turnTimeoutMs: 600000 },
  };
  expect(isRunnerDescriptor(descriptor)).toBe(true);
});

it("V4.8: accepts tool_call_failed as a standard runner event", () => {
  const event: RunnerEvent = {
    type: "tool_call_failed",
    at: "2026-05-21T00:00:00.000Z",
    runnerId: "claude_reviewer",
    runnerRunId: "claude-run-1",
    pipelineRunId: "pipe-1",
    workItemId: "wi-1",
    taskId: "task-1",
    role: "reviewer",
    message: "tool failed",
    redactedFields: [],
  };
  expect(isRunnerEvent(event)).toBe(true);
});
```

- [x] **Step 1.2: Run tests and confirm they fail**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts vitest run src/__tests__/runner.test.ts
```

Expected: tests fail because `claude_code` and `tool_call_failed` are not in the current contract.

- [x] **Step 1.3: Extend runner contract**

Implement:

```ts
export const RUNNER_KIND_VALUES = ["codex_app_server", "claude_code"] as const;

export interface ClaudeCodeRunnerOptions {
  command?: string;
  model?: string;
  maxTurns?: number;
  turnTimeoutMs?: number;
}

export type RunnerOptionsByKind = {
  codex_app_server: CodexAppServerRunnerOptions;
  claude_code: ClaudeCodeRunnerOptions;
};

export type RunnerDescriptor =
  | {
      runnerId: string;
      kind: "codex_app_server";
      displayName?: string;
      capabilities: RunnerCapability[];
      defaultTimeoutSeconds?: number;
      options?: CodexAppServerRunnerOptions;
    }
  | {
      runnerId: string;
      kind: "claude_code";
      displayName?: string;
      capabilities: RunnerCapability[];
      defaultTimeoutSeconds?: number;
      options?: ClaudeCodeRunnerOptions;
    };
```

Update `RUNNER_EVENT_TYPE_VALUES`:

```ts
export const RUNNER_EVENT_TYPE_VALUES = [
  "runner_started",
  "turn_started",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "runner_message",
  "runner_completed",
  "runner_failed",
  "runner_cancelled",
] as const;
```

Keep `isRunnerDescriptor()` strict: it must reject unknown kinds and non-object `options`.

- [x] **Step 1.4: Run shared-contract tests**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts vitest run src/__tests__/runner.test.ts src/__tests__/agent-report.test.ts
```

Expected: PASS.

- [x] **Step 1.5: Commit**

```bash
git add packages/shared-contracts/src/runner.ts packages/shared-contracts/src/__tests__/runner.test.ts
git commit -m "feat(v4.8): extend runner contract for claude code"
```

## Task 2: Workflow Parser And Resolver

**Files:**

- Modify: `packages/workflow/src/parse.ts`
- Modify: `packages/workflow/src/resolve.ts`
- Modify: `packages/workflow/src/__tests__/parse.test.ts`
- Modify: `packages/workflow/src/__tests__/resolve.test.ts`

- [x] **Step 2.1: Write failing parser tests**

Add parser test:

```ts
it("V4.8: parses claude_code runner options with kind-specific allowlist", () => {
  const cfg = parseWorkflowConfig(`---
runners:
  claude_reviewer:
    kind: claude_code
    display_name: Claude Code Reviewer
    capabilities: [roles.reviewer, events.streaming, cancel, artifacts, filesystem.readonly]
    options:
      command: claude
      model: sonnet
      max_turns: 3
      turn_timeout_ms: 600000
roles:
  reviewer:
    prompt_template: prompts/reviewer.md
    runner: claude_reviewer
---`);

  expect(cfg.runners.claude_reviewer?.kind).toBe("claude_code");
  expect(cfg.runners.claude_reviewer?.options).toEqual({
    command: "claude",
    model: "sonnet",
    maxTurns: 3,
    turnTimeoutMs: 600000,
  });
});
```

Add forbidden option matrix:

```ts
it.each(["env", "token", "secret", "credential", "cwd", "workspace_root", "shell", "args", "script", "stdin_template"])(
  "V4.8: rejects claude_code forbidden option %s",
  (key) => {
    expect(() =>
      parseWorkflowConfig(`---
runners:
  claude_reviewer:
    kind: claude_code
    capabilities: [roles.reviewer, filesystem.readonly]
    options:
      ${key}: nope
roles:
  reviewer:
    runner: claude_reviewer
---`),
    ).toThrow(/options/);
  },
);
```

- [x] **Step 2.2: Write failing resolver tests**

Add resolver tests:

```ts
it("V4.8: resolves reviewer role through claude_code runner", async () => {
  const cfg = await loadResolvedFixture(`
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.coder, roles.test_evidence, filesystem.worktree_write, artifacts]
  claude_reviewer:
    kind: claude_code
    capabilities: [roles.reviewer, events.streaming, cancel, artifacts, filesystem.readonly]
roles:
  coder:
    runner: codex_app_server
  reviewer:
    runner: claude_reviewer
  test_evidence:
    runner: codex_app_server
`);

  expect(cfg.roles.reviewer?.runner).toBe("claude_reviewer");
  expect(cfg.runners.claude_reviewer?.kind).toBe("claude_code");
});

it("V4.8: fails closed when claude_code reviewer lacks filesystem.readonly", async () => {
  await expect(loadResolvedFixture(`
runners:
  claude_reviewer:
    kind: claude_code
    capabilities: [roles.reviewer]
roles:
  reviewer:
    runner: claude_reviewer
    sandbox: readonly
`)).rejects.toMatchObject({ code: "capability_missing" });
});
```

- [x] **Step 2.3: Run workflow tests and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/workflow vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts
```

Expected: parser rejects `claude_code`; resolver rejects non-Codex kind.

- [x] **Step 2.4: Implement kind-specific options parsing**

Replace direct `parseCodexAppServerOptions()` call with:

```ts
if (obj.options !== undefined) {
  descriptor.options = parseRunnerOptionsByKind(runnerId, kindRaw, obj.options);
}
```

Add:

```ts
function parseRunnerOptionsByKind(
  runnerId: string,
  kind: RunnerKind,
  raw: unknown,
): RunnerDescriptor["options"] {
  switch (kind) {
    case "codex_app_server":
      return parseCodexAppServerOptions(runnerId, raw);
    case "claude_code":
      return parseClaudeCodeOptions(runnerId, raw);
  }
}
```

Implement `parseClaudeCodeOptions()` with the same numeric validation as Codex options and only these keys:

```ts
case "command":
case "model":
case "max_turns":
case "turn_timeout_ms":
```

- [x] **Step 2.5: Update resolver**

Remove:

```ts
if (runner.kind !== "codex_app_server") {
  throw new RunnerConfigInvalidError(...);
}
```

Keep capability, sandbox and GitLab tool checks unchanged. This makes `claude_code` pass only when its descriptor explicitly declares the capabilities required by the role.

- [x] **Step 2.6: Run workflow tests**

Run:

```bash
pnpm --filter @issuepilot/workflow vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts
```

Expected: PASS.

- [x] **Step 2.7: Commit**

```bash
git add packages/workflow/src/parse.ts packages/workflow/src/resolve.ts packages/workflow/src/__tests__/parse.test.ts packages/workflow/src/__tests__/resolve.test.ts
git commit -m "feat(v4.8): parse claude code runner descriptors"
```

## Task 3: Standardize `tool_call_failed` Events

**Files:**

- Modify: `apps/orchestrator/src/runners/codex-app-server.ts`
- Modify: `apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts`

- [x] **Step 3.1: Update failing Codex adapter test**

Change the V4.7 regression test from expecting `runner_message` to:

```ts
expect(events.at(-1)).toMatchObject({
  type: "tool_call_failed",
  runnerId: "codex_app_server",
  role: "coder",
});
```

- [x] **Step 3.2: Run test and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/codex-app-server.test.ts
```

Expected: FAIL because current mapping still emits `runner_message`.

- [x] **Step 3.3: Change mapping**

Update:

```ts
tool_call_failed: "tool_call_failed",
```

Keep terminal event emission unchanged.

- [x] **Step 3.4: Run adapter tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/codex-app-server.test.ts
```

Expected: PASS.

- [x] **Step 3.5: Commit**

```bash
git add apps/orchestrator/src/runners/codex-app-server.ts apps/orchestrator/src/runners/__tests__/codex-app-server.test.ts
git commit -m "fix(v4.8): restore tool call failed runner event"
```

## Task 4: Claude Code Driver And Adapter

**Files:**

- Create: `apps/orchestrator/src/runners/claude-code-driver.ts`
- Create: `apps/orchestrator/src/runners/claude-code.ts`
- Create: `apps/orchestrator/src/runners/__tests__/claude-code.test.ts`

- [x] **Step 4.1: Write fake-driver adapter tests**

Test completed mapping:

```ts
it("maps completed claude code driver result to RunnerResult", async () => {
  const events: RunnerEvent[] = [];
  const adapter = createClaudeCodeAdapter({
    descriptor: claudeDescriptor(),
    driver: fakeDriver({
      status: "completed",
      runnerRunId: "claude-run-1",
      finalMessage: "{\"summary\":\"LGTM\",\"decision\":\"approve_with_comments\",\"confidence\":0.82,\"risks\":[],\"evidence_request\":[],\"findings\":[],\"inline_comments\":[]}",
      artifacts: [{ kind: "log", summary: "review completed" }],
    }),
    now: () => "2026-05-21T00:00:00.000Z",
  });

  const result = await adapter.run(runnerInput(), { events: { emit: (e) => events.push(e) } });

  expect(result).toMatchObject({
    status: "completed",
    runId: "claude-run-1",
    finalMessage: expect.stringContaining("\"decision\""),
  });
  expect(events.map((e) => e.type)).toEqual(["runner_started", "runner_message", "runner_completed"]);
});
```

Test timeout and cancel:

```ts
it("kills the driver on timeout and returns RunnerResultTimeout", async () => {
  const killed: string[] = [];
  const adapter = createClaudeCodeAdapter({
    descriptor: claudeDescriptor(),
    driver: hangingDriver({ onKill: (reason) => killed.push(reason) }),
    now: () => "2026-05-21T00:00:00.000Z",
  });

  await expect(adapter.run({ ...runnerInput(), timeoutSeconds: 1 })).resolves.toMatchObject({
    status: "timeout",
    error: { code: "runner_timeout" },
  });
  expect(killed).toEqual(["timeout"]);
});
```

Test redaction:

```ts
it("redacts secret-looking stdout, stderr and artifact summaries", async () => {
  const adapter = createClaudeCodeAdapter({
    descriptor: claudeDescriptor(),
    driver: fakeDriver({
      status: "failed",
      runnerRunId: "claude-run-2",
      errorMessage: "token=sk-test-abcdef",
      artifacts: [{ kind: "log", summary: "glpat-secret123456" }],
    }),
  });

  const result = await adapter.run(runnerInput());
  expect(JSON.stringify(result)).not.toContain("sk-test-abcdef");
  expect(JSON.stringify(result)).not.toContain("glpat-secret123456");
  expect(result.redactedFields).toEqual(expect.arrayContaining(["error.message", "artifacts[0].summary"]));
});
```

- [ ] **Step 4.2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/claude-code.test.ts
```

Expected: FAIL because files do not exist.

- [x] **Step 4.3: Implement driver interface**

`claude-code-driver.ts`:

```ts
export type ClaudeCodeDriverStatus = "completed" | "failed" | "cancelled";

export interface ClaudeCodeDriverResult {
  status: ClaudeCodeDriverStatus;
  runnerRunId: string;
  finalMessage?: string;
  errorMessage?: string;
  artifacts: RunnerArtifact[];
}

export interface ClaudeCodeDriverProcess {
  result: Promise<ClaudeCodeDriverResult>;
  kill(reason: "cancelled" | "timeout"): Promise<void>;
}

export interface ClaudeCodeDriver {
  start(input: RunnerRunInput, options: ClaudeCodeRunnerOptions): ClaudeCodeDriverProcess;
}
```

Default driver uses `execa` without shell:

```ts
const command = options.command ?? "claude";
const child = execa(command, [], { cwd: input.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", shell: false });
child.stdin?.end(input.prompt);
```

Adapter owns CLI flags after local verification; workflow never supplies arbitrary args.

- [x] **Step 4.4: Implement adapter**

`claude-code.ts` exports:

```ts
export function createClaudeCodeAdapter(options: {
  descriptor: RunnerDescriptor & { kind: "claude_code" };
  driver?: ClaudeCodeDriver;
  now?: () => string;
}): RunnerAdapter
```

Rules:

- Emit `runner_started` before starting driver.
- Emit bounded `runner_message` for sanitized stdout/final summary.
- Emit exactly one terminal event: `runner_completed`, `runner_failed`, or `runner_cancelled`.
- On timeout, call `process.kill("timeout")` and return `RunnerResultTimeout`.
- On thrown driver error, return `RunnerResultFailed` with `error.code = "runner_unavailable"`.
- Never write pipeline store, GitLab note, or `AgentReport`.

- [x] **Step 4.5: Run adapter tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/claude-code.test.ts
```

Expected: PASS.

- [x] **Step 4.6: Commit**

```bash
git add apps/orchestrator/src/runners/claude-code-driver.ts apps/orchestrator/src/runners/claude-code.ts apps/orchestrator/src/runners/__tests__/claude-code.test.ts
git commit -m "feat(v4.8): add claude code runner adapter"
```

## Task 5: Agent Factories Preserve Actual Runner Kind

**Files:**

- Modify: `apps/orchestrator/src/agents/coder.ts`
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Modify: `apps/orchestrator/src/agents/test-evidence.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/coder.test.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/reviewer.test.ts`
- Modify: `apps/orchestrator/src/agents/__tests__/test-evidence.test.ts`

- [x] **Step 5.1: Write failing reviewer test**

Add:

```ts
it("V4.8: preserves claude_code runner kind on reviewer report", async () => {
  const adapter: RunnerAdapter = {
    descriptor: {
      runnerId: "claude_reviewer",
      kind: "claude_code",
      capabilities: ["roles.reviewer", "filesystem.readonly"],
    },
    run: vi.fn().mockResolvedValue({
      status: "completed",
      runId: "claude-run-1",
      finalMessage: JSON.stringify({
        summary: "LGTM",
        decision: "approve_with_comments",
        confidence: 0.8,
        risks: [],
        evidence_request: [],
        findings: [],
        inline_comments: [],
      }),
      artifacts: [],
      redactedFields: [],
    } satisfies RunnerResult),
  };

  const agent = createReviewerAgent({ runnerRegistry: registryWith(adapter) });
  const result = await agent.run(inputWithRunner("claude_reviewer"));

  expect(result.kind).toBe("report");
  if (result.kind === "report") {
    expect(result.report.runnerId).toBe("claude_reviewer");
    expect(result.report.runnerKind).toBe("claude_code");
    expect(result.report.runnerRunId).toBe("claude-run-1");
  }
});
```

Add analogous focused tests for coder and test-evidence, using completed `RunnerResult`.

- [x] **Step 5.2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/agents/__tests__/coder.test.ts src/agents/__tests__/reviewer.test.ts src/agents/__tests__/test-evidence.test.ts
```

Expected: FAIL because factories hard-code `codex_app_server`.

- [x] **Step 5.3: Capture adapter kind**

In each factory:

```ts
let runnerKind: RunnerKind = "codex_app_server";
try {
  const adapter = deps.runnerRegistry.getForRole({ role: "reviewer", runnerId });
  runnerKind = adapter.descriptor.kind;
  result = await adapter.run(...);
} catch (cause) {
  // failed report uses runnerKind from descriptor only if adapter was found
}
```

Use `runnerKind` for every `AgentReport.runnerKind`.

For `test-evidence.ts`, change `buildReport()` input:

```ts
runnerKind: RunnerKind;
```

and set:

```ts
runnerKind: input.runnerKind,
```

- [x] **Step 5.4: Run agent tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/agents/__tests__/coder.test.ts src/agents/__tests__/reviewer.test.ts src/agents/__tests__/test-evidence.test.ts
```

Expected: PASS.

- [x] **Step 5.5: Commit**

```bash
git add apps/orchestrator/src/agents/coder.ts apps/orchestrator/src/agents/reviewer.ts apps/orchestrator/src/agents/test-evidence.ts apps/orchestrator/src/agents/__tests__/coder.test.ts apps/orchestrator/src/agents/__tests__/reviewer.test.ts apps/orchestrator/src/agents/__tests__/test-evidence.test.ts
git commit -m "fix(v4.8): preserve actual runner kind in agent reports"
```

## Task 6: Daemon And Team Daemon Adapter Registration

**Files:**

- Modify: `apps/orchestrator/src/daemon.ts`
- Modify: `apps/orchestrator/src/team/daemon.ts`
- Modify: `apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts`
- Modify: `apps/orchestrator/src/team/__tests__/daemon-pipeline-wiring.test.ts` or the existing team daemon wiring test file.

- [ ] **Step 6.1: Write failing wiring tests**

Single daemon:

```ts
it("V4.8: registers claude_code adapter when workflow declares it", async () => {
  const handle = await startDaemonWithWorkflow(`
runners:
  codex_app_server:
    kind: codex_app_server
    capabilities: [roles.coder, roles.test_evidence, filesystem.worktree_write, artifacts]
  claude_reviewer:
    kind: claude_code
    capabilities: [roles.reviewer, events.streaming, cancel, artifacts, filesystem.readonly]
roles:
  reviewer:
    runner: claude_reviewer
`);

  expect(handle.pipelineService?.runnerRegistry.listRunners().map((r) => r.kind)).toContain("claude_code");
});
```

Team daemon should assert the same through the project-scoped pipeline service.

- [ ] **Step 6.2: Run tests and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/daemon-pipeline-wiring.test.ts src/team/__tests__/daemon-pipeline-wiring.test.ts
```

Expected: FAIL because no `claude_code` adapter registration exists.

- [x] **Step 6.3: Add adapter factory helper**

In daemon modules add a small local helper or shared helper:

```ts
function createAdaptersForWorkflow(cfg: WorkflowConfig, deps: AdapterDeps): RunnerAdapter[] {
  return Object.values(cfg.runners).map((descriptor) => {
    switch (descriptor.kind) {
      case "codex_app_server":
        return createCodexAppServerAdapter({ descriptor, codex: cfg.codex, ...deps.codex });
      case "claude_code":
        return createClaudeCodeAdapter({ descriptor });
    }
  });
}
```

Do not register an adapter for a descriptor not present in workflow.

- [x] **Step 6.4: Run daemon wiring tests**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/daemon-pipeline-wiring.test.ts src/team/__tests__/daemon-pipeline-wiring.test.ts
```

Expected: PASS.

- [x] **Step 6.5: Commit**

```bash
git add apps/orchestrator/src/daemon.ts apps/orchestrator/src/team/daemon.ts apps/orchestrator/src/__tests__/daemon-pipeline-wiring.test.ts apps/orchestrator/src/team/__tests__/daemon-pipeline-wiring.test.ts
git commit -m "feat(v4.8): wire claude code runner into daemons"
```

## Task 7: Dashboard Runner Trace

**Files:**

- Modify: `apps/dashboard/components/work-items/agent-report-tabs.tsx`
- Modify: `apps/dashboard/components/work-items/agent-report-tabs.test.tsx`
- Modify: `apps/dashboard/i18n/messages/zh.json`
- Modify: `apps/dashboard/i18n/messages/en.json`

- [x] **Step 7.1: Write failing dashboard test**

Add:

```tsx
it("V4.8: renders claude_code runner kind display name", () => {
  render(<AgentReportTabs reports={[reviewerReport({ runnerId: "claude_reviewer", runnerKind: "claude_code" })]} />);

  const trace = screen.getByTestId("agent-runner-trace-reviewer");
  expect(within(trace).getByText(/Claude Code/)).toBeInTheDocument();
  expect(within(trace).getByText("claude_reviewer")).toBeInTheDocument();
});
```

- [x] **Step 7.2: Run test and confirm failure**

Run:

```bash
pnpm --filter @issuepilot/dashboard vitest run components/work-items/agent-report-tabs.test.tsx
```

Expected: FAIL because switch does not handle `claude_code` and i18n key is missing.

- [x] **Step 7.3: Add exhaustive switch case and i18n**

`agent-report-tabs.tsx`:

```ts
case "claude_code":
  return t("kinds.claude_code");
```

`zh.json`:

```json
"claude_code": "Claude Code"
```

`en.json`:

```json
"claude_code": "Claude Code"
```

- [x] **Step 7.4: Run dashboard test**

Run:

```bash
pnpm --filter @issuepilot/dashboard vitest run components/work-items/agent-report-tabs.test.tsx
```

Expected: PASS.

- [x] **Step 7.5: Commit**

```bash
git add apps/dashboard/components/work-items/agent-report-tabs.tsx apps/dashboard/components/work-items/agent-report-tabs.test.tsx apps/dashboard/i18n/messages/zh.json apps/dashboard/i18n/messages/en.json
git commit -m "feat(v4.8): show claude code runner trace"
```

## Task 8: Mixed-Runner Pipeline Fixture

**Files:**

- Create: `apps/orchestrator/src/__tests__/v4-8-mixed-runner-pipeline.test.ts`
- Modify existing test helpers if they currently assume one `codex_app_server` runner.

- [x] **Step 8.1: Write mixed-runner pipeline test**

Create a hermetic test with fake adapters:

```ts
it("V4.8: runs codex coder, claude reviewer, codex test evidence", async () => {
  const codexAdapter = fakeAdapter("codex_app_server", "codex_app_server", ["roles.coder", "roles.test_evidence"]);
  const claudeAdapter = fakeAdapter("claude_reviewer", "claude_code", ["roles.reviewer"]);
  const registry = createRunnerRegistry({
    descriptors: {
      codex_app_server: codexAdapter.descriptor,
      claude_reviewer: claudeAdapter.descriptor,
    },
    adapters: [codexAdapter, claudeAdapter],
  });

  const pipeline = await runPipelineFixture({
    registry,
    roles: {
      coder: { runnerId: "codex_app_server" },
      reviewer: { runnerId: "claude_reviewer" },
      test_evidence: { runnerId: "codex_app_server" },
    },
  });

  expect(pipeline.agentReports.map((r) => [r.role, r.runnerKind])).toEqual([
    ["coder", "codex_app_server"],
    ["reviewer", "claude_code"],
    ["test_evidence", "codex_app_server"],
  ]);
});
```

- [ ] **Step 8.2: Run test and confirm failure if helpers are too Codex-specific**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-mixed-runner-pipeline.test.ts
```

Expected: initially fail until helper assumptions and Task 5 wiring are complete.

- [x] **Step 8.3: Implement helper changes only where required**

Keep changes local to test helpers or pipeline setup. Do not add runner-specific branching to `PipelineCoordinator`.

- [x] **Step 8.4: Run pipeline test**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-mixed-runner-pipeline.test.ts
```

Expected: PASS.

- [x] **Step 8.5: Commit**

```bash
git add apps/orchestrator/src/__tests__/v4-8-mixed-runner-pipeline.test.ts
git commit -m "test(v4.8): cover mixed runner pipeline"
```

## Task 9: Optional Real Claude Code Smoke

**Files:**

- Create: `apps/orchestrator/src/__tests__/v4-8-claude-code-dogfood.test.ts`
- Modify: `package.json` or package scripts only if an existing script pattern supports opt-in smoke tests.

- [x] **Step 9.1: Add opt-in smoke test**

Create a test that skips unless `ISSUEPILOT_CLAUDE_CODE_E2E=1`:

```ts
const runIfClaudeSmoke = process.env["ISSUEPILOT_CLAUDE_CODE_E2E"] === "1" ? it : it.skip;

runIfClaudeSmoke("V4.8: real claude_code reviewer smoke", async () => {
  const adapter = createClaudeCodeAdapter({
    descriptor: {
      runnerId: "claude_reviewer",
      kind: "claude_code",
      capabilities: ["roles.reviewer", "events.streaming", "cancel", "artifacts", "filesystem.readonly"],
      options: { command: "claude", model: "sonnet", maxTurns: 1, turnTimeoutMs: 120000 },
    },
  });

  const result = await adapter.run({
    ...runnerInputForTempReadonlyWorktree(),
    role: "reviewer",
    prompt: "Return reviewer JSON with approve_with_comments and no findings.",
  });

  expect(result.status).toBe("completed");
  expect(result.finalMessage ?? "").toContain("approve_with_comments");
});
```

- [x] **Step 9.2: Run default test path**

Run:

```bash
pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts
```

Expected: PASS with the test skipped.

- [ ] **Step 9.3: Run opt-in local smoke on a machine with Claude Code installed and logged in**

Run:

```bash
ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts
```

Expected if local CLI is ready: PASS and the output includes one completed `claude_code` run.

Expected if local CLI is missing or not logged in: FAIL with `runner_unavailable`; record the exact reason in acceptance and keep V4.8 experimental.

- [x] **Step 9.4: Commit**

```bash
git add apps/orchestrator/src/__tests__/v4-8-claude-code-dogfood.test.ts package.json
git commit -m "test(v4.8): add opt-in claude code dogfood smoke"
```

## Task 10: Docs, Acceptance, And Roadmap Sync

**Files:**

- Create: `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md`
- Modify: `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`
- Modify: `docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.en.md`
- Modify: `CHANGELOG.md`

- [x] **Step 10.1: Write acceptance record**

Create acceptance doc:

````md
# IssuePilot V4.8 第二 Runner 自用验证验收记录

日期：2026-05-21
状态：待执行

## 默认 gate

- [ ] `pnpm --filter @issuepilot/shared-contracts vitest run src/__tests__/runner.test.ts src/__tests__/agent-report.test.ts`
- [ ] `pnpm --filter @issuepilot/workflow vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts`
- [ ] `pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/claude-code.test.ts src/__tests__/v4-8-mixed-runner-pipeline.test.ts`
- [ ] `pnpm --filter @issuepilot/dashboard vitest run components/work-items/agent-report-tabs.test.tsx`
- [ ] `SKIP_E2E=1 bash scripts/ci-equivalent-check.sh`

## 真实 Claude Code 自用验证

- [ ] `ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts`

若跳过，记录原因：

```text
原因：
```
````

- [x] **Step 10.2: Sync spec links and statuses**

Update V4.8 spec implementation plan section to link this plan.

Update V4 total spec V4.8 entry:

```md
实施计划：
`docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood.md`。
```

- [x] **Step 10.3: Sync README and CHANGELOG**

README Chinese entries should say `V4.8 实施计划已写，待实施` instead of `设计中`.

README English entry should say `V4.8 plan written, pending implementation`.

CHANGELOG top should add a V4.8 plan entry with links to design spec and implementation plan.

- [x] **Step 10.4: Run markdown whitespace check**

Run:

```bash
git diff --check
```

Expected: PASS.

- [x] **Step 10.5: Commit**

```bash
git add docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md docs/superpowers/specs/2026-05-21-issuepilot-v4-8-second-runner-dogfood-design.md README.md README.zh-CN.md README.en.md CHANGELOG.md
git commit -m "docs(v4.8): add second runner dogfood plan"
```

## Task 11: Final Verification

**Files:**

- All files touched in Tasks 1-10.

- [x] **Step 11.1: Run focused test matrix**

Run:

```bash
pnpm --filter @issuepilot/shared-contracts vitest run src/__tests__/runner.test.ts src/__tests__/agent-report.test.ts
pnpm --filter @issuepilot/workflow vitest run src/__tests__/parse.test.ts src/__tests__/resolve.test.ts
pnpm --filter @issuepilot/orchestrator vitest run src/runners/__tests__/codex-app-server.test.ts src/runners/__tests__/claude-code.test.ts src/agents/__tests__/coder.test.ts src/agents/__tests__/reviewer.test.ts src/agents/__tests__/test-evidence.test.ts src/__tests__/v4-8-mixed-runner-pipeline.test.ts
pnpm --filter @issuepilot/dashboard vitest run components/work-items/agent-report-tabs.test.tsx
```

Expected: PASS.

- [x] **Step 11.2: Run repo gate**

Run:

```bash
SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

Expected: PASS.

- [ ] **Step 11.3: Optional real CLI smoke**

Run only on a machine with Claude Code installed and logged in:

```bash
ISSUEPILOT_CLAUDE_CODE_E2E=1 pnpm --filter @issuepilot/orchestrator vitest run src/__tests__/v4-8-claude-code-dogfood.test.ts
```

Expected: PASS. If skipped or failed because local CLI is unavailable, record the exact reason in the acceptance doc and keep V4.8 marked experimental / pending dog-food.

- [x] **Step 11.4: Update acceptance checkboxes**

Modify `docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md` with exact command results and any skip reason.

- [x] **Step 11.5: Commit verification record**

```bash
git add docs/superpowers/plans/2026-05-21-issuepilot-v4-8-second-runner-dogfood-acceptance.md
git commit -m "docs(v4.8): record second runner dogfood acceptance"
```

## Self-Review Checklist

- Spec coverage:
  - §2 goals map to Tasks 1-8.
  - §6 contract changes map to Tasks 1-3.
  - §7 workflow config maps to Task 2.
  - §8 adapter architecture maps to Task 4 and Task 6.
  - §9 reviewer-first strategy maps to Task 5 and Task 8.
  - §10 error handling maps to Task 4 and existing failure mapping preservation.
  - §11 security maps to Task 2 forbidden options and Task 4 redaction/cwd constraints.
  - §12 dashboard/reports maps to Task 7.
  - §13 testing strategy maps to Tasks 1-9 and Task 11.
  - §14 acceptance maps to Task 10 and Task 11.
  - §15 rollback maps to default Codex runner preservation in Tasks 2 and 6.
- Placeholder scan: no unresolved placeholder markers, no unowned "add tests", and every code-changing task has concrete files, commands and expected results.
- Type consistency: `claude_code`, `RunnerKind`, `RunnerDescriptor.options`, `RunnerEventType`, `RunnerResult`, `AgentReport.runnerKind`, `roles.<role>.runner`, and `RunnerAdapter` names match the current V4.7 code.
