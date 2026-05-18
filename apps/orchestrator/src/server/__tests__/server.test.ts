import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createEventBus } from "@issuepilot/observability";
import {
  RUN_REPORT_VERSION,
  type ProjectSummary,
  type QualitySummaryResponse,
  type RunReportArtifact,
  type TaskPlan,
  type TaskRunLink,
  type TeamRuntimeSummary,
  type WorkItem,
  type WorkItemReport,
} from "@issuepilot/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperatorActionResult } from "../../operations/actions.js";
import { buildRunReportSummary } from "@issuepilot/shared-contracts";
import { createRuntimeState } from "../../runtime/state.js";
import { createServer, type ServerDeps } from "../index.js";

type TestEvent = {
  id: string;
  runId: string;
  type: string;
  message: string;
  [key: string]: unknown;
};

async function buildTestApp(
  readEvents: (
    runId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<TestEvent[]> = async () => [],
  overrides: {
    workflowPath?: string;
    gitlabProject?: string;
    concurrency?: number;
    readLogsTail?: (
      runId: string,
      opts?: { limit?: number },
    ) => Promise<string[]>;
    runtime?: TeamRuntimeSummary | (() => TeamRuntimeSummary);
    projects?: ProjectSummary[] | (() => ProjectSummary[]);
    operatorActions?: ServerDeps["operatorActions"];
    reports?: ServerDeps["reports"];
    reportsByProject?: ServerDeps["reportsByProject"];
    workItems?: ServerDeps["workItems"];
    workItemsByProject?: ServerDeps["workItemsByProject"];
    quality?: ServerDeps["quality"];
    qualityByProject?: ServerDeps["qualityByProject"];
  } = {},
) {
  const state = createRuntimeState();
  const eventBus = createEventBus<TestEvent>();
  const app = await createServer(
    {
      state,
      eventBus,
      readEvents,
      readLogsTail: overrides.readLogsTail,
      workflowPath: overrides.workflowPath ?? ".agents/workflow.md",
      gitlabProject: overrides.gitlabProject ?? "group/project",
      pollIntervalMs: 10000,
      concurrency: overrides.concurrency ?? 1,
      ...(overrides.runtime ? { runtime: overrides.runtime } : {}),
      ...(overrides.projects ? { projects: overrides.projects } : {}),
      ...(overrides.operatorActions
        ? { operatorActions: overrides.operatorActions }
        : {}),
      ...(overrides.reports ? { reports: overrides.reports } : {}),
      ...(overrides.reportsByProject
        ? { reportsByProject: overrides.reportsByProject }
        : {}),
      ...(overrides.workItems ? { workItems: overrides.workItems } : {}),
      ...(overrides.workItemsByProject
        ? { workItemsByProject: overrides.workItemsByProject }
        : {}),
      ...(overrides.quality ? { quality: overrides.quality } : {}),
      ...(overrides.qualityByProject
        ? { qualityByProject: overrides.qualityByProject }
        : {}),
    },
    { port: 0 },
  );

  return { app, state, eventBus };
}

describe("Orchestrator HTTP API", () => {
  let app: Awaited<ReturnType<typeof createServer>>;
  let state: ReturnType<typeof createRuntimeState>;
  let eventBus: ReturnType<typeof createEventBus<TestEvent>>;

  beforeEach(async () => {
    const setup = await buildTestApp();
    app = setup.app;
    state = setup.state;
    eventBus = setup.eventBus;
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/state returns service snapshot", async () => {
    state.setRun("r-human-review", {
      runId: "r-human-review",
      status: "completed",
      attempt: 1,
      issue: { labels: ["human-review"] },
    });
    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.service.status).toBe("ready");
    expect(body.summary).toMatchObject({
      running: 0,
      retrying: 0,
      "human-review": 1,
      failed: 0,
      blocked: 0,
    });
  });

  it("GET /api/state exposes team runtime metadata when configured", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [], {
      workflowPath: "/srv/issuepilot.team.yaml",
      gitlabProject: "team",
      concurrency: 2,
      runtime: {
        mode: "team",
        maxConcurrentRuns: 2,
        activeLeases: 1,
        projectCount: 2,
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          workflowPath: "/srv/platform-web/WORKFLOW.md",
          gitlabProject: "group/platform-web",
          enabled: true,
          activeRuns: 1,
          lastPollAt: null,
        },
        {
          id: "infra-tools",
          name: "Infra Tools",
          workflowPath: "/srv/infra-tools/WORKFLOW.md",
          gitlabProject: "group/infra-tools",
          enabled: true,
          activeRuns: 0,
          lastPollAt: null,
        },
      ],
    });
    app = setup.app;

    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      service: {
        workflowPath: "/srv/issuepilot.team.yaml",
        gitlabProject: "team",
        concurrency: 2,
      },
      runtime: {
        mode: "team",
        activeLeases: 1,
        projectCount: 2,
      },
      projects: [
        { id: "platform-web", activeRuns: 1 },
        { id: "infra-tools", activeRuns: 0 },
      ],
    });
  });

  it("GET /api/state evaluates runtime/projects getters on each request", async () => {
    await app.close();
    let activeLeases = 0;
    let activeRuns = 0;
    const runtimeGetter = vi.fn(
      (): TeamRuntimeSummary => ({
        mode: "team",
        maxConcurrentRuns: 2,
        activeLeases,
        projectCount: 1,
      }),
    );
    const projectsGetter = vi.fn(
      (): ProjectSummary[] => [
        {
          id: "platform-web",
          name: "Platform Web",
          workflowPath: "/srv/platform-web/WORKFLOW.md",
          gitlabProject: "group/platform-web",
          enabled: true,
          activeRuns,
          lastPollAt: null,
        },
      ],
    );
    const setup = await buildTestApp(async () => [], {
      runtime: runtimeGetter,
      projects: projectsGetter,
    });
    app = setup.app;

    const first = await app.inject({ method: "GET", url: "/api/state" });
    expect(JSON.parse(first.body).runtime.activeLeases).toBe(0);
    expect(JSON.parse(first.body).projects[0].activeRuns).toBe(0);

    activeLeases = 1;
    activeRuns = 2;
    const second = await app.inject({ method: "GET", url: "/api/state" });
    expect(JSON.parse(second.body).runtime.activeLeases).toBe(1);
    expect(JSON.parse(second.body).projects[0].activeRuns).toBe(2);
    expect(runtimeGetter).toHaveBeenCalledTimes(2);
    expect(projectsGetter).toHaveBeenCalledTimes(2);
  });

  it("GET /api/state redacts response fields", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [], {
      workflowPath: "Bearer secret-token",
    });
    app = setup.app;

    const response = await app.inject({ method: "GET", url: "/api/state" });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret-token");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs returns empty array initially", async () => {
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("GET /api/runs returns redacted runs after adding", async () => {
    await app.close();
    const setup = await buildTestApp(async () => [
      {
        id: "e1",
        runId: "r1",
        type: "turn_started",
        message: "turn started",
        createdAt: "2026-05-12T05:00:00.000Z",
      },
      {
        id: "e2",
        runId: "r1",
        type: "turn_completed",
        message: "turn completed",
        createdAt: "2026-05-12T05:01:00.000Z",
      },
    ]);
    app = setup.app;
    state = setup.state;
    state.setRun("r1", {
      runId: "r1",
      status: "running",
      attempt: 1,
      details: "using Bearer secret-token",
    });
    const response = await app.inject({ method: "GET", url: "/api/runs" });
    const body = JSON.parse(response.body);
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("r1");
    expect(body[0].turnCount).toBe(2);
    expect(body[0].lastEvent).toEqual({
      type: "turn_completed",
      message: "turn completed",
      createdAt: "2026-05-12T05:01:00.000Z",
    });
    expect(response.body).not.toContain("secret-token");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs rejects invalid limits", async () => {
    for (const limit of ["10abc", "1.5", "-1", "0"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs?limit=${encodeURIComponent(limit)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "limit must be a positive integer",
      });
    }
  });

  it("GET /api/runs/:runId returns redacted specific run", async () => {
    await app.close();
    const setup = await buildTestApp(
      async () => [
        {
          id: "e1",
          runId: "r1",
          type: "run_started",
          message: "started",
        },
      ],
      { readLogsTail: async () => ["line 1"] },
    );
    app = setup.app;
    state = setup.state;
    state.setRun("r1", {
      runId: "r1",
      status: "running",
      attempt: 1,
      token: "glpat-12345678901234567890",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/runs/r1",
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      run: { runId: "r1" },
      events: [{ id: "e1", runId: "r1", type: "run_started" }],
      logsTail: ["line 1"],
    });
    expect(response.body).not.toContain("glpat-12345678901234567890");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/runs/:runId returns 404 for unknown id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runs/nonexistent",
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET /api/events reads persisted history by runId with paging", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [
        {
          id: "e1",
          runId,
          type: "run_started",
          message: "started",
        },
      ];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1&limit=25&offset=5",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([
      {
        id: "e1",
        runId: "r1",
        type: "run_started",
        message: "started",
      },
    ]);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 25, offset: 5 } }]);
  });

  it("GET /api/events accepts offset zero", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 100, offset: 0 } }]);
  });

  it("GET /api/events defaults limit and redacts persisted history responses", async () => {
    await app.close();
    const calls: Array<{
      runId: string;
      opts?: { limit?: number; offset?: number };
    }> = [];
    const setup = await buildTestApp(async (runId, opts) => {
      calls.push({ runId, opts });
      return [
        {
          id: "e1",
          runId,
          type: "tool_output",
          message: "called with Bearer secret-token",
          token: "glpat-12345678901234567890",
        },
      ];
    });
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=r1",
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ runId: "r1", opts: { limit: 100 } }]);
    expect(response.body).not.toContain("secret-token");
    expect(response.body).not.toContain("glpat-12345678901234567890");
    expect(response.body).toContain("[REDACTED]");
  });

  it("GET /api/events returns empty array for unknown runs", async () => {
    await app.close();
    const setup = await buildTestApp(async () => []);
    app = setup.app;

    const response = await app.inject({
      method: "GET",
      url: "/api/events?runId=missing",
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it("GET /api/events requires runId", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/events",
    });

    expect(response.statusCode).toBe(400);
  });

  it("GET /api/events rejects invalid limits", async () => {
    for (const limit of ["10abc", "1.5", "-1", "0"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/events?runId=r1&limit=${encodeURIComponent(limit)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "limit must be a positive integer",
      });
    }
  });

  it("GET /api/events rejects invalid offsets", async () => {
    for (const offset of ["10abc", "1.5", "-1"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/events?runId=r1&offset=${encodeURIComponent(offset)}`,
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "offset must be a non-negative integer",
      });
    }
  });

  it("GET /api/events/stream filters and redacts SSE payloads", async () => {
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind to a TCP port");
    }

    const controller = new AbortController();
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/events/stream?runId=r1`,
      { signal: controller.signal },
    );
    const response = await responsePromise;
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body reader");

    eventBus.publish({
      id: "e-other",
      runId: "r2",
      type: "tool_output",
      message: "ignore Bearer other-secret",
    });
    eventBus.publish({
      id: "e1",
      runId: "r1",
      type: "tool_output",
      message: "called with Bearer secret-token",
      token: "glpat-12345678901234567890",
    });

    const decoder = new TextDecoder();
    let body = "";
    const deadline = Date.now() + 1_000;
    while (!body.includes('"id":"e1"') && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    controller.abort();

    expect(body).toContain("data:");
    expect(body).toContain('"id":"e1"');
    expect(body).not.toContain("e-other");
    expect(body).not.toContain("secret-token");
    expect(body).not.toContain("glpat-12345678901234567890");
    expect(body).toContain("[REDACTED]");
  });
});

type ActionFn = (input: {
  runId: string;
  operator: string;
  cancelTimeoutMs?: number;
}) => Promise<OperatorActionResult>;

function buildActions(partial: {
  retry?: ActionFn;
  stop?: ActionFn;
  archive?: ActionFn;
}): NonNullable<ServerDeps["operatorActions"]> {
  return {
    retry: partial.retry ?? (async () => ({ ok: true })),
    stop: partial.stop ?? (async () => ({ ok: true })),
    archive: partial.archive ?? (async () => ({ ok: true })),
  };
}

describe("operator action routes", () => {
  it("POST /api/runs/:runId/retry returns 200 and defaults operator to system", async () => {
    const retry = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body)).toEqual({ ok: true });
      expect(retry).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "system",
      });
    } finally {
      await app.close();
    }
  });

  it("POST honors x-issuepilot-operator header", async () => {
    const retry = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
        headers: { "x-issuepilot-operator": "alice" },
      });
      expect(retry).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "alice",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on invalid_status", async () => {
    const stop = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "invalid_status",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "invalid_status",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 409 on cancel_failed and surfaces reason", async () => {
    const stop = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "cancel_failed",
      reason: "cancel_timeout",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop",
      });
      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "cancel_failed",
        reason: "cancel_timeout",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 404 on not_found", async () => {
    const archive = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "not_found",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ archive }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/archive",
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 500 on gitlab_failed", async () => {
    const retry = vi.fn<ActionFn>(async () => ({
      ok: false,
      code: "gitlab_failed",
      message: "no route to host",
    }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ retry }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(500);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "gitlab_failed",
      });
    } finally {
      await app.close();
    }
  });

  it("POST returns 503 actions_unavailable when operatorActions is not wired", async () => {
    const { app } = await buildTestApp();
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/retry",
      });
      expect(resp.statusCode).toBe(503);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "actions_unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("dispatches to stop and archive routes by URL path", async () => {
    const stop = vi.fn<ActionFn>(async () => ({ ok: true }));
    const archive = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop, archive }),
    });
    try {
      await app.inject({ method: "POST", url: "/api/runs/run-1/stop" });
      expect(stop).toHaveBeenCalledTimes(1);

      await app.inject({ method: "POST", url: "/api/runs/run-1/archive" });
      expect(archive).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("POST /stop forwards cancelTimeoutMs query parameter", async () => {
    const stop = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop?cancelTimeoutMs=750",
      });
      expect(resp.statusCode).toBe(200);
      expect(stop).toHaveBeenCalledWith({
        runId: "run-1",
        operator: "system",
        cancelTimeoutMs: 750,
      });
    } finally {
      await app.close();
    }
  });

  it("POST /stop rejects invalid cancelTimeoutMs with 400", async () => {
    const stop = vi.fn<ActionFn>(async () => ({ ok: true }));
    const { app } = await buildTestApp(async () => [], {
      operatorActions: buildActions({ stop }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/runs/run-1/stop?cancelTimeoutMs=0",
      });
      expect(resp.statusCode).toBe(400);
      expect(stop).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("archived run filter", () => {
  it("GET /api/runs hides archived runs by default", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("active", {
        runId: "active",
        status: "completed",
        attempt: 1,
        issue: {
          id: "1",
          iid: 1,
          title: "Fix",
          url: "https://example/-/issues/1",
          projectId: "g/p",
          labels: [],
        },
      });
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({ method: "GET", url: "/api/runs" });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body.map((r) => r.runId)).toEqual(["active"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs?includeArchived=true returns archived runs", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({
        method: "GET",
        url: "/api/runs?includeArchived=true",
      });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body.map((r) => r.runId)).toContain("archived");
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs ignores invalid includeArchived values", async () => {
    const { app, state } = await buildTestApp();
    try {
      state.setRun("archived", {
        runId: "archived",
        status: "completed",
        attempt: 1,
        archivedAt: "2026-05-15T00:00:00.000Z",
        issue: {
          id: "2",
          iid: 2,
          title: "Done",
          url: "https://example/-/issues/2",
          projectId: "g/p",
          labels: [],
        },
      });

      const resp = await app.inject({
        method: "GET",
        url: "/api/runs?includeArchived=yes",
      });
      const body = JSON.parse(resp.body) as Array<{ runId: string }>;
      expect(body).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("run reports", () => {
  function fixtureReport(): RunReportArtifact {
    return {
      version: RUN_REPORT_VERSION,
      runId: "run-1",
      issue: {
        projectId: "group/project",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        labels: ["human-review"],
      },
      run: {
        status: "completed",
        attempt: 1,
        branch: "ai/42-fix-checkout",
        workspacePath: "/tmp/ws",
        startedAt: "2026-05-16T00:00:00.000Z",
        endedAt: "2026-05-16T00:05:00.000Z",
        durations: { totalMs: 300000 },
      },
      handoff: {
        summary: "Updated checkout copy.",
        validation: ["pnpm test passed"],
        risks: [],
        followUps: [],
        nextAction: "Review and merge the MR.",
      },
      diff: { summary: "1 file changed", filesChanged: 1, notableFiles: [] },
      checks: [],
      mergeReadiness: {
        mode: "dry-run",
        status: "ready",
        reasons: [
          {
            code: "all_checks_satisfied",
            severity: "info",
            message: "ok",
          },
        ],
        evaluatedAt: "2026-05-16T00:06:00.000Z",
      },
      notes: {},
    };
  }

  function buildReportStore(report: RunReportArtifact) {
    const summary = buildRunReportSummary(report);
    return {
      save: async () => {},
      get: async (runId: string) =>
        runId === report.runId ? report : undefined,
      summary: (runId: string) =>
        runId === report.runId ? summary : undefined,
      allSummaries: () => [summary],
      all: async () => [report],
    };
  }

  it("GET /api/runs attaches the report summary when present", async () => {
    const report = fixtureReport();
    const { app, state } = await buildTestApp(async () => [], {
      reports: buildReportStore(report),
    });
    try {
      state.setRun("run-1", {
        runId: "run-1",
        status: "completed",
        attempt: 1,
        issue: { iid: 42, labels: ["human-review"] },
      });
      const resp = await app.inject({ method: "GET", url: "/api/runs" });
      const body = JSON.parse(resp.body) as Array<{
        runId: string;
        report?: { mergeReadinessStatus: string };
      }>;
      expect(body[0]!.report?.mergeReadinessStatus).toBe("ready");
    } finally {
      await app.close();
    }
  });

  it("GET /api/runs/:runId returns the full report artifact", async () => {
    const report = fixtureReport();
    const { app, state } = await buildTestApp(async () => [], {
      reports: buildReportStore(report),
    });
    try {
      state.setRun("run-1", {
        runId: "run-1",
        status: "completed",
        attempt: 1,
        issue: { iid: 42, labels: ["human-review"] },
      });
      const resp = await app.inject({
        method: "GET",
        url: "/api/runs/run-1",
      });
      const body = JSON.parse(resp.body) as { report?: { runId: string } };
      expect(body.report?.runId).toBe("run-1");
    } finally {
      await app.close();
    }
  });

  it("GET /api/reports lists report summaries", async () => {
    const report = fixtureReport();
    const { app } = await buildTestApp(async () => [], {
      reports: buildReportStore(report),
    });
    try {
      const resp = await app.inject({ method: "GET", url: "/api/reports" });
      const body = JSON.parse(resp.body) as {
        reports: Array<{ runId: string }>;
      };
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0]!.runId).toBe("run-1");
    } finally {
      await app.close();
    }
  });

  it("GET /api/reports returns empty list when reports are not configured", async () => {
    const { app } = await buildTestApp();
    try {
      const resp = await app.inject({ method: "GET", url: "/api/reports" });
      const body = JSON.parse(resp.body) as { reports: unknown[] };
      expect(body.reports).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

describe("V4.1 work item routes", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function workItemFixture(over: Partial<{ status: string }> = {}) {
    return {
      workItemId: "wi_01",
      sourceIssue: {
        projectId: "g/p",
        iid: 42,
        url: "https://gl/-/issues/42",
        title: "Big",
      },
      title: "Big",
      goal: "Ship X",
      acceptanceCriteria: ["AC1"],
      status: over.status ?? "ready",
      taskIds: ["t1", "t2"],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:01.000Z",
    };
  }

  function planFixture() {
    return {
      planId: "tp_01",
      workItemId: "wi_01",
      version: 1,
      tasks: [],
      dependencies: [],
      operatorEdits: [],
      status: "accepted" as const,
      acceptedAt: "2026-05-17T00:00:02.000Z",
    };
  }

  function buildWorkItemsService(
    over: Partial<NonNullable<ServerDeps["workItems"]>> = {},
  ): NonNullable<ServerDeps["workItems"]> {
    return {
      planFromIssue: over.planFromIssue ??
        (async () => ({
          workItem: workItemFixture(),
          plan: planFixture(),
        })),
      list: over.list ?? (async () => [workItemFixture()]),
      detail: over.detail ??
        (async () => ({
          workItem: workItemFixture(),
          plan: { current: planFixture(), history: [] },
          tasks: [],
          runLinks: [],
        })),
      acceptPlan: over.acceptPlan ??
        (async () => ({
          workItem: workItemFixture({ status: "ready" }),
          plan: planFixture(),
        })),
      regeneratePlan: over.regeneratePlan ??
        (async () => ({
          workItem: workItemFixture({ status: "planning" }),
          plan: { ...planFixture(), version: 2, status: "draft" as const },
        })),
      skipTask: over.skipTask ?? (async () => ({ ok: true as const })),
      retryTask: over.retryTask ?? (async () => ({ ok: true as const })),
      replanTask: over.replanTask ??
        (async () => ({
          workItem: workItemFixture({ status: "ready" }),
          plan: { ...planFixture(), version: 2, status: "draft" as const },
        })),
      markNeedsRework: over.markNeedsRework ?? (async () => ({ ok: true as const })),
      unskipTask: over.unskipTask ?? (async () => ({ ok: true as const })),
      graph: over.graph ??
        (async () => ({
          levels: [["t1"], ["t2"]],
          edges: [{ from: "t1", to: "t2" }],
          criticalPathTaskIds: ["t1", "t2"],
        })),
      report: over.report ?? (async () => undefined),
      getReportMarkdown: over.getReportMarkdown ??
        (async () => "# Work item report\n"),
      getEvidence: over.getEvidence ??
        (async () => ({
          index: [],
          byTask: {},
          missing: [],
        })),
      confirmTaskEvidence: over.confirmTaskEvidence ??
        (async (_workItemId, _taskId, evidenceId) => ({
          evidenceId,
          confirmedAt: "2026-05-17T00:20:00.000Z",
          report: workItemReportFixture(),
        })),
    };
  }

  function workItemReportFixture() {
    return {
      workItemId: "wi_01",
      overallStatus: "complete" as const,
      taskSummaries: [],
      validationSummary: "",
      riskSummary: "",
      evidence: { index: [], byTask: {} },
      openQuestions: [],
      recommendedNextActions: [],
      humanReviewChecklist: [],
      generatedAt: "2026-05-17T00:10:00.000Z",
    };
  }

  function evidenceResponseFixture() {
    return {
      index: [
        {
          evidenceId: "ev-screenshot",
          taskId: "t1",
          kind: "screenshot" as const,
          label: "Login screenshot",
          confidence: "ai-claim" as const,
          source: { runId: "run-1", relPath: "screenshots/login.png" },
        },
      ],
      byTask: {
        t1: [
          {
            evidenceId: "ev-screenshot",
            taskId: "t1",
            kind: "screenshot" as const,
            label: "Login screenshot",
            confidence: "ai-claim" as const,
            source: { runId: "run-1", relPath: "screenshots/login.png" },
          },
        ],
      },
      missing: [{ taskId: "t2", reason: "no-run-report" as const }],
    };
  }

  function runReportFixture(
    over: Partial<RunReportArtifact> = {},
  ): RunReportArtifact {
    return {
      version: RUN_REPORT_VERSION,
      runId: "run-1",
      issue: {
        projectId: "group/project",
        iid: 42,
        title: "Fix checkout",
        url: "https://gitlab.example.com/issues/42",
        labels: ["human-review"],
      },
      run: {
        status: "completed",
        attempt: 1,
        branch: "ai/42-fix-checkout",
        workspacePath: "/tmp/ws",
        startedAt: "2026-05-16T00:00:00.000Z",
        endedAt: "2026-05-16T00:05:00.000Z",
        durations: { totalMs: 300000 },
      },
      handoff: {
        summary: "Updated checkout copy.",
        validation: ["pnpm test passed"],
        risks: [],
        followUps: [],
        nextAction: "Review and merge the MR.",
      },
      diff: { summary: "1 file changed", filesChanged: 1, notableFiles: [] },
      checks: [],
      mergeReadiness: {
        mode: "dry-run",
        status: "ready",
        reasons: [],
        evaluatedAt: "2026-05-16T00:06:00.000Z",
      },
      notes: {},
      ...over,
    };
  }

  function buildReportStoreByRun(reports: RunReportArtifact[]) {
    const byRun = new Map(reports.map((report) => [report.runId, report]));
    return {
      save: async () => {},
      get: async (runId: string) => byRun.get(runId),
      summary: (runId: string) => {
        const report = byRun.get(runId);
        return report ? buildRunReportSummary(report) : undefined;
      },
      allSummaries: () => [...byRun.values()].map(buildRunReportSummary),
      all: async () => [...byRun.values()],
    };
  }

  async function createEvidencePng(runId = "run-1") {
    const taskWorktreePath = await mkdtemp(
      path.join(tmpdir(), "issuepilot-server-evidence-"),
    );
    tempDirs.push(taskWorktreePath);
    const evidenceDir = path.join(
      taskWorktreePath,
      ".issuepilot",
      "evidence",
      runId,
      "screenshots",
    );
    await mkdir(evidenceDir, { recursive: true });
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(path.join(evidenceDir, "login.png"), png);
    return { taskWorktreePath, png };
  }

  it("returns 503 work_items_unavailable when service is not wired", async () => {
    const { app } = await buildTestApp();
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items",
      });
      expect(resp.statusCode).toBe(503);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "work_items_unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/issues/:iid/plan returns work item and plan", async () => {
    const planFromIssue = vi.fn(async (input: {
      iid: number;
      regenerate?: boolean;
      operator: string;
    }) => ({
      workItem: workItemFixture(),
      plan: planFixture(),
      _captured: input,
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        planFromIssue: planFromIssue as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/issues/42/plan",
        headers: { "x-issuepilot-operator": "alice" },
        payload: { iid: 42, regenerate: false },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.workItem.workItemId).toBe("wi_01");
      expect(body.plan.planId).toBe("tp_01");
      expect(planFromIssue).toHaveBeenCalledWith({
        iid: 42,
        regenerate: false,
        operator: "alice",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/issues/:iid/plan rejects non-numeric iid", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService(),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/issues/abc/plan",
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "invalid_iid",
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items returns counters keyed by status", async () => {
    const list = vi.fn(async () => [
      workItemFixture({ status: "ready" }),
      { ...workItemFixture({ status: "running" }), workItemId: "wi_02" },
      { ...workItemFixture({ status: "completed" }), workItemId: "wi_03" },
    ]);
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ list: list as never }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items",
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.workItems).toHaveLength(3);
      expect(body.counters).toEqual({
        planning: 0,
        ready: 1,
        running: 1,
        partial: 0,
        completed: 1,
        blocked: 0,
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id 404 when missing", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        detail: (async () => undefined) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_missing",
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/plan/accept requires planId", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService(),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/plan/accept",
        payload: { edits: [] },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "missing_plan_id",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/plan/accept forwards edits + operator", async () => {
    const acceptPlan = vi.fn(async (input: unknown) => ({
      workItem: workItemFixture({ status: "ready" }),
      plan: planFixture(),
      _captured: input,
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ acceptPlan: acceptPlan as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/plan/accept",
        headers: { "x-issuepilot-operator": "bob" },
        payload: {
          planId: "tp_01",
          edits: [{ taskId: "t1", field: "title", after: "New title" }],
        },
      });
      expect(resp.statusCode).toBe(200);
      expect(acceptPlan).toHaveBeenCalledWith({
        planId: "tp_01",
        edits: [{ taskId: "t1", field: "title", after: "New title" }],
        operator: "bob",
        workItemId: "wi_01",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/plan/regenerate calls regeneratePlan", async () => {
    const regeneratePlan = vi.fn(async () => ({
      workItem: workItemFixture({ status: "planning" }),
      plan: { ...planFixture(), version: 2, status: "draft" as const },
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ regeneratePlan: regeneratePlan as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/plan/regenerate",
      });
      expect(resp.statusCode).toBe(200);
      expect(regeneratePlan).toHaveBeenCalledWith("wi_01", "system");
    } finally {
      await app.close();
    }
  });

  it("POST .../tasks/:taskId/skip returns 200 on ok", async () => {
    const skipTask = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ skipTask: skipTask as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/skip",
      });
      expect(resp.statusCode).toBe(200);
      expect(skipTask).toHaveBeenCalledWith("wi_01", "t1", "system");
    } finally {
      await app.close();
    }
  });

  it("POST .../tasks/:taskId/skip returns 404 on not_found error", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        skipTask: (async () => ({
          error: { code: "not_found", message: "missing" },
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/missing/skip",
      });
      expect(resp.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("POST .../tasks/:taskId/retry forwards operator", async () => {
    const retryTask = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ retryTask: retryTask as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/retry",
        headers: { "x-issuepilot-operator": "carol" },
      });
      expect(resp.statusCode).toBe(200);
      expect(retryTask).toHaveBeenCalledWith("wi_01", "t1", "carol");
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/report returns { report } shape", async () => {
    const report = vi.fn(async () => workItemReportFixture());
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ report: report as never }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/report",
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.report.workItemId).toBe("wi_01");
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/report.md returns markdown body", async () => {
    const getReportMarkdown = vi.fn(async () => "# Review packet\n\nReady.");
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        getReportMarkdown: getReportMarkdown as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/report.md",
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers["content-type"]).toContain("text/markdown");
      expect(resp.body).toBe("# Review packet\n\nReady.");
      expect(getReportMarkdown).toHaveBeenCalledWith("wi_01");
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/report.md returns 404 report_not_ready when no plan accepted", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        getReportMarkdown: (async () => ({
          error: { code: "report_not_ready", message: "report not ready" },
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/report.md",
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "report_not_ready",
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence returns grouped + missing", async () => {
    const getEvidence = vi.fn(async () => evidenceResponseFixture());
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ getEvidence: getEvidence as never }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence",
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body)).toEqual(evidenceResponseFixture());
      expect(getEvidence).toHaveBeenCalledWith("wi_01");
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence/file streams png and infers content-type", async () => {
    const { taskWorktreePath, png } = await createEvidencePng();
    const report = runReportFixture({
      run: { ...runReportFixture().run, workspacePath: taskWorktreePath },
    });
    const { app } = await buildTestApp(async () => [], {
      reports: buildReportStoreByRun([report]),
      workItems: buildWorkItemsService({
        detail: (async () => ({
          workItem: workItemFixture(),
          plan: { current: planFixture(), history: [] },
          tasks: [],
          runLinks: [
            {
              taskId: "t1",
              runId: "run-1",
              attempt: 1,
              status: "completed",
              branch: "ai/42-t1",
              startedAt: "2026-05-17T00:00:00.000Z",
            },
          ],
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file?runId=run-1&path=screenshots/login.png",
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers["content-type"]).toContain("image/png");
      expect(Buffer.from(resp.rawPayload)).toEqual(png);
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence/file returns 403 when path tries to escape via ../", async () => {
    const { taskWorktreePath } = await createEvidencePng();
    const report = runReportFixture({
      run: { ...runReportFixture().run, workspacePath: taskWorktreePath },
    });
    const { app } = await buildTestApp(async () => [], {
      reports: buildReportStoreByRun([report]),
      workItems: buildWorkItemsService({
        detail: (async () => ({
          workItem: workItemFixture(),
          plan: { current: planFixture(), history: [] },
          tasks: [],
          runLinks: [
            {
              taskId: "t1",
              runId: "run-1",
              attempt: 1,
              status: "completed",
              branch: "ai/42-t1",
              startedAt: "2026-05-17T00:00:00.000Z",
            },
          ],
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file?runId=run-1&path=../secret.png",
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence/file returns 400 for malformed runId or path query", async () => {
    const detail = vi.fn(async () => ({
      workItem: workItemFixture(),
      plan: { current: planFixture(), history: [] },
      tasks: [],
      runLinks: [
        {
          taskId: "t1",
          runId: "run-1",
          attempt: 1,
          status: "completed" as const,
          branch: "ai/42-t1",
          startedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ detail: detail as never }),
    });
    const cases = [
      { path: "screenshots/login.png" },
      { runId: "run-1" },
      { runId: ["run-1", "run-2"], path: "screenshots/login.png" },
      { runId: "run-1", path: ["screenshots/login.png", "other.png"] },
    ];
    try {
      for (const query of cases) {
        const resp = await app.inject({
          method: "GET",
          url: "/api/work-items/wi_01/evidence/file",
          query,
        });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body)).toMatchObject({
          ok: false,
          code: "validation_failed",
        });
      }
      expect(detail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm stamps confirmedBy + returns report", async () => {
    const confirmTaskEvidence = vi.fn(async () => ({
      evidenceId: "ev-screenshot",
      confirmedAt: "2026-05-17T00:20:00.000Z",
      report: {
        ...workItemReportFixture(),
        evidence: {
          index: [
            {
              evidenceId: "ev-screenshot",
              taskId: "t1",
              kind: "screenshot" as const,
              label: "Login screenshot",
              confidence: "human-confirmed" as const,
              confirmedBy: "alice",
              confirmedAt: "2026-05-17T00:20:00.000Z",
            },
          ],
          byTask: {},
        },
      },
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        confirmTaskEvidence: confirmTaskEvidence as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/evidence/ev-screenshot/confirm",
        payload: { operator: "alice" },
      });
      expect(resp.statusCode).toBe(200);
      expect(confirmTaskEvidence).toHaveBeenCalledWith(
        "wi_01",
        "t1",
        "ev-screenshot",
        { operator: "alice" },
      );
      expect(JSON.parse(resp.body)).toMatchObject({
        evidenceId: "ev-screenshot",
        confirmedAt: "2026-05-17T00:20:00.000Z",
        report: {
          evidence: {
            index: [
              {
                evidenceId: "ev-screenshot",
                confidence: "human-confirmed",
                confirmedBy: "alice",
              },
            ],
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm returns 404 when evidenceId is unknown", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        confirmTaskEvidence: (async () => ({
          error: { code: "not_found", message: "evidence not found" },
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/evidence/missing/confirm",
        payload: { operator: "alice" },
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence/file returns 404 when runId is not linked to this WorkItem", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        detail: (async () => ({
          workItem: workItemFixture(),
          plan: { current: planFixture(), history: [] },
          tasks: [],
          runLinks: [],
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file?runId=other-run&path=screenshots/login.png",
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/evidence/:evidenceId/confirm returns 404 when evidenceId belongs to another task", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        confirmTaskEvidence: (async () => ({
          error: { code: "not_found", message: "evidence not found" },
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t2/evidence/ev-screenshot/confirm",
        payload: { operator: "alice" },
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("routes go through x-issuepilot-project header or ?project= fallback in team mode", async () => {
    const { taskWorktreePath, png } = await createEvidencePng();
    const projectB = await createEvidencePng();
    await writeFile(
      path.join(
        projectB.taskWorktreePath,
        ".issuepilot",
        "evidence",
        "run-1",
        "screenshots",
        "login.png",
      ),
      Buffer.from("project-b"),
    );
    const report = runReportFixture({
      run: { ...runReportFixture().run, workspacePath: taskWorktreePath },
    });
    const projectBReport = runReportFixture({
      run: { ...runReportFixture().run, workspacePath: projectB.taskWorktreePath },
    });
    const getEvidenceA = vi.fn(async () => evidenceResponseFixture());
    const getEvidenceB = vi.fn(async () => ({
      index: [],
      byTask: {},
      missing: [],
    }));
    const detailA = vi.fn(async () => ({
      workItem: workItemFixture(),
      plan: { current: planFixture(), history: [] },
      tasks: [],
      runLinks: [
        {
          taskId: "t1",
          runId: "run-1",
          attempt: 1,
          status: "completed",
          branch: "ai/42-t1",
          startedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    }));
    const { app } = await buildTestApp(async () => [], {
      reports: buildReportStoreByRun([projectBReport]),
      reportsByProject: new Map([
        ["proj-a", buildReportStoreByRun([report])],
        ["proj-b", buildReportStoreByRun([projectBReport])],
      ]),
      workItemsByProject: new Map([
        [
          "proj-a",
          buildWorkItemsService({
            detail: detailA as never,
            getEvidence: getEvidenceA as never,
          }),
        ],
        ["proj-b", buildWorkItemsService({ getEvidence: getEvidenceB as never })],
      ]) as never,
    });
    try {
      const evidenceResp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence",
        headers: { "x-issuepilot-project": "proj-a" },
      });
      expect(evidenceResp.statusCode).toBe(200);
      expect(getEvidenceA).toHaveBeenCalledWith("wi_01");
      expect(getEvidenceB).toHaveBeenCalledTimes(0);

      const fileResp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file?project=proj-a&runId=run-1&path=screenshots/login.png",
      });
      expect(fileResp.statusCode).toBe(200);
      expect(fileResp.headers["content-type"]).toContain("image/png");
      expect(Buffer.from(fileResp.rawPayload)).toEqual(png);
      expect(detailA).toHaveBeenCalledWith("wi_01");

      const headerPriorityResp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file?project=proj-b&runId=run-1&path=screenshots/login.png",
        headers: { "x-issuepilot-project": "proj-a" },
      });
      expect(headerPriorityResp.statusCode).toBe(200);
      expect(Buffer.from(headerPriorityResp.rawPayload)).toEqual(png);
      expect(detailA).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/evidence/file returns 400 for ambiguous project fallback", async () => {
    const detailA = vi.fn(async () => ({
      workItem: workItemFixture(),
      plan: { current: planFixture(), history: [] },
      tasks: [],
      runLinks: [
        {
          taskId: "t1",
          runId: "run-1",
          attempt: 1,
          status: "completed" as const,
          branch: "ai/42-t1",
          startedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    }));
    const { app } = await buildTestApp(async () => [], {
      workItemsByProject: new Map([
        ["proj-a", buildWorkItemsService({ detail: detailA as never })],
        ["proj-b", buildWorkItemsService()],
      ]) as never,
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/evidence/file",
        query: {
          project: ["proj-a", "proj-b"],
          runId: "run-1",
          path: "screenshots/login.png",
        },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "validation_failed",
      });
      expect(detailA).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // V4.2 Task Graph routes

  it("POST /api/work-items/:id/tasks/:taskId/replan returns new draft plan", async () => {
    const replanTask = vi.fn(async () => ({
      workItem: workItemFixture({ status: "ready" }),
      plan: { ...planFixture(), version: 2, status: "draft" as const },
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ replanTask: replanTask as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/replan",
        headers: { "x-issuepilot-operator": "alice" },
        payload: { reason: "Sub-task too broad", hint: "split into 2" },
      });
      expect(resp.statusCode).toBe(200);
      expect(replanTask).toHaveBeenCalledWith({
        workItemId: "wi_01",
        taskId: "t1",
        reason: "Sub-task too broad",
        hint: "split into 2",
        operator: "alice",
      });
      const body = JSON.parse(resp.body);
      expect(body.plan.version).toBe(2);
      expect(body.plan.status).toBe("draft");
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/replan rejects empty reason with 400 validation_failed", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService(),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/replan",
        payload: { reason: "" },
      });
      expect(resp.statusCode).toBe(422);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "validation_failed",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/mark-rework records the reason", async () => {
    const markNeedsRework = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        markNeedsRework: markNeedsRework as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/mark-rework",
        headers: { "x-issuepilot-operator": "bob" },
        payload: { reason: "Reviewer asked for tests" },
      });
      expect(resp.statusCode).toBe(200);
      expect(markNeedsRework).toHaveBeenCalledWith({
        workItemId: "wi_01",
        taskId: "t1",
        reason: "Reviewer asked for tests",
        operator: "bob",
      });
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/mark-rework rejects empty reason", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService(),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/mark-rework",
        payload: { reason: "  " },
      });
      expect(resp.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("POST /api/work-items/:id/tasks/:taskId/unskip succeeds on skipped task", async () => {
    const unskipTask = vi.fn(async () => ({ ok: true as const }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ unskipTask: unskipTask as never }),
    });
    try {
      const resp = await app.inject({
        method: "POST",
        url: "/api/work-items/wi_01/tasks/t1/unskip",
        headers: { "x-issuepilot-operator": "carol" },
      });
      expect(resp.statusCode).toBe(200);
      expect(unskipTask).toHaveBeenCalledWith({
        workItemId: "wi_01",
        taskId: "t1",
        operator: "carol",
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/graph returns levels/edges/criticalPathTaskIds", async () => {
    const graph = vi.fn(async () => ({
      levels: [["t1"], ["t2"]],
      edges: [{ from: "t1", to: "t2" }],
      criticalPathTaskIds: ["t1", "t2"],
    }));
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ graph: graph as never }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_01/graph",
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.levels).toEqual([["t1"], ["t2"]]);
      expect(body.edges).toEqual([{ from: "t1", to: "t2" }]);
      expect(body.criticalPathTaskIds).toEqual(["t1", "t2"]);
    } finally {
      await app.close();
    }
  });

  it("GET /api/work-items/:id/graph returns 404 not_found from service", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({
        graph: (async () => ({
          error: { code: "not_found", message: "missing" },
        })) as never,
      }),
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items/wi_missing/graph",
      });
      expect(resp.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("routes to per-project workItems service when x-issuepilot-project header is set", async () => {
    const listA = vi.fn(async () => [workItemFixture({ status: "ready" })]);
    const listB = vi.fn(async () => [
      { ...workItemFixture({ status: "running" }), workItemId: "wi_B1" },
    ]);
    const { app } = await buildTestApp(async () => [], {
      workItemsByProject: new Map([
        ["proj-a", buildWorkItemsService({ list: listA as never })],
        ["proj-b", buildWorkItemsService({ list: listB as never })],
      ]) as never,
    });
    try {
      const respA = await app.inject({
        method: "GET",
        url: "/api/work-items",
        headers: { "x-issuepilot-project": "proj-a" },
      });
      expect(respA.statusCode).toBe(200);
      expect(JSON.parse(respA.body).workItems[0].workItemId).toBe("wi_01");
      expect(listA).toHaveBeenCalledTimes(1);
      expect(listB).toHaveBeenCalledTimes(0);
      const respB = await app.inject({
        method: "GET",
        url: "/api/work-items",
        headers: { "x-issuepilot-project": "proj-b" },
      });
      expect(respB.statusCode).toBe(200);
      expect(JSON.parse(respB.body).workItems[0].workItemId).toBe("wi_B1");
    } finally {
      await app.close();
    }
  });

  it("returns 400 project_header_required when workItemsByProject is wired but header is missing", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItemsByProject: new Map([
        ["proj-a", buildWorkItemsService()],
      ]) as never,
    });
    try {
      const resp = await app.inject({ method: "GET", url: "/api/work-items" });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "project_header_required",
      });
    } finally {
      await app.close();
    }
  });

  it("returns 404 when x-issuepilot-project header references an unknown project", async () => {
    const { app } = await buildTestApp(async () => [], {
      workItemsByProject: new Map([
        ["proj-a", buildWorkItemsService()],
      ]) as never,
    });
    try {
      const resp = await app.inject({
        method: "GET",
        url: "/api/work-items",
        headers: { "x-issuepilot-project": "missing" },
      });
      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body)).toMatchObject({
        ok: false,
        code: "project_not_found",
      });
    } finally {
      await app.close();
    }
  });

  it("falls back to the default workItems service when the header is absent (single-mode)", async () => {
    const list = vi.fn(async () => [workItemFixture({ status: "ready" })]);
    const { app } = await buildTestApp(async () => [], {
      workItems: buildWorkItemsService({ list: list as never }),
    });
    try {
      const resp = await app.inject({ method: "GET", url: "/api/work-items" });
      expect(resp.statusCode).toBe(200);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  describe("V4.4 quality summary route", () => {
    function fixtureRunReport(over: {
      runId: string;
      projectId?: string;
      status?: "completed" | "failed" | "blocked";
      ciStatus?: "success" | "failed";
    }): RunReportArtifact {
      return {
        version: RUN_REPORT_VERSION,
        runId: over.runId,
        issue: {
          projectId: over.projectId ?? "proj-a",
          iid: 1,
          title: "Issue",
          url: "https://gitlab.example/1",
          labels: ["human-review"],
        },
        run: {
          status: over.status ?? "completed",
          attempt: 1,
          branch: "issuepilot/1",
          workspacePath: "/tmp/ws",
          startedAt: "2026-05-18T00:00:00.000Z",
          endedAt: "2026-05-18T00:05:00.000Z",
          durations: { totalMs: 300_000 },
        },
        handoff: {
          summary: "ok",
          validation: [],
          risks: [],
          followUps: [],
          nextAction: "review",
        },
        diff: { summary: "", filesChanged: 0, notableFiles: [] },
        checks: [{ name: "unit", status: "passed" }],
        mergeReadiness: {
          mode: "dry-run",
          status: "unknown",
          reasons: [],
          evaluatedAt: "2026-05-18T00:05:00.000Z",
        },
        notes: {},
        ...(over.ciStatus
          ? {
              ci: {
                status: over.ciStatus,
                checkedAt: "2026-05-18T00:05:00.000Z",
              },
            }
          : {}),
      };
    }

    function reportStoreWith(reports: RunReportArtifact[]) {
      return {
        save: async () => {},
        get: async (runId: string) =>
          reports.find((r) => r.runId === runId),
        summary: () => undefined,
        allSummaries: () => [],
        all: async () => reports,
      };
    }

    it("GET /api/quality/summary returns quality summary", async () => {
      const { app } = await buildTestApp(async () => [], {
        reports: reportStoreWith([
          fixtureRunReport({ runId: "ok", status: "completed" }),
          fixtureRunReport({ runId: "bad", status: "failed" }),
        ]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary?window=7d",
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.metrics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "success-rate" }),
          ]),
        );
        expect(body.scope).toEqual({ mode: "single-project" });
      } finally {
        await app.close();
      }
    });

    it("rejects project query to avoid scope ambiguity", async () => {
      const { app } = await buildTestApp(async () => [], {
        reports: reportStoreWith([]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary?project=proj-a",
        });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body)).toMatchObject({
          code: "project_query_unsupported",
        });
      } finally {
        await app.close();
      }
    });

    it("rejects unsupported status", async () => {
      const { app } = await buildTestApp(async () => [], {
        reports: reportStoreWith([]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary?status=failed",
        });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body)).toMatchObject({
          code: "invalid_status",
        });
      } finally {
        await app.close();
      }
    });

    it("requires x-issuepilot-project in team mode", async () => {
      const { app } = await buildTestApp(async () => [], {
        qualityByProject: new Map([
          ["proj-a", { reports: reportStoreWith([]) }],
        ]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary",
        });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body)).toMatchObject({
          code: "project_required",
        });
      } finally {
        await app.close();
      }
    });

    it("rejects unknown project id in team mode", async () => {
      const { app } = await buildTestApp(async () => [], {
        qualityByProject: new Map([
          ["proj-a", { reports: reportStoreWith([]) }],
        ]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary",
          headers: { "x-issuepilot-project": "missing" },
        });
        expect(resp.statusCode).toBe(404);
        expect(JSON.parse(resp.body)).toMatchObject({
          code: "project_not_found",
        });
      } finally {
        await app.close();
      }
    });

    it("routes team quality summary to the selected project", async () => {
      const { app } = await buildTestApp(async () => [], {
        qualityByProject: new Map([
          [
            "proj-a",
            { reports: reportStoreWith([fixtureRunReport({ runId: "a", projectId: "proj-a" })]) },
          ],
          [
            "proj-b",
            { reports: reportStoreWith([fixtureRunReport({ runId: "b", projectId: "proj-b" })]) },
          ],
        ]),
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary",
          headers: { "x-issuepilot-project": "proj-b" },
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.scope).toEqual({
          mode: "team-project",
          projectId: "proj-b",
        });
      } finally {
        await app.close();
      }
    });

    it("returns stable empty response when stores are absent", async () => {
      const { app } = await buildTestApp(async () => [], {});
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary",
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body);
        expect(body.metrics.length).toBeGreaterThan(0);
        expect(body.drilldown).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it("V4.4 summarizes quality from reports and work items", async () => {
      const okRun: RunReportArtifact = {
        ...fixtureRunReport({
          runId: "ok",
          projectId: "proj-a",
          status: "completed",
          ciStatus: "success",
        }),
      };
      const badRun: RunReportArtifact = {
        ...fixtureRunReport({
          runId: "bad",
          projectId: "proj-a",
          status: "failed",
          ciStatus: "failed",
        }),
        run: {
          status: "failed",
          attempt: 1,
          branch: "issuepilot/bad",
          workspacePath: "/tmp/ws",
          startedAt: "2026-05-18T00:00:00.000Z",
          endedAt: "2026-05-18T00:05:00.000Z",
          durations: { totalMs: 300_000 },
          lastError: {
            classification: "auth",
            code: "401",
            message: "401 unauthorized while pushing branch",
          },
        },
      };

      const workItem: WorkItem = {
        workItemId: "wi-1",
        sourceIssue: {
          projectId: "proj-a",
          iid: 7,
          url: "https://gl/-/issues/7",
          title: "Big",
        },
        title: "Big",
        goal: "g",
        acceptanceCriteria: [],
        status: "running",
        taskIds: ["t1", "t2"],
        createdAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:10:00.000Z",
      };
      const plan: TaskPlan = {
        planId: "tp_1",
        workItemId: "wi-1",
        version: 1,
        tasks: [
          {
            taskId: "t1",
            title: "Task 1",
            goal: "g",
            scope: "s",
            dependsOn: [],
            suggestedValidation: [],
            status: "completed",
            runIds: ["run-t1"],
            riskLevel: "low",
          },
          {
            taskId: "t2",
            title: "Task 2",
            goal: "g",
            scope: "s",
            dependsOn: [],
            suggestedValidation: [],
            status: "needs_rework",
            runIds: ["run-t2"],
            riskLevel: "low",
            needsReworkReason: "Reviewer requested broader test coverage",
          },
        ],
        dependencies: [],
        operatorEdits: [],
        status: "accepted",
        acceptedAt: "2026-05-18T00:00:00.000Z",
      };
      const links: TaskRunLink[] = [
        {
          taskId: "t1",
          runId: "run-t1",
          attempt: 1,
          status: "completed",
          branch: "issuepilot/t1",
          startedAt: "2026-05-18T00:00:00.000Z",
          completedAt: "2026-05-18T00:01:00.000Z",
        },
        {
          taskId: "t2",
          runId: "run-t2",
          attempt: 1,
          status: "completed",
          branch: "issuepilot/t2",
          startedAt: "2026-05-18T00:02:00.000Z",
          completedAt: "2026-05-18T00:03:00.000Z",
        },
      ];
      const workItemReport: WorkItemReport = {
        workItemId: "wi-1",
        overallStatus: "partial",
        taskSummaries: [],
        validationSummary: "",
        riskSummary: "",
        evidence: { index: [], byTask: {} },
        openQuestions: [],
        recommendedNextActions: [],
        humanReviewChecklist: [
          {
            itemId: "h1",
            taskId: "t1",
            label: "Evidence missing for Task 1",
            reason: "missing-evidence",
            confirmed: false,
          },
        ],
        generatedAt: "2026-05-18T00:10:00.000Z",
      };
      const workItems = {
        listWorkItems: async () => [workItem],
        getCurrentPlan: async (id: string) =>
          id === "wi-1" ? plan : undefined,
        listAllTaskRunLinks: async (id: string) =>
          id === "wi-1" ? links : [],
        getReport: async (id: string) =>
          id === "wi-1" ? workItemReport : undefined,
      };

      const { app } = await buildTestApp(async () => [], {
        quality: {
          reports: reportStoreWith([okRun, badRun]),
          workItems,
        },
      });
      try {
        const resp = await app.inject({
          method: "GET",
          url: "/api/quality/summary?window=7d",
        });
        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.body) as QualitySummaryResponse;
        const successRate = body.metrics.find((m) => m.id === "success-rate");
        expect(successRate).toMatchObject({ numerator: 1, denominator: 2 });
        const patternIds = body.failurePatterns.map((p) => p.patternId);
        expect(patternIds).toEqual(
          expect.arrayContaining([
            "permission-issue",
            "ci-failure",
            "review-rework",
            "missing-evidence",
          ]),
        );
        expect(body.drilldown).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              target: {
                kind: "evidence",
                href: "/work-items/wi-1?view=evidence",
              },
            }),
          ]),
        );
      } finally {
        await app.close();
      }
    });
  });
});
