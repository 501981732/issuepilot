// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ViewToggle } from "./view-toggle";

describe("ViewToggle", () => {
  it("renders List, Graph, and Evidence buttons", () => {
    render(<ViewToggle view="list" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /List/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Graph/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Evidence/ }),
    ).toBeInTheDocument();
  });

  it("marks the graph view with aria-pressed=true", () => {
    render(<ViewToggle view="graph" onChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: /Graph/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /List/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("marks the evidence view with aria-pressed=true", () => {
    render(<ViewToggle view="evidence" onChange={() => {}} />);
    expect(
      screen
        .getByRole("button", { name: /Evidence/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /List/ }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: /Graph/ }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("calls onChange with graph when the graph button is clicked", () => {
    const onChange = vi.fn();
    render(<ViewToggle view="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Graph/ }));
    expect(onChange).toHaveBeenCalledWith("graph");
  });

  it("calls onChange with evidence when the evidence button is clicked", () => {
    const onChange = vi.fn();
    render(<ViewToggle view="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Evidence/ }));
    expect(onChange).toHaveBeenCalledWith("evidence");
  });
});
