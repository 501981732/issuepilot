// @vitest-environment jsdom
import type { WorkItemEvidenceResponse } from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { EvidenceTab } from "./evidence-tab";

const baseEvidence = (
  over: Partial<WorkItemEvidenceResponse> = {},
): WorkItemEvidenceResponse => ({
  index: [
    {
      taskId: "task-a",
      kind: "screenshot",
      evidenceId: "ev_screenshot",
      label: "Login screenshot",
      confidence: "ai-claim",
      source: { runId: "run-1", relPath: "screenshots/login.png" },
    },
    {
      taskId: "task-a",
      kind: "command_output",
      evidenceId: "ev_command",
      label: "pnpm lint",
      confidence: "system-derived",
      text: "lint passed",
    },
    {
      taskId: "task-b",
      kind: "recording",
      evidenceId: "ev_recording",
      label: "Checkout recording",
      confidence: "ai-claim",
      href: "https://example.test/recording.webm",
      capturedAt: "2026-05-17T01:00:00.000Z",
    },
    {
      taskId: "task-b",
      kind: "playwright",
      evidenceId: "ev_trace",
      label: "Trace zip",
      confidence: "ai-claim",
      href: "https://example.test/trace.zip",
    },
    {
      taskId: "task-c",
      kind: "validation",
      evidenceId: "ev_validation",
      label: "Manual validation",
      confidence: "ai-claim",
      href: "https://example.test/validation",
      text: "operator checked acceptance criteria",
    },
  ],
  byTask: {},
  missing: [],
  ...over,
});

describe("EvidenceTab", () => {
  it("groups entries by task and kind", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    const taskA = screen.getByTestId("evidence-task-task-a");
    expect(taskA).toBeInTheDocument();
    expect(within(taskA).getByText("Screenshots")).toBeInTheDocument();
    expect(within(taskA).getByText("Commands")).toBeInTheDocument();
    expect(within(taskA).getByText("Login screenshot")).toBeInTheDocument();
    expect(within(taskA).getByText("pnpm lint")).toBeInTheDocument();

    const taskB = screen.getByTestId("evidence-task-task-b");
    expect(within(taskB).getByText("Recordings")).toBeInTheDocument();
    expect(within(taskB).getByText("Playwright")).toBeInTheDocument();
  });

  it("renders <img> for screenshot entries with the orchestrator file URL", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Login screenshot" }),
    ).toHaveAttribute(
      "src",
      "http://127.0.0.1:4738/api/work-items/wi_01/evidence/file?runId=run-1&path=screenshots%2Flogin.png",
    );
  });

  it("renders <a> for recordings / playwright", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Checkout recording" }),
    ).toHaveAttribute("href", "https://example.test/recording.webm");
    expect(
      screen.getByRole("link", { name: "Open Playwright trace" }),
    ).toHaveAttribute("href", "https://example.test/trace.zip");
    expect(
      screen.getByText("Open locally with `npx playwright show-trace`."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Captured at 2026-05-17T01:00:00.000Z"),
    ).toBeInTheDocument();
  });

  it("filters by kind via the top selector", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Commands" }));

    expect(screen.getByText("pnpm lint")).toBeInTheDocument();
    expect(screen.queryByText("Login screenshot")).not.toBeInTheDocument();
    expect(screen.queryByText("Checkout recording")).not.toBeInTheDocument();
  });

  it("calls onConfirm and optimistically renders the pill as human-confirmed", async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );

    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={onConfirm}
      />,
    );

    const item = screen.getByText("Login screenshot").closest("li");
    fireEvent.click(within(item!).getByRole("button", { name: "Confirm" }));

    expect(onConfirm).toHaveBeenCalledWith("task-a", "ev_screenshot");
    expect(within(item!).getByText("Human confirmed")).toBeInTheDocument();
    expect(
      within(item!).getByRole("button", { name: "Confirmed" }),
    ).toBeDisabled();

    resolveConfirm();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it("rolls back optimistic pill change when onConfirm rejects", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("nope"));

    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={onConfirm}
      />,
    );

    const item = screen.getByText("Login screenshot").closest("li");
    fireEvent.click(within(item!).getByRole("button", { name: "Confirm" }));

    expect(within(item!).getByText("Human confirmed")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(item!).getByText("AI inferred")).toBeInTheDocument(),
    );
    expect(
      within(item!).getByRole("button", { name: "Confirm" }),
    ).toBeEnabled();
  });

  it("renders missing-evidence card for tasks in evidence.missing", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence({
          missing: [{ taskId: "task-missing", reason: "no-run-report" }],
        })}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Missing evidence — task task-missing has a TaskRunLink but no report",
      ),
    ).toBeInTheDocument();
  });
});
