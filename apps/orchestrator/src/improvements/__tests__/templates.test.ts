import { describe, expect, it } from "vitest";

import { templateForPattern } from "../templates.js";

describe("improvement templates", () => {
  it("maps missing-evidence to prompt template guidance", () => {
    expect(templateForPattern("missing-evidence")).toMatchObject({
      targetKind: "prompt_template",
      title: "Require evidence for validation claims",
    });
  });

  it("maps permission issues without suggesting secret writes", () => {
    const template = templateForPattern("permission-issue");
    expect(template.targetKind).toBe("project_rules");
    expect(template.suggestedChange.toLowerCase()).not.toContain("token value");
    expect(template.suggestedChange.toLowerCase()).toContain("token");
  });
});
