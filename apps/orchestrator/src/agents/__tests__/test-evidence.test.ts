import type {
  TaskNode,
  TestEvidenceItem,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import type { TestEvidenceRoleProfile } from "../../pipelines/role-profile.js";
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
  prompt: "evidence",
  promptTemplateHash: "abc1234567",
  sandbox: "read_only_source_write_evidence",
  toolAllow: [],
  timeoutSeconds: 1800,
  tokenScopeRequirements: undefined,
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

const mkAgent = () => {
  let i = 0;
  return createTestEvidenceAgent({
    now: () => `2026-05-19T11:00:${String(i++).padStart(2, "0")}.000Z`,
    newId: () => "ar_te_1",
  });
};

describe("TestEvidenceAgent.run", () => {
  it("全部 collector collected → status=complete + baseline 保留", async () => {
    const agent = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
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
    const agent = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
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
    const agent = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
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
    const agent = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      evidenceDir: "/tmp/evidence",
      collectors: [failingCollector("ci", new Error("disk full"))],
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("evidence_unavailable");
  });

  it("collector 返回 cancel → AgentRunResult.kind=cancelled", async () => {
    const agent = mkAgent();
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
      evidenceDir: "/tmp/evidence",
      collectors: [cancelCollector],
    });
    expect(res.kind).toBe("cancelled");
    if (res.kind !== "cancelled") throw new Error("expected cancelled");
    expect(res.cancelledAt).toBe("2026-05-19T11:05:00.000Z");
  });

  it("所有 item 都 failed/skipped 且无 collected → status=failed evidence_unavailable", async () => {
    const agent = mkAgent();
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
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
