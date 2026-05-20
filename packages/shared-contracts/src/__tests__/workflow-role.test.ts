import { describe, expect, it } from "vitest";

import {
  WORKFLOW_SANDBOX_VALUES,
  WORKFLOW_TOOL_NAME_VALUES,
  REVIEWER_SEVERITY_THRESHOLD_VALUES,
  isWorkflowSandbox,
  isWorkflowToolName,
  isReviewerSeverityThreshold,
  parseRoleConfig,
  WorkflowConfigError,
  type WorkflowRoleConfig,
} from "../workflow-role.js";

describe("workflow-role contracts", () => {
  it("WORKFLOW_SANDBOX_VALUES 严格三项 snake_case", () => {
    expect([...WORKFLOW_SANDBOX_VALUES]).toEqual([
      "read_write_worktree",
      "read_only_worktree",
      "read_only_source_write_evidence",
    ]);
    expect(isWorkflowSandbox("read_only_worktree")).toBe(true);
    expect(isWorkflowSandbox("workspace-write")).toBe(false);
    expect(isWorkflowSandbox("read-only-source")).toBe(false);
  });

  it("WORKFLOW_TOOL_NAME_VALUES 严格按 spec §10 七项", () => {
    expect(new Set(WORKFLOW_TOOL_NAME_VALUES)).toEqual(
      new Set([
        "gitlab.create_mr",
        "gitlab.update_mr",
        "gitlab.read_mr",
        "gitlab.note_inline",
        "run.command",
        "playwright.walkthrough",
        "evidence.collect",
      ]),
    );
    expect(isWorkflowToolName("run.command")).toBe(true);
    expect(isWorkflowToolName("gitlab.delete_mr")).toBe(false);
  });

  it("REVIEWER_SEVERITY_THRESHOLD_VALUES 严格 low/medium/high/critical", () => {
    expect([...REVIEWER_SEVERITY_THRESHOLD_VALUES]).toEqual([
      "low",
      "medium",
      "high",
      "critical",
    ]);
    expect(isReviewerSeverityThreshold("medium")).toBe(true);
    expect(isReviewerSeverityThreshold("info")).toBe(false);
  });

  it("parseRoleConfig 把 YAML snake_case 映射成 TS camelCase（reviewer）", () => {
    const cfg = parseRoleConfig({
      role: "reviewer",
      raw: {
        prompt_template: "prompts/reviewer.md",
        sandbox: "read_only_worktree",
        tools: [
          { name: "gitlab.read_mr" },
          { name: "gitlab.note_inline" },
        ],
        publish_to_mr: true,
        severity_threshold: "medium",
        max_inline_comments: 25,
        timeout_seconds: 900,
      },
    });
    const reviewer = cfg as Extract<WorkflowRoleConfig, { role: "reviewer" }>;
    expect(reviewer.promptTemplate).toBe("prompts/reviewer.md");
    expect(reviewer.sandbox).toBe("read_only_worktree");
    expect(reviewer.tools).toEqual([
      { name: "gitlab.read_mr" },
      { name: "gitlab.note_inline" },
    ]);
    expect(reviewer.publishToMr).toBe(true);
    expect(reviewer.severityThreshold).toBe("medium");
    expect(reviewer.maxInlineComments).toBe(25);
    expect(reviewer.timeoutSeconds).toBe(900);
  });

  it("parseRoleConfig 接受 run.command 的 allow[]，包括 token 内 `*`", () => {
    const cfg = parseRoleConfig({
      role: "coder",
      raw: {
        prompt_template: "prompts/coder.md",
        sandbox: "read_write_worktree",
        tools: [
          {
            name: "run.command",
            allow: ["pnpm build", "pnpm --filter * test"],
          },
        ],
        timeout_seconds: 1800,
      },
    });
    const coder = cfg as Extract<WorkflowRoleConfig, { role: "coder" }>;
    expect(coder.tools).toEqual([
      {
        name: "run.command",
        allow: ["pnpm build", "pnpm --filter * test"],
      },
    ]);
  });

  it("parseRoleConfig 拒绝 allow: ['*']", () => {
    expect(() =>
      parseRoleConfig({
        role: "coder",
        raw: {
          prompt_template: "prompts/coder.md",
          sandbox: "read_write_worktree",
          tools: [{ name: "run.command", allow: ["*"] }],
        },
      }),
    ).toThrow(WorkflowConfigError);
  });

  it("parseRoleConfig 拒绝 allow: ['*', '*']", () => {
    expect(() =>
      parseRoleConfig({
        role: "coder",
        raw: {
          prompt_template: "prompts/coder.md",
          sandbox: "read_write_worktree",
          tools: [{ name: "run.command", allow: ["*", "*"] }],
        },
      }),
    ).toThrow(WorkflowConfigError);
  });

  it("parseRoleConfig 拒绝在非 run.command 上配 allow[]", () => {
    expect(() =>
      parseRoleConfig({
        role: "reviewer",
        raw: {
          prompt_template: "prompts/reviewer.md",
          sandbox: "read_only_worktree",
          tools: [{ name: "gitlab.note_inline", allow: ["any"] }],
        },
      }),
    ).toThrow(WorkflowConfigError);
  });

  it("parseRoleConfig 拒绝未知 sandbox 字面值", () => {
    expect(() =>
      parseRoleConfig({
        role: "reviewer",
        raw: {
          prompt_template: "prompts/reviewer.md",
          sandbox: "workspace-write",
        },
      }),
    ).toThrow(WorkflowConfigError);
  });

  it("parseRoleConfig 解析 token_scope_requirements 数组", () => {
    const cfg = parseRoleConfig({
      role: "reviewer",
      raw: {
        prompt_template: "prompts/reviewer.md",
        sandbox: "read_only_worktree",
        token_scope_requirements: ["api", "read_repository"],
      },
    });
    expect(cfg.tokenScopeRequirements).toEqual(["api", "read_repository"]);
  });

  it("parseRoleConfig 缺 promptTemplate 抛错", () => {
    expect(() =>
      parseRoleConfig({
        role: "coder",
        raw: { sandbox: "read_write_worktree" },
      }),
    ).toThrow(WorkflowConfigError);
  });

  it("V4.7: parseRoleConfig 默认 runner 为 codex_app_server，并保留显式 runner id", () => {
    const baseRaw = {
      prompt_template: "prompts/coder.md",
      sandbox: "read_write_worktree" as const,
    };
    expect(parseRoleConfig({ role: "coder", raw: { ...baseRaw } }).runner).toBe(
      "codex_app_server",
    );
    expect(
      parseRoleConfig({
        role: "coder",
        raw: { ...baseRaw, runner: "codex-fast" },
      }).runner,
    ).toBe("codex-fast");
    expect(
      parseRoleConfig({
        role: "coder",
        raw: { ...baseRaw, runner: "" },
      }).runner,
    ).toBe("codex_app_server");
  });
});
