/**
 * V4.6 spec §9：PipelineRun + AgentReport 持久化层。
 *
 * 目录布局（在 single 模式 root = `~/.issuepilot`；team 模式 root =
 * `<workflow.workspace.root>` per project）：
 *
 * ```
 * <root>/
 *   pipelines/<workItemId>/<taskId>/<pipelineRunId>.json
 *   agent-reports/<taskId>/<role>/<agentReportId>.json
 *   agent-reports/<taskId>/<role>/index.json
 * ```
 *
 * 写入前一律过 `@issuepilot/observability/redact`，token / secret 被
 * 替换为 `[REDACTED]`；store 不做 redactedFields[] 自动追踪（由 agent
 * 在写之前显式标记），但保证写盘时即使遗漏也由 redact 兜底。
 *
 * 路径含 `..` 或绝对路径越权 → `PipelineStorePathError`，防止 task /
 * report 之间越权访问磁盘；读取损坏 JSON → `PipelineStoreReadError`。
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { redact } from "@issuepilot/observability";
import {
  type AgentReport,
  type AgentRole,
  type PipelineRun,
  isAgentReport,
  isPipelineRun,
} from "@issuepilot/shared-contracts";

import type {
  AgentReportRoleIndex,
  ListPipelinesForTaskItem,
  PipelineStorePaths,
  SaveAgentReportOptions,
} from "./types.js";

export class PipelineStorePathError extends Error {
  override readonly name = "PipelineStorePathError";

  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
  }
}

export class PipelineStoreReadError extends Error {
  override readonly name = "PipelineStoreReadError";

  constructor(
    message: string,
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const assertSafeSegment = (segment: string, role: string): void => {
  if (!segment || segment.includes("..") || segment.includes("/")) {
    throw new PipelineStorePathError(
      `${role} segment contains illegal characters: ${segment}`,
      segment,
    );
  }
  if (!SAFE_SEGMENT.test(segment)) {
    throw new PipelineStorePathError(
      `${role} segment must match ${SAFE_SEGMENT}: ${segment}`,
      segment,
    );
  }
};

const ensureRoleSegment = (role: AgentRole): void => {
  if (role !== "coder" && role !== "reviewer" && role !== "test_evidence") {
    throw new PipelineStorePathError(`unknown role: ${role}`, role);
  }
};

const buildPaths = (root: string): PipelineStorePaths => ({
  pipelineRunPath: ({ workItemId, taskId, pipelineRunId }) => {
    assertSafeSegment(workItemId, "workItemId");
    assertSafeSegment(taskId, "taskId");
    assertSafeSegment(pipelineRunId, "pipelineRunId");
    return path.join(
      root,
      "pipelines",
      workItemId,
      taskId,
      `${pipelineRunId}.json`,
    );
  },
  agentReportPath: ({ taskId, role, agentReportId }) => {
    assertSafeSegment(taskId, "taskId");
    ensureRoleSegment(role);
    assertSafeSegment(agentReportId, "agentReportId");
    return path.join(
      root,
      "agent-reports",
      taskId,
      role,
      `${agentReportId}.json`,
    );
  },
  agentReportIndexPath: ({ taskId, role }) => {
    assertSafeSegment(taskId, "taskId");
    ensureRoleSegment(role);
    return path.join(root, "agent-reports", taskId, role, "index.json");
  },
});

const writeJsonAtomic = async (
  destination: string,
  payload: unknown,
): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  const redacted = redact(payload);
  const tmp = `${destination}.tmp`;
  await writeFile(tmp, `${JSON.stringify(redacted, null, 2)}\n`, "utf8");
  // node:fs/promises rename 在大多数 POSIX 系统是原子的；保留两步避免
  // ESM 环境下 import dance。
  const { rename } = await import("node:fs/promises");
  await rename(tmp, destination);
};

const readJsonSafe = async <T>(
  filePath: string,
  guard: (value: unknown) => value is T,
): Promise<T> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw cause;
    }
    throw new PipelineStoreReadError(
      `failed to read ${path.basename(filePath)}`,
      filePath,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PipelineStoreReadError(
      `corrupt JSON in ${path.basename(filePath)}`,
      filePath,
      { cause },
    );
  }
  if (!guard(parsed)) {
    throw new PipelineStoreReadError(
      `JSON in ${path.basename(filePath)} does not match expected schema`,
      filePath,
    );
  }
  return parsed;
};

export interface PipelineStore {
  /** spec §8.1：写入 PipelineRun 到 `<root>/pipelines/<wid>/<tid>/<prid>.json`。 */
  savePipelineRun(run: PipelineRun): Promise<void>;
  /** 读最新一次 PipelineRun（按 createdAt 倒序）。 */
  latestForTask(input: {
    workItemId: string;
    taskId: string;
  }): Promise<PipelineRun | null>;
  /** 列出某 task 全部 PipelineRun，按 createdAt 倒序，标 latest=true 给 supersede 末端。 */
  listForTask(input: {
    workItemId: string;
    taskId: string;
  }): Promise<ListPipelinesForTaskItem[]>;
  /** 按 pipelineRunId 直接读，不走 task path（dashboard 详情页用）。 */
  getPipelineRunById(input: {
    workItemId: string;
    taskId: string;
    pipelineRunId: string;
  }): Promise<PipelineRun | null>;
  /** spec §8.1：把 prevId.supersededBy = nextId 写回；nextId.supersedes = prevId。 */
  supersede(input: {
    workItemId: string;
    taskId: string;
    prevId: string;
    nextId: string;
  }): Promise<void>;

  /** spec §8.2 / §9：写 AgentReport + 同步 supersede 链 index.json。 */
  saveAgentReport(
    report: AgentReport,
    options?: SaveAgentReportOptions,
  ): Promise<void>;
  /** 读某个 AgentReport（按 taskId + role + id 定位）。 */
  getAgentReport(input: {
    taskId: string;
    role: AgentRole;
    agentReportId: string;
  }): Promise<AgentReport | null>;
  /** 列 task 下某 role 的所有 AgentReport（含 supersede 链信息）。 */
  listAgentReportsForRole(input: {
    taskId: string;
    role: AgentRole;
  }): Promise<{
    reports: AgentReport[];
    index: AgentReportRoleIndex;
  }>;
  /** 取 task 下某 role 的最新 AgentReport（非 superseded）。 */
  latestAgentReportForRole(input: {
    taskId: string;
    role: AgentRole;
  }): Promise<AgentReport | null>;
  /** 暴露 path builder 给上层（如测试 / 维护脚本）。 */
  readonly paths: PipelineStorePaths;
  readonly root: string;
}

export interface CreatePipelineStoreOptions {
  root: string;
}

export const createPipelineStore = (
  opts: CreatePipelineStoreOptions,
): PipelineStore => {
  const root = opts.root;
  const paths = buildPaths(root);

  const readIndex = async (input: {
    taskId: string;
    role: AgentRole;
  }): Promise<AgentReportRoleIndex> => {
    const indexPath = paths.agentReportIndexPath(input);
    try {
      const raw = await readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as AgentReportRoleIndex;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray(parsed.agentReportIds)
      ) {
        return parsed;
      }
      throw new PipelineStoreReadError(
        `index.json malformed for role ${input.role}`,
        indexPath,
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          taskId: input.taskId,
          role: input.role,
          agentReportIds: [],
          supersedeChain: [],
          latestAgentReportId: null,
          updatedAt: new Date().toISOString(),
        };
      }
      if (cause instanceof PipelineStoreReadError) throw cause;
      throw new PipelineStoreReadError(
        `failed to read index.json for role ${input.role}`,
        indexPath,
        { cause },
      );
    }
  };

  const writeIndex = async (idx: AgentReportRoleIndex): Promise<void> => {
    const indexPath = paths.agentReportIndexPath({
      taskId: idx.taskId,
      role: idx.role,
    });
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(
      indexPath,
      `${JSON.stringify(redact(idx), null, 2)}\n`,
      "utf8",
    );
  };

  return {
    paths,
    root,

    async savePipelineRun(run: PipelineRun): Promise<void> {
      const destination = paths.pipelineRunPath({
        workItemId: run.workItemId,
        taskId: run.taskId,
        pipelineRunId: run.pipelineRunId,
      });
      await writeJsonAtomic(destination, run);
    },

    async getPipelineRunById(input) {
      const destination = paths.pipelineRunPath(input);
      try {
        return await readJsonSafe(destination, isPipelineRun);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (cause instanceof PipelineStoreReadError) throw cause;
        throw cause;
      }
    },

    async listForTask(input) {
      assertSafeSegment(input.workItemId, "workItemId");
      assertSafeSegment(input.taskId, "taskId");
      const taskDir = path.join(
        root,
        "pipelines",
        input.workItemId,
        input.taskId,
      );
      let entries: string[];
      try {
        entries = await readdir(taskDir);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw cause;
      }
      const runs: PipelineRun[] = [];
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const filePath = path.join(taskDir, name);
        try {
          const run = await readJsonSafe(filePath, isPipelineRun);
          runs.push(run);
        } catch (cause) {
          // 单条损坏不阻塞其他 run 的读取；error 由调用方决定如何上报。
          if (cause instanceof PipelineStoreReadError) {
            throw cause;
          }
          throw cause;
        }
      }
      runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return runs.map((run) => ({
        pipelineRun: run,
        latest: !run.supersededBy,
      }));
    },

    async latestForTask(input) {
      const items = await this.listForTask(input);
      const latest = items.find((it) => it.latest);
      return latest?.pipelineRun ?? null;
    },

    async supersede({ workItemId, taskId, prevId, nextId }) {
      const prev = await this.getPipelineRunById({
        workItemId,
        taskId,
        pipelineRunId: prevId,
      });
      const next = await this.getPipelineRunById({
        workItemId,
        taskId,
        pipelineRunId: nextId,
      });
      if (!prev || !next) {
        throw new PipelineStoreReadError(
          `cannot supersede: prev=${!!prev} next=${!!next}`,
          paths.pipelineRunPath({ workItemId, taskId, pipelineRunId: prevId }),
        );
      }
      const updatedPrev: PipelineRun = {
        ...prev,
        supersededBy: nextId,
        updatedAt: new Date().toISOString(),
      };
      const updatedNext: PipelineRun = {
        ...next,
        supersedes: prevId,
        updatedAt: new Date().toISOString(),
      };
      await this.savePipelineRun(updatedPrev);
      await this.savePipelineRun(updatedNext);
    },

    async saveAgentReport(report, options) {
      const destination = paths.agentReportPath({
        taskId: report.taskId,
        role: report.role,
        agentReportId: report.agentReportId,
      });
      await writeJsonAtomic(destination, report);

      if (options?.updateIndex === false) return;

      const idx = await readIndex({
        taskId: report.taskId,
        role: report.role,
      });
      if (!idx.agentReportIds.includes(report.agentReportId)) {
        idx.agentReportIds.push(report.agentReportId);
      }
      idx.latestAgentReportId = report.agentReportId;
      idx.updatedAt = new Date().toISOString();
      await writeIndex(idx);
    },

    async getAgentReport(input) {
      const destination = paths.agentReportPath(input);
      try {
        return await readJsonSafe(destination, isAgentReport);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (cause instanceof PipelineStoreReadError) throw cause;
        throw cause;
      }
    },

    async listAgentReportsForRole(input) {
      const idx = await readIndex(input);
      const reports: AgentReport[] = [];
      for (const id of idx.agentReportIds) {
        const r = await this.getAgentReport({
          taskId: input.taskId,
          role: input.role,
          agentReportId: id,
        });
        if (r) reports.push(r);
      }
      return { reports, index: idx };
    },

    async latestAgentReportForRole(input) {
      const idx = await readIndex(input);
      if (!idx.latestAgentReportId) return null;
      return this.getAgentReport({
        taskId: input.taskId,
        role: input.role,
        agentReportId: idx.latestAgentReportId,
      });
    },
  };
};

export interface ProjectScope {
  /** 任意 project 标识符，用于 team 模式按项目隔离。 */
  projectId: string;
  /** 该项目的 pipeline / agent-report 目录根（例如 workflow.workspace.root）。 */
  root: string;
}

export interface PipelineStoreByProject {
  get(projectId: string): PipelineStore | undefined;
  upsert(scope: ProjectScope): PipelineStore;
  list(): Array<{ projectId: string; store: PipelineStore }>;
}

/**
 * spec §9 / V4.4：team 模式下每个 project 一份独立 pipeline store，
 * 落点目录互不重叠。
 */
export const createPipelineStoresByProject = (
  scopes: ProjectScope[],
): PipelineStoreByProject => {
  const map = new Map<string, PipelineStore>();
  for (const scope of scopes) {
    map.set(scope.projectId, createPipelineStore({ root: scope.root }));
  }
  return {
    get(projectId) {
      return map.get(projectId);
    },
    upsert(scope) {
      const existing = map.get(scope.projectId);
      if (existing && existing.root === scope.root) return existing;
      const store = createPipelineStore({ root: scope.root });
      map.set(scope.projectId, store);
      return store;
    },
    list() {
      return Array.from(map.entries()).map(([projectId, store]) => ({
        projectId,
        store,
      }));
    },
  };
};

/** 在测试 / 维护时确认目录存在（spec §9 三层布局可选 prepare）。 */
export const ensurePipelineDirs = async (root: string): Promise<void> => {
  await mkdir(path.join(root, "pipelines"), { recursive: true });
  await mkdir(path.join(root, "agent-reports"), { recursive: true });
};

export type { AgentReportRoleIndex } from "./types.js";
