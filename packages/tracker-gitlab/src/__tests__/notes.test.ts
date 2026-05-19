import { describe, expect, it, vi } from "vitest";

import type {
  GitLabApi,
  MergeRequestNotePosition,
  RawIssueNote,
} from "../api-shape.js";
import { createGitLabClient, type GitLabClient } from "../client.js";
import { GitLabError } from "../errors.js";
import {
  createIssueNote,
  createMrInlineNote,
  createMrNote,
  deleteMrNotes,
  findLatestIssuePilotWorkpadNote,
  findWorkpadNote,
  GitLabScopeMissingError,
  updateIssueNote,
} from "../notes.js";

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

const note = (over: Partial<RawIssueNote>): RawIssueNote => ({
  id: 1,
  body: "",
  author: null,
  system: false,
  ...over,
});

const marker = (runId: string) => `<!-- issuepilot:run=${runId} -->`;

describe("createIssueNote", () => {
  it("delegates to IssueNotes.create and returns the new note id", async () => {
    const create = vi.fn(async () => note({ id: 100, body: "x" }));
    const client = makeClient({
      IssueNotes: { all: vi.fn(), create, edit: vi.fn() },
    });
    const r = await createIssueNote(client, 42, "hello");
    expect(create).toHaveBeenCalledWith("group/project", 42, "hello");
    expect(r).toEqual({ id: 100 });
  });
});

describe("updateIssueNote", () => {
  it("delegates to IssueNotes.edit with the new body", async () => {
    const edit = vi.fn(async () => note({ id: 7, body: "new" }));
    const client = makeClient({
      IssueNotes: { all: vi.fn(), create: vi.fn(), edit },
    });
    await updateIssueNote(client, 42, 7, "new");
    expect(edit).toHaveBeenCalledWith("group/project", 42, 7, { body: "new" });
  });
});

describe("findWorkpadNote", () => {
  it("returns the first non-system note whose first line equals the marker", async () => {
    const m = marker("run-abc");
    const all = vi.fn(async () => [
      note({ id: 1, body: "unrelated comment", system: false }),
      note({ id: 2, body: "label change", system: true }),
      note({ id: 3, body: `${m}\n## Run summary\nhello`, system: false }),
      note({ id: 4, body: `${m}\nlater`, system: false }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    const r = await findWorkpadNote(client, 42, m);
    expect(r).toEqual({ id: 3, body: `${m}\n## Run summary\nhello` });
    expect(all).toHaveBeenCalledWith("group/project", 42, { perPage: 100 });
  });

  it("ignores system notes even when their first line matches", async () => {
    const m = marker("run-xyz");
    const all = vi.fn(async () => [
      note({ id: 9, body: `${m}\nsystem`, system: true }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(await findWorkpadNote(client, 42, m)).toBeNull();
  });

  it("only matches when the marker is on the first line", async () => {
    const m = marker("run-1");
    const all = vi.fn(async () => [
      note({ id: 1, body: `intro\n${m}` }),
      note({ id: 2, body: `  ${m}  ` }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    const r = await findWorkpadNote(client, 42, m);
    expect(r?.id).toBe(2);
  });

  it("returns null when no note matches the marker", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "hi" }),
      note({ id: 2, body: "<!-- issuepilot:run=other -->\nbody" }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(await findWorkpadNote(client, 42, marker("missing"))).toBeNull();
  });

  it("handles empty / undefined body gracefully", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "" }),
      note({ id: 2, body: undefined as unknown as string }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });
    expect(await findWorkpadNote(client, 42, marker("x"))).toBeNull();
  });
});

describe("findLatestIssuePilotWorkpadNote", () => {
  it("returns the first matching workpad note from newest-first GitLab rows", async () => {
    const all = vi.fn(async () => [
      note({
        id: 5,
        body: "<!-- issuepilot:run=latest -->\nlatest",
        system: false,
      }),
      note({
        id: 4,
        body: "<!-- issuepilot:run:system -->\nsystem",
        system: true,
      }),
      note({ id: 3, body: "unrelated", system: false }),
      note({ id: 2, body: "<!-- issuepilot:run:older -->\nolder" }),
      note({ id: 1, body: "<!-- issuepilot:run=oldest -->\noldest" }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });

    expect(await findLatestIssuePilotWorkpadNote(client, 42)).toEqual({
      id: 5,
      body: "<!-- issuepilot:run=latest -->\nlatest",
    });
    expect(all).toHaveBeenCalledWith("group/project", 42, {
      perPage: 100,
      orderBy: "updated_at",
      sort: "desc",
    });
  });

  it("supports colon markers after ignoring newer system notes", async () => {
    const all = vi.fn(async () => [
      note({
        id: 3,
        body: "<!-- issuepilot:run=system -->\nsystem",
        system: true,
      }),
      note({ id: 2, body: "<!-- issuepilot:run:latest -->\nlatest" }),
      note({ id: 1, body: "<!-- issuepilot:run=older -->\nolder" }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });

    expect(await findLatestIssuePilotWorkpadNote(client, 42)).toEqual({
      id: 2,
      body: "<!-- issuepilot:run:latest -->\nlatest",
    });
  });

  it("returns null when no non-system IssuePilot workpad note exists", async () => {
    const all = vi.fn(async () => [
      note({ id: 1, body: "<!-- issuepilot:other=x -->\nbody" }),
      note({
        id: 2,
        body: "<!-- issuepilot:run=system -->\nbody",
        system: true,
      }),
    ]);
    const client = makeClient({
      IssueNotes: { all, create: vi.fn(), edit: vi.fn() },
    });

    expect(await findLatestIssuePilotWorkpadNote(client, 42)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// V4.6 reviewer publish flow: MR notes (create / inline-create / batch delete)
// ────────────────────────────────────────────────────────────────────────────

const mrPosition = (
  over: Partial<MergeRequestNotePosition> = {},
): MergeRequestNotePosition => ({
  position_type: "text",
  base_sha: "base-sha",
  start_sha: "start-sha",
  head_sha: "head-sha",
  new_path: "src/foo.ts",
  old_path: "src/foo.ts",
  new_line: 12,
  ...over,
});

function makeMrClient(api: Partial<GitLabApi["MergeRequestNotes"]>) {
  const create = api.create ?? vi.fn();
  const remove = api.remove ?? vi.fn();
  return makeClient({
    MergeRequestNotes: {
      all: vi.fn(),
      create,
      remove,
    },
  });
}

function statusError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

describe("createMrNote", () => {
  it("delegates to MergeRequestNotes.create without a position and returns the new note id", async () => {
    const create = vi.fn(async () => note({ id: 7001, body: "main note" }));
    const client = makeMrClient({ create });
    const result = await createMrNote({
      client,
      mrIid: 42,
      body: "main note",
    });
    expect(create).toHaveBeenCalledWith("group/project", 42, "main note");
    expect(result).toEqual({ id: 7001 });
  });

  it("translates 401 / 403 into GitLabScopeMissingError annotated with the required scope", async () => {
    const create = vi.fn(async () => {
      throw statusError(403);
    });
    const client = makeMrClient({ create });
    await expect(
      createMrNote({
        client,
        mrIid: 42,
        body: "noop",
        requiredScope: "api",
      }),
    ).rejects.toMatchObject({
      name: "GitLabScopeMissingError",
      missingScope: "api",
      category: "permission",
      status: 403,
    });
  });

  it("re-throws non-auth GitLab errors unchanged so callers can fail soft", async () => {
    const create = vi.fn(async () => {
      throw statusError(500);
    });
    const client = makeMrClient({ create });
    await expect(
      createMrNote({ client, mrIid: 42, body: "noop" }),
    ).rejects.toBeInstanceOf(GitLabError);
    await expect(
      createMrNote({ client, mrIid: 42, body: "noop" }),
    ).rejects.not.toBeInstanceOf(GitLabScopeMissingError);
  });
});

describe("createMrInlineNote", () => {
  it("delegates to MergeRequestNotes.create passing the position payload and returns the new note id", async () => {
    const create = vi.fn(async () => note({ id: 9001, body: "inline" }));
    const client = makeMrClient({ create });
    const position = mrPosition({ new_line: 12 });

    const result = await createMrInlineNote({
      client,
      mrIid: 7,
      body: "inline finding",
      position,
    });

    expect(create).toHaveBeenCalledWith(
      "group/project",
      7,
      "inline finding",
      { position },
    );
    expect(result).toEqual({ id: 9001 });
  });

  it("translates 401 into GitLabScopeMissingError defaulting missing scope to 'unknown' if caller omits it", async () => {
    const create = vi.fn(async () => {
      throw statusError(401);
    });
    const client = makeMrClient({ create });

    let captured: unknown;
    try {
      await createMrInlineNote({
        client,
        mrIid: 7,
        body: "x",
        position: mrPosition(),
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(GitLabScopeMissingError);
    expect((captured as GitLabScopeMissingError).missingScope).toBe("unknown");
    expect((captured as GitLabScopeMissingError).category).toBe("auth");
  });
});

describe("deleteMrNotes", () => {
  it("calls MergeRequestNotes.remove for each note id and returns the deleted ids", async () => {
    const remove = vi.fn(async () => undefined);
    const client = makeMrClient({ remove });

    const result = await deleteMrNotes({
      client,
      mrIid: 7,
      noteIds: [10, 20, 30],
    });

    expect(remove.mock.calls).toEqual([
      ["group/project", 7, 10],
      ["group/project", 7, 20],
      ["group/project", 7, 30],
    ]);
    expect(result).toEqual({
      deletedNoteIds: [10, 20, 30],
      missingNoteIds: [],
    });
  });

  it("treats per-note 404 as idempotent success (note already gone)", async () => {
    const remove = vi.fn(async (_p: string, _iid: number, noteId: number) => {
      if (noteId === 20) throw statusError(404);
      return undefined;
    });
    const client = makeMrClient({ remove });

    const result = await deleteMrNotes({
      client,
      mrIid: 7,
      noteIds: [10, 20, 30],
    });

    expect(result).toEqual({
      deletedNoteIds: [10, 30],
      missingNoteIds: [20],
    });
  });

  it("propagates a GitLabScopeMissingError on 401 / 403 so callers can record scope_insufficient", async () => {
    const remove = vi.fn(async () => {
      throw statusError(403);
    });
    const client = makeMrClient({ remove });

    await expect(
      deleteMrNotes({
        client,
        mrIid: 7,
        noteIds: [10],
        requiredScope: "api",
      }),
    ).rejects.toMatchObject({
      name: "GitLabScopeMissingError",
      missingScope: "api",
    });
  });

  it("propagates non-auth errors unchanged so callers can mark publish_failed", async () => {
    const remove = vi.fn(async () => {
      throw statusError(500);
    });
    const client = makeMrClient({ remove });

    await expect(
      deleteMrNotes({ client, mrIid: 7, noteIds: [10] }),
    ).rejects.toBeInstanceOf(GitLabError);
    await expect(
      deleteMrNotes({ client, mrIid: 7, noteIds: [10] }),
    ).rejects.not.toBeInstanceOf(GitLabScopeMissingError);
  });

  it("returns an empty result without contacting the API when noteIds is empty", async () => {
    const remove = vi.fn();
    const client = makeMrClient({ remove });

    const result = await deleteMrNotes({ client, mrIid: 7, noteIds: [] });

    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedNoteIds: [], missingNoteIds: [] });
  });
});

describe("GitLabScopeMissingError", () => {
  it("subclasses GitLabError and exposes the missing scope name", () => {
    const cause = new Error("forbidden");
    const err = new GitLabScopeMissingError("api", { cause, status: 403 });
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.name).toBe("GitLabScopeMissingError");
    expect(err.missingScope).toBe("api");
    expect(err.category).toBe("permission");
    expect(err.status).toBe(403);
  });

  it("classifies status 401 as auth so retry callers don't loop", () => {
    const err = new GitLabScopeMissingError("api", { status: 401 });
    expect(err.category).toBe("auth");
    expect(err.retriable).toBe(false);
  });
});
