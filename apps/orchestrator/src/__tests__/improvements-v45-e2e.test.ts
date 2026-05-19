import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { buildQualitySummary } from "../quality/aggregate.js";
import { createImprovementService } from "../improvements/service.js";
import { createImprovementStore } from "../improvements/store.js";

describe("V4.5 improvement loop e2e", () => {
  it("quality facts generate recommendation and inert patch preview", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "issuepilot-v45-"));
    const workflowPath = join(rootDir, "WORKFLOW.md");
    const original = "---\nagent:\n  max_attempts: 2\n---\nRun the task.\n";
    await writeFile(workflowPath, original, "utf8");
    const store = createImprovementStore({ rootDir });
    const service = createImprovementService({
      store,
      buildQualitySummary: async () =>
        buildQualitySummary({
          items: [
            {
              kind: "task",
              projectId: "proj-a",
              workflow: "default",
              taskType: "frontend",
              workItemId: "wi-1",
              workItemTitle: "Build UI",
              taskId: "t1",
              taskTitle: "Add widget",
              taskStatus: "completed",
              checklistReasons: ["missing-evidence"],
              evidenceCount: 0,
              validationEvidenceCount: 0,
              trustedValidationEvidenceCount: 0,
              aiClaimValidationEvidenceCount: 0,
              updatedAt: "2026-05-18T00:00:00.000Z",
            },
          ],
          filters: {
            from: "2026-05-11T00:00:00.000Z",
            to: "2026-05-18T23:59:59.999Z",
            window: "7d",
          },
          scope: { mode: "single-project" },
          diagnostics: { invalidReportCount: 0 },
        }),
    });

    const generated = await service.generate({});
    const recommendation = generated.recommendations[0]!;
    await service.accept(recommendation.recommendationId, {
      operator: "alice",
    });

    const accepted = (await service.detail(recommendation.recommendationId))!;
    await store.save({
      ...accepted,
      target: { ...accepted.target, path: workflowPath },
    });
    const preview = await service.patchPreview(recommendation.recommendationId, {
      operator: "alice",
    });
    if ("error" in preview) {
      throw new Error(`unexpected error: ${preview.error.message}`);
    }

    expect(preview.recommendation.patchPreview.status).toBe("generated");
    expect(preview.recommendation.patchPreview.diff).toContain("+");
    await expect(readFile(workflowPath, "utf8")).resolves.toBe(original);
  });
});
