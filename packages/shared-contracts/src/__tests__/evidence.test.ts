import { describe, expect, it } from "vitest";

import type { ReportEvidence, RunReportArtifact } from "../report.js";
import {
  isWorkItemReportStatus,
  type HumanReviewChecklistItem,
  type WorkItemCiSummary,
  type WorkItemEvidenceConfidence,
  type WorkItemEvidenceEntry,
  type WorkItemEvidenceKind,
  type WorkItemReport,
  type WorkItemTestSummary,
} from "../work-item.js";

describe("V4.3 evidence contracts", () => {
  it("accepts the 5 new evidence kinds", () => {
    const entries: WorkItemEvidenceKind[] = [
      "screenshot",
      "recording",
      "playwright",
      "command_output",
      "test_result",
    ];
    expect(entries).toHaveLength(5);
  });

  it("keeps the full WorkItemEvidenceEntry kind union", () => {
    const kinds: WorkItemEvidenceKind[] = [
      "diff",
      "validation",
      "risk",
      "ci",
      "review_feedback",
      "screenshot",
      "recording",
      "playwright",
      "command_output",
      "test_result",
    ];
    expect(kinds).toEqual([
      "diff",
      "validation",
      "risk",
      "ci",
      "review_feedback",
      "screenshot",
      "recording",
      "playwright",
      "command_output",
      "test_result",
    ]);
  });

  it("requires confidence on WorkItemEvidenceEntry", () => {
    const e: WorkItemEvidenceEntry = {
      taskId: "t1",
      kind: "screenshot",
      evidenceId: "t1:screenshot:run_a:login",
      label: "Login form",
      confidence: "ai-claim",
      mediaType: "image/png",
      capturedAt: "2026-05-17T08:00:00.000Z",
      source: { runId: "run_a", relPath: "screenshots/login.png" },
    };
    expect(JSON.parse(JSON.stringify(e)).confidence).toBe("ai-claim");
  });

  it("supports the three evidence confidence states", () => {
    const states: WorkItemEvidenceConfidence[] = [
      "ai-claim",
      "system-derived",
      "human-confirmed",
    ];
    expect(states).toEqual([
      "ai-claim",
      "system-derived",
      "human-confirmed",
    ]);
  });

  it("supports a human-confirmed evidence stamp", () => {
    const e: WorkItemEvidenceEntry = {
      taskId: "t1",
      kind: "screenshot",
      evidenceId: "t1:screenshot:run_a:login",
      label: "Login form",
      confidence: "human-confirmed",
      confirmedBy: "alice",
      confirmedAt: "2026-05-17T09:00:00.000Z",
    };
    expect(e.confirmedBy).toBe("alice");
  });

  it("RunReportArtifact carries optional evidence array", () => {
    const ev: ReportEvidence = {
      kind: "playwright",
      label: "Checkout walkthrough",
      relPath: "playwright/checkout-trace.zip",
      mediaType: "application/zip",
      capturedAt: "2026-05-17T08:00:00.000Z",
    };
    const r = { evidence: [ev] } as Partial<RunReportArtifact>;
    expect(r.evidence?.[0]?.kind).toBe("playwright");
  });

  it("ReportEvidence limits confidence to AI or system derived states", () => {
    const ev: ReportEvidence = {
      kind: "test_result",
      label: "Shared contracts tests",
      relPath: "tests/shared-contracts.json",
      confidence: "system-derived",
    };
    expect(ev.confidence).toBe("system-derived");
  });

  it("WorkItemReport carries humanReviewChecklist + ciSummary + testSummary", () => {
    const item: HumanReviewChecklistItem = {
      itemId: "t1:risk",
      taskId: "t1",
      label: "Confirm risk: data migration is reversible",
      reason: "ai-risk-medium",
      confirmed: false,
    };
    const ci: WorkItemCiSummary = {
      overall: "passed",
      perTask: { t1: { status: "passed", pipelineUrl: "https://gitlab/p" } },
    };
    const tests: WorkItemTestSummary = {
      passed: 4,
      failed: 0,
      skipped: 1,
      unknown: 0,
      perTask: { t1: { passed: 4, failed: 0, skipped: 1, unknown: 0 } },
    };
    const r: Partial<WorkItemReport> = {
      humanReviewChecklist: [item],
      ciSummary: ci,
      testSummary: tests,
    };
    expect(r.humanReviewChecklist?.[0]?.confirmed).toBe(false);
    expect(r.ciSummary?.overall).toBe("passed");
    expect(r.testSummary?.passed).toBe(4);
  });

  it("isWorkItemReportStatus remains exhaustive", () => {
    for (const s of ["draft", "partial", "complete", "incomplete"]) {
      expect(isWorkItemReportStatus(s)).toBe(true);
    }
    expect(isWorkItemReportStatus("ready_to_merge")).toBe(false);
  });
});
