// @vitest-environment jsdom
import type { TaskNode, TaskRunLink } from "@issuepilot/shared-contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { TaskList } from "./task-list";

const baseTask = (over: Partial<TaskNode>): TaskNode => ({
  taskId: "t1",
  title: "T1",
  goal: "g",
  scope: "s",
  dependsOn: [],
  suggestedValidation: [],
  status: "ready",
  runIds: [],
  riskLevel: "medium",
  ...over,
});

describe("TaskList", () => {
  it("groups tasks by their effective status", () => {
    const tasks: TaskNode[] = [
      baseTask({ taskId: "t1", title: "Ready 1", status: "ready" }),
      baseTask({ taskId: "t2", title: "Done 1", status: "completed" }),
      baseTask({ taskId: "t3", title: "Failed 1", status: "failed" }),
    ];
    render(<TaskList tasks={tasks} />);
    expect(screen.getByText("Ready 1")).toBeInTheDocument();
    expect(screen.getByText("Done 1")).toBeInTheDocument();
    expect(screen.getByText("Failed 1")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("shows Retry on failed task and Skip on ready task; calls handlers", () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    const tasks: TaskNode[] = [
      baseTask({ taskId: "ready1", title: "Ready X", status: "ready" }),
      baseTask({ taskId: "fail1", title: "Failed X", status: "failed" }),
    ];
    render(<TaskList tasks={tasks} onRetry={onRetry} onSkip={onSkip} />);

    fireEvent.click(screen.getAllByRole("button", { name: /Retry/ })[0]!);
    expect(onRetry).toHaveBeenCalledWith("fail1");

    fireEvent.click(screen.getAllByRole("button", { name: /^Skip$/ })[0]!);
    expect(onSkip).toHaveBeenCalledWith("ready1");
  });

  it("V4.2: shows Replan on every task status", () => {
    const onReplan = vi.fn(async () => {});
    const tasks: TaskNode[] = [
      baseTask({ taskId: "ready1", status: "ready" }),
      baseTask({ taskId: "running1", status: "running" }),
      baseTask({ taskId: "done1", status: "completed" }),
      baseTask({ taskId: "fail1", status: "failed" }),
      baseTask({ taskId: "rework1", status: "needs_rework" }),
      baseTask({ taskId: "skip1", status: "skipped" }),
    ];
    render(<TaskList tasks={tasks} onReplan={onReplan} />);
    expect(screen.getAllByRole("button", { name: /Replan/ }).length).toBe(6);
  });

  it("V4.2: shows Mark rework on completed/failed/blocked tasks only", () => {
    const onMarkRework = vi.fn(async () => {});
    const tasks: TaskNode[] = [
      baseTask({ taskId: "done1", status: "completed", title: "Done" }),
      baseTask({ taskId: "fail1", status: "failed", title: "Fail" }),
      baseTask({ taskId: "block1", status: "blocked", title: "Block" }),
      baseTask({ taskId: "ready1", status: "ready", title: "Ready" }),
      baseTask({ taskId: "running1", status: "running", title: "Running" }),
    ];
    render(<TaskList tasks={tasks} onMarkRework={onMarkRework} />);
    const buttons = screen.getAllByRole("button", { name: /Mark for rework/ });
    expect(buttons.length).toBe(3);
  });

  it("V4.2: shows Unskip only on skipped tasks and triggers callback", () => {
    const onUnskip = vi.fn(async () => {});
    const tasks: TaskNode[] = [
      baseTask({ taskId: "skip1", status: "skipped", title: "Skipped one" }),
      baseTask({ taskId: "done1", status: "completed", title: "Done" }),
    ];
    render(<TaskList tasks={tasks} onUnskip={onUnskip} />);
    const unskipButtons = screen.getAllByRole("button", {
      name: /Cancel skip/,
    });
    expect(unskipButtons.length).toBe(1);
    fireEvent.click(unskipButtons[0]!);
    expect(onUnskip).toHaveBeenCalledWith("skip1");
  });

  it("V4.2: hides Skip on completed/running/failed/blocked/needs_rework/skipped", () => {
    const onSkip = vi.fn();
    const tasks: TaskNode[] = [
      baseTask({ taskId: "done1", status: "completed", title: "Done" }),
      baseTask({ taskId: "running1", status: "running", title: "Running" }),
      baseTask({ taskId: "fail1", status: "failed", title: "Failed" }),
      baseTask({ taskId: "block1", status: "blocked", title: "Blocked" }),
      baseTask({
        taskId: "rework1",
        status: "needs_rework",
        title: "Rework",
      }),
      baseTask({ taskId: "skip1", status: "skipped", title: "Skipped" }),
    ];
    render(<TaskList tasks={tasks} onSkip={onSkip} />);
    expect(screen.queryAllByRole("button", { name: /^Skip$/ })).toHaveLength(
      0,
    );
  });

  it("V4.2: replan button on a completed task opens dialog and submits", async () => {
    const onReplan = vi.fn(async () => {});
    const tasks: TaskNode[] = [
      baseTask({ taskId: "done1", status: "completed", title: "Done" }),
    ];
    render(<TaskList tasks={tasks} onReplan={onReplan} />);
    fireEvent.click(screen.getByRole("button", { name: /Replan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "Need to split" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Replan/ }));
    // Wait a tick for the async submit to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(onReplan).toHaveBeenCalledWith("done1", {
      reason: "Need to split",
    });
  });

  it("disables actions when actionsEnabled is false (e.g. plan still draft)", () => {
    const tasks: TaskNode[] = [
      baseTask({ taskId: "fail1", title: "Failed X", status: "failed" }),
    ];
    render(<TaskList tasks={tasks} onRetry={vi.fn()} actionsEnabled={false} />);
    const btn = screen.getByRole("button", { name: /Retry/ });
    expect(btn).toBeDisabled();
  });

  it("uses the run link's status (and shows MR link) when present", () => {
    const tasks: TaskNode[] = [baseTask({ taskId: "t1", status: "ready" })];
    const links: TaskRunLink[] = [
      {
        taskId: "t1",
        runId: "run_1",
        attempt: 1,
        status: "running",
        branch: "ai/wi/p/iid/T1/v1",
        mergeRequest: { iid: 7, url: "https://gl/-/mr/7", state: "opened" },
        startedAt: "2026-05-17T00:00:00.000Z",
      },
    ];
    render(<TaskList tasks={tasks} runLinks={links} />);
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /MR !7/ })).toHaveAttribute(
      "href",
      "https://gl/-/mr/7",
    );
  });
});
