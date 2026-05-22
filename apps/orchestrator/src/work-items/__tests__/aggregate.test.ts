import { describe, expect, it } from "vitest";

import type {
  ReportEvidence,
  RunReportArtifact,
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
} from "@issuepilot/shared-contracts";

import { aggregateWorkItem } from "../aggregate.js";

const workItem: WorkItem = {
  workItemId: "wi_01",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "Big",
  },
  title: "Big",
  goal: "g",
  acceptanceCriteria: ["AC1"],
  status: "ready",
  taskIds: ["t1", "t2"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

function task(over: Partial<TaskNode> & Pick<TaskNode, "taskId">): TaskNode {
  return {
    taskId: over.taskId,
    title: over.title ?? `Task ${over.taskId}`,
    goal: "g",
    scope: "s",
    dependsOn: over.dependsOn ?? [],
    suggestedValidation: over.suggestedValidation ?? [],
    status: over.status ?? "completed",
    runIds: over.runIds ?? [],
    riskLevel: over.riskLevel ?? "low",
    ...(over.statusReason ? { statusReason: over.statusReason } : {}),
    ...(over.needsReworkReason
      ? { needsReworkReason: over.needsReworkReason }
      : {}),
  };
}

function planWith(tasks: TaskNode[]): TaskPlan {
  return {
    planId: "tp_01",
    workItemId: workItem.workItemId,
    version: 1,
    tasks,
    dependencies: [],
    operatorEdits: [],
    status: "accepted",
    acceptedAt: "2026-05-17T00:00:00.000Z",
  };
}

const plan = planWith([
  task({ taskId: "t1", title: "Add API", status: "completed" }),
  task({ taskId: "t2", title: "Add UI", status: "completed" }),
]);

function link(
  over: Partial<TaskRunLink> & Pick<TaskRunLink, "taskId" | "runId">,
): TaskRunLink {
  return {
    taskId: over.taskId,
    runId: over.runId,
    attempt: over.attempt ?? 1,
    status: over.status ?? "completed",
    branch: over.branch ?? `ai/42-${over.taskId}`,
    startedAt: over.startedAt ?? "2026-05-17T00:00:00.000Z",
    completedAt: over.completedAt ?? "2026-05-17T00:01:00.000Z",
    ...(over.mergeRequest ? { mergeRequest: over.mergeRequest } : {}),
    ...(over.reportId ? { reportId: over.reportId } : {}),
  };
}

function report(over: {
  runId: string;
  status?: RunReportArtifact["run"]["status"];
  mrState?: "opened" | "merged" | "closed";
  validation?: string[];
  risks?: RunReportArtifact["handoff"]["risks"];
  ci?: RunReportArtifact["ci"];
  reviewFeedback?: RunReportArtifact["reviewFeedback"];
  diffSummary?: string;
  checks?: RunReportArtifact["checks"];
  evidence?: ReportEvidence[];
}): RunReportArtifact {
  return {
    version: 1,
    runId: over.runId,
    issue: {
      projectId: "g/p",
      iid: 42,
      title: "T",
      url: "https://gl/-/issues/42",
      labels: [],
    },
    run: {
      status: over.status ?? "completed",
      attempt: 1,
      branch: `ai/42-${over.runId}`,
      workspacePath: "/tmp/wt",
      startedAt: "2026-05-17T00:00:00.000Z",
      endedAt: "2026-05-17T00:01:00.000Z",
      durations: {},
    },
    ...(over.mrState
      ? {
          mergeRequest: {
            iid: 7,
            url: "https://gl/-/mr/7",
            state: over.mrState,
          },
        }
      : {}),
    handoff: {
      summary: `summary for ${over.runId}`,
      validation: over.validation ?? ["pnpm test"],
      risks: over.risks ?? [],
      followUps: [],
      nextAction: "review",
    },
    diff: {
      summary: over.diffSummary ?? "stub diff",
      filesChanged: 1,
      notableFiles: [],
    },
    checks: over.checks ?? [],
    ...(over.evidence ? { evidence: over.evidence } : {}),
    ...(over.ci ? { ci: over.ci } : {}),
    ...(over.reviewFeedback ? { reviewFeedback: over.reviewFeedback } : {}),
    mergeReadiness: {
      mode: "dry-run",
      status: "unknown",
      reasons: [],
      evaluatedAt: "2026-05-17T00:01:00.000Z",
    },
    notes: {},
  };
}

async function aggregate(
  activePlan: TaskPlan,
  links: TaskRunLink[],
  reports: Map<string, RunReportArtifact>,
  extraDeps: Partial<Parameters<typeof aggregateWorkItem>[3]> = {},
) {
  return aggregateWorkItem(workItem, activePlan, links, {
    getRunReport: async (id) => reports.get(id),
    now: () => "2026-05-17T01:00:00.000Z",
    ...extraDeps,
  });
}

function idsByEvidenceKey(
  entries: Array<{
    kind: string;
    text?: string;
    label: string;
    evidenceId: string;
    source?: { relPath?: string };
  }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of entries) {
    if (entry.source?.relPath) {
      out.set(`${entry.kind}:${entry.source.relPath}`, entry.evidenceId);
      continue;
    }
    if (entry.kind === "validation" && entry.text) {
      out.set(`validation:${entry.text}`, entry.evidenceId);
      continue;
    }
    if (entry.kind === "risk" && entry.text) {
      const level = entry.label.match(/\(([^)]+)\)/)?.[1] ?? "";
      out.set(`risk:${level}:${entry.text}`, entry.evidenceId);
      continue;
    }
    if (entry.kind === "test_result") {
      const command = entry.text?.match(/^command: (.+)$/m)?.[1] ?? "";
      const name = entry.label.replace(/^Check [^:]+: /, "");
      out.set(`test_result:${name}:${command}`, entry.evidenceId);
    }
  }
  return out;
}

describe("aggregateWorkItem", () => {
  it("returns AggregateResult with report and missing", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a" }),
      link({ taskId: "t2", runId: "run_b" }),
    ];
    const result = await aggregate(
      plan,
      links,
      new Map([
        ["run_a", report({ runId: "run_a" })],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    expect(result).toEqual({
      report: expect.objectContaining({
        workItemId: "wi_01",
        overallStatus: "complete",
      }),
      missing: [],
    });
    expect(result.report.taskSummaries.length).toBe(2);
  });

  it("preserves complete, partial, and no-ready-to-merge invariants", async () => {
    const failedPlan = planWith([
      task({ taskId: "t1", status: "completed" }),
      task({ taskId: "t2", status: "failed" }),
    ]);
    const links = [
      link({ taskId: "t1", runId: "run_a", status: "completed" }),
      link({ taskId: "t2", runId: "run_b", status: "failed" }),
    ];
    const result = await aggregate(
      failedPlan,
      links,
      new Map([
        ["run_a", report({ runId: "run_a", mrState: "merged" })],
        [
          "run_b",
          report({ runId: "run_b", status: "failed", mrState: "merged" }),
        ],
      ]),
    );

    expect(result.report.overallStatus).toBe("partial");
    expect(
      result.report.taskSummaries.find((t) => t.taskId === "t2")?.taskStatus,
    ).toBe("failed");
    expect(JSON.stringify(result.report).toLowerCase()).not.toContain(
      "ready_to_merge",
    );
  });

  it("indexes old evidence kinds with deterministic ids and explicit confidence", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a" }),
      link({ taskId: "t2", runId: "run_b" }),
    ];
    const result = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            validation: ["pnpm -r test"],
            risks: [{ level: "medium", text: "regression risk" }],
            ci: {
              status: "success",
              checkedAt: "2026-05-17T00:30:00.000Z",
            },
          }),
        ],
        [
          "run_b",
          report({
            runId: "run_b",
            reviewFeedback: {
              unresolvedCount: 1,
              comments: [
                {
                  author: "reviewer",
                  body: "please fix",
                  url: "https://gl/-/c/1",
                  resolved: false,
                  createdAt: "2026-05-17T00:00:00.000Z",
                },
              ],
            },
          }),
        ],
      ]),
    );

    const kindsT1 = (result.report.evidence.byTask["t1"] ?? []).map(
      (e) => e.kind,
    );
    expect(kindsT1).toEqual(
      expect.arrayContaining(["diff", "validation", "risk", "ci"]),
    );
    const kindsT2 = (result.report.evidence.byTask["t2"] ?? []).map(
      (e) => e.kind,
    );
    expect(kindsT2).toEqual(
      expect.arrayContaining(["diff", "validation", "review_feedback"]),
    );

    for (const entry of result.report.evidence.index) {
      expect(entry.evidenceId).toMatch(
        new RegExp(`^${entry.taskId}:${entry.kind}:run_[ab]:`),
      );
    }
    expect(
      result.report.evidence.index.find((e) => e.kind === "ci")?.confidence,
    ).toBe("system-derived");
    expect(
      result.report.evidence.index.find((e) => e.kind === "review_feedback")
        ?.confidence,
    ).toBe("ai-claim");
  });

  it("hoists RunReportArtifact.evidence into byTask and index", async () => {
    const result = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            evidence: [
              {
                kind: "screenshot",
                label: "Login screen",
                relPath: "evidence/login.png",
                href: "file:///tmp/login.png",
                mediaType: "image/png",
                capturedAt: "2026-05-17T00:02:00.000Z",
              },
              {
                kind: "test_result",
                label: "Playwright passed",
                confidence: "system-derived",
              },
            ],
          }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    const screenshot = result.report.evidence.byTask["t1"]?.find(
      (e) => e.kind === "screenshot",
    );
    expect(screenshot).toEqual(
      expect.objectContaining({
        taskId: "t1",
        label: "Login screen",
        confidence: "ai-claim",
        href: "file:///tmp/login.png",
        mediaType: "image/png",
        capturedAt: "2026-05-17T00:02:00.000Z",
        source: { runId: "run_a", relPath: "evidence/login.png" },
      }),
    );
    expect(result.report.evidence.index).toContainEqual(screenshot);
    expect(
      result.report.evidence.byTask["t1"]?.find(
        (e) => e.kind === "test_result" && e.label === "Playwright passed",
      )?.confidence,
    ).toBe("system-derived");
  });

  it("adds system-derived test_result entries and testSummary from checks", async () => {
    const result = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            checks: [
              {
                name: "unit",
                status: "passed",
                command: "pnpm test",
                durationMs: 1200,
                details: "ok",
              },
              { name: "lint", status: "failed", details: "eslint failed" },
            ],
          }),
        ],
        [
          "run_b",
          report({
            runId: "run_b",
            checks: [
              { name: "e2e", status: "skipped" },
              { name: "typecheck", status: "unknown" },
            ],
          }),
        ],
      ]),
    );

    const checkEvidence = result.report.evidence.byTask["t1"]?.find(
      (e) => e.kind === "test_result" && e.label.includes("unit"),
    );
    expect(checkEvidence).toEqual(
      expect.objectContaining({
        confidence: "system-derived",
        text: expect.stringContaining("pnpm test"),
        source: { runId: "run_a" },
      }),
    );
    expect(result.report.testSummary).toEqual({
      passed: 1,
      failed: 1,
      skipped: 1,
      unknown: 1,
      perTask: {
        t1: { passed: 1, failed: 1, skipped: 0, unknown: 0 },
        t2: { passed: 0, failed: 0, skipped: 1, unknown: 1 },
      },
    });
  });

  it("keeps report.evidence ids stable when evidence order changes", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a" }),
      link({ taskId: "t2", runId: "run_b" }),
    ];
    const screenshot: ReportEvidence = {
      kind: "screenshot",
      label: "Login",
      relPath: "evidence/login.png",
    };
    const recording: ReportEvidence = {
      kind: "recording",
      label: "Login video",
      relPath: "evidence/login.webm",
    };
    const first = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({ runId: "run_a", evidence: [screenshot, recording] }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );
    const second = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({ runId: "run_a", evidence: [recording, screenshot] }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    const firstIds = idsByEvidenceKey(first.report.evidence.byTask["t1"] ?? []);
    const secondIds = idsByEvidenceKey(
      second.report.evidence.byTask["t1"] ?? [],
    );
    expect(secondIds.get("screenshot:evidence/login.png")).toBe(
      firstIds.get("screenshot:evidence/login.png"),
    );
    expect(secondIds.get("recording:evidence/login.webm")).toBe(
      firstIds.get("recording:evidence/login.webm"),
    );
  });

  it("keeps report.evidence id stable when metadata changes but relPath remains", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a" }),
      link({ taskId: "t2", runId: "run_b" }),
    ];
    const first = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            evidence: [
              {
                kind: "screenshot",
                label: "Login v1",
                relPath: "evidence/login.png",
                mediaType: "image/png",
                capturedAt: "2026-05-17T00:02:00.000Z",
              },
            ],
          }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );
    const second = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            evidence: [
              {
                kind: "screenshot",
                label: "Login after copy edit",
                relPath: "evidence/login.png",
                mediaType: "image/webp",
                capturedAt: "2026-05-17T00:03:00.000Z",
                confidence: "system-derived",
              },
            ],
          }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    expect(
      second.report.evidence.byTask["t1"]?.find((e) =>
        e.source?.relPath === "evidence/login.png"
      )?.evidenceId,
    ).toBe(
      first.report.evidence.byTask["t1"]?.find((e) =>
        e.source?.relPath === "evidence/login.png"
      )?.evidenceId,
    );
  });

  it("keeps legacy validation, risk, and check ids stable when arrays reorder", async () => {
    const links = [
      link({ taskId: "t1", runId: "run_a" }),
      link({ taskId: "t2", runId: "run_b" }),
    ];
    const first = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            validation: ["pnpm test", "pnpm lint"],
            risks: [
              { level: "medium", text: "API contract changed" },
              { level: "high", text: "Auth path changed" },
            ],
            checks: [
              {
                name: "unit",
                status: "passed",
                command: "pnpm test",
                durationMs: 1200,
              },
              {
                name: "lint",
                status: "passed",
                command: "pnpm lint",
                durationMs: 500,
              },
            ],
          }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );
    const second = await aggregate(
      plan,
      links,
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            validation: ["pnpm lint", "pnpm test"],
            risks: [
              { level: "high", text: "Auth path changed" },
              { level: "medium", text: "API contract changed" },
            ],
            checks: [
              {
                name: "lint",
                status: "passed",
                command: "pnpm lint",
                durationMs: 700,
              },
              {
                name: "unit",
                status: "passed",
                command: "pnpm test",
                durationMs: 1600,
              },
            ],
          }),
        ],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    const firstIds = idsByEvidenceKey(first.report.evidence.byTask["t1"] ?? []);
    const secondIds = idsByEvidenceKey(
      second.report.evidence.byTask["t1"] ?? [],
    );
    expect(secondIds.get("validation:pnpm test")).toBe(
      firstIds.get("validation:pnpm test"),
    );
    expect(secondIds.get("validation:pnpm lint")).toBe(
      firstIds.get("validation:pnpm lint"),
    );
    expect(secondIds.get("risk:medium:API contract changed")).toBe(
      firstIds.get("risk:medium:API contract changed"),
    );
    expect(secondIds.get("risk:high:Auth path changed")).toBe(
      firstIds.get("risk:high:Auth path changed"),
    );
    expect(secondIds.get("test_result:unit:pnpm test")).toBe(
      firstIds.get("test_result:unit:pnpm test"),
    );
    expect(secondIds.get("test_result:lint:pnpm lint")).toBe(
      firstIds.get("test_result:lint:pnpm lint"),
    );
  });

  it("derives ciSummary using worst status across task reports", async () => {
    const result = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            ci: {
              status: "success",
              pipelineUrl: "https://gl/pipelines/1",
              checkedAt: "2026-05-17T00:00:00.000Z",
            },
          }),
        ],
        [
          "run_b",
          report({
            runId: "run_b",
            ci: {
              status: "failed",
              pipelineUrl: "https://gl/pipelines/2",
              checkedAt: "2026-05-17T00:00:00.000Z",
            },
          }),
        ],
      ]),
    );

    expect(result.report.ciSummary).toEqual({
      overall: "failed",
      perTask: {
        t1: { status: "passed", pipelineUrl: "https://gl/pipelines/1" },
        t2: { status: "failed", pipelineUrl: "https://gl/pipelines/2" },
      },
    });
  });

  it("builds review checklist for risk, status, partial, missing, and CI failures", async () => {
    const activePlan = planWith([
      task({ taskId: "t1", status: "needs_rework" }),
      task({ taskId: "t2", status: "skipped" }),
      task({ taskId: "t3", status: "completed" }),
      task({ taskId: "t4", status: "completed" }),
    ]);
    const result = await aggregate(
      activePlan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t3", runId: "run_c" }),
      ],
      new Map([
        [
          "run_a",
          report({
            runId: "run_a",
            risks: [
              { level: "medium", text: "medium risk" },
              { level: "high", text: "high risk" },
            ],
            ci: {
              status: "failed",
              checkedAt: "2026-05-17T00:00:00.000Z",
            },
          }),
        ],
        ["run_c", report({ runId: "run_c" })],
      ]),
    );

    const reasons = result.report.humanReviewChecklist.map((i) => i.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "ai-risk-medium",
        "ai-risk-high",
        "needs-rework",
        "skipped-task",
        "missing-evidence",
        "ci-failed",
      ]),
    );
    expect(
      result.report.humanReviewChecklist.every((i) => i.confirmed === false),
    ).toBe(true);
    expect(result.report.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        itemId: "needs-rework:t1",
        taskId: "t1",
      }),
    );
    expect(result.report.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        itemId: "missing-evidence:t4",
        taskId: "t4",
      }),
    );
    expect(result.report.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        itemId: "ci-failed:workItem",
      }),
    );
  });

  it("adds a work-item checklist entry for partial overall reports", async () => {
    const activePlan = planWith([
      task({ taskId: "t1", status: "completed" }),
      task({ taskId: "t2", status: "failed" }),
    ]);
    const result = await aggregate(
      activePlan,
      [
        link({ taskId: "t1", runId: "run_a", status: "completed" }),
        link({ taskId: "t2", runId: "run_b", status: "failed" }),
      ],
      new Map([
        ["run_a", report({ runId: "run_a" })],
        ["run_b", report({ runId: "run_b", status: "failed" })],
      ]),
    );

    expect(result.report.humanReviewChecklist).toContainEqual(
      expect.objectContaining({
        itemId: "partial-overall:workItem",
        reason: "partial-overall",
        confirmed: false,
      }),
    );
  });

  it("overlays human confirmations by derived evidenceId", async () => {
    const reports = new Map([
      ["run_a", report({ runId: "run_a", diffSummary: "confirmed diff" })],
      ["run_b", report({ runId: "run_b" })],
    ]);
    const first = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      reports,
    );
    const evidenceId = first.report.evidence.byTask["t1"]?.find(
      (e) => e.kind === "diff",
    )?.evidenceId;
    expect(evidenceId).toBeDefined();

    const second = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      reports,
      {
        getEvidenceConfirmations: async () => ({
          [evidenceId!]: {
            confirmedBy: "alice",
            confirmedAt: "2026-05-17T09:00:00.000Z",
          },
        }),
      },
    );

    expect(
      second.report.evidence.byTask["t1"]?.find((e) => e.kind === "diff"),
    ).toEqual(
      expect.objectContaining({
        evidenceId,
        confidence: "human-confirmed",
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T09:00:00.000Z",
      }),
    );
  });

  it("reports missing no-link, no-run-report, and incomplete-report", async () => {
    const activePlan = planWith([
      task({ taskId: "t1", status: "completed" }),
      task({ taskId: "t2", status: "completed" }),
      task({ taskId: "t3", status: "completed" }),
      task({ taskId: "t4", status: "skipped" }),
    ]);
    const incomplete = {
      ...report({ runId: "run_c" }),
      checks: undefined,
    } as unknown as RunReportArtifact;

    const result = await aggregate(
      activePlan,
      [
        link({ taskId: "t2", runId: "run_b", status: "completed" }),
        link({ taskId: "t3", runId: "run_c", status: "completed" }),
      ],
      new Map([["run_c", incomplete]]),
    );

    expect(result.missing).toEqual([
      { taskId: "t1", reason: "no-link" },
      { taskId: "t2", reason: "no-run-report" },
      { taskId: "t3", reason: "incomplete-report" },
    ]);
  });

  it("reports no-run-report for failed and blocked terminal links with missing reports", async () => {
    const activePlan = planWith([
      task({ taskId: "t1", status: "failed" }),
      task({ taskId: "t2", status: "blocked" }),
    ]);

    const result = await aggregate(
      activePlan,
      [
        link({ taskId: "t1", runId: "run_failed", status: "failed" }),
        link({ taskId: "t2", runId: "run_blocked", status: "blocked" }),
      ],
      new Map(),
    );

    expect(result.report.overallStatus).toBe("incomplete");
    expect(result.missing).toEqual([
      { taskId: "t1", reason: "no-run-report" },
      { taskId: "t2", reason: "no-run-report" },
    ]);
    expect(result.report.humanReviewChecklist).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: "missing-evidence:t1",
          taskId: "t1",
          reason: "missing-evidence",
          confirmed: false,
        }),
        expect.objectContaining({
          itemId: "missing-evidence:t2",
          taskId: "t2",
          reason: "missing-evidence",
          confirmed: false,
        }),
      ]),
    );
  });

  it("does not mark a report incomplete only because evidence is undefined", async () => {
    const result = await aggregate(
      plan,
      [
        link({ taskId: "t1", runId: "run_a" }),
        link({ taskId: "t2", runId: "run_b" }),
      ],
      new Map([
        ["run_a", report({ runId: "run_a" })],
        ["run_b", report({ runId: "run_b" })],
      ]),
    );

    expect(result.missing).toEqual([]);
  });

  it("populates recommendedNextActions for the partial case with failed task ids", async () => {
    const failedPlan = planWith([
      task({ taskId: "t1", title: "Add API", status: "completed" }),
      task({ taskId: "t2", title: "Add UI", status: "failed" }),
    ]);
    const result = await aggregate(
      failedPlan,
      [
        link({ taskId: "t1", runId: "run_a", status: "completed" }),
        link({ taskId: "t2", runId: "run_b", status: "failed" }),
      ],
      new Map([
        ["run_a", report({ runId: "run_a" })],
        ["run_b", report({ runId: "run_b", status: "failed" })],
      ]),
    );

    expect(result.report.recommendedNextActions.join(" ")).toContain("t2");
  });

  // V4.9 Intelligent Review Workflow: when the workflow service has
  // accepted plans for the WorkItem, the aggregator must thread a
  // `reviewReworkSummary` snapshot onto the report so the Parent
  // Review Packet shows blocking / accepted / resolved counters
  // without re-reading the plan store.
  it("V4.9: aggregates per-task accepted rework items into reviewReworkSummary", async () => {
    const plans = [
      {
        planId: "p1",
        runId: "run_a",
        issueIid: 42,
        workItemId: workItem.workItemId,
        taskId: "t1",
        status: "accepted" as const,
        generatedAt: "2026-05-21T00:00:00.000Z",
        items: [
          {
            itemId: "i1",
            status: "accepted" as const,
            category: "test_gap" as const,
            priority: "blocking" as const,
            title: "Add e2e",
            summary: "",
            targetFiles: [],
            suggestedValidation: [],
            sourceRefs: [],
            confidence: 0.7,
          },
          {
            itemId: "i2",
            status: "resolved" as const,
            category: "ci_failure" as const,
            priority: "high" as const,
            title: "Fix flaky tsc",
            summary: "",
            targetFiles: [],
            suggestedValidation: [],
            sourceRefs: [],
            confidence: 0.8,
          },
        ],
      },
    ];
    const result = await aggregate(
      planWith([task({ taskId: "t1", status: "completed" })]),
      [link({ taskId: "t1", runId: "run_a", status: "completed" })],
      new Map([["run_a", report({ runId: "run_a" })]]),
      {
        getReviewReworkPlans: async () => plans,
      },
    );
    expect(result.report.reviewReworkSummary?.blockingCount).toBe(1);
    expect(result.report.reviewReworkSummary?.acceptedCount).toBe(1);
    expect(result.report.reviewReworkSummary?.resolvedCount).toBe(1);
    expect(result.report.reviewReworkSummary?.perTask["t1"]?.blocking).toBe(1);
    expect(result.report.reviewReworkSummary?.latestPlanIds).toEqual(["p1"]);
  });
});
