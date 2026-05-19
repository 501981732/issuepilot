import type {
  ReviewerFinding,
  TaskNode,
  WorkItem,
} from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import type { ReviewerRoleProfile } from "../../pipelines/role-profile.js";
import {
  ReviewerParseError,
  createReviewerAgent,
  filterFindingsForInline,
  formatReviewerConfidence,
  parseReviewerMessage,
  type ReviewerLifecycleOutcome,
  type ReviewerLifecycleRunner,
} from "../reviewer.js";

const TASK: TaskNode = {
  taskId: "t_1",
  title: "T",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "running_reviewer",
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
const PROFILE: ReviewerRoleProfile = {
  role: "reviewer",
  roleProfileId: "reviewer@abc1234",
  prompt: "review",
  promptTemplateHash: "abc1234567",
  sandbox: "read_only_worktree",
  toolAllow: [],
  timeoutSeconds: 1800,
  tokenScopeRequirements: ["api"],
  publishToMr: true,
  severityThreshold: "medium",
  maxInlineComments: 25,
};

const wrap = (payload: unknown): string =>
  "Quick summary outside fence\n\n```json\n" +
  JSON.stringify(payload) +
  "\n```\n";

describe("parseReviewerMessage", () => {
  it("解析 happy path", () => {
    const out = parseReviewerMessage(
      wrap({
        summary: "ok",
        decision: "approve_with_comments",
        confidence: 0.91,
        risks: [],
        evidenceRequest: [],
        findings: [],
        inlineComments: [],
      }),
    );
    expect(out.summary).toBe("ok");
    expect(out.decision).toBe("approve_with_comments");
    expect(out.confidence).toBe(0.91);
  });

  it("缺 ```json fence → ReviewerParseError (schema mismatch)", () => {
    expect(() => parseReviewerMessage("hello world")).toThrowError(
      ReviewerParseError,
    );
  });

  it("decision 非法 → schema mismatch", () => {
    expect(() =>
      parseReviewerMessage(
        wrap({ summary: "x", decision: "bogus", confidence: 0.5 }),
      ),
    ).toThrowError(ReviewerParseError);
  });

  it("confidence 超出 [0,1] → schema mismatch", () => {
    expect(() =>
      parseReviewerMessage(
        wrap({
          summary: "x",
          decision: "approve_with_comments",
          confidence: 1.5,
        }),
      ),
    ).toThrowError(ReviewerParseError);
  });

  it("summary > 4000 → reviewer_summary_too_long", () => {
    try {
      parseReviewerMessage(
        wrap({
          summary: "a".repeat(4001),
          decision: "approve_with_comments",
          confidence: 0.5,
        }),
      );
      expect.fail("should throw");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ReviewerParseError);
      expect((cause as ReviewerParseError).code).toBe(
        "reviewer_summary_too_long",
      );
    }
  });
});

describe("formatReviewerConfidence", () => {
  it.each([
    [0, "0.00"],
    [0.9, "0.90"],
    [0.911, "0.91"],
    [1, "1.00"],
    [Number.NaN, "0.00"],
    [-1, "0.00"],
    [1.5, "1.00"],
  ])("%s → %s", (input, expected) => {
    expect(formatReviewerConfidence(input)).toBe(expected);
  });
});

describe("filterFindingsForInline", () => {
  const findings: ReviewerFinding[] = [
    {
      severity: "low",
      category: "style",
      message: "tiny",
      locationHint: { filePath: "a.ts", lineRange: { start: 1, end: 1 } },
    },
    {
      severity: "medium",
      category: "logic",
      message: "med1",
      locationHint: { filePath: "a.ts", lineRange: { start: 2, end: 2 } },
    },
    {
      severity: "medium",
      category: "logic",
      message: "med2",
      locationHint: { filePath: "a.ts", lineRange: { start: 3, end: 3 } },
    },
    {
      severity: "high",
      category: "security",
      message: "high1",
      locationHint: { filePath: "a.ts", lineRange: { start: 4, end: 4 } },
    },
    {
      severity: "high",
      category: "security",
      message: "high2",
      locationHint: { filePath: "a.ts", lineRange: { start: 5, end: 5 } },
    },
    {
      severity: "critical",
      category: "security",
      message: "crit",
      locationHint: { filePath: "a.ts", lineRange: { start: 6, end: 6 } },
    },
  ];

  it("severityThreshold=medium, max=25 → 过滤掉 low，剩 5 条", () => {
    const r = filterFindingsForInline({
      findings,
      severityThreshold: "medium",
      maxInlineComments: 25,
    });
    expect(r.inlineComments.length).toBe(5);
    expect(r.hiddenCount).toBe(0);
    expect(r.inlineComments.every((c) => c.severity !== "low" as never)).toBe(true);
  });

  it("severityThreshold=medium, max=3 → cap 到 3，hiddenCount=2", () => {
    const r = filterFindingsForInline({
      findings,
      severityThreshold: "medium",
      maxInlineComments: 3,
    });
    expect(r.inlineComments.length).toBe(3);
    expect(r.hiddenCount).toBe(2);
  });

  it("severityThreshold=high → 只留 high+critical 共 3 条", () => {
    const r = filterFindingsForInline({
      findings,
      severityThreshold: "high",
      maxInlineComments: 25,
    });
    expect(r.inlineComments.length).toBe(3);
    expect(new Set(r.inlineComments.map((c) => c.severity))).toEqual(
      new Set(["high", "critical"]),
    );
  });

  it("severityThreshold=critical → 1 条", () => {
    const r = filterFindingsForInline({
      findings,
      severityThreshold: "critical",
      maxInlineComments: 25,
    });
    expect(r.inlineComments.length).toBe(1);
    expect(r.inlineComments[0]?.severity).toBe("critical");
  });

  it("LLM 直接给了 inlineComments → 优先用，仍要 filter + cap", () => {
    const r = filterFindingsForInline({
      findings: [],
      severityThreshold: "high",
      maxInlineComments: 2,
      llmInlineComments: [
        {
          filePath: "a.ts",
          lineRange: { start: 1, end: 1 },
          severity: "medium",
          category: "c",
          message: "m",
        },
        {
          filePath: "a.ts",
          lineRange: { start: 2, end: 2 },
          severity: "high",
          category: "c",
          message: "m",
        },
        {
          filePath: "a.ts",
          lineRange: { start: 3, end: 3 },
          severity: "critical",
          category: "c",
          message: "m",
        },
        {
          filePath: "a.ts",
          lineRange: { start: 4, end: 4 },
          severity: "high",
          category: "c",
          message: "m",
        },
      ],
    });
    expect(r.inlineComments.length).toBe(2);
    expect(r.hiddenCount).toBe(1);
    expect(new Set(r.inlineComments.map((c) => c.severity))).toEqual(
      new Set(["high", "critical"]),
    );
  });
});

const mkAgent = (
  outcome: ReviewerLifecycleOutcome | Error,
) => {
  const lifecycle: ReviewerLifecycleRunner = {
    run: vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  let i = 0;
  return createReviewerAgent({
    lifecycle,
    now: () => `2026-05-19T11:00:${String(i++).padStart(2, "0")}.000Z`,
    newId: () => "ar_rev_1",
  });
};

describe("ReviewerAgent.run", () => {
  it("happy approve_with_comments → status=complete, mrPublication.pending（publishToMr=true）", async () => {
    const agent = mkAgent({
      kind: "message",
      result: {
        runId: "run_x",
        rawMessage: wrap({
          summary: "looks good",
          decision: "approve_with_comments",
          confidence: 0.91,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
        }),
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("complete");
    expect(res.report.reviewer.decision).toBe("approve_with_comments");
    expect(res.report.reviewer.confidence).toBe(0.91);
    expect(res.report.reviewer.mrPublication.status).toBe("pending");
  });

  it("publishToMr=false → mrPublication.skipped_by_config", async () => {
    const agent = mkAgent({
      kind: "message",
      result: {
        runId: "run_x",
        rawMessage: wrap({
          summary: "ok",
          decision: "approve_with_comments",
          confidence: 0.8,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
        }),
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: { ...PROFILE, publishToMr: false },
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.reviewer.mrPublication.status).toBe("skipped_by_config");
  });

  it("schema mismatch → status=failed lastError.code=parse_failed", async () => {
    const agent = mkAgent({
      kind: "message",
      result: { runId: "run_x", rawMessage: "no fence" },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("failed");
    expect(res.report.lastError?.code).toBe("parse_failed");
    expect(res.report.lastError?.message).toBe(
      "prompt_output_schema_mismatch",
    );
  });

  it("decision=request_changes → status 仍 complete", async () => {
    const agent = mkAgent({
      kind: "message",
      result: {
        runId: "run_x",
        rawMessage: wrap({
          summary: "needs rework",
          decision: "request_changes",
          confidence: 0.6,
          risks: [],
          evidenceRequest: [],
          findings: [],
          inlineComments: [],
        }),
      },
    });
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.status).toBe("complete");
    expect(res.report.reviewer.decision).toBe("request_changes");
  });

  it("lifecycle 抛错 → status=failed lastError.code=reviewer_unavailable", async () => {
    const agent = mkAgent(new Error("rpc 500"));
    const res = await agent.run({
      workItem: WORKITEM,
      task: TASK,
      pipelineRun: { pipelineRunId: "pr_1" },
      profile: PROFILE,
      cwd: "/tmp/wt",
    });
    if (res.kind !== "report") throw new Error("not report");
    expect(res.report.lastError?.code).toBe("reviewer_unavailable");
  });
});
