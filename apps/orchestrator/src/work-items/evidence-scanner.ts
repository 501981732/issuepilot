import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ReportEvidence } from "@issuepilot/shared-contracts";

export interface ScanRunEvidenceOptions {
  taskWorktreePath: string;
  runId: string;
  oversizedLimitBytes?: number;
}

export interface OversizedEvidenceFile {
  relPath: string;
  sizeBytes: number;
}

export interface RejectedEvidenceEntry {
  relPath: string;
  reason: "path-escape";
}

export interface ScanRunEvidenceResult {
  entries: ReportEvidence[];
  oversized: OversizedEvidenceFile[];
  rejected: RejectedEvidenceEntry[];
  manifestUsed: boolean;
}

const DEFAULT_OVERSIZED_LIMIT_BYTES = 50 * 1024 * 1024;

const EVIDENCE_DIR = ".issuepilot/evidence";

const mediaTypes = new Map<string, string>([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

export async function scanRunEvidence({
  taskWorktreePath,
  runId,
  oversizedLimitBytes = DEFAULT_OVERSIZED_LIMIT_BYTES,
}: ScanRunEvidenceOptions): Promise<ScanRunEvidenceResult> {
  const evidenceRunRoot = path.join(taskWorktreePath, EVIDENCE_DIR, runId);
  if (!(await directoryExists(evidenceRunRoot))) {
    return emptyResult();
  }

  const fileRelPaths = await listFiles(evidenceRunRoot);
  const oversized = await findOversizedFiles({
    evidenceRunRoot,
    fileRelPaths,
    oversizedLimitBytes,
  });
  const oversizedRelPaths = new Set(oversized.map((file) => file.relPath));

  const manifestPath = path.join(evidenceRunRoot, "manifest.json");
  const manifestUsed = await fileExists(manifestPath);
  const rejected: RejectedEvidenceEntry[] = [];

  if (manifestUsed) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries?: ReportEvidence[];
    };
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    return {
      entries: entries.filter((entry) => {
        if (!entry.relPath) {
          return true;
        }
        if (isPathEscaped(evidenceRunRoot, entry.relPath)) {
          rejected.push({ relPath: entry.relPath, reason: "path-escape" });
          return false;
        }
        return !oversizedRelPaths.has(normalizeRelPath(entry.relPath));
      }),
      oversized,
      rejected,
      manifestUsed: true,
    };
  }

  return {
    entries: fileRelPaths
      .filter((relPath) => !oversizedRelPaths.has(relPath))
      .flatMap((relPath) => inferEvidenceEntry(relPath)),
    oversized,
    rejected,
    manifestUsed: false,
  };
}

function emptyResult(): ScanRunEvidenceResult {
  return {
    entries: [],
    oversized: [],
    rejected: [],
    manifestUsed: false,
  };
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        return listFiles(root, entryPath);
      }
      if (!entry.isFile()) {
        return [];
      }
      const relPath = normalizeRelPath(path.relative(root, entryPath));
      return relPath === "manifest.json" ? [] : [relPath];
    }),
  );
  return files.flat().sort();
}

async function findOversizedFiles({
  evidenceRunRoot,
  fileRelPaths,
  oversizedLimitBytes,
}: {
  evidenceRunRoot: string;
  fileRelPaths: string[];
  oversizedLimitBytes: number;
}): Promise<OversizedEvidenceFile[]> {
  const oversized = await Promise.all(
    fileRelPaths.map(async (relPath) => {
      const stats = await stat(path.join(evidenceRunRoot, relPath));
      if (stats.size <= oversizedLimitBytes) {
        return undefined;
      }
      return { relPath, sizeBytes: stats.size };
    }),
  );
  return oversized.filter((file): file is OversizedEvidenceFile => Boolean(file));
}

function inferEvidenceEntry(relPath: string): ReportEvidence[] {
  const dirname = path.posix.dirname(relPath);
  const basename = path.posix.basename(relPath);
  const ext = path.posix.extname(relPath).toLowerCase();

  if (dirname === "screenshots" && isScreenshotExtension(ext)) {
    const mediaType = mediaTypes.get(ext);
    if (!mediaType) {
      return [];
    }
    return [
      {
        kind: "screenshot",
        label: basename,
        relPath,
        mediaType,
      },
    ];
  }

  if (dirname === "recordings" && isRecordingExtension(ext)) {
    const mediaType = mediaTypes.get(ext);
    if (!mediaType) {
      return [];
    }
    return [
      {
        kind: "recording",
        label: basename,
        relPath,
        mediaType,
      },
    ];
  }

  if (dirname === "playwright" && ext === ".zip") {
    return [{ kind: "playwright", label: basename, relPath }];
  }

  if (dirname === "commands" && (ext === ".txt" || ext === ".log")) {
    return [{ kind: "command_output", label: basename, relPath }];
  }

  if (dirname === "tests" && ext === ".json") {
    return [{ kind: "test_result", label: basename, relPath }];
  }

  return [];
}

function isScreenshotExtension(ext: string): boolean {
  return ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp";
}

function isRecordingExtension(ext: string): boolean {
  return ext === ".mp4" || ext === ".webm" || ext === ".mov";
}

function isPathEscaped(root: string, relPath: string): boolean {
  const resolved = path.resolve(root, relPath);
  const relative = path.relative(root, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function normalizeRelPath(relPath: string): string {
  return relPath.split(path.sep).join(path.posix.sep);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
