import { describe, expect, it } from "vitest";

import { deriveEvidenceId } from "../evidence-id.js";

describe("deriveEvidenceId", () => {
  it("returns a stable base64url sha1-derived id", () => {
    const input = {
      taskId: "task-1",
      kind: "screenshot" as const,
      runId: "run_a",
      seed: "screenshots/login.png",
    };

    expect(deriveEvidenceId(input)).toBe(deriveEvidenceId(input));
    expect(deriveEvidenceId(input)).toMatch(
      /^task-1:screenshot:run_a:[A-Za-z0-9_-]+$/,
    );
  });

  it("matches the sha1 base64url golden digest", () => {
    expect(
      deriveEvidenceId({
        taskId: "task-1",
        kind: "validation",
        runId: "run_a",
        seed: "stable-seed",
      }),
    ).toBe("task-1:validation:run_a:7sICaj63IrmqCV-Ai9VLn6wF62E");
  });

  it("changes when task, kind, run, or seed changes", () => {
    const base = {
      taskId: "task-1",
      kind: "screenshot" as const,
      runId: "run_a",
      seed: "screenshots/login.png",
    };
    const baseline = deriveEvidenceId(base);

    expect(deriveEvidenceId({ ...base, taskId: "task-2" })).not.toBe(baseline);
    expect(deriveEvidenceId({ ...base, kind: "recording" })).not.toBe(baseline);
    expect(deriveEvidenceId({ ...base, runId: "run_b" })).not.toBe(baseline);
    expect(
      deriveEvidenceId({ ...base, seed: "screenshots/settings.png" }),
    ).not.toBe(baseline);
  });

  it("does not emit slash, plus, or equals padding", () => {
    const id = deriveEvidenceId({
      taskId: "task-1",
      kind: "command_output",
      runId: "run_a",
      seed: "seed with bytes likely to need url-safe encoding",
    });

    expect(id).not.toMatch(/[+/=]/);
  });
});
