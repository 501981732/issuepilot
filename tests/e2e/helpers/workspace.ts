/**
 * Shared E2E workspace setup: bare repo + fake GitLab + workflow file +
 * fake-codex script. Keeps the test files focused on assertions.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGitLabState,
  seedGitLabState,
  type GitLabFakeState,
  type SeedIssueInput,
} from "../fakes/gitlab/data.js";
import {
  startGitLabFakeServer,
  type GitLabFakeServer,
} from "../fakes/gitlab/server.js";
import { createFakeBareRepo, type FakeBareRepo } from "../fakes/git/repo.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "fixtures");
const TSX_BIN = resolve(HERE, "..", "node_modules", ".bin", "tsx");
const FAKE_CODEX_MAIN = resolve(HERE, "..", "fakes", "codex", "main.ts");

export const E2E_TOKEN = "glpat-fake-e2e-token";

export interface E2EWorkspace {
  tmpRoot: string;
  workspaceRoot: string;
  repoCacheRoot: string;
  workflowPath: string;
  codexScriptPath: string;
  bareRepo: FakeBareRepo;
  gitlabServer: GitLabFakeServer;
  gitlabState: GitLabFakeState;
  projectId: string;
  cleanup: () => Promise<void>;
}

export interface CreateE2EWorkspaceOptions {
  projectId?: string;
  issues?: SeedIssueInput[];
  codexScriptFixture: string;
  workflowTemplate?: string;
  /**
   * Override `agent.max_attempts` in the rendered workflow. Defaults to `1`
   * to match the spec §6 example. Tests that exercise the retry loop should
   * bump this to `2` or higher.
   */
  maxAttempts?: number;
  /**
   * Override `codex.turn_timeout_ms` in the rendered workflow. Defaults to
   * 15 000 ms. Tests that synthetically time out a turn (to drive the retry
   * path) want a much smaller value (~500 ms) so the e2e finishes quickly.
   */
  turnTimeoutMs?: number;
  /**
   * Enable the V2 Phase 3 CI feedback scanner. Defaults to `false` so
   * happy-path / blocked-and-failed e2e tests don't accidentally start
   * polling pipelines.
   */
  ciEnabled?: boolean;
  /**
   * Override `ci.on_failure`. Only meaningful when `ciEnabled` is true.
   * Defaults to `"ai-rework"`.
   */
  ciOnFailure?: "ai-rework" | "human-review";
  /**
   * Override `tracker.active_labels`. Defaults to `["ai-ready"]` to keep
   * the happy-path / CI feedback tests from accidentally re-claiming
   * recycled issues. The Phase 4 review feedback sweep e2e bumps this
   * to `["ai-ready", "ai-rework"]` so it can exercise the full
   * ai-rework → reclaim → prompt-injection loop.
   */
  activeLabels?: string[];
}

export async function createE2EWorkspace(
  opts: CreateE2EWorkspaceOptions,
): Promise<E2EWorkspace> {
  const projectId = opts.projectId ?? "demo/repo";
  const tmpRoot = mkdtempSync(join(tmpdir(), "issuepilot-e2e-"));
  const workspaceRoot = join(tmpRoot, "workspaces");
  const repoCacheRoot = join(tmpRoot, "repos");
  const promptsRoot = join(tmpRoot, "prompts");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(repoCacheRoot, { recursive: true });
  mkdirSync(promptsRoot, { recursive: true });
  writeFileSync(
    join(promptsRoot, "coder.md"),
    "Implement the task described by the issue and keep changes scoped.\n",
  );
  writeFileSync(
    join(promptsRoot, "reviewer.md"),
    "Review the task output and return structured reviewer findings.\n",
  );
  writeFileSync(
    join(promptsRoot, "test-evidence.md"),
    "Collect validation evidence for the completed task.\n",
  );

  const bareRepo = await createFakeBareRepo();
  const gitlabState = createGitLabState({ projectId });
  seedGitLabState(gitlabState, { issues: opts.issues ?? [] });
  const gitlabServer = await startGitLabFakeServer({
    state: gitlabState,
    token: E2E_TOKEN,
  });

  const codexScriptPath = join(tmpRoot, "codex-script.json");
  const fixtureScript = readFileSync(
    join(FIXTURES, opts.codexScriptFixture),
    "utf8",
  );
  writeFileSync(codexScriptPath, fixtureScript);

  // The daemon's `splitCommand` now understands single + double quotes, so
  // any path containing spaces (`HOME="/Users/User Name"` etc.) survives.
  // Surface a clear error for surprising whitespace classes that the
  // tokenizer doesn't yet handle (control chars), instead of letting the
  // daemon explode obscurely.
  for (const piece of [TSX_BIN, FAKE_CODEX_MAIN, codexScriptPath]) {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(piece)) {
      throw new Error(
        `createE2EWorkspace: command path contains control character: ${JSON.stringify(piece)}`,
      );
    }
  }

  const workflowPath = join(tmpRoot, "workflow.fake.md");
  const tplName = opts.workflowTemplate ?? "workflow.fake.md.tpl";
  const tpl = readFileSync(join(FIXTURES, tplName), "utf8");
  // The codex command must run `tsx <fake-main> <script>` as a single command
  // line; we quote each piece so spaces in paths are tolerated.
  const codexCmd = `${quote(TSX_BIN)} ${quote(FAKE_CODEX_MAIN)} ${quote(codexScriptPath)}`;
  const rendered = tpl
    .replaceAll("__GITLAB_URL__", gitlabServer.baseUrl)
    .replaceAll("__PROJECT_ID__", projectId)
    .replaceAll("__WORKSPACE_ROOT__", workspaceRoot)
    .replaceAll("__REPO_CACHE_ROOT__", repoCacheRoot)
    .replaceAll("__REPO_URL__", bareRepo.bareDir)
    .replaceAll("__CODEX_CMD__", codexCmd)
    .replaceAll("__MAX_ATTEMPTS__", String(opts.maxAttempts ?? 1))
    .replaceAll("__TURN_TIMEOUT_MS__", String(opts.turnTimeoutMs ?? 15_000))
    .replaceAll("__CI_ENABLED__", String(opts.ciEnabled ?? false))
    .replaceAll("__CI_ON_FAILURE__", opts.ciOnFailure ?? "ai-rework")
    .replaceAll(
      "__ACTIVE_LABELS__",
      JSON.stringify(opts.activeLabels ?? ["ai-ready"]),
    );
  writeFileSync(workflowPath, rendered);

  return {
    tmpRoot,
    workspaceRoot,
    repoCacheRoot,
    workflowPath,
    codexScriptPath,
    bareRepo,
    gitlabServer,
    gitlabState,
    projectId,
    async cleanup() {
      await gitlabServer.close();
      bareRepo.cleanup();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Conservative shell quoting that works for the simple paths we generate. */
function quote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
