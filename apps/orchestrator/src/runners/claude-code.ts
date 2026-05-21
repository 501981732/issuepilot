import type {
  RunnerArtifact,
  RunnerDescriptor,
  RunnerEvent,
  RunnerEventType,
  RunnerResult,
} from "@issuepilot/shared-contracts";

import {
  createDefaultClaudeCodeDriver,
  type ClaudeCodeDriver,
  type ClaudeCodeDriverResult,
} from "./claude-code-driver.js";
import type { RunnerAdapter, RunnerRunContext } from "./types.js";

type ClaudeCodeDescriptor = Extract<RunnerDescriptor, { kind: "claude_code" }>;

const SECRET_VALUE_PATTERN =
  /\b(glpat|gloas|gldt|github_pat|ghp|gho|sk-live|sk-test|sk-)[-A-Za-z0-9_]{6,}|token\s*=\s*[A-Za-z0-9._\-+/=]{6,}/gi;

interface RedactionScope {
  fields: Set<string>;
}

const redactString = (value: string): [string, boolean] => {
  let redacted = false;
  const next = value.replace(SECRET_VALUE_PATTERN, () => {
    redacted = true;
    return "[REDACTED]";
  });
  return [next, redacted];
};

const redactOptionalString = (
  value: string | undefined,
  field: string,
  scope: RedactionScope,
): string | undefined => {
  if (value === undefined) return undefined;
  const [next, wasRedacted] = redactString(value);
  if (wasRedacted) scope.fields.add(field);
  return next;
};

const redactArtifacts = (
  artifacts: RunnerArtifact[],
  scope: RedactionScope,
): RunnerArtifact[] =>
  artifacts.map((artifact, index) => {
    if (artifact.summary === undefined) return artifact;
    const [summary, wasRedacted] = redactString(artifact.summary);
    if (wasRedacted) scope.fields.add(`artifacts[${index}].summary`);
    return { ...artifact, summary };
  });

const emit = async (
  ctx: RunnerRunContext,
  input: {
    type: RunnerEventType;
    at: string;
    descriptor: ClaudeCodeDescriptor;
    runnerRunId?: string;
    runInput: Parameters<RunnerAdapter["run"]>[0];
    message?: string;
    redactedFields?: string[];
  },
): Promise<void> => {
  if (!ctx.events) return;
  const event: RunnerEvent = {
    type: input.type,
    at: input.at,
    runnerId: input.descriptor.runnerId,
    ...(input.runnerRunId ? { runnerRunId: input.runnerRunId } : {}),
    pipelineRunId: input.runInput.pipelineRunId,
    workItemId: input.runInput.workItemId,
    taskId: input.runInput.taskId,
    role: input.runInput.role,
    ...(input.message ? { message: input.message } : {}),
    redactedFields: input.redactedFields ?? [],
  };
  await ctx.events.emit(event);
};

export interface CreateClaudeCodeAdapterOptions {
  descriptor: ClaudeCodeDescriptor;
  driver?: ClaudeCodeDriver;
  now?: () => string;
}

export function createClaudeCodeAdapter(
  options: CreateClaudeCodeAdapterOptions,
): RunnerAdapter {
  const driver = options.driver ?? createDefaultClaudeCodeDriver();
  const now = options.now ?? ((): string => new Date().toISOString());

  return {
    descriptor: options.descriptor,
    async run(input, ctx: RunnerRunContext = {}): Promise<RunnerResult> {
      const scope: RedactionScope = { fields: new Set() };
      await emit(ctx, {
        type: "runner_started",
        at: now(),
        descriptor: options.descriptor,
        runInput: input,
      });

      const process = driver.start(input, options.descriptor.options ?? {});
      let driverResult: ClaudeCodeDriverResult;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = Math.max(0, (input.timeoutSeconds ?? 0) * 1000);
      try {
        if (timeoutMs > 0) {
          driverResult = await Promise.race([
            process.result,
            new Promise<ClaudeCodeDriverResult>((resolve) => {
              timeout = setTimeout(() => {
                resolve({
                  status: "failed",
                  runnerRunId: `${input.pipelineRunId}:${input.role}:timeout`,
                  errorMessage: "claude_code runner timed out",
                  artifacts: [],
                });
              }, timeoutMs);
            }),
          ]);
          if (driverResult.errorMessage === "claude_code runner timed out") {
            await process.kill("timeout");
            const message = redactOptionalString(
              driverResult.errorMessage,
              "error.message",
              scope,
            );
            await emit(ctx, {
              type: "runner_failed",
              at: now(),
              descriptor: options.descriptor,
              runnerRunId: driverResult.runnerRunId,
              runInput: input,
              ...(message ? { message } : {}),
              redactedFields: [...scope.fields],
            });
            return {
              status: "timeout",
              runId: driverResult.runnerRunId,
              error: {
                code: "runner_timeout",
                message: message ?? "claude_code runner timed out",
              },
              artifacts: [],
              redactedFields: [...scope.fields],
            };
          }
        } else {
          driverResult = await process.result;
        }
      } catch (cause) {
        const rawMessage = cause instanceof Error ? cause.message : String(cause);
        const message = redactOptionalString(rawMessage, "error.message", scope);
        await emit(ctx, {
          type: "runner_failed",
          at: now(),
          descriptor: options.descriptor,
          runInput: input,
          ...(message ? { message } : {}),
          redactedFields: [...scope.fields],
        });
        return {
          status: "failed",
          error: { code: "runner_unavailable", message: message ?? rawMessage },
          artifacts: [],
          redactedFields: [...scope.fields],
        };
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      const finalMessage = redactOptionalString(
        driverResult.finalMessage,
        "finalMessage",
        scope,
      );
      const artifacts = redactArtifacts(driverResult.artifacts, scope);

      if (finalMessage) {
        await emit(ctx, {
          type: "runner_message",
          at: now(),
          descriptor: options.descriptor,
          runnerRunId: driverResult.runnerRunId,
          runInput: input,
          message: finalMessage,
          redactedFields: scope.fields.has("finalMessage")
            ? ["message"]
            : [],
        });
      }

      if (driverResult.status === "completed") {
        await emit(ctx, {
          type: "runner_completed",
          at: now(),
          descriptor: options.descriptor,
          runnerRunId: driverResult.runnerRunId,
          runInput: input,
          redactedFields: [...scope.fields],
        });
        return {
          status: "completed",
          runId: driverResult.runnerRunId,
          ...(finalMessage ? { finalMessage } : {}),
          artifacts,
          redactedFields: [...scope.fields],
        };
      }

      if (driverResult.status === "cancelled") {
        await emit(ctx, {
          type: "runner_cancelled",
          at: now(),
          descriptor: options.descriptor,
          runnerRunId: driverResult.runnerRunId,
          runInput: input,
          redactedFields: [...scope.fields],
        });
        return {
          status: "cancelled",
          runId: driverResult.runnerRunId,
          cancelledAt: driverResult.cancelledAt ?? now(),
          artifacts,
          redactedFields: [...scope.fields],
        };
      }

      const message =
        redactOptionalString(driverResult.errorMessage, "error.message", scope) ??
        "claude_code runner failed";
      await emit(ctx, {
        type: "runner_failed",
        at: now(),
        descriptor: options.descriptor,
        runnerRunId: driverResult.runnerRunId,
        runInput: input,
        message,
        redactedFields: [...scope.fields],
      });
      return {
        status: "failed",
        runId: driverResult.runnerRunId,
        error: { code: "runner_unavailable", message },
        artifacts,
        redactedFields: [...scope.fields],
      };
    },
  };
}
