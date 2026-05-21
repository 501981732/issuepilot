import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createClaudeCodeAdapter } from "../runners/claude-code.js";

const runIfClaudeSmoke =
  process.env["ISSUEPILOT_CLAUDE_CODE_E2E"] === "1" ? it : it.skip;

describe("V4.8 real claude_code dogfood smoke", () => {
  runIfClaudeSmoke("runs reviewer role through local Claude Code CLI", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "issuepilot-claude-smoke-"));
    try {
      const adapter = createClaudeCodeAdapter({
        descriptor: {
          runnerId: "claude_reviewer",
          kind: "claude_code",
          capabilities: [
            "roles.reviewer",
            "events.streaming",
            "cancel",
            "artifacts",
            "filesystem.readonly",
          ],
          options: {
            command: "claude",
            model: "sonnet",
            turnTimeoutMs: 120_000,
          },
        },
      });

      const result = await adapter.run({
        runnerId: "claude_reviewer",
        role: "reviewer",
        prompt:
          'Return only JSON: {"summary":"ok","decision":"approve_with_comments","confidence":0.8,"risks":[],"evidence_request":[],"findings":[],"inline_comments":[]}',
        cwd,
        workItemId: "wi-smoke",
        taskId: "task-smoke",
        pipelineRunId: "pipe-smoke",
        roleProfileId: "reviewer@smoke",
        timeoutSeconds: 120,
        toolAllow: [],
        sandbox: "read_only_worktree",
        metadata: {},
      });

      expect(result.status).toBe("completed");
      expect(result.finalMessage ?? "").toContain("approve_with_comments");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
