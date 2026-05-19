// @vitest-environment jsdom
import type {
  ImprovementRecommendation,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptImprovementRecommendation,
  ApiError,
} from "../../lib/api";
import { renderWithIntl as render } from "../../test/intl";

import { ReportsPage } from "./reports-page";

vi.mock("./quality-analytics", () => ({
  QualityAnalytics: () => <section aria-label="Quality analytics" />,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/reports",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));

import type * as ApiModule from "../../lib/api";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof ApiModule>("../../lib/api");
  return {
    ...actual,
    acceptImprovementRecommendation: vi.fn(),
    deferImprovementRecommendation: vi.fn(),
    generateImprovementRecommendations: vi.fn(),
    previewImprovementPatch: vi.fn(),
    rejectImprovementRecommendation: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(acceptImprovementRecommendation).mockReset();
});

function improvement(): ImprovementRecommendation {
  return {
    recommendationId: "rec_1",
    projectId: "proj-a",
    scope: { mode: "single-project" },
    problemPattern: "missing-evidence",
    title: "Require evidence",
    summary: "Repeated missing evidence",
    target: { kind: "prompt_template", description: "Prompt template" },
    evidenceRefs: [],
    suggestedChange: "Require evidence.",
    patchPreview: {
      status: "not_generated",
      targetDescription: "Prompt template",
    },
    confidence: "high",
    risk: "low",
    status: "open",
    actionHistory: [],
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
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
    metrics: [],
    trends: [],
    failurePatterns: [],
    drilldown: [],
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
    ...over,
  };
}

describe("ReportsPage", () => {
  it("renders counters and table rows", () => {
    render(
      <ReportsPage
        reports={[
          {
            runId: "run-1",
            issueIid: 42,
            issueTitle: "Fix checkout",
            projectId: "group/project",
            status: "completed",
            labels: ["human-review"],
            attempt: 1,
            branch: "ai/42",
            mergeReadinessStatus: "ready",
            updatedAt: "2026-05-16T00:00:00.000Z",
            totalMs: 60000,
          },
          {
            runId: "run-2",
            issueIid: 43,
            issueTitle: "Refactor login",
            projectId: "group/project",
            status: "failed",
            labels: ["ai-failed"],
            attempt: 2,
            branch: "ai/43",
            mergeReadinessStatus: "blocked",
            updatedAt: "2026-05-16T00:01:00.000Z",
          },
        ]}
        quality={qualitySummaryFixture()}
        recommendations={[]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Reports" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Fix checkout")).toBeInTheDocument();
    expect(screen.getByText("Refactor login")).toBeInTheDocument();
    expect(screen.getAllByText("ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1m").length).toBeGreaterThan(0);
  });

  it("renders the quality analytics section", () => {
    render(
      <ReportsPage
        reports={[]}
        quality={qualitySummaryFixture({
          metrics: [
            {
              id: "success-rate",
              label: "Success rate",
              value: 50,
              unit: "percent",
              numerator: 1,
              denominator: 2,
              direction: "unknown",
            },
          ],
        })}
        recommendations={[]}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Quality analytics/i }),
    ).toBeInTheDocument();
  });

  it("renders an empty state when no reports exist", () => {
    render(
      <ReportsPage
        reports={[]}
        quality={qualitySummaryFixture()}
        recommendations={[]}
      />,
    );
    expect(screen.getByText(/No reports yet/i)).toBeInTheDocument();
  });

  it("renders recommendations below quality analytics", () => {
    render(
      <ReportsPage
        reports={[]}
        quality={qualitySummaryFixture()}
        recommendations={[improvement()]}
      />,
    );
    expect(
      screen.getByRole("region", { name: /Recommendations/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Require evidence").length).toBeGreaterThan(0);
  });

  it("surfaces an alert when an improvement action fails", async () => {
    vi.mocked(acceptImprovementRecommendation).mockRejectedValueOnce(
      new ApiError("POST … failed: HTTP 503", 503, {
        ok: false,
        code: "improvements_unavailable",
      }),
    );
    render(
      <ReportsPage
        reports={[]}
        quality={qualitySummaryFixture()}
        recommendations={[improvement()]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "improvements_unavailable",
      );
    });
  });
});
