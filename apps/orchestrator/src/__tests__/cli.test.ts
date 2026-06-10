import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCli } from "../cli.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const rootPackage = JSON.parse(
  fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("CLI", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-")),
    );
    process.exitCode = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("prints the package version", async () => {
    const output: string[] = [];
    const cli = buildCli();
    cli.configureOutput({ writeOut: (text) => output.push(text) });
    cli.exitOverride();

    await expect(
      cli.parseAsync(["--version"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.version" });

    expect(output.join("")).toContain(rootPackage.version);
  });

  it("validate fails for missing workflow", async () => {
    const cli = buildCli();
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});

    await cli.parseAsync(["validate", "--workflow", "/nonexistent/wf.md"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("validate succeeds for existing workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({
      validateWorkflow: async () => ({
        tracker: {
          kind: "gitlab",
          baseUrl: "https://gitlab.example.com",
          projectId: "group/project",
          tokenEnv: "GITLAB_TOKEN",
          activeLabels: ["ai-ready"],
          runningLabel: "ai-running",
          handoffLabel: "human-review",
          failedLabel: "ai-failed",
          blockedLabel: "ai-blocked",
          reworkLabel: "ai-rework",
          mergingLabel: "ai-merging",
        },
        workspace: {
          root: "/tmp/issuepilot",
          strategy: "worktree",
          repoCacheRoot: "/tmp/issuepilot/cache",
        },
        git: {
          repoUrl: "git@example.com:group/project.git",
          baseBranch: "main",
          branchPrefix: "issuepilot",
        },
        agent: {
          runner: "codex-app-server",
          maxConcurrentAgents: 1,
          maxTurns: 3,
          maxAttempts: 2,
          retryBackoffMs: 1000,
        },
        codex: {
          command: "codex app-server",
          approvalPolicy: "never",
          threadSandbox: "workspace-write",
          turnTimeoutMs: 60_000,
          turnSandboxPolicy: { type: "workspaceWrite" },
        },
        hooks: {},
        promptTemplate: "Fix {{ issue.title }}",
        source: {
          path: wfPath,
          sha256: "sha",
          loadedAt: new Date(0).toISOString(),
        },
      }),
    });

    await cli.parseAsync(["validate", "--workflow", wfPath], {
      from: "user",
    });

    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("Validation passed"),
    );
    mockLog.mockRestore();
  });

  it("validate defaults to ./WORKFLOW.md when --workflow is omitted", async () => {
    const originalCwd = process.cwd();
    const wfPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const validateWorkflow = vi.fn(async () => ({
      tracker: {
        kind: "gitlab",
        baseUrl: "https://gitlab.example.com",
        projectId: "group/project",
        tokenEnv: "GITLAB_TOKEN",
        activeLabels: ["ai-ready"],
        runningLabel: "ai-running",
        handoffLabel: "human-review",
        failedLabel: "ai-failed",
        blockedLabel: "ai-blocked",
        reworkLabel: "ai-rework",
        mergingLabel: "ai-merging",
      },
      workspace: {
        root: "/tmp/issuepilot",
        strategy: "worktree",
        repoCacheRoot: "/tmp/issuepilot/cache",
      },
      git: {
        repoUrl: "git@example.com:group/project.git",
        baseBranch: "main",
        branchPrefix: "issuepilot",
      },
      agent: {
        runner: "codex-app-server",
        maxConcurrentAgents: 1,
        maxTurns: 3,
        maxAttempts: 2,
        retryBackoffMs: 1000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 60_000,
        turnSandboxPolicy: { type: "workspaceWrite" },
      },
      hooks: {},
      promptTemplate: "Fix {{ issue.title }}",
      source: {
        path: wfPath,
        sha256: "sha",
        loadedAt: new Date(0).toISOString(),
      },
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ validateWorkflow });

    try {
      process.chdir(tmpDir);
      await cli.parseAsync(["validate"], { from: "user" });
    } finally {
      process.chdir(originalCwd);
      mockLog.mockRestore();
    }

    expect(validateWorkflow).toHaveBeenCalledWith(wfPath);
  });

  it("validate defaults to ./issuepilot.team.yaml when present", async () => {
    const originalCwd = process.cwd();
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
    );

    const loadTeamConfig = vi.fn(async () => ({
      version: 1 as const,
      server: { host: "127.0.0.1", port: 4738 },
      scheduler: {
        maxConcurrentRuns: 2,
        maxConcurrentRunsPerProject: 1,
        leaseTtlMs: 900_000,
        pollIntervalMs: 10_000,
      },
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: path.join(tmpDir, "projects/platform-web.yaml"),
          workflowProfilePath: path.join(tmpDir, "workflows/default-web.md"),
          enabled: true,
          ci: null,
        },
      ],
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 20,
        cleanupIntervalMs: 3_600_000,
      },
      ci: null,
      source: {
        path: configPath,
        sha256: "sha",
        loadedAt: new Date(0).toISOString(),
      },
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig });

    try {
      process.chdir(tmpDir);
      await cli.parseAsync(["validate"], { from: "user" });
    } finally {
      process.chdir(originalCwd);
      mockLog.mockRestore();
    }

    expect(loadTeamConfig).toHaveBeenCalledWith(configPath);
  });

  it("validate falls back to .agents/workflow.md with a warning", async () => {
    const originalCwd = process.cwd();
    const legacyDir = path.join(tmpDir, ".agents");
    fs.mkdirSync(legacyDir);
    const wfPath = path.join(legacyDir, "workflow.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const validateWorkflow = vi.fn(async () => ({
      tracker: {
        kind: "gitlab",
        baseUrl: "https://gitlab.example.com",
        projectId: "group/project",
        tokenEnv: "GITLAB_TOKEN",
        activeLabels: ["ai-ready"],
        runningLabel: "ai-running",
        handoffLabel: "human-review",
        failedLabel: "ai-failed",
        blockedLabel: "ai-blocked",
        reworkLabel: "ai-rework",
        mergingLabel: "ai-merging",
      },
      workspace: {
        root: "/tmp/issuepilot",
        strategy: "worktree",
        repoCacheRoot: "/tmp/issuepilot/cache",
      },
      git: {
        repoUrl: "git@example.com:group/project.git",
        baseBranch: "main",
        branchPrefix: "issuepilot",
      },
      agent: {
        runner: "codex-app-server",
        maxConcurrentAgents: 1,
        maxTurns: 3,
        maxAttempts: 2,
        retryBackoffMs: 1000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 60_000,
        turnSandboxPolicy: { type: "workspaceWrite" },
      },
      hooks: {},
      promptTemplate: "Fix {{ issue.title }}",
      source: {
        path: wfPath,
        sha256: "sha",
        loadedAt: new Date(0).toISOString(),
      },
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cli = buildCli({ validateWorkflow });

    try {
      process.chdir(tmpDir);
      await cli.parseAsync(["validate"], { from: "user" });
      expect(validateWorkflow).toHaveBeenCalledWith(wfPath);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          ".agents/workflow.md is deprecated as a default",
        ),
      );
    } finally {
      process.chdir(originalCwd);
      mockLog.mockRestore();
      mockWarn.mockRestore();
    }
  });

  it("validate --config reports project/profile paths for each team project", async () => {
    const cfgPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(cfgPath, "version: 1\n");
    const loadTeamConfig = vi.fn(async () => ({
      version: 1 as const,
      server: { host: "127.0.0.1", port: 4738 },
      scheduler: {
        maxConcurrentRuns: 3,
        maxConcurrentRunsPerProject: 1,
        leaseTtlMs: 600_000,
        pollIntervalMs: 5_000,
      },
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
          workflowProfilePath:
            "/srv/issuepilot-config/workflows/default-web.md",
          enabled: true,
          ci: null,
        },
        {
          id: "platform-api",
          name: "Platform API",
          projectPath: "/srv/issuepilot-config/projects/platform-api.yaml",
          workflowProfilePath:
            "/srv/issuepilot-config/workflows/default-node-lib.md",
          enabled: false,
          ci: null,
        },
      ],
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 50,
        cleanupIntervalMs: 3_600_000,
      },
      ci: null,
      source: { path: cfgPath, sha256: "deadbeef", loadedAt: "" },
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig });

    await cli.parseAsync(["validate", "--config", cfgPath], { from: "user" });

    expect(loadTeamConfig).toHaveBeenCalledWith(cfgPath);
    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Team config loaded");
    expect(output).toContain("2 (1 enabled, 1 disabled)");
    expect(output).toContain(
      "project=/srv/issuepilot-config/projects/platform-web.yaml",
    );
    expect(output).toContain(
      "profile=/srv/issuepilot-config/workflows/default-web.md",
    );
    expect(output).toContain("Team validation passed.");
    mockLog.mockRestore();
  });

  it("render-workflow prints the effective workflow for one team project", async () => {
    const cfgPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(cfgPath, "version: 1\n");
    const loadTeamConfig = vi.fn(async () => ({
      version: 1 as const,
      server: { host: "127.0.0.1", port: 4738 },
      scheduler: {
        maxConcurrentRuns: 3,
        maxConcurrentRunsPerProject: 1,
        leaseTtlMs: 600_000,
        pollIntervalMs: 5_000,
      },
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
          workflowProfilePath:
            "/srv/issuepilot-config/workflows/default-web.md",
          enabled: true,
          ci: null,
        },
      ],
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 50,
        cleanupIntervalMs: 3_600_000,
      },
      ci: null,
      source: { path: cfgPath, sha256: "deadbeef", loadedAt: "" },
    }));
    const compileCentralWorkflowProject = vi.fn(async () => ({
      tracker: {
        kind: "gitlab" as const,
        baseUrl: "https://gitlab.example.com",
        projectId: "group/platform-web",
        tokenEnv: "GITLAB_TOKEN",
        activeLabels: ["ai-ready"],
        runningLabel: "ai-running",
        handoffLabel: "human-review",
        failedLabel: "ai-failed",
        blockedLabel: "ai-blocked",
        reworkLabel: "ai-rework",
        mergingLabel: "ai-merging",
      },
      workspace: {
        root: "~/.issuepilot/workspaces",
        strategy: "worktree" as const,
        repoCacheRoot: "~/.issuepilot/repos",
      },
      git: {
        repoUrl: "git@gitlab.example.com:group/platform-web.git",
        baseBranch: "main",
        branchPrefix: "ai",
      },
      agent: {
        runner: "codex-app-server" as const,
        maxConcurrentAgents: 1,
        maxTurns: 12,
        maxAttempts: 3,
        retryBackoffMs: 30_000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never" as const,
        threadSandbox: "workspace-write" as const,
        turnTimeoutMs: 3_600_000,
        turnSandboxPolicy: { type: "workspaceWrite" as const },
      },
      hooks: {
        afterCreate: "pnpm install --frozen-lockfile",
        beforeRun: "pnpm typecheck",
        afterRun: "pnpm test",
      },
      ci: {
        enabled: false,
        onFailure: "ai-rework" as const,
        waitForPipeline: true,
      },
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 50,
        cleanupIntervalMs: 3_600_000,
      },
      pollIntervalMs: 10_000,
      promptTemplate: [
        "Issue: {{ issue.identifier }}",
        "Title: {{ issue.title }}",
        "",
        "Please resolve the issue end-to-end.",
      ].join("\n"),
      source: {
        path: "/srv/issuepilot-config/.generated/platform-web.workflow.md",
        sha256: "abc",
        loadedAt: new Date(0).toISOString(),
      },
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig, compileCentralWorkflowProject });

    await cli.parseAsync(
      ["render-workflow", "--config", cfgPath, "--project", "platform-web"],
      { from: "user" },
    );

    expect(compileCentralWorkflowProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "platform-web",
        projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
        workflowProfilePath: "/srv/issuepilot-config/workflows/default-web.md",
      }),
    );
    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("tracker:");
    expect(output).toContain("project_id: group/platform-web");
    // Operators reviewing a compiled workflow specifically need to see
    // shell commands and the prompt — assert they aren't silently dropped.
    expect(output).toContain("hooks:");
    expect(output).toContain("after_create: pnpm install --frozen-lockfile");
    expect(output).toContain("before_run: pnpm typecheck");
    expect(output).toContain("after_run: pnpm test");
    expect(output).toContain("retention:");
    expect(output).toContain("successful_run_days: 7");
    expect(output).toContain("max_workspace_gb: 50");
    // Multi-line prompts must use YAML literal block scalars (`|` or `|-`)
    // so newlines / Liquid tags survive a copy/diff round-trip.
    expect(output).toMatch(/prompt_template: \|/);
    expect(output).toContain("Issue: {{ issue.identifier }}");
    expect(output).toContain("Please resolve the issue end-to-end.");
    // Secrets / runtime metadata must still be scrubbed.
    expect(output).not.toMatch(/token_env/);
    expect(output).not.toMatch(/GITLAB_TOKEN/);
    expect(output).not.toMatch(/sha256/);
    expect(output).not.toMatch(/loaded_at|loadedAt/);
    mockLog.mockRestore();
  });

  it("render-workflow exits with code 1 when the project id is unknown", async () => {
    const cfgPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(cfgPath, "version: 1\n");
    const loadTeamConfig = vi.fn(async () => ({
      version: 1 as const,
      server: { host: "127.0.0.1", port: 4738 },
      scheduler: {
        maxConcurrentRuns: 3,
        maxConcurrentRunsPerProject: 1,
        leaseTtlMs: 600_000,
        pollIntervalMs: 5_000,
      },
      defaults: {
        labelsPath: null,
        codexPath: null,
        workspaceRoot: "~/.issuepilot/workspaces",
        repoCacheRoot: "~/.issuepilot/repos",
      },
      projects: [
        {
          id: "platform-web",
          name: "Platform Web",
          projectPath: "/srv/issuepilot-config/projects/platform-web.yaml",
          workflowProfilePath:
            "/srv/issuepilot-config/workflows/default-web.md",
          enabled: true,
          ci: null,
        },
      ],
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 50,
        cleanupIntervalMs: 3_600_000,
      },
      ci: null,
      source: { path: cfgPath, sha256: "deadbeef", loadedAt: "" },
    }));
    const compileCentralWorkflowProject = vi.fn();
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig, compileCentralWorkflowProject });

    await cli.parseAsync(
      ["render-workflow", "--config", cfgPath, "--project", "unknown"],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(compileCentralWorkflowProject).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("project not found"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("validate --config surfaces parser errors with exit code 1", async () => {
    const cfgPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(cfgPath, "version: 1\n");
    const loadTeamConfig = vi.fn(async () => {
      throw new Error("scheduler.lease_ttl_ms: Number must be >= 60000");
    });
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig });

    await cli.parseAsync(["validate", "--config", cfgPath], { from: "user" });

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("scheduler.lease_ttl_ms"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("validate --config and --workflow are mutually exclusive", async () => {
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli({ loadTeamConfig: vi.fn() });

    await cli.parseAsync(
      [
        "validate",
        "--config",
        path.join(tmpDir, "x.yaml"),
        "--workflow",
        path.join(tmpDir, "WORKFLOW.md"),
      ],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("mutually exclusive"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("doctor runs checks", async () => {
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({
      checkCodexAppServer: async () => "0.0.0",
      execaCommand: async () => ({ stdout: "git version 2.0.0" }) as never,
    });

    await cli.parseAsync(["doctor"], { from: "user" });

    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Node.js");
    expect(output).toContain("git");
    expect(output).toContain("state dir");
    mockLog.mockRestore();
  });

  it("doctor --workspace dry-runs the cleanup planner without deleting files", async () => {
    const wfPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(wfPath, "---\ntitle: ignored by mock\n---\n");
    const workspaceRoot = path.join(tmpDir, "workspaces");
    const wsToKeep = path.join(workspaceRoot, "platform-web", "run-fresh");
    const wsToDelete = path.join(workspaceRoot, "platform-web", "run-old");
    fs.mkdirSync(wsToKeep, { recursive: true });
    fs.mkdirSync(wsToDelete, { recursive: true });
    fs.writeFileSync(path.join(wsToKeep, "keep.txt"), "k".repeat(2048));
    fs.writeFileSync(path.join(wsToDelete, "stale.txt"), "s".repeat(4096));

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const validateWorkflow = vi.fn(async () => ({
      tracker: {
        kind: "gitlab",
        baseUrl: "https://gitlab.example.com",
        projectId: "platform-web",
        tokenEnv: "GITLAB_TOKEN",
        activeLabels: ["ai-ready"],
        runningLabel: "ai-running",
        handoffLabel: "human-review",
        failedLabel: "ai-failed",
        blockedLabel: "ai-blocked",
        reworkLabel: "ai-rework",
        mergingLabel: "ai-merging",
      },
      workspace: {
        root: workspaceRoot,
        strategy: "worktree",
        repoCacheRoot: path.join(tmpDir, "repos"),
      },
      git: {
        repoUrl: "git@example.com:platform-web.git",
        baseBranch: "main",
        branchPrefix: "ai",
      },
      agent: {
        runner: "codex-app-server",
        maxConcurrentAgents: 1,
        maxTurns: 3,
        maxAttempts: 2,
        retryBackoffMs: 1000,
      },
      codex: {
        command: "codex app-server",
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 60_000,
        turnSandboxPolicy: { type: "workspaceWrite" },
      },
      hooks: {},
      ci: { enabled: false, onFailure: "ai-rework", waitForPipeline: true },
      retention: {
        successfulRunDays: 7,
        failedRunDays: 30,
        maxWorkspaceGb: 50,
        cleanupIntervalMs: 60_000,
      },
      pollIntervalMs: 10_000,
      promptTemplate: "Fix {{ issue.title }}",
      source: {
        path: wfPath,
        sha256: "sha",
        loadedAt: new Date(0).toISOString(),
      },
    }));
    const cli = buildCli({ validateWorkflow });

    await cli.parseAsync(["doctor", "--workspace", "--workflow", wfPath], {
      from: "user",
    });

    const output = mockLog.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Workspace cleanup dry-run");
    expect(output).toMatch(/entries:\s*2/);
    expect(output).toMatch(/will delete:\s*0/); // both fresh, no run records
    // Dry-run never deletes from disk.
    expect(fs.existsSync(wsToKeep)).toBe(true);
    expect(fs.existsSync(wsToDelete)).toBe(true);
    expect(process.exitCode).toBe(0);
    mockLog.mockRestore();
  });

  it("dashboard starts with configured port and API URL", async () => {
    const spawnDashboard = vi.fn(async () => ({
      wait: async () => undefined,
    }));
    const cli = buildCli({ spawnDashboard });

    await cli.parseAsync(
      ["dashboard", "--port", "3333", "--api-url", "http://127.0.0.1:4738"],
      { from: "user" },
    );

    expect(spawnDashboard).toHaveBeenCalledWith({
      port: 3333,
      host: "127.0.0.1",
      apiUrl: "http://127.0.0.1:4738",
    });
  });

  it("dashboard rejects invalid port", async () => {
    const spawnDashboard = vi.fn(async () => ({
      wait: async () => undefined,
    }));
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli({ spawnDashboard });

    await cli.parseAsync(["dashboard", "--port", "70000"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    expect(spawnDashboard).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("invalid port"),
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("run fails for missing workflow", async () => {
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli();

    await cli.parseAsync(["run", "--workflow", "/nonexistent/wf.md"], {
      from: "user",
    });

    expect(process.exitCode).toBe(1);
    mockError.mockRestore();
    process.exitCode = 0;
  });

  it("run starts for valid workflow", async () => {
    const wfPath = path.join(tmpDir, "wf.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const startDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      state: {} as never,
      stop: async () => undefined,
      wait: async () => undefined,
    }));
    const cli = buildCli({ startDaemon });

    await cli.parseAsync(["run", "--workflow", wfPath], { from: "user" });

    expect(startDaemon).toHaveBeenCalledWith({
      workflowPath: wfPath,
      port: 4738,
      host: "127.0.0.1",
    });
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining("daemon ready"),
    );
    mockLog.mockRestore();
  });

  it("run defaults to ./WORKFLOW.md when --workflow is omitted", async () => {
    const originalCwd = process.cwd();
    const wfPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const startDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      state: {} as never,
      stop: async () => undefined,
      wait: async () => undefined,
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ startDaemon });

    try {
      process.chdir(tmpDir);
      await cli.parseAsync(["run"], { from: "user" });
    } finally {
      process.chdir(originalCwd);
      mockLog.mockRestore();
    }

    expect(startDaemon).toHaveBeenCalledWith({
      workflowPath: wfPath,
      port: 4738,
      host: "127.0.0.1",
    });
  });

  it("run defaults to ./issuepilot.team.yaml when present", async () => {
    const originalCwd = process.cwd();
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
    );

    const startTeamDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      stop: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ startTeamDaemon });

    try {
      process.chdir(tmpDir);
      await cli.parseAsync(["run"], { from: "user" });
    } finally {
      process.chdir(originalCwd);
      mockLog.mockRestore();
    }

    expect(startTeamDaemon).toHaveBeenCalledWith({ configPath });
  });

  it("run starts team daemon when --config is provided", async () => {
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
    );
    const wait = vi.fn(async () => {});
    const startTeamDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      stop: vi.fn(async () => {}),
      wait,
    }));
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const cli = buildCli({ startTeamDaemon });

    await cli.parseAsync(["run", "--config", configPath], { from: "user" });

    // Without an explicit --host/--port the CLI must not override the values
    // in issuepilot.team.yaml; assert only configPath is forwarded.
    expect(startTeamDaemon).toHaveBeenCalledWith({ configPath });
    expect(mockLog).toHaveBeenCalledWith(
      "IssuePilot team daemon ready: http://127.0.0.1:4738",
    );
    expect(wait).toHaveBeenCalled();
    mockLog.mockRestore();
  });

  it("run forwards explicit --port/--host to startTeamDaemon as overrides", async () => {
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(
      configPath,
      [
        "version: 1",
        "projects:",
        "  - id: platform-web",
        "    name: Platform Web",
        "    project: ./projects/platform-web.yaml",
        "    workflow_profile: ./workflows/default-web.md",
      ].join("\n"),
    );
    const wait = vi.fn(async () => {});
    const startTeamDaemon = vi.fn(async () => ({
      host: "0.0.0.0",
      port: 9999,
      url: "http://0.0.0.0:9999",
      stop: vi.fn(async () => {}),
      wait,
    }));
    const cli = buildCli({ startTeamDaemon });
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await cli.parseAsync(
      ["run", "--config", configPath, "--host", "0.0.0.0", "--port", "9999"],
      { from: "user" },
    );

    expect(startTeamDaemon).toHaveBeenCalledWith({
      configPath,
      host: "0.0.0.0",
      port: 9999,
    });
    mockLog.mockRestore();
  });

  it("run rejects passing --workflow and --config together", async () => {
    const configPath = path.join(tmpDir, "issuepilot.team.yaml");
    fs.writeFileSync(configPath, "version: 1\nprojects: []\n");
    const wfPath = path.join(tmpDir, "WORKFLOW.md");
    fs.writeFileSync(wfPath, "---\ntitle: test\n---\n");

    const startDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      state: {} as never,
      stop: async () => undefined,
      wait: async () => undefined,
    }));
    const startTeamDaemon = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 4738,
      url: "http://127.0.0.1:4738",
      stop: async () => undefined,
      wait: async () => undefined,
    }));
    const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
    const cli = buildCli({ startDaemon, startTeamDaemon });

    await cli.parseAsync(
      ["run", "--workflow", wfPath, "--config", configPath],
      { from: "user" },
    );

    expect(process.exitCode).toBe(1);
    expect(startDaemon).not.toHaveBeenCalled();
    expect(startTeamDaemon).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalledWith(
      "Error: --workflow and --config cannot be used together",
    );
    mockError.mockRestore();
    process.exitCode = 0;
  });

  describe("auth subcommands", () => {
    it("auth login forwards hostname/scope/client-id to authLogin", async () => {
      const authLogin = vi.fn(async () => ({}));
      const cli = buildCli({ authLogin });
      await cli.parseAsync(
        [
          "auth",
          "login",
          "--hostname",
          "gitlab.example.com",
          "--scope",
          "api read_repository",
          "--client-id",
          "test-client",
        ],
        { from: "user" },
      );
      expect(authLogin).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
        scope: ["api", "read_repository"],
        clientId: "test-client",
      });
    });

    it("auth status forwards hostname filter to authStatus", async () => {
      const authStatus = vi.fn(async () => ({}));
      const cli = buildCli({ authStatus });
      await cli.parseAsync(
        ["auth", "status", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(authStatus).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
      });
    });

    it("auth logout forwards hostname or --all", async () => {
      const authLogout = vi.fn(async () => ({}));
      const cli = buildCli({ authLogout });
      await cli.parseAsync(
        ["auth", "logout", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(authLogout).toHaveBeenCalledWith({
        hostname: "gitlab.example.com",
      });

      authLogout.mockClear();
      const cli2 = buildCli({ authLogout });
      await cli2.parseAsync(["auth", "logout", "--all"], { from: "user" });
      expect(authLogout).toHaveBeenCalledWith({ all: true });
    });

    it("auth login surfaces non-zero exit code on failure", async () => {
      const authLogin = vi.fn(async () => {
        throw new Error("boom");
      });
      const mockError = vi.spyOn(console, "error").mockImplementation(() => {});
      const cli = buildCli({ authLogin });
      await cli.parseAsync(
        ["auth", "login", "--hostname", "gitlab.example.com"],
        { from: "user" },
      );
      expect(process.exitCode).toBe(1);
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("auth login failed"),
      );
      mockError.mockRestore();
      process.exitCode = 0;
    });
  });
});
