"use client";

import type { WorkItemEvidenceConfidence } from "@issuepilot/shared-contracts";
import { useTranslations } from "next-intl";

import { Badge, type BadgeTone } from "../ui/badge";

const CONFIDENCE_TONES: Record<WorkItemEvidenceConfidence, BadgeTone> = {
  "ai-claim": "warning",
  "system-derived": "info",
  "human-confirmed": "success",
};

export interface ConfidencePillProps {
  confidence: WorkItemEvidenceConfidence;
}

export function ConfidencePill({ confidence }: ConfidencePillProps) {
  const t = useTranslations("workItem.confidence");
  const label = t(confidence);

  return (
    <Badge aria-label={label} tone={CONFIDENCE_TONES[confidence]}>
      {label}
    </Badge>
  );
}
