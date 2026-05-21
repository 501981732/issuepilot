// @vitest-environment jsdom
import type {
  ReviewReworkPlan,
  ReviewReworkItem,
} from "@issuepilot/shared-contracts";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ReviewReworkPlanPanel } from "./review-rework-plan-panel";

function makeItem(
  overrides: Partial<ReviewReworkItem> = {},
): ReviewReworkItem {
  return {
    itemId: "i1",
    status: "open",
    category: "correctness",
    priority: "blocking",
    title: "Fix null handling",
    summary: "reviewer flagged null",
    targetFiles: ["src/foo.ts"],
    suggestedValidation: ["pnpm test"],
    sourceRefs: [
      {
        kind: "human_review_comment",
        id: "note-1",
        url: "https://gitlab.example.com/g/p/-/merge_requests/1#note_1",
      },
    ],
    confidence: 0.9,
    ...overrides,
  };
}

function makePlan(overrides: Partial<ReviewReworkPlan> = {}): ReviewReworkPlan {
  return {
    planId: "p1",
    runId: "r1",
    issueIid: 7,
    status: "draft",
    generatedAt: "2026-05-21T00:00:00.000Z",
    items: [makeItem()],
    ...overrides,
  };
}

describe("ReviewReworkPlanPanel", () => {
  it("renders plan title, status badge, item title and priority/category", () => {
    render(
      <ReviewReworkPlanPanel
        plan={makePlan()}
        onAcceptPlan={vi.fn()}
        onDismissPlan={vi.fn()}
        onItemAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Review rework plan")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Fix null handling")).toBeInTheDocument();
    expect(screen.getByText("Blocking")).toBeInTheDocument();
    expect(screen.getByText("Correctness")).toBeInTheDocument();
    expect(screen.getByText("Reviewer note")).toBeInTheDocument();
  });

  it("calls onAcceptPlan with the plan id when the Accept plan button is pressed", () => {
    const onAcceptPlan = vi.fn();
    render(
      <ReviewReworkPlanPanel
        plan={makePlan()}
        onAcceptPlan={onAcceptPlan}
        onDismissPlan={vi.fn()}
        onItemAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept plan" }));
    expect(onAcceptPlan).toHaveBeenCalledWith("p1");
  });

  it("disables accept/dismiss buttons when the plan is not in draft status", () => {
    render(
      <ReviewReworkPlanPanel
        plan={makePlan({ status: "accepted" })}
        onAcceptPlan={vi.fn()}
        onDismissPlan={vi.fn()}
        onItemAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Accept plan" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss plan" })).toBeDisabled();
  });

  it("invokes onItemAction with the next status when the per-item button is clicked", () => {
    const onItemAction = vi.fn();
    render(
      <ReviewReworkPlanPanel
        plan={makePlan()}
        onAcceptPlan={vi.fn()}
        onDismissPlan={vi.fn()}
        onItemAction={onItemAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(onItemAction).toHaveBeenCalledWith("p1", "i1", "accepted");
  });

  it("shows the empty-state copy when the plan has no items", () => {
    render(
      <ReviewReworkPlanPanel
        plan={makePlan({ items: [] })}
        onAcceptPlan={vi.fn()}
        onDismissPlan={vi.fn()}
        onItemAction={vi.fn()}
      />,
    );
    expect(
      screen.getByText("No rework items in this plan."),
    ).toBeInTheDocument();
  });
});
