export { resolveGitLabToken, defaultEnv, type EnvLike } from "./auth.js";
export {
  GitLabError,
  classifyHttpStatus,
  extractStatus,
  toGitLabError,
  type GitLabErrorInit,
} from "./errors.js";
export {
  createGitLabClient,
  createGitLabClientFromCredential,
  type CreateGitLabClientFromCredentialInput,
  type CreateGitLabClientInput,
  type GitLabClient,
  type GitlabCtor,
} from "./client.js";
export type {
  GitLabApi,
  IssueNotesApi,
  IssuesApi,
  MergeRequestNotePosition,
  MergeRequestNotesApi,
  MergeRequestsApi,
  PipelinesApi,
  RawIssue,
  RawIssueNote,
  RawMergeRequest,
  RawPipeline,
} from "./api-shape.js";
export {
  closeIssue,
  getIssue,
  listCandidateIssues,
  toIssueRef,
  type CloseIssueOpts,
  type CloseIssueResult,
  type ListCandidateIssuesOpts,
} from "./issues.js";
export {
  createGitLabAdapter,
  createGitLabAdapterFromCredential,
  type CreateGitLabAdapterFromCredentialInput,
  type CreateGitLabAdapterInput,
  type GitLabAdapterHandle,
} from "./adapter.js";
export {
  transitionLabels,
  type TransitionLabelsOpts,
  type TransitionLabelsResult,
} from "./labels.js";
export {
  createIssueNote,
  createMrInlineNote,
  createMrNote,
  deleteMrNotes,
  findLatestIssuePilotWorkpadNote,
  findWorkpadNote,
  GitLabScopeMissingError,
  updateIssueNote,
  type CreateIssueNoteResult,
  type CreateMrInlineNoteInput,
  type CreateMrInlineNoteResult,
  type CreateMrNoteInput,
  type DeleteMrNotesInput,
  type DeleteMrNotesResult,
  type WorkpadNote,
} from "./notes.js";
export {
  createMergeRequest,
  findMergeRequestBySourceBranch,
  getMergeRequest,
  listMergeRequestsBySourceBranch,
  listMergeRequestNotes,
  updateMergeRequest,
  type CreateMergeRequestInput,
  type CreatedMergeRequest,
  type MergeRequestNote,
  type MergeRequestSummary,
  type MergeRequestUpdates,
  type SourceBranchMergeRequestDetail,
  type SourceBranchMergeRequestSummary,
} from "./merge-requests.js";
export {
  classifyPipelineStatus,
  getPipelineStatus,
  type PipelineStatus,
} from "./pipelines.js";
export type { GitLabAdapter, GitLabErrorCategory, IssueRef } from "./types.js";

export const PACKAGE_NAME = "@issuepilot/tracker-gitlab";
export const VERSION = "0.0.0";
