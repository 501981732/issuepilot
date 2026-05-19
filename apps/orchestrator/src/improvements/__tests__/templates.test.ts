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

  it("V4.6: maps reviewer_cannot_review to role_configuration target", () => {
    const template = templateForPattern("reviewer_cannot_review");
    expect(template.targetKind).toBe("role_configuration");
    expect(template.title.toLowerCase()).toContain("reviewer");
  });

  it("V4.6: maps role_profile_invalid to role_configuration target", () => {
    expect(templateForPattern("role_profile_invalid").targetKind).toBe(
      "role_configuration",
    );
  });

  it("V4.6: maps sandbox_violation to role_configuration with medium risk", () => {
    const template = templateForPattern("sandbox_violation");
    expect(template.targetKind).toBe("role_configuration");
    expect(template.risk).toBe("medium");
  });

  it("V4.6: pipeline_cancelled stays in workflow_front_matter so operator gets the runbook", () => {
    expect(templateForPattern("pipeline_cancelled").targetKind).toBe(
      "workflow_front_matter",
    );
  });
});
