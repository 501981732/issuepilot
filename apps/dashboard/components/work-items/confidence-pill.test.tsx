// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithIntl as render } from "../../test/intl";
import zhMessages from "../../i18n/messages/zh.json";

import { ConfidencePill } from "./confidence-pill";

describe("ConfidencePill", () => {
  it("renders 'AI 推断' label for ai-claim in zh locale", () => {
    render(<ConfidencePill confidence="ai-claim" />, {
      locale: "zh",
      catalog: zhMessages,
    });

    expect(screen.getByText("AI 推断")).toBeInTheDocument();
  });

  it("renders the success tone for human-confirmed", () => {
    render(<ConfidencePill confidence="human-confirmed" />);

    expect(screen.getByText("Human confirmed")).toHaveAttribute(
      "data-tone",
      "success",
    );
  });

  it("renders aria-label for screen readers", () => {
    render(<ConfidencePill confidence="system-derived" />, {
      locale: "zh",
      catalog: zhMessages,
    });

    expect(screen.getByText("系统生成")).toHaveAttribute(
      "aria-label",
      "系统生成",
    );
  });
});
