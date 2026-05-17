// @vitest-environment jsdom
import type { RunRecord } from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunWithReport } from "../../lib/api";
import { renderWithIntl as render } from "../../test/intl";

vi.mock("../../lib/api", async () => {
  const actual =
    await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    planWorkItem: vi.fn(),
  };
});

import { planWorkItem } from "../../lib/api";

import { ReviewPacketInspector } from "./review-packet-inspector";

const baseRun = (over: Partial<RunRecord> = {}): RunWithReport => ({
  runId: "run_1",
  status: "completed",
  attempt: 1,
  branch: "ai/run_1",
  workspacePath: "/tmp/ws",
  startedAt: "2026-05-17T00:00:00.000Z",
  updatedAt: "2026-05-17T00:01:00.000Z",
  issue: {
    id: "issue-42",
    projectId: "g/p",
    iid: 42,
    url: "https://gl/-/issues/42",
    title: "T",
    labels: [],
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReviewPacketInspector V4.1 entry point", () => {
  it("Plan work item button calls planWorkItem(iid) and navigates to /work-items/<id>", async () => {
    vi.mocked(planWorkItem).mockResolvedValue({
      workItem: {
        workItemId: "wi_42",
        sourceIssue: {
          projectId: "g/p",
          iid: 42,
          url: "https://gl/-/issues/42",
          title: "T",
        },
        title: "T",
        goal: "g",
        acceptanceCriteria: [],
        status: "planning",
        taskIds: [],
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      },
      plan: {
        planId: "p1",
        workItemId: "wi_42",
        version: 1,
        status: "draft",
        tasks: [],
        dependencies: [],
        operatorEdits: [],
      },
    });

    // jsdom: use a setter-watching href stub so we can assert navigation
    // without triggering the real document unload error.
    let navigated: string | null = null;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        get href() {
          return navigated ?? "about:blank";
        },
        set href(v: string) {
          navigated = v;
        },
      } as unknown as Location,
    });

    render(<ReviewPacketInspector run={baseRun()} />);
    const btn = screen.getByRole("button", { name: "Plan work item" });
    fireEvent.click(btn);
    await waitFor(() => expect(planWorkItem).toHaveBeenCalledWith(42));
    await waitFor(() => expect(navigated).toBe("/work-items/wi_42"));
  });

  it("renders a link to the existing work item instead of the Plan button when run is already linked", () => {
    render(
      <ReviewPacketInspector
        run={baseRun({
          workItem: { workItemId: "wi_99", taskId: "T1" },
        })}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Plan work item" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "wi_99" })).toHaveAttribute(
      "href",
      "/work-items/wi_99",
    );
  });
});
