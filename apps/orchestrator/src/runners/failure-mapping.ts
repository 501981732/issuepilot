/**
 * V4.7 RunnerErrorCode → AgentReport.lastError.code mapping.
 *
 * Agent factories use this helper to translate a runner-layer failure
 * into the orchestrator-wide `LastErrorCode` truth source (spec §16.2)
 * so V4.4 quality / V4.5 improvement / dashboard see a consistent
 * `runner_unavailable` / `sandbox_violation` / `parse_failed` /
 * `evidence_unavailable` taxonomy regardless of which runner produced
 * the error.
 */

import type {
  LastErrorCode,
  RunnerErrorCode,
} from "@issuepilot/shared-contracts";

export const runnerErrorToLastErrorCode = (
  code: RunnerErrorCode,
): LastErrorCode => {
  switch (code) {
    case "sandbox_violation":
      return "sandbox_violation";
    case "output_unparseable":
      return "parse_failed";
    case "artifact_collection_failed":
      return "evidence_unavailable";
    case "runner_unavailable":
    case "runner_timeout":
    case "capability_missing":
    case "tool_denied":
      return "runner_unavailable";
    default: {
      const _exhaustive: never = code;
      throw new Error(
        `unsupported RunnerErrorCode in failure mapping: ${String(_exhaustive)}`,
      );
    }
  }
};
