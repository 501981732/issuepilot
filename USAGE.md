# IssuePilot Quick Start

English | [简体中文](./USAGE.zh-CN.md)

This is the only getting-started entry in this repository. Follow the steps in
order the first time you run IssuePilot. For background, see the
[docs home](./docs/README.md) and [Roadmap](./docs/roadmap.md).

The common launch path is:

```bash
cd /path/to/target-project
issuepilot validate
issuepilot run --host 127.0.0.1 --port 4738
```

Then open another terminal:

```bash
issuepilot dashboard
```

You do not need `WORKFLOW_PATH` when the current directory contains
`WORKFLOW.md`. The steps below cover installation, GitLab credentials, the
`WORKFLOW.md` content and the startup order.

## Step 1: Prepare The Environment

Make sure the machine has:

| Tool      | Requirement                                                           |
| --------- | --------------------------------------------------------------------- |
| Node.js   | `>=22 <23`                                                            |
| pnpm      | `10.x`, enabled through `corepack`                                    |
| Git       | Can clone, fetch and push the target project                          |
| Codex CLI | Signed in and able to run `codex app-server`                          |
| GitLab    | A test project where you can create Issues, labels and Merge Requests |

IssuePilot stores runtime state, mirrors, worktrees and event logs under
`~/.issuepilot`.

## Step 2: Install IssuePilot

Inside the IssuePilot repository:

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-*.tgz
issuepilot doctor
```

Continue when `issuepilot doctor` reports `[OK]` for Node.js, Git, Codex
app-server and `~/.issuepilot/state`.

If you are contributing to the source tree and do not want a global install:

```bash
pnpm build
pnpm exec issuepilot doctor
```

You can temporarily replace every later `issuepilot ...` command with
`pnpm exec issuepilot ...`.

## Step 3: Prepare The Target Project

Do the following in the GitLab project that AI will modify.

Create these 6 labels:

```text
ai-ready
ai-running
human-review
ai-rework
ai-failed
ai-blocked
```

Confirm your local SSH key can push:

```bash
ssh -T git@gitlab.example.com
```

Then commit `WORKFLOW.md` at the target project root:

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

1. Read the relevant code before editing.
2. Work only inside the provided workspace.
3. Implement the Issue description.
4. Commit changes and create or update a Merge Request.
5. Write implementation, validation, risk and MR link back to the Issue.
6. If information, permission or secrets are missing, mark the Issue
   `ai-blocked` and explain why.
```

`tracker.project_id` can be a project path or numeric ID. `git.repo_url` should
prefer SSH. Do not put tokens in `WORKFLOW.md`.

## Step 4: Configure GitLab Credentials

OAuth is recommended on personal machines:

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

If you use a PAT, Group Access Token or Project Access Token, add an environment
variable name to the `tracker` block in `WORKFLOW.md`:

```yaml
tracker:
  base_url: "https://gitlab.example.com"
  token_env: "GITLAB_TOKEN"
```

Export it before launch:

```bash
export GITLAB_TOKEN="<gitlab token>"
```

`token_env` must be the environment variable name, not the token value.

## Step 5: Validate The Config

```bash
cd /path/to/target-project
issuepilot validate
```

The config is usable when you see:

```text
Workflow loaded: /path/to/target-project/WORKFLOW.md
GitLab project: group/project
Validation passed.
```

`issuepilot validate` reads `./WORKFLOW.md` from the current directory by
default. If you want to run it from another directory, pass the path explicitly:

```bash
issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
```

## Step 6: Start IssuePilot

Open two terminals.

Terminal A starts the orchestrator:

```bash
cd /path/to/target-project
issuepilot run --host 127.0.0.1 --port 4738
```

Terminal B starts the dashboard:

```bash
issuepilot dashboard
```

Open:

```text
http://localhost:3000
```

If you start the dashboard from source:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:4738 pnpm dev:dashboard
```

You do not have to set `WORKFLOW_PATH` when you start from the target project
root. IssuePilot automatically reads `./WORKFLOW.md`. Use `--workflow` only
when starting from another directory:

```bash
issuepilot run --workflow /path/to/target-project/WORKFLOW.md --host 127.0.0.1 --port 4738
```

## Step 7: Run The First Issue

1. Create a tiny test Issue in the target GitLab project.
2. Add the `ai-ready` label.
3. Watch for the run in the dashboard.
4. Wait for IssuePilot to create the branch and MR.
5. Review the MR, handoff note, validation result and risk note.
6. Merge manually if the result is good; use `ai-rework` if it needs another pass.

IssuePilot never auto-merges MRs.

## Multi-Project Startup

If one machine needs to manage multiple projects, prepare a central config
directory and use:

```bash
issuepilot validate --config /path/to/issuepilot.team.yaml
issuepilot run --config /path/to/issuepilot.team.yaml --host 127.0.0.1 --port 4738
issuepilot dashboard
```

The central config background is documented in
[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md).

## Troubleshooting

| Problem                                 | Fix                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| dashboard shows `GET /api/state failed` | Confirm the orchestrator is running and the dashboard points to `http://127.0.0.1:4738`   |
| GitLab returns 401 / 403                | Check OAuth status, or confirm the env var named by `token_env` is exported               |
| Codex runner is unavailable             | Sign in to Codex CLI again, then run `issuepilot doctor`                                  |
| branch push fails                       | Check `git.repo_url`, SSH key and target project permissions                              |
| workspace state is confusing            | Stop the daemon, then inspect `~/.issuepilot/workspaces` and `~/.issuepilot/state/events` |

## Document Map

- [Docs home](./docs/README.md)
- [Roadmap](./docs/roadmap.md)
- [IssuePilot design spec](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [V4 architecture diagram](./docs/superpowers/diagrams/v4-architecture.svg)
- [V4 end-to-end flow diagram](./docs/superpowers/diagrams/v4-flow.svg)
