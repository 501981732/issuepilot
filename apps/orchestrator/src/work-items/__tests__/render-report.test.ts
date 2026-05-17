import { describe, expect, it } from "vitest";

import type {
  TaskPlan,
  WorkItem,
  WorkItemReport,
} from "@issuepilot/shared-contracts";

import { workItemHandoffMarker } from "../handoff.js";
import { renderWorkItemReportMarkdown } from "../render-report.js";

const workItem: WorkItem = {
  workItemId: "wi_01",
  sourceIssue: {
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "Big issue",
  },
  title: "Big issue",
  goal: "Ship feature X.",
  acceptanceCriteria: ["AC1", "AC2"],
  status: "completed",
  taskIds: ["t1", "t2"],
  createdAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z",
};

const plan: TaskPlan = {
  planId: "tp_01",
  workItemId: "wi_01",
  version: 3,
  tasks: [
    {
      taskId: "t1",
      title: "Add API",
      goal: "POST /x",
      scope: "src/api/x.ts",
      dependsOn: [],
      suggestedValidation: ["pnpm test"],
      status: "completed",
      runIds: ["run_a"],
      riskLevel: "medium",
    },
    {
      taskId: "t2",
      title: "Add UI",
      goal: "Render result",
      scope: "src/ui/x.tsx",
      dependsOn: ["t1"],
      suggestedValidation: ["pnpm test"],
      status: "completed",
      runIds: ["run_b"],
      riskLevel: "low",
    },
  ],
  dependencies: [{ from: "t1", to: "t2" }],
  operatorEdits: [],
  status: "accepted",
  acceptedAt: "2026-05-17T00:01:00.000Z",
};

function report(over: Partial<WorkItemReport> = {}): WorkItemReport {
  return {
    workItemId: "wi_01",
    overallStatus: "complete",
    taskSummaries: [
      {
        taskId: "t1",
        title: "Add API",
        taskStatus: "completed",
        runId: "run_a",
        diffSummary: "Added /x route",
        validation: ["pnpm test passed"],
        risks: [{ level: "medium", text: "API contract changed" }],
        followUps: ["Confirm rollout window"],
        mergeRequestUrl: "https://gl/-/mrs/100",
        ciStatus: "success",
        nextAction: "Reviewer to inspect MR.",
      },
      {
        taskId: "t2",
        title: "Add UI",
        taskStatus: "completed",
        runId: "run_b",
        diffSummary: "Added UI",
        validation: ["pnpm test passed"],
        risks: [],
        followUps: [],
        mergeRequestUrl: "https://gl/-/mrs/101",
        ciStatus: "success",
        nextAction: "Reviewer to inspect MR.",
      },
    ],
    validationSummary: "All tests green",
    riskSummary: "One medium API contract risk.",
    evidence: {
      index: [
        {
          taskId: "t2",
          kind: "validation",
          evidenceId: "t2:validation:run_b:002",
          label: "UI validation",
          confidence: "system-derived",
          text: "pnpm test passed",
          source: { runId: "run_b" },
        },
        {
          taskId: "t1",
          kind: "screenshot",
          evidenceId: "t1:screenshot:run_a:002",
          label: "API screenshot",
          confidence: "ai-claim",
          source: {
            runId: "run_a",
            relPath: "evidence/api.png",
          },
        },
        {
          taskId: "t1",
          kind: "diff",
          evidenceId: "t1:diff:run_a:001",
          label: "API diff",
          confidence: "system-derived",
          href: "https://gl/-/mrs/100/diffs",
          text: "Added /x route",
          source: { runId: "run_a" },
        },
      ],
      byTask: {
        t2: [
          {
            taskId: "t2",
            kind: "validation",
            evidenceId: "t2:validation:run_b:002",
            label: "UI validation",
            confidence: "system-derived",
            text: "pnpm test passed",
            source: { runId: "run_b" },
          },
        ],
        t1: [
          {
            taskId: "t1",
            kind: "screenshot",
            evidenceId: "t1:screenshot:run_a:002",
            label: "API screenshot",
            confidence: "ai-claim",
            source: {
              runId: "run_a",
              relPath: "evidence/api.png",
            },
          },
          {
            taskId: "t1",
            kind: "diff",
            evidenceId: "t1:diff:run_a:001",
            label: "API diff",
            confidence: "system-derived",
            href: "https://gl/-/mrs/100/diffs",
            text: "Added /x route",
            source: { runId: "run_a" },
          },
        ],
      },
    },
    openQuestions: ["Should rollout wait for the next release train?"],
    recommendedNextActions: [
      "Ask reviewer to inspect each MR.",
      "ready_to_merge",
    ],
    humanReviewChecklist: [
      {
        itemId: "risk:t1",
        taskId: "t1",
        label: "Review API contract risk",
        reason: "ai-risk-medium",
        confirmed: false,
      },
      {
        itemId: "ci:t2",
        taskId: "t2",
        label: "Confirm UI CI result",
        reason: "ci-failed",
        confirmed: true,
        confirmedBy: "alice",
        confirmedAt: "2026-05-17T02:00:00.000Z",
      },
    ],
    ciSummary: {
      overall: "failed",
      perTask: {
        t1: { status: "passed", pipelineUrl: "https://gl/pipelines/1" },
        t2: { status: "failed", pipelineUrl: "https://gl/pipelines/2" },
      },
    },
    testSummary: {
      passed: 4,
      failed: 1,
      skipped: 2,
      unknown: 0,
      perTask: {
        t1: { passed: 2, failed: 0, skipped: 0, unknown: 0 },
        t2: { passed: 2, failed: 1, skipped: 2, unknown: 0 },
      },
    },
    generatedAt: "2026-05-17T01:00:00.000Z",
    ...over,
  };
}

function withoutTitle(markdown: string): string {
  return markdown.split("\n").slice(1).join("\n");
}

describe("renderWorkItemReportMarkdown", () => {
  it("renders audience-specific titles without emitting the GitLab marker", () => {
    const gitlab = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "gitlab",
    });
    const markdown = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
    });

    expect(gitlab).toContain("## IssuePilot work item handoff — Big issue");
    expect(markdown).toContain("# Parent Review Packet — Big issue");
    expect(gitlab).not.toContain(workItemHandoffMarker(workItem.workItemId));
    expect(markdown).not.toContain(workItemHandoffMarker(workItem.workItemId));
  });

  it("renders status metadata and human checklist confirmation state", () => {
    const body = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
    });

    expect(body).toContain("- Status: All tasks completed (complete)");
    expect(body).toContain("- Plan version: 3");
    expect(body).toContain("- Tasks: 2");
    expect(body).toContain("- Generated at: 2026-05-17T01:00:00.000Z");
    expect(body).toContain("- [ ] Review API contract risk");
    expect(body).toContain(
      "- [x] Confirm UI CI result — confirmed by alice at 2026-05-17T02:00:00.000Z",
    );
  });

  it("groups evidence by task in plan order and sorts evidence by evidenceId", () => {
    const body = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
      evidenceBaseHref: "https://reports.local/evidence",
    });

    const t1Heading = body.indexOf("#### Add API (t1)");
    const t1Diff = body.indexOf(
      "- [API diff](https://gl/-/mrs/100/diffs) (system-derived)",
    );
    const t1Screenshot = body.indexOf(
      "- [API screenshot](https://reports.local/evidence?runId=run_a&path=evidence%2Fapi.png) (ai-claim)",
    );
    const t2Heading = body.indexOf("#### Add UI (t2)");
    const t2Validation = body.indexOf("- UI validation (system-derived)");

    expect(t1Heading).toBeGreaterThan(-1);
    expect(t1Diff).toBeGreaterThan(t1Heading);
    expect(t1Screenshot).toBeGreaterThan(t1Diff);
    expect(t2Heading).toBeGreaterThan(t1Screenshot);
    expect(t2Validation).toBeGreaterThan(t2Heading);
  });

  it("renders CI and test summaries when present, and omits CI when undefined", () => {
    const withSummaries = renderWorkItemReportMarkdown(
      workItem,
      plan,
      report(),
      {
        audience: "markdown",
      },
    );
    const withoutCi = renderWorkItemReportMarkdown(
      workItem,
      plan,
      report({ ciSummary: undefined }),
      { audience: "markdown" },
    );

    expect(withSummaries).toContain("### CI");
    expect(withSummaries).toContain("- Overall: failed");
    expect(withSummaries).toContain("- t2: failed — https://gl/pipelines/2");
    expect(withSummaries).toContain("### Tests");
    expect(withSummaries).toContain(
      "- Total: 4 passed, 1 failed, 2 skipped, 0 unknown",
    );
    expect(withoutCi).not.toContain("### CI");
  });

  it("keeps core sections identical between audiences and never outputs ready_to_merge", () => {
    const gitlab = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "gitlab",
    });
    const markdown = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
    });

    expect(withoutTitle(gitlab)).toBe(withoutTitle(markdown));
    expect(gitlab.toLowerCase()).not.toContain("ready_to_merge");
    expect(markdown.toLowerCase()).not.toContain("ready_to_merge");
  });

  it("is deterministic", () => {
    const first = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
      evidenceBaseHref: "https://reports.local/evidence?viewer=1",
    });
    const second = renderWorkItemReportMarkdown(workItem, plan, report(), {
      audience: "markdown",
      evidenceBaseHref: "https://reports.local/evidence?viewer=1",
    });

    expect(first).toBe(second);
    expect(first).toContain(
      "[API screenshot](https://reports.local/evidence?viewer=1&runId=run_a&path=evidence%2Fapi.png)",
    );
  });
});
