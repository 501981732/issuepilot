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
    // V4.7 review N2: 标签必须走 i18n, 在 en bundle 下展示 "Runner / Kind /
    // Run"; runnerKind 通过 `kinds.codex_app_server` 映射成 display name
    // "Codex App Server" 而不是裸 enum 值。注意 `<dt>` 是 inline label,所以
    // 用 `within(...).getByText` 拿单独节点比对,而不是把整段 textContent
    // 拼起来正则匹配。
    const labels = within(trace).getAllByText(/^(Runner|Kind|Run)$/);
    expect(labels.map((n) => n.textContent)).toEqual([
      "Runner",
      "Kind",
      "Run",
    ]);
    expect(within(trace).getByText("Codex App Server")).toBeInTheDocument();
    // runnerId 仍然按原 enum 渲染,用于跨任务定位 adapter。
    expect(within(trace).getByText("codex_app_server")).toBeInTheDocument();
    expect(within(trace).getByText("turn-coder")).toBeInTheDocument();
  });

  it("V4.7 review N-5 regression: unknown runnerKind falls back to raw enum (no i18n throw)", () => {
    // 模拟未来加了新 runner 但只更新 persisted data、暂时没补 i18n
    // bundle 的过渡期。RunnerTrace 不应抛 next-intl 4.x 的 MISSING_MESSAGE,
    // 而应直接渲染原值,等 i18n bundle 补齐再升级显示。
    render(
      <AgentReportTabs
        reports={{
          coder: coderReport({
            runnerId: "local_command_v1",
            // 故意用一个不在 RUNNER_KIND_VALUES 的字符串走 fallback 路径。
            runnerKind: "local_command" as unknown as "codex_app_server",
            runnerRunId: "turn-local",
          }),
        }}
      />,
    );
    const trace = screen.getByTestId("agent-runner-trace-coder");
    // Kind 字段应渲染未翻译的 "local_command" 而不是 "kinds.local_command"。
    expect(within(trace).getByText("local_command")).toBeInTheDocument();
    expect(
      within(trace).queryByText("kinds.local_command"),
    ).not.toBeInTheDocument();
  });

  it("V4.8 renders claude_code runner kind display name", () => {
    render(
      <AgentReportTabs
        reports={{
          reviewer: reviewerReport({
            runnerId: "claude_reviewer",
            runnerKind: "claude_code",
            runnerRunId: "claude-run-1",
          }),
        }}
      />,
    );
    const trace = screen.getByTestId("agent-runner-trace-reviewer");
    expect(within(trace).getByText("Claude Code")).toBeInTheDocument();
    expect(within(trace).getByText("claude_reviewer")).toBeInTheDocument();
    expect(within(trace).getByText("claude-run-1")).toBeInTheDocument();
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
