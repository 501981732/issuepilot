// @vitest-environment jsdom
import type {
  FailurePatternSummary,
  QualityDrilldownItem,
  QualityMetric,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { QualityAnalytics } from "./quality-analytics";

const navigationMocks = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/reports",
  useRouter: () => navigationMocks,
}));

function metric(
  over: Partial<QualityMetric> & Pick<QualityMetric, "id">,
): QualityMetric {
  return {
    id: over.id,
    label: over.label ?? over.id,
    value: over.value ?? 0,
    unit: over.unit ?? "percent",
    direction: over.direction ?? "unknown",
    numerator: over.numerator,
    denominator: over.denominator,
    unknownCount: over.unknownCount,
    delta: over.delta,
    previousValue: over.previousValue,
  };
}

function patternSummary(
  over: Partial<FailurePatternSummary> &
    Pick<FailurePatternSummary, "patternId">,
): FailurePatternSummary {
  return {
    patternId: over.patternId,
    label: over.label ?? over.patternId,
    count: over.count ?? 1,
    rate: over.rate ?? 50,
    drilldownCount: over.drilldownCount ?? 1,
    topProject: over.topProject,
    topWorkflow: over.topWorkflow,
    latestReason: over.latestReason,
  };
}

function drilldown(
  over: Partial<QualityDrilldownItem> & Pick<QualityDrilldownItem, "itemId">,
): QualityDrilldownItem {
  return {
    itemId: over.itemId,
    patternIds: over.patternIds ?? [],
    reason: over.reason ?? "reason",
    projectId: over.projectId ?? "proj-a",
    updatedAt: over.updatedAt ?? "2026-05-18T00:00:00.000Z",
    target: over.target ?? { kind: "run", href: "/runs/run-1" },
    workflow: over.workflow,
    taskType: over.taskType,
    issue: over.issue,
    workItem: over.workItem,
    task: over.task,
    run: over.run,
    evidenceId: over.evidenceId,
  };
}

function qualitySummaryFixture(
  over: Partial<QualitySummaryResponse> = {},
): QualitySummaryResponse {
  return {
    scope: { mode: "single-project" },
    filters: {
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-18T00:00:00.000Z",
      window: "7d",
    },
    metrics: [
      metric({
        id: "success-rate",
        label: "Success",
        value: 50,
        numerator: 1,
        denominator: 2,
      }),
      metric({
        id: "failure-rate",
        label: "Failure",
        value: 50,
        numerator: 1,
        denominator: 2,
      }),
    ],
    trends: [
      {
        metricId: "success-rate",
        bucketStart: "2026-05-11T00:00:00.000Z",
        bucketEnd: "2026-05-12T00:00:00.000Z",
        value: 0,
        numerator: 0,
        denominator: 0,
      },
    ],
    failurePatterns: [
      patternSummary({
        patternId: "permission-issue",
        label: "Permission",
        count: 2,
        rate: 67,
        latestReason: "401 unauthorized",
      }),
    ],
    drilldown: [
      drilldown({
        itemId: "run:run-1",
        patternIds: ["permission-issue"],
        reason: "401 unauthorized",
        run: { runId: "run-1", status: "failed" },
        target: { kind: "run", href: "/runs/run-1" },
      }),
    ],
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
    ...over,
  };
}

describe("QualityAnalytics", () => {
  beforeEach(() => {
    navigationMocks.replace.mockClear();
    navigationMocks.refresh.mockClear();
    window.history.replaceState(null, "", "/reports");
  });

  it("renders quality summary metrics", () => {
    render(<QualityAnalytics summary={qualitySummaryFixture()} />);
    expect(screen.getByText(/Quality Analytics/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Success/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Failure/i).length).toBeGreaterThan(0);
  });

  it("renders pattern list with counts", () => {
    render(<QualityAnalytics summary={qualitySummaryFixture()} />);
    expect(
      screen.getByRole("button", { name: /Permission/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 · 67%/)).toBeInTheDocument();
  });

  it("filters drilldown when a pattern button is clicked and writes URL", () => {
    render(
      <QualityAnalytics
        summary={qualitySummaryFixture({
          drilldown: [
            drilldown({
              itemId: "run:run-1",
              patternIds: ["permission-issue"],
              target: { kind: "run", href: "/runs/run-1" },
            }),
            drilldown({
              itemId: "run:run-2",
              patternIds: ["ci-failure"],
              target: { kind: "run", href: "/runs/run-2" },
            }),
          ],
        })}
      />,
    );

    expect(screen.getAllByRole("link", { name: /open source/i })).toHaveLength(
      2,
    );
    fireEvent.click(screen.getByRole("button", { name: /Permission/i }));
    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/reports?pattern=permission-issue",
      { scroll: false },
    );
    expect(navigationMocks.refresh).toHaveBeenCalled();
  });

  it("routes filter changes through URL query so SSR fetches filtered data", () => {
    render(
      <QualityAnalytics
        summary={qualitySummaryFixture({
          dimensions: [
            {
              kind: "workflow",
              value: "default-web",
              label: "default-web",
              count: 3,
            },
          ],
        })}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Workflow/i), {
      target: { value: "default-web" },
    });

    expect(navigationMocks.replace).toHaveBeenCalledWith(
      "/reports?workflow=default-web",
      { scroll: false },
    );
  });

  it("links drilldown rows to their target href", () => {
    render(<QualityAnalytics summary={qualitySummaryFixture()} />);
    const link = screen.getByRole("link", { name: /open source/i });
    expect(link).toHaveAttribute("href", "/runs/run-1");
  });

  it("renders an empty state when no metric data exists", () => {
    render(
      <QualityAnalytics
        summary={qualitySummaryFixture({
          metrics: [
            metric({
              id: "success-rate",
              denominator: 0,
              numerator: 0,
              value: 0,
            }),
          ],
          failurePatterns: [],
          drilldown: [],
        })}
      />,
    );
    expect(screen.getByText(/No quality data yet/i)).toBeInTheDocument();
  });

  it("renders diagnostics when invalid reports exist", () => {
    render(
      <QualityAnalytics
        summary={qualitySummaryFixture({
          diagnostics: { invalidReportCount: 3 },
        })}
      />,
    );
    expect(screen.getByText(/3 invalid reports skipped/i)).toBeInTheDocument();
  });
});
