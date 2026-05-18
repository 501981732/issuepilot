import { describe, expect, it } from "vitest";

import { classifyQualityPatterns } from "../patterns.js";
import type { QualitySourceItem } from "../types.js";

function runSource(over: Partial<Extract<QualitySourceItem, { kind: "run" }>>): QualitySourceItem {
  return {
    kind: "run",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    runId: "run-1",
    runStatus: "completed",
    issue: {
      projectId: "proj-a",
      iid: 1,
      title: "Issue",
      url: "https://gitlab.example/1",
      labels: [],
    },
    checks: [],
    risks: [],
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

function taskSource(over: Partial<Extract<QualitySourceItem, { kind: "task" }>>): QualitySourceItem {
  return {
    kind: "task",
    projectId: "proj-a",
    workflow: "unknown",
    taskType: "unknown",
    workItemId: "wi-1",
    workItemTitle: "WI",
    taskId: "t1",
    taskTitle: "Task",
    taskStatus: "completed",
    checklistReasons: [],
    evidenceCount: 1,
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...over,
  } as QualitySourceItem;
}

describe("classifyQualityPatterns", () => {
  it("classifies permission issues", () => {
    const patterns = classifyQualityPatterns(
      runSource({
        runId: "run-1",
        runStatus: "failed",
        lastError: {
          code: "gitlab_403",
          message: "403 access denied",
          classification: "failed",
        },
      }),
    );
    expect(patterns).toContainEqual(
      expect.objectContaining({
        patternId: "permission-issue",
        reason: expect.stringContaining("403"),
      }),
    );
  });

  it("classifies missing tests when checks are empty", () => {
    expect(
      classifyQualityPatterns(
        runSource({ checks: [], risks: [], runStatus: "completed" }),
      ).map((p) => p.patternId),
    ).toContain("missing-tests");
  });

  it("classifies missing tests when task has no evidence", () => {
    expect(
      classifyQualityPatterns(
        taskSource({ taskStatus: "completed", evidenceCount: 0 }),
      ).map((p) => p.patternId),
    ).toContain("missing-tests");
  });

  it("classifies review rework", () => {
    expect(
      classifyQualityPatterns(
        taskSource({
          taskStatus: "needs_rework",
          needsReworkReason: "Reviewer requested unit tests",
        }),
      ).map((p) => p.patternId),
    ).toContain("review-rework");
  });

  it("classifies review rework from unresolved feedback on a run", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          reviewFeedback: { unresolvedCount: 2, comments: [] },
        }),
      ).map((p) => p.patternId),
    ).toContain("review-rework");
  });

  it("classifies unclear requirements", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "blocked",
          lastError: {
            code: "blocked",
            message: "missing acceptance criteria",
          },
        }),
      ).map((p) => p.patternId),
    ).toContain("unclear-requirements");
  });

  it("classifies environment issues", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          lastError: {
            code: "setup",
            message: "dependency install timeout",
          },
        }),
      ).map((p) => p.patternId),
    ).toContain("environment-issue");
  });

  it("classifies ci failure", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "failed",
          ciStatus: "failed",
        }),
      ).map((p) => p.patternId),
    ).toContain("ci-failure");
  });

  it("classifies missing evidence on task checklist", () => {
    expect(
      classifyQualityPatterns(
        taskSource({
          taskStatus: "completed",
          checklistReasons: ["missing-evidence"],
        }),
      ).map((p) => p.patternId),
    ).toContain("missing-evidence");
  });

  it("classifies missing evidence when report is incomplete", () => {
    expect(
      classifyQualityPatterns(
        taskSource({ reportStatus: "incomplete" }),
      ).map((p) => p.patternId),
    ).toContain("missing-evidence");
  });

  it("can emit multiple patterns for a single item", () => {
    const patterns = classifyQualityPatterns(
      runSource({
        runStatus: "failed",
        ciStatus: "failed",
        lastError: {
          code: "permission",
          message: "401 unauthorized; missing token",
        },
      }),
    );
    const ids = patterns.map((p) => p.patternId);
    expect(ids).toEqual(expect.arrayContaining(["permission-issue", "ci-failure"]));
  });

  it("does not classify completed runs with checks as missing-tests", () => {
    expect(
      classifyQualityPatterns(
        runSource({
          runStatus: "completed",
          checks: [
            { name: "unit", status: "passed" },
          ],
        }),
      ).map((p) => p.patternId),
    ).not.toContain("missing-tests");
  });
});
