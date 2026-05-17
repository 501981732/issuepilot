// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { MarkReworkDialog } from "./mark-rework-dialog";

describe("MarkReworkDialog", () => {
  it("requires a non-empty reason", () => {
    render(
      <MarkReworkDialog
        open
        taskId="t1"
        taskTitle="Implement"
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    const submit = screen.getByRole("button", { name: /Mark$/ });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/feedback/i), {
      target: { value: "Add caching" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("submits reason to onSubmit and closes", async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <MarkReworkDialog
        open
        taskId="t1"
        taskTitle="Implement"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/feedback/i), {
      target: { value: "Reviewer wants tests" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Mark$/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ reason: "Reviewer wants tests" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
