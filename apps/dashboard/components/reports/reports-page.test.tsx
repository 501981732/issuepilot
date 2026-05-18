// @vitest-environment jsdom
import type { QualitySummaryResponse } from "@issuepilot/shared-contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ReportsPage } from "./reports-page";

function qualitySummaryFixture(
  over: Partial<QualitySummaryResponse> = {},
): QualitySummaryResponse {
  return {
    scope: { mode: "single-project" },
    filters: {
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-18T00:00:00.000Z",
      window: "7d",
    },
    metrics: [],
    trends: [],
    failurePatterns: [],
    drilldown: [],
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
    ...over,
  };
}

describe("ReportsPage", () => {
  it("renders counters and table rows", () => {
    render(
      <ReportsPage
        reports={[
          {
            runId: "run-1",
            issueIid: 42,
            issueTitle: "Fix checkout",
            projectId: "group/project",
            status: "completed",
            labels: ["human-review"],
            attempt: 1,
            branch: "ai/42",
            mergeReadinessStatus: "ready",
            updatedAt: "2026-05-16T00:00:00.000Z",
            totalMs: 60000,
          },
          {
            runId: "run-2",
            issueIid: 43,
            issueTitle: "Refactor login",
            projectId: "group/project",
            status: "failed",
            labels: ["ai-failed"],
            attempt: 2,
            branch: "ai/43",
            mergeReadinessStatus: "blocked",
            updatedAt: "2026-05-16T00:01:00.000Z",
          },
        ]}
        quality={qualitySummaryFixture()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Reports" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Fix checkout")).toBeInTheDocument();
    expect(screen.getByText("Refactor login")).toBeInTheDocument();
    expect(screen.getAllByText("ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1m").length).toBeGreaterThan(0);
  });

  it("renders the quality analytics section", () => {
    render(
      <ReportsPage
        reports={[]}
        quality={qualitySummaryFixture({
          metrics: [
            {
              id: "success-rate",
              label: "Success rate",
              value: 50,
              unit: "percent",
              numerator: 1,
              denominator: 2,
              direction: "unknown",
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Quality Analytics/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Success rate/i)).toBeInTheDocument();
  });

  it("renders an empty state when no reports exist", () => {
    render(<ReportsPage reports={[]} quality={qualitySummaryFixture()} />);
    expect(screen.getByText(/No reports yet/i)).toBeInTheDocument();
  });
});
