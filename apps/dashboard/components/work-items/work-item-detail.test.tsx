// @vitest-environment jsdom
import type { WorkItemDetailResponse } from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

vi.mock("../../lib/api", () => ({
  acceptWorkItemPlan: vi.fn(),
  regenerateWorkItemPlan: vi.fn(),
  skipWorkItemTask: vi.fn(),
  retryWorkItemTask: vi.fn(),
  getWorkItem: vi.fn(),
}));

import {
  acceptWorkItemPlan,
  getWorkItem,
  regenerateWorkItemPlan,
  retryWorkItemTask,
  skipWorkItemTask,
} from "../../lib/api";
import { WorkItemDetail } from "./work-item-detail";

const draftDetail = (): WorkItemDetailResponse => ({
  workItem: {
    workItemId: "wi_1",
    sourceIssue: {
      projectId: "g/p",
      iid: 42,
      url: "https://gl/-/issues/42",
      title: "Big",
    },
    title: "Big",
    goal: "Ship",
    acceptanceCriteria: ["AC1"],
    status: "planning",
    taskIds: ["T1"],
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  },
  plan: {
    current: {
      planId: "p1",
      workItemId: "wi_1",
      version: 1,
      status: "draft",
      tasks: [
        {
          taskId: "T1",
          title: "T1 Title",
          goal: "T1 Goal",
          scope: "T1 Scope",
          dependsOn: [],
          suggestedValidation: ["pnpm test"],
          status: "ready",
          runIds: [],
          riskLevel: "medium",
        },
      ],
      dependencies: [],
      operatorEdits: [],
    },
    history: [],
  },
  tasks: [],
  runLinks: [],
  report: undefined,
});

const acceptedDetail = (): WorkItemDetailResponse => {
  const d = draftDetail();
  return {
    ...d,
    workItem: { ...d.workItem, status: "ready" },
    plan: {
      current: { ...d.plan.current, status: "accepted" },
      history: [d.plan.current],
    },
    tasks: d.plan.current.tasks,
    runLinks: [],
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorkItemDetail", () => {
  it("shows plan editor with Accept / Regenerate when plan is draft and hides task list", () => {
    render(<WorkItemDetail initial={draftDetail()} operator="alice" />);
    expect(screen.getByRole("button", { name: "Accept plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
    expect(screen.queryByText("T1 Title")).toBeInTheDocument();
    // task list (groups) hidden until accepted
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
  });

  it("shows task list when plan is accepted", () => {
    render(<WorkItemDetail initial={acceptedDetail()} operator="alice" />);
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    // Title appears both in plan editor and task list
    expect(screen.getAllByText("T1 Title").length).toBeGreaterThanOrEqual(1);
  });

  it("calls acceptWorkItemPlan with edits + reloads on Accept", async () => {
    vi.mocked(acceptWorkItemPlan).mockResolvedValue({
      workItem: { ...draftDetail().workItem, status: "ready" },
      plan: { ...draftDetail().plan.current, status: "accepted" },
    });
    vi.mocked(getWorkItem).mockResolvedValue(acceptedDetail());

    render(<WorkItemDetail initial={draftDetail()} operator="alice" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    fireEvent.change(titleInput, { target: { value: "Updated title" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept plan" }));

    await waitFor(() => expect(acceptWorkItemPlan).toHaveBeenCalledTimes(1));
    const [id, body, opts] = vi.mocked(acceptWorkItemPlan).mock.calls[0]!;
    expect(id).toBe("wi_1");
    expect(body.planId).toBe("p1");
    expect(body.operator).toBe("alice");
    expect(body.edits).toEqual([
      { taskId: "T1", field: "title", after: "Updated title" },
    ]);
    expect(opts).toEqual({ operator: "alice" });

    await waitFor(() => expect(getWorkItem).toHaveBeenCalledWith("wi_1"));
  });

  it("invokes regenerateWorkItemPlan with operator and reloads", async () => {
    vi.mocked(regenerateWorkItemPlan).mockResolvedValue({
      workItem: draftDetail().workItem,
      plan: draftDetail().plan.current,
    });
    vi.mocked(getWorkItem).mockResolvedValue(draftDetail());

    render(<WorkItemDetail initial={draftDetail()} operator="alice" />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(regenerateWorkItemPlan).toHaveBeenCalledWith("wi_1", {
        operator: "alice",
      }),
    );
    await waitFor(() => expect(getWorkItem).toHaveBeenCalledWith("wi_1"));
  });

  it("invokes skipWorkItemTask / retryWorkItemTask from task list", async () => {
    vi.mocked(skipWorkItemTask).mockResolvedValue({ ok: true });
    vi.mocked(retryWorkItemTask).mockResolvedValue({ ok: true });
    vi.mocked(getWorkItem).mockResolvedValue(acceptedDetail());

    const detail = acceptedDetail();
    detail.tasks = [
      {
        taskId: "T1",
        title: "T1 Title",
        goal: "g",
        scope: "s",
        dependsOn: [],
        suggestedValidation: [],
        status: "failed",
        runIds: [],
        riskLevel: "medium",
      },
    ];
    render(<WorkItemDetail initial={detail} operator="bob" />);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(retryWorkItemTask).toHaveBeenCalledWith("wi_1", "T1", {
        operator: "bob",
      }),
    );
  });
});
