/**
 * V4.6 spec §8.2 / §16.1：Test/Evidence Agent。
 *
 * 复用 V4.3 evidence 通道：调用一组 evidence collector，把各个证据项
 * （CI、Playwright walkthrough、screenshot、test log…）依次落到
 * `<worktree>/.issuepilot/evidence/<taskId>/`，并产生
 * `TestEvidenceAgentReport`。
 *
 * 状态映射（spec §8.2 / §16.1）：
 * - 全部 collector `collected` → `status = "complete"`。
 * - 至少一个 collector `failed/skipped` 但其他成功 → `status = "incomplete"`，
 *   `lastError.code = "evidence_partial"`。
 * - collector 抛 SandboxViolationError → `status = "failed"`，
 *   `lastError.code = "sandbox_violation"`，保留 violation 之前已成功
 *   的 evidenceItems。
 * - lifecycle 抛任意错 → `status = "failed"`, `lastError.code = "evidence_unavailable"`。
 * - 整体被取消 → `AgentRunResult.kind = "cancelled"`。
 */

import { randomUUID } from "node:crypto";

import type {
  LastErrorCode,
  RunnerKind,
  RunnerResult,
  TaskNode,
  TestEvidenceAgentReport,
  TestEvidenceBaseline,
  TestEvidenceItem,
  WorkItem,
} from "@issuepilot/shared-contracts";

import type { TestEvidenceRoleProfile } from "../pipelines/role-profile.js";
import { runnerErrorToLastErrorCode } from "../runners/failure-mapping.js";
import { RunnerRegistryError } from "../runners/registry.js";
import type { RunnerRegistry } from "../runners/types.js";
import type { RunnerEventSink } from "../runners/types.js";

import { SandboxViolationError } from "./coder.js";

const RUNNER_KIND_CODEX: RunnerKind = "codex_app_server";

export interface CollectorInput {
  workItem: WorkItem;
  task: TaskNode;
  profile: TestEvidenceRoleProfile;
  evidenceDir: string;
}

export type CollectorOutcome =
  | { kind: "item"; item: TestEvidenceItem }
  | { kind: "baseline"; baseline: TestEvidenceBaseline }
  | { kind: "cancel"; cancelledAt: string }
  /**
   * V4.6 follow-up Task 4c review: collector executed but had nothing
   * to contribute (typical: scanner-snapshot on a worktree where the
   * prior agents haven't produced any evidence yet). Agent loop skips
   * the outcome entirely so it does NOT inflate `items.length` and
   * trip the `allFailed` branch (`items.length > 0 && !hasCollected`).
   * The honest pipeline state in that case is `status = "complete"`
   * with `evidenceItems = []` — exactly what an empty collector run
   * should look like, not `evidence_unavailable`.
   */
  | { kind: "noop" };

export interface EvidenceCollector {
  /** 用于日志 / SandboxViolationError 上下文。 */
  readonly name: string;
  collect(input: CollectorInput): Promise<CollectorOutcome>;
}

export interface TestEvidenceAgentRunInput {
  workItem: WorkItem;
  task: TaskNode;
  pipelineRun: { pipelineRunId: string };
  profile: TestEvidenceRoleProfile;
  cwd: string;
  evidenceDir: string;
  collectors: EvidenceCollector[];
  now?: () => string;
  newId?: () => string;
}

export type TestEvidenceAgentResult =
  | { kind: "report"; report: TestEvidenceAgentReport }
  | { kind: "cancelled"; cancelledAt: string };

export interface TestEvidenceAgent {
  run(input: TestEvidenceAgentRunInput): Promise<TestEvidenceAgentResult>;
}

const buildReport = (input: {
  agentReportId: string;
  workItemId?: string;
  pipelineRunId: string;
  taskId: string;
  roleProfileId: string;
  runnerId: string;
  runnerRunId: string | null;
  promptTemplateHash: string;
  startedAt: string;
  completedAt: string;
  status: TestEvidenceAgentReport["status"];
  items: TestEvidenceItem[];
  baseline: TestEvidenceBaseline | null;
  redactedFields: string[];
  lastErrorCode?: LastErrorCode;
  lastErrorMessage?: string;
}): TestEvidenceAgentReport => ({
  agentReportId: input.agentReportId,
  ...(input.workItemId ? { workItemId: input.workItemId } : {}),
  pipelineRunId: input.pipelineRunId,
  taskId: input.taskId,
  role: "test_evidence",
  roleProfileId: input.roleProfileId,
  runnerId: input.runnerId,
  runnerKind: RUNNER_KIND_CODEX,
  runnerRunId: input.runnerRunId,
  status: input.status,
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  promptTemplateHash: input.promptTemplateHash,
  ...(input.lastErrorCode
    ? {
        lastError: {
          code: input.lastErrorCode,
          message: input.lastErrorMessage ?? input.lastErrorCode,
        },
      }
    : {}),
  evidenceLinks: input.items
    .map((i) => i.artifactPath)
    .filter((p): p is string => typeof p === "string"),
  redactedFields: input.redactedFields,
  testEvidence: {
    evidenceItems: input.items,
    baselineEvidence: input.baseline,
  },
});

const runnerRedactedFieldsForReport = (result: RunnerResult): string[] => {
  if (!result.redactedFields || result.redactedFields.length === 0) return [];
  return result.redactedFields.map((field) => `runner.${field}`);
};

export const createTestEvidenceAgent = (deps: {
  runnerRegistry: RunnerRegistry;
  events?: RunnerEventSink;
  now?: () => string;
  newId?: () => string;
}): TestEvidenceAgent => {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const newId = deps.newId ?? ((): string => randomUUID());

  return {
    async run(input) {
      const tickNow = input.now ?? now;
      const tickId = input.newId ?? newId;
      const startedAt = tickNow();
      const items: TestEvidenceItem[] = [];
      let baseline: TestEvidenceBaseline | null = null;
      const runnerId = input.profile.runnerId;

      let runnerResult: RunnerResult;
      try {
        const adapter = deps.runnerRegistry.getForRole({
          role: "test_evidence",
          runnerId,
        });
        runnerResult = await adapter.run(
          {
            runnerId,
            role: "test_evidence",
            prompt: input.profile.prompt,
            cwd: input.cwd,
            workItemId: input.workItem.workItemId,
            taskId: input.task.taskId,
            pipelineRunId: input.pipelineRun.pipelineRunId,
            roleProfileId: input.profile.roleProfileId,
            toolAllow: input.profile.toolAllow,
            sandbox: input.profile.sandbox,
            metadata: { agentReportRole: "test_evidence" },
            ...(input.profile.timeoutSeconds !== undefined
              ? { timeoutSeconds: input.profile.timeoutSeconds }
              : {}),
          },
          deps.events ? { events: deps.events } : undefined,
        );
      } catch (cause) {
        const isRegistryError = cause instanceof RunnerRegistryError;
        return {
          kind: "report",
          report: buildReport({
            agentReportId: tickId(),
            workItemId: input.workItem.workItemId,
            pipelineRunId: input.pipelineRun.pipelineRunId,
            taskId: input.task.taskId,
            roleProfileId: input.profile.roleProfileId,
            runnerId,
            runnerRunId: null,
            promptTemplateHash: input.profile.promptTemplateHash,
            startedAt,
            completedAt: tickNow(),
            status: "failed",
            items: [],
            baseline: null,
            redactedFields: [],
            lastErrorCode: isRegistryError
              ? "runner_unavailable"
              : "evidence_unavailable",
            lastErrorMessage:
              cause instanceof Error ? cause.message : String(cause),
          }),
        };
      }

      if (runnerResult.status === "cancelled") {
        return { kind: "cancelled", cancelledAt: runnerResult.cancelledAt };
      }

      const runnerRunId = runnerResult.runId ?? null;
      const redactedFields = runnerRedactedFieldsForReport(runnerResult);

      if (
        runnerResult.status === "failed" ||
        runnerResult.status === "timeout"
      ) {
        const baseCode = runnerErrorToLastErrorCode(runnerResult.error.code);
        const errCode: LastErrorCode =
          runnerResult.error.code === "artifact_collection_failed"
            ? "evidence_unavailable"
            : baseCode;
        return {
          kind: "report",
          report: buildReport({
            agentReportId: tickId(),
            workItemId: input.workItem.workItemId,
            pipelineRunId: input.pipelineRun.pipelineRunId,
            taskId: input.task.taskId,
            roleProfileId: input.profile.roleProfileId,
            runnerId,
            runnerRunId,
            promptTemplateHash: input.profile.promptTemplateHash,
            startedAt,
            completedAt: tickNow(),
            status: "failed",
            items: [],
            baseline: null,
            redactedFields,
            lastErrorCode: errCode,
            lastErrorMessage: runnerResult.error.message,
          }),
        };
      }

      // runner completed → run collectors
      for (const collector of input.collectors) {
        try {
          const out = await collector.collect({
            workItem: input.workItem,
            task: input.task,
            profile: input.profile,
            evidenceDir: input.evidenceDir,
          });
          if (out.kind === "cancel") {
            return { kind: "cancelled", cancelledAt: out.cancelledAt };
          }
          if (out.kind === "noop") {
            // Collector explicitly opted out — skip without recording
            // an item/baseline.
            continue;
          }
          if (out.kind === "item") {
            items.push(out.item);
          } else {
            baseline = out.baseline;
          }
        } catch (cause) {
          if (cause instanceof SandboxViolationError) {
            return {
              kind: "report",
              report: buildReport({
                agentReportId: tickId(),
                workItemId: input.workItem.workItemId,
                pipelineRunId: input.pipelineRun.pipelineRunId,
                taskId: input.task.taskId,
                roleProfileId: input.profile.roleProfileId,
                runnerId,
                runnerRunId,
                promptTemplateHash: input.profile.promptTemplateHash,
                startedAt,
                completedAt: tickNow(),
                status: "failed",
                items,
                baseline,
                redactedFields,
                lastErrorCode: "sandbox_violation",
                lastErrorMessage: cause.message,
              }),
            };
          }
          return {
            kind: "report",
            report: buildReport({
              agentReportId: tickId(),
              workItemId: input.workItem.workItemId,
              pipelineRunId: input.pipelineRun.pipelineRunId,
              taskId: input.task.taskId,
              roleProfileId: input.profile.roleProfileId,
              runnerId,
              runnerRunId,
              promptTemplateHash: input.profile.promptTemplateHash,
              startedAt,
              completedAt: tickNow(),
              status: "failed",
              items,
              baseline,
              redactedFields,
              lastErrorCode: "evidence_unavailable",
              lastErrorMessage:
                cause instanceof Error ? cause.message : String(cause),
            }),
          };
        }
      }

      const hasFailedOrSkipped = items.some(
        (it) => it.status === "failed" || it.status === "skipped",
      );
      const hasCollected = items.some((it) => it.status === "collected");
      const allFailed = items.length > 0 && !hasCollected;

      let finalStatus: TestEvidenceAgentReport["status"];
      let lastCode: LastErrorCode | undefined;
      let lastMsg: string | undefined;

      if (allFailed) {
        finalStatus = "failed";
        lastCode = "evidence_unavailable";
        lastMsg = "all evidence collectors failed";
      } else if (hasFailedOrSkipped) {
        finalStatus = "incomplete";
        lastCode = "evidence_partial";
        lastMsg = "some evidence items failed / skipped";
      } else {
        finalStatus = "complete";
      }

      return {
        kind: "report",
        report: buildReport({
          agentReportId: tickId(),
          workItemId: input.workItem.workItemId,
          pipelineRunId: input.pipelineRun.pipelineRunId,
          taskId: input.task.taskId,
          roleProfileId: input.profile.roleProfileId,
          runnerId,
          runnerRunId,
          promptTemplateHash: input.profile.promptTemplateHash,
          startedAt,
          completedAt: tickNow(),
          status: finalStatus,
          items,
          baseline,
          redactedFields,
          ...(lastCode ? { lastErrorCode: lastCode } : {}),
          ...(lastMsg ? { lastErrorMessage: lastMsg } : {}),
        }),
      };
    },
  };
};
