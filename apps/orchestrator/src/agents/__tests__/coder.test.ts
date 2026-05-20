import type {
  RunnerDescriptor,
  RunnerResult,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { CoderRoleProfile } from "../../pipelines/role-profile.js";
import { createRunnerRegistry } from "../../runners/registry.js";
import type {
  RunnerAdapter,
  RunnerRegistry,
} from "../../runners/types.js";
import {
  RunnerUnavailableError,
  SandboxViolationError,
  createCoderAgent,
} from "../coder.js";

const TASK: TaskNode = {
  taskId: "t_1",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "running_coding",
  runIds: [],
  riskLevel: "low",
};
const WORKITEM: WorkItem = {
  workItemId: "wi_1",
  sourceIssue: { projectId: "g/p", iid: 1, url: "u", title: "t" },
  title: "T",
  goal: "g",
  acceptanceCriteria: ["AC"],
  status: "running",
  taskIds: ["t_1"],
  createdAt: "t0",
  updatedAt: "t0",
};
const CODER_DESCRIPTOR: RunnerDescriptor = {
  runnerId: "codex_app_server",
  kind: "codex_app_server",
  capabilities: ["roles.coder", "filesystem.worktree_write"],
};
const PROFILE: CoderRoleProfile = {
  role: "coder",
  roleProfileId: "coder@abc1234",
  runnerId: "codex_app_server",
  prompt: "do",
  promptTemplateHash: "abc1234567",
  sandbox: "read_write_worktree",
  toolAllow: [],
  timeoutSeconds: 3600,
  tokenScopeRequirements: undefined,
};

interface MakeAgentOptions {
  outcome?: RunnerResult | (() => RunnerResult | Promise<RunnerResult>) | Error;
  descriptor?: RunnerDescriptor;
  registryOverride?: RunnerRegistry;
}

const makeAgent = (opts: MakeAgentOptions = {}) => {
  const runFn = vi.fn(async () => {
    if (opts.outcome instanceof Error) throw opts.outcome;
    if (typeof opts.outcome === "function") return opts.outcome();
    if (opts.outcome) return opts.outcome;
    return {
      status: "failed",
      error: { code: "runner_unavailable", message: "no outcome" },
    } satisfies RunnerResult;
  });
  const descriptor = opts.descriptor ?? CODER_DESCRIPTOR;
  const adapter: RunnerAdapter = { descriptor, run: runFn };
  const registry =
    opts.registryOverride ??
    createRunnerRegistry({
      descriptors: { [descriptor.runnerId]: descriptor },
      adapters: [adapter],
    });
  let i = 0;
  return {
    agent: createCoderAgent({
      runnerRegistry: registry,
      now: () => `2026-05-19T11:00:${String(i++).padStart(2, "0")}.000Z`,
      newId: () => "ar_coder_1",
    }),
    runFn,
  };
};

describe("CoderAgent.run completed", () => {
  it("V4.7 writes runner trace fields on completed coder report", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "completed",
        runId: "turn-1",
        finalMessage: "implemented",
        artifacts: [
          {
            kind: "diff",
            summary: "branch:feature/issue-42\nsrc/a.ts | 2 +-",
          },
          {
            kind: "tool_result",
            summary: "merge_request:7:https://gitlab/mr/7",
          },
        ],
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    expect(res.kind).toBe("report");
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("complete");
    expect(res.report.runnerId).toBe("codex_app_server");
    expect(res.report.runnerKind).toBe("codex_app_server");
    expect(res.report.runnerRunId).toBe("turn-1");
    expect(res.report.runId).toBe("turn-1");
    expect(res.report.promptTemplateHash).toBe("abc1234567");
    // V4.7 review H1:adapter 在 diff artifact 头部嵌入 `branch:<name>\n`,
    // agent 把它拆出来回填 `CoderAgentReport.coder.branch`,不再硬编码空串。
    expect(res.report.coder.branch).toBe("feature/issue-42");
    // V4.7 review H2:diff artifact 的剩余部分就是 git diff --stat 输出,
    // 不再被 Codex `final_message` 散文污染。
    expect(res.report.coder.diffSummary).toBe("src/a.ts | 2 +-");
    expect(res.report.coder.mergeRequest).toEqual({
      iid: 7,
      url: "https://gitlab/mr/7",
      state: "opened",
    });
  });

  it("V4.7 review H2 regression: text artifact (final_message) does not pollute diffSummary", async () => {
    // 当 adapter 拿不到 git 状态(空 worktree / detached HEAD)时,只
    // emit `text` artifact 的 `final_message:` 前缀串。V4.7 之前 agent
    // 会把这串当 diffSummary 兜底,污染 dashboard / RunReport.diff;
    // 修复后 diffSummary 留空,fallback 由 report-artifact 负责。
    const { agent } = makeAgent({
      outcome: {
        status: "completed",
        runId: "turn-no-git",
        finalMessage: "implemented",
        artifacts: [
          {
            kind: "text",
            summary: "final_message:\nimplemented",
          },
        ],
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("complete");
    expect(res.report.coder.branch).toBe("");
    expect(res.report.coder.diffSummary).toBe("");
  });
});

describe("CoderAgent.run failure paths", () => {
  it("V4.7 registry failure → status=failed, lastError.code=runner_unavailable", async () => {
    // build a registry that lacks an adapter for the descriptor:
    const registry = createRunnerRegistry({
      descriptors: { [CODER_DESCRIPTOR.runnerId]: CODER_DESCRIPTOR },
      adapters: [],
    });
    const { agent } = makeAgent({ registryOverride: registry });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("runner_unavailable");
    expect(res.report.runnerRunId).toBeNull();
    expect(res.report.coder.branch).toBe("");
  });

  it("V4.7 adapter throws → falls back to coding_failed", async () => {
    const { agent } = makeAgent({
      outcome: new Error("boom"),
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("coding_failed");
  });

  it("V4.7 RunnerResult failed sandbox_violation → status=failed, sandbox_violation", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "failed",
        runId: "turn-fail",
        error: { code: "sandbox_violation", message: "write outside" },
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("failed");
    expect(res.report.runnerRunId).toBe("turn-fail");
    expect(res.report.runId).toBe("turn-fail");
    expect(res.report.lastError?.code).toBe("sandbox_violation");
  });

  it("V4.7 RunnerResult timeout → status=failed, runner_unavailable", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "timeout",
        runId: "turn-timeout",
        error: { code: "runner_timeout", message: "timed out" },
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("runner_unavailable");
    expect(res.report.runnerRunId).toBe("turn-timeout");
  });
});

describe("CoderAgent.run cancellation", () => {
  it("RunnerResult cancelled → AgentRunResult.kind=cancelled", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "cancelled",
        cancelledAt: "2026-05-19T11:05:00.000Z",
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    expect(res.kind).toBe("cancelled");
    if (res.kind !== "cancelled") throw new Error("expected cancelled");
    expect(res.cancelledAt).toBe("2026-05-19T11:05:00.000Z");
  });
});

describe("CoderAgent V4.7 redaction audit", () => {
  it("propagates runner redactedFields into AgentReport with runner. prefix", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "completed",
        runId: "turn-redacted",
        finalMessage: "[REDACTED]",
        artifacts: [{ kind: "diff", summary: "[REDACTED]" }],
        redactedFields: ["finalMessage", "artifacts[0].summary"],
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.redactedFields).toEqual(
      expect.arrayContaining([
        "runner.finalMessage",
        "runner.artifacts[0].summary",
      ]),
    );
  });

  it("propagates runner error redaction audit into failed coder AgentReport", async () => {
    const { agent } = makeAgent({
      outcome: {
        status: "failed",
        runId: "turn-failed",
        error: { code: "runner_unavailable", message: "[REDACTED]" },
        redactedFields: ["error.message"],
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.status).toBe("failed");
    expect(res.report.redactedFields).toContain("runner.error.message");
  });
});

describe("CoderAgent legacy error classes still re-exported", () => {
  it("preserves RunnerUnavailableError / SandboxViolationError symbols", () => {
    expect(new RunnerUnavailableError("x").name).toBe("RunnerUnavailableError");
    expect(new SandboxViolationError("x").name).toBe("SandboxViolationError");
  });
});
