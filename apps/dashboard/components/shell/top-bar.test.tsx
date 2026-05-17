// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

beforeAll(() => {
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
});

import { TopBar } from "./top-bar";

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
    // Command Center label appears in both the brand block and the nav.
    const commandCenterLinks = screen.getAllByRole("link", {
      name: "Command Center",
    });
    expect(commandCenterLinks.length).toBeGreaterThanOrEqual(1);
    expect(commandCenterLinks.some((l) => l.getAttribute("href") === "/")).toBe(
      true,
    );
  });
});
