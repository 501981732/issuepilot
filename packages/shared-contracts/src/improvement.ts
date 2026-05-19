import type {
  FailurePatternId,
  QualityStatusFilter,
  QualityWindow,
} from "./quality.js";

/**
 * V4.5 Improvement Loop wire contract. Keep all values JSON-serialisable.
 * Patch previews are inert records; they never imply filesystem writes.
 */

export const IMPROVEMENT_TARGET_KIND_VALUES = [
  "workflow_front_matter",
  "prompt_template",
  "project_rules",
  "skill_instruction",
] as const;

export type ImprovementTargetKind =
  (typeof IMPROVEMENT_TARGET_KIND_VALUES)[number];

export const isImprovementTargetKind = (
  value: unknown,
): value is ImprovementTargetKind =>
  typeof value === "string" &&
  (IMPROVEMENT_TARGET_KIND_VALUES as readonly string[]).includes(value);

export const IMPROVEMENT_RECOMMENDATION_STATUS_VALUES = [
  "open",
  "accepted",
  "rejected",
  "deferred",
  "blocked",
  "stale",
  "superseded",
] as const;

export type ImprovementRecommendationStatus =
  (typeof IMPROVEMENT_RECOMMENDATION_STATUS_VALUES)[number];

export const isImprovementRecommendationStatus = (
  value: unknown,
): value is ImprovementRecommendationStatus =>
  typeof value === "string" &&
  (IMPROVEMENT_RECOMMENDATION_STATUS_VALUES as readonly string[]).includes(
    value,
  );

export type ImprovementEvidenceKind =
  | "quality-drilldown"
  | "run"
  | "work-item"
  | "task"
  | "evidence"
  | "review-comment";

export interface ImprovementEvidenceRef {
  kind: ImprovementEvidenceKind;
  id: string;
  href?: string;
  reason: string;
}

export interface ImprovementPatchSourceSnapshot {
  targetPath: string;
  sha256: string;
  capturedAt: string;
}

export interface ImprovementPatchPreview {
  status: "not_generated" | "generated" | "blocked" | "stale";
  targetPath?: string;
  targetDescription: string;
  sourceSnapshot?: ImprovementPatchSourceSnapshot;
  diff?: string;
  blockedReason?: string;
  rollbackNotes?: string;
}

export type ImprovementAction =
  | "generated"
  | "accepted"
  | "rejected"
  | "deferred"
  | "superseded"
  | "patch_preview_generated";

export interface ImprovementActionHistoryEntry {
  action: ImprovementAction;
  actor: "operator" | "system";
  at: string;
  note?: string;
}

export interface ImprovementRecommendation {
  recommendationId: string;
  projectId: string;
  scope: {
    mode: "single-project" | "team-project";
    projectId?: string;
    workflow?: string;
    taskType?: string;
  };
  problemPattern: FailurePatternId;
  title: string;
  summary: string;
  target: {
    kind: ImprovementTargetKind;
    path?: string;
    description: string;
  };
  evidenceRefs: ImprovementEvidenceRef[];
  suggestedChange: string;
  patchPreview: ImprovementPatchPreview;
  confidence: "low" | "medium" | "high";
  risk: "low" | "medium" | "high";
  status: ImprovementRecommendationStatus;
  actionHistory: ImprovementActionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  supersedes?: string[];
}

export interface ImprovementRecommendationFilters {
  status?: ImprovementRecommendationStatus;
  pattern?: FailurePatternId;
  targetKind?: ImprovementTargetKind;
  workflow?: string;
  taskType?: string;
}

export interface ImprovementGenerateRequest {
  filters?: {
    workflow?: string;
    taskType?: string;
    status?: QualityStatusFilter;
    pattern?: FailurePatternId;
    from?: string;
    to?: string;
    window?: QualityWindow;
  };
}

export interface ImprovementActionRequest {
  operator?: string;
  note?: string;
}

export interface ImprovementPatchPreviewRequest {
  operator?: string;
}

export interface ImprovementRecommendationsListResponse {
  recommendations: ImprovementRecommendation[];
}

export interface ImprovementRecommendationDetailResponse {
  recommendation?: ImprovementRecommendation;
}

export interface ImprovementGenerateResponse {
  recommendations: ImprovementRecommendation[];
  generated: number;
  updated: number;
  skipped: number;
}

export interface ImprovementActionResponse {
  recommendation: ImprovementRecommendation;
}
