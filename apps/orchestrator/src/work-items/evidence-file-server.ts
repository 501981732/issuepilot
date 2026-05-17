import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface ServeEvidenceFileInput {
  taskWorktreePath: string;
  runId: string;
  relPath: string;
}

export type ServeEvidenceFileResult =
  | { ok: true; absPath: string; mediaType: string; sizeBytes: number }
  | { ok: false; error: "not_found" | "forbidden" | "oversized" };

const EVIDENCE_DIR = ".issuepilot/evidence";
const MAX_EVIDENCE_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const mediaTypes = new Map<string, string>([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".log", "text/plain"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".txt", "text/plain"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

export async function serveEvidenceFile({
  taskWorktreePath,
  runId,
  relPath,
}: ServeEvidenceFileInput): Promise<ServeEvidenceFileResult> {
  const evidenceBase = path.resolve(taskWorktreePath, EVIDENCE_DIR);
  const expectedRoot = path.resolve(evidenceBase, runId);
  if (
    expectedRoot === evidenceBase ||
    !expectedRoot.startsWith(evidenceBase + path.sep)
  ) {
    return { ok: false, error: "forbidden" };
  }

  const requested = path.resolve(expectedRoot, relPath);
  if (!requested.startsWith(expectedRoot + path.sep)) {
    return { ok: false, error: "forbidden" };
  }

  let linkStats;
  try {
    linkStats = await lstat(requested);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: false, error: "not_found" };
    }
    throw error;
  }
  if (linkStats.isSymbolicLink()) {
    return { ok: false, error: "forbidden" };
  }

  let stats;
  let realExpectedRoot;
  let realRequested;
  try {
    [stats, realExpectedRoot, realRequested] = await Promise.all([
      stat(requested),
      realpath(expectedRoot),
      realpath(requested),
    ]);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { ok: false, error: "not_found" };
    }
    throw error;
  }
  if (!realRequested.startsWith(realExpectedRoot + path.sep)) {
    return { ok: false, error: "forbidden" };
  }
  if (!stats.isFile()) {
    return { ok: false, error: "not_found" };
  }

  if (stats.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    return { ok: false, error: "oversized" };
  }

  return {
    ok: true,
    absPath: requested,
    mediaType: inferMediaType(requested),
    sizeBytes: stats.size,
  };
}

function inferMediaType(filePath: string): string {
  return (
    mediaTypes.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream"
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
