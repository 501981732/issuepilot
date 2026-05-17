import type { WorkItemEvidenceConfidence } from "@issuepilot/shared-contracts";

import type { Locale } from "../../i18n/locales";
import { Badge, type BadgeTone } from "../ui/badge";

const CONFIDENCE_LABELS: Record<
  Locale,
  Record<WorkItemEvidenceConfidence, string>
> = {
  en: {
    "ai-claim": "AI inferred",
    "system-derived": "System derived",
    "human-confirmed": "Human confirmed",
  },
  zh: {
    "ai-claim": "AI 推断",
    "system-derived": "系统生成",
    "human-confirmed": "人工确认",
  },
};

const CONFIDENCE_TONES: Record<WorkItemEvidenceConfidence, BadgeTone> = {
  "ai-claim": "warning",
  "system-derived": "info",
  "human-confirmed": "success",
};

export interface ConfidencePillProps {
  confidence: WorkItemEvidenceConfidence;
  locale?: Locale;
}

export function ConfidencePill({
  confidence,
  locale = "en",
}: ConfidencePillProps) {
  const label = CONFIDENCE_LABELS[locale][confidence];

  return (
    <Badge
      aria-label={label}
      role="status"
      tone={CONFIDENCE_TONES[confidence]}
    >
      {label}
    </Badge>
  );
}
