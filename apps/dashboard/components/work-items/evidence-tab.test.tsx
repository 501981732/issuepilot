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
      source: { runId: "run-1", relPath: "commands/lint.log" },
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

  it("appends the project query to browser-loaded evidence file URLs", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        project="platform-web"
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Login screenshot" }),
    ).toHaveAttribute(
      "src",
      "http://127.0.0.1:4738/api/work-items/wi_01/evidence/file?runId=run-1&path=screenshots%2Flogin.png&project=platform-web",
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

  it("keeps the pill in its server confidence while confirm is in flight, then turns it human-confirmed when it resolves", async () => {
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
    // V4.3 UX: pill 不抢跑，与按钮共享 in-flight 状态。
    expect(within(item!).getByText("AI inferred")).toBeInTheDocument();
    expect(
      within(item!).getByRole("button", { name: "Confirming…" }),
    ).toBeDisabled();

    resolveConfirm();
    await waitFor(() =>
      expect(within(item!).getByText("Human confirmed")).toBeInTheDocument(),
    );
    expect(
      within(item!).getByRole("button", { name: "Confirmed" }),
    ).toBeDisabled();
  });

  it("does not flip the pill when onConfirm rejects", async () => {
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

    // pill 在 in-flight 与 reject 之后都保持原 confidence。
    expect(within(item!).getByText("AI inferred")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(item!).getByRole("button", { name: "Confirm" }),
      ).toBeEnabled(),
    );
    expect(within(item!).getByText("AI inferred")).toBeInTheDocument();
  });

  it("settles each confirm independently when concurrent attempts mix success and failure", async () => {
    let rejectScreenshot: (error: Error) => void = () => {};
    let resolveCommand: () => void = () => {};
    const onConfirm = vi.fn((taskId: string, evidenceId: string) => {
      if (evidenceId === "ev_screenshot") {
        return new Promise<void>((_, reject) => {
          rejectScreenshot = reject;
        });
      }
      if (evidenceId === "ev_command") {
        return new Promise<void>((resolve) => {
          resolveCommand = resolve;
        });
      }
      return Promise.resolve();
    });

    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={onConfirm}
      />,
    );

    const screenshotItem = screen.getByText("Login screenshot").closest("li");
    const commandItem = screen.getByText("pnpm lint").closest("li");
    fireEvent.click(
      within(screenshotItem!).getByRole("button", { name: "Confirm" }),
    );
    fireEvent.click(
      within(commandItem!).getByRole("button", { name: "Confirm" }),
    );

    // 两个都还在 in-flight：pill 不抢跑，仍是 server confidence。
    expect(within(screenshotItem!).getByText("AI inferred")).toBeInTheDocument();
    expect(within(commandItem!).getByText("System derived")).toBeInTheDocument();

    rejectScreenshot(new Error("nope"));
    await waitFor(() =>
      expect(
        within(screenshotItem!).getByRole("button", { name: "Confirm" }),
      ).toBeEnabled(),
    );
    expect(within(screenshotItem!).getByText("AI inferred")).toBeInTheDocument();

    resolveCommand();
    await waitFor(() =>
      expect(
        within(commandItem!).getByText("Human confirmed"),
      ).toBeInTheDocument(),
    );
    expect(
      within(commandItem!).getByRole("button", { name: "Confirmed" }),
    ).toBeDisabled();
  });

  it("treats human-confirmed prop updates as confirmed state", () => {
    const { rerender } = render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    rerender(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence({
          index: [
            {
              ...baseEvidence().index[0]!,
              confidence: "human-confirmed",
            },
          ],
        })}
        onConfirm={vi.fn()}
      />,
    );

    const item = screen.getByText("Login screenshot").closest("li");
    expect(within(item!).getByText("Human confirmed")).toBeInTheDocument();
    expect(
      within(item!).getByRole("button", { name: "Confirmed" }),
    ).toBeDisabled();
  });

  it("renders file links for non-media entries with source relPath", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "pnpm lint" })).toHaveAttribute(
      "href",
      "http://127.0.0.1:4738/api/work-items/wi_01/evidence/file?runId=run-1&path=commands%2Flint.log",
    );
  });

  it("appends the project query to non-media file-backed evidence links", () => {
    render(
      <EvidenceTab
        workItemId="wi_01"
        evidence={baseEvidence()}
        project="platform-web"
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: "pnpm lint" })).toHaveAttribute(
      "href",
      "http://127.0.0.1:4738/api/work-items/wi_01/evidence/file?runId=run-1&path=commands%2Flint.log&project=platform-web",
    );
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
