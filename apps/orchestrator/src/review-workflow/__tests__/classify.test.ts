import { describe, expect, it } from "vitest";

import { classifyComment, classifyFinding } from "../classify.js";

describe("V4.9 review rework classifier", () => {
  it("maps test/coverage keywords to test_gap", () => {
    expect(classifyComment("please add unit tests for util.ts").category).toBe(
      "test_gap",
    );
    expect(classifyComment("coverage dropped below 80%").category).toBe(
      "test_gap",
    );
  });

  it("maps ci/pipeline keywords to ci_failure with blocking priority", () => {
    const r = classifyComment("CI pipeline failed on lint");
    expect(r.category).toBe("ci_failure");
    expect(r.priority).toBe("blocking");
  });

  it("maps evidence/screenshot keywords to missing_evidence", () => {
    expect(classifyComment("please attach a playwright walkthrough").category)
      .toBe("missing_evidence");
    expect(classifyComment("missing screenshot for new modal").category)
      .toBe("missing_evidence");
  });

  it("maps security keywords to security with high priority", () => {
    const r = classifyComment("you are logging the token in plain text");
    expect(r.category).toBe("security");
    expect(["high", "blocking"]).toContain(r.priority);
  });

  it("falls back to question with medium priority and low confidence", () => {
    const r = classifyComment("can we discuss naming offline?");
    expect(r.category).toBe("question");
    expect(r.priority).toBe("medium");
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("escalates reviewer critical severity to blocking", () => {
    const r = classifyFinding({
      severity: "critical",
      category: "correctness",
      message: "null pointer leak",
    });
    expect(r.priority).toBe("blocking");
  });
});
