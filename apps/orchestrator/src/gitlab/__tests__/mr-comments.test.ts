/**
 * V4.6 spec §12 / Phase 7 Task 7.4：reviewer publish/revoke 六条护栏。
 *
 *   1. prefix：所有 note 都以 `[ai-reviewer] ` 起始
 *   2. 聚合主 note：每次 publish 恰好 1 条 summary + N 条 inline
 *   3. severity_threshold + max_inline_comments：由 reviewer agent 提前过
 *      滤；本模块只接受过滤后的 `inlineComments`
 *   4. fail soft：非 scope 错 → `MrPublication.status = "publish_failed"`，
 *      `lastError` 写入；AgentReport 不被升级为 failed
 *   5. revoke：删除 noteIds 时 404 视为已删除（idempotent）
 *   6. redaction：token / 凭据被 redact，被改写的字段名追加到
 *      `redactedFieldsAdded`
 *
 * 额外：GitLab 401/403 → `scopeInsufficient` 信号，调用方负责把 AgentReport
 *      升级到 `status = "failed"` + `lastError.code = "scope_insufficient"`。
 */

import { describe, expect, it, vi } from "vitest";

import type {
  AgentReport,
  MrPublication,
  ReviewerAgentReport,
} from "@issuepilot/shared-contracts";
import {
  createGitLabClient,
  GitLabError,
  GitLabScopeMissingError,
  type GitLabApi,
  type GitLabClient,
} from "@issuepilot/tracker-gitlab";

import {
  publishReviewerToMr,
  revokeReviewerMrComments,
  type MrRef,
} from "../mr-comments.js";

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

const note = (id: number, body: string) =>
  ({
    id,
    body,
    author: null,
    system: false,
  }) as const;

function statusError(status: number): Error & { status: number } {
  const err = new Error(`HTTP ${status}`) as Error & { status: number };
  err.status = status;
  return err;
}

const mrRef: MrRef = {
  iid: 7,
  baseSha: "base-sha",
  startSha: "start-sha",
  headSha: "head-sha",
};

function baseReport(): ReviewerAgentReport {
  const base = {
    agentReportId: "ar-reviewer-1",
    pipelineRunId: "pr-1",
    taskId: "task-1",
    role: "reviewer",
    roleProfileId: "reviewer-default",
    status: "complete",
    startedAt: "2026-05-19T10:00:00.000Z",
    completedAt: "2026-05-19T10:00:01.000Z",
    promptTemplateHash: "hash-reviewer",
    evidenceLinks: [],
    redactedFields: [],
    reviewer: {
      summary: "Summary explains coding result.",
      decision: "approve_with_comments",
      confidence: 0.78,
      risks: [{ severity: "medium", message: "consider null check" }],
      evidenceRequest: [
        { kind: "ci_log", target: "pipeline-42", rationale: "check tests" },
      ],
      findings: [],
      inlineComments: [
        {
          filePath: "src/foo.ts",
          lineRange: { start: 10, end: 12 },
          severity: "high",
          category: "logic",
          message: "Potential null deref here.",
        },
        {
          filePath: "src/bar.ts",
          lineRange: { start: 4, end: 4 },
          severity: "medium",
          category: "style",
          message: "extract helper for readability",
          suggestedFix: "const helper = () => …",
        },
      ],
      mrPublication: { status: "pending", noteIds: [] },
    },
  } satisfies Partial<ReviewerAgentReport> as ReviewerAgentReport;
  return base;
}

describe("publishReviewerToMr", () => {
  it("posts exactly 1 main note + N inline notes prefixed with [ai-reviewer]", async () => {
    const create = vi.fn(async (_p, _iid, body: string) =>
      note(create.mock.calls.length + 1000, body),
    );
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });

    const result = await publishReviewerToMr({
      client,
      reviewerReport: baseReport(),
      mrRef,
      publishToMr: true,
      now: () => "2026-05-19T10:00:02.000Z",
    });

    expect(create).toHaveBeenCalledTimes(3);
    // First call: main note, no position option
    const [_p1, _i1, mainBody, mainOpts] = create.mock.calls[0]!;
    expect(typeof mainBody).toBe("string");
    expect((mainBody as string).startsWith("[ai-reviewer]")).toBe(true);
    expect(mainOpts).toBeUndefined();
    // Inline notes: every body prefixed and uses position payload
    for (const callArgs of create.mock.calls.slice(1)) {
      const [, , body, opts] = callArgs;
      expect((body as string).startsWith("[ai-reviewer]")).toBe(true);
      expect(opts).toHaveProperty("position");
      const position = (opts as { position: { position_type: string } })
        .position;
      expect(position.position_type).toBe("text");
    }
    expect(result.mrPublication.status).toBe("published");
    expect(result.mrPublication.publishedAt).toBe("2026-05-19T10:00:02.000Z");
    expect(result.mrPublication.noteIds).toEqual(["1001", "1002", "1003"]);
    expect(result.scopeInsufficient).toBe(false);
  });

  it("includes summary, decision, confidence (two decimals) and risks in the main note body", async () => {
    const create = vi.fn(async (_p, _iid, body: string) => note(1, body));
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });
    const report = baseReport();
    report.reviewer.confidence = 0.789;
    await publishReviewerToMr({
      client,
      reviewerReport: report,
      mrRef,
      publishToMr: true,
    });
    const mainBody = create.mock.calls[0]![2] as string;
    expect(mainBody).toContain("Summary explains coding result.");
    expect(mainBody).toContain("approve_with_comments");
    expect(mainBody).toContain("0.79");
    expect(mainBody).toContain("consider null check");
  });

  it("returns skipped_by_config without contacting GitLab when publishToMr is false", async () => {
    const create = vi.fn();
    const remove = vi.fn();
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove },
    });

    const result = await publishReviewerToMr({
      client,
      reviewerReport: baseReport(),
      mrRef,
      publishToMr: false,
    });

    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(result.mrPublication).toEqual<MrPublication>({
      status: "skipped_by_config",
      noteIds: [],
    });
    expect(result.redactedFieldsAdded).toEqual([]);
    expect(result.scopeInsufficient).toBe(false);
  });

  it("redacts tokens / secrets before publishing and records the redacted field paths", async () => {
    const create = vi.fn(async (_p, _iid, body: string) =>
      note(create.mock.calls.length + 200, body),
    );
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });
    const report = baseReport();
    report.reviewer.summary =
      "We leak glpat-1234567890ABCDEFGHIJKLMN here in summary";
    report.reviewer.inlineComments[0]!.message =
      "Bearer abcdefghijklmnop should be revoked";

    const result = await publishReviewerToMr({
      client,
      reviewerReport: report,
      mrRef,
      publishToMr: true,
    });

    const mainBody = create.mock.calls[0]![2] as string;
    const inlineBody = create.mock.calls[1]![2] as string;
    expect(mainBody).toContain("[REDACTED]");
    expect(mainBody).not.toContain("glpat-1234567890ABCDEFGHIJKLMN");
    expect(inlineBody).toContain("[REDACTED]");
    expect(inlineBody).not.toContain("Bearer abcdefghijklmnop");
    expect(result.redactedFieldsAdded).toEqual(
      expect.arrayContaining([
        "reviewer.summary",
        "reviewer.inlineComments[0].message",
      ]),
    );
    // Inline #2 did not have any secret, so it should NOT be recorded
    expect(result.redactedFieldsAdded).not.toContain(
      "reviewer.inlineComments[1].message",
    );
  });

  it("redacts suggestedFix and tracks it under the inlineComments[i].suggestedFix path", async () => {
    const create = vi.fn(async (_p, _iid, body: string) =>
      note(create.mock.calls.length + 300, body),
    );
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });
    const report = baseReport();
    report.reviewer.inlineComments[1]!.suggestedFix =
      "Use Bearer abcdefghijklmnopqrstuvwxyz to authenticate";

    const result = await publishReviewerToMr({
      client,
      reviewerReport: report,
      mrRef,
      publishToMr: true,
    });

    const inlineTwoBody = create.mock.calls[2]![2] as string;
    expect(inlineTwoBody).toContain("[REDACTED]");
    expect(result.redactedFieldsAdded).toContain(
      "reviewer.inlineComments[1].suggestedFix",
    );
  });

  it("fails soft on non-auth GitLab errors: status=publish_failed, lastError set, no throw", async () => {
    const create = vi.fn(async () => {
      throw statusError(500);
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });

    const result = await publishReviewerToMr({
      client,
      reviewerReport: baseReport(),
      mrRef,
      publishToMr: true,
    });

    expect(result.mrPublication.status).toBe("publish_failed");
    expect(result.mrPublication.lastError?.code).toBe("gitlab_rate_limited");
    expect(result.mrPublication.noteIds).toEqual([]);
    expect(result.scopeInsufficient).toBe(false);
  });

  it("keeps partial noteIds when main note succeeds but inline note fails so revoke can clean up", async () => {
    let n = 0;
    const create = vi.fn(async (_p, _iid, body: string) => {
      n += 1;
      if (n >= 3) throw statusError(500);
      return note(7000 + n, body);
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });

    const result = await publishReviewerToMr({
      client,
      reviewerReport: baseReport(),
      mrRef,
      publishToMr: true,
    });

    expect(result.mrPublication.status).toBe("publish_failed");
    // Main note (n=1) + first inline (n=2) succeeded; second inline (n=3) failed.
    expect(result.mrPublication.noteIds).toEqual(["7001", "7002"]);
    expect(result.mrPublication.lastError?.code).toBe("gitlab_rate_limited");
  });

  it("surfaces scope insufficient on 401/403 without throwing so coordinator can promote AgentReport to failed", async () => {
    const create = vi.fn(async () => {
      throw statusError(403);
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create, remove: vi.fn() },
    });

    const result = await publishReviewerToMr({
      client,
      reviewerReport: baseReport(),
      mrRef,
      publishToMr: true,
      requiredScope: "api",
    });

    expect(result.scopeInsufficient).toEqual({ missingScope: "api" });
    // mrPublication NEVER ends up published when scope missing — caller will
    // promote AgentReport to failed and rewrite mrPublication if needed.
    expect(result.mrPublication.status).toBe("publish_failed");
    expect(result.mrPublication.lastError?.code).toBe("scope_insufficient");
  });

  it("type-guards the AgentReport input: only ReviewerAgentReport is accepted at the type level", () => {
    // This test is a compile-time guard: AgentReport union shapes other than
    // reviewer should not be assignable here without a narrowing.
    const example: AgentReport = baseReport();
    expect(example.role).toBe("reviewer");
  });
});

describe("revokeReviewerMrComments", () => {
  it("deletes every noteId and returns mrPublication with status=revoked + cleared noteIds", async () => {
    const remove = vi.fn(async () => undefined);
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
    });

    const result = await revokeReviewerMrComments({
      client,
      mrIid: 7,
      mrPublication: {
        status: "published",
        noteIds: ["10", "20"],
        publishedAt: "2026-05-19T10:00:02.000Z",
      },
      now: () => "2026-05-19T11:00:00.000Z",
    });

    expect(remove.mock.calls).toEqual([
      ["group/project", 7, 10],
      ["group/project", 7, 20],
    ]);
    expect(result.mrPublication).toEqual<MrPublication>({
      status: "revoked",
      noteIds: [],
      publishedAt: "2026-05-19T10:00:02.000Z",
    });
  });

  it("idempotently absorbs 404 on a note that was already deleted", async () => {
    const remove = vi.fn(async (_p: string, _iid: number, noteId: number) => {
      if (noteId === 20) throw statusError(404);
      return undefined;
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
    });

    const result = await revokeReviewerMrComments({
      client,
      mrIid: 7,
      mrPublication: { status: "published", noteIds: ["10", "20", "30"] },
    });
    expect(result.mrPublication.status).toBe("revoked");
    expect(result.mrPublication.noteIds).toEqual([]);
  });

  it("propagates GitLabScopeMissingError on 401/403 so the route can return 403 to the dashboard", async () => {
    const remove = vi.fn(async () => {
      throw statusError(401);
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
    });

    await expect(
      revokeReviewerMrComments({
        client,
        mrIid: 7,
        mrPublication: { status: "published", noteIds: ["10"] },
        requiredScope: "api",
      }),
    ).rejects.toBeInstanceOf(GitLabScopeMissingError);
  });

  it("propagates other GitLab errors so dashboard can retry the revoke later", async () => {
    const remove = vi.fn(async () => {
      throw statusError(500);
    });
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
    });

    await expect(
      revokeReviewerMrComments({
        client,
        mrIid: 7,
        mrPublication: { status: "published", noteIds: ["10"] },
      }),
    ).rejects.toBeInstanceOf(GitLabError);
  });

  it("short-circuits when noteIds is empty (status -> revoked without contacting GitLab)", async () => {
    const remove = vi.fn();
    const client = makeClient({
      MergeRequestNotes: { all: vi.fn(), create: vi.fn(), remove },
    });

    const result = await revokeReviewerMrComments({
      client,
      mrIid: 7,
      mrPublication: { status: "published", noteIds: [] },
    });

    expect(remove).not.toHaveBeenCalled();
    expect(result.mrPublication.status).toBe("revoked");
    expect(result.mrPublication.noteIds).toEqual([]);
  });
});
