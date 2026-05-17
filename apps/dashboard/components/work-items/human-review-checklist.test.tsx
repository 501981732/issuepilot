// @vitest-environment jsdom
import type { HumanReviewChecklistItem } from "@issuepilot/shared-contracts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";
import zhMessages from "../../i18n/messages/zh.json";

import { HumanReviewChecklist } from "./human-review-checklist";

const reasons: HumanReviewChecklistItem["reason"][] = [
  "ai-risk-medium",
  "ai-risk-high",
  "needs-rework",
  "partial-overall",
  "missing-evidence",
  "skipped-task",
  "ci-failed",
];

function item(
  reason: HumanReviewChecklistItem["reason"],
  over: Partial<HumanReviewChecklistItem> = {},
): HumanReviewChecklistItem {
  return {
    itemId: `${reason}:T1`,
    taskId: "T1",
    label: `Review ${reason}`,
    reason,
    confirmed: false,
    ...over,
  };
}

describe("HumanReviewChecklist", () => {
  it("renders all items as unconfirmed in V4.3", () => {
    render(<HumanReviewChecklist items={reasons.map((r) => item(r))} />);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(reasons.length);
    for (const checkbox of checkboxes) {
      expect(checkbox).toHaveAttribute("aria-checked", "false");
    }
    expect(document.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
  });

  it("would render confirmed state with confirmedBy/At suffix for V4.4", () => {
    render(
      <HumanReviewChecklist
        items={[
          item("ai-risk-medium", {
            confirmed: true,
            confirmedBy: "alice",
            confirmedAt: "2026-05-17T09:00:00.000Z",
          }),
        ]}
      />,
    );

    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText("(confirmed by alice at 2026-05-17T09:00:00.000Z)"),
    ).toBeInTheDocument();
  });

  it("renders the localized hint pointing operators to the Evidence tab", () => {
    render(<HumanReviewChecklist items={[item("missing-evidence")]} />, {
      locale: "zh",
      catalog: zhMessages,
    });

    expect(screen.getByText("逐条证据确认请到证据标签页。")).toBeInTheDocument();
  });

  it("renders the localized reason label for each checklist reason", () => {
    render(<HumanReviewChecklist items={reasons.map((r) => item(r))} />);

    const list = screen.getByRole("list");
    expect(within(list).getByText("Medium AI risk")).toBeInTheDocument();
    expect(within(list).getByText("High AI risk")).toBeInTheDocument();
    expect(within(list).getByText("Needs rework")).toBeInTheDocument();
    expect(within(list).getByText("Partial outcome")).toBeInTheDocument();
    expect(within(list).getByText("Missing evidence")).toBeInTheDocument();
    expect(within(list).getByText("Skipped task")).toBeInTheDocument();
    expect(within(list).getByText("CI failed")).toBeInTheDocument();
  });
});
