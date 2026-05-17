// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("../../lib/api", () => ({
  getState: vi.fn(),
  setActiveWorkItemsProject: vi.fn(),
}));

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeAll(() => installMatchMedia());

import { getState } from "../../lib/api";

import { TopBar } from "./top-bar";

beforeEach(() => {
  installMatchMedia();
  if (typeof window !== "undefined") window.localStorage.clear();
  vi.mocked(getState).mockResolvedValue({
    service: {
      status: "ready",
      workflowPath: "wf",
      gitlabProject: "g/p",
      pollIntervalMs: 1000,
      concurrency: 1,
      lastConfigReloadAt: null,
      lastPollAt: null,
    },
    summary: {
      claimed: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
    },
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar", () => {
  it("renders Work Items nav entry pointing to /work-items", () => {
    render(<TopBar />);
    const link = screen.getByRole("link", { name: "Work Items" });
    expect(link).toHaveAttribute("href", "/work-items");
  });

  it("includes Command Center and Reports nav entries", () => {
    render(<TopBar />);
    const reports = screen.getByRole("link", { name: "Reports" });
    expect(reports).toHaveAttribute("href", "/reports");
    const commandCenterLinks = screen.getAllByRole("link", {
      name: "Command Center",
    });
    expect(commandCenterLinks.length).toBeGreaterThanOrEqual(1);
    expect(commandCenterLinks.some((l) => l.getAttribute("href") === "/")).toBe(
      true,
    );
  });

  it("V4.2: hides ProjectSwitcher in single-mode", async () => {
    render(<TopBar />);
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("V4.2: shows ProjectSwitcher with enabled projects in team-mode", async () => {
    vi.mocked(getState).mockResolvedValue({
      service: {
        status: "ready",
        workflowPath: "wf",
        gitlabProject: "team",
        pollIntervalMs: 1000,
        concurrency: 2,
        lastConfigReloadAt: null,
        lastPollAt: null,
      },
      summary: {
        claimed: 0,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
      },
      runtime: {
        mode: "team",
        maxConcurrentRuns: 2,
        activeLeases: 0,
        projectCount: 1,
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/cfg/platform-web.yaml",
          profilePath: "/cfg/default-web.md",
          effectiveWorkflowPath:
            "/cfg/.generated/platform-web.workflow.md",
          gitlabProject: "group/platform-web",
          enabled: true,
          activeRuns: 0,
          lastPollAt: null,
        },
      ],
    } as never);
    render(<TopBar />);
    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeNull();
    });
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(
      Array.from(select.querySelectorAll("option"))
        .map((o) => o.value)
        .filter(Boolean),
    ).toEqual(["platform-web"]);
  });
});
