import type { FailurePatternId } from "@issuepilot/shared-contracts";

import type { ImprovementTemplate } from "./types.js";

const TEMPLATES: Record<FailurePatternId, ImprovementTemplate> = {
  "missing-evidence": {
    patternId: "missing-evidence",
    targetKind: "prompt_template",
    title: "Require evidence for validation claims",
    summary:
      "Recent tasks reached review without enough trusted validation evidence.",
    suggestedChange:
      "Add prompt guidance that asks agents to attach screenshot, command output, or test evidence when they claim validation is complete.",
    risk: "low",
  },
  "missing-tests": {
    patternId: "missing-tests",
    targetKind: "project_rules",
    title: "Strengthen test evidence expectations",
    summary: "Recent work lacked test output or relied on weak validation claims.",
    suggestedChange:
      "Add project-rule guidance that requires explicit test commands, skipped-test rationale, or reviewer-visible validation evidence.",
    risk: "low",
  },
  "environment-issue": {
    patternId: "environment-issue",
    targetKind: "workflow_front_matter",
    title: "Add environment preflight guidance",
    summary:
      "Recent runs failed because local setup, workspace, network, or runner prerequisites were unavailable.",
    suggestedChange:
      "Add workflow guidance that requires environment preflight checks and clear blocked notes when prerequisites are missing.",
    risk: "medium",
  },
  "permission-issue": {
    patternId: "permission-issue",
    targetKind: "project_rules",
    title: "Document credential preflight without storing secrets",
    summary:
      "Recent runs failed because GitLab permissions or credentials were unavailable.",
    suggestedChange:
      "Add project-rule guidance that tells operators which credential environment variable must exist for the GitLab token, without persisting credential strings into files or logs.",
    risk: "low",
  },
  "review-rework": {
    patternId: "review-rework",
    targetKind: "prompt_template",
    title: "Structure review feedback rework input",
    summary: "Recent tasks repeatedly entered reviewer-driven rework.",
    suggestedChange:
      "Add prompt guidance that requires the agent to quote reviewer requests as structured constraints and respond with targeted changes plus validation evidence.",
    risk: "low",
  },
  "unclear-requirements": {
    patternId: "unclear-requirements",
    targetKind: "prompt_template",
    title: "Require acceptance criteria before execution",
    summary:
      "Recent runs were blocked by missing acceptance criteria or unclear scope.",
    suggestedChange:
      "Add planning prompt guidance that asks the agent to stop and request clarification when acceptance criteria or scope boundaries are missing.",
    risk: "low",
  },
  "ci-failure": {
    patternId: "ci-failure",
    targetKind: "workflow_front_matter",
    title: "Clarify CI failure handling",
    summary:
      "Recent runs reached CI failure paths that need clearer operator and agent behavior.",
    suggestedChange:
      "Add workflow guidance for CI retry boundaries, manual prompt behavior, and evidence required before rework.",
    risk: "medium",
  },
};

export function templateForPattern(
  patternId: FailurePatternId,
): ImprovementTemplate {
  return TEMPLATES[patternId];
}
