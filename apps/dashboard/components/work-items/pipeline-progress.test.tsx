// @vitest-environment jsdom
import type {
  AgentReportSummary,
  PipelineRun,
} from "@issuepilot/shared-contracts";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { PipelineProgress } from "./pipeline-progress";

function pipelineRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    pipelineRunId: "p1",
    workItemId: "wi1",
    taskId: "t1",
    recipe: "full_pipeline",
    recipeSource: "workflow_default",
    status: "running_coding",
    currentRole: "coder",
    agentReportIds: { coder: null, reviewer: null, test_evidence: null },
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...over,
  } as PipelineRun;
}

function reportSummary(
  over: Partial<AgentReportSummary>,
): AgentReportSummary {
  return {
    agentReportId: "ar1",
    pipelineRunId: "p1",
    taskId: "t1",
    role: "coder",
    status: "complete",
    startedAt: "2026-05-19T00:00:00.000Z",
    completedAt: "2026-05-19T00:00:10.000Z",
    ...over,
  } as AgentReportSummary;
}

describe("PipelineProgress (V4.6)", () => {
  it("renders empty state when no PipelineRun exists", () => {
    render(<PipelineProgress pipelineRun={null} />);
    const section = screen.getByRole("region", {
      name: /pipeline progress/i,
    });
    expect(section.getAttribute("data-state")).toBe("empty");
  });

  it("renders three role steps in the canonical order", () => {
    render(<PipelineProgress pipelineRun={pipelineRun()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.getAttribute("data-role")).toBe("coder");
    expect(items[1]?.getAttribute("data-role")).toBe("reviewer");
    expect(items[2]?.getAttribute("data-role")).toBe("test_evidence");
  });

  it("marks current role as running and others as pending when full pipeline starts", () => {
    render(<PipelineProgress pipelineRun={pipelineRun()} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("running");
    expect(items[1]?.getAttribute("data-state")).toBe("pending");
    expect(items[2]?.getAttribute("data-state")).toBe("pending");
  });

  it("greys reviewer + test_evidence when recipe is coding_only", () => {
    render(
      <PipelineProgress
        pipelineRun={pipelineRun({ recipe: "coding_only" })}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[1]?.getAttribute("data-state")).toBe("skipped_by_recipe");
    expect(items[2]?.getAttribute("data-state")).toBe("skipped_by_recipe");
  });

  it("greys test_evidence only when recipe is coding_plus_reviewer", () => {
    render(
      <PipelineProgress
        pipelineRun={pipelineRun({
          recipe: "coding_plus_reviewer",
          currentRole: "reviewer",
          status: "running_reviewer",
        })}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("pending");
    expect(items[1]?.getAttribute("data-state")).toBe("running");
    expect(items[2]?.getAttribute("data-state")).toBe("skipped_by_recipe");
  });

  it("reflects reports states (complete coder + running reviewer)", () => {
    render(
      <PipelineProgress
        pipelineRun={pipelineRun({
          currentRole: "reviewer",
          status: "running_reviewer",
        })}
        agentReports={[
          reportSummary({ role: "coder", status: "complete" }),
          reportSummary({
            agentReportId: "ar2",
            role: "reviewer",
            status: "running",
          }),
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.getAttribute("data-state")).toBe("complete");
    expect(items[1]?.getAttribute("data-state")).toBe("running");
  });

  it("shows pending recipe badge when pendingRecipe is supplied", () => {
    render(
      <PipelineProgress
        pipelineRun={pipelineRun()}
        pendingRecipe="coding_only"
      />,
    );
    expect(
      screen.getByText(/Pending recipe: Coder only/i),
    ).toBeInTheDocument();
  });

  it("excludes superseded reports from the role state lookup", () => {
    render(
      <PipelineProgress
        pipelineRun={pipelineRun({ currentRole: null })}
        agentReports={[
          reportSummary({
            role: "coder",
            status: "failed",
            supersededBy: "ar2",
          }),
        ]}
      />,
    );
    const coderItem = screen.getAllByRole("listitem")[0];
    expect(coderItem?.getAttribute("data-state")).toBe("pending");
  });

  it("renders i18n role labels for coder / reviewer / test_evidence", () => {
    render(<PipelineProgress pipelineRun={pipelineRun()} />);
    const list = screen.getByRole("list");
    expect(within(list).getByText("Coder")).toBeInTheDocument();
    expect(within(list).getByText("Reviewer")).toBeInTheDocument();
    expect(within(list).getByText("Test/Evidence")).toBeInTheDocument();
  });
});
