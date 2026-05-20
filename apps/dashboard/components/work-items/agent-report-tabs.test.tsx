// @vitest-environment jsdom
import type {
  AgentReport,
  CoderAgentReport,
  ReviewerAgentReport,
  TestEvidenceAgentReport,
} from "@issuepilot/shared-contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { AgentReportTabs } from "./agent-report-tabs";

const baseFields = {
  agentReportId: "ar-1",
  pipelineRunId: "p-1",
  taskId: "t-1",
  roleProfileId: "v1",
  // V4.7: every AgentReport carries runner trace fields. Fixtures must
  // include them so V4.6 dashboard render tests stay compatible with the
  // strengthened `isAgentReport()` guard in shared-contracts.
  runnerId: "codex_app_server",
  runnerKind: "codex_app_server",
  runnerRunId: "turn-1",
  startedAt: "2026-05-19T00:00:00.000Z",
  completedAt: "2026-05-19T00:01:00.000Z",
  evidenceLinks: [],
  redactedFields: [],
} as const;

function coderReport(over: Partial<CoderAgentReport> = {}): CoderAgentReport {
  return {
    ...baseFields,
    role: "coder",
    status: "complete",
    coder: { diffSummary: "wrote tests + diff" } as unknown,
    ...over,
  } as CoderAgentReport;
}

function reviewerReport(
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport {
  return {
    ...baseFields,
    agentReportId: "ar-2",
    role: "reviewer",
    status: "complete",
    reviewer: {
      summary: "Looks good, two minor findings",
      decision: "approve_with_comments",
      confidence: 0.91,
      risks: [],
      evidenceRequest: [],
      findings: [
        {
          severity: "high",
          category: "logic-error",
          message: "off-by-one",
        },
        {
          severity: "low",
          category: "style",
          message: "missing semicolon",
        },
      ],
      inlineComments: [
        {
          filePath: "src/foo.ts",
          lineRange: { start: 12, end: 14 },
          severity: "high",
          category: "logic-error",
          message: "off-by-one",
        },
      ],
      mrPublication: { status: "published", noteIds: ["n1"] },
    },
    ...over,
  } as ReviewerAgentReport;
}

function testEvidenceReport(
  over: Partial<TestEvidenceAgentReport> = {},
): TestEvidenceAgentReport {
  return {
    ...baseFields,
    agentReportId: "ar-3",
    role: "test_evidence",
    status: "incomplete",
    testEvidence: {
      evidenceItems: [
        {
          kind: "command_output",
          target: "pnpm test",
          source: "ci",
          status: "collected",
        },
      ],
      baselineEvidence: null,
    },
    ...over,
  } as TestEvidenceAgentReport;
}

describe("AgentReportTabs (V4.6)", () => {
  it("renders all three tabs and defaults to first available role", () => {
    const reports: Partial<Record<AgentReport["role"], AgentReport>> = {
      reviewer: reviewerReport(),
    };
    render(<AgentReportTabs reports={reports} />);
    expect(screen.getByTestId("agent-tab-coder")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-reviewer")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-test_evidence")).toBeInTheDocument();
    expect(screen.getByTestId("reviewer-panel")).toBeInTheDocument();
  });

  it("renders empty state for missing role", () => {
    render(<AgentReportTabs reports={{ coder: coderReport() }} />);
    fireEvent.click(screen.getByTestId("agent-tab-reviewer"));
    expect(screen.getByTestId("agent-empty-reviewer")).toBeInTheDocument();
  });

  it("reviewer panel shows decision badge + findings sorted by severity", () => {
    render(<AgentReportTabs reports={{ reviewer: reviewerReport() }} />);
    expect(screen.getByTestId("reviewer-decision-badge")).toHaveTextContent(
      /approve with comments/i,
    );
    const findings = within(screen.getByTestId("reviewer-findings"));
    const items = findings.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toMatch(/off-by-one/);
    expect(items[1]?.textContent).toMatch(/missing semicolon/);
  });

  it("reviewer panel mounts RevokeAiReviewButton enabled when published", () => {
    render(<AgentReportTabs reports={{ reviewer: reviewerReport() }} />);
    const trigger = screen.getByTestId("revoke-trigger");
    expect(trigger).not.toBeDisabled();
  });

  it("test_evidence panel renders evidence items list", () => {
    render(
      <AgentReportTabs
        reports={{ test_evidence: testEvidenceReport() }}
      />,
    );
    fireEvent.click(screen.getByTestId("agent-tab-test_evidence"));
    expect(screen.getByTestId("test-evidence-panel")).toBeInTheDocument();
    expect(screen.getByText("command_output")).toBeInTheDocument();
  });

  it("coder panel renders summary and lastError when present", () => {
    render(
      <AgentReportTabs
        reports={{
          coder: coderReport({
            status: "failed",
            lastError: { code: "coding_failed", message: "build broke" },
          }),
        }}
      />,
    );
    expect(screen.getByTestId("coder-panel")).toBeInTheDocument();
    expect(screen.getByTestId("coder-lastError").textContent).toMatch(
      /coding_failed/,
    );
  });

  it("V4.6 fix: CoderPanel reads CoderAgentReportPayload.diffSummary", () => {
    render(
      <AgentReportTabs
        reports={{
          coder: coderReport({
            coder: { diffSummary: "wrote 12 files + tests" } as unknown,
          } as Partial<CoderAgentReport>),
        }}
      />,
    );
    expect(screen.getByTestId("coder-panel").textContent).toMatch(
      /wrote 12 files \+ tests/,
    );
  });

  it("V4.7 shows compact runner trace metadata on each role panel", () => {
    render(
      <AgentReportTabs
        reports={{
          coder: coderReport({
            runnerId: "codex_app_server",
            runnerKind: "codex_app_server",
            runnerRunId: "turn-coder",
          }),
        }}
      />,
    );
    const trace = screen.getByTestId("agent-runner-trace-coder");
    // Both runnerId and runnerKind happen to be the same string in V4.7
    // (only one supported kind), so we just assert the values are visible
    // and the runId is rendered in its own slot.
    expect(trace.textContent).toMatch(/codex_app_server/);
    expect(trace.textContent).toMatch(/turn-coder/);
  });

  it("V4.7 does not render an empty runnerRunId slot when missing", () => {
    render(
      <AgentReportTabs
        reports={{
          reviewer: reviewerReport({
            runnerId: "codex_app_server",
            runnerKind: "codex_app_server",
            runnerRunId: null,
          }),
        }}
      />,
    );
    const trace = screen.getByTestId("agent-runner-trace-reviewer");
    expect(trace.textContent).toMatch(/codex_app_server/);
    expect(
      screen.queryByTestId("agent-runner-trace-reviewer-runId"),
    ).not.toBeInTheDocument();
  });
});
