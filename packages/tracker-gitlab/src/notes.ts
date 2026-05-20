import type { GitLabApi, MergeRequestNotePosition } from "./api-shape.js";
import type { GitLabClient } from "./client.js";
import { classifyHttpStatus, extractStatus, GitLabError } from "./errors.js";

export interface CreateIssueNoteResult {
  id: number;
}

export interface WorkpadNote {
  id: number;
  body: string;
}

const NOTES_PER_PAGE = 100;
const ISSUEPILOT_RUN_MARKER = /^<!--\s*issuepilot:run(?::|=)[^>]+-->\s*$/;

// ────────────────────────────────────────────────────────────────────────────
// V4.6 reviewer publish flow — MR notes API
//
// The V4.6 reviewer agent posts one main summary note plus N inline findings
// to a GitLab MR through these helpers. The V4.6 design spec §12 requires
// the publisher to:
//   1. surface scope errors (401 / 403) as a dedicated typed failure so the
//      coordinator can map them to `lastError.code = "scope_insufficient"`
//      and TaskNode `roleFailureReason = "reviewer_cannot_review"`;
//   2. tolerate per-note 404 on delete (idempotent revoke) so a partially
//      stale `noteIds` list can still finish cleanly;
//   3. leave non-auth GitLab errors unchanged so `mrPublication.status`
//      falls into `publish_failed` rather than `scope_insufficient`.
// ────────────────────────────────────────────────────────────────────────────

export interface GitLabScopeMissingErrorInit {
  status?: number;
  cause?: unknown;
}

export class GitLabScopeMissingError extends GitLabError {
  override name = "GitLabScopeMissingError";
  readonly missingScope: string;

  constructor(missingScope: string, init: GitLabScopeMissingErrorInit = {}) {
    const status = init.status;
    const category =
      status === 401
        ? "auth"
        : status === 403
          ? "permission"
          : "permission";
    super(
      `GitLab MR notes scope missing: ${missingScope || "unknown"}`,
      status !== undefined
        ? {
            category,
            status,
            retriable: false,
            ...(init.cause !== undefined ? { cause: init.cause } : {}),
          }
        : {
            category,
            retriable: false,
            ...(init.cause !== undefined ? { cause: init.cause } : {}),
          },
    );
    this.missingScope = missingScope || "unknown";
  }
}

function isScopeStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/**
 * Wrap a call into the `MergeRequestNotes.*` API so 401 / 403 surface as
 * a `GitLabScopeMissingError` carrying the caller-declared `requiredScope`,
 * while everything else propagates as a regular `GitLabError`.
 */
async function withScopeMapping<T>(
  client: GitLabClient<GitLabApi>,
  label: string,
  requiredScope: string | undefined,
  fn: (api: GitLabApi) => Promise<T>,
): Promise<T> {
  try {
    return await client.request(label, fn);
  } catch (err) {
    if (err instanceof GitLabError && isScopeStatus(err.status)) {
      throw new GitLabScopeMissingError(requiredScope ?? "unknown", {
        ...(err.status !== undefined ? { status: err.status } : {}),
        cause: err.cause,
      });
    }
    // Direct status (some test stubs throw a plain Error with .status).
    const status = extractStatus(err);
    if (isScopeStatus(status)) {
      throw new GitLabScopeMissingError(requiredScope ?? "unknown", {
        ...(status !== undefined ? { status } : {}),
        cause: err,
      });
    }
    throw err;
  }
}

export async function createIssueNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  body: string,
): Promise<CreateIssueNoteResult> {
  return client.request("issueNotes.create", async (api) => {
    const created = await api.IssueNotes.create(client.projectId, iid, body);
    return { id: created.id };
  });
}

export async function updateIssueNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  noteId: number,
  body: string,
): Promise<void> {
  await client.request("issueNotes.edit", async (api) => {
    await api.IssueNotes.edit(client.projectId, iid, noteId, { body });
  });
}

/**
 * Find the IssuePilot workpad note on an issue. Each run prefixes its first
 * line with `<!-- issuepilot:run=<runId> -->`; this lookup re-uses the same
 * note across attempts so the issue thread doesn't accumulate stale comments.
 *
 * GitLab "system" notes (label/state changes) are always skipped — they
 * cannot be edited by us anyway.
 */
export async function findWorkpadNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
  marker: string,
): Promise<WorkpadNote | null> {
  return client.request("issueNotes.find", async (api) => {
    const notes = await api.IssueNotes.all(client.projectId, iid, {
      perPage: NOTES_PER_PAGE,
    });
    for (const n of notes) {
      if (n.system) continue;
      const body = typeof n.body === "string" ? n.body : "";
      if (firstLine(body) === marker) {
        return { id: n.id, body };
      }
    }
    return null;
  });
}

export async function findLatestIssuePilotWorkpadNote(
  client: GitLabClient<GitLabApi>,
  iid: number,
): Promise<WorkpadNote | null> {
  return client.request(
    "issueNotes.findLatestIssuePilotWorkpad",
    async (api) => {
      const notes = await api.IssueNotes.all(client.projectId, iid, {
        perPage: NOTES_PER_PAGE,
        orderBy: "updated_at",
        sort: "desc",
      });
      for (const note of notes) {
        if (!note || note.system) continue;
        const body = typeof note.body === "string" ? note.body : "";
        if (ISSUEPILOT_RUN_MARKER.test(firstLine(body))) {
          return { id: note.id, body };
        }
      }
      return null;
    },
  );
}

function firstLine(body: string): string {
  const newlineAt = body.indexOf("\n");
  const head = newlineAt === -1 ? body : body.slice(0, newlineAt);
  return head.trim();
}

export interface CreateMrNoteInput {
  client: GitLabClient<GitLabApi>;
  mrIid: number;
  body: string;
  /**
   * Token scope expected for `POST /merge_requests/:iid/notes`. The reviewer
   * publish flow reads this from `tracker.token_scope_requirements`. If a 401
   * / 403 comes back, the value is embedded in `GitLabScopeMissingError` so
   * the dashboard banner can name the missing scope explicitly.
   */
  requiredScope?: string;
}

export interface CreateMrInlineNoteInput extends CreateMrNoteInput {
  position: MergeRequestNotePosition;
}

export interface CreateMrInlineNoteResult {
  id: number;
}

/**
 * Post the reviewer's main summary note to an MR. Use {@link createMrInlineNote}
 * for findings tied to a specific diff position.
 */
export async function createMrNote(
  input: CreateMrNoteInput,
): Promise<CreateMrInlineNoteResult> {
  const { client, mrIid, body, requiredScope } = input;
  return withScopeMapping(
    client,
    "mergeRequestNotes.create",
    requiredScope,
    async (api) => {
      const created = await api.MergeRequestNotes.create(
        client.projectId,
        mrIid,
        body,
      );
      return { id: created.id };
    },
  );
}

/**
 * Post a reviewer inline finding to an MR, anchored at the given diff
 * position (file path + line on either side of the diff).
 */
export async function createMrInlineNote(
  input: CreateMrInlineNoteInput,
): Promise<CreateMrInlineNoteResult> {
  const { client, mrIid, body, position, requiredScope } = input;
  return withScopeMapping(
    client,
    "mergeRequestNotes.create",
    requiredScope,
    async (api) => {
      const created = await api.MergeRequestNotes.create(
        client.projectId,
        mrIid,
        body,
        { position },
      );
      return { id: created.id };
    },
  );
}

export interface DeleteMrNotesInput {
  client: GitLabClient<GitLabApi>;
  mrIid: number;
  noteIds: readonly number[];
  /** See {@link CreateMrNoteInput.requiredScope}. */
  requiredScope?: string;
}

export interface DeleteMrNotesResult {
  /** Note ids that GitLab confirmed deleted (status 2xx). */
  deletedNoteIds: number[];
  /** Note ids that already returned 404 — counted as idempotent success. */
  missingNoteIds: number[];
}

/**
 * Delete a batch of MR notes. Per spec §12 idempotency rule, a 404 on any
 * single note is silently absorbed (the note is already gone, so revoke is
 * still a success). 401 / 403 surface as {@link GitLabScopeMissingError}.
 */
export async function deleteMrNotes(
  input: DeleteMrNotesInput,
): Promise<DeleteMrNotesResult> {
  const { client, mrIid, noteIds, requiredScope } = input;
  const deletedNoteIds: number[] = [];
  const missingNoteIds: number[] = [];
  if (noteIds.length === 0) {
    return { deletedNoteIds, missingNoteIds };
  }

  for (const noteId of noteIds) {
    try {
      await withScopeMapping(
        client,
        "mergeRequestNotes.remove",
        requiredScope,
        async (api) => {
          await api.MergeRequestNotes.remove(client.projectId, mrIid, noteId);
        },
      );
      deletedNoteIds.push(noteId);
    } catch (err) {
      if (err instanceof GitLabError) {
        // Already-gone notes are part of the contract — record but continue.
        const status = err.status ?? extractStatus(err);
        if (status === 404 || classifyHttpStatus(status ?? 0) === "not_found") {
          missingNoteIds.push(noteId);
          continue;
        }
      }
      throw err;
    }
  }
  return { deletedNoteIds, missingNoteIds };
}
