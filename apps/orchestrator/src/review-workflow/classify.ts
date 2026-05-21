import type {
  FindingSeverity,
  ReviewerFinding,
} from "@issuepilot/shared-contracts";

import type { ClassifiedSignal } from "./types.js";

interface KeywordRule {
  pattern: RegExp;
  category: ClassifiedSignal["category"];
  priority: ClassifiedSignal["priority"];
  confidence: number;
}

/**
 * Detect question-like comments before falling through to keyword
 * rules. Reviewers often phrase low-confidence questions with a
 * trailing `?` or interrogative leads like "wdyt" / "can we" /
 * "should we" / "thoughts" / "discuss". When these markers appear we
 * label the comment `question` even if the body happens to contain
 * style / naming keywords — operators usually defer naming questions
 * rather than treat them as concrete rework.
 */
const QUESTION_DETECTORS: RegExp[] = [
  /\?\s*$/,
  /\b(wdyt|thoughts|opinion|opinions)\b/i,
  /\b(can|could|should|would)\s+(we|you|i)\b/i,
  /\b(discuss|chat|sync)\b/i,
];

const RULES: readonly KeywordRule[] = [
  {
    pattern: /\b(ci\s+pipeline|pipeline\s+(failed|red)|build\s+failed)\b/i,
    category: "ci_failure",
    priority: "blocking",
    confidence: 0.85,
  },
  {
    pattern: /\b(ci|pipeline|jenkins)\b/i,
    category: "ci_failure",
    priority: "high",
    confidence: 0.7,
  },
  {
    pattern: /\b(security|token|secret|credential|permission|leak)\b/i,
    category: "security",
    priority: "high",
    confidence: 0.8,
  },
  {
    pattern: /\b(screenshot|evidence|playwright|walkthrough|recording)\b/i,
    category: "missing_evidence",
    priority: "high",
    confidence: 0.75,
  },
  {
    pattern: /\b(test|tests|coverage|unit|e2e|spec)\b/i,
    category: "test_gap",
    priority: "high",
    confidence: 0.7,
  },
  {
    pattern: /\b(doc|docs|readme|changelog)\b/i,
    category: "docs",
    priority: "medium",
    confidence: 0.6,
  },
  {
    pattern: /\b(style|format|prettier|eslint|naming)\b/i,
    category: "style",
    priority: "low",
    confidence: 0.55,
  },
  {
    pattern: /\b(scope|out\s+of\s+scope|requirement|clarif)/i,
    category: "scope_clarification",
    priority: "medium",
    confidence: 0.6,
  },
  {
    pattern: /\b(null|undefined|race|deadlock|bug|crash)\b/i,
    category: "correctness",
    priority: "high",
    confidence: 0.7,
  },
];

const QUESTION_FALLBACK: ClassifiedSignal = {
  category: "question",
  priority: "medium",
  confidence: 0.35,
};

function looksLikeQuestion(body: string): boolean {
  return QUESTION_DETECTORS.some((re) => re.test(body));
}

export function classifyComment(body: string): ClassifiedSignal {
  if (looksLikeQuestion(body)) {
    return QUESTION_FALLBACK;
  }
  for (const rule of RULES) {
    if (rule.pattern.test(body)) {
      return {
        category: rule.category,
        priority: rule.priority,
        confidence: rule.confidence,
      };
    }
  }
  return QUESTION_FALLBACK;
}

function severityToPriority(
  severity: FindingSeverity,
): ClassifiedSignal["priority"] {
  switch (severity) {
    case "critical":
      return "blocking";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
  }
}

function findingCategory(
  finding: Pick<ReviewerFinding, "category" | "message">,
): ClassifiedSignal["category"] {
  const known = classifyComment(`${finding.category} ${finding.message}`);
  return known.category;
}

export function classifyFinding(
  finding: Pick<ReviewerFinding, "severity" | "category" | "message">,
): ClassifiedSignal {
  const category = findingCategory(finding);
  return {
    category,
    priority: severityToPriority(finding.severity),
    confidence: finding.severity === "critical" ? 0.9 : 0.75,
  };
}
