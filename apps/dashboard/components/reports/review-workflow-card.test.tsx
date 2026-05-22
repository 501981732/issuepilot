// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ReviewWorkflowCard } from "./review-workflow-card";

describe("ReviewWorkflowCard", () => {
  it("renders counters and top categories from the quality summary slice", () => {
    render(
      <ReviewWorkflowCard
        data={{
          plansGenerated: 3,
          itemsAccepted: 5,
          itemsResolved: 2,
          topCategories: [
            { category: "test_gap", count: 4 },
            { category: "ci_failure", count: 1 },
          ],
          runnerKindBreakdown: { codex_app_server: 2, claude_code: 1 },
        }}
      />,
    );
    expect(screen.getByText("Review workflow")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Test gap")).toBeInTheDocument();
    expect(screen.getByText("codex_app_server")).toBeInTheDocument();
  });

  it("shows the empty fallback when no categories or runner kinds exist", () => {
    render(
      <ReviewWorkflowCard
        data={{
          plansGenerated: 0,
          itemsAccepted: 0,
          itemsResolved: 0,
          topCategories: [],
          runnerKindBreakdown: {},
        }}
      />,
    );
    expect(
      screen.getByText("No rework plans recorded yet."),
    ).toBeInTheDocument();
  });
});
