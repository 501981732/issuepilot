import type { TaskNode, WorkItem } from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { CoderRoleProfile } from "../../pipelines/role-profile.js";
import {
  RunnerUnavailableError,
  SandboxViolationError,
  createCoderAgent,
  type CoderLifecycleOutcome,
  type CoderLifecycleRunner,
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
const PROFILE: CoderRoleProfile = {
  role: "coder",
  roleProfileId: "coder@abc1234",
  prompt: "do",
  promptTemplateHash: "abc1234567",
  sandbox: "read_write_worktree",
  toolAllow: [],
  timeoutSeconds: 3600,
  tokenScopeRequirements: undefined,
};

const mkAgent = (outcome: CoderLifecycleOutcome | (() => CoderLifecycleOutcome | Promise<CoderLifecycleOutcome>) | Error) => {
  const lifecycle: CoderLifecycleRunner = {
    run: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === "function") return outcome();
      return outcome;
    }),
  };
  let i = 0;
  return createCoderAgent({
    lifecycle,
    now: () => `2026-05-19T11:00:${String(i++).padStart(2, "0")}.000Z`,
    newId: () => "ar_coder_1",
  });
};

describe("CoderAgent.run completed", () => {
  it("写出 CoderAgentReport，含 runId / promptTemplateHash / branch / diffSummary / buildStatus", async () => {
    const agent = mkAgent({
      kind: "completed",
      result: {
        runId: "run_abc",
        diffSummary: "+1/-0",
        branch: "issuepilot/wi_1/t_1",
        runReportArtifactId: "rra_xx",
        buildStatus: "passed",
        testStatus: "passed",
        lintStatus: "passed",
        mergeRequest: {
          iid: 7,
          url: "https://gl/-/mr/7",
          state: "opened",
        },
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
    expect(res.report.runId).toBe("run_abc");
    expect(res.report.promptTemplateHash).toBe("abc1234567");
    expect(res.report.role).toBe("coder");
    expect(res.report.coder.diffSummary).toBe("+1/-0");
    expect(res.report.coder.branch).toBe("issuepilot/wi_1/t_1");
    expect(res.report.coder.runReportArtifactId).toBe("rra_xx");
    expect(res.report.coder.buildStatus).toBe("passed");
    expect(res.report.coder.mergeRequest?.iid).toBe(7);
    expect(res.report.evidenceLinks).toEqual([
      "run-report-artifact://rra_xx",
    ]);
  });
});

describe("CoderAgent.run failure paths", () => {
  it("lifecycle 抛 RunnerUnavailableError → status=failed, lastError.code=runner_unavailable", async () => {
    const agent = mkAgent(new RunnerUnavailableError("rpc spawn failed"));
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
    expect(res.report.coder.branch).toBe("");
  });

  it("lifecycle 抛 SandboxViolationError → lastError.code=sandbox_violation", async () => {
    const agent = mkAgent(
      new SandboxViolationError("write outside ~/.issuepilot"),
    );
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.lastError?.code).toBe("sandbox_violation");
  });

  it("lifecycle 抛任意 Error → lastError.code=coding_failed（兜底）", async () => {
    const agent = mkAgent(new Error("boom"));
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not a report");
    expect(res.report.lastError?.code).toBe("coding_failed");
  });

  it("outcome.kind = failed → status=failed 并保留 partial 字段", async () => {
    const agent = mkAgent({
      kind: "failed",
      reason: "coding_failed",
      message: "CI red",
      runId: "run_x",
      partial: { diffSummary: "+50/-10", branch: "issuepilot/x/y", buildStatus: "failed" },
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
    expect(res.report.runId).toBe("run_x");
    expect(res.report.coder.diffSummary).toBe("+50/-10");
    expect(res.report.coder.buildStatus).toBe("failed");
  });
});

describe("CoderAgent.run cancellation", () => {
  it("outcome.cancelled → AgentRunResult.kind=cancelled，cancelledAt 透传", async () => {
    const agent = mkAgent({
      kind: "cancelled",
      cancelledAt: "2026-05-19T11:05:00.000Z",
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
