// @vitest-environment jsdom
import type { ReviewReworkSummary as ReviewReworkSummaryShape } from "@issuepilot/shared-contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ReviewReworkSummary } from "./review-rework-summary";

const populated: ReviewReworkSummaryShape = {
  blockingCount: 1,
  acceptedCount: 2,
  resolvedCount: 3,
  perTask: {
    "task-1": { blocking: 1, accepted: 1, resolved: 0 },
    "task-2": { blocking: 0, accepted: 1, resolved: 3 },
  },
  latestPlanIds: ["plan-1", "plan-2"],
};

describe("ReviewReworkSummary", () => {
  it("renders the counts from the contract", () => {
    render(<ReviewReworkSummary summary={populated} />);
    expect(screen.getByText("Review rework summary")).toBeInTheDocument();
    expect(screen.getByText("plan-1, plan-2")).toBeInTheDocument();
    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByText("task-2")).toBeInTheDocument();
  });

  it("shows empty-state copy when the summary has no counts", () => {
    render(
      <ReviewReworkSummary
        summary={{
          blockingCount: 0,
          acceptedCount: 0,
          resolvedCount: 0,
          perTask: {},
          latestPlanIds: [],
        }}
      />,
    );
    expect(
      screen.getByText("No rework plans recorded yet."),
    ).toBeInTheDocument();
  });
});
