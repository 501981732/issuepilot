/**
 * Internal types for `@issuepilot/tracker-gitlab`.
 *
 * Only types that are part of the package's public adapter surface should land
 * here. Anything wider (e.g. shared between orchestrator and dashboard) lives
 * in `@issuepilot/shared-contracts`.
 */

import type { IssueRef } from "@issuepilot/shared-contracts";

export type { IssueRef };

/**
 * Coarse-grained classification of GitLab API errors. Maps directly to the
 * three-way orchestrator outcome (blocked / failed / retryable) in spec §13:
 * `auth | permission | not_found | validation | unknown` are blocking;
 * `rate_limit | transient` are retryable.
 */
export type GitLabErrorCategory =
  | "auth"
  | "permission"
  | "not_found"
  | "validation"
  | "rate_limit"
  | "transient"
  | "unknown";

export interface GitLabAdapter {
  listCandidateIssues(opts: {
    activeLabels: readonly string[];
    excludeLabels: readonly string[];
    perPage?: number;
  }): Promise<IssueRef[]>;

  getIssue(
    iid: number,
  ): Promise<IssueRef & { description: string; state?: string }>;

  closeIssue(
    iid: number,
    opts: {
      removeLabels: readonly string[];
      requireCurrent?: readonly string[];
    },
  ): Promise<{ labels: string[]; state: string | undefined }>;

  transitionLabels(
    iid: number,
    opts: {
      add: readonly string[];
      remove: readonly string[];
      requireCurrent?: readonly string[];
    },
  ): Promise<{ labels: string[] }>;

  createIssueNote(iid: number, body: string): Promise<{ id: number }>;
  updateIssueNote(iid: number, noteId: number, body: string): Promise<void>;
  findWorkpadNote(
    iid: number,
    marker: string,
  ): Promise<{ id: number; body: string } | null>;
  findLatestIssuePilotWorkpadNote(
    iid: number,
  ): Promise<{ id: number; body: string } | null>;

  findMergeRequestBySourceBranch(sourceBranch: string): Promise<{
    iid: number;
    webUrl: string;
    state: string;
    sourceBranch: string;
    title: string;
    description: string;
    updatedAt?: string;
  } | null>;
  createMergeRequest(input: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    issueIid: number;
  }): Promise<{ id: number; iid: number; webUrl: string }>;
  updateMergeRequest(
    mrIid: number,
    input: Partial<{
      title: string;
      description: string;
      targetBranch: string;
    }>,
  ): Promise<void>;
  getMergeRequest(
    mrIid: number,
  ): Promise<{
    iid: number;
    webUrl: string;
    state: string;
    diffRefs?: { baseSha: string; startSha: string; headSha: string };
  }>;
  listMergeRequestsBySourceBranch(sourceBranch: string): Promise<
    Array<{
      iid: number;
      webUrl: string;
      state: string;
      sourceBranch: string;
      updatedAt?: string;
    }>
  >;
  listMergeRequestNotes(
    mrIid: number,
  ): Promise<
    Array<{
      id: number;
      body: string;
      author: string;
      system: boolean;
      createdAt?: string;
      updatedAt?: string;
      resolvable?: boolean;
      resolved?: boolean;
    }>
  >;

  getPipelineStatus(
    ref: string,
  ): Promise<
    "running" | "success" | "failed" | "pending" | "canceled" | "unknown"
  >;
}
