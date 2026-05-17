// @vitest-environment jsdom
import type { TaskPlan } from "@issuepilot/shared-contracts";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { PlanEditor } from "./plan-editor";

const draftPlan = (): TaskPlan => ({
  planId: "p1",
  workItemId: "wi_1",
  version: 1,
  status: "draft",
  tasks: [
    {
      taskId: "T1",
      title: "Title 1",
      goal: "Goal 1",
      scope: "Scope 1",
      dependsOn: [],
      suggestedValidation: ["pnpm test"],
      status: "ready",
      runIds: [],
      riskLevel: "low",
    },
  ],
  dependencies: [],
  operatorEdits: [],
});

const acceptedPlan = (): TaskPlan => ({
  ...draftPlan(),
  status: "accepted",
  acceptedAt: "2026-05-17T00:00:00.000Z",
});

describe("PlanEditor", () => {
  it("shows Accept and Regenerate buttons when plan is draft", () => {
    render(<PlanEditor plan={draftPlan()} onAccept={vi.fn()} onRegenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("hides Accept / Edit when plan is already accepted", () => {
    render(<PlanEditor plan={acceptedPlan()} onAccept={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: "Accept plan" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("captures inline edits and emits a TaskPlanEdit diff on accept", async () => {
    const onAccept = vi.fn().mockResolvedValue(undefined);
    render(
      <PlanEditor plan={draftPlan()} operator="alice" onAccept={onAccept} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "New Title" } });

    fireEvent.click(screen.getByRole("button", { name: "Accept plan" }));

    await Promise.resolve();
    expect(onAccept).toHaveBeenCalledTimes(1);
    const arg = onAccept.mock.calls[0]![0] as {
      edits: Array<{
        taskId: string;
        field: string;
        before: unknown;
        after: unknown;
        by: string;
      }>;
    };
    expect(arg.edits).toEqual([
      {
        taskId: "T1",
        field: "title",
        before: "Title 1",
        after: "New Title",
        by: "alice",
      },
    ]);
  });

  it("invokes onRegenerate when Regenerate is clicked", () => {
    const onRegenerate = vi.fn();
    render(<PlanEditor plan={draftPlan()} onRegenerate={onRegenerate} />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });
});
