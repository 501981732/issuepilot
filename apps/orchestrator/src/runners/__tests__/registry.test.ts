import type { RunnerDescriptor } from "@issuepilot/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { createRunnerRegistry, RunnerRegistryError } from "../registry.js";
import type { RunnerAdapter } from "../types.js";

const codexDescriptor = (): RunnerDescriptor => ({
  runnerId: "codex_app_server",
  kind: "codex_app_server",
  capabilities: ["roles.coder", "roles.reviewer", "roles.test_evidence"],
});

describe("RunnerRegistry (V4.7)", () => {
  it("returns adapter by role profile runner id", () => {
    const descriptor = codexDescriptor();
    const adapter: RunnerAdapter = {
      descriptor,
      run: vi.fn(),
    };

    const registry = createRunnerRegistry({
      descriptors: { codex_app_server: descriptor },
      adapters: [adapter],
    });

    expect(
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" }),
    ).toBe(adapter);
    expect(
      registry.getForRole({ role: "reviewer", runnerId: "codex_app_server" }),
    ).toBe(adapter);
  });

  it("fails closed when descriptor is not declared", () => {
    const registry = createRunnerRegistry({
      descriptors: {},
      adapters: [],
    });

    expect(() =>
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" }),
    ).toThrow(/runner_unavailable/);
    try {
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" });
    } catch (e) {
      expect(e).toBeInstanceOf(RunnerRegistryError);
      expect((e as RunnerRegistryError).code).toBe("runner_unavailable");
    }
  });

  it("fails closed when adapter is missing even though descriptor exists", () => {
    const registry = createRunnerRegistry({
      descriptors: { codex_app_server: codexDescriptor() },
      adapters: [],
    });

    expect(() =>
      registry.getForRole({ role: "coder", runnerId: "codex_app_server" }),
    ).toThrow(/runner_unavailable/);
  });

  it("rejects duplicate adapters for the same runner id", () => {
    const descriptor = codexDescriptor();
    const adapterA: RunnerAdapter = { descriptor, run: vi.fn() };
    const adapterB: RunnerAdapter = { descriptor, run: vi.fn() };

    expect(() =>
      createRunnerRegistry({
        descriptors: { codex_app_server: descriptor },
        adapters: [adapterA, adapterB],
      }),
    ).toThrow(/duplicate/i);
  });

  it("listRunners returns all declared descriptors", () => {
    const descriptor = codexDescriptor();
    const adapter: RunnerAdapter = { descriptor, run: vi.fn() };
    const registry = createRunnerRegistry({
      descriptors: { codex_app_server: descriptor },
      adapters: [adapter],
    });

    expect(registry.listRunners()).toEqual([descriptor]);
  });
});
