# IssuePilot

[English](README.en.md) | [简体中文](README.md)

IssuePilot turns GitLab Issues into isolated, reviewable AI engineering runs.
Teams should not supervise agent chat sessions directly; they should manage
delivery through Issues, MRs, Review Packets and a dashboard.

[Quick Start](./USAGE.md) · [Docs](./docs/README.md) · [Roadmap](./docs/roadmap.md)

![IssuePilot Command Center](./docs/assets/screenshots/dashboard-command-center.png)

## Why IssuePilot

The hard part of AI coding agents is not only whether they can write code. The
hard part is how a team assigns work, isolates execution, reviews output and
sends precise rework back through an existing engineering workflow.
IssuePilot puts those controls back into GitLab Issues and Merge Requests.

## How It Works

1. Add `ai-ready` to a GitLab Issue.
2. The orchestrator claims the issue and creates an isolated worktree under
   `~/.issuepilot`.
3. A runner executes inside that worktree.
4. IssuePilot creates a branch, MR, handoff note and run report.
5. The dashboard shows Command Center, Run Detail, Review Packet and Reports.
6. A human reviewer decides whether to merge, move to `ai-rework`, mark
   `ai-blocked` or mark `ai-failed`.

![IssuePilot Run Detail](./docs/assets/screenshots/dashboard-run-detail.png)

## Core Capabilities

- GitLab label-driven orchestration.
- local-first workspace isolation.
- Codex app-server runner.
- dashboard Command Center.
- MR handoff note.
- Review Packet / Evidence.
- Review feedback to rework plan.
- Quality analytics and improvement loop.
- Runner adapter contract with runner kind, provenance and redaction trace.

## Current Maturity

| Phase | Status |
| --- | --- |
| P0 / V1 | single-machine loop complete |
| V2 / V2.5 | team runtime and Command Center complete |
| V4.1-V4.10 | intelligent workbench release lock complete |
| V3 | production execution platform not started |

IssuePilot is currently suitable for local development, team-machine pilots and
internal dog-food. It is not a SaaS product and it never auto-merges MRs.

## Where To Start

For a first run, use only [Quick Start](./USAGE.md). It walks through:

1. Preparing the local machine.
2. Installing IssuePilot.
3. Preparing the target GitLab project and `WORKFLOW.md`.
4. Configuring GitLab credentials.
5. Validating the config.
6. Starting the orchestrator and dashboard.
7. Running the first `ai-ready` Issue.

## Documentation

- [快速使用中文](./USAGE.zh-CN.md)
- [Quick Start English](./USAGE.md)
- [Docs home](./docs/README.md)
- [Roadmap](./docs/roadmap.md)
- [V4 architecture diagram](./docs/superpowers/diagrams/v4-architecture.svg)
- [V4 end-to-end flow diagram](./docs/superpowers/diagrams/v4-flow.svg)

## Development And Verification

For docs-only changes, run:

```bash
git diff --check
```

For code changes, prefer:

```bash
SKIP_E2E=1 bash scripts/ci-equivalent-check.sh
```

## License

See [LICENSE](./LICENSE).
