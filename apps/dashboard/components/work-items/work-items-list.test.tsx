// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { WorkItemsList } from "./work-items-list";

describe("WorkItemsList", () => {
  const counters = {
    planning: 0,
    ready: 1,
    running: 2,
    partial: 0,
    completed: 3,
    blocked: 0,
  } as const;

  it("renders counters and rows for each work item", () => {
    render(
      <WorkItemsList
        counters={counters}
        workItems={[
          {
            workItemId: "wi_01",
            sourceIssue: {
              projectId: "g/p",
              iid: 42,
              url: "https://gl/-/issues/42",
              title: "Big",
            },
            title: "Big",
            goal: "Ship",
            acceptanceCriteria: ["AC1"],
            status: "ready",
            taskIds: ["t1", "t2"],
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Work Items", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Big")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("ready")).toBeInTheDocument();
    // counter values
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders the empty state when there are no work items", () => {
    render(<WorkItemsList counters={counters} workItems={[]} />);
    expect(screen.getByText(/No work items yet/i)).toBeInTheDocument();
  });
});
