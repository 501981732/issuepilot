// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { ReplanTaskDialog } from "./replan-task-dialog";

describe("ReplanTaskDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <ReplanTaskDialog
        open={false}
        taskId="t1"
        taskTitle="Implement"
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("disables submit until reason is at least 3 chars", () => {
    render(
      <ReplanTaskDialog
        open
        taskId="t1"
        taskTitle="Implement"
        onClose={() => {}}
        onSubmit={async () => {}}
      />,
    );
    const submit = screen.getByRole("button", { name: /Replan/ });
    expect(submit).toBeDisabled();

    const reason = screen.getByLabelText(/Reason/);
    fireEvent.change(reason, { target: { value: "ok" } });
    expect(submit).toBeDisabled();

    fireEvent.change(reason, { target: { value: "Too broad" } });
    expect(submit).not.toBeDisabled();
  });

  it("submits reason + hint to onSubmit and closes", async () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ReplanTaskDialog
        open
        taskId="t1"
        taskTitle="Implement"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "Need to split auth" },
    });
    fireEvent.change(screen.getByLabelText(/Hint/), {
      target: { value: "use new SSO library" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Replan/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      reason: "Need to split auth",
      hint: "use new SSO library",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Esc / Cancel closes without submitting", () => {
    const onSubmit = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <ReplanTaskDialog
        open
        taskId="t1"
        taskTitle="Implement"
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
