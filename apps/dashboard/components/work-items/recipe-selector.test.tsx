// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithIntl as render } from "../../test/intl";

import { RecipeSelector } from "./recipe-selector";

const FAKE_BASE = "http://api.test";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE = FAKE_BASE;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE;
  vi.restoreAllMocks();
});

describe("RecipeSelector (V4.6)", () => {
  it("shows three recipe options with current one selected", () => {
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        locked={false}
      />,
    );
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
  });

  it("disables save button until selection differs from current", () => {
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        locked={false}
      />,
    );
    const save = screen.getByTestId("recipe-save");
    expect(save).toBeDisabled();
    fireEvent.click(screen.getAllByRole("radio")[1]!);
    expect(save).not.toBeDisabled();
  });

  it("locks the form when locked=true and surfaces lockedTooltip on save button", () => {
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        locked
      />,
    );
    expect(screen.getByTestId("locked-badge")).toBeInTheDocument();
    const save = screen.getByTestId("recipe-save");
    expect(save).toBeDisabled();
    expect(save.getAttribute("title")).toMatch(
      /running_coding|cannot be changed/i,
    );
  });

  it("displays pending badge when pendingRecipe is supplied and defaults selection to it", () => {
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        pendingRecipe="coding_only"
        locked={false}
      />,
    );
    expect(screen.getByTestId("pending-recipe-badge")).toBeInTheDocument();
    const codingOnlyRadio = screen.getAllByRole("radio")[2] as HTMLInputElement;
    expect(codingOnlyRadio.checked).toBe(true);
  });

  it("POSTs setRecipeOverride and invokes onSaved on success", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          recipe: "coding_only",
          recipeSource: "operator_override",
          appliedTo: "pending",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const onSaved = vi.fn();
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        locked={false}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[2]!);
    fireEvent.click(screen.getByTestId("recipe-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("coding_only"));
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi-1/tasks/t-1/pipeline/recipe-override`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces ApiError code when the server returns 409", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "recipe_override_locked",
          message: "locked",
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    render(
      <RecipeSelector
        workItemId="wi-1"
        taskId="t-1"
        currentRecipe="full_pipeline"
        currentSource="workflow_default"
        locked={false}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[2]!);
    fireEvent.click(screen.getByTestId("recipe-save"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "recipe_override_locked",
      );
    });
  });
});
