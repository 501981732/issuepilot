// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfidencePill } from "./confidence-pill";

describe("ConfidencePill", () => {
  it("renders 'AI 推断' label for ai-claim in zh locale", () => {
    render(<ConfidencePill confidence="ai-claim" locale="zh" />);

    expect(screen.getByText("AI 推断")).toBeInTheDocument();
  });

  it("renders the success tone for human-confirmed", () => {
    render(<ConfidencePill confidence="human-confirmed" />);

    expect(screen.getByRole("status")).toHaveAttribute(
      "data-tone",
      "success",
    );
  });

  it("renders aria-label for screen readers", () => {
    render(<ConfidencePill confidence="system-derived" locale="zh" />);

    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "系统生成",
    );
  });
});
