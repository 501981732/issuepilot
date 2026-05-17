# IssuePilot User Guide

English | [简体中文](./USAGE.zh-CN.md)

This guide is for **engineers running IssuePilot for the first time**. The
goal: turn a single GitLab Issue into a branch, a Merge Request and an Issue
note automatically, then scale a single shared machine up to multiple GitLab
projects with CI / review feedback and workspace cleanup wired in.

> **Versions covered**: V1 single-project local loop + V2 team-operable
> release (Phase 1–5 merged into main).
> **Maintenance**: top-level bilingual entry; keep in sync with
> [`USAGE.zh-CN.md`](./USAGE.zh-CN.md).

Visual versions:

- Architecture: [`docs/superpowers/diagrams/v2-architecture.svg`](./docs/superpowers/diagrams/v2-architecture.svg)
- End-to-end flow: [`docs/superpowers/diagrams/v2-flow.svg`](./docs/superpowers/diagrams/v2-flow.svg)

---

## Table of contents

- [Part 1 — Overview](#part-1--overview)
  - [1.1 What IssuePilot does](#11-what-issuepilot-does)
  - [1.2 V1 single-project vs V2 team mode](#12-v1-single-project-vs-v2-team-mode)
  - [1.3 Repositories and directory roles](#13-repositories-and-directory-roles)
- [Part 2 — Quick walkthrough (~30 minutes)](#part-2--quick-walkthrough-30-minutes)
  - [2.1 Environment requirements](#21-environment-requirements)
  - [2.2 Install IssuePilot](#22-install-issuepilot)
  - [2.3 First-run checklist](#23-first-run-checklist)
- [Part 3 — Prepare the target GitLab project](#part-3--prepare-the-target-gitlab-project)
  - [3.1 Create workflow labels](#31-create-workflow-labels)
  - [3.2 SSH can push to the target project](#32-ssh-can-push-to-the-target-project)
  - [3.3 Author `WORKFLOW.md`](#33-author-workflowmd)
  - [3.4 Configure GitLab credentials](#34-configure-gitlab-credentials)
  - [3.5 Validate the config](#35-validate-the-config)
- [Part 4 — V1 single-project mode: personal dev machine](#part-4--v1-single-project-mode-personal-dev-machine)
  - [4.1 Start orchestrator + dashboard](#41-start-orchestrator--dashboard)
  - [4.2 Run the first Issue](#42-run-the-first-issue)
  - [4.3 What to do for each of the 6 label states](#43-what-to-do-for-each-of-the-6-label-states)
- [Part 5 — V2 team mode: shared machine + multiple projects](#part-5--v2-team-mode-shared-machine--multiple-projects)
  - [5.1 Central team config](#51-central-team-config)
  - [5.2 Validate, render, launch](#52-validate-render-launch)
  - [5.3 Phase 2 — Dashboard actions (retry / stop / archive)](#53-phase-2--dashboard-actions-retry--stop--archive)
  - [5.4 Phase 3 — CI status auto-flip](#54-phase-3--ci-status-auto-flip)
  - [5.5 Phase 4 — Review feedback sweep](#55-phase-4--review-feedback-sweep)
  - [5.6 Phase 5 — Workspace retention](#56-phase-5--workspace-retention)
  - [5.7 V4.1 Workflow Spine — plan a large issue end to end](#57-v41-workflow-spine--plan-a-large-issue-end-to-end)
  - [5.8 Current V2 boundaries and gaps](#58-current-v2-boundaries-and-gaps)
- [Part 6 — Day-2 operations and troubleshooting](#part-6--day-2-operations-and-troubleshooting)
  - [6.1 Where to look](#61-where-to-look)
  - [6.2 Forensics for failed / blocked runs](#62-forensics-for-failed--blocked-runs)
  - [6.3 FAQ](#63-faq)
- [Part 7 — Reference](#part-7--reference)
  - [7.1 CLI cheat sheet](#71-cli-cheat-sheet)
  - [7.2 HTTP API endpoints](#72-http-api-endpoints)
  - [7.3 Document map](#73-document-map)

---

## Part 1 — Overview

### 1.1 What IssuePilot does

IssuePilot is a local-first orchestrator that runs on a single dev machine or
a shared team machine. One complete cycle:

1. Polls GitLab and finds Issues labelled `ai-ready`.
2. Creates an isolated git worktree per Issue under `~/.issuepilot`.
3. Spawns `codex app-server` in that worktree to drive Codex.
4. Pushes the branch, opens or updates a Merge Request, writes a handoff note
   on the Issue.
5. Transitions the Issue label from `ai-running` to `human-review` /
   `ai-failed` / `ai-blocked`.
6. During `human-review`, periodically scans MR pipeline, reviewer comments,
   and prunes expired worktrees per retention policy (V2).
7. When a human merges the MR, IssuePilot writes a closing note, removes
   `human-review` and closes the Issue.

IssuePilot is not a SaaS, not a cluster, and **never auto-merges MRs**.

### 1.2 V1 single-project vs V2 team mode

| Dimension | V1 single-project | V2 team mode |
| --- | --- | --- |
| Best for | Personal machine, one daemon → one project | Shared machine, one daemon → many GitLab projects |
| Entry | `issuepilot run --workflow /path/to/WORKFLOW.md` | `issuepilot run --config /path/to/issuepilot.team.yaml` |
| Config source of truth | Per-project `WORKFLOW.md` in the business repo | Central `issuepilot-config/` directory: `issuepilot.team.yaml` + `projects/*.yaml` + `workflows/*.md` |
| Concurrency | Single run, one worktree | 1–5, global + per-project lease prevents duplicate claim |
| Dashboard actions | retry / stop / archive available | retry / stop / archive not yet wired (returns `503 actions_unavailable`) |
| CI feedback | ✅ | ✅ |
| Review feedback sweep | ✅ | ✅ |
| Workspace cleanup loop | ✅ | ⚠ `retention` schema parsed but cleanup loop not yet running (follow-up) |
| Dashboard project view | Single project | All projects listed in team config order |

The two entrypoints are **mutually exclusive**; passing both exits with an
error. They can coexist: in a team scenario where you want Phase 5 cleanup
right now, the fallback is to launch per-project V1 daemons.

### 1.3 Repositories and directory roles

```text
/path/to/issuepilot                       This repo. Build / package only here.
  pnpm release:pack                       Produces ./dist/release/issuepilot-*.tgz

/path/to/target-project                   The business repo Codex modifies.
  WORKFLOW.md                             V1 single-project entry: prompt + contract committed at the repo root.

/path/to/issuepilot-config                V2 team-mode entry (see §5.1).
  issuepilot.team.yaml                    Server / scheduler / projects roster.
  projects/<id>.yaml                      Per-project facts (tracker, git, optional agent overrides).
  workflows/<name>.md                     Reusable workflow profile (prompt + runtime guardrails).

~/.issuepilot/                            Local runtime state
  repos/                                  bare git mirror
  workspaces/<project>/<iid>/             one git worktree per Issue
  state/leases-*.json                     V2 lease store
  state/runs/                             run records (JSON)
  state/events/                           JSONL event store (one file per Issue)
  state/logs/issuepilot.log               pino structured log
  credentials                             OAuth tokens (0600)

Installed CLI
  issuepilot doctor                       environment self-check
  issuepilot validate                     validate workflow / team config
  issuepilot run --workflow ...           V1 single-project entry
  issuepilot run --config ...             V2 team-mode entry
  issuepilot dashboard                    launch the read-only dashboard (default :3000)
```

---

## Part 2 — Quick walkthrough (~30 minutes)

Shortest path from "installed nothing" to "first Issue in `human-review`".

### 2.1 Environment requirements

| Tool | Requirement |
| --- | --- |
| Node.js | `>=22 <23` |
| pnpm | `10.x` (via corepack) |
| Git | `>=2.40` |
| Codex CLI | Can run `codex app-server` and is signed in |
| GitLab | A test project with API / label / Issue / MR support |
| SSH key | Can push to the target project |

### 2.2 Install IssuePilot

Inside the **IssuePilot repo**:

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
issuepilot doctor
```

Expected: `doctor` reports `[OK]` for Node.js, Git, Codex app-server, and
`~/.issuepilot/state`.

> **Contributor fallback** (run from the source tree without global install):
> ```bash
> pnpm build
> pnpm exec issuepilot doctor
> pnpm exec issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
> ```

### 2.3 First-run checklist

```text
[ ] Part 3.1   6 workflow labels exist in the target GitLab project
[ ] Part 3.2   ssh -T succeeds against the GitLab host
[ ] Part 3.3   target-project root contains WORKFLOW.md (committed)
[ ] Part 3.4   OAuth logged in OR token environment variable exported
[ ] Part 3.5   issuepilot validate --workflow prints "Validation passed."
[ ] Part 4.1   Terminal A: issuepilot run --workflow ...; Terminal B: issuepilot dashboard
[ ] Part 4.2   Create a tiny Issue in GitLab and label it ai-ready
[ ] Part 4.2   In ~10s a run appears on dashboard; minutes later label flips to human-review
```

---

## Part 3 — Prepare the target GitLab project

These steps are all performed in the **target project** (the business repo
Codex modifies). One-time setup. §3.1, §3.2 and §3.4 apply to both V1 and
V2; §3.3 (`WORKFLOW.md` in the business repo) and §3.5 (`validate
--workflow`) are V1 single-project entries only — V2 team mode owns the
workflow centrally (see [§5.1](#51-central-team-config) and use `issuepilot
validate --config` instead).

### 3.1 Create workflow labels

| Label | Meaning |
| --- | --- |
| `ai-ready` | Candidate Issue; IssuePilot will claim it |
| `ai-running` | IssuePilot has claimed it, in progress |
| `human-review` | MR ready; awaiting human review |
| `ai-rework` | Human asked AI to take another pass |
| `ai-failed` | Run failed; needs human investigation |
| `ai-blocked` | Missing info / permission / secret |

### 3.2 SSH can push to the target project

`workflow.git.repo_url` should use SSH. IssuePilot's Git push uses your local
SSH key, not the GitLab API token.

```bash
ssh -T git@gitlab.example.com
# If your org has two GitLab instances, test both:
ssh -T git@gitlab.chehejia.com
ssh -T git@gitlabee.chehejia.com
```

### 3.3 Author `WORKFLOW.md`

Create `WORKFLOW.md` at the **root of the target project** and commit it to
the default branch.

```bash
cd /path/to/target-project
$EDITOR WORKFLOW.md
```

Minimum template:

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  active_labels:
    - ai-ready
    - ai-rework
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked
  rework_label: ai-rework

workspace:
  root: "~/.issuepilot/workspaces"
  strategy: worktree
  repo_cache_root: "~/.issuepilot/repos"

git:
  repo_url: "git@gitlab.example.com:group/project.git"
  base_branch: main
  branch_prefix: ai

agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 10
  max_attempts: 2
  retry_backoff_ms: 30000

codex:
  command: "codex app-server"
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: 3600000
  turn_sandbox_policy:
    type: workspaceWrite

poll_interval_ms: 10000
---

You are the AI engineer for this repository.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
URL: {{ issue.url }}

Description:
{{ issue.description }}

Requirements:

1. Read relevant code before editing.
2. Work only inside the provided workspace.
3. Implement the Issue description.
4. Commit changes and use `gitlab_create_merge_request` to open / update the MR.
5. Use `gitlab_create_issue_note` to post implementation, validation, risk and MR link back to the Issue.
6. Let the orchestrator transition the Issue to `human-review` on success.
7. If you lack info / permission / secret, call `gitlab_transition_labels` to set `ai-blocked` with reason.
```

Commit:

```bash
git add WORKFLOW.md
git commit -m "chore(issuepilot): add workflow"
git push origin main
```

Field cheat sheet:

| Field | How to fill |
| --- | --- |
| `tracker.kind` | always `gitlab`; do not write `gitlabee` |
| `tracker.base_url` | GitLab instance URL |
| `tracker.project_id` | project path or numeric ID |
| `tracker.token_env` | **only when using the env-token path**; value is a variable name, not a token value |
| `git.repo_url` | SSH clone URL of the target project |
| `git.base_branch` | MR target branch (usually `main`) |
| `agent.max_concurrent_agents` | start with `1`, ramp up only after it is stable |
| `codex.approval_policy` | P0 recommends `never` |
| `poll_interval_ms` | default 10000ms; smaller = faster reaction, more GitLab API load |

⚠ Workflow rejects `danger-full-access` / `dangerFullAccess` sandbox; never
write a plaintext token — everything is injected through env vars or OAuth
credentials.

### 3.4 Configure GitLab credentials

Pick one. Personal dev machines should use **OAuth**; CI or shared
environments should use **env-token**.

#### Path A: OAuth (recommended)

Prerequisite: an OAuth Application registered in each GitLab instance by an
admin.

- Entry: `https://<gitlab-host>/admin/applications`
- Name: `IssuePilot`
- Confidential: **unchecked** (must be a public application)
- Scopes: `api`, `read_repository`, `write_repository`
- Enable Device Authorization Grant if your GitLab exposes the toggle
- Save and copy the **Application ID**; this becomes `--client-id` below

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

After login the token lands in `~/.issuepilot/credentials` (`0600`). The
daemon auto-refreshes and retries once on 401. **When using OAuth, do not
set `tracker.token_env` in the workflow** — setting it makes IssuePilot
require that env var.

Multiple GitLab instances:

```bash
issuepilot auth login --hostname gitlab.chehejia.com --client-id <oauth-application-id>
issuepilot auth login --hostname gitlabee.chehejia.com --client-id <oauth-application-id>
```

#### Path B: Env-token

If you already have a PAT / Group Access Token / Project Access Token, the
workflow's `tracker` block **must** include `token_env`:

```yaml
tracker:
  base_url: "https://gitlab.chehejia.com"
  token_env: "GITLAB_TOKEN"

tracker:
  base_url: "https://gitlabee.chehejia.com"
  token_env: "GITLABEE_TOKEN"
```

Before starting the daemon:

```bash
export GITLAB_TOKEN="<gitlab.chehejia.com token>"
export GITLABEE_TOKEN="<gitlabee.chehejia.com token>"
```

Tokens must never appear in `WORKFLOW.md`, Issues, prompts or logs.

### 3.5 Validate the config

Validate without starting the daemon and without hitting GitLab:

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot validate --workflow "$WORKFLOW_PATH"
```

Expected:

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

Common failures:

| Error | Fix |
| --- | --- |
| `WorkflowConfigError: tracker` | Check workflow front matter field names and indentation |
| `WorkflowConfigError: tracker.token_env` | Workflow declares `token_env` but the env var is missing; either export it or drop `token_env` and use OAuth |
| `GitLabError(category="auth")` | Token wrong, expired, or OAuth credentials missing |
| `GitLabError(category="permission")` | Token lacks `api` scope or has no access to the project |

---

## Part 4 — V1 single-project mode: personal dev machine

### 4.1 Start orchestrator + dashboard

Two terminals.

**Terminal A — orchestrator:**

```bash
export WORKFLOW_PATH="/path/to/target-project/WORKFLOW.md"
issuepilot run --workflow "$WORKFLOW_PATH" --port 4738 --host 127.0.0.1
```

Once ready, the log prints `API: http://127.0.0.1:4738`.

> Contributor fallback from source: `pnpm exec issuepilot run --workflow "$WORKFLOW_PATH"`.

**Terminal B — dashboard:**

```bash
issuepilot dashboard
```

Open `http://localhost:3000`. By default the dashboard talks to
`http://127.0.0.1:4738`. If the orchestrator uses another port:

```bash
issuepilot dashboard --api-url http://127.0.0.1:4839
```

If you see `IssuePilot orchestrator unreachable` / `fetch failed`, confirm
the orchestrator is still running in Terminal A and that the dashboard is
pointed at the same port.

The home page is the **V2.5 Command Center** — a single screen with a
**List view** and a **Board view** (toggle in the top-right). Click a run to
open the inline Review Packet inspector; click the run ID to open the full
run detail page, which now starts with a **Review Packet** section that
mirrors the structured handoff, validation, risks, follow-ups, and
merge-readiness verdict from the run's persisted report. The Reports
aggregator lives at `http://127.0.0.1:3000/reports` and summarises
ready-to-merge, blocked, and failed counters from local report artifacts.

The dashboard is bilingual: use the **EN / 中** toggle in the sidebar to
switch between English and 简体中文. The choice is stored in the
`issuepilot-locale` cookie and applies to every page (Command Center,
Reports, run detail). Technical tokens — status labels (`running`,
`completed`, `failed`, `blocked`, `human-review`, `ai-ready`, …),
readiness verdicts (`ready` / `not-ready` / `blocked` / `unknown`), CI
status, run ids, branches, paths, and product names like `IssuePilot` /
`Codex` / `GitLab` / `MR` / `Workflow` / `Workspace` — remain English in
both locales by design.

> Merge readiness is a **dry-run only** evaluator: it tells you whether
> CI, approvals, review feedback, and risks look ready. IssuePilot will not
> call any GitLab merge API — humans still own the actual merge decision.

### 4.2 Run the first Issue

In the target GitLab project:

1. Create a tiny Issue (e.g. "Append `Hello from IssuePilot` to README").
2. Apply the `ai-ready` label. **No need** to assign it to yourself.

Within ~10 seconds IssuePilot should:

```text
1. Flip Issue label ai-ready → ai-running
2. A run appears in dashboard with status running
3. ~/.issuepilot/workspaces/<project>/<iid> contains the worktree
4. Codex edits files in the worktree and commits
5. Push the ai/<iid>-<slug> branch
6. Open a draft MR
7. Post a handoff note on the Issue: ## IssuePilot handoff ...
8. Flip the Issue label to human-review
```

Then a human reviews the MR:

- **Merge the MR** → IssuePilot auto-writes a closing note, removes
  `human-review`, closes the Issue.
- **Ask AI for another pass** → set the label to `ai-rework` (Phase 4 review
  feedback sweep structures your MR comments into the next prompt).
- **Close the MR without merging** → IssuePilot reverts the label to
  `ai-rework`.

### 4.3 What to do for each of the 6 label states

| Current label | What you should do |
| --- | --- |
| `ai-ready` | Wait for IssuePilot to pick it up (every `poll_interval_ms`) |
| `ai-running` | Watch the dashboard; do not change labels manually |
| `human-review` | Review the MR in GitLab; optionally wait for CI auto-update |
| `ai-rework` | Wait for IssuePilot to take another pass |
| `ai-failed` | Inspect dashboard timeline + failure note; fix and click Retry, or relabel to `ai-ready` |
| `ai-blocked` | Provide missing info / permission / secret, then relabel to `ai-ready` |

---

## Part 5 — V2 team mode: shared machine + multiple projects

V2 reuses everything in V1 and adds a `--config` team entrypoint plus four
capability buckets: dashboard actions, CI failure flip-back, review feedback
sweep, and workspace retention. The V1 / V2 picker is in [§1.2](#12-v1-single-project-vs-v2-team-mode);
the two entrypoints are **mutually exclusive** (passing both exits with an
error).

### 5.1 Central team config

Team mode does **not** read `WORKFLOW.md` from a business repo. Instead, a
single `issuepilot-config/` directory owns three things:

1. `issuepilot.team.yaml` — server / scheduler / projects roster.
2. `projects/<id>.yaml` — one file per project, **project facts only**
   (tracker target, repo URL, base branch, optional small agent knobs).
3. `workflows/<name>.md` — reusable workflow profile (prompt + runtime
   guardrails like sandbox / runner / concurrency). Multiple projects can
   share the same profile.

```text
issuepilot-config/
  issuepilot.team.yaml
  projects/
    platform-web.yaml
    infra-tools.yaml
  workflows/
    default-web.md
    default-node-lib.md
```

`issuepilot-config/issuepilot.team.yaml`:

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

scheduler:
  max_concurrent_runs: 2
  max_concurrent_runs_per_project: 1
  lease_ttl_ms: 900000
  poll_interval_ms: 10000

projects:
  - id: platform-web
    name: Platform Web
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md
    enabled: true
  - id: infra-tools
    name: Infra Tools
    project: ./projects/infra-tools.yaml
    workflow_profile: ./workflows/default-node-lib.md
    enabled: true

# Optional: team-wide CI override. When set, wins over the profile's `ci`
# block; per-project `projects[].ci` wins over this. Any override must
# carry all three keys together.
# ci:
#   enabled: true
#   on_failure: ai-rework        # or human-review
#   wait_for_pipeline: true

# Optional: workspace retention defaults (V1 cleanup loop today; team
# daemon parses but does not yet enforce — see §5.6).
# retention:
#   successful_run_days: 7
#   failed_run_days: 30
#   max_workspace_gb: 50
#   cleanup_interval_ms: 3600000
```

`projects/platform-web.yaml` — project facts; no token, no runner, no
prompt:

```yaml
tracker:
  kind: gitlab
  base_url: https://gitlab.example.com
  project_id: group/platform-web

git:
  repo_url: git@gitlab.example.com:group/platform-web.git
  base_branch: main
  branch_prefix: ai

# Optional per-project agent override; profile values fill the rest.
# agent:
#   max_turns: 10
#   max_attempts: 2
```

`workflows/default-web.md` — prompt + runtime guardrails shared across
projects of the same shape. The profile is the only place to set the
runner / Codex sandbox / hooks; project files cannot raise those.

```md
---
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

You are working on GitLab project `{{ project.tracker.project_id }}`.
Target repo: `{{ project.git.repo_url }}`, default branch `{{ project.git.base_branch }}`.
```

Field constraints (violations fail at startup with a dotted path):

| Field | Constraint |
| --- | --- |
| `version` | must be `1` |
| `scheduler.max_concurrent_runs` | `1..5` |
| `scheduler.lease_ttl_ms` | `>= 60000` |
| `scheduler.poll_interval_ms` | `>= 1000` |
| `projects[].id` | lowercase alphanum + dashes; unique per config |
| `projects[].project` / `projects[].workflow_profile` | both required; relative paths resolve against the team config directory |
| `ci` (precedence) | `projects[].ci > team ci > workflow profile ci`; any override must carry all three keys |

`projects[].workflow` (the legacy single-file pointer) is **no longer
supported in team mode**; the loader rejects it with an actionable
dotted-path error pointing at the migration target.

### 5.2 Validate, render, launch

```bash
# 1. Schema check (no GitLab, no daemon)
issuepilot validate --config /path/to/issuepilot-config/issuepilot.team.yaml

# 2. Inspect the compiled effective workflow for one project (tokens / secrets
#    redacted; safe to paste into a review ticket or diff against a previous
#    render). The compiled workflow never lands on disk.
issuepilot render-workflow \
  --config  /path/to/issuepilot-config/issuepilot.team.yaml \
  --project platform-web

# 3. Launch the team daemon
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml

# 4. Launch the dashboard in another terminal
issuepilot dashboard --api-url http://127.0.0.1:4738
```

`validate --config` and daemon startup share one `loadTeamConfig` pipeline,
so YAML errors and zod schema errors both surface with the same dotted path.
In V2 the dashboard's `Projects` strip lists every project in team-config
order; `enabled: false` shows a neutral `disabled` badge; a project whose
workflow fails to compile shows a red `load error` badge with the error
summary.

### 5.3 Phase 2 — Dashboard actions (retry / stop / archive)

Dashboard runs list and detail pages expose three buttons. Every action
emits an `operator_action_*` event to the event store.

| Action | Applies to | Behavior | Notes |
| --- | --- | --- | --- |
| **Retry** | `ai-failed` / `ai-blocked` / `ai-rework` / archived failed run | Issue label flips to `ai-rework`; run status set to `claimed` | V2 team daemon not wired yet → `503 actions_unavailable`; V1 works |
| **Stop** | Active `ai-running` run | Real Codex `turn/interrupt`; 5s timeout escalates `stopping` and finally converges via `turnTimeoutMs` | Does not touch GitLab labels directly; failures emit `operator_action_failed { code: cancel_timeout / cancel_threw / not_registered }` |
| **Archive** | Terminal run (`completed` / `failed` / `blocked`) | Records `archivedAt`; dashboard hides by default | List header has a `Show archived` toggle |

Operator identity defaults to the server-side `"system"` fallback; the
`x-issuepilot-operator` HTTP header is the hook for V3 RBAC.

### 5.4 Phase 3 — CI status auto-flip

Enable `ci.enabled` in either `WORKFLOW.md` or team config and, while the
Issue sits in `human-review`, the orchestrator polls the MR pipeline every
`poll_interval_ms`:

```yaml
ci:
  enabled: true
  on_failure: ai-rework        # or human-review
  wait_for_pipeline: true
```

Behavior matrix:

| pipeline state | `on_failure` | Effect |
| --- | --- | --- |
| `success` | — | Stay in `human-review`; dashboard marks it ready for review |
| `failed` | `ai-rework` | Label flips to `ai-rework`; note posted with `<!-- issuepilot:ci-feedback:<runId> -->` marker |
| `failed` | `human-review` | Labels untouched; marker note only; `ci_status_observed { action: "noop" }` |
| `running` / `pending` / `unknown` | — | Stay in `human-review`; wait for next poll; no note |
| `canceled` / `skipped` | — | Marker note hinting human review; `ci_status_observed { action: "manual" }` |

Constraints:

- The scanner is wired into the loop at daemon startup based on `ci.enabled`.
  **Changing `ci.enabled` requires restarting `issuepilot run`** to take effect.
- Auto-merge is out of scope for V2.

### 5.5 Phase 4 — Review feedback sweep

Each poll inside `human-review`, the orchestrator scans the MR's human
comments (system notes and IssuePilot's own marker notes are skipped),
structures them into a `ReviewFeedbackSummary`, and persists it on the run
record.

- Dashboard run detail page adds a `Latest review feedback` panel: MR link,
  last sweep time, per-comment author / time / resolved badge / truncated
  body, and deep links to the original MR note.
- When a human flips the Issue back to `ai-rework`, the next dispatch
  prepends a standardised `## Review feedback` markdown block to the prompt;
  reviewer bodies are wrapped in `<<<REVIEWER_BODY id=N>>> ...
  <<<END_REVIEWER_BODY>>>` envelopes to defend against prompt injection.
- **Always on**. No-op when there is no MR or no comment; no workflow toggle.
- Does not auto-merge and does not replace Phase 3 CI feedback.

### 5.6 Phase 5 — Workspace retention

Default retention policy (override in workflow or team config top-level
`retention`):

| Run state | Default kept |
| --- | --- |
| active / running / stopping / claimed / retrying | never auto-deleted |
| successful / closed | 7 days |
| failed / blocked | 30 days |
| archived terminal | counted from original terminal time |

Constraints:

- When total workspace exceeds `max_workspace_gb` (default 50), planner
  **only** removes already-expired terminal runs; capacity pressure never
  justifies removing active or unexpired failures.
- Failed worktrees keep their `.issuepilot/failed-at-*` marker; markers are
  not pruned by default.
- Cleanup emits a three-step event sequence: `workspace_cleanup_planned`
  → `workspace_cleanup_completed` / `workspace_cleanup_failed`, written
  under the sentinel `runId=workspace-cleanup`. Read via
  `/api/events?runId=workspace-cleanup` or the dashboard timeline.
- **Limitation: the V2 team daemon currently only parses the `retention`
  schema and does not run the cleanup loop.** Until that is wired, the
  workaround for teams is to launch per-project V1 daemons. This is listed
  as a Phase 5 follow-up.

**Dry-run preview** (no daemon required):

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

Example output (without a daemon, run state is unreadable, so every entry
defaults to `unknown` and the planner refuses to delete; for a real preview
tail the `workspace_cleanup_planned` events):

```text
Workspace cleanup dry-run
  workspace root: ~/.issuepilot/workspaces
  entries: 14
  total usage: 2.471 GB (cap 50 GB)
  will delete: 0
  keep failure markers: 3
```

**Operator runbook** (accidental deletion, cleanup-failure diagnostics,
temporary disable):
[`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md).

### 5.7 V4.1 Workflow Spine — plan a large issue end to end

V4.1 turns IssuePilot from "one issue, one run" into a workbench that can
break a large GitLab Issue into 2–5 ordered sub-tasks, dispatch one
synthetic task run per sub-task (each with its own branch + MR), and
ship a single Parent Review Packet back to the parent Issue.

Operator workflow:

1. In the **Command Center** (`/`), pick a run whose `issue.iid` points
   at the large Issue you want IssuePilot to plan, and click
   **Plan work item** in the right-hand inspector. The orchestrator
   POSTs to `/api/issues/:iid/plan`, drafts a `TaskPlan` from the LLM,
   and the dashboard hard-navigates to `/work-items/<id>`.
2. On the **Work item detail** page (`/work-items/<id>`), review the
   draft plan. While `plan.status === "draft"` you can:
   - Click **Edit** to inline-edit `title` / `goal` / `scope` /
     `dependsOn` / `suggestedValidation` per task.
   - Click **Accept plan** — only operator-changed fields are POSTed,
     `WorkItem.status` flips to `ready`, and orchestration immediately
     dispatches every zero-dependency task whose concurrency slot is
     free.
   - Click **Regenerate** — the orchestrator marks the current draft
     `superseded` and asks the planner for a fresh draft as a new
     version.
3. As each synthetic task run lands, watch the **Tasks** section group
   tasks by their effective status (`ready` / `running` / `completed` /
   `failed` / `blocked` / `needs_rework` / `blocked_by_dependency` /
   `skipped`). Each row links to its MR; failed / needs-rework / blocked
   rows expose **Retry**, blocked / blocked-by-dependency / failed rows
   expose **Skip**.
4. Once every task settles, the **Parent Review Packet** card renders
   `WorkItemReport`: validation summary, risk summary, per-task cards
   (diff, validation, risks, follow-ups, CI, MR, next action), evidence
   index and recommended next actions. Use **Copy as Markdown** to drop
   the same content into Slack / a code review thread.
5. The orchestrator writes a single workpad note on the parent Issue
   carrying the marker `<!-- issuepilot:work-item:<id> -->` so the same
   note is updated on every reconciliation. When *every* required task
   ends `completed`, IssuePilot transitions the parent Issue from
   `ai-running` to `human-review`. Partial / failed outcomes leave the
   parent label untouched and let the operator decide.

CLI / direct HTTP equivalents (useful for scripting and CI checks):

```bash
# Draft a plan for a GitLab Issue iid
curl -X POST -H 'content-type: application/json' \
  -d '{"iid": 42}' \
  http://127.0.0.1:4738/api/issues/42/plan

# List all WorkItems with status counters
curl http://127.0.0.1:4738/api/work-items

# Read the latest aggregated WorkItemReport
curl http://127.0.0.1:4738/api/work-items/<id>/report
```

V4.1 invariants worth knowing as an operator:

- IssuePilot **never** creates child GitLab Issues; the parent Issue
  stays the only tracked artefact, while every task gets its own MR.
- Synthetic task runs **never** flip the parent Issue label; that is the
  aggregator's job. If you see runs flipping the parent label, file a
  bug — it would mean `parentIssueLabelMode: "suppressed"` was bypassed.
- The dashboard **never** advertises `ready_to_merge` for a work item;
  the strongest recommendation V4.1 emits is "请进入人工 review"
  ("reviewer to inspect the linked MRs"). Auto-merge is reserved for
  later phases.

### 5.8 V4.2 Task Graph — graph view, replan, mark-rework, branch chaining, team-mode project switcher

V4.2 builds on V4.1's WorkItem foundation and adds four operator-facing
capabilities without changing the V4.1 contract (parent Issue label is
still aggregator-owned; synthetic task runs never flip it themselves).

1. **Task Graph view**. Open `/work-items/<id>?view=graph` — or click
   the **Graph** button in the work-item header — to switch the Tasks
   section from a grouped list to an SVG dependency graph. Nodes show
   `taskId` + title + status badge, edges show `dependsOn` directions,
   and nodes on the critical path are highlighted. Click **List** to
   switch back. The view choice is reflected in the URL so the link is
   shareable.
2. **Single-task replan**. On any task row, click **Replan** to open
   a dialog asking for a `reason` (required) and an optional `hint`.
   Submitting POSTs to
   `/api/work-items/<id>/tasks/<taskId>/replan`. IssuePilot drafts a
   new plan version that replaces *only* the targeted task; the
   non-replanned tasks inherit their previous `status` and `runIds`
   so an in-flight workflow does not reset. The previous plan is
   marked `superseded` and the new plan starts as `draft` so you can
   review / accept it before dispatch runs again.
3. **Mark rework + retry**. On a `completed` (or `failed` / `blocked`)
   task row, click **Mark for rework** and provide a `reason`. The
   service flips the task to `needs_rework`, persists the reason,
   reconciles the WorkItem (which moves it back from `completed` to
   `partial` so the parent Issue label re-enters `ai-rework`), then
   you can click **Retry** to dispatch the task again on a fresh
   branch.
4. **Unskip**. Tasks that were skipped (operator decision or
   `failed → skip`) now expose a **Cancel skip** button. POST
   `/api/work-items/<id>/tasks/<taskId>/unskip` flips the task back to
   `ready`; orchestration re-dispatches it on the next tick.
5. **Branch chaining**. When a downstream task `dependsOn` exactly
   one upstream task, and that upstream is `completed` but the
   upstream MR is still `opened` (not merged), the daemon dispatches
   the downstream task using `origin/<upstream-branch>` as the
   `DispatchInput.baseBranch`. This lets a linear refactor land its
   pieces end-to-end without waiting for every MR to merge. Multi
   -upstream tasks still wait for *all* upstream MRs to merge before
   dispatch (no implicit merge-commit synthesis).
6. **Team-mode project switcher**. When the orchestrator runs in
   team-mode (started via `issuepilot start --config issuepilot.team.yaml`),
   the dashboard top bar renders a **Project** dropdown. Pick a
   project — the selection is persisted in `localStorage` and every
   subsequent work-item API call sends `x-issuepilot-project: <id>`.
   Each project has its own `.issuepilot/` workspace namespace, so
   project A's WorkItems are never visible to project B (and vice
   versa). A missing header returns `400 project_header_required`;
   an unknown project id returns `404 project_not_found`.

CLI / direct HTTP equivalents:

```bash
# Replan a single task
curl -X POST -H 'content-type: application/json' \
  -d '{"reason": "missing audit log", "hint": "use writeAudit()"}' \
  http://127.0.0.1:4738/api/work-items/<wi>/tasks/<taskId>/replan

# Mark a completed task back to needs_rework
curl -X POST -H 'content-type: application/json' \
  -d '{"reason": "reviewer wants extra tests"}' \
  http://127.0.0.1:4738/api/work-items/<wi>/tasks/<taskId>/mark-rework

# Cancel a skip
curl -X POST http://127.0.0.1:4738/api/work-items/<wi>/tasks/<taskId>/unskip

# Read the task graph projection
curl http://127.0.0.1:4738/api/work-items/<wi>/graph

# Team-mode: scope a call to a specific project
curl -H 'x-issuepilot-project: platform-web' \
  http://127.0.0.1:4738/api/work-items
```

V4.2 invariants worth knowing as an operator:

- Parent Issue label transitions still go through the aggregator
  path. `markNeedsRework` / `unskipTask` / `replanTask` all run
  `reconcileWorkItem`, so the parent Issue label and handoff note
  follow the same state machine `settleTaskRunFinal` uses.
- Replan **does not** reuse the prior runId. The old `TaskRunLink` is
  retained as historical evidence; the new plan version dispatches a
  fresh run when accepted.
- Branch chaining falls back safely: if the upstream task is failed
  or marked `needs_rework`, the downstream chain returns to
  `blocked_by_dependency` and waits for an operator decision. Any
  in-flight downstream run keeps running and reports its outcome
  back to the aggregator like normal.

### 5.9 Current V2 boundaries and gaps

The main V2 surface is complete. **Explicitly out of scope** for V2 (will be
handled in V3 / V4):

- Multi-user RBAC; token / budget / quota management.
- Remote workers, Docker / K8s sandboxes.
- Auto-merge, cross-issue dependency planning, auto-decomposition.
- Postgres / SQLite as a hard dependency for long-term run history.
- Multi-tracker plugin model; non-GitLab Issue trackers.
- Remote `ai/*` branch cleanup and MR auto-archival.

Open follow-ups (do not block day-to-day use):

- Wire workspace cleanup loop into the V2 team daemon.
- Wire operator actions into the V2 team daemon (dashboard retry / stop /
  archive currently return `503 actions_unavailable`).

---

## Part 6 — Day-2 operations and troubleshooting

### 6.1 Where to look

| What you want | Where to look |
| --- | --- |
| Current daemon state / concurrency / poll interval | dashboard service header or `GET /api/state` |
| All runs / status distribution | dashboard `/` (archived hidden by default) |
| Per-run timeline / tool calls / log tail / review feedback | dashboard `/runs/<runId>` |
| Real-time event stream | `GET /api/events/stream?runId=<runId>` (SSE) |
| One Issue's event history | `~/.issuepilot/state/events/<project-slug>-<iid>.jsonl` |
| Per-run metadata | `~/.issuepilot/state/runs/<project-slug>-<iid>.json` |
| Daemon global log | `~/.issuepilot/state/logs/issuepilot.log` |
| Workspace cleanup history | `/api/events?runId=workspace-cleanup` |

### 6.2 Forensics for failed / blocked runs

Failed / blocked runs are not cleaned up automatically. Investigate via:

```bash
~/.issuepilot/state/logs/issuepilot.log
~/.issuepilot/state/events/<project-slug>-<iid>.jsonl
~/.issuepilot/state/runs/<project-slug>-<iid>.json
~/.issuepilot/workspaces/<project-slug>/<iid>/
~/.issuepilot/workspaces/<project-slug>/<iid>/.issuepilot/failed-at-<iso>
```

`.issuepilot/failed-at-*` is dispatcher-written failure context (cause
category, retry decision, error chain). After fixing the root cause, click
`Retry` in the dashboard or manually relabel the Issue back to `ai-ready`
/ `ai-rework`.

### 6.3 FAQ

**`codex app-server not found`**

```bash
which codex
codex app-server --help
```

If Codex is not on PATH, set `codex.command` in the workflow to an absolute
path.

**`auth login failed ... category=invalid_client`**

The GitLab instance has no matching OAuth Application, or Device
Authorization Grant is disabled. Re-register the Application per
[§3.4](#34-configure-gitlab-credentials) and retry:

```bash
issuepilot auth login --hostname <host> --client-id <oauth-application-id>
```

**GitLab 401 / 403**

Confirm the token is exported in the same shell that starts the daemon, has
`api` scope, and can access the project. Fix and restart the orchestrator.

**Dashboard shows `orchestrator unreachable`**

The dashboard is only the frontend; you must run the orchestrator in
another terminal. If the orchestrator is not on `4738`, use
`NEXT_PUBLIC_API_BASE` or `--api-url` to point at it.

**Which run produced an Issue note?**

The first line of every IssuePilot note carries the marker
`<!-- issuepilot:run:<runId> -->`. The final handoff note starts with
`## IssuePilot handoff` and contains branch, MR, implementation summary,
validation results, risks / follow-ups, and next steps for the human
reviewer.

**Changed `ci.enabled` and nothing happened**

The scanner is wired into the loop at daemon startup based on `ci.enabled`.
Restart `issuepilot run`.

**V2 team-mode dashboard buttons return 503**

The V2 team daemon does not yet wire operator actions; retry / stop /
archive return `503 actions_unavailable`
([§5.7](#57-current-v2-boundaries-and-gaps) follow-up). Temporary
workaround: launch that project via V1 entry.

**V2 team-mode disk keeps growing**

The V2 team daemon does not yet run the workspace cleanup loop
([§5.6](#56-phase-5--workspace-retention) limitation). Run cleanup
manually:

```bash
issuepilot doctor --workspace --workflow /path/to/target-project/WORKFLOW.md
```

Or switch that project to V1 entry (V1 has the cleanup loop wired).

---

## Part 7 — Reference

### 7.1 CLI cheat sheet

```bash
# Environment self-check
issuepilot doctor

# Workspace cleanup dry-run (V2 Phase 5)
issuepilot doctor --workspace --workflow /path/to/WORKFLOW.md

# OAuth management
issuepilot auth login --hostname <gitlab-host> --client-id <oauth-application-id>
issuepilot auth status --hostname <gitlab-host>
issuepilot auth logout --hostname <gitlab-host>
issuepilot auth logout --all

# Validate config
issuepilot validate --workflow /path/to/WORKFLOW.md
issuepilot validate --config /path/to/issuepilot.team.yaml

# Render the compiled effective workflow for one team-mode project
# (secrets / timestamps scrubbed; safe to diff between configs)
issuepilot render-workflow --config /path/to/issuepilot.team.yaml --project <id>

# Run orchestrator
issuepilot run --workflow /path/to/WORKFLOW.md                    # V1 single-project
issuepilot run --config /path/to/issuepilot.team.yaml             # V2 team mode
issuepilot run --workflow ... --port 4738 --host 127.0.0.1

# Run dashboard
issuepilot dashboard
issuepilot dashboard --port 3000 --api-url http://127.0.0.1:4738
```

### 7.2 HTTP API endpoints

```text
GET  /api/state                              orchestrator + service header
GET  /api/runs?status=...&includeArchived=true list runs
GET  /api/runs/:runId                        run detail
GET  /api/events?runId=...                   per-run event history
GET  /api/events/stream?runId=...            SSE real-time event stream
POST /api/runs/:runId/retry                  V2 Phase 2 (V1 entry only)
POST /api/runs/:runId/stop                   V2 Phase 2 (V1 entry only)
POST /api/runs/:runId/archive                V2 Phase 2 (V1 entry only)
```

Operator identity is passed via the HTTP header `x-issuepilot-operator`;
defaults to `"system"`.

### 7.3 Document map

- **Architecture & flow diagrams**: [`docs/superpowers/diagrams/`](./docs/superpowers/diagrams/)
- **V2 master spec & Phase 1–5 progress**: [`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- **P0 design spec**: [`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- **Workspace cleanup runbook**: [`docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md`](./docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md)
- **Live GitLab smoke runbook**: [`docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md`](./docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md)
- **CHANGELOG**: [`CHANGELOG.md`](./CHANGELOG.md)
