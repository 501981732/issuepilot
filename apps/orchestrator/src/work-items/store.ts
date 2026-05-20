import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redact } from "@issuepilot/observability";
import type {
  TaskNode,
  TaskPlan,
  TaskRunLink,
  WorkItem,
  WorkItemReport,
} from "@issuepilot/shared-contracts";
import { legacyRunningStateToV46 } from "@issuepilot/shared-contracts";

/**
 * V4.1 Work Item Store。
 *
 * 落地路径锁定 spec §10：
 *
 *   work-items/<workItemId>.json
 *   task-plans/<planId>.json
 *   task-run-links/<taskId>/<runId>.json
 *   work-item-reports/<workItemId>.json
 *
 * 内存缓存只是 fast path，所有写都过 fs；读时若内存缺失，回退磁盘。
 * `redact()` 走 observability 包，避免 token / 凭据落盘。
 *
 * V4.1 不引入 Postgres（spec §10）；这一层是 V3 平台化的边界。
 */
export interface WorkItemStore {
  saveWorkItem(item: WorkItem): Promise<void>;
  getWorkItem(id: string): Promise<WorkItem | undefined>;
  listWorkItems(): Promise<WorkItem[]>;

  saveTaskPlan(plan: TaskPlan): Promise<void>;
  /**
   * 当前 plan 的语义：在该 workItem 下，按 `version` 取最新一份，前提是
   * `status !== "rejected"`。`rejected` 仅保留为历史。`superseded` 也算
   * 历史，但实践上 superseded 出现时通常已经有新 draft，因此排在更早。
   */
  getCurrentPlan(workItemId: string): Promise<TaskPlan | undefined>;
  /** 按 `version` 升序返回 workItem 名下全部 plan。 */
  listPlanHistory(workItemId: string): Promise<TaskPlan[]>;

  saveTaskRunLink(link: TaskRunLink): Promise<void>;
  listTaskRunLinks(taskId: string): Promise<TaskRunLink[]>;
  /**
   * 用 WorkItem.taskIds 反查每个 taskId 目录下的 link。需要 workItem
   * 已经在 store 中存在（spec §9.4：TaskRunLink 是 canonical binding，
   * 但 taskId → workItem 的映射来自 WorkItem.taskIds）。
   */
  listAllTaskRunLinks(workItemId: string): Promise<TaskRunLink[]>;

  saveReport(report: WorkItemReport): Promise<void>;
  getReport(workItemId: string): Promise<WorkItemReport | undefined>;

  loadEvidenceConfirmations(
    workItemId: string,
  ): Promise<Record<string, EvidenceConfirmation>>;
  saveEvidenceConfirmation(
    workItemId: string,
    evidenceId: string,
    confirmation: EvidenceConfirmation,
  ): Promise<EvidenceConfirmation>;
}

export interface EvidenceConfirmation {
  confirmedBy: string;
  confirmedAt: string;
}

export interface CreateWorkItemStoreOptions {
  /** `~/.issuepilot/` 的等价物。所有 V4.1 资源在此目录下展开。 */
  rootDir: string;
}

const WORK_ITEMS_DIR = "work-items";
const TASK_PLANS_DIR = "task-plans";
const TASK_RUN_LINKS_DIR = "task-run-links";
const WORK_ITEM_REPORTS_DIR = "work-item-reports";
const EVIDENCE_CONFIRMATIONS_DIR = "evidence-confirmations";

export function createWorkItemStore(
  opts: CreateWorkItemStoreOptions,
): WorkItemStore {
  const workItems = new Map<string, WorkItem>();
  const plansById = new Map<string, TaskPlan>();
  // plansByWorkItem 是 workItemId -> Set<planId>，避免每次扫整个目录。
  const plansByWorkItem = new Map<string, Set<string>>();
  const taskRunLinks = new Map<string, Map<string, TaskRunLink>>();
  const reports = new Map<string, WorkItemReport>();
  const evidenceConfirmations = new Map<
    string,
    Record<string, EvidenceConfirmation>
  >();
  const evidenceConfirmationWrites = new Map<string, Promise<unknown>>();

  function workItemPath(id: string): string {
    return join(opts.rootDir, WORK_ITEMS_DIR, `${id}.json`);
  }
  function planPath(planId: string): string {
    return join(opts.rootDir, TASK_PLANS_DIR, `${planId}.json`);
  }
  function linkPath(taskId: string, runId: string): string {
    return join(opts.rootDir, TASK_RUN_LINKS_DIR, taskId, `${runId}.json`);
  }
  function reportPath(workItemId: string): string {
    return join(opts.rootDir, WORK_ITEM_REPORTS_DIR, `${workItemId}.json`);
  }
  function evidenceConfirmationsPath(workItemId: string): string {
    return join(
      opts.rootDir,
      EVIDENCE_CONFIRMATIONS_DIR,
      `${workItemId}.json`,
    );
  }

  async function writeJson(path: string, payload: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(redact(payload), null, 2)}\n`, "utf8");
  }

  async function readJson<T>(path: string): Promise<T | undefined> {
    try {
      const body = await readFile(path, "utf8");
      return JSON.parse(body) as T;
    } catch {
      return undefined;
    }
  }

  /**
   * V4.6 spec §8.0 / §16.2：把 TaskNode.status 中遗留的 `running` 升级为
   * `running_coding`。仅在读路径上做（saveTaskPlan 写入的是新值时
   * 直接保留），这样既不破坏旧仓库快照，也避免重复写盘。
   */
  function migrateTaskNode(task: TaskNode): TaskNode {
    if (task.status === "running") {
      return { ...task, status: legacyRunningStateToV46(task.status) };
    }
    return task;
  }

  function migratePlan(plan: TaskPlan): TaskPlan {
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return plan;
    let mutated = false;
    const tasks = plan.tasks.map((t) => {
      const next = migrateTaskNode(t);
      if (next !== t) mutated = true;
      return next;
    });
    return mutated ? { ...plan, tasks } : plan;
  }

  function indexPlan(plan: TaskPlan): void {
    plansById.set(plan.planId, plan);
    let bucket = plansByWorkItem.get(plan.workItemId);
    if (!bucket) {
      bucket = new Set();
      plansByWorkItem.set(plan.workItemId, bucket);
    }
    bucket.add(plan.planId);
  }

  /**
   * Hot-load every plan file once into the in-memory index. Plans are stored
   * flat as `task-plans/<planId>.json` (spec §10), so we cannot stat a single
   * file to answer `getCurrentPlan(workItemId)` — we must scan the directory
   * and rebuild `plansByWorkItem`. `workItemId` is accepted by name so the
   * intent at the call site stays readable, but the loader deliberately
   * indexes every plan it sees (already-cached ones are skipped via
   * `plansById.has(planId)`), since the next `getCurrentPlan` for a sibling
   * WorkItem will then hit the cache without re-reading disk.
   */
  async function loadPlansFromDisk(_workItemId: string): Promise<void> {
    const dir = join(opts.rootDir, TASK_PLANS_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const planId = entry.slice(0, -".json".length);
      if (plansById.has(planId)) continue;
      const raw = await readJson<TaskPlan>(join(dir, entry));
      if (!raw) continue;
      indexPlan(migratePlan(raw));
    }
  }

  return {
    async saveWorkItem(item) {
      workItems.set(item.workItemId, item);
      await writeJson(workItemPath(item.workItemId), item);
    },

    async getWorkItem(id) {
      const cached = workItems.get(id);
      if (cached) return cached;
      const loaded = await readJson<WorkItem>(workItemPath(id));
      if (loaded) workItems.set(id, loaded);
      return loaded;
    },

    async listWorkItems() {
      const dir = join(opts.rootDir, WORK_ITEMS_DIR);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return [...workItems.values()].sort(byCreatedAtDesc);
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.slice(0, -".json".length);
        if (workItems.has(id)) continue;
        const loaded = await readJson<WorkItem>(join(dir, entry));
        if (loaded) workItems.set(id, loaded);
      }
      return [...workItems.values()].sort(byCreatedAtDesc);
    },

    async saveTaskPlan(plan) {
      indexPlan(plan);
      await writeJson(planPath(plan.planId), plan);
    },

    async getCurrentPlan(workItemId) {
      await loadPlansFromDisk(workItemId);
      const bucket = plansByWorkItem.get(workItemId);
      if (!bucket) return undefined;
      const candidates = [...bucket]
        .map((planId) => plansById.get(planId)!)
        .filter((p) => p.status !== "rejected")
        .sort((a, b) => b.version - a.version);
      return candidates[0];
    },

    async listPlanHistory(workItemId) {
      await loadPlansFromDisk(workItemId);
      const bucket = plansByWorkItem.get(workItemId);
      if (!bucket) return [];
      return [...bucket]
        .map((planId) => plansById.get(planId)!)
        .sort((a, b) => a.version - b.version);
    },

    async saveTaskRunLink(link) {
      let bucket = taskRunLinks.get(link.taskId);
      if (!bucket) {
        bucket = new Map();
        taskRunLinks.set(link.taskId, bucket);
      }
      bucket.set(link.runId, link);
      await writeJson(linkPath(link.taskId, link.runId), link);
    },

    async listTaskRunLinks(taskId) {
      const dir = join(opts.rootDir, TASK_RUN_LINKS_DIR, taskId);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        entries = [];
      }
      let bucket = taskRunLinks.get(taskId);
      if (!bucket) {
        bucket = new Map();
        taskRunLinks.set(taskId, bucket);
      }
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const runId = entry.slice(0, -".json".length);
        if (bucket.has(runId)) continue;
        const loaded = await readJson<TaskRunLink>(join(dir, entry));
        if (loaded) bucket.set(runId, loaded);
      }
      return [...bucket.values()].sort((a, b) =>
        a.startedAt.localeCompare(b.startedAt),
      );
    },

    async listAllTaskRunLinks(workItemId) {
      const item = workItems.get(workItemId) ??
        (await readJson<WorkItem>(workItemPath(workItemId)));
      if (!item) return [];
      const out: TaskRunLink[] = [];
      for (const taskId of item.taskIds) {
        out.push(...(await this.listTaskRunLinks(taskId)));
      }
      return out;
    },

    async saveReport(report) {
      reports.set(report.workItemId, report);
      await writeJson(reportPath(report.workItemId), report);
    },

    async getReport(workItemId) {
      const cached = reports.get(workItemId);
      if (cached) return cached;
      const loaded = await readJson<WorkItemReport>(reportPath(workItemId));
      if (loaded) reports.set(workItemId, loaded);
      return loaded;
    },

    async loadEvidenceConfirmations(workItemId) {
      const cached = evidenceConfirmations.get(workItemId);
      if (cached) return cached;
      const loaded =
        (await readJson<Record<string, EvidenceConfirmation>>(
          evidenceConfirmationsPath(workItemId),
        )) ?? {};
      evidenceConfirmations.set(workItemId, loaded);
      return loaded;
    },

    async saveEvidenceConfirmation(workItemId, evidenceId, confirmation) {
      const previousWrite =
        evidenceConfirmationWrites.get(workItemId) ?? Promise.resolve();
      const nextWrite = previousWrite.then(async () => {
        const current =
          (await readJson<Record<string, EvidenceConfirmation>>(
            evidenceConfirmationsPath(workItemId),
          )) ?? {};
        const saved = current[evidenceId] ?? confirmation;
        const next = { ...current, [evidenceId]: saved };
        evidenceConfirmations.set(workItemId, next);
        await writeJson(evidenceConfirmationsPath(workItemId), next);
        return saved;
      });
      const queuedWrite = nextWrite.catch(() => undefined);
      evidenceConfirmationWrites.set(workItemId, queuedWrite);
      try {
        return await nextWrite;
      } finally {
        if (evidenceConfirmationWrites.get(workItemId) === queuedWrite) {
          evidenceConfirmationWrites.delete(workItemId);
        }
      }
    },
  };
}

function byCreatedAtDesc(a: WorkItem, b: WorkItem): number {
  return b.createdAt.localeCompare(a.createdAt);
}
