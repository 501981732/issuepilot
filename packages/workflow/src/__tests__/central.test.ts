import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { compileCentralWorkflowProject } from "../central.js";
import type { CentralWorkflowConfigError } from "../central.js";

describe("central workflow config compiler", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "issuepilot-central-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("compiles project facts and workflow profile into WorkflowConfig", async () => {
    const projectPath = path.join(dir, "platform-web.yaml");
    const profilePath = path.join(dir, "default-web.md");

    await writeFile(
      projectPath,
      `
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web
git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai
agent:
  max_turns: 12
  max_attempts: 3
`,
      "utf8",
    );

    await writeFile(
      profilePath,
      `---
agent:
  runner: codex-app-server
  max_concurrent_agents: 1
codex:
  approval_policy: never
  thread_sandbox: workspace-write
ci:
  enabled: true
  on_failure: ai-rework
  wait_for_pipeline: true
---

Work on {{ project.tracker.project_id }} issue {{ issue.identifier }}.
`,
      "utf8",
    );

    const workflow = await compileCentralWorkflowProject({
      projectId: "platform-web",
      projectPath,
      workflowProfilePath: profilePath,
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      generatedSourcePath: path.join(
        dir,
        ".generated/platform-web.workflow.md",
      ),
    });

    expect(workflow.tracker.projectId).toBe("group/platform-web");
    expect(workflow.git.repoUrl).toBe(
      "git@gitlab.example.com:group/platform-web.git",
    );
    expect(workflow.agent.maxTurns).toBe(12);
    expect(workflow.agent.maxAttempts).toBe(3);
    expect(workflow.ci.enabled).toBe(true);
    expect(workflow.promptTemplate).toContain("{{ project.tracker.project_id }}");
    expect(workflow.source.path).toContain(".generated/platform-web.workflow.md");
  });

  it("rejects project files that override high-risk runtime fields", async () => {
    const projectPath = path.join(dir, "bad-project.yaml");
    const profilePath = path.join(dir, "default-web.md");

    await writeFile(
      projectPath,
      `
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web
  token_env: GITLAB_TOKEN
git:
  repo_url: git@gitlab.example.com:group/platform-web.git
`,
      "utf8",
    );
    await writeFile(profilePath, "---\n---\nPrompt\n", "utf8");

    await expect(
      compileCentralWorkflowProject({
        projectId: "platform-web",
        projectPath,
        workflowProfilePath: profilePath,
        defaults: {
          labelsPath: null,
          codexPath: null,
          workspaceRoot: "~/.issuepilot/workspaces",
          repoCacheRoot: "~/.issuepilot/repos",
        },
        generatedSourcePath: path.join(
          dir,
          ".generated/platform-web.workflow.md",
        ),
      }),
    ).rejects.toMatchObject({
      name: "CentralWorkflowConfigError",
      path: "project.tracker.token_env",
    } satisfies Partial<CentralWorkflowConfigError>);
  });

  it("falls back to default labels when profile omits tracker labels", async () => {
    const projectPath = path.join(dir, "platform-web.yaml");
    const profilePath = path.join(dir, "default-web.md");

    await writeFile(
      projectPath,
      `
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web
git:
  repo_url: git@gitlab.example.com:group/platform-web.git
`,
      "utf8",
    );

    await writeFile(profilePath, `---\n---\nPrompt body\n`, "utf8");

    const workflow = await compileCentralWorkflowProject({
      projectId: "platform-web",
      projectPath,
      workflowProfilePath: profilePath,
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      generatedSourcePath: path.join(
        dir,
        ".generated/platform-web.workflow.md",
      ),
    });

    expect(workflow.tracker.activeLabels).toEqual(["ai-ready", "ai-rework"]);
    expect(workflow.tracker.runningLabel).toBe("ai-running");
    expect(workflow.tracker.mergingLabel).toBe("ai-merging");
    expect(workflow.workspace.root).toBe("~/.issuepilot/workspaces");
    expect(workflow.workspace.repoCacheRoot).toBe("~/.issuepilot/repos");
    expect(workflow.git.baseBranch).toBe("main");
    expect(workflow.git.branchPrefix).toBe("ai");
  });

  it("wraps file-read failures with the project label", async () => {
    const profilePath = path.join(dir, "default-web.md");
    await writeFile(profilePath, `---\n---\nPrompt body\n`, "utf8");

    await expect(
      compileCentralWorkflowProject({
        projectId: "platform-web",
        projectPath: path.join(dir, "does-not-exist.yaml"),
        workflowProfilePath: profilePath,
        defaults: {
          labelsPath: null,
          codexPath: null,
          workspaceRoot: "~/.issuepilot/workspaces",
          repoCacheRoot: "~/.issuepilot/repos",
        },
        generatedSourcePath: path.join(
          dir,
          ".generated/platform-web.workflow.md",
        ),
      }),
    ).rejects.toMatchObject({
      name: "CentralWorkflowConfigError",
      path: "project",
    });
  });
});
