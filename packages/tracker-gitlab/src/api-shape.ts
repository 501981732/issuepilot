/**
 * Narrow subset of the `@gitbeaker/rest` runtime surface that this adapter
 * actually exercises. Defining it here keeps tests honest (stubs match
 * production shape) and isolates us from `@gitbeaker`'s sprawling generic
 * type tree.
 */

export interface RawIssue {
  id: number;
  iid: number;
  title: string;
  description?: string | null;
  web_url: string;
  project_id: number;
  labels?: readonly string[];
  state?: string;
}

export interface RawIssueNote {
  id: number;
  body: string;
  author?: { username?: string | null; name?: string | null } | null;
  system?: boolean;
  /** GitLab `created_at`; only present on the notes API, not on system events. */
  created_at?: string;
  /** GitLab `updated_at`; may equal `created_at` for unedited notes. */
  updated_at?: string;
  /** Whether the surrounding discussion is resolvable (MR discussions only). */
  resolvable?: boolean;
  /** Whether the discussion has been resolved by a maintainer. */
  resolved?: boolean;
}

export interface RawMergeRequest {
  id: number;
  iid: number;
  web_url: string;
  state: string;
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string | null;
  updated_at?: string;
  diff_refs?: {
    base_sha?: string | null;
    start_sha?: string | null;
    head_sha?: string | null;
  } | null;
}

export interface RawPipeline {
  id: number;
  ref: string;
  status: string;
  updated_at?: string;
}

export interface IssuesApi {
  all(opts: {
    projectId: string | number;
    state?: "opened" | "closed";
    labels?: string;
    perPage?: number;
    orderBy?: string;
    sort?: "asc" | "desc";
  }): Promise<readonly RawIssue[]>;
  show(iid: number, opts: { projectId: string | number }): Promise<RawIssue>;
  edit(
    projectId: string | number,
    iid: number,
    opts: {
      labels?: string;
      removeLabels?: string;
      stateEvent?: "close" | "reopen";
    },
  ): Promise<RawIssue>;
}

export interface IssueNotesApi {
  all(
    projectId: string | number,
    iid: number,
    opts?: { perPage?: number; orderBy?: string; sort?: "asc" | "desc" },
  ): Promise<readonly RawIssueNote[]>;
  create(
    projectId: string | number,
    iid: number,
    body: string,
  ): Promise<RawIssueNote>;
  edit(
    projectId: string | number,
    iid: number,
    noteId: number,
    opts: { body: string },
  ): Promise<RawIssueNote>;
}

export interface MergeRequestsApi {
  all(opts: {
    projectId: string | number;
    sourceBranch?: string;
    state?: string;
    perPage?: number;
  }): Promise<readonly RawMergeRequest[]>;
  create(
    projectId: string | number,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    opts?: {
      description?: string;
    },
  ): Promise<RawMergeRequest>;
  edit(
    projectId: string | number,
    mrIid: number,
    opts: Partial<{
      title: string;
      description: string;
      targetBranch: string;
    }>,
  ): Promise<RawMergeRequest>;
  show(projectId: string | number, mrIid: number): Promise<RawMergeRequest>;
}

/**
 * Position payload accepted by GitLab's `POST /merge_requests/:iid/notes` (or
 * the discussions API) for inline review comments. We intentionally type only
 * the fields we send so unrelated GitLab evolutions don't ripple here.
 */
export interface MergeRequestNotePosition {
  /** `"text"` for normal diff comments — we never send image positions. */
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  new_path: string;
  old_path: string;
  new_line?: number;
  old_line?: number;
}

export interface MergeRequestNotesApi {
  all(
    projectId: string | number,
    mrIid: number,
    opts?: { perPage?: number },
  ): Promise<readonly RawIssueNote[]>;
  create(
    projectId: string | number,
    mrIid: number,
    body: string,
    opts?: { position?: MergeRequestNotePosition },
  ): Promise<RawIssueNote>;
  remove(
    projectId: string | number,
    mrIid: number,
    noteId: number,
  ): Promise<void>;
}

export interface PipelinesApi {
  all(
    projectId: string | number,
    opts?: {
      ref?: string;
      perPage?: number;
      orderBy?: string;
      sort?: "asc" | "desc";
    },
  ): Promise<readonly RawPipeline[]>;
}

export interface GitLabApi {
  Issues: IssuesApi;
  IssueNotes: IssueNotesApi;
  MergeRequests: MergeRequestsApi;
  MergeRequestNotes: MergeRequestNotesApi;
  Pipelines: PipelinesApi;
}
