import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  parseWorkflowFile,
  parseWorkflowString,
  WorkflowConfigError,
} from "../parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  path.join(here, "..", "..", "tests", "fixtures", name);

describe("parseWorkflowFile", () => {
  it("解析合法 front matter 并返回 prompt body", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));

    expect(cfg.tracker.kind).toBe("gitlab");
    expect(cfg.tracker.baseUrl).toBe("https://gitlab.example.com");
    expect(cfg.tracker.projectId).toBe("group/project");
    expect(cfg.tracker.tokenEnv).toBe("ISSUEPILOT_TEST_TOKEN");
    expect(cfg.tracker.activeLabels).toEqual(["ai-ready", "ai-rework"]);
    expect(cfg.tracker.runningLabel).toBe("ai-running");
    expect(cfg.tracker.handoffLabel).toBe("human-review");
    expect(cfg.tracker.failedLabel).toBe("ai-failed");
    expect(cfg.tracker.blockedLabel).toBe("ai-blocked");
    expect(cfg.tracker.reworkLabel).toBe("ai-rework");
    expect(cfg.tracker.mergingLabel).toBe("ai-merging");

    expect(cfg.workspace.root).toBe("~/.issuepilot/workspaces");
    expect(cfg.workspace.strategy).toBe("worktree");
    expect(cfg.workspace.repoCacheRoot).toBe("~/.issuepilot/repos");

    expect(cfg.git.repoUrl).toBe("git@gitlab.example.com:group/project.git");
    expect(cfg.git.baseBranch).toBe("main");
    expect(cfg.git.branchPrefix).toBe("ai");

    expect(cfg.agent.runner).toBe("codex-app-server");
    expect(cfg.agent.maxConcurrentAgents).toBe(1);
    expect(cfg.agent.maxTurns).toBe(10);
    expect(cfg.agent.maxAttempts).toBe(2);
    expect(cfg.agent.retryBackoffMs).toBe(30_000);

    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.approvalPolicy).toBe("never");
    expect(cfg.codex.threadSandbox).toBe("workspace-write");
    expect(cfg.codex.turnTimeoutMs).toBe(3_600_000);
    expect(cfg.codex.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });

    expect(cfg.hooks.afterCreate).toMatch(/pnpm install/);
    expect(cfg.hooks.beforeRun).toMatch(/git fetch origin/);
    expect(cfg.hooks.afterRun).toMatch(/pnpm test/);

    expect(cfg.ci).toEqual({
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });

    expect(cfg.retention).toEqual({
      successfulRunDays: 7,
      failedRunDays: 30,
      maxWorkspaceGb: 50,
      cleanupIntervalMs: 3_600_000,
    });

    expect(cfg.promptTemplate).toMatch(/Issue: \{\{ issue.identifier \}\}/);
    expect(cfg.promptTemplate).toMatch(/You are the AI engineer/);

    expect(cfg.source.path).toBe(fixture("workflow.valid.md"));
    expect(cfg.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => new Date(cfg.source.loadedAt)).not.toThrow();
  });

  it("最小 front matter 会被默认值补齐", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.minimal.md"));

    expect(cfg.tracker.activeLabels).toEqual(["ai-ready", "ai-rework"]);
    expect(cfg.tracker.runningLabel).toBe("ai-running");
    expect(cfg.tracker.handoffLabel).toBe("human-review");
    expect(cfg.tracker.failedLabel).toBe("ai-failed");
    expect(cfg.tracker.blockedLabel).toBe("ai-blocked");
    expect(cfg.tracker.reworkLabel).toBe("ai-rework");
    expect(cfg.tracker.mergingLabel).toBe("ai-merging");

    expect(cfg.workspace.root).toBe("~/.issuepilot/workspaces");
    expect(cfg.workspace.strategy).toBe("worktree");
    expect(cfg.workspace.repoCacheRoot).toBe("~/.issuepilot/repos");

    expect(cfg.git.baseBranch).toBe("main");
    expect(cfg.git.branchPrefix).toBe("ai");

    expect(cfg.agent.runner).toBe("codex-app-server");
    expect(cfg.agent.maxConcurrentAgents).toBe(1);
    expect(cfg.agent.maxTurns).toBe(10);
    expect(cfg.agent.maxAttempts).toBe(2);
    expect(cfg.agent.retryBackoffMs).toBe(30_000);

    expect(cfg.codex.command).toBe("codex app-server");
    expect(cfg.codex.approvalPolicy).toBe("never");
    expect(cfg.codex.threadSandbox).toBe("workspace-write");
    expect(cfg.codex.turnTimeoutMs).toBe(3_600_000);
    expect(cfg.codex.turnSandboxPolicy).toEqual({ type: "workspaceWrite" });

    expect(cfg.hooks.afterCreate).toBeUndefined();
    expect(cfg.hooks.beforeRun).toBeUndefined();
    expect(cfg.hooks.afterRun).toBeUndefined();

    expect(cfg.ci).toEqual({
      enabled: false,
      onFailure: "ai-rework",
      waitForPipeline: true,
    });
  });

  it("retention 节自定义值会被透传", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.retention.md"));

    expect(cfg.retention).toEqual({
      successfulRunDays: 1,
      failedRunDays: 60,
      maxWorkspaceGb: 100,
      cleanupIntervalMs: 120_000,
    });
  });

  it("retention.cleanup_interval_ms 低于 60 秒下限抛 WorkflowConfigError", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.retention-bad-interval.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "retention.cleanup_interval_ms",
    });
  });

  it("ci.enabled 与 on_failure 自定义值会被透传", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.ci-enabled.md"));

    expect(cfg.ci).toEqual({
      enabled: true,
      onFailure: "human-review",
      waitForPipeline: false,
    });
  });

  it("ci.on_failure 仅接受 ai-rework / human-review 枚举", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.ci-bad-on-failure.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "ci.on_failure",
    });
  });

  it("缺少 tracker 时抛 WorkflowConfigError 且包含字段路径", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.missing-tracker.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "tracker",
    });
  });

  it("缺少 tracker 时抛出的错误是 WorkflowConfigError 类型", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.missing-tracker.md")),
    ).rejects.toBeInstanceOf(WorkflowConfigError);
  });

  it("YAML 解析失败时抛出 WorkflowConfigError 且 path 指向 front-matter", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.bad-yaml.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "<front-matter>",
    });
  });

  it("不存在的文件抛 WorkflowConfigError 且 path = <file>", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.does-not-exist.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "<file>",
    });
  });

  it("拒绝 workflow 将 Codex sandbox 提升到 danger-full-access", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.danger-sandbox.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "codex.thread_sandbox",
    });
  });

  it("拒绝非法 tracker.token_env 名称", async () => {
    await expect(
      parseWorkflowFile(fixture("workflow.invalid-token-env.md")),
    ).rejects.toMatchObject({
      name: "WorkflowConfigError",
      path: "tracker.token_env",
    });
  });

  it("V4.6: 缺 default_recipe 时 fallback 到 full_pipeline 并 emit warning", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
---
hello
`;
    const cfg = parseWorkflowString(raw, "/tmp/wf.md");
    expect(cfg.defaultRecipe).toBe("full_pipeline");
    expect(
      cfg.warnings?.some((w) => w.code === "default_recipe_missing"),
    ).toBe(true);
  });

  it("V4.6: 显式 default_recipe = coding_only 透传", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
default_recipe: coding_only
---
hi
`;
    const cfg = parseWorkflowString(raw, "/tmp/wf.md");
    expect(cfg.defaultRecipe).toBe("coding_only");
    expect(
      cfg.warnings?.some((w) => w.code === "default_recipe_missing"),
    ).toBe(false);
  });

  it("V4.6: 非法 default_recipe 抛 WorkflowConfigError", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
default_recipe: nope
---
hi
`;
    expect(() => parseWorkflowString(raw, "/tmp/wf.md")).toThrow(
      /default_recipe/,
    );
  });

  it("V4.6: roles 块解析 reviewer 字段 + sandbox + run.command allow", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
roles:
  coder:
    prompt_template: "prompts/coder.md"
    sandbox: read_write_worktree
    tools:
      - name: gitlab.create_mr
      - name: run.command
        allow:
          - "pnpm build"
          - "pnpm --filter * test"
    timeout_seconds: 1800
  reviewer:
    prompt_template: "prompts/reviewer.md"
    sandbox: read_only_worktree
    publish_to_mr: true
    severity_threshold: medium
    max_inline_comments: 25
    timeout_seconds: 900
  test_evidence:
    prompt_template: "prompts/test-evidence.md"
    sandbox: read_only_source_write_evidence
    timeout_seconds: 1200
---
prompt body
`;
    const cfg = parseWorkflowString(raw, "/tmp/wf.md");
    expect(cfg.roles.coder?.promptTemplate).toBe("prompts/coder.md");
    expect(cfg.roles.coder?.sandbox).toBe("read_write_worktree");
    expect(cfg.roles.coder?.tools).toEqual([
      { name: "gitlab.create_mr" },
      {
        name: "run.command",
        allow: ["pnpm build", "pnpm --filter * test"],
      },
    ]);
    expect(cfg.roles.reviewer?.promptTemplate).toBe("prompts/reviewer.md");
    if (cfg.roles.reviewer?.role === "reviewer") {
      expect(cfg.roles.reviewer.publishToMr).toBe(true);
      expect(cfg.roles.reviewer.severityThreshold).toBe("medium");
      expect(cfg.roles.reviewer.maxInlineComments).toBe(25);
    }
    expect(cfg.roles.test_evidence?.sandbox).toBe(
      "read_only_source_write_evidence",
    );
  });

  it("V4.6: 缺 reviewer role → fallback 到默认 profile 并 emit warning", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
roles:
  coder:
    prompt_template: "prompts/coder.md"
    sandbox: read_write_worktree
---
hi
`;
    const cfg = parseWorkflowString(raw, "/tmp/wf.md");
    expect(cfg.roles.reviewer?.promptTemplate).toBe("prompts/reviewer.md");
    expect(
      cfg.warnings?.some(
        (w) => w.code === "role_default_used" && w.path === "roles.reviewer",
      ),
    ).toBe(true);
  });

  it("V4.6: tools allow ['*'] 抛 WorkflowConfigError 路径 = roles.coder", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
roles:
  coder:
    prompt_template: "prompts/coder.md"
    sandbox: read_write_worktree
    tools:
      - name: run.command
        allow: ["*"]
---
hi
`;
    try {
      parseWorkflowString(raw, "/tmp/wf.md");
      expect.fail("expected WorkflowConfigError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(WorkflowConfigError);
      expect((cause as WorkflowConfigError).path).toBe("roles.coder");
    }
  });

  it("V4.6: tools allow 仅允许 run.command", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
roles:
  reviewer:
    prompt_template: "prompts/reviewer.md"
    sandbox: read_only_worktree
    tools:
      - name: gitlab.note_inline
        allow: ["whatever"]
---
hi
`;
    try {
      parseWorkflowString(raw, "/tmp/wf.md");
      expect.fail("expected WorkflowConfigError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(WorkflowConfigError);
      expect((cause as WorkflowConfigError).path).toBe("roles.reviewer");
    }
  });

  it("V4.6: 非法 sandbox 抛 WorkflowConfigError", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
roles:
  coder:
    prompt_template: "prompts/coder.md"
    sandbox: workspace-write
---
hi
`;
    try {
      parseWorkflowString(raw, "/tmp/wf.md");
      expect.fail("expected WorkflowConfigError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(WorkflowConfigError);
      expect((cause as WorkflowConfigError).path).toBe("roles.coder");
    }
  });

  it("V4.6: tracker.token_scope_requirements 透传", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_scope_requirements:
    - api
    - read_repository
git:
  repo_url: "git@gitlab.example.com:group/project.git"
---
hi
`;
    const cfg = parseWorkflowString(raw, "/tmp/wf.md");
    expect(cfg.tracker.tokenScopeRequirements).toEqual([
      "api",
      "read_repository",
    ]);
  });

  it("V4.6: tracker.token_scope_requirements 非数组抛错", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_scope_requirements: "api"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
---
hi
`;
    expect(() => parseWorkflowString(raw, "/tmp/wf.md")).toThrow(
      WorkflowConfigError,
    );
  });

  it("parses workflow content from a generated source path", () => {
    const raw = `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
---

Handle issue {{ issue.identifier }}.
`;

    const cfg = parseWorkflowString(
      raw,
      "/srv/issuepilot-config/.generated/platform-web.workflow.md",
    );

    expect(cfg.source.path).toBe(
      "/srv/issuepilot-config/.generated/platform-web.workflow.md",
    );
    expect(cfg.tracker.projectId).toBe("group/project");
    expect(cfg.git.baseBranch).toBe("main");
    expect(cfg.promptTemplate).toContain("Handle issue");
  });
});
