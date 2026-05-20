import { describe, expect, it } from "vitest";

import {
  IMPROVEMENT_RECOMMENDATION_STATUS_VALUES,
  IMPROVEMENT_TARGET_KIND_VALUES,
  isImprovementRecommendationStatus,
  isImprovementTargetKind,
  type ImprovementRecommendation,
} from "../improvement.js";

describe("V4.5 improvement contracts", () => {
  it("keeps target kind and status guards strict", () => {
    expect(IMPROVEMENT_TARGET_KIND_VALUES).toEqual([
      "workflow_front_matter",
      "prompt_template",
      "project_rules",
      "skill_instruction",
      "role_configuration",
    ]);
    expect(isImprovementTargetKind("role_configuration")).toBe(true);
    expect(IMPROVEMENT_RECOMMENDATION_STATUS_VALUES).toEqual([
      "open",
      "accepted",
      "rejected",
      "deferred",
      "blocked",
      "stale",
      "superseded",
    ]);
    expect(isImprovementTargetKind("prompt_template")).toBe(true);
    expect(isImprovementTargetKind("label_state_machine")).toBe(false);
    expect(isImprovementRecommendationStatus("accepted")).toBe(true);
    expect(isImprovementRecommendationStatus("applied")).toBe(false);
  });

  it("round-trips a generated recommendation as JSON", () => {
    const recommendation: ImprovementRecommendation = {
      recommendationId: "rec_1",
      projectId: "platform-web",
      scope: {
        mode: "team-project",
        projectId: "platform-web",
        workflow: "default-web",
        taskType: "frontend",
      },
      problemPattern: "missing-evidence",
      title: "Require UI evidence",
      summary: "UI tasks repeatedly lacked screenshot or command output evidence.",
      target: {
        kind: "prompt_template",
        path: "/repo/WORKFLOW.md",
        description: "Prompt template evidence section",
      },
      evidenceRefs: [
        {
          kind: "quality-drilldown",
          id: "task:wi_1:t_1:missing-evidence",
          href: "/work-items/wi_1?view=evidence",
          reason: "Task had no trusted validation evidence",
        },
      ],
      suggestedChange:
        "Require screenshot or command output evidence for UI behavior changes.",
      patchPreview: {
        status: "generated",
        targetPath: "/repo/WORKFLOW.md",
        targetDescription: "Prompt template evidence section",
        sourceSnapshot: {
          targetPath: "/repo/WORKFLOW.md",
          sha256: "a".repeat(64),
          capturedAt: "2026-05-18T00:00:00.000Z",
        },
        diff: "@@ prompt_template @@\n+ Attach UI evidence.\n",
        rollbackNotes: "Remove the added prompt sentence.",
      },
      confidence: "high",
      risk: "low",
      status: "accepted",
      actionHistory: [
        {
          action: "generated",
          actor: "system",
          at: "2026-05-18T00:00:00.000Z",
        },
        {
          action: "accepted",
          actor: "operator",
          at: "2026-05-18T00:01:00.000Z",
          note: "Looks correct",
        },
      ],
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:01:00.000Z",
    };

    const parsed = JSON.parse(
      JSON.stringify(recommendation),
    ) as ImprovementRecommendation;
    expect(parsed.patchPreview.sourceSnapshot?.sha256).toHaveLength(64);
    expect(parsed.actionHistory.map((e) => e.action)).toEqual([
      "generated",
      "accepted",
    ]);
  });
});
