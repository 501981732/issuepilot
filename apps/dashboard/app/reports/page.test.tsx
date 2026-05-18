// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "../../i18n/messages/en.json";
import { PROJECT_COOKIE_KEY } from "../../lib/active-project-cookie";
import { getQualitySummary, listReports } from "../../lib/api";
import { renderWithIntl as render } from "../../test/intl";

import ReportsRoute from "./page";

vi.mock("../../lib/api", () => ({
  getQualitySummary: vi.fn(),
  listReports: vi.fn(),
}));

const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (key: string) => {
      const value = cookieStore.get(key);
      return value === undefined ? undefined : { name: key, value };
    },
  }),
}));

vi.mock("next-intl/server", async () => {
  const { Fragment } = await import("react");
  function makeTranslator(namespace?: string) {
    const t = (key: string) => (namespace ? `${namespace}.${key}` : key);
    return Object.assign(t, { rich: t });
  }
  return {
    getTranslations: async (namespace?: string) => makeTranslator(namespace),
    getLocale: async () => "en",
    getMessages: async () => enMessages,
    Fragment,
  };
});

vi.mock("../../components/reports/reports-page", () => ({
  ReportsPage: ({
    reports,
    quality,
  }: {
    reports: unknown[];
    quality: { filters: Record<string, unknown> };
  }) => (
    <div data-testid="reports-page">
      {reports.length}:{String(quality.filters.pattern ?? "")}
    </div>
  ),
}));

function qualitySummary() {
  return {
    scope: { mode: "single-project" as const },
    filters: {
      from: "2026-05-11T00:00:00.000Z",
      to: "2026-05-18T00:00:00.000Z",
      window: "7d" as const,
    },
    metrics: [],
    trends: [],
    failurePatterns: [],
    drilldown: [],
    dimensions: [],
    diagnostics: { invalidReportCount: 0 },
  };
}

describe("ReportsRoute", () => {
  beforeEach(() => {
    cookieStore.clear();
    vi.mocked(listReports).mockReset();
    vi.mocked(getQualitySummary).mockReset();
    vi.mocked(listReports).mockResolvedValue({ reports: [] });
    vi.mocked(getQualitySummary).mockResolvedValue(qualitySummary());
  });

  it("passes project cookie and URL filters to reports and quality APIs", async () => {
    cookieStore.set(PROJECT_COOKIE_KEY, "platform-web");

    const page = await ReportsRoute({
      searchParams: Promise.resolve({
        pattern: "permission-issue",
        status: "run-failed",
        window: "30d",
        workflow: "default-web",
        taskType: "frontend",
      }),
    });
    render(page);

    expect(listReports).toHaveBeenCalledWith({ project: "platform-web" });
    expect(getQualitySummary).toHaveBeenCalledWith(
      {
        pattern: "permission-issue",
        status: "run-failed",
        window: "30d",
        workflow: "default-web",
        taskType: "frontend",
      },
      { project: "platform-web" },
    );
    expect(screen.getByTestId("reports-page")).toBeInTheDocument();
  });
});
