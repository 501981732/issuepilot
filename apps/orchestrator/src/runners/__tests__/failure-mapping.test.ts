import { describe, expect, it } from "vitest";

import { runnerErrorToLastErrorCode } from "../failure-mapping.js";

describe("runnerErrorToLastErrorCode", () => {
  it.each([
    ["runner_unavailable", "runner_unavailable"],
    ["runner_timeout", "runner_unavailable"],
    ["sandbox_violation", "sandbox_violation"],
    ["capability_missing", "runner_unavailable"],
    ["tool_denied", "runner_unavailable"],
    ["output_unparseable", "parse_failed"],
    ["artifact_collection_failed", "evidence_unavailable"],
  ] as const)("maps %s -> %s", (runnerCode, lastErrorCode) => {
    expect(runnerErrorToLastErrorCode(runnerCode)).toBe(lastErrorCode);
  });
});
