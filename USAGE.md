# IssuePilot Quick Start

English | [简体中文](./USAGE.zh-CN.md)

This is the only getting-started entry in this repository. Follow the steps in
order the first time you run IssuePilot. For background, see the
[docs home](./docs/README.md) and [Roadmap](./docs/roadmap.md).

Separate two things first:

1. Installing IssuePilot: run these commands in the IssuePilot source repository.
2. Running IssuePilot: run it from a central config directory; IssuePilot reads
   `./issuepilot.team.yaml` by default.

After installation, the common launch path is:

```bash
cd /path/to/issuepilot-config
issuepilot validate
issuepilot run
```

Then open another terminal:

```bash
issuepilot dashboard
```

`/path/to/issuepilot-config` is the central config directory, not the target
project. Target project paths, GitLab project ids and workflow profiles live in
central config.

If you do not want to change directories, pass the config explicitly:

```bash
issuepilot validate --config /path/to/issuepilot-config/issuepilot.team.yaml
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml
```

The steps below cover installation, GitLab credentials, central config and the
startup order.

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

## Step 3: Prepare Central Config

Prepare a config directory, for example:

```text
issuepilot-config/
  issuepilot.team.yaml
  projects/
    platform-web.yaml
  workflows/
    default-web.md
```

`issuepilot.team.yaml`:

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 4738

projects:
  - id: platform-web
    name: Platform Web
    enabled: true
    project: ./projects/platform-web.yaml
    workflow_profile: ./workflows/default-web.md
```

`projects/platform-web.yaml`:

```yaml
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/platform-web"

git:
  repo_url: "git@gitlab.example.com:group/platform-web.git"
  base_branch: main
  branch_prefix: ai
```

`workflows/default-web.md`:

```md
---
agent:
  runner: codex-app-server
  max_turns: 10
  max_attempts: 2
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
```

## Step 4: Prepare The Target Project

Create these 6 labels in the GitLab project that AI will modify:

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

Do not put tokens in config files.

## Step 5: Configure GitLab Credentials

Use OAuth on personal machines:

```bash
issuepilot auth login --hostname gitlab.example.com --client-id <oauth-application-id>
issuepilot auth status --hostname gitlab.example.com
```

Central project files do not set `tracker.token_env`, and they must not store
token values.

## Step 6: Validate And Start

```bash
cd /path/to/issuepilot-config
issuepilot validate
```

Open two terminals.

Terminal A starts the orchestrator:

```bash
issuepilot run
```

Terminal B starts the dashboard:

```bash
issuepilot dashboard
```

Open:

```text
http://localhost:3000
```

If you are not in the config directory, pass `--config`:

```bash
issuepilot run --config /path/to/issuepilot-config/issuepilot.team.yaml
```

## Step 7: Run The First Issue

1. Create a tiny test Issue in the target GitLab project.
2. Add the `ai-ready` label.
3. Watch for the run in the dashboard.
4. Wait for IssuePilot to create the branch and MR.
5. Review the MR, handoff note, validation result and risk note.
6. Merge manually if the result is good; use `ai-rework` if it needs another pass.

IssuePilot never auto-merges MRs.

## Compatibility: Single-Project `WORKFLOW.md`

`--workflow` is not required for central config. It is only for the older
single-project `WORKFLOW.md` path:

```bash
issuepilot run --workflow /path/to/target-project/WORKFLOW.md
```

The central config background is documented in
[`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](./docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md).

## Troubleshooting

| Problem                                 | Fix                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| dashboard shows `GET /api/state failed` | Confirm the orchestrator is running and the dashboard points to `http://127.0.0.1:4738`   |
| GitLab returns 401 / 403                | Check OAuth status and target project permissions                                         |
| Codex runner is unavailable             | Sign in to Codex CLI again, then run `issuepilot doctor`                                  |
| branch push fails                       | Check `git.repo_url`, SSH key and target project permissions                              |
| workspace state is confusing            | Stop the daemon, then inspect `~/.issuepilot/workspaces` and `~/.issuepilot/state/events` |

## Document Map

- [Docs home](./docs/README.md)
- [Roadmap](./docs/roadmap.md)
- [IssuePilot design spec](./docs/superpowers/specs/2026-05-11-issuepilot-design.md)
- [V4 architecture diagram](./docs/superpowers/diagrams/v4-architecture.svg)
- [V4 end-to-end flow diagram](./docs/superpowers/diagrams/v4-flow.svg)
