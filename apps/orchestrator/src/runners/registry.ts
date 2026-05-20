/**
 * V4.7 orchestrator runner registry.
 *
 * `createRunnerRegistry` is the only path through which agent factories
 * obtain a `RunnerAdapter`. The registry fails closed: if the requested
 * runner id is missing from `descriptors`, or if no adapter is wired up
 * for it, `getForRole` throws `RunnerRegistryError` with code
 * `runner_unavailable`. Daemon wiring (Task 6) translates that into a
 * failed `AgentReport` with `lastError.code = "runner_unavailable"`.
 */

import type { RunnerDescriptor } from "@issuepilot/shared-contracts";

import type {
  RunnerAdapter,
  RunnerLookupInput,
  RunnerRegistry,
} from "./types.js";

export type RunnerRegistryErrorCode =
  | "runner_unavailable"
  | "capability_missing";

export class RunnerRegistryError extends Error {
  override readonly name = "RunnerRegistryError";

  constructor(
    message: string,
    public readonly code: RunnerRegistryErrorCode,
  ) {
    super(message);
  }
}

export interface CreateRunnerRegistryInput {
  descriptors: Record<string, RunnerDescriptor>;
  adapters: RunnerAdapter[];
}

export function createRunnerRegistry(
  input: CreateRunnerRegistryInput,
): RunnerRegistry {
  const adapters = new Map<string, RunnerAdapter>();
  for (const adapter of input.adapters) {
    const id = adapter.descriptor.runnerId;
    if (adapters.has(id)) {
      throw new RunnerRegistryError(
        `duplicate runner adapter registered for runnerId=${id}`,
        "runner_unavailable",
      );
    }
    adapters.set(id, adapter);
  }

  return {
    getForRole(lookup: RunnerLookupInput): RunnerAdapter {
      const descriptor = input.descriptors[lookup.runnerId];
      if (!descriptor) {
        throw new RunnerRegistryError(
          `runner_unavailable: runner ${lookup.runnerId} is not declared in workflow runners registry (role=${lookup.role})`,
          "runner_unavailable",
        );
      }
      const adapter = adapters.get(lookup.runnerId);
      if (!adapter) {
        throw new RunnerRegistryError(
          `runner_unavailable: runner ${lookup.runnerId} has no registered adapter (role=${lookup.role})`,
          "runner_unavailable",
        );
      }
      return adapter;
    },
    listRunners(): RunnerDescriptor[] {
      return Object.values(input.descriptors);
    },
  };
}
