// Mini mock orchestrator for the V2.5 Command Center UI preview.
// Serves canned `/api/state` / `/api/runs` / `/api/runs/:id` / `/api/reports`
// responses + a heartbeat SSE stream so the dashboard renders the
// Command Center, Review Packet, and Reports page end to end without
// needing real GitLab / Codex credentials.
//
// Usage:
//   node scripts/demo/mock-orchestrator.mjs
//
// Then start the dashboard in another terminal pointing at this port:
//   NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm --filter @issuepilot/dashboard dev

/* global URL, clearInterval, console, process, setInterval */

import http from "node:http";

const PORT = Number(process.env.PORT ?? 4738);
const HOST = "127.0.0.1";

const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
const twelveMinutesAgo = new Date(Date.now() - 12 * 60_000).toISOString();
const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();

// Two sample report artifacts: one ready-to-merge, one blocked by review.
const reports = {
  "run-101": {
    version: 1,
    runId: "run-101",
    issue: {
      iid: 101,
      title: "Fix dashboard navigation bug",
      url: "https://gitlab.example.com/g/p/-/issues/101",
      projectId: "demo/web",
      labels: ["human-review"],
    },
    run: {
      status: "completed",
      attempt: 1,
      branch: "ai/101-fix-nav",
      workspacePath: "~/.issuepilot/workspaces/demo-web/101",
      startedAt: twelveMinutesAgo,
      endedAt: fiveMinutesAgo,
      durations: { totalMs: 7 * 60_000 },
    },
    handoff: {
      summary:
        "Adjusted the `<NavLink>` active state to compare normalized URL paths so collapsible menus open correctly on hash navigation.",
      validation: [
        "pnpm --filter @issuepilot/dashboard test (96/96 passed)",
        "Manual smoke on Chrome 130 confirms the bug is fixed",
      ],
      risks: [
        {
          level: "low",
          text: "URL normalization may differ on rare hash-only routes; covered by a new vitest case.",
        },
      ],
      followUps: ["Consider exposing the matcher as a hook for embedders."],
      nextAction:
        "Review and merge the MR, or move this Issue to `ai-rework` if changes are required.",
    },
    diff: {
      summary: "1 fix + 1 test",
      filesChanged: 2,
      notableFiles: [
        "apps/dashboard/components/ui/nav-link.tsx",
        "apps/dashboard/components/ui/nav-link.test.tsx",
      ],
    },
    checks: [
      { name: "CI pipeline", status: "passed" },
      { name: "Approvals", status: "passed" },
      { name: "Review feedback", status: "passed" },
      { name: "Risk gate", status: "passed" },
    ],
    mergeReadiness: {
      mode: "dry-run",
      status: "ready",
      reasons: [
        {
          code: "all_gates_passed",
          severity: "info",
          message:
            "CI passed, no unresolved reviewer comments, no high-severity risks.",
        },
      ],
      evaluatedAt: fiveMinutesAgo,
    },
    ci: { status: "success", checkedAt: fiveMinutesAgo },
    mergeRequest: {
      iid: 451,
      url: "https://gitlab.example.com/g/p/-/merge_requests/451",
      state: "opened",
      approvals: { required: 1, currentCount: 1 },
    },
    reviewFeedback: { latestCursor: null, unresolvedCount: 0, comments: [] },
    notes: { handoffNoteId: 9001 },
  },
  "run-102": {
    version: 1,
    runId: "run-102",
    issue: {
      iid: 102,
      title: "Add CSV export to reports page",
      url: "https://gitlab.example.com/g/p/-/issues/102",
      projectId: "demo/web",
      labels: ["human-review"],
    },
    run: {
      status: "completed",
      attempt: 2,
      branch: "ai/102-csv-export",
      workspacePath: "~/.issuepilot/workspaces/demo-web/102",
      startedAt: oneHourAgo,
      endedAt: fiveMinutesAgo,
      durations: { totalMs: 55 * 60_000 },
    },
    handoff: {
      summary:
        "Added a CSV export button to the Reports page. Streams the summary table through `papaparse` to keep the renderer thin.",
      validation: ["pnpm --filter @issuepilot/dashboard test"],
      risks: [
        {
          level: "medium",
          text: "Reviewer flagged that the export filename should include the project slug; needs a follow-up.",
        },
      ],
      followUps: [
        "Filename should include project slug",
        "Add empty-state copy when there are no rows",
      ],
      nextAction:
        "Review and merge the MR, or move this Issue to `ai-rework` if changes are required.",
    },
    diff: {
      summary: "1 feature + 2 tests",
      filesChanged: 4,
      notableFiles: [
        "apps/dashboard/components/reports/reports-page.tsx",
        "apps/dashboard/components/reports/export-button.tsx",
      ],
    },
    checks: [
      { name: "CI pipeline", status: "passed" },
      { name: "Approvals", status: "failed" },
      { name: "Review feedback", status: "failed" },
      { name: "Risk gate", status: "unknown" },
    ],
    mergeReadiness: {
      mode: "dry-run",
      status: "blocked",
      reasons: [
        {
          code: "review_unresolved",
          severity: "blocking",
          message: "1 unresolved reviewer comment.",
        },
        {
          code: "approval_missing",
          severity: "blocking",
          message: "Approvals required: 1, currently 0.",
        },
      ],
      evaluatedAt: fiveMinutesAgo,
    },
    ci: { status: "success", checkedAt: fiveMinutesAgo },
    mergeRequest: {
      iid: 452,
      url: "https://gitlab.example.com/g/p/-/merge_requests/452",
      state: "opened",
      approvals: { required: 1, currentCount: 0 },
    },
    reviewFeedback: {
      latestCursor: "2026-05-16T10:30:00.000Z",
      unresolvedCount: 1,
      comments: [
        {
          author: "alice",
          body: "Filename should include the project slug, e.g. `demo-web-report-2026-05-16.csv`.",
          url: "https://gitlab.example.com/g/p/-/merge_requests/452#note_77",
          resolved: false,
          createdAt: "2026-05-16T10:30:00.000Z",
        },
      ],
    },
    notes: { handoffNoteId: 9002 },
  },
};

function buildSummary(report) {
  const order = { low: 1, medium: 2, high: 3 };
  const highestRisk = report.handoff.risks.reduce(
    (acc, r) => (order[r.level] > order[acc] ? r.level : acc),
    "low",
  );
  return {
    runId: report.runId,
    issueIid: report.issue.iid,
    issueTitle: report.issue.title,
    projectId: report.issue.projectId,
    status: report.run.status,
    labels: report.issue.labels,
    attempt: report.run.attempt,
    branch: report.run.branch,
    mergeRequestUrl: report.mergeRequest?.url,
    ciStatus: report.ci?.status,
    mergeReadinessStatus: report.mergeReadiness.status,
    highestRisk,
    updatedAt: report.run.endedAt ?? report.run.startedAt,
    totalMs: report.run.durations?.totalMs,
  };
}

const runRecords = Object.values(reports).map((r) => ({
  runId: r.runId,
  status: r.run.status,
  attempt: r.run.attempt,
  branch: r.run.branch,
  issue: { id: `gid://issue/${r.issue.iid}`, ...r.issue },
  startedAt: r.run.startedAt,
  updatedAt: r.run.endedAt ?? r.run.startedAt,
  endedAt: r.run.endedAt,
  workspacePath: r.run.workspacePath,
  mergeRequestUrl: r.mergeRequest?.url,
  latestCiStatus: r.ci?.status,
  latestCiCheckedAt: r.ci?.checkedAt,
  report: buildSummary(r),
}));

const state = {
  service: {
    status: "ready",
    workflowPath: "/Users/demo/projects/web/.agents/workflow.md",
    gitlabProject: "demo/web",
    pollIntervalMs: 10000,
    concurrency: 1,
    lastConfigReloadAt: oneHourAgo,
    lastPollAt: fiveMinutesAgo,
    workspaceUsageGb: 0.02,
    nextCleanupAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  },
  summary: {
    running: 0,
    retrying: 0,
    "human-review": 2,
    failed: 0,
    blocked: 0,
  },
};

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(json);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type, accept, x-issuepilot-operator",
    });
    res.end();
    return;
  }

  if (pathname === "/api/state") {
    return send(res, 200, state);
  }
  if (pathname === "/api/runs" && req.method === "GET") {
    return send(res, 200, runRecords);
  }
  const detailMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (detailMatch && req.method === "GET") {
    const runId = decodeURIComponent(detailMatch[1]);
    const report = reports[runId];
    if (!report) return send(res, 404, { code: "run_not_found" });
    return send(res, 200, {
      run: runRecords.find((r) => r.runId === runId),
      events: [
        {
          type: "claim_succeeded",
          runId,
          ts: report.run.startedAt,
          detail: { iid: report.issue.iid },
        },
        {
          type: "dispatch_completed",
          runId,
          ts: report.run.endedAt,
          detail: {},
        },
      ],
      logsTail: [
        `[${report.run.startedAt}] dispatch_start iid=${report.issue.iid}`,
        `[${report.run.endedAt}] dispatch_completed status=human-review`,
      ],
      report,
    });
  }
  if (pathname === "/api/reports") {
    return send(res, 200, {
      reports: Object.values(reports).map(buildSummary),
    });
  }
  if (pathname === "/api/events") {
    return send(res, 200, []);
  }
  if (pathname === "/api/events/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    const ping = () => res.write(`: ping ${Date.now()}\n\n`);
    ping();
    const interval = setInterval(ping, 15000);
    req.on("close", () => clearInterval(interval));
    return;
  }
  if (req.method === "POST") {
    return send(res, 200, { ok: true });
  }
  send(res, 404, { code: "not_found", path: pathname });
});

server.listen(PORT, HOST, () => {
  console.log(
    `IssuePilot V2.5 mock orchestrator ready: http://${HOST}:${PORT}`,
  );
});
