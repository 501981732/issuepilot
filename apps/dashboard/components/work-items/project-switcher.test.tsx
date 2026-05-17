// @vitest-environment jsdom
import type { ProjectSummary } from "@issuepilot/shared-contracts";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ProjectSwitcher } from "./project-switcher";

const projectA: ProjectSummary = {
  id: "platform-web",
  name: "Platform Web",
  projectPath: "/cfg/platform-web.yaml",
  profilePath: "/cfg/default-web.md",
  effectiveWorkflowPath: "/cfg/.generated/platform-web.workflow.md",
  gitlabProject: "group/platform-web",
  enabled: true,
  activeRuns: 0,
  lastPollAt: null,
};

const projectB: ProjectSummary = {
  id: "infra-tools",
  name: "Infra Tools",
  projectPath: "/cfg/infra-tools.yaml",
  profilePath: "/cfg/default-node-lib.md",
  effectiveWorkflowPath: "/cfg/.generated/infra-tools.workflow.md",
  gitlabProject: "group/infra-tools",
  enabled: true,
  activeRuns: 0,
  lastPollAt: null,
};

const projectDisabled: ProjectSummary = {
  ...projectB,
  id: "legacy",
  name: "Legacy",
  enabled: false,
};

function clearProjectCookie() {
  if (typeof document === "undefined") return;
  // Match the attributes used in ProjectSwitcher.writeProjectCookie so
  // the test cleanup actually removes the cookie regardless of which
  // value the previous test wrote.
  document.cookie = `issuepilot.workItems.activeProject=; path=/; max-age=0; samesite=lax`;
}

function readProjectCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("issuepilot.workItems.activeProject="));
  if (!match) return null;
  return decodeURIComponent(match.split("=", 2)[1] ?? "") || null;
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
  clearProjectCookie();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearProjectCookie();
});

describe("ProjectSwitcher", () => {
  it("renders nothing in single-mode", () => {
    const { container } = render(
      <ProjectSwitcher mode="single" projects={[projectA, projectB]} />,
    );
    expect(container.querySelector("select")).toBeNull();
  });

  it("renders an option for each enabled project in team-mode", () => {
    render(
      <ProjectSwitcher
        mode="team"
        projects={[projectA, projectB, projectDisabled]}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll("option"));
    // Only enabled projects show up (disabled ones omitted).
    const ids = options.map((o) => o.value).filter(Boolean);
    expect(ids).toEqual(["platform-web", "infra-tools"]);
  });

  it("persists selection in localStorage and calls onChange", () => {
    const onChange = vi.fn();
    render(
      <ProjectSwitcher
        mode="team"
        projects={[projectA, projectB]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "infra-tools" } });
    expect(onChange).toHaveBeenCalledWith("infra-tools");
    expect(window.localStorage.getItem("issuepilot.workItems.activeProject")).toBe(
      "infra-tools",
    );
  });

  it("hydrates initial selection from localStorage", () => {
    window.localStorage.setItem(
      "issuepilot.workItems.activeProject",
      "infra-tools",
    );
    render(
      <ProjectSwitcher mode="team" projects={[projectA, projectB]} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("infra-tools");
  });

  // V4.2 review C3: ProjectSwitcher must mirror its selection into a
  // cookie so Server Components can read it during SSR and attach
  // `x-issuepilot-project` to team-mode API calls. Without this the
  // detail page SSR returns HTTP 400.
  it("mirrors the selected project into a cookie so SSR can read it", () => {
    render(<ProjectSwitcher mode="team" projects={[projectA, projectB]} />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "infra-tools" } });
    expect(readProjectCookie()).toBe("infra-tools");
  });

  it("clears the cookie when the operator picks the 'all' option", () => {
    window.localStorage.setItem(
      "issuepilot.workItems.activeProject",
      "infra-tools",
    );
    render(<ProjectSwitcher mode="team" projects={[projectA, projectB]} />);
    // Initial hydration syncs the cookie from localStorage so the
    // server reads the same value the client is showing.
    expect(readProjectCookie()).toBe("infra-tools");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "" } });
    expect(readProjectCookie()).toBeNull();
  });

  // V4.2 review I2: ProjectSwitcher previously read `localStorage`
  // inside `useState`'s lazy initializer, which produces different
  // values on SSR vs the first client render and triggers React's
  // hydration mismatch warning when the component is rendered server-
  // side. The fix is to hydrate from a post-mount effect — that pulls
  // any `console.error` from `react-dom` to a clean log.
  it("does not log a hydration-mismatch warning on first mount", () => {
    window.localStorage.setItem(
      "issuepilot.workItems.activeProject",
      "infra-tools",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ProjectSwitcher mode="team" projects={[projectA, projectB]} />);
    const hydrationWarnings = errorSpy.mock.calls.filter((args) =>
      args.some(
        (a) =>
          typeof a === "string" &&
          /hydrat|did not match|server html/i.test(a),
      ),
    );
    expect(hydrationWarnings).toEqual([]);
  });
});
