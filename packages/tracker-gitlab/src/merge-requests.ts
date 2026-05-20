import type { GitLabApi } from "./api-shape.js";
import type { GitLabClient } from "./client.js";

export interface CreateMergeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  /**
   * The issue this MR resolves. Close-link semantics belong in the
   * orchestrator-side description template (spec §12); GitLab's create MR API
   * does not accept an issue iid option.
   */
  issueIid: number;
}

export interface CreatedMergeRequest {
  id: number;
  iid: number;
  webUrl: string;
}

export type MergeRequestUpdates = Partial<{
  title: string;
  description: string;
  targetBranch: string;
}>;

export interface MergeRequestSummary {
  iid: number;
  webUrl: string;
  state: string;
  diffRefs?: {
    baseSha: string;
    startSha: string;
    headSha: string;
  };
}

export interface SourceBranchMergeRequestDetail extends SourceBranchMergeRequestSummary {
  title: string;
  description: string;
}

export interface SourceBranchMergeRequestSummary extends MergeRequestSummary {
  sourceBranch: string;
  updatedAt?: string;
}

export interface MergeRequestNote {
  id: number;
  body: string;
  /** Resolved username; falls back to display name and finally `"unknown"`. */
  author: string;
  /**
   * `true` when GitLab generated the note (label change, milestone, etc.).
   * Always present so the V2 Phase 4 review sweep can drop system noise
   * with a simple boolean filter rather than a heuristic on the body.
   * Defaults to `false` when GitLab omits the field on older payloads.
   */
  system: boolean;
  /**
   * ISO-8601 timestamp from GitLab. Set whenever the API returns it
   * (every modern notes payload), absent only for legacy mocks that
   * predate the V2 Phase 4 contract.
   */
  createdAt?: string;
  /** Mirror of `updated_at` for the rare edit case. */
  updatedAt?: string;
  /** True only for MR discussion notes that GitLab marks resolvable. */
  resolvable?: boolean;
  /** True only for resolved discussions; meaningless when `resolvable` is false. */
  resolved?: boolean;
}

/**
 * Create a merge request — or return the existing opened MR if one already
 * exists for the same source branch. The reconcile loop (spec §12) calls this
 * after every dispatch, so it MUST be safe to retry without producing a fork.
 */
export async function createMergeRequest(
  client: GitLabClient<GitLabApi>,
  input: CreateMergeRequestInput,
): Promise<CreatedMergeRequest> {
  return client.request("mergeRequests.create", async (api) => {
    const opened = await api.MergeRequests.all({
      projectId: client.projectId,
      sourceBranch: input.sourceBranch,
      state: "opened",
      perPage: 5,
    });
    const existing = opened.find(
      (mr) => mr.source_branch === input.sourceBranch && mr.state === "opened",
    );
    if (existing) {
      return {
        id: existing.id,
        iid: existing.iid,
        webUrl: existing.web_url,
      };
    }
    const created = await api.MergeRequests.create(
      client.projectId,
      input.sourceBranch,
      input.targetBranch,
      input.title,
      {
        description: input.description,
      },
    );
    return { id: created.id, iid: created.iid, webUrl: created.web_url };
  });
}

/**
 * Apply optional updates to an MR. Skips the network entirely when the caller
 * has nothing to change — this keeps the reconciler quiet when an MR is
 * already in the desired shape (spec §12).
 */
export async function updateMergeRequest(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
  updates: MergeRequestUpdates,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  await client.request("mergeRequests.edit", async (api) => {
    await api.MergeRequests.edit(client.projectId, mrIid, updates);
  });
}

export async function getMergeRequest(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
): Promise<MergeRequestSummary> {
  return client.request("mergeRequests.show", async (api) => {
    const mr = await api.MergeRequests.show(client.projectId, mrIid);
    const summary: MergeRequestSummary = {
      iid: mr.iid,
      webUrl: mr.web_url,
      state: mr.state,
    };
    const diffRefs = mapDiffRefs(mr);
    return diffRefs ? { ...summary, diffRefs } : summary;
  });
}

function mapDiffRefs(mr: {
  diff_refs?: {
    base_sha?: string | null;
    start_sha?: string | null;
    head_sha?: string | null;
  } | null;
}): MergeRequestSummary["diffRefs"] | undefined {
  const refs = mr.diff_refs;
  if (!refs) return undefined;
  if (
    typeof refs.base_sha !== "string" ||
    typeof refs.start_sha !== "string" ||
    typeof refs.head_sha !== "string"
  ) {
    return undefined;
  }
  return {
    baseSha: refs.base_sha,
    startSha: refs.start_sha,
    headSha: refs.head_sha,
  };
}

export async function findMergeRequestBySourceBranch(
  client: GitLabClient<GitLabApi>,
  sourceBranch: string,
): Promise<SourceBranchMergeRequestDetail | null> {
  return client.request("mergeRequests.findBySourceBranch", async (api) => {
    const rows = await api.MergeRequests.all({
      projectId: client.projectId,
      sourceBranch,
      state: "opened",
      perPage: 5,
    });
    const mr = rows.find(
      (candidate) =>
        candidate.source_branch === sourceBranch &&
        candidate.state === "opened",
    );
    if (!mr) return null;
    const summary: SourceBranchMergeRequestDetail = {
      iid: mr.iid,
      webUrl: mr.web_url,
      state: mr.state,
      sourceBranch: mr.source_branch,
      title: mr.title,
      description: typeof mr.description === "string" ? mr.description : "",
    };
    return mr.updated_at ? { ...summary, updatedAt: mr.updated_at } : summary;
  });
}

export async function listMergeRequestsBySourceBranch(
  client: GitLabClient<GitLabApi>,
  sourceBranch: string,
): Promise<SourceBranchMergeRequestSummary[]> {
  return client.request("mergeRequests.listBySourceBranch", async (api) => {
    const rows = await api.MergeRequests.all({
      projectId: client.projectId,
      sourceBranch,
      perPage: 20,
    });
    return rows.map((mr) => {
      const summary: SourceBranchMergeRequestSummary = {
        iid: mr.iid,
        webUrl: mr.web_url,
        state: mr.state,
        sourceBranch: mr.source_branch,
      };
      return mr.updated_at ? { ...summary, updatedAt: mr.updated_at } : summary;
    });
  });
}

export async function listMergeRequestNotes(
  client: GitLabClient<GitLabApi>,
  mrIid: number,
): Promise<MergeRequestNote[]> {
  return client.request("mergeRequestNotes.all", async (api) => {
    const rows = await api.MergeRequestNotes.all(client.projectId, mrIid, {
      perPage: 100,
    });
    return rows.map((n) => {
      const note: MergeRequestNote = {
        id: n.id,
        body: typeof n.body === "string" ? n.body : "",
        author:
          n.author?.username && n.author.username.length > 0
            ? n.author.username
            : n.author?.name && n.author.name.length > 0
              ? n.author.name
              : "unknown",
        system: n.system === true,
      };
      if (typeof n.created_at === "string") note.createdAt = n.created_at;
      if (typeof n.updated_at === "string") note.updatedAt = n.updated_at;
      if (typeof n.resolvable === "boolean") note.resolvable = n.resolvable;
      if (typeof n.resolved === "boolean") note.resolved = n.resolved;
      return note;
    });
  });
}
