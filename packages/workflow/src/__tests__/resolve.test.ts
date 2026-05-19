import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { parseWorkflowFile, parseWorkflowString } from "../parse.js";
import {
  expandHomePath,
  expandWorkflowPaths,
  resolveRolePromptHashes,
  resolveTrackerSecret,
  resolveWorkflow,
  RoleProfileInvalidError,
  validateWorkflowEnv,
  WorkflowConfigError,
} from "../resolve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  path.join(here, "..", "..", "tests", "fixtures", name);

describe("expandHomePath", () => {
  it("将 `~/foo` 展开为 homedir/foo", () => {
    expect(expandHomePath("~/foo")).toBe(path.join(os.homedir(), "foo"));
  });

  it("纯 `~` 展开为 homedir", () => {
    expect(expandHomePath("~")).toBe(os.homedir());
  });

  it("将 `$HOME/bar/baz` 展开", () => {
    expect(expandHomePath("$HOME/bar/baz")).toBe(
      path.join(os.homedir(), "bar/baz"),
    );
  });

  it("不展开 `~user/foo` 这类用户引用", () => {
    expect(expandHomePath("~user/foo")).toBe("~user/foo");
  });

  it("不展开 `$HOMEX` 这种非边界匹配", () => {
    expect(expandHomePath("$HOMEX/abc")).toBe("$HOMEX/abc");
  });

  it("不展开其它环境变量", () => {
    expect(expandHomePath("$USER/foo")).toBe("$USER/foo");
    expect(expandHomePath("${HOME}/foo")).toBe("${HOME}/foo");
  });

  it("绝对路径和相对路径原样返回", () => {
    expect(expandHomePath("/abs/path")).toBe("/abs/path");
    expect(expandHomePath("relative/path")).toBe("relative/path");
  });

  it("非字符串输入抛 WorkflowConfigError", () => {
    expect(() => expandHomePath(undefined as unknown as string)).toThrow(
      WorkflowConfigError,
    );
    expect(() => expandHomePath(123 as unknown as string)).toThrow(
      WorkflowConfigError,
    );
  });
});

describe("expandWorkflowPaths", () => {
  it("展开 workspace.root 与 workspace.repoCacheRoot", async () => {
    const raw = await parseWorkflowFile(fixture("workflow.valid.md"));
    const cfg = expandWorkflowPaths(raw);

    expect(cfg.workspace.root).toBe(
      path.join(os.homedir(), ".issuepilot/workspaces"),
    );
    expect(cfg.workspace.repoCacheRoot).toBe(
      path.join(os.homedir(), ".issuepilot/repos"),
    );
    expect(cfg.tracker.projectId).toBe(raw.tracker.projectId);
    expect(cfg.promptTemplate).toBe(raw.promptTemplate);
  });

  it("返回的是新对象，不修改输入", async () => {
    const raw = await parseWorkflowFile(fixture("workflow.valid.md"));
    const before = raw.workspace.root;
    const cfg = expandWorkflowPaths(raw);
    expect(raw.workspace.root).toBe(before);
    expect(cfg).not.toBe(raw);
  });
});

describe("validateWorkflowEnv", () => {
  it("env 中有 token 时安静返回", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));
    expect(() =>
      validateWorkflowEnv(cfg, { ISSUEPILOT_TEST_TOKEN: "secret" }),
    ).not.toThrow();
  });

  it("缺失时抛 WorkflowConfigError 且 path === 'tracker.token_env'", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));
    try {
      validateWorkflowEnv(cfg, {});
      throw new Error("expected validateWorkflowEnv to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowConfigError);
      expect((e as WorkflowConfigError).path).toBe("tracker.token_env");
    }
  });

  it("空字符串视为缺失", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));
    expect(() =>
      validateWorkflowEnv(cfg, { ISSUEPILOT_TEST_TOKEN: "" }),
    ).toThrow(WorkflowConfigError);
  });
});

describe("resolveTrackerSecret", () => {
  it("返回 token 但不修改 cfg", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));
    const before = JSON.stringify(cfg);

    const secret = resolveTrackerSecret(cfg, {
      ISSUEPILOT_TEST_TOKEN: "glpat-xxxxx",
    });
    expect(secret).toEqual({ token: "glpat-xxxxx" });
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it("缺失时抛 WorkflowConfigError(path = tracker.token_env)", async () => {
    const cfg = await parseWorkflowFile(fixture("workflow.valid.md"));
    try {
      resolveTrackerSecret(cfg, {});
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowConfigError);
      expect((e as WorkflowConfigError).path).toBe("tracker.token_env");
    }
  });
});

describe("V4.6 role prompt template hashing", () => {
  const baseWorkflowRaw = (rolesYaml: string): string => `---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
git:
  repo_url: "git@gitlab.example.com:group/project.git"
${rolesYaml}---
prompt body
`;

  const writeAllRolePrompts = async (
    dir: string,
    overrides: Partial<Record<"coder" | "reviewer" | "test_evidence", string>> = {},
  ): Promise<void> => {
    const all = {
      coder: { rel: "coder.md", body: "coder default" },
      reviewer: { rel: "reviewer.md", body: "reviewer default" },
      test_evidence: { rel: "test-evidence.md", body: "evidence default" },
      ...overrides,
    } as Record<string, { rel: string; body: string } | string>;
    for (const value of Object.values(all)) {
      if (typeof value === "string") continue;
      await writeFile(path.join(dir, value.rel), value.body, "utf8");
    }
  };

  it("给同一文件两次 resolve 返回稳定 sha256", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "issuepilot-resolve-"));
    const reviewerPath = path.join(dir, "reviewer.md");
    await writeFile(reviewerPath, "Review the following diff strictly.\n", "utf8");
    // 为默认 coder / test_evidence profile 准备相对路径文件，避免它们因 fallback 触发缺失。
    await writeFile(path.join(dir, "prompts-coder.md"), "coder", "utf8");
    const cfg = parseWorkflowString(
      baseWorkflowRaw(`roles:
  coder:
    prompt_template: "prompts-coder.md"
    sandbox: read_write_worktree
  reviewer:
    prompt_template: "reviewer.md"
    sandbox: read_only_worktree
  test_evidence:
    prompt_template: "evidence.md"
    sandbox: read_only_source_write_evidence
`),
      path.join(dir, "WORKFLOW.md"),
    );
    await writeFile(path.join(dir, "evidence.md"), "evidence", "utf8");
    const r1 = await resolveRolePromptHashes(cfg, dir);
    const r2 = await resolveRolePromptHashes(cfg, dir);
    expect(r1.reviewer?.promptTemplateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.reviewer?.promptTemplateHash).toBe(
      r2.reviewer?.promptTemplateHash,
    );
    expect(path.isAbsolute(r1.reviewer?.promptTemplate ?? "")).toBe(true);
  });

  it("缺失 prompt template 抛 RoleProfileInvalidError 带 role + 绝对路径", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "issuepilot-resolve-"));
    await writeFile(path.join(dir, "coder.md"), "coder", "utf8");
    await writeFile(path.join(dir, "test-evidence.md"), "evidence", "utf8");
    const cfg = parseWorkflowString(
      baseWorkflowRaw(`roles:
  coder:
    prompt_template: "coder.md"
    sandbox: read_write_worktree
  reviewer:
    prompt_template: "missing.md"
    sandbox: read_only_worktree
  test_evidence:
    prompt_template: "test-evidence.md"
    sandbox: read_only_source_write_evidence
`),
      path.join(dir, "WORKFLOW.md"),
    );
    try {
      await resolveRolePromptHashes(cfg, dir);
      expect.fail("expected RoleProfileInvalidError");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RoleProfileInvalidError);
      const err = cause as RoleProfileInvalidError;
      expect(err.role).toBe("reviewer");
      expect(path.isAbsolute(err.promptTemplatePath)).toBe(true);
      expect(err.promptTemplatePath).toContain("missing.md");
    }
  });

  it("resolveWorkflow 一次返回带 promptTemplateHash 与展开路径的 cfg", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "issuepilot-resolve-"));
    await writeFile(path.join(dir, "coder.md"), "coder prompt", "utf8");
    await writeFile(path.join(dir, "reviewer.md"), "reviewer prompt", "utf8");
    await writeFile(
      path.join(dir, "test-evidence.md"),
      "evidence prompt",
      "utf8",
    );
    const cfg = parseWorkflowString(
      baseWorkflowRaw(`roles:
  coder:
    prompt_template: "coder.md"
    sandbox: read_write_worktree
  reviewer:
    prompt_template: "reviewer.md"
    sandbox: read_only_worktree
  test_evidence:
    prompt_template: "test-evidence.md"
    sandbox: read_only_source_write_evidence
`),
      path.join(dir, "WORKFLOW.md"),
    );
    const resolved = await resolveWorkflow(cfg, dir);
    expect(resolved.roles.coder?.promptTemplateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(resolved.roles.reviewer?.promptTemplateHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(resolved.roles.test_evidence?.promptTemplateHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // 路径已展开为绝对
    expect(path.isAbsolute(resolved.roles.coder?.promptTemplate ?? "")).toBe(
      true,
    );
  });
});
