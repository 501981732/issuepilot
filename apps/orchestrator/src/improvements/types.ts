import type {
  FailurePatternId,
  ImprovementRecommendation,
  ImprovementTargetKind,
  QualityDrilldownItem,
  QualitySummaryResponse,
} from "@issuepilot/shared-contracts";

export interface ImprovementTemplate {
  patternId: FailurePatternId;
  targetKind: ImprovementTargetKind;
  title: string;
  summary: string;
  suggestedChange: string;
  risk: "low" | "medium" | "high";
}

export interface TargetPathResolverInput {
  template: ImprovementTemplate;
  cluster: PatternCluster;
  projectId: string;
}

export type TargetPathResolver = (
  input: TargetPathResolverInput,
) => string | undefined;

export interface BuildImprovementRecommendationsInput {
  summary: QualitySummaryResponse;
  existing?: ImprovementRecommendation[];
  now?: () => Date;
  resolveTargetPath?: TargetPathResolver;
}

export interface BuildImprovementRecommendationsResult {
  recommendations: ImprovementRecommendation[];
  /**
   * Existing recommendation IDs that the new emit set has replaced. Callers
   * are responsible for flipping these records to `status: "superseded"` so
   * the operator-facing audit trail stays intact (spec §9.2).
   */
  supersededIds: string[];
}

export interface PatternCluster {
  patternId: FailurePatternId;
  workflow?: string;
  taskType?: string;
  items: QualityDrilldownItem[];
}
