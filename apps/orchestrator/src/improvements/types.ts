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

export interface BuildImprovementRecommendationsInput {
  summary: QualitySummaryResponse;
  existing?: ImprovementRecommendation[];
  now?: () => Date;
}

export interface PatternCluster {
  patternId: FailurePatternId;
  workflow?: string;
  taskType?: string;
  items: QualityDrilldownItem[];
}
