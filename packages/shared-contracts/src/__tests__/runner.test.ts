import { describe, expect, it } from "vitest";

import {
  isRunnerCapability,
  isRunnerDescriptor,
  isRunnerEvent,
  isRunnerKind,
  isRunnerResult,
  runnerCapabilityForRole,
  RUNNER_CAPABILITY_VALUES,
  RUNNER_ERROR_CODE_VALUES,
  RUNNER_EVENT_TYPE_VALUES,
  RUNNER_KIND_VALUES,
  type RunnerDescriptor,
  type RunnerEvent,
  type RunnerResult,
} from "../runner.js";

describe("runner contract (V4.7)", () => {
  it("accepts only codex_app_server as V4.7 runner kind", () => {
    expect(isRunnerKind("codex_app_server")).toBe(true);
    expect(isRunnerKind("local_command")).toBe(false);
    expect(isRunnerKind("claude_code")).toBe(false);
    expect([...RUNNER_KIND_VALUES]).toEqual(["codex_app_server"]);
  });

  it("RUNNER_CAPABILITY_VALUES covers role / streaming / fs / tool capabilities", () => {
    expect(new Set(RUNNER_CAPABILITY_VALUES)).toEqual(
      new Set([
        "roles.coder",
        "roles.reviewer",
        "roles.test_evidence",
        "events.streaming",
        "cancel",
        "artifacts",
        "gitlab.tools",
        "filesystem.readonly",
        "filesystem.worktree_write",
      ]),
    );
    expect(isRunnerCapability("roles.coder")).toBe(true);
    expect(isRunnerCapability("roles.planner")).toBe(false);
  });

  it("validates RunnerDescriptor with adapter-specific options", () => {
    const descriptor: RunnerDescriptor = {
      runnerId: "codex_app_server",
      kind: "codex_app_server",
      displayName: "Codex App Server",
      capabilities: [
        "roles.coder",
        "roles.reviewer",
        "roles.test_evidence",
        "events.streaming",
        "cancel",
        "artifacts",
        "gitlab.tools",
        "filesystem.worktree_write",
      ],
      defaultTimeoutSeconds: 1800,
      options: {
        command: "codex app-server",
        maxTurns: 20,
        turnTimeoutMs: 3_600_000,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
      },
    };

    expect(isRunnerDescriptor(descriptor)).toBe(true);
    expect(runnerCapabilityForRole("coder")).toBe("roles.coder");
    expect(runnerCapabilityForRole("reviewer")).toBe("roles.reviewer");
    expect(runnerCapabilityForRole("test_evidence")).toBe(
      "roles.test_evidence",
    );
  });

  it("rejects invalid runner descriptor", () => {
    expect(
      isRunnerDescriptor({
        runnerId: "x",
        kind: "local_command",
        capabilities: ["roles.coder"],
      }),
    ).toBe(false);
    expect(
      isRunnerDescriptor({
        runnerId: "x",
        kind: "codex_app_server",
        capabilities: ["roles.unknown"],
      }),
    ).toBe(false);
    expect(isRunnerDescriptor(null)).toBe(false);
  });

  it("rejects invalid runner result and accepts completed result", () => {
    const ok: RunnerResult = {
      status: "completed",
      finalMessage: "done",
      runId: "turn-1",
      artifacts: [{ kind: "text", summary: "summary" }],
    };

    expect(isRunnerResult(ok)).toBe(true);
    expect(isRunnerResult({ status: "success" })).toBe(false);
    expect(isRunnerResult({ status: "completed", artifacts: "no" })).toBe(
      false,
    );
    expect(
      isRunnerResult({
        status: "failed",
        error: { code: "runner_unavailable", message: "x" },
      }),
    ).toBe(true);
    expect(
      isRunnerResult({
        status: "failed",
        error: { code: "unknown_code", message: "x" },
      }),
    ).toBe(false);
  });

  it("RUNNER_ERROR_CODE_VALUES enumerates V4.7 error space", () => {
    expect(new Set(RUNNER_ERROR_CODE_VALUES)).toEqual(
      new Set([
        "runner_unavailable",
        "runner_timeout",
        "sandbox_violation",
        "capability_missing",
        "tool_denied",
        "output_unparseable",
        "artifact_collection_failed",
      ]),
    );
  });

  it("RUNNER_EVENT_TYPE_VALUES covers full lifecycle", () => {
    expect(new Set(RUNNER_EVENT_TYPE_VALUES)).toEqual(
      new Set([
        "runner_started",
        "turn_started",
        "tool_call_started",
        "tool_call_completed",
        "runner_message",
        "runner_completed",
        "runner_failed",
        "runner_cancelled",
      ]),
    );
  });

  it("requires sanitized runner events with correlation fields", () => {
    const event: RunnerEvent = {
      type: "runner_started",
      at: "2026-05-20T00:00:00.000Z",
      runnerId: "codex_app_server",
      pipelineRunId: "pipe-1",
      workItemId: "wi-1",
      taskId: "task-1",
      role: "coder",
      data: { turn: 1, ok: true, note: null },
      redactedFields: [],
    };

    expect(isRunnerEvent(event)).toBe(true);
    expect(
      isRunnerEvent({ ...event, data: { raw: { nested: "not allowed" } } }),
    ).toBe(false);
    expect(
      isRunnerEvent({ ...event, type: "totally_unknown" }),
    ).toBe(false);
    expect(isRunnerEvent({ ...event, role: "planner" })).toBe(false);
  });
});
