// @vitest-environment jsdom
import type {
  TaskNode,
  WorkItemGraphResponse,
} from "@issuepilot/shared-contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { TaskGraph } from "./task-graph";

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

function makeFixture(): { tasks: TaskNode[]; graph: WorkItemGraphResponse } {
  return {
    tasks: [
      baseTask({ taskId: "t1", title: "Plan", status: "completed" }),
      baseTask({
        taskId: "t2",
        title: "Implement",
        status: "running",
        dependsOn: ["t1"],
      }),
      baseTask({
        taskId: "t3",
        title: "Test",
        status: "blocked_by_dependency",
        dependsOn: ["t2"],
      }),
    ],
    graph: {
      levels: [["t1"], ["t2"], ["t3"]],
      edges: [
        { from: "t1", to: "t2" },
        { from: "t2", to: "t3" },
      ],
      criticalPathTaskIds: ["t1", "t2", "t3"],
    },
  };
}

describe("TaskGraph", () => {
  it("renders one node per task with a status badge", () => {
    const { tasks, graph } = makeFixture();
    render(<TaskGraph graph={graph} tasks={tasks} />);
    expect(screen.getByTestId("task-graph-node-t1")).toBeInTheDocument();
    expect(screen.getByTestId("task-graph-node-t2")).toBeInTheDocument();
    expect(screen.getByTestId("task-graph-node-t3")).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("blocked_by_dependency")).toBeInTheDocument();
  });

  it("renders one SVG path per edge with data-from / data-to attributes", () => {
    const { tasks, graph } = makeFixture();
    const { container } = render(<TaskGraph graph={graph} tasks={tasks} />);
    const edges = container.querySelectorAll("path[data-edge]");
    expect(edges.length).toBe(2);
    const attrs = Array.from(edges).map((p) => ({
      from: p.getAttribute("data-from"),
      to: p.getAttribute("data-to"),
    }));
    expect(attrs).toEqual(
      expect.arrayContaining([
        { from: "t1", to: "t2" },
        { from: "t2", to: "t3" },
      ]),
    );
  });

  it("flags blocking edges when downstream task is blocked_by_dependency", () => {
    const { tasks, graph } = makeFixture();
    const { container } = render(<TaskGraph graph={graph} tasks={tasks} />);
    // t3 is blocked_by_dependency → the incoming edge t2→t3 carries
    // data-blocked="true" so the dashboard can style it in red dashed.
    const blocked = container.querySelector(
      'path[data-edge][data-blocked="true"]',
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.getAttribute("data-to")).toBe("t3");
  });

  it("flags nodes on the critical path", () => {
    const { tasks } = makeFixture();
    const graph: WorkItemGraphResponse = {
      levels: [["t1"], ["t2"], ["t3"]],
      edges: [
        { from: "t1", to: "t2" },
        { from: "t2", to: "t3" },
      ],
      criticalPathTaskIds: ["t1", "t2"],
    };
    render(<TaskGraph graph={graph} tasks={tasks} />);
    expect(
      screen.getByTestId("task-graph-node-t1").getAttribute("data-critical"),
    ).toBe("true");
    expect(
      screen.getByTestId("task-graph-node-t2").getAttribute("data-critical"),
    ).toBe("true");
    expect(
      screen.getByTestId("task-graph-node-t3").getAttribute("data-critical"),
    ).toBe("false");
  });

  it("renders an empty placeholder when the graph has no tasks", () => {
    const empty: WorkItemGraphResponse = {
      levels: [],
      edges: [],
      criticalPathTaskIds: [],
    };
    render(<TaskGraph graph={empty} tasks={[]} />);
    expect(screen.getByTestId("task-graph-empty")).toBeInTheDocument();
  });

  it("places each node in its level row using data-level attribute", () => {
    const { tasks, graph } = makeFixture();
    render(<TaskGraph graph={graph} tasks={tasks} />);
    expect(
      screen.getByTestId("task-graph-node-t1").getAttribute("data-level"),
    ).toBe("0");
    expect(
      screen.getByTestId("task-graph-node-t2").getAttribute("data-level"),
    ).toBe("1");
    expect(
      screen.getByTestId("task-graph-node-t3").getAttribute("data-level"),
    ).toBe("2");
  });
});
