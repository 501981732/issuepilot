import { describe, expect, it, vi } from "vitest";

import type { GitLabApi, RawMergeRequest } from "../api-shape.js";
import { createGitLabClient, type GitLabClient } from "../client.js";
import {
  createMergeRequest,
  findMergeRequestBySourceBranch,
  getMergeRequest,
  listMergeRequestsBySourceBranch,
  listMergeRequestNotes,
  updateMergeRequest,
} from "../merge-requests.js";

function makeClient(api: Partial<GitLabApi>): GitLabClient<GitLabApi> {
  return createGitLabClient<GitLabApi>({
    baseUrl: "https://gitlab.example.com",
    tokenEnv: "GL_TOKEN",
    projectId: "group/project",
    env: { get: () => "tok" },
    GitlabCtor: function GitlabStub(this: object) {
      Object.assign(this, api);
    } as never,
  });
}

const mrRow = (over: Partial<RawMergeRequest> = {}): RawMergeRequest => ({
  id: 1,
  iid: 1,
  web_url: "https://gitlab.example.com/g/p/-/merge_requests/1",
  state: "opened",
  source_branch: "ai/42-add-x",
  target_branch: "main",
  title: "t",
  description: null,
  ...over,
});

describe("createMergeRequest", () => {
  it("returns existing opened MR for the same source branch (idempotent)", async () => {
    const all = vi.fn(async () => [
      mrRow({
        id: 9,
        iid: 5,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/5",
        state: "opened",
        source_branch: "ai/42-add-x",
      }),
    ]);
    const create = vi.fn();
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "feat: x",
      description: "body",
      issueIid: 42,
    });
    expect(r).toEqual({
      id: 9,
      iid: 5,
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/5",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a new MR when no opened MR exists for the source branch", async () => {
    const all = vi.fn(async () => []);
    const create = vi.fn(async () =>
      mrRow({
        id: 11,
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
        source_branch: "ai/42-add-x",
        target_branch: "main",
      }),
    );
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "feat: x",
      description: "body",
      issueIid: 42,
    });
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      state: "opened",
      perPage: 5,
    });
    expect(create).toHaveBeenCalledWith(
      "group/project",
      "ai/42-add-x",
      "main",
      "feat: x",
      { description: "body" },
    );
    expect(r.iid).toBe(6);
  });

  it("ignores closed/merged MRs for the same branch and creates fresh", async () => {
    const all = vi.fn(async () => [
      mrRow({ state: "merged", source_branch: "ai/42-add-x" }),
      mrRow({ state: "closed", source_branch: "ai/42-add-x" }),
    ]);
    const create = vi.fn(async () =>
      mrRow({ id: 22, iid: 7, source_branch: "ai/42-add-x" }),
    );
    const client = makeClient({
      MergeRequests: { all, create, edit: vi.fn(), show: vi.fn() },
    });
    const r = await createMergeRequest(client, {
      sourceBranch: "ai/42-add-x",
      targetBranch: "main",
      title: "t",
      description: "d",
      issueIid: 42,
    });
    expect(create).toHaveBeenCalled();
    expect(r.iid).toBe(7);
  });
});

describe("updateMergeRequest", () => {
  it("forwards only the provided fields", async () => {
    const edit = vi.fn(async () => mrRow());
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit,
        show: vi.fn(),
      },
    });
    await updateMergeRequest(client, 5, { title: "new title" });
    expect(edit).toHaveBeenCalledWith("group/project", 5, {
      title: "new title",
    });
  });

  it("skips the GitLab call entirely when nothing changed", async () => {
    const edit = vi.fn();
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit,
        show: vi.fn(),
      },
    });
    await updateMergeRequest(client, 5, {});
    expect(edit).not.toHaveBeenCalled();
  });
});

describe("getMergeRequest", () => {
  it("projects state and webUrl from the raw row", async () => {
    const show = vi.fn(async () =>
      mrRow({
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
      }),
    );
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit: vi.fn(),
        show,
      },
    });
    expect(await getMergeRequest(client, 6)).toEqual({
      iid: 6,
      webUrl: "https://gitlab.example.com/g/p/-/merge_requests/6",
      state: "opened",
    });
  });

  it("maps GitLab diff_refs into camelCase diffRefs", async () => {
    const show = vi.fn(async () =>
      mrRow({
        iid: 6,
        diff_refs: {
          base_sha: "base123",
          start_sha: "start123",
          head_sha: "head123",
        },
      }),
    );
    const client = makeClient({
      MergeRequests: {
        all: vi.fn(),
        create: vi.fn(),
        edit: vi.fn(),
        show,
      },
    });
    expect(await getMergeRequest(client, 6)).toEqual(
      expect.objectContaining({
        diffRefs: {
          baseSha: "base123",
          startSha: "start123",
          headSha: "head123",
        },
      }),
    );
  });
});

describe("findMergeRequestBySourceBranch", () => {
  it("returns the opened MR detail for an exact source branch", async () => {
    const all = vi.fn(async () => [
      mrRow({
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
        source_branch: "ai/42-add-x",
        title: "MR title",
        description: "MR body",
        updated_at: "2026-05-14T01:02:03Z",
      }),
    ]);
    const client = makeClient({
      MergeRequests: {
        all,
        create: vi.fn(),
        edit: vi.fn(),
        show: vi.fn(),
      },
    });

    expect(await findMergeRequestBySourceBranch(client, "ai/42-add-x")).toEqual(
      {
        iid: 6,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "opened",
        sourceBranch: "ai/42-add-x",
        title: "MR title",
        description: "MR body",
        updatedAt: "2026-05-14T01:02:03Z",
      },
    );
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      state: "opened",
      perPage: 5,
    });
  });

  it("ignores non-open or mismatched source branch rows", async () => {
    const all = vi.fn(async () => [
      mrRow({ state: "merged", source_branch: "ai/42-add-x" }),
      mrRow({ state: "opened", source_branch: "ai/other" }),
    ]);
    const client = makeClient({
      MergeRequests: {
        all,
        create: vi.fn(),
        edit: vi.fn(),
        show: vi.fn(),
      },
    });

    expect(await findMergeRequestBySourceBranch(client, "ai/42-add-x")).toBe(
      null,
    );
  });
});

describe("listMergeRequestsBySourceBranch", () => {
  it("returns MR summaries for a source branch without filtering state", async () => {
    const all = vi.fn(async () => [
      mrRow({
        iid: 6,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "merged",
        source_branch: "ai/42-add-x",
        updated_at: "2026-05-14T01:02:03Z",
      }),
      mrRow({
        iid: 7,
        web_url: "https://gitlab.example.com/g/p/-/merge_requests/7",
        state: "closed",
        source_branch: "ai/42-add-x",
      }),
    ]);
    const client = makeClient({
      MergeRequests: {
        all,
        create: vi.fn(),
        edit: vi.fn(),
        show: vi.fn(),
      },
    });

    expect(
      await listMergeRequestsBySourceBranch(client, "ai/42-add-x"),
    ).toEqual([
      {
        iid: 6,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/6",
        state: "merged",
        sourceBranch: "ai/42-add-x",
        updatedAt: "2026-05-14T01:02:03Z",
      },
      {
        iid: 7,
        webUrl: "https://gitlab.example.com/g/p/-/merge_requests/7",
        state: "closed",
        sourceBranch: "ai/42-add-x",
      },
    ]);
    expect(all).toHaveBeenCalledWith({
      projectId: "group/project",
      sourceBranch: "ai/42-add-x",
      perPage: 20,
    });
  });
});

describe("listMergeRequestNotes", () => {
  it("maps the GitLab note rows and falls back to 'unknown' author", async () => {
    const all = vi.fn(async () => [
      {
        id: 1,
        body: "hello",
        author: { username: "alice", name: "Alice" },
        system: false,
      },
      {
        id: 2,
        body: "bot",
        author: { username: null, name: "Bot" },
        system: false,
      },
      { id: 3, body: "anon", author: null, system: false },
    ]);
    const client = makeClient({
      MergeRequestNotes: { all },
    });
    const r = await listMergeRequestNotes(client, 6);
    expect(r).toEqual([
      { id: 1, body: "hello", author: "alice", system: false },
      { id: 2, body: "bot", author: "Bot", system: false },
      { id: 3, body: "anon", author: "unknown", system: false },
    ]);
    expect(all).toHaveBeenCalledWith("group/project", 6, { perPage: 100 });
  });

  it("exposes timestamps + resolved markers required by the review feedback sweep (V2 Phase 4)", async () => {
    const all = vi.fn(async () => [
      {
        id: 11,
        body: "Please remove the debug log.",
        author: { username: "alice", name: "Alice" },
        created_at: "2026-05-16T00:01:00.000Z",
        updated_at: "2026-05-16T00:01:00.000Z",
        system: false,
        resolvable: true,
        resolved: false,
      },
      {
        id: 12,
        body: "removed: ai-ready",
        author: { username: "issuepilot-bot", name: "IssuePilot" },
        created_at: "2026-05-16T00:00:30.000Z",
        updated_at: "2026-05-16T00:00:30.000Z",
        system: true,
      },
      {
        id: 13,
        body: "Acknowledged.",
        author: { username: "bob", name: "Bob" },
        created_at: "2026-05-16T00:02:00.000Z",
        updated_at: "2026-05-16T00:02:00.000Z",
        system: false,
        resolvable: true,
        resolved: true,
      },
    ]);
    const client = makeClient({
      MergeRequestNotes: { all },
    });

    const r = await listMergeRequestNotes(client, 7);

    expect(r[0]).toMatchObject({
      id: 11,
      author: "alice",
      body: "Please remove the debug log.",
      createdAt: "2026-05-16T00:01:00.000Z",
      updatedAt: "2026-05-16T00:01:00.000Z",
      system: false,
      resolvable: true,
      resolved: false,
    });
    expect(r[1]).toMatchObject({
      id: 12,
      system: true,
    });
    expect(r[2]).toMatchObject({
      id: 13,
      resolved: true,
    });
  });
});
