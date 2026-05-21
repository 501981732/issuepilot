import { setTimeout as delay } from "node:timers/promises";

import type {
  ClaudeCodeRunnerOptions,
  RunnerArtifact,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";
import { execa } from "execa";

export type ClaudeCodeDriverStatus = "completed" | "failed" | "cancelled";
const KILL_GRACE_MS = 2000;

export interface ClaudeCodeDriverResult {
  status: ClaudeCodeDriverStatus;
  runnerRunId: string;
  finalMessage?: string;
  errorMessage?: string;
  cancelledAt?: string;
  artifacts: RunnerArtifact[];
}

export interface ClaudeCodeDriverProcess {
  result: Promise<ClaudeCodeDriverResult>;
  kill(reason: "cancelled" | "timeout"): Promise<void>;
}

export interface ClaudeCodeDriver {
  start(
    input: RunnerRunInput,
    options: ClaudeCodeRunnerOptions,
  ): ClaudeCodeDriverProcess;
}

export const createDefaultClaudeCodeDriver = (): ClaudeCodeDriver => ({
  start(input, options) {
    const command = options.command ?? "claude";
    const args = ["--print"];
    if (options.model) args.push("--model", options.model);
    const child = execa(command, args, {
      cwd: input.cwd,
      shell: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      reject: false,
      forceKillAfterDelay: KILL_GRACE_MS,
    });
    child.stdin?.end(input.prompt);

    const result = child.then((completed): ClaudeCodeDriverResult => {
      const runnerRunId = `${input.pipelineRunId}:${input.role}:${Date.now()}`;
      const stdout = completed.stdout.trim();
      const stderr = completed.stderr.trim();
      if (completed.exitCode === 0) {
        return {
          status: "completed",
          runnerRunId,
          finalMessage: stdout,
          artifacts: stderr ? [{ kind: "log", summary: stderr }] : [],
        };
      }
      return {
        status: "failed",
        runnerRunId,
        ...(stdout ? { finalMessage: stdout } : {}),
        errorMessage:
          stderr ||
          `claude_code exited with code ${String(completed.exitCode)}`,
        artifacts: [],
      };
    });

    return {
      result,
      async kill() {
        child.kill("SIGTERM");
        const settled = child.catch(() => undefined);
        await Promise.race([
          settled,
          delay(KILL_GRACE_MS).then(() => {
            child.kill("SIGKILL");
          }),
        ]);
        await Promise.race([settled, delay(500)]).catch(() => undefined);
      },
    };
  },
});
