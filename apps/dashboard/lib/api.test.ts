import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  acceptWorkItemPlan,
  archiveRun,
  getRunDetail,
  getState,
  getWorkItem,
  getWorkItemGraph,
  getWorkItemReport,
  listEvents,
  listReports,
  listRuns,
  listWorkItems,
  markWorkItemTaskRework,
  planWorkItem,
  regenerateWorkItemPlan,
  replanWorkItemTask,
  resolveApiBase,
  retryRun,
  retryWorkItemTask,
  setActiveWorkItemsProject,
  skipWorkItemTask,
  stopRun,
  unskipWorkItemTask,
} from "./api";

const FAKE_BASE = "http://api.test";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE = FAKE_BASE;
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE;
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, init: { status?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("resolveApiBase", () => {
  it("uses NEXT_PUBLIC_API_BASE when set", () => {
    expect(resolveApiBase()).toBe(FAKE_BASE);
  });

  it("falls back to 127.0.0.1:4738 when env unset", () => {
    delete process.env.NEXT_PUBLIC_API_BASE;
    expect(resolveApiBase()).toBe("http://127.0.0.1:4738");
  });

  it("strips trailing slash", () => {
    process.env.NEXT_PUBLIC_API_BASE = `${FAKE_BASE}/`;
    expect(resolveApiBase()).toBe(FAKE_BASE);
  });
});

describe("getState", () => {
  it("GETs /api/state and returns typed snapshot", async () => {
    const fetchMock = mockFetch({
      service: {
        status: "ready",
        workflowPath: ".agents/workflow.md",
        gitlabProject: "g/p",
        pollIntervalMs: 10_000,
        concurrency: 1,
        lastConfigReloadAt: null,
        lastPollAt: null,
      },
      summary: {
        claimed: 0,
        running: 1,
        retrying: 0,
        completed: 2,
        failed: 0,
        blocked: 0,
      },
    });

    const state = await getState();

    expect(state.service.status).toBe("ready");
    expect(state.summary.running).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/state`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws ApiError on non-2xx", async () => {
    mockFetch({ error: "boom" }, { status: 500 });
    await expect(getState()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("listRuns", () => {
  it("encodes status and limit query", async () => {
    const fetchMock = mockFetch([]);

    await listRuns({ status: ["running", "blocked"], limit: 25 });

    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      `${FAKE_BASE}/api/runs?status=running%2Cblocked&limit=25`,
    );
  });

  it("omits empty query parameters", async () => {
    const fetchMock = mockFetch([]);
    await listRuns();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${FAKE_BASE}/api/runs`);
  });
});

describe("getRunDetail", () => {
  it("hits /api/runs/:runId", async () => {
    const fetchMock = mockFetch({
      run: { runId: "r1", status: "running" },
      events: [],
      logsTail: ["log line"],
    });
    const detail = await getRunDetail("r1");
    expect(detail.run.runId).toBe("r1");
    expect(detail.logsTail).toEqual(["log line"]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r1`,
    );
  });

  it("URL-encodes runId", async () => {
    const fetchMock = mockFetch({ run: {}, events: [], logsTail: [] });
    await getRunDetail("r 1/2");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r%201%2F2`,
    );
  });

  it("preserves optional report field on detail responses", async () => {
    mockFetch({
      run: { runId: "r1", status: "completed" },
      events: [],
      logsTail: [],
      report: {
        version: 1,
        runId: "r1",
        mergeReadiness: { mode: "dry-run", status: "ready", reasons: [] },
      },
    });
    const detail = await getRunDetail("r1");
    expect(detail.report?.runId).toBe("r1");
    expect(detail.report?.mergeReadiness?.status).toBe("ready");
  });
});

describe("listReports", () => {
  it("GETs /api/reports and returns typed payload", async () => {
    const fetchMock = mockFetch({
      reports: [
        {
          runId: "r1",
          issueIid: 42,
          issueTitle: "Fix checkout",
          projectId: "group/project",
          status: "completed",
          labels: ["human-review"],
          attempt: 1,
          branch: "ai/42",
          mergeReadinessStatus: "ready",
          updatedAt: "2026-05-16T00:00:00.000Z",
        },
      ],
    });

    const result = await listReports();

    expect(result.reports[0]?.runId).toBe("r1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/reports`,
    );
  });
});

describe("listEvents", () => {
  it("requires runId and passes paging", async () => {
    const fetchMock = mockFetch([]);
    await listEvents({ runId: "r1", limit: 50, offset: 10 });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/events?runId=r1&limit=50&offset=10`,
    );
  });
});

describe("listRuns includeArchived", () => {
  it("passes includeArchived=true when requested", async () => {
    const fetchMock = mockFetch([]);
    await listRuns({ includeArchived: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs?includeArchived=true`,
    );
  });

  it("omits includeArchived when false", async () => {
    const fetchMock = mockFetch([]);
    await listRuns({ includeArchived: false });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${FAKE_BASE}/api/runs`);
  });
});

describe("operator action clients", () => {
  it("retryRun POSTs without operator header by default", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`${FAKE_BASE}/api/runs/r-1/retry`);
    const reqInit = init as RequestInit;
    expect(reqInit.method).toBe("POST");
    const headers = new Headers(reqInit.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBeNull();
  });

  it("stopRun POSTs to /stop", async () => {
    const fetchMock = mockFetch({ ok: true });
    await stopRun("r-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r-1/stop`,
    );
  });

  it("archiveRun POSTs to /archive", async () => {
    const fetchMock = mockFetch({ ok: true });
    await archiveRun("r-1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r-1/archive`,
    );
  });

  it("URL-encodes runId in the action path", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r 1/2");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${FAKE_BASE}/api/runs/r%201%2F2/retry`,
    );
  });

  it("throws ApiError on 409 invalid_status", async () => {
    mockFetch({ ok: false, code: "invalid_status" }, { status: 409 });
    await expect(stopRun("r-1")).rejects.toMatchObject({
      status: 409,
      code: "invalid_status",
    });
  });

  it("throws ApiError on 409 cancel_failed with reason", async () => {
    mockFetch(
      { ok: false, code: "cancel_failed", reason: "cancel_timeout" },
      { status: 409 },
    );
    await expect(stopRun("r-1")).rejects.toMatchObject({
      status: 409,
      code: "cancel_failed",
      reason: "cancel_timeout",
    });
  });

  it("throws ApiError on 503 actions_unavailable", async () => {
    mockFetch({ ok: false, code: "actions_unavailable" }, { status: 503 });
    await expect(retryRun("r-1")).rejects.toMatchObject({
      status: 503,
      code: "actions_unavailable",
    });
  });

  it("includes operator header when explicitly supplied", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryRun("r-1", { operator: "alice" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBe("alice");
  });
});

describe("V4.1 work item client", () => {
  it("planWorkItem POSTs /api/issues/:iid/plan with body", async () => {
    const fetchMock = mockFetch({
      workItem: { workItemId: "wi_01" },
      plan: { planId: "tp_01" },
    });
    const result = await planWorkItem(42, { regenerate: true });
    expect(result.workItem.workItemId).toBe("wi_01");
    const url = fetchMock.mock.calls[0]?.[0];
    expect(url).toBe(`${FAKE_BASE}/api/issues/42/plan`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ iid: 42, regenerate: true });
  });

  it("planWorkItem propagates operator header", async () => {
    const fetchMock = mockFetch({ workItem: {}, plan: {} });
    await planWorkItem(42, {}, { operator: "alice" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBe("alice");
  });

  it("listWorkItems GETs /api/work-items and returns counters", async () => {
    const fetchMock = mockFetch({
      workItems: [{ workItemId: "wi_01" }],
      counters: {
        planning: 0,
        ready: 1,
        running: 0,
        partial: 0,
        completed: 0,
        blocked: 0,
      },
    });
    const result = await listWorkItems();
    expect(result.counters.ready).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("getWorkItem GETs /api/work-items/:id", async () => {
    const fetchMock = mockFetch({
      workItem: { workItemId: "wi_01" },
      plan: { current: { planId: "tp_01" }, history: [] },
      tasks: [],
      runLinks: [],
    });
    const result = await getWorkItem("wi_01");
    expect(result.workItem.workItemId).toBe("wi_01");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("acceptWorkItemPlan POSTs accept body with edits + planId", async () => {
    const fetchMock = mockFetch({ workItem: {}, plan: {} });
    await acceptWorkItemPlan(
      "wi_01",
      {
        planId: "tp_01",
        edits: [{ taskId: "t1", field: "title", after: "X" }],
        operator: "alice",
      },
      { operator: "alice" },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/plan/accept`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      planId: "tp_01",
      edits: [{ taskId: "t1", field: "title", after: "X" }],
      operator: "alice",
    });
  });

  it("regenerateWorkItemPlan POSTs /plan/regenerate with empty body", async () => {
    const fetchMock = mockFetch({ workItem: {}, plan: {} });
    await regenerateWorkItemPlan("wi_01");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/plan/regenerate`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("skipWorkItemTask POSTs /tasks/:taskId/skip", async () => {
    const fetchMock = mockFetch({ ok: true });
    await skipWorkItemTask("wi_01", "t1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/tasks/t1/skip`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("retryWorkItemTask POSTs /tasks/:taskId/retry", async () => {
    const fetchMock = mockFetch({ ok: true });
    await retryWorkItemTask("wi_01", "t1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/tasks/t1/retry`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getWorkItemReport GETs /report and returns optional report", async () => {
    const fetchMock = mockFetch({ report: undefined });
    const result = await getWorkItemReport("wi_01");
    expect(result.report).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/report`,
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("V4.2 work item client", () => {
  // Reset the module-level activeWorkItemsProject before every test so a
  // leftover from one test cannot leak the project header into another.
  beforeEach(() => {
    setActiveWorkItemsProject(null);
  });
  afterEach(() => {
    setActiveWorkItemsProject(null);
  });

  it("replanWorkItemTask POSTs /api/work-items/:id/tasks/:taskId/replan", async () => {
    const fetchMock = mockFetch({
      workItem: { workItemId: "wi_01" },
      plan: { planId: "tp_02" },
    });
    const result = await replanWorkItemTask(
      "wi_01",
      "t1",
      { reason: "API surface changed", hint: "expose v2" },
      { operator: "alice" },
    );
    expect(result.plan.planId).toBe("tp_02");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/tasks/t1/replan`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "API surface changed",
      hint: "expose v2",
    });
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-operator")).toBe("alice");
  });

  it("markWorkItemTaskRework POSTs /tasks/:taskId/mark-rework with reason", async () => {
    const fetchMock = mockFetch({ ok: true });
    await markWorkItemTaskRework("wi_01", "t1", {
      reason: "Reviewer wants caching",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/tasks/t1/mark-rework`,
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "Reviewer wants caching",
    });
  });

  it("unskipWorkItemTask POSTs /tasks/:taskId/unskip with empty body", async () => {
    const fetchMock = mockFetch({ ok: true });
    await unskipWorkItemTask("wi_01", "t1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/tasks/t1/unskip`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getWorkItemGraph GETs /api/work-items/:id/graph", async () => {
    const fetchMock = mockFetch({
      workItemId: "wi_01",
      planId: "tp_01",
      version: 1,
      tasks: [],
      edges: [],
      levels: [],
      criticalPath: [],
    });
    const result = await getWorkItemGraph("wi_01");
    expect(result.workItemId).toBe("wi_01");
    expect(fetchMock).toHaveBeenCalledWith(
      `${FAKE_BASE}/api/work-items/wi_01/graph`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("propagates x-issuepilot-project header from activeProject", async () => {
    setActiveWorkItemsProject("platform-web");
    const fetchMock = mockFetch({ ok: true });
    await unskipWorkItemTask("wi_01", "t1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-project")).toBe("platform-web");
  });

  it("opts.project overrides activeProject", async () => {
    setActiveWorkItemsProject("platform-web");
    const fetchMock = mockFetch({ ok: true });
    await unskipWorkItemTask("wi_01", "t1", { project: "infra-tools" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-project")).toBe("infra-tools");
  });

  it("omits x-issuepilot-project header when neither active nor opts is set", async () => {
    const fetchMock = mockFetch({ ok: true });
    await unskipWorkItemTask("wi_01", "t1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-project")).toBeNull();
  });

  it("propagates project header on GET work-item graph too", async () => {
    setActiveWorkItemsProject("platform-web");
    const fetchMock = mockFetch({
      workItemId: "wi_01",
      planId: "tp_01",
      version: 1,
      tasks: [],
      edges: [],
      levels: [],
      criticalPath: [],
    });
    await getWorkItemGraph("wi_01");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-project")).toBe("platform-web");
  });

  it("propagates project header on list work items GET request", async () => {
    setActiveWorkItemsProject("infra-tools");
    const fetchMock = mockFetch({
      workItems: [],
      counters: {
        planning: 0,
        ready: 0,
        running: 0,
        partial: 0,
        completed: 0,
        blocked: 0,
      },
    });
    await listWorkItems();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers ?? undefined);
    expect(headers.get("x-issuepilot-project")).toBe("infra-tools");
  });
});
