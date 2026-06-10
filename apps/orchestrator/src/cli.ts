import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  compileCentralWorkflowProject as defaultCompileCentralWorkflowProject,
  type CompileCentralWorkflowProjectInput,
  type WorkflowConfig,
} from "@issuepilot/workflow";
import {
  enumerateWorkspaceEntries,
  planWorkspaceCleanup,
} from "@issuepilot/workspace";
import { Command } from "commander";
import { execaCommand } from "execa";
import * as YAML from "yaml";

import {
  authLogin,
  authLogout,
  authStatus,
  type AuthLoginDeps,
  type AuthLoginOptions,
  type AuthLogoutOptions,
  type AuthStatusOptions,
} from "./auth/index.js";
import {
  checkCodexAppServer,
  startDaemon,
  validateWorkflow,
  type DaemonHandle,
} from "./daemon.js";
import {
  startDashboard,
  type DashboardHandle,
  type DashboardOptions,
} from "./dashboard.js";
import {
  loadTeamConfig as defaultLoadTeamConfig,
  type TeamConfig,
} from "./team/config.js";
import {
  startTeamDaemon,
  type StartTeamDaemonOptions,
  type TeamDaemonHandle,
} from "./team/daemon.js";
import { PACKAGE_VERSION } from "./version.js";

export interface CliDeps {
  version?: string | undefined;
  startDaemon?: typeof startDaemon | undefined;
  startTeamDaemon?:
    | ((opts: StartTeamDaemonOptions) => Promise<TeamDaemonHandle>)
    | undefined;
  validateWorkflow?: typeof validateWorkflow | undefined;
  loadTeamConfig?: ((path: string) => Promise<TeamConfig>) | undefined;
  compileCentralWorkflowProject?:
    | ((input: CompileCentralWorkflowProjectInput) => Promise<WorkflowConfig>)
    | undefined;
  checkCodexAppServer?: typeof checkCodexAppServer | undefined;
  spawnDashboard?:
    | ((opts: DashboardOptions) => Promise<DashboardHandle>)
    | undefined;
  execaCommand?: typeof execaCommand | undefined;
  authLogin?:
    | ((opts: AuthLoginOptions, deps?: AuthLoginDeps) => Promise<unknown>)
    | undefined;
  authStatus?: ((opts: AuthStatusOptions) => Promise<unknown>) | undefined;
  authLogout?: ((opts: AuthLogoutOptions) => Promise<unknown>) | undefined;
}

function parsePort(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const port = Number(value);
  if (port > 65_535) return null;
  return port;
}

interface ResolvedWorkflowPath {
  path: string;
  warning?: string;
}

interface ResolvedTeamConfigPath {
  path: string;
  explicit: boolean;
}

/**
 * Render a compiled {@link WorkflowConfig} as YAML for `render-workflow`.
 *
 * Drops anything sensitive (`tracker.tokenEnv`, `source.sha256`, runtime
 * timestamps) so the rendered text is safe to paste into review tickets
 * or diff against a previous render. Includes `hooks`, `retention`, and
 * the full `prompt_template` block — operators reviewing a compiled
 * workflow specifically need to see the shell commands and Codex prompt
 * that will execute. Field naming mirrors the YAML keys an operator
 * would write in `workflows/*.md`.
 */
function renderWorkflowYaml(workflow: WorkflowConfig): string {
  // Strip undefined hook keys so YAML output stays compact for workflows
  // that don't define every hook stage.
  const hooks: Record<string, string> = {};
  if (workflow.hooks.afterCreate)
    hooks.after_create = workflow.hooks.afterCreate;
  if (workflow.hooks.beforeRun) hooks.before_run = workflow.hooks.beforeRun;
  if (workflow.hooks.afterRun) hooks.after_run = workflow.hooks.afterRun;

  return YAML.stringify(
    {
      tracker: {
        kind: workflow.tracker.kind,
        base_url: workflow.tracker.baseUrl,
        project_id: workflow.tracker.projectId,
        active_labels: workflow.tracker.activeLabels,
        running_label: workflow.tracker.runningLabel,
        handoff_label: workflow.tracker.handoffLabel,
        failed_label: workflow.tracker.failedLabel,
        blocked_label: workflow.tracker.blockedLabel,
        rework_label: workflow.tracker.reworkLabel,
        merging_label: workflow.tracker.mergingLabel,
      },
      workspace: {
        root: workflow.workspace.root,
        strategy: workflow.workspace.strategy,
        repo_cache_root: workflow.workspace.repoCacheRoot,
      },
      git: {
        repo_url: workflow.git.repoUrl,
        base_branch: workflow.git.baseBranch,
        branch_prefix: workflow.git.branchPrefix,
      },
      agent: {
        runner: workflow.agent.runner,
        max_concurrent_agents: workflow.agent.maxConcurrentAgents,
        max_turns: workflow.agent.maxTurns,
        max_attempts: workflow.agent.maxAttempts,
        retry_backoff_ms: workflow.agent.retryBackoffMs,
      },
      codex: {
        command: workflow.codex.command,
        approval_policy: workflow.codex.approvalPolicy,
        thread_sandbox: workflow.codex.threadSandbox,
        turn_timeout_ms: workflow.codex.turnTimeoutMs,
        turn_sandbox_policy: workflow.codex.turnSandboxPolicy,
      },
      ci: {
        enabled: workflow.ci.enabled,
        on_failure: workflow.ci.onFailure,
        wait_for_pipeline: workflow.ci.waitForPipeline,
      },
      retention: {
        successful_run_days: workflow.retention.successfulRunDays,
        failed_run_days: workflow.retention.failedRunDays,
        max_workspace_gb: workflow.retention.maxWorkspaceGb,
        cleanup_interval_ms: workflow.retention.cleanupIntervalMs,
      },
      hooks,
      poll_interval_ms: workflow.pollIntervalMs,
      prompt_template: workflow.promptTemplate,
    },
    // `blockScalar: "literal"` keeps the prompt template as a `|` block
    // so newlines / Liquid `{% %}` blocks render as written; `lineWidth: 0`
    // disables auto-wrapping so we never split a prompt line mid-token.
    { blockQuote: "literal", lineWidth: 0 },
  );
}

function resolveWorkflowPath(
  input: unknown,
  cwd = process.cwd(),
): ResolvedWorkflowPath {
  if (typeof input === "string" && input.trim().length > 0) {
    return { path: path.resolve(input) };
  }

  const rootWorkflow = path.resolve(cwd, "WORKFLOW.md");
  if (fs.existsSync(rootWorkflow)) return { path: rootWorkflow };

  const legacyWorkflow = path.resolve(cwd, ".agents", "workflow.md");
  if (fs.existsSync(legacyWorkflow)) {
    return {
      path: legacyWorkflow,
      warning:
        "Warning: .agents/workflow.md is deprecated as a default workflow path; move it to WORKFLOW.md or pass --workflow explicitly.",
    };
  }

  return { path: rootWorkflow };
}

function resolveTeamConfigPath(
  input: unknown,
  cwd = process.cwd(),
): ResolvedTeamConfigPath | null {
  if (typeof input === "string" && input.trim().length > 0) {
    return { path: path.resolve(cwd, input), explicit: true };
  }

  const rootConfig = path.resolve(cwd, "issuepilot.team.yaml");
  if (fs.existsSync(rootConfig)) return { path: rootConfig, explicit: false };

  return null;
}

export function buildCli(deps: CliDeps = {}): Command {
  const daemonStarter = deps.startDaemon ?? startDaemon;
  const teamDaemonStarter = deps.startTeamDaemon ?? startTeamDaemon;
  const workflowValidator = deps.validateWorkflow ?? validateWorkflow;
  const codexCheck = deps.checkCodexAppServer ?? checkCodexAppServer;
  const dashboardStarter = deps.spawnDashboard ?? startDashboard;
  const runExecaCommand = deps.execaCommand ?? execaCommand;
  const authLoginImpl = deps.authLogin ?? authLogin;
  const authStatusImpl = deps.authStatus ?? authStatus;
  const authLogoutImpl = deps.authLogout ?? authLogout;

  const program = new Command("issuepilot")
    .description("IssuePilot — AI-driven GitLab issue orchestrator")
    .version(deps.version ?? PACKAGE_VERSION);

  program
    .command("dashboard")
    .description("Start the local read-only dashboard")
    .option("--port <number>", "Dashboard port", "3000")
    .option("--host <host>", "Dashboard bind host", "127.0.0.1")
    .option("--api-url <url>", "Orchestrator API URL", "http://127.0.0.1:4738")
    .action(async (opts) => {
      const port = parsePort(opts.port);
      if (port === null) {
        console.error(`Error: invalid port: ${opts.port}`);
        process.exitCode = 1;
        return;
      }
      const host = typeof opts.host === "string" ? opts.host.trim() : "";
      if (!host) {
        console.error("Error: --host must not be empty");
        process.exitCode = 1;
        return;
      }
      const apiUrl = typeof opts.apiUrl === "string" ? opts.apiUrl.trim() : "";
      if (!apiUrl) {
        console.error("Error: --api-url must not be empty");
        process.exitCode = 1;
        return;
      }
      let handle: DashboardHandle;
      try {
        handle = await dashboardStarter({ port, host, apiUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: failed to start dashboard: ${message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`IssuePilot dashboard ready: http://${host}:${port}`);
      await handle.wait();
    });

  program
    .command("run")
    .description("Start the orchestrator daemon")
    .option("--workflow <path>", "Path to legacy single-project workflow file")
    .option(
      "--config <path>",
      "Path to team config file (defaults to ./issuepilot.team.yaml when present)",
    )
    .option(
      "--port <number>",
      "HTTP API port (default 4738; team mode falls back to issuepilot.team.yaml server.port)",
    )
    .option(
      "--host <host>",
      "HTTP API bind address (default 127.0.0.1; team mode falls back to issuepilot.team.yaml server.host; use 0.0.0.0 for container/remote smoke runs)",
    )
    .action(async (opts) => {
      if (
        typeof opts.workflow === "string" &&
        opts.workflow.length > 0 &&
        typeof opts.config === "string" &&
        opts.config.length > 0
      ) {
        console.error("Error: --workflow and --config cannot be used together");
        process.exitCode = 1;
        return;
      }

      let explicitPort: number | undefined;
      if (typeof opts.port === "string" && opts.port.length > 0) {
        const parsed = parsePort(opts.port);
        if (parsed === null) {
          console.error(`Error: invalid port: ${opts.port}`);
          process.exitCode = 1;
          return;
        }
        explicitPort = parsed;
      }

      let explicitHost: string | undefined;
      if (typeof opts.host === "string") {
        const trimmed = opts.host.trim();
        if (!trimmed) {
          console.error("Error: --host must not be empty");
          process.exitCode = 1;
          return;
        }
        explicitHost = trimmed;
      }

      const resolvedTeamConfig =
        typeof opts.workflow === "string" && opts.workflow.length > 0
          ? null
          : resolveTeamConfigPath(opts.config);
      if (resolvedTeamConfig) {
        const configPath = resolvedTeamConfig.path;
        if (!fs.existsSync(configPath)) {
          console.error(`Error: team config file not found: ${configPath}`);
          process.exitCode = 1;
          return;
        }
        // In team mode we only forward explicit CLI overrides so the
        // `issuepilot.team.yaml` `server: { host, port }` block remains
        // authoritative when no flag is passed.
        const teamOpts: StartTeamDaemonOptions = { configPath };
        if (explicitPort !== undefined) teamOpts.port = explicitPort;
        if (explicitHost !== undefined) teamOpts.host = explicitHost;
        let teamHandle: TeamDaemonHandle;
        try {
          teamHandle = await teamDaemonStarter(teamOpts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error: failed to start team daemon: ${message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`IssuePilot team daemon ready: ${teamHandle.url}`);
        await teamHandle.wait();
        return;
      }

      const resolvedWorkflow = resolveWorkflowPath(opts.workflow);
      if (resolvedWorkflow.warning) console.warn(resolvedWorkflow.warning);
      const workflowPath = resolvedWorkflow.path;
      if (!fs.existsSync(workflowPath)) {
        console.error(`Error: workflow file not found: ${workflowPath}`);
        process.exitCode = 1;
        return;
      }
      let handle: DaemonHandle;
      try {
        // V1 single-workflow mode has no yaml host/port to fall back to, so we
        // keep the original built-in defaults to preserve V1 release contracts.
        handle = await daemonStarter({
          workflowPath,
          port: explicitPort ?? 4738,
          host: explicitHost ?? "127.0.0.1",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: failed to start daemon: ${message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`IssuePilot daemon ready: ${handle.url}`);
      await handle.wait();
    });

  program
    .command("validate")
    .description(
      "Validate workflow or team config (preflight before `run`).\n" +
        "Defaults to ./issuepilot.team.yaml when present, then ./WORKFLOW.md. Pass --config or --workflow to choose explicitly.",
    )
    .option("--workflow <path>", "Path to legacy single-project workflow file")
    .option("--config <path>", "Path to issuepilot.team.yaml")
    .action(async (opts) => {
      if (opts.config && opts.workflow) {
        console.error(
          "Error: --config and --workflow are mutually exclusive; pass only one.",
        );
        process.exitCode = 1;
        return;
      }
      const resolvedTeamConfig = opts.workflow
        ? null
        : resolveTeamConfigPath(opts.config);
      if (resolvedTeamConfig) {
        const configPath = resolvedTeamConfig.path;
        if (!fs.existsSync(configPath)) {
          console.error(`Error: team config file not found: ${configPath}`);
          process.exitCode = 1;
          return;
        }
        try {
          const loader = deps.loadTeamConfig ?? defaultLoadTeamConfig;
          const cfg = await loader(configPath);
          const enabled = cfg.projects.filter((p) => p.enabled);
          const disabled = cfg.projects.filter((p) => !p.enabled);
          console.log(`Team config loaded: ${cfg.source.path}`);
          console.log(`Version: ${cfg.version}`);
          console.log(
            `Scheduler: max=${cfg.scheduler.maxConcurrentRuns}, perProject=${cfg.scheduler.maxConcurrentRunsPerProject}, leaseTtlMs=${cfg.scheduler.leaseTtlMs}`,
          );
          console.log(
            `Projects: ${cfg.projects.length} (${enabled.length} enabled, ${disabled.length} disabled)`,
          );
          for (const p of cfg.projects) {
            const flag = p.enabled ? "enabled " : "disabled";
            console.log(`  - [${flag}] ${p.id}`);
            console.log(`    project=${p.projectPath}`);
            console.log(`    profile=${p.workflowProfilePath}`);
          }
          console.log("Team validation passed.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Team validation failed: ${message}`);
          process.exitCode = 1;
        }
        return;
      }
      const resolvedWorkflow = resolveWorkflowPath(opts.workflow);
      if (resolvedWorkflow.warning) console.warn(resolvedWorkflow.warning);
      const workflowPath = resolvedWorkflow.path;
      if (!fs.existsSync(workflowPath)) {
        console.error(`Error: workflow file not found: ${workflowPath}`);
        process.exitCode = 1;
        return;
      }
      try {
        const workflow = await workflowValidator(workflowPath);
        console.log(`Workflow loaded: ${workflow.source.path}`);
        console.log(`GitLab project: ${workflow.tracker.projectId}`);
        console.log("Validation passed.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Validation failed: ${message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("render-workflow")
    .description(
      "Render one effective workflow from issuepilot.team.yaml.\n" +
        "Compiles the project file + workflow profile and prints the result " +
        "as YAML for diffing / review. Never prints token env names or other " +
        "secrets.",
    )
    .requiredOption("--config <path>", "Path to issuepilot.team.yaml")
    .requiredOption("--project <id>", "Team project id")
    .action(async (opts) => {
      const configPath = path.resolve(String(opts.config));
      if (!fs.existsSync(configPath)) {
        console.error(`Error: team config file not found: ${configPath}`);
        process.exitCode = 1;
        return;
      }
      const loader = deps.loadTeamConfig ?? defaultLoadTeamConfig;
      const compile =
        deps.compileCentralWorkflowProject ??
        defaultCompileCentralWorkflowProject;
      let cfg: TeamConfig;
      try {
        cfg = await loader(configPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: failed to load team config: ${message}`);
        process.exitCode = 1;
        return;
      }
      const project = cfg.projects.find((p) => p.id === String(opts.project));
      if (!project) {
        console.error(
          `Error: project not found in team config: ${String(opts.project)}`,
        );
        process.exitCode = 1;
        return;
      }
      const generatedSourcePath = path.join(
        path.dirname(cfg.source.path),
        ".generated",
        `${project.id}.workflow.md`,
      );
      let workflow: WorkflowConfig;
      try {
        workflow = await compile({
          projectId: project.id,
          projectPath: project.projectPath,
          workflowProfilePath: project.workflowProfilePath,
          defaults: cfg.defaults,
          generatedSourcePath,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: failed to render workflow: ${message}`);
        process.exitCode = 1;
        return;
      }
      console.log(renderWorkflowYaml(workflow));
    });

  program
    .command("doctor")
    .description(
      "Check system prerequisites; pass --workspace --workflow <path> for a workspace-cleanup dry-run.",
    )
    .option(
      "--workspace",
      "Run the V2 Phase 5 workspace-cleanup planner in dry-run mode",
    )
    .option(
      "--workflow <path>",
      "Workflow file backing the dry-run (required with --workspace)",
    )
    .action(async (opts) => {
      if (opts.workspace === true) {
        const resolvedWorkflow = resolveWorkflowPath(opts.workflow);
        if (resolvedWorkflow.warning) console.warn(resolvedWorkflow.warning);
        const workflowPath = resolvedWorkflow.path;
        if (!fs.existsSync(workflowPath)) {
          console.error(`Error: workflow file not found: ${workflowPath}`);
          process.exitCode = 1;
          return;
        }
        try {
          const workflow = await workflowValidator(workflowPath);
          const enumeration = await enumerateWorkspaceEntries({
            workspaceRoot: workflow.workspace.root,
            // Dry-run cannot consult RuntimeState (no daemon is running),
            // so every directory shows up as `unknown` and the planner
            // refuses to delete it. That is the safest default for a
            // doctor command; operators that want a real preview should
            // tail `workspace_cleanup_planned` events instead.
            lookupRun: () => undefined,
          });
          const plan = planWorkspaceCleanup({
            entries: enumeration.entries,
            retention: workflow.retention,
            now: new Date(),
            errors: enumeration.errors,
          });
          const totalGb = (plan.totalBytes / 1024 ** 3).toFixed(3);
          const retainGb = (plan.retainBytes / 1024 ** 3).toFixed(0);
          console.log(`Workspace cleanup dry-run`);
          console.log(`  workspace root: ${workflow.workspace.root}`);
          console.log(`  entries: ${enumeration.entries.length}`);
          console.log(
            `  total usage: ${totalGb} GB (cap ${retainGb} GB${plan.totalBytes > plan.retainBytes ? ", OVER" : ""})`,
          );
          console.log(`  will delete: ${plan.delete.length}`);
          console.log(
            `  keep failure markers: ${plan.keepFailureMarkers.length}`,
          );
          if (plan.errors.length > 0) {
            console.log(`  errors: ${plan.errors.length}`);
            for (const err of plan.errors) {
              console.log(`    [WARN] ${err.workspacePath}: ${err.reason}`);
            }
          }
          for (const entry of plan.delete) {
            console.log(`    [${entry.reason}] ${entry.workspacePath}`);
          }
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Workspace cleanup dry-run failed: ${message}`);
          process.exitCode = 1;
          return;
        }
      }
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

      const nodeVersion = process.version;
      const major = parseInt(nodeVersion.slice(1), 10);
      checks.push({
        name: "Node.js",
        ok: major >= 22,
        detail: `${nodeVersion} (require >=22)`,
      });

      try {
        const { stdout } = await runExecaCommand("git --version");
        checks.push({ name: "git", ok: true, detail: stdout.trim() });
      } catch {
        checks.push({ name: "git", ok: false, detail: "not found" });
      }

      try {
        const detail = await codexCheck();
        checks.push({ name: "codex app-server", ok: true, detail });
      } catch {
        checks.push({
          name: "codex app-server",
          ok: false,
          detail: "not found",
        });
      }

      const stateDir = path.join(os.homedir(), ".issuepilot", "state");
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        const testFile = path.join(stateDir, ".write-test");
        fs.writeFileSync(testFile, "test");
        fs.unlinkSync(testFile);
        checks.push({ name: "state dir", ok: true, detail: stateDir });
      } catch {
        checks.push({
          name: "state dir",
          ok: false,
          detail: `cannot write to ${stateDir}`,
        });
      }

      const allOk = checks.every((c) => c.ok);
      for (const c of checks) {
        const icon = c.ok ? "OK" : "FAIL";
        console.log(`[${icon}] ${c.name}: ${c.detail}`);
      }

      if (!allOk) {
        process.exitCode = 1;
      }
    });

  const authCommand = program
    .command("auth")
    .description(
      "Manage GitLab credentials via OAuth 2.0 Device Authorization Grant",
    );

  authCommand
    .command("login")
    .description("Run the OAuth Device Flow and persist the resulting token")
    .requiredOption(
      "--hostname <host>",
      "GitLab hostname, e.g. gitlab.example.com",
    )
    .option(
      "--scope <scopes>",
      "Space-separated OAuth scopes (default: api read_repository write_repository)",
    )
    .option(
      "--client-id <id>",
      "GitLab OAuth Application ID / client_id (default: issuepilot-cli)",
    )
    .option(
      "--base-url <url>",
      "Override base URL (default: https://<hostname>)",
    )
    .action(async (opts) => {
      const loginOpts: AuthLoginOptions = { hostname: String(opts.hostname) };
      if (typeof opts.scope === "string" && opts.scope.length > 0) {
        loginOpts.scope = opts.scope.split(/\s+/).filter(Boolean);
      }
      if (typeof opts.clientId === "string" && opts.clientId.length > 0) {
        loginOpts.clientId = opts.clientId;
      }
      if (typeof opts.baseUrl === "string" && opts.baseUrl.length > 0) {
        loginOpts.baseUrl = opts.baseUrl;
      }
      try {
        await authLoginImpl(loginOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth login failed: ${message}`);
        process.exitCode = 1;
      }
    });

  authCommand
    .command("status")
    .description("Show stored credentials and their token expiry")
    .option("--hostname <host>", "Filter by hostname")
    .action(async (opts) => {
      const statusOpts: AuthStatusOptions = {};
      if (typeof opts.hostname === "string" && opts.hostname.length > 0) {
        statusOpts.hostname = opts.hostname;
      }
      try {
        await authStatusImpl(statusOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth status failed: ${message}`);
        process.exitCode = 1;
      }
    });

  authCommand
    .command("logout")
    .description("Remove stored credentials")
    .option("--hostname <host>", "Hostname to remove")
    .option("--all", "Wipe credentials for every host")
    .action(async (opts) => {
      const logoutOpts: AuthLogoutOptions = {};
      if (typeof opts.hostname === "string" && opts.hostname.length > 0) {
        logoutOpts.hostname = opts.hostname;
      }
      if (opts.all === true) logoutOpts.all = true;
      try {
        await authLogoutImpl(logoutOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`auth logout failed: ${message}`);
        process.exitCode = 1;
      }
    });

  return program;
}
