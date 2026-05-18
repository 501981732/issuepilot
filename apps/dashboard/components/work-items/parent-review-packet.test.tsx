// @vitest-environment jsdom
import type { WorkItemReport } from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

vi.mock("../../lib/api", () => ({
  getWorkItemReportMarkdown: vi.fn(),
}));

import { getWorkItemReportMarkdown } from "../../lib/api";
import { ParentReviewPacket } from "./parent-review-packet";

const baseReport = (over: Partial<WorkItemReport> = {}): WorkItemReport => ({
  workItemId: "wi_1",
  overallStatus: "complete",
  taskSummaries: [
    {
      taskId: "T1",
      title: "T1 Title",
      taskStatus: "completed",
      validation: ["pnpm test"],
      risks: [{ level: "medium", text: "schema rename" }],
      followUps: ["docs"],
      mergeRequestUrl: "https://gl/-/mr/7",
      diffSummary: "+10/-2 in src",
      ciStatus: "success",
      nextAction: "request human review",
    },
  ],
  validationSummary: "All synthetic tests pass",
  riskSummary: "Medium risk schema rename",
  evidence: {
    index: [
      {
        taskId: "T1",
        kind: "diff",
        evidenceId: "T1:diff:run_a:diff",
        label: "diff link",
        confidence: "ai-claim",
        href: "https://gl/-/mr/7/diffs",
      },
      {
        taskId: "T1",
        kind: "validation",
        evidenceId: "T1:validation:run_a:test",
        label: "pnpm test passed",
        confidence: "ai-claim",
      },
      {
        taskId: "T1",
        kind: "screenshot",
        evidenceId: "T1:screenshot:run_a:login",
        label: "login screenshot",
        confidence: "ai-claim",
      },
    ],
    byTask: {},
  },
  openQuestions: ["Q1"],
  recommendedNextActions: ["Reviewer to inspect MR"],
  humanReviewChecklist: [],
  generatedAt: "2026-05-17T01:00:00.000Z",
  ...over,
});

describe("ParentReviewPacket", () => {
  it("shows empty state when no report is provided", () => {
    render(<ParentReviewPacket />);
    expect(
      screen.getByText(/Aggregation pending/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Copy as Markdown/i)).not.toBeInTheDocument();
  });

  it("renders complete status banner with summaries, evidence and next actions", () => {
    render(<ParentReviewPacket report={baseReport()} />);
    expect(screen.getByText("All tasks completed")).toBeInTheDocument();
    expect(screen.getByText("All synthetic tests pass")).toBeInTheDocument();
    expect(screen.getByText("Medium risk schema rename")).toBeInTheDocument();
    expect(screen.getByText("T1 Title")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MR ↗" })).toHaveAttribute(
      "href",
      "https://gl/-/mr/7",
    );
    expect(
      screen.getByRole("link", { name: "diff link" }),
    ).toBeInTheDocument();
    expect(screen.getByText("login screenshot")).toBeInTheDocument();
    expect(screen.getByText("Reviewer to inspect MR")).toBeInTheDocument();
  });

  it("renders ConfidencePill for each evidence entry", () => {
    render(<ParentReviewPacket report={baseReport()} />);

    expect(screen.getAllByText("AI inferred")).toHaveLength(3);
  });

  it("renders HumanReviewChecklist when report.humanReviewChecklist is non-empty", () => {
    render(
      <ParentReviewPacket
        report={baseReport({
          humanReviewChecklist: [
            {
              itemId: "ai-risk-medium:T1",
              taskId: "T1",
              label: "Review medium AI risk for T1",
              reason: "ai-risk-medium",
              confirmed: false,
            },
          ],
        })}
      />,
    );

    expect(
      screen.getByText("Confirm evidence item by item in the Evidence tab."),
    ).toBeInTheDocument();
    expect(screen.getByText("Review medium AI risk for T1")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("renders partial status banner with the partial label", () => {
    render(
      <ParentReviewPacket report={baseReport({ overallStatus: "partial" })} />,
    );
    expect(
      screen.getByText("Partial — operator action required"),
    ).toBeInTheDocument();
  });

  it("renders incomplete status banner when the report itself is unreliable", () => {
    render(
      <ParentReviewPacket
        report={baseReport({ overallStatus: "incomplete" })}
      />,
    );
    expect(screen.getByText("Awaiting more task runs")).toBeInTheDocument();
  });

  it("never surfaces a `ready_to_merge` recommendation", () => {
    render(
      <ParentReviewPacket
        report={baseReport({
          overallStatus: "complete",
          recommendedNextActions: [
            "Reviewer to inspect the linked MRs and decide next steps.",
          ],
        })}
      />,
    );
    expect(screen.queryByText(/ready_to_merge/i)).not.toBeInTheDocument();
  });

  it("Copy as Markdown fetches report.md and writes it to navigator.clipboard", async () => {
    vi.mocked(getWorkItemReportMarkdown).mockResolvedValue(
      "# Server-rendered Review Packet\n\nAll synthetic tests pass\n",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<ParentReviewPacket report={baseReport()} project="platform-web" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    await waitFor(() =>
      expect(getWorkItemReportMarkdown).toHaveBeenCalledWith("wi_1", {
        project: "platform-web",
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const md = writeText.mock.calls[0]![0] as string;
    expect(md).toContain("# Server-rendered Review Packet");
    expect(md).toContain("All synthetic tests pass");
  });
});
