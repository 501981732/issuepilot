import type { ReportEvidence } from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import type { ScanRunEvidenceResult } from "../evidence-scanner.js";
import {
  appendOversizedFollowUps,
  mergeReportEvidence,
} from "../evidence-merge.js";

function scanResult(
  overrides: Partial<ScanRunEvidenceResult>,
): ScanRunEvidenceResult {
  return {
    entries: [],
    oversized: [],
    rejected: [],
    manifestUsed: false,
    ...overrides,
  };
}

const existingScreenshot: ReportEvidence = {
  kind: "screenshot",
  label: "existing screenshot",
  relPath: "screenshots/login.png",
};

describe("mergeReportEvidence", () => {
  it("returns scan entries as authoritative when manifest is used", () => {
    const manifestEntries: ReportEvidence[] = [
      {
        kind: "recording",
        label: "manifest video",
        relPath: "recordings/demo.webm",
      },
    ];

    expect(
      mergeReportEvidence(
        [existingScreenshot],
        scanResult({ entries: manifestEntries, manifestUsed: true }),
      ),
    ).toEqual(manifestEntries);
  });

  it("dedupes by relPath when scanner overlaps with existing", () => {
    const merged = mergeReportEvidence(
      [existingScreenshot],
      scanResult({
        entries: [
          {
            kind: "screenshot",
            label: "scanner screenshot",
            relPath: "screenshots/login.png",
          },
        ],
      }),
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("scanner screenshot");
  });

  it("keeps scanner fields when scan entry wins on overlap", () => {
    const merged = mergeReportEvidence(
      [
        {
          ...existingScreenshot,
          mediaType: "image/jpeg",
          capturedAt: "2026-05-16T00:00:00.000Z",
        },
      ],
      scanResult({
        entries: [
          {
            ...existingScreenshot,
            mediaType: "image/png",
            capturedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(merged[0]).toMatchObject({
      mediaType: "image/png",
      capturedAt: "2026-05-17T00:00:00.000Z",
    });
  });

  it("orders merged entries deterministically", () => {
    const merged = mergeReportEvidence(
      [
        {
          kind: "command_output",
          label: "z command",
          relPath: "commands/z.log",
        },
        {
          kind: "screenshot",
          label: "a screenshot",
          relPath: "screenshots/a.png",
        },
      ],
      scanResult({
        entries: [
          {
            kind: "recording",
            label: "m recording",
            relPath: "recordings/m.webm",
          },
        ],
      }),
    );

    expect(merged.map((entry) => entry.relPath)).toEqual([
      "commands/z.log",
      "recordings/m.webm",
      "screenshots/a.png",
    ]);
  });
});

describe("appendOversizedFollowUps", () => {
  it("appends oversized and rejected findings as one followUp per file", () => {
    const existing = ["existing follow-up"];
    const merged = appendOversizedFollowUps(
      existing,
      [{ relPath: "recordings/demo.webm", sizeBytes: 5 * 1024 * 1024 }],
      [{ relPath: "../escape.png", reason: "path-escape" }],
    );

    expect(merged).toEqual([
      "existing follow-up",
      "evidence oversized: recordings/demo.webm (5.0MB)",
      "evidence rejected: ../escape.png escapes evidence dir",
    ]);
    expect(existing).toEqual(["existing follow-up"]);
  });

  it("does not duplicate generated followUps when re-run", () => {
    const existing = [
      "existing follow-up",
      "evidence oversized: recordings/demo.webm (5.0MB)",
      "evidence rejected: ../escape.png escapes evidence dir",
    ];

    expect(
      appendOversizedFollowUps(
        existing,
        [{ relPath: "recordings/demo.webm", sizeBytes: 5 * 1024 * 1024 }],
        [{ relPath: "../escape.png", reason: "path-escape" }],
      ),
    ).toEqual(existing);
  });
});
