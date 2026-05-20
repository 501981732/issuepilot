/**
 * Smoke tests for `splitCommand`. These are duplicated from the original
 * `daemon.test.ts` block so the standalone module stays covered after
 * the V4.6 follow-up Task 4b extraction. The exhaustive coverage still
 * lives in `daemon.test.ts` (it imports `splitCommand` via the re-export
 * to keep backward compat).
 */

import { describe, expect, it } from "vitest";

import { splitCommand } from "../split-command.js";

describe("splitCommand (codex/split-command.ts)", () => {
  it("splits a simple command on whitespace", () => {
    expect(splitCommand("codex app-server")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside double quotes", () => {
    expect(
      splitCommand('"/Users/User Name/.local/bin/codex" app-server'),
    ).toEqual({
      command: "/Users/User Name/.local/bin/codex",
      args: ["app-server"],
    });
  });

  it("preserves spaces inside single quotes and supports mixed quotes", () => {
    expect(
      splitCommand("'/var/data with space/codex' app-server --foo \"bar baz\""),
    ).toEqual({
      command: "/var/data with space/codex",
      args: ["app-server", "--foo", "bar baz"],
    });
  });

  it("rejects an empty string", () => {
    expect(() => splitCommand("   ")).toThrow(/must not be empty/);
  });

  it("rejects an unbalanced quote", () => {
    expect(() => splitCommand('codex "app-server')).toThrow(/unbalanced/);
  });
});
