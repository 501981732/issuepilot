/**
 * V4.7 orchestrator-internal runner types.
 *
 * Shared-contracts (`@issuepilot/shared-contracts`) defines the public
 * `RunnerDescriptor` / `RunnerRunInput` / `RunnerResult` / `RunnerEvent`
 * shapes; orchestrator wraps them with adapters that own the actual
 * lifecycle (Codex RPC, mock runner for tests, etc.) and a registry that
 * the agent factories consult before running each role.
 *
 * Adapters are intentionally pure: they take a `RunnerRunInput`, return
 * a `RunnerResult`, and emit sanitized `RunnerEvent`s via the optional
 * `RunnerEventSink`. They must NOT touch the pipeline store or build
 * business `AgentReport` payloads — that belongs to the role-specific
 * agent factories in `apps/orchestrator/src/agents/*`.
 */

import type {
  AgentRole,
  RunnerDescriptor,
  RunnerEvent,
  RunnerResult,
  RunnerRunInput,
} from "@issuepilot/shared-contracts";

export interface RunnerEventSink {
  emit(event: RunnerEvent): void | Promise<void>;
}

export interface RunnerRunContext {
  events?: RunnerEventSink;
}

export interface RunnerAdapter {
  readonly descriptor: RunnerDescriptor;
  run(input: RunnerRunInput, ctx?: RunnerRunContext): Promise<RunnerResult>;
}

export interface RunnerLookupInput {
  role: AgentRole;
  runnerId: string;
}

export interface RunnerRegistry {
  getForRole(input: RunnerLookupInput): RunnerAdapter;
  listRunners(): RunnerDescriptor[];
}
