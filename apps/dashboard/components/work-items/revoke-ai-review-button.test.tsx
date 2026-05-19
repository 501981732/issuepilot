// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { RevokeAiReviewButton } from "./revoke-ai-review-button";

const FAKE_BASE = "http://api.test";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE = FAKE_BASE;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE;
  vi.restoreAllMocks();
});

describe("RevokeAiReviewButton (V4.6)", () => {
  it("returns null when role is not reviewer", () => {
    const { container } = render(
      <RevokeAiReviewButton
        agentReportId="ar-1"
        role="coder"
        agentReportStatus="complete"
        mrPublicationStatus="published"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("is enabled when mrPublicationStatus = published", () => {
    render(
      <RevokeAiReviewButton
        agentReportId="ar-1"
        role="reviewer"
        agentReportStatus="complete"
        mrPublicationStatus="published"
      />,
    );
    const trigger = screen.getByTestId("revoke-trigger");
    expect(trigger).not.toBeDisabled();
  });

  it.each([
    ["pending", /pending|cannot revoke/i],
    ["publish_failed", /failed|no comments/i],
    ["revoked", /already revoked/i],
    ["skipped_by_config", /skipped/i],
  ] as const)(
    "is visible but disabled with i18n tooltip for status=%s",
    (status, pattern) => {
      render(
        <RevokeAiReviewButton
          agentReportId="ar-1"
          role="reviewer"
          agentReportStatus="complete"
          mrPublicationStatus={status}
        />,
      );
      const trigger = screen.getByTestId("revoke-trigger");
      expect(trigger).toBeDisabled();
      expect(trigger.getAttribute("title") ?? "").toMatch(pattern);
    },
  );

  it("shows incomplete-warning when reviewer status is cancelled but MR published", () => {
    render(
      <RevokeAiReviewButton
        agentReportId="ar-1"
        role="reviewer"
        agentReportStatus="cancelled"
        mrPublicationStatus="published"
      />,
    );
    expect(screen.getByTestId("incomplete-warning")).toBeInTheDocument();
    const trigger = screen.getByTestId("revoke-trigger");
    expect(trigger).not.toBeDisabled();
  });

  it("happy path: confirm dialog then revoke success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          agentReportId: "ar-1",
          status: "revoked",
          revokedAt: "2026-05-19T00:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const onRevoked = vi.fn();
    render(
      <RevokeAiReviewButton
        agentReportId="ar-1"
        role="reviewer"
        agentReportStatus="complete"
        mrPublicationStatus="published"
        onRevoked={onRevoked}
      />,
    );
    fireEvent.click(screen.getByTestId("revoke-trigger"));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("revoke-confirm"));
    await waitFor(() => expect(onRevoked).toHaveBeenCalledWith("ar-1"));
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/agent-reports/ar-1/revoke-ai-review`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders ApiError code on 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ code: "not_revocable", message: "nope" }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    render(
      <RevokeAiReviewButton
        agentReportId="ar-1"
        role="reviewer"
        agentReportStatus="complete"
        mrPublicationStatus="published"
      />,
    );
    fireEvent.click(screen.getByTestId("revoke-trigger"));
    fireEvent.click(screen.getByTestId("revoke-confirm"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("not_revocable");
    });
  });
});
