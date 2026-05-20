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
  // V4.6 增量（plan Task 10.3 / spec §17.4）：reviewer / test_evidence /
  // pipeline / role profile / sandbox / redaction / runner / coding / storage
  // / cancel。其中以 reviewer / test_evidence prompt 模板和 role profile
  // sandbox 为目标的三个 V4.6 模板把 `targetKind` 设为 `role_configuration`，
  // 其他兜底走最接近的现有 kind。
  reviewer_unavailable: {
    patternId: "reviewer_unavailable",
    targetKind: "workflow_front_matter",
    title: "Diagnose reviewer runner outages",
    summary:
      "Reviewer pipeline step repeatedly hit runner-unavailable or parse failures.",
    suggestedChange:
      "Add workflow guidance that checks Codex app-server health before scheduling reviewer and surfaces a clear operator action when the reviewer runner cannot start.",
    risk: "medium",
  },
  reviewer_requested_changes: {
    patternId: "reviewer_requested_changes",
    targetKind: "role_configuration",
    title: "Sharpen reviewer prompt to reduce repeated rework",
    summary:
      "Reviewer keeps requesting changes for similar reasons across recent tasks.",
    suggestedChange:
      "Tune the reviewer role prompt template to explicitly enumerate the rework triggers and required evidence before approving.",
    risk: "low",
  },
  reviewer_cannot_review: {
    patternId: "reviewer_cannot_review",
    targetKind: "role_configuration",
    title: "Configure reviewer GitLab scopes and prompt template",
    summary:
      "Reviewer returned cannot_review for multiple tasks (missing scope or prompt mismatch).",
    suggestedChange:
      "Adjust reviewer role profile: confirm tracker.token_scope_requirements covers note publication and audit the reviewer prompt template path.",
    risk: "low",
  },
  evidence_unavailable: {
    patternId: "evidence_unavailable",
    targetKind: "role_configuration",
    title: "Restore test_evidence collector availability",
    summary:
      "Test/evidence pipeline step could not collect any evidence (runner or sandbox issues).",
    suggestedChange:
      "Inspect test_evidence role profile sandbox + tools allow list; ensure the collector is permitted to write under worktree/.issuepilot/evidence/.",
    risk: "medium",
  },
  evidence_partial: {
    patternId: "evidence_partial",
    targetKind: "role_configuration",
    title: "Reduce test_evidence partial outcomes",
    summary:
      "Test/evidence runs frequently return incomplete (CI ok but screenshot/CLI evidence missing).",
    suggestedChange:
      "Tune test_evidence prompt template to require explicit fallbacks (screenshot retry, log dump) before marking the run partial.",
    risk: "low",
  },
  pipeline_cancelled: {
    patternId: "pipeline_cancelled",
    targetKind: "workflow_front_matter",
    title: "Document pipeline cancellation handling",
    summary:
      "Pipelines were cancelled mid-run; ensure operator knows when to retry / replan.",
    suggestedChange:
      "Add workflow guidance describing operator decision after cancellation: retry coder vs. recipe override vs. mark blocked.",
    risk: "low",
  },
  pipeline_init_failed: {
    patternId: "pipeline_init_failed",
    targetKind: "workflow_front_matter",
    title: "Stabilise pipeline initialization",
    summary:
      "Pipeline creation failed before any role agent could run (config / store / scope).",
    suggestedChange:
      "Audit workflow YAML default_recipe + roles map, and confirm the pipeline storage directory is writable before retry.",
    risk: "medium",
  },
  role_profile_invalid: {
    patternId: "role_profile_invalid",
    targetKind: "role_configuration",
    title: "Repair invalid role profile",
    summary:
      "Role profile (prompt template / sandbox / tools) failed validation in recent runs.",
    suggestedChange:
      "Run /api/workflows/:workflowId/roles/validate and fix the reported role profile (missing prompt template path, invalid sandbox keyword, or disallowed tool grant).",
    risk: "low",
  },
  runner_unavailable: {
    patternId: "runner_unavailable",
    targetKind: "workflow_front_matter",
    title: "Recover Codex runner availability",
    summary:
      "Pipeline steps repeatedly failed with runner_unavailable across roles.",
    suggestedChange:
      "Add workflow guidance that documents Codex app-server restart procedure and how to confirm the runner is reachable before re-dispatching.",
    risk: "medium",
  },
  coding_failed: {
    patternId: "coding_failed",
    targetKind: "role_configuration",
    title: "Tighten coder role prompt",
    summary:
      "Coder agent repeatedly produced unusable patches.",
    suggestedChange:
      "Tune the coder role prompt template to enforce build/test gates before declaring the patch complete; consider adjusting tools.allow for the coder runner.",
    risk: "low",
  },
  sandbox_violation: {
    patternId: "sandbox_violation",
    targetKind: "role_configuration",
    title: "Audit role sandbox boundaries",
    summary:
      "Agents attempted writes outside the worktree (sandbox_violation events).",
    suggestedChange:
      "Re-confirm each role sandbox (read_write_worktree / read_only_worktree / read_only_source_write_evidence) is consistent with the role prompt; tighten tools.allow if needed.",
    risk: "medium",
  },
  redaction_failed: {
    patternId: "redaction_failed",
    targetKind: "role_configuration",
    title: "Inspect redact pipeline before re-running reviewer",
    summary:
      "Reviewer output failed redaction and was held back from MR publication.",
    suggestedChange:
      "Review the reviewer prompt template to avoid leaking raw credentials, and confirm the redact rule set covers the suspected pattern.",
    risk: "medium",
  },
  storage_full: {
    patternId: "storage_full",
    targetKind: "workflow_front_matter",
    title: "Free pipeline storage space",
    summary:
      "Pipeline / agent report store ran out of disk space.",
    suggestedChange:
      "Trim ~/.issuepilot/<scope>/{pipelines,agent-reports} retention or expand the workspace volume.",
    risk: "medium",
  },
};

export function templateForPattern(
  patternId: FailurePatternId,
): ImprovementTemplate {
  return TEMPLATES[patternId];
}
