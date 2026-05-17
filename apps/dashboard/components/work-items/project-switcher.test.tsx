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

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
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
});
