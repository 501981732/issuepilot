/**
 * V4.6 follow-up Task 4c (review C1 part 3/3) — default `EvidenceCollector`
 * set wired into `createTestEvidenceAgent`。
 *
 * Why a "scanner-snapshot" 单 collector：
 * - 4c 的目标是把最后一个 `agent_not_configured` 桩取掉。诚实可落地的
 *   默认行为是「扫一下 `<evidenceDir>` 下有没有先前阶段（coder 写出
 *   的 playwright zip / log / screenshot）留下的产物」，把结果落成
 *   一条 `TestEvidenceItem`，让 dashboard 看到 status = collected /
 *   skipped 而不是「agent 没接」。
 * - 单条 `CollectorOutcome` 是 agent 现行契约（`test-evidence.ts:42-50`）
 *   的硬约束；若要返回 N 条 `TestEvidenceItem` 必须扩 collector 协议
 *   到 batch outcome（plan note 里也明确允许，但属于跨契约改动）。
 *   V4.7 跟进时再做。
 *
 * TODO V4.7：扩展 collector 协议为 `CollectorOutcome | CollectorOutcome[]`
 *   或新增 `collectMany`，让一次 scan 能 emit 每个文件一条 evidence item。
 *   当前快照式 item 仅记录 evidenceDir 路径，dashboard 仍能跳转，但
 *   per-file 切片缺失。详见
 *   `docs/superpowers/specs/2026-05-15-issuepilot-gap-closure-design.md`。
 */
import { readdir, stat } from "node:fs/promises";

import type {
  CollectorInput,
  CollectorOutcome,
  EvidenceCollector,
} from "./test-evidence.js";

/**
 * 单文件 scanner snapshot collector：
 * - 若 `<evidenceDir>` 不存在 / 为空，emit `{ kind: "noop" }` —— agent
 *   loop 跳过，不把 item.length 推到 1。这是为了避免「首跑还没攒证据」
 *   的 task 被 `test-evidence.ts:185-205` 的 `allFailed = items.length
 *   > 0 && !hasCollected` 分支误判成 `evidence_unavailable`。诚实的
 *   现状是「pipeline 跑完了，但暂时没证据」，让 report.status
 *   = "complete" + evidenceItems = []。
 * - 若有任意文件 / 子目录，回落 `status: "collected"` 并把 evidenceDir
 *   写到 `artifactPath`，让 evidenceLinks[] 能聚合出 dashboard 可用的
 *   一条链接（agent.run() 会从 `item.artifactPath` 拷到顶层
 *   evidenceLinks，见 `test-evidence.ts:103-105`）。
 *
 * 注意：collector 只感知 evidenceDir 的存在性，不读文件内容，也不写。
 * 真正的 evidence 产物来自 coder / reviewer / V4.5 dispatch 路径。
 */
const scannerSnapshotCollector: EvidenceCollector = {
  name: "scanner-snapshot",
  async collect({ evidenceDir }: CollectorInput): Promise<CollectorOutcome> {
    let exists = false;
    let entries: string[] = [];
    try {
      const s = await stat(evidenceDir);
      if (s.isDirectory()) {
        exists = true;
        entries = await readdir(evidenceDir);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    if (!exists || entries.length === 0) {
      return { kind: "noop" };
    }
    return {
      kind: "item",
      item: {
        kind: "command_output",
        target: "evidence-scanner",
        source: "scanner",
        status: "collected",
        artifactPath: evidenceDir,
      },
    };
  },
};

/**
 * 默认 collector 列表：当前只挂 scanner-snapshot 一条；4c 范围内
 * 把 `agent_not_configured` 桩取掉、保留 V4.7 扩展点。
 */
export const createDefaultEvidenceCollectors = (): EvidenceCollector[] => [
  scannerSnapshotCollector,
];

/**
 * 按 task 取 collectors。当前与 `createDefaultEvidenceCollectors` 同义；
 * 留 `_task` 形参是为了 V4.7 按 role profile / task suggestedValidation
 * 动态选取 collector 集合（例如带 `screenshot` 关键字的任务再加一条
 * 截图专用 collector）。
 */
export const collectorsForTask = (
  _task: unknown,
): EvidenceCollector[] => createDefaultEvidenceCollectors();
