import { createHash } from "node:crypto";

import type { WorkItemEvidenceKind } from "@issuepilot/shared-contracts";

export function deriveEvidenceId(input: {
  taskId: string;
  kind: WorkItemEvidenceKind;
  runId: string;
  seed: string;
}): string {
  const digest = createHash("sha1").update(input.seed).digest("base64url");
  return `${input.taskId}:${input.kind}:${input.runId}:${digest}`;
}
