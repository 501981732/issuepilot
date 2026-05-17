import type { ReportEvidence } from "@issuepilot/shared-contracts";

import type {
  OversizedEvidenceFile,
  RejectedEvidenceEntry,
  ScanRunEvidenceResult,
} from "./evidence-scanner.js";

export function mergeReportEvidence(
  existing: ReportEvidence[],
  scan: ScanRunEvidenceResult,
): ReportEvidence[] {
  if (scan.manifestUsed) {
    return [...scan.entries];
  }

  const byKey = new Map<string, ReportEvidence>();
  for (const entry of existing) {
    byKey.set(evidenceKey(entry), entry);
  }
  for (const entry of scan.entries) {
    byKey.set(evidenceKey(entry), entry);
  }

  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry);
}

export function appendOversizedFollowUps(
  followUps: string[],
  oversized: OversizedEvidenceFile[],
  rejected: RejectedEvidenceEntry[],
): string[] {
  const seen = new Set(followUps);
  const next = [...followUps];
  for (const line of [
    ...oversized.map(
      (file) =>
        `evidence oversized: ${file.relPath} (${formatMegabytes(
          file.sizeBytes,
        )}MB)`,
    ),
    ...rejected.map(
      (entry) => `evidence rejected: ${entry.relPath} escapes evidence dir`,
    ),
  ]) {
    if (seen.has(line)) continue;
    seen.add(line);
    next.push(line);
  }
  return next;
}

function evidenceKey(entry: ReportEvidence): string {
  return entry.relPath || entry.href || entry.label;
}

function formatMegabytes(sizeBytes: number): string {
  return (sizeBytes / (1024 * 1024)).toFixed(1);
}
