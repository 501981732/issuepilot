// @vitest-environment jsdom
import type { TaskNode, TaskRunLink } from "@issuepilot/shared-contracts";
import { fireEvent, screen } from "@testing-library/react";
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
