import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentReport,
  CoderAgentReport,
  PipelineRun,
  ReviewerAgentReport,
  TestEvidenceAgentReport,
} from "@issuepilot/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  PipelineStorePathError,
  PipelineStoreReadError,
  createPipelineStore,
  createPipelineStoresByProject,
  ensurePipelineDirs,
} from "../store.js";

const isoNow = () => "2026-05-19T11:00:00.000Z";

function pipelineRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    pipelineRunId: "pr_1",
    workItemId: "wi_1",
    taskId: "t_1",
    recipe: "full_pipeline",
    recipeSource: "workflow_default",
    agentReportIds: {
      coder: null,
      reviewer: null,
      test_evidence: null,
    },
    status: "running_coding",
    currentRole: "coder",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    ...over,
  };
}

function coderReport(
  over: Partial<CoderAgentReport> = {},
): CoderAgentReport {
  return {
    agentReportId: "ar_coder_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "coder",
    roleProfileId: "coder@v1",
    status: "complete",
    startedAt: isoNow(),
    evidenceLinks: [],
    redactedFields: [],
    coder: {
      diffSummary: "diff",
      branch: "issuepilot/wi_1/t_1",
    },
    ...over,
  };
}

function reviewerReport(
  over: Partial<ReviewerAgentReport> = {},
): ReviewerAgentReport {
  return {
    agentReportId: "ar_rev_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "reviewer",
    roleProfileId: "reviewer@v1",
    status: "complete",
    startedAt: isoNow(),
    evidenceLinks: [],
    redactedFields: [],
    reviewer: {
      summary: "ok",
      decision: "approve_with_comments",
      confidence: 0.8,
      risks: [],
      evidenceRequest: [],
      findings: [],
      inlineComments: [],
      mrPublication: { status: "pending", noteIds: [] },
    },
    ...over,
  };
}

function testEvidenceReport(
  over: Partial<TestEvidenceAgentReport> = {},
): TestEvidenceAgentReport {
  return {
    agentReportId: "ar_te_1",
    pipelineRunId: "pr_1",
    taskId: "t_1",
    role: "test_evidence",
    roleProfileId: "test_evidence@v1",
    status: "complete",
    startedAt: isoNow(),
    evidenceLinks: [],
    redactedFields: [],
    testEvidence: {
      evidenceItems: [],
      baselineEvidence: null,
    },
    ...over,
  };
}

async function createTempStore() {
  const root = await mkdtemp(join(tmpdir(), "ip-pipeline-"));
  return { root, store: createPipelineStore({ root }) };
}

describe("PipelineStore.savePipelineRun + getPipelineRunById", () => {
  it("写入 PipelineRun 到 pipelines/<wid>/<tid>/<prid>.json 并能读回", async () => {
    const { root, store } = await createTempStore();
    const run = pipelineRun();
    await store.savePipelineRun(run);
    const expectedPath = join(
      root,
      "pipelines",
      run.workItemId,
      run.taskId,
      `${run.pipelineRunId}.json`,
    );
    const raw = await readFile(expectedPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      pipelineRunId: "pr_1",
      workItemId: "wi_1",
      taskId: "t_1",
      recipe: "full_pipeline",
    });
    const loaded = await store.getPipelineRunById({
      workItemId: run.workItemId,
      taskId: run.taskId,
      pipelineRunId: run.pipelineRunId,
    });
    expect(loaded?.pipelineRunId).toBe(run.pipelineRunId);
  });

  it("路径含 .. 或绝对路径 → PipelineStorePathError", async () => {
    const { store } = await createTempStore();
    await expect(
      store.savePipelineRun(pipelineRun({ workItemId: "../etc" })),
    ).rejects.toBeInstanceOf(PipelineStorePathError);
    await expect(
      store.savePipelineRun(
        pipelineRun({ pipelineRunId: "/tmp/abs" }),
      ),
    ).rejects.toBeInstanceOf(PipelineStorePathError);
  });

  it("损坏 JSON → PipelineStoreReadError", async () => {
    const { root, store } = await createTempStore();
    const dir = join(root, "pipelines", "wi_1", "t_1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pr_broken.json"), "{not json}", "utf8");
    await expect(
      store.getPipelineRunById({
        workItemId: "wi_1",
        taskId: "t_1",
        pipelineRunId: "pr_broken",
      }),
    ).rejects.toBeInstanceOf(PipelineStoreReadError);
  });

  it("不存在的 pipelineRun 返回 null", async () => {
    const { store } = await createTempStore();
    const res = await store.getPipelineRunById({
      workItemId: "wi_1",
      taskId: "t_1",
      pipelineRunId: "pr_missing",
    });
    expect(res).toBeNull();
  });
});

describe("PipelineStore.listForTask + latestForTask", () => {
  it("按 createdAt 倒序返回；supersede 末端标 latest=true", async () => {
    const { store } = await createTempStore();
    const a = pipelineRun({
      pipelineRunId: "pr_a",
      createdAt: "2026-05-18T10:00:00.000Z",
      updatedAt: "2026-05-18T10:00:00.000Z",
      supersededBy: "pr_b",
    });
    const b = pipelineRun({
      pipelineRunId: "pr_b",
      createdAt: "2026-05-19T10:00:00.000Z",
      updatedAt: "2026-05-19T10:00:00.000Z",
      supersedes: "pr_a",
    });
    await store.savePipelineRun(a);
    await store.savePipelineRun(b);

    const list = await store.listForTask({ workItemId: "wi_1", taskId: "t_1" });
    expect(list.map((it) => it.pipelineRun.pipelineRunId)).toEqual([
      "pr_b",
      "pr_a",
    ]);
    expect(list[0]!.latest).toBe(true);
    expect(list[1]!.latest).toBe(false);

    const latest = await store.latestForTask({
      workItemId: "wi_1",
      taskId: "t_1",
    });
    expect(latest?.pipelineRunId).toBe("pr_b");
  });

  it("task 目录不存在 → 空数组", async () => {
    const { store } = await createTempStore();
    const list = await store.listForTask({
      workItemId: "wi_unknown",
      taskId: "t_unknown",
    });
    expect(list).toEqual([]);
  });
});

describe("PipelineStore.supersede", () => {
  it("把 prev.supersededBy / next.supersedes 双向写回", async () => {
    const { store } = await createTempStore();
    const prev = pipelineRun({ pipelineRunId: "pr_a" });
    const next = pipelineRun({
      pipelineRunId: "pr_b",
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:00:00.000Z",
    });
    await store.savePipelineRun(prev);
    await store.savePipelineRun(next);
    await store.supersede({
      workItemId: "wi_1",
      taskId: "t_1",
      prevId: "pr_a",
      nextId: "pr_b",
    });
    const a = await store.getPipelineRunById({
      workItemId: "wi_1",
      taskId: "t_1",
      pipelineRunId: "pr_a",
    });
    const b = await store.getPipelineRunById({
      workItemId: "wi_1",
      taskId: "t_1",
      pipelineRunId: "pr_b",
    });
    expect(a?.supersededBy).toBe("pr_b");
    expect(b?.supersedes).toBe("pr_a");
  });

  it("prev/next 缺失 → PipelineStoreReadError", async () => {
    const { store } = await createTempStore();
    await expect(
      store.supersede({
        workItemId: "wi_1",
        taskId: "t_1",
        prevId: "pr_a",
        nextId: "pr_b",
      }),
    ).rejects.toBeInstanceOf(PipelineStoreReadError);
  });
});

describe("PipelineStore.saveAgentReport + index.json", () => {
  it("写入 AgentReport 并维护 index.json 的 agentReportIds / latestAgentReportId", async () => {
    const { root, store } = await createTempStore();
    const r1 = coderReport();
    const r2 = coderReport({
      agentReportId: "ar_coder_2",
      pipelineRunId: "pr_2",
    });
    await store.saveAgentReport(r1);
    await store.saveAgentReport(r2);

    const reportPath = join(
      root,
      "agent-reports",
      r1.taskId,
      "coder",
      `${r1.agentReportId}.json`,
    );
    const reportRaw = await readFile(reportPath, "utf8");
    expect(JSON.parse(reportRaw)).toMatchObject({
      agentReportId: "ar_coder_1",
      role: "coder",
    });

    const indexPath = join(root, "agent-reports", r1.taskId, "coder", "index.json");
    const idxRaw = await readFile(indexPath, "utf8");
    const idx = JSON.parse(idxRaw);
    expect(idx.agentReportIds).toEqual([r1.agentReportId, r2.agentReportId]);
    expect(idx.latestAgentReportId).toBe(r2.agentReportId);
  });

  it("redact：包含 glpat- token 的字段落盘时被替换成 [REDACTED]", async () => {
    const { root, store } = await createTempStore();
    const r1 = coderReport({
      coder: {
        diffSummary: "use glpat-AAAAAAAAAAAAAAAAAAAA to push",
        branch: "issuepilot/wi/t",
      },
    });
    await store.saveAgentReport(r1);
    const reportPath = join(
      root,
      "agent-reports",
      r1.taskId,
      "coder",
      `${r1.agentReportId}.json`,
    );
    const reportRaw = await readFile(reportPath, "utf8");
    expect(reportRaw).toContain("[REDACTED]");
    expect(reportRaw).not.toContain("glpat-AAAAAAAAAAAAAAAAAAAA");
  });

  it("role 取值非法 → PipelineStorePathError", async () => {
    const { store } = await createTempStore();
    const bogus = {
      ...coderReport(),
      role: "evil" as never,
    } as unknown as AgentReport;
    await expect(store.saveAgentReport(bogus)).rejects.toBeInstanceOf(
      PipelineStorePathError,
    );
  });

  it("agentReportId 含越权片段 → PipelineStorePathError", async () => {
    const { store } = await createTempStore();
    const bogus = coderReport({ agentReportId: "../escape" });
    await expect(store.saveAgentReport(bogus)).rejects.toBeInstanceOf(
      PipelineStorePathError,
    );
  });
});

describe("PipelineStore.listAgentReportsForRole + latestAgentReportForRole", () => {
  it("按 index.json 顺序返回报告；latestAgentReportForRole 返回 supersede 末端", async () => {
    const { store } = await createTempStore();
    const r1 = reviewerReport();
    const r2 = reviewerReport({
      agentReportId: "ar_rev_2",
      pipelineRunId: "pr_2",
    });
    await store.saveAgentReport(r1);
    await store.saveAgentReport(r2);

    const { reports, index } = await store.listAgentReportsForRole({
      taskId: r1.taskId,
      role: "reviewer",
    });
    expect(reports.map((r) => r.agentReportId)).toEqual([
      r1.agentReportId,
      r2.agentReportId,
    ]);
    expect(index.latestAgentReportId).toBe(r2.agentReportId);

    const latest = await store.latestAgentReportForRole({
      taskId: r1.taskId,
      role: "reviewer",
    });
    expect(latest?.agentReportId).toBe(r2.agentReportId);
  });

  it("没有任何报告时返回空数组 + null latest", async () => {
    const { store } = await createTempStore();
    const { reports, index } = await store.listAgentReportsForRole({
      taskId: "t_empty",
      role: "test_evidence",
    });
    expect(reports).toEqual([]);
    expect(index.latestAgentReportId).toBeNull();
    expect(
      await store.latestAgentReportForRole({
        taskId: "t_empty",
        role: "test_evidence",
      }),
    ).toBeNull();
  });

  it("写入 test_evidence 报告同样维护独立的 index.json", async () => {
    const { store } = await createTempStore();
    await store.saveAgentReport(testEvidenceReport());
    const idx = (
      await store.listAgentReportsForRole({
        taskId: "t_1",
        role: "test_evidence",
      })
    ).index;
    expect(idx.latestAgentReportId).toBe("ar_te_1");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// V4.6 Phase 8 Task 8.2 — AgentReport supersede chain (retry test_evidence)
// ────────────────────────────────────────────────────────────────────────────

describe("PipelineStore.supersedeAgentReport", () => {
  it("links prev.supersededBy / next.supersedes both ways and updates index.supersedeChain", async () => {
    const { store } = await createTempStore();
    const r1 = testEvidenceReport({ agentReportId: "ar_te_1" });
    const r2 = testEvidenceReport({
      agentReportId: "ar_te_2",
      pipelineRunId: r1.pipelineRunId,
      startedAt: "2026-05-19T12:00:00.000Z",
    });
    await store.saveAgentReport(r1);
    await store.saveAgentReport(r2);

    await store.supersedeAgentReport({
      taskId: r1.taskId,
      role: "test_evidence",
      prevId: r1.agentReportId,
      nextId: r2.agentReportId,
    });

    const refreshed1 = await store.getAgentReport({
      taskId: r1.taskId,
      role: "test_evidence",
      agentReportId: r1.agentReportId,
    });
    const refreshed2 = await store.getAgentReport({
      taskId: r2.taskId,
      role: "test_evidence",
      agentReportId: r2.agentReportId,
    });
    expect(refreshed1?.supersededBy).toBe("ar_te_2");
    expect(refreshed2?.supersedes).toBe("ar_te_1");

    const { index } = await store.listAgentReportsForRole({
      taskId: r1.taskId,
      role: "test_evidence",
    });
    expect(index.supersedeChain).toEqual([
      { from: "ar_te_1", to: "ar_te_2" },
    ]);
    expect(index.latestAgentReportId).toBe("ar_te_2");
  });

  it("throws PipelineStoreReadError when prev or next is missing", async () => {
    const { store } = await createTempStore();
    await store.saveAgentReport(testEvidenceReport({ agentReportId: "ar_te_only" }));
    await expect(
      store.supersedeAgentReport({
        taskId: "t_1",
        role: "test_evidence",
        prevId: "ar_te_only",
        nextId: "ar_te_missing",
      }),
    ).rejects.toBeInstanceOf(PipelineStoreReadError);
  });
});

describe("createPipelineStoresByProject", () => {
  it("按 projectId 隔离根目录；upsert 同根目录返回同实例", async () => {
    const tmp1 = await mkdtemp(join(tmpdir(), "ip-pipeline-proj-a-"));
    const tmp2 = await mkdtemp(join(tmpdir(), "ip-pipeline-proj-b-"));
    const stores = createPipelineStoresByProject([
      { projectId: "p1", root: tmp1 },
      { projectId: "p2", root: tmp2 },
    ]);
    expect(stores.get("p1")?.root).toBe(tmp1);
    expect(stores.get("p2")?.root).toBe(tmp2);
    const sameAgain = stores.upsert({ projectId: "p1", root: tmp1 });
    expect(sameAgain).toBe(stores.get("p1"));
    const list = stores.list();
    expect(list.map((it) => it.projectId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("ensurePipelineDirs", () => {
  it("会创建 pipelines / agent-reports 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-pipeline-mk-"));
    await ensurePipelineDirs(root);
    const ok = async (p: string) => {
      const { stat } = await import("node:fs/promises");
      const s = await stat(p);
      return s.isDirectory();
    };
    expect(await ok(join(root, "pipelines"))).toBe(true);
    expect(await ok(join(root, "agent-reports"))).toBe(true);
  });
});
