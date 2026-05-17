import { describe, it, expect, expectTypeOf } from "vitest";

import {
  PIPELINE_STATUS_VALUES,
  RUN_STATUS_VALUES,
  isPipelineStatus,
  isRunStatus,
  type PipelineStatus,
  type RunRecord,
  type RunStatus,
} from "../run.js";

describe("@issuepilot/shared-contracts/run", () => {
  it("RUN_STATUS_VALUES enumerates the seven dashboard-visible statuses", () => {
    expect(new Set(RUN_STATUS_VALUES)).toEqual(
      new Set([
        "claimed",
        "running",
        "retrying",
        "stopping",
        "completed",
        "failed",
        "blocked",
      ]),
    );
  });

  it("RunRecord.workItem carries V4.1 synthetic task metadata", () => {
    const run: RunRecord = {
      runId: "run_a",
      issue: {
        id: "1",
        iid: 1,
        title: "T",
        url: "u",
        projectId: "g/p",
        labels: [],
      },
      status: "claimed",
      attempt: 1,
      branch: "ai/1",
      workspacePath: "/tmp",
      startedAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:01.000Z",
      workItem: { workItemId: "wi_01", taskId: "t1" },
    };
    expect(run.workItem?.taskId).toBe("t1");
    expect(JSON.parse(JSON.stringify(run))).toEqual(run);
  });

  it("isRunStatus narrows known strings and rejects unknown ones", () => {
    expect(isRunStatus("running")).toBe(true);
    expect(isRunStatus("nope")).toBe(false);
    expect(isRunStatus(42)).toBe(false);
    expect(isRunStatus(undefined)).toBe(false);
  });

  it("RunStatus is exactly the union of RUN_STATUS_VALUES", () => {
    expectTypeOf<RunStatus>().toEqualTypeOf<
      (typeof RUN_STATUS_VALUES)[number]
    >();
  });

  it("RunRecord requires runId / issue / status / attempt / branch / workspacePath / startedAt / updatedAt", () => {
    expectTypeOf<RunRecord>().toHaveProperty("runId").toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("status")
      .toEqualTypeOf<RunStatus>();
    expectTypeOf<RunRecord>().toHaveProperty("attempt").toEqualTypeOf<number>();
    expectTypeOf<RunRecord>().toHaveProperty("branch").toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("workspacePath")
      .toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("startedAt")
      .toEqualTypeOf<string>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("updatedAt")
      .toEqualTypeOf<string>();
  });

  it("allows runs to carry team project metadata", () => {
    const run: RunRecord = {
      runId: "run-1",
      status: "running",
      attempt: 1,
      issue: {
        id: "1",
        iid: 1,
        title: "Fix checkout",
        url: "https://gitlab.example.com/group/platform-web/-/issues/1",
        projectId: "group/platform-web",
        labels: ["ai-running"],
      },
      branch: "ai/1-fix",
      workspacePath: "/tmp/issuepilot/platform-web/1",
      projectId: "platform-web",
      projectName: "Platform Web",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
    };

    expect(run.projectId).toBe("platform-web");
    expect(run.projectName).toBe("Platform Web");
  });

  it("accepts stopping run status", () => {
    expect(isRunStatus("stopping")).toBe(true);
  });

  it("allows RunRecord to carry archivedAt", () => {
    const run: RunRecord = {
      runId: "run-1",
      issue: {
        id: "1",
        iid: 1,
        title: "Fix checkout",
        url: "https://gitlab.example.com/group/web/-/issues/1",
        projectId: "group/web",
        labels: ["ai-failed"],
      },
      status: "failed",
      attempt: 1,
      branch: "ai/1-fix",
      workspacePath: "/tmp/run-1",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:01.000Z",
      archivedAt: "2026-05-15T00:01:00.000Z",
    };

    expect(run.archivedAt).toBe("2026-05-15T00:01:00.000Z");
  });

  it("PIPELINE_STATUS_VALUES enumerates the six tracker-coarsed statuses", () => {
    expect(new Set(PIPELINE_STATUS_VALUES)).toEqual(
      new Set([
        "running",
        "success",
        "failed",
        "pending",
        "canceled",
        "unknown",
      ]),
    );
  });

  it("isPipelineStatus narrows known strings and rejects unknown ones", () => {
    expect(isPipelineStatus("success")).toBe(true);
    expect(isPipelineStatus("failed")).toBe(true);
    expect(isPipelineStatus("nope")).toBe(false);
    expect(isPipelineStatus(undefined)).toBe(false);
  });

  it("allows RunRecord to carry the review feedback cursor and the latest summary (V2 Phase 4)", () => {
    const run: RunRecord = {
      runId: "run-1",
      issue: {
        id: "1",
        iid: 1,
        title: "Fix",
        url: "https://gitlab.example.com/group/web/-/issues/1",
        projectId: "group/web",
        labels: ["human-review"],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/1-fix",
      workspacePath: "/tmp/run-1",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:02:00.000Z",
      lastDiscussionCursor: "2026-05-15T00:01:30.000Z",
      latestReviewFeedback: {
        mrIid: 42,
        mrUrl: "https://gitlab.example.com/group/web/-/merge_requests/42",
        generatedAt: "2026-05-15T00:02:00.000Z",
        cursor: "2026-05-15T00:01:30.000Z",
        comments: [
          {
            noteId: 7,
            author: "alice",
            body: "Please add a test for the empty branch path.",
            url: "https://gitlab.example.com/group/web/-/merge_requests/42#note_7",
            createdAt: "2026-05-15T00:01:30.000Z",
            resolved: false,
          },
        ],
      },
    };

    expect(run.lastDiscussionCursor).toBe("2026-05-15T00:01:30.000Z");
    expect(run.latestReviewFeedback?.comments).toHaveLength(1);
    expect(run.latestReviewFeedback?.cursor).toBe("2026-05-15T00:01:30.000Z");
  });

  it("allows RunRecord to carry latestCiStatus + latestCiCheckedAt", () => {
    const run: RunRecord = {
      runId: "run-1",
      issue: {
        id: "1",
        iid: 1,
        title: "Fix",
        url: "https://gitlab.example.com/group/web/-/issues/1",
        projectId: "group/web",
        labels: ["human-review"],
      },
      status: "completed",
      attempt: 1,
      branch: "ai/1-fix",
      workspacePath: "/tmp/run-1",
      startedAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:01:00.000Z",
      latestCiStatus: "failed",
      latestCiCheckedAt: "2026-05-15T00:01:30.000Z",
    };

    expect(run.latestCiStatus).toBe("failed");
    expectTypeOf(run.latestCiStatus).toEqualTypeOf<PipelineStatus | undefined>();
  });

  it("RunRecord.mergeRequestUrl / endedAt / lastError / dashboard metadata are optional", () => {
    expectTypeOf<RunRecord>()
      .toHaveProperty("mergeRequestUrl")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("endedAt")
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("lastError")
      .toEqualTypeOf<{ code: string; message: string } | undefined>();
    expectTypeOf<RunRecord>()
      .toHaveProperty("turnCount")
      .toEqualTypeOf<number | undefined>();
    expectTypeOf<RunRecord>().toHaveProperty("lastEvent").toEqualTypeOf<
      | {
          type: string;
          message: string;
          createdAt?: string;
        }
      | undefined
    >();
  });
});
