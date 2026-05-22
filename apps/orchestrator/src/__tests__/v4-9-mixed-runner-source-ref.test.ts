/**
 * V4.9 §2.6 / §11 — mixed runner runnerKind propagation.
 *
 * 当 reviewer 阶段使用 V4.8 多 runner（如 `claude_code`）时，planner
 * 必须把原始 runnerKind 透传到 `ReviewReworkSourceRef.runnerKind`，否则
 * 后续的 quality analytics / Parent Review Packet 会丢失 provenance，
 * 这是 V4.8 dogfood 接力到 V4.9 的核心数据契约。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus, type IssuePilotInternalEvent } from "@issuepilot/observability";
import type { ReviewerAgentReport } from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createReviewReworkPlanStore } from "../review-workflow/store.js";
import { createReviewWorkflowService } from "../review-workflow/service.js";

function makeReviewerReport(
  overrides: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport {
  return {
    agentReportId: "report-1",
    runId: "run-1",
    issueIid: 11,
    role: "reviewer",
    status: "complete",
    submittedAt: "2026-05-21T10:00:00Z",
    completedAt: "2026-05-21T10:01:00Z",
    runnerId: "claude-code-primary",
    runnerKind: "claude_code",
    runnerRunId: "rrun-1",
    reviewer: {
      summary: "Need stronger test coverage for the navbar fix.",
      decision: "rework",
      confidence: 0.78,
      risks: [],
      evidenceRequest: [],
      findings: [
        {
          severity: "high",
          category: "test_gap",
          message: "missing e2e for navbar after layout shuffle",
          locationHint: { filePath: "src/components/navbar.tsx" },
        },
      ],
      inlineComments: [],
      mrPublication: { status: "skipped" },
    },
    ...overrides,
  };
}

describe("V4.9 review rework plan source refs", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "ipilot-v49-mixed-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("preserves runnerKind on source refs when reviewer findings come from claude_code", async () => {
    const store = createReviewReworkPlanStore({ rootDir: workdir });
    const bus = createEventBus<IssuePilotInternalEvent>();
    const service = createReviewWorkflowService({
      store,
      eventBus: bus,
      now: () => new Date("2026-05-21T10:05:00Z"),
    });

    const plan = await service.generate({
      runId: "run-1",
      issueIid: 11,
      reviewerReports: [makeReviewerReport()],
    });

    expect(plan.items).toHaveLength(1);
    const ref = plan.items[0]!.sourceRefs[0]!;
    expect(ref.kind).toBe("ai_reviewer_finding");
    expect(ref.runnerKind).toBe("claude_code");
    expect(ref.agentReportId).toBe("report-1");
  });

  it("also preserves runnerKind for codex_app_server findings", async () => {
    const store = createReviewReworkPlanStore({ rootDir: workdir });
    const bus = createEventBus<IssuePilotInternalEvent>();
    const service = createReviewWorkflowService({
      store,
      eventBus: bus,
      now: () => new Date("2026-05-21T10:05:00Z"),
    });

    const plan = await service.generate({
      runId: "run-2",
      issueIid: 12,
      reviewerReports: [
        makeReviewerReport({
          agentReportId: "report-2",
          runId: "run-2",
          issueIid: 12,
          runnerKind: "codex_app_server",
        }),
      ],
    });

    expect(plan.items[0]!.sourceRefs[0]!.runnerKind).toBe("codex_app_server");
  });
});
