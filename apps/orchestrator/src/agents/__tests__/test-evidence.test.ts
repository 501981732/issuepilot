import type {
  RunnerDescriptor,
  RunnerResult,
  TaskNode,
  TestEvidenceItem,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { TestEvidenceRoleProfile } from "../../pipelines/role-profile.js";
import { createRunnerRegistry } from "../../runners/registry.js";
import type { RunnerAdapter } from "../../runners/types.js";
import { SandboxViolationError } from "../coder.js";
import {
  createTestEvidenceAgent,
  type EvidenceCollector,
} from "../test-evidence.js";

const TASK: TaskNode = {
  taskId: "t_1",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "running_test_evidence",
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
const PROFILE: TestEvidenceRoleProfile = {
  role: "test_evidence",
  roleProfileId: "test_evidence@abc1234",
  runnerId: "codex_app_server",
  prompt: "evidence",
  promptTemplateHash: "abc1234567",
  sandbox: "read_only_source_write_evidence",
  toolAllow: [],
  timeoutSeconds: 1800,
  tokenScopeRequirements: undefined,
};
const EVIDENCE_DESCRIPTOR: RunnerDescriptor = {
  runnerId: "codex_app_server",
  kind: "codex_app_server",
  capabilities: ["roles.test_evidence", "filesystem.readonly"],
};
const COMPLETED_RUN: RunnerResult = {
  status: "completed",
  runId: "turn-evidence",
  finalMessage: "collect requested evidence",
};

const itemCollector = (name: string, item: TestEvidenceItem): EvidenceCollector => ({
  name,
  async collect() {
    return { kind: "item", item };
  },
});

const baselineCollector: EvidenceCollector = {
  name: "baseline",
  async collect() {
    return {
      kind: "baseline",
      baseline: {
        ciSummary: "ci ok",
        testSummary: "all green",
        collectedAt: "2026-05-19T11:00:00.000Z",
      },
    };
  },
};

const failingCollector = (
  name: string,
  err: Error,
): EvidenceCollector => ({
  name,
  async collect() {
    throw err;
  },
});

interface MkAgentOpts {
  runnerOutcome?: RunnerResult | Error;
  descriptor?: RunnerDescriptor;
}

const mkAgent = (opts: MkAgentOpts = {}) => {
  const outcome = opts.runnerOutcome ?? COMPLETED_RUN;
  const runFn = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const adapter: RunnerAdapter = {
    descriptor: opts.descriptor ?? EVIDENCE_DESCRIPTOR,
    run: runFn,
  };
  const registry = createRunnerRegistry({
    descriptors: {
      [adapter.descriptor.runnerId]: adapter.descriptor,
    },
    adapters: [adapter],
  });
  let i = 0;
  return {
    agent: createTestEvidenceAgent({
      runnerRegistry: registry,
      now: () => `2026-05-19T11:00:${String(i++).padStart(2, "0")}.000Z`,
      newId: () => "ar_te_1",
    }),
    runFn,
  };
};

describe("TestEvidenceAgent.run", () => {
  it("V4.7 starts test_evidence through runner before collectors", async () => {
    const { agent, runFn } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "collected",
          artifactPath: "/tmp/evidence/ci.txt",
        }),
      ],
    });
    expect(runFn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "test_evidence" }),
      undefined,
    );
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("complete");
    expect(res.report.runnerRunId).toBe("turn-evidence");
    expect(res.report.runnerKind).toBe("codex_app_server");
  });

  it("V4.8 preserves non-Codex runner kind on test_evidence report", async () => {
    const { agent } = mkAgent({
      descriptor: {
        runnerId: "claude_evidence",
        kind: "claude_code",
        capabilities: ["roles.test_evidence", "filesystem.readonly"],
      },
      runnerOutcome: {
        status: "completed",
        runId: "claude-evidence-run",
        finalMessage: "ok",
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: { ...PROFILE, runnerId: "claude_evidence" },
      cwd: "/tmp/wt",
      collectors: [],
      evidenceDir: "/tmp/wt/.issuepilot/evidence/t_1",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.runnerId).toBe("claude_evidence");
    expect(res.report.runnerKind).toBe("claude_code");
    expect(res.report.runnerRunId).toBe("claude-evidence-run");
  });

  it("V4.7 runner timeout → failed AgentReport, evidence_unavailable mapped, no collectors run", async () => {
    const failingCollectorCalled = vi.fn();
    const collector: EvidenceCollector = {
      name: "ci",
      async collect() {
        failingCollectorCalled();
        return {
          kind: "item",
          item: {
            kind: "ci_log",
            target: "x",
            source: "pnpm",
            status: "collected",
          },
        };
      },
    };
    const { agent } = mkAgent({
      runnerOutcome: {
        status: "timeout",
        runId: "turn-timeout",
        error: { code: "runner_timeout", message: "stuck" },
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [collector],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("runner_unavailable");
    expect(res.report.runnerRunId).toBe("turn-timeout");
    expect(failingCollectorCalled).not.toHaveBeenCalled();
  });

  it("V4.7 artifact_collection_failed → evidence_unavailable", async () => {
    const { agent } = mkAgent({
      runnerOutcome: {
        status: "failed",
        runId: "turn-acf",
        error: {
          code: "artifact_collection_failed",
          message: "artifact write failed",
        },
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("evidence_unavailable");
  });

  it("全部 collector collected → status=complete + baseline 保留", async () => {
    const { agent } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        baselineCollector,
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "collected",
          artifactPath: "/tmp/evidence/ci.txt",
        }),
        itemCollector("walkthrough", {
          kind: "screenshot",
          target: "Login",
          source: "playwright",
          status: "collected",
          artifactPath: "/tmp/evidence/login.png",
        }),
      ],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("complete");
    expect(res.report.testEvidence.baselineEvidence?.testSummary).toBe("all green");
    expect(res.report.testEvidence.evidenceItems.length).toBe(2);
    expect(res.report.evidenceLinks).toEqual([
      "/tmp/evidence/ci.txt",
      "/tmp/evidence/login.png",
    ]);
  });

  it("walkthrough failed + CI passed → status=incomplete, lastError.code=evidence_partial", async () => {
    const { agent } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "collected",
          artifactPath: "/tmp/evidence/ci.txt",
        }),
        itemCollector("walkthrough", {
          kind: "screenshot",
          target: "Login",
          source: "playwright",
          status: "failed",
          lastError: { code: "evidence_partial", message: "screenshot failed" },
        }),
      ],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("incomplete");
    expect(res.report.lastError?.code).toBe("evidence_partial");
  });

  it("collector 抛 SandboxViolationError → status=failed sandbox_violation 并保留已 collected items", async () => {
    const { agent } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "collected",
          artifactPath: "/tmp/evidence/ci.txt",
        }),
        failingCollector("walkthrough", new SandboxViolationError("write src")),
      ],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("sandbox_violation");
    expect(res.report.testEvidence.evidenceItems.length).toBe(1);
  });

  it("collector 抛任意 Error → status=failed evidence_unavailable", async () => {
    const { agent } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [failingCollector("ci", new Error("disk full"))],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("evidence_unavailable");
  });

  it("collector 返回 cancel → AgentRunResult.kind=cancelled", async () => {
    const { agent } = mkAgent();
    const cancelCollector: EvidenceCollector = {
      name: "cancel",
      async collect() {
        return { kind: "cancel", cancelledAt: "2026-05-19T11:05:00.000Z" };
      },
    };
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [cancelCollector],
    });
    expect(res.kind).toBe("cancelled");
    if (res.kind !== "cancelled") throw new Error("expected cancelled");
    expect(res.cancelledAt).toBe("2026-05-19T11:05:00.000Z");
  });

  it("collector 返回 noop → agent 跳过该 outcome（V4.6 follow-up Task 4c review）", async () => {
    // 防回归：把 `{ kind: "noop" }` 的 collector 与一条 collected 混在
    // 一起，结果里应该只看到 collected 那一条，noop 不会被记进
    // evidenceItems。把 agent.ts 里 `if (out.kind === "noop") continue;`
    // 删掉后这里的 length 会变 1（noop 落进 else 分支当 baseline）或
    // type 校验直接挂掉，断言必红。
    const { agent } = mkAgent();
    const noopCollector: EvidenceCollector = {
      name: "scanner-noop",
      async collect() {
        return { kind: "noop" };
      },
    };
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        noopCollector,
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "collected",
          artifactPath: "/tmp/evidence/ci.txt",
        }),
      ],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("complete");
    expect(res.report.testEvidence.evidenceItems.length).toBe(1);
    expect(res.report.testEvidence.evidenceItems[0]?.source).toBe("pnpm");
  });

  it("全 noop collector → items.length === 0 + status=complete（首跑没产物的诚实状态）", async () => {
    const { agent } = mkAgent();
    const noopOne: EvidenceCollector = {
      name: "scanner-noop-1",
      async collect() {
        return { kind: "noop" };
      },
    };
    const noopTwo: EvidenceCollector = {
      name: "scanner-noop-2",
      async collect() {
        return { kind: "noop" };
      },
    };
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [noopOne, noopTwo],
    });
    if (res.kind !== "report") throw new Error("not report");
    // items.length===0 走 `complete` 分支（test-evidence.ts:194-205 中
    // allFailed 的前提是 `items.length > 0`）。这是 4c review 要求的
    // 诚实路径：dashboard 看到 testEvidence complete + 空 evidenceItems
    // 而不是 "evidence_unavailable" 的伪 failed。
    expect(res.report.status).toBe("complete");
    expect(res.report.lastError).toBeUndefined();
    expect(res.report.testEvidence.evidenceItems).toEqual([]);
    expect(res.report.evidenceLinks).toEqual([]);
  });

  it("所有 item 都 failed/skipped 且无 collected → status=failed evidence_unavailable", async () => {
    const { agent } = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
      evidenceDir: "/tmp/evidence",
      collectors: [
        itemCollector("ci", {
          kind: "ci_log",
          target: "pnpm test",
          source: "pnpm",
          status: "failed",
          lastError: { code: "evidence_unavailable", message: "ci timeout" },
        }),
        itemCollector("walkthrough", {
          kind: "screenshot",
          target: "Login",
          source: "playwright",
          status: "skipped",
        }),
      ],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("evidence_unavailable");
  });
});
