// @vitest-environment jsdom
import type { ImprovementRecommendation } from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { Recommendations } from "./recommendations";

const actions = {
  onGenerate: vi.fn(),
  onAccept: vi.fn(),
  onReject: vi.fn(),
  onDefer: vi.fn(),
  onPreview: vi.fn(),
};

beforeEach(() => {
  actions.onGenerate.mockReset();
  actions.onAccept.mockReset();
  actions.onReject.mockReset();
  actions.onDefer.mockReset();
  actions.onPreview.mockReset();
});

function rec(
  over: Partial<ImprovementRecommendation> = {},
): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project", workflow: "default" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: { kind: "prompt_template", description: "Prompt template" },
    evidenceRefs: [
      {
        kind: "quality-drilldown",
        id: "task:wi:t:missing-evidence",
        href: "/work-items/wi?view=evidence",
        reason: "missing evidence",
      },
    ],
    suggestedChange: "Require evidence.",
    patchPreview: {
      status: "generated",
      targetDescription: "Prompt template",
      diff: "+ Require evidence.",
      rollbackNotes: "Remove the added line.",
    },
    confidence: "high",
    risk: "low",
    status: "open",
    actionHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  };
}

describe("Recommendations", () => {
  it("renders an empty state and generate action", () => {
    render(<Recommendations recommendations={[]} {...actions} />);
    expect(screen.getByText("Recommendations")).toBeInTheDocument();
    expect(screen.getByText("No recommendations yet.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Generate recommendations" }),
    );
    expect(actions.onGenerate).toHaveBeenCalled();
  });

  it("shows queue, evidence, and patch preview", () => {
    render(<Recommendations recommendations={[rec()]} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: /Require evidence/ }));
    expect(screen.getByText("missing-evidence")).toBeInTheDocument();
    expect(screen.getByText("+ Require evidence.")).toBeInTheDocument();
    expect(screen.getByText(/Remove the added line\./)).toBeInTheDocument();
  });

  it("calls accept, reject, defer, and preview handlers", async () => {
    render(<Recommendations recommendations={[rec()]} {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: /Require evidence/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Defer" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Generate patch preview" }),
    );
    await waitFor(() => expect(actions.onAccept).toHaveBeenCalledWith("rec_1"));
    expect(actions.onReject).toHaveBeenCalledWith("rec_1");
    expect(actions.onDefer).toHaveBeenCalledWith("rec_1");
    expect(actions.onPreview).toHaveBeenCalledWith("rec_1");
  });
});
