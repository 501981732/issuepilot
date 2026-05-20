import * as fsp from "node:fs/promises";
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
import { describe, expect, it, vi } from "vitest";

import {
  PipelineStorePathError,
  PipelineStoreReadError,
  createPipelineStore,
  createPipelineStoresByProject,
  ensurePipelineDirs,
} from "../store.js";

// V4.6 follow-up Important #2 crash-safety 测试需要在运行时把 `fs.rename`
// 替换成可控的失败 mock。Node ESM 的 module namespace 是 frozen 的，无法
// 直接 `vi.spyOn`。用 `vi.mock` 把 `node:fs/promises` 包成一个普通对象，
// 让 spy 能正确接管，并保证其它测试不受影响（行为与原模块相同）。
// （`vi.mock` 调用会被 vitest 自动 hoist 到文件顶部，放置位置仅为可读性。）
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof fsp>("node:fs/promises");
  return { ...actual };
});

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

  // ──────────────────────────────────────────────────────────────────────
  // V4.6 follow-up Important #2：supersedeAgentReport 必须 crash-atomic。
  // 现状把 prev / next 报告先逐个写盘，再写 index.json；中途 crash 会留下
  // prev.supersededBy 已切但 index 没更新（或反过来）的半完成状态。
  // 修复：每次写盘都走 `staging-file (write + fsync) → rename`，且把
  // index 切换排到最后一步；中途任意一步失败 →
  //   1) `latestAgentReportId` 仍是 supersede 之前那一刻（baseline =
  //      prevReport.id，不是 nextReport.id），且
  //   2) `supersedeChain` 仍为 `[]`，且
  //   3) role 目录里不残留 `*.tmp` 文件（write 完但 rename 失败的暂存
  //      文件必须被 best-effort unlink）。
  //
  // 设置上：`prevReport` 走完整 saveAgentReport 把 index 推进到 prev；
  // `nextReport` 用 `{ updateIndex: false }` 只落盘不动 index，让 baseline
  // 锁在 `latestAgentReportId === prevReport.id`。这样
  // `supersedeAgentReport` 自身才是 index 推进的唯一来源，crash 中途
  // 失败时「未推进」语义才能被 latest 字段断到。
  // ──────────────────────────────────────────────────────────────────────
  it("supersedeAgentReport is crash-safe: failing mid-way leaves no orphan", async () => {
    const { root, store } = await createTempStore();
    const prevReport = coderReport({ agentReportId: "ar_prev" });
    const nextReport = coderReport({
      agentReportId: "ar_next",
      pipelineRunId: "pr_2",
    });
    await store.saveAgentReport(prevReport);
    await store.saveAgentReport(nextReport, { updateIndex: false });

    // baseline：index 仍指向 prevReport，supersedeChain 还没建。
    const baseline = await store.listAgentReportsForRole({
      taskId: prevReport.taskId,
      role: "coder",
    });
    expect(baseline.index.latestAgentReportId).toBe(prevReport.agentReportId);
    expect(baseline.index.supersedeChain).toEqual([]);

    // 注入故障：让 supersedeAgentReport 内部的第二次 fs.rename 抛错（模拟
    // 写完第一个 AgentReport tmp 文件后磁盘满 / 断电）。第一次和后续 rename
    // 走真实实现，避免污染其它测试。
    const realRename = fsp.rename;
    let renameCalls = 0;
    const renameSpy = vi
      .spyOn(fsp, "rename")
      .mockImplementation(async (...args) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error("disk full (test injection)");
        }
        return realRename(
          ...(args as Parameters<typeof realRename>),
        );
      });

    try {
      await expect(
        store.supersedeAgentReport({
          taskId: prevReport.taskId,
          role: "coder",
          prevId: prevReport.agentReportId,
          nextId: nextReport.agentReportId,
        }),
      ).rejects.toThrow(/disk full/);
    } finally {
      renameSpy.mockRestore();
    }

    const after = await store.listAgentReportsForRole({
      taskId: prevReport.taskId,
      role: "coder",
    });
    // (1) index 没有被部分推进：latest 仍是 prev，chain 仍空。
    expect(after.index.latestAgentReportId).toBe(prevReport.agentReportId);
    expect(after.index.supersedeChain).toEqual([]);

    // (2) 失败的 rename 不能在 role 目录里留下 staging tmp 文件。
    //     旧实现里 writeJsonAtomic / writeIndex 在 rename 失败后没有
    //     unlink 暂存文件，会留下 `${dest}.tmp`；新实现做了 best-effort
    //     unlink。
    const roleDir = join(root, "agent-reports", prevReport.taskId, "coder");
    const remaining = await fsp.readdir(roleDir);
    const tmpLeftovers = remaining.filter((name) => name.endsWith(".tmp"));
    expect(tmpLeftovers).toEqual([]);
  });

  // V4.6 follow-up Important #1：supersedeAgentReport 在中途失败之后
  // 必须可以 retry 收敛到完整的成功状态——这是 docstring 「retry is
  // safe」契约的实测锚定。即使个别 `<reportId>.json` 在前一次失败时
  // 已写入部分 `supersededBy` / `supersedes` 字段，重跑也不应产生重
  // 复的 supersedeChain 项 / agentReportIds 项。
  it("supersedeAgentReport is idempotent: re-running after a failed mid-flight supersede converges to the success state", async () => {
    const { store } = await createTempStore();
    const prevReport = coderReport({ agentReportId: "ar_prev" });
    const nextReport = coderReport({
      agentReportId: "ar_next",
      pipelineRunId: "pr_2",
    });
    await store.saveAgentReport(prevReport);
    await store.saveAgentReport(nextReport, { updateIndex: false });

    const realRename = fsp.rename;
    let renameCalls = 0;
    const renameSpy = vi
      .spyOn(fsp, "rename")
      .mockImplementation(async (...args) => {
        renameCalls += 1;
        if (renameCalls === 2) {
          throw new Error("disk full (test injection)");
        }
        return realRename(
          ...(args as Parameters<typeof realRename>),
        );
      });

    try {
      await expect(
        store.supersedeAgentReport({
          taskId: prevReport.taskId,
          role: "coder",
          prevId: prevReport.agentReportId,
          nextId: nextReport.agentReportId,
        }),
      ).rejects.toThrow(/disk full/);
    } finally {
      renameSpy.mockRestore();
    }

    await expect(
      store.supersedeAgentReport({
        taskId: prevReport.taskId,
        role: "coder",
        prevId: prevReport.agentReportId,
        nextId: nextReport.agentReportId,
      }),
    ).resolves.toBeUndefined();

    const list = await store.listAgentReportsForRole({
      taskId: prevReport.taskId,
      role: "coder",
    });
    expect(list.index.latestAgentReportId).toBe(nextReport.agentReportId);
    expect(list.index.supersedeChain).toEqual([
      { from: prevReport.agentReportId, to: nextReport.agentReportId },
    ]);
    expect([...list.index.agentReportIds].sort()).toEqual(
      [prevReport.agentReportId, nextReport.agentReportId].sort(),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// V4.6 review fix C4 — PipelineStore.listAllAgentReports (cross-task/role
// listing used by daemon to feed buildQualitySummary({ agentReports }))
// ────────────────────────────────────────────────────────────────────────────

describe("PipelineStore.listAllAgentReports (V4.6 review C4)", () => {
  it("filters by sinceIso and excludes superseded by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-store-listall-"));
    const store = createPipelineStore({ root });
    await store.saveAgentReport(
      coderReport({
        agentReportId: "ar_old",
        startedAt: "2026-05-19T00:00:00.000Z",
        supersededBy: "ar_new",
      }),
    );
    await store.saveAgentReport(
      coderReport({
        agentReportId: "ar_new",
        startedAt: "2026-05-20T00:00:00.000Z",
      }),
    );
    await store.saveAgentReport(
      reviewerReport({
        agentReportId: "ar_rev_new",
        startedAt: "2026-05-20T01:00:00.000Z",
      }),
    );

    const recent = await store.listAllAgentReports({
      sinceIso: "2026-05-19T12:00:00.000Z",
    });
    expect(recent.map((r) => r.agentReportId).sort()).toEqual([
      "ar_new",
      "ar_rev_new",
    ]);

    const recentWithSuperseded = await store.listAllAgentReports({
      sinceIso: "2026-05-19T12:00:00.000Z",
      includeSuperseded: true,
    });
    expect(recentWithSuperseded.map((r) => r.agentReportId).sort()).toEqual([
      "ar_new",
      "ar_rev_new",
    ]);

    const fromDawn = await store.listAllAgentReports({
      includeSuperseded: true,
    });
    expect(fromDawn).toHaveLength(3);
  });

  it("returns [] when agent-reports dir does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "ip-store-empty-"));
    const store = createPipelineStore({ root });
    const out = await store.listAllAgentReports();
    expect(out).toEqual([]);
  });

  it("skips index.json sentinel files when scanning role dirs", async () => {
    const { store } = await createTempStore();
    await store.saveAgentReport(
      coderReport({ agentReportId: "ar_only", startedAt: "2026-05-20T00:00:00.000Z" }),
    );
    const all = await store.listAllAgentReports({ includeSuperseded: true });
    expect(all).toHaveLength(1);
    expect(all[0]?.agentReportId).toBe("ar_only");
  });

  // ──────────────────────────────────────────────────────────────────────
  // V4.6 review follow-up (Issue 2)：单文件损坏不应该阻塞整个 byRole 切片。
  // readJsonSafe 在 (a) 非 ENOENT 读失败、(b) JSON parse 失败、(c) schema
  // 不匹配 三种情况都会抛 `PipelineStoreReadError`，listAllAgentReports
  // 应该把这种条目静默跳过（continue），让全量扫描产出尽量多的可用数据。
  // ──────────────────────────────────────────────────────────────────────
  it("skips files with corrupt JSON instead of aborting the whole scan", async () => {
    const { root, store } = await createTempStore();
    await store.saveAgentReport(
      coderReport({
        agentReportId: "ar_good_1",
        startedAt: "2026-05-20T00:00:00.000Z",
      }),
    );
    await store.saveAgentReport(
      coderReport({
        agentReportId: "ar_good_2",
        startedAt: "2026-05-20T00:30:00.000Z",
      }),
    );
    const corruptPath = join(
      root,
      "agent-reports",
      "t_1",
      "coder",
      "ar_corrupt.json",
    );
    await writeFile(corruptPath, "{not valid json", "utf8");

    const all = await store.listAllAgentReports({ includeSuperseded: true });
    expect(all.map((r) => r.agentReportId).sort()).toEqual([
      "ar_good_1",
      "ar_good_2",
    ]);
  });

  it("skips files with schema mismatch instead of aborting the whole scan", async () => {
    const { root, store } = await createTempStore();
    await store.saveAgentReport(
      coderReport({
        agentReportId: "ar_good_3",
        startedAt: "2026-05-20T00:00:00.000Z",
      }),
    );
    const badShapePath = join(
      root,
      "agent-reports",
      "t_1",
      "coder",
      "ar_wrong_shape.json",
    );
    await mkdir(join(root, "agent-reports", "t_1", "coder"), {
      recursive: true,
    });
    await writeFile(badShapePath, JSON.stringify({ foo: "bar" }), "utf8");

    const all = await store.listAllAgentReports({ includeSuperseded: true });
    expect(all.map((r) => r.agentReportId)).toEqual(["ar_good_3"]);
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
