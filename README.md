# IssuePilot

[English](README.md) | [简体中文](README.zh-CN.md)

> Engineering project management today still means babysitting coding agents:
> tracking task progress, chasing PRs, checking CI, and manually shepherding
> validation back and forth — coordination is sliced up across "what is the
> agent doing right now?".
>
> **IssuePilot turns project work into isolated, autonomous implementation
> runs, so teams can manage the work instead of supervising the coding
> agent.** Every GitLab issue becomes a bounded run: its own worktree, its
> own prompt, its own event stream, and an auditable trail of work — handed
> back as a merge request for human review instead of asking engineers to sit
> in every agent turn.

IssuePilot is an open-source local orchestrator for GitLab issue driven AI
engineering work.

It watches GitLab issues, claims work through labels, creates isolated git
worktrees, runs Codex through the app-server protocol, records an auditable event
trail, hands the result back as a merge request for human review, and closes the
issue after that MR is manually merged.

## Product Positioning

IssuePilot is designed as a workflow layer that complements Harness Engineer.
When a project already has a Harness Engineer layer, Harness Engineer should keep
owning the repository's engineering rules, code constraints, validation matrix,
implementation discipline, and local execution quality. IssuePilot focuses on
the cross-issue and multi-run control plane: task orchestration, state
management, reports, evidence, review feedback, and continuous improvement.

Projects can also use IssuePilot without Harness Engineer. In that mode,
`issuepilot-config/`, the workflow profile, repo-local rules, and skills form
the minimum engineering constraint layer, while IssuePilot still provides task
decomposition, orchestration, Review Packets, and auditable evidence.

### Highlights

- **Issue-driven work claim** — watches a GitLab issue board and auto-claims
  issues labelled `ai-ready` into isolated runs, instead of hand-dispatching
  tasks to agents.
- **Full proof of work** — every run produces a CI status, an MR description
  with review links, a reconciliation event trail, a JSONL event store, and a
  live dashboard timeline.
- **Trustworthy handoff boundary** — failures and blocks fall back to
  `ai-failed` / `ai-blocked` while the workspace and logs are preserved for
  forensics; secrets never leak into logs, events, API responses, or prompts.
- **Human review closure** — IssuePilot does not auto-merge code, but after a
  human merges the generated MR, the daemon writes a final note, removes
  `human-review`, and closes the GitLab issue.
- **Zero hand-rolled token management** — built-in `issuepilot auth login`
  runs the GitLab OAuth 2.0 Device Flow, persists the token at
  `~/.issuepilot/credentials` (mode `0600`), and auto-refreshes it; on a 401
  the daemon silently rotates and retries once. PAT / Group Token via
  `tracker.token_env` still works for CI / shared envs.
- **Local single-machine loop** — `~/.issuepilot` keeps the worktrees, JSONL
  event store, and run records on disk; the daemon recovers reconciliation on
  restart without requiring an external database.
- **Complements harness engineering** — works with mature repos that already
  have Harness Engineer, while still remaining usable as a direct local workflow
  platform for repos that do not.
- **Open SPEC + reference implementation** — `SPEC.md` and the Symphony Elixir
  reference implementation remain in the repository, so teams can build their
  own variants in other languages from the same contract.

The project started as a fork of OpenAI Symphony. The current product direction
is TypeScript-first and GitLab-first; the original Symphony spec and Elixir
implementation remain in this repository as reference material.

> [!WARNING]
> IssuePilot has closed the P0 local loop, locked the V1 local tarball, and
> merged V2 Phases 1-5 (team mode, dashboard actions, CI flip-back, review
> feedback sweep, workspace retention). Release tags, archived smoke evidence,
> and the stable local API/CLI compatibility window are still being locked down;
> the V2 team daemon does not auto-run the workspace cleanup loop yet — see the
> V2 roadmap entry below for the Phase 5 follow-up.

## Why IssuePilot?

Coding agents are most useful when they can work from the same units of work
that engineers already manage. IssuePilot treats an issue tracker as the control
plane:

- Engineers describe work in GitLab issues.
- Labels express state: ready, running, review, rework, failed, or blocked.
- Each run happens in its own worktree under `~/.issuepilot`.
- Codex receives a scoped prompt and a restricted workspace.
- The orchestrator writes events, logs, issue notes, branches, and merge
  requests.
- Humans review the MR instead of supervising every agent turn.
- After the MR is manually merged, IssuePilot reconciles the GitLab issue to a
  closed terminal state.

The P0 goal is a local single-machine loop, not a hosted multi-tenant service.

## How IssuePilot Compares to OpenAI Symphony

IssuePilot started as a fork of OpenAI Symphony, so the **overall architecture
is shared lineage**: both treat the issue tracker as the control plane, isolate
each agent run in a per-issue workspace, drive Codex through the app-server
protocol, version the workflow policy as a repo-owned file, and recover on
restart through tracker + filesystem signals instead of an external database.

The differences live in **what we are optimizing for** and **how we implement
it**:

| Dimension       | OpenAI Symphony (reference, Elixir)                             | IssuePilot (the direction in this repo)                                                            |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Positioning     | Public prototype; recommended to fork and harden internally     | Internal P0 product direction; targeting day-to-day use by an engineering team                     |
| Issue tracker   | Linear                                                          | GitLab (SaaS and self-managed, Group Access Token or Personal Token)                               |
| State machine   | Linear issue **status** (state-based)                           | GitLab **labels** (`ai-ready` / `ai-running` / `human-review` / …)                                 |
| Workflow file   | `WORKFLOW.md` at the repo root                                  | `WORKFLOW.md` (YAML front matter + Markdown prompt)                                        |
| Language        | Elixir / OTP                                                    | TypeScript / Node.js 22 LTS                                                                        |
| Runtime         | Single Elixir service + optional status surface                 | Orchestrator daemon (Fastify) + read-only Next.js dashboard (Tailwind/shadcn)                      |
| Workspace       | Per-issue workspace                                             | Bare mirror + git worktree under `~/.issuepilot/{repos,workspaces,state}`                          |
| Events / logs   | Structured logs + optional status surface                       | JSONL event store + atomic run records + SSE live stream + pino structured logging                 |
| MR / PR writes  | Performed by the agent through workflow-defined tools           | Hybrid: Codex can use narrow GitLab dynamic tools, while the orchestrator owns claim, reconciliation, and fallback MR / note / label writes |
| Restart recovery | Tracker + filesystem driven                                    | Driven by labels + handoff note marker (`<!-- issuepilot:run:<runId> -->`)                         |
| Security stance | Each implementation declares its own trust posture              | Rejects `danger-full-access` sandboxes, redacts tokens end-to-end, pins Codex cwd to the worktree  |
| Open SPEC       | `SPEC.md` v1 (language-agnostic)                                | `SPEC.md` retained as reference; product spec lives in `docs/superpowers/specs/`                   |
| Status          | Evaluation-only prototype; harden before production use         | V1 local pilot usable; release lock still pending evidence/tag archival                            |

If you want the Linear + Elixir reference implementation, jump straight to
[`elixir/`](elixir/README.md) and [`SPEC.md`](SPEC.md). If you want the
GitLab + TypeScript variant and plan to pilot it inside a team, the IssuePilot
implementation at the root of this repository is the version you're looking
for.

## Current Status

Implemented in this repository:

- TypeScript monorepo with pnpm, Turborepo, Vitest, ESLint, and Prettier.
- Workflow parsing, validation, defaulting, env checks, and prompt rendering.
- GitLab adapter boundaries for issues, labels, notes, merge requests, and
  pipelines.
- Git workspace management using real `git` commands through `execa`.
- Codex app-server JSON-RPC client pieces and dynamic GitLab tool contracts.
- Observability primitives: redaction, event bus, event store, run store, and
  logger.
- Orchestrator modules for claim, dispatch, retry, reconcile, runtime state,
  HTTP API, SSE, and CLI scaffolding.
- Human-review reconciliation: open MRs stay in review, merged MRs close the
  issue, and closed-unmerged MRs return to the configured rework label.
- Read-only dashboard with overview and run detail views, SSE refresh, timeline,
  tool calls, and log tail rendering.
- V2.5 Command Center: Linear-style List / Board home page, Review Packet
  (handoff + checks + merge readiness) on each run detail, and a `/reports`
  page summarising local report artifacts.
- V2.6 shell + layout refresh: the persistent left sidebar was replaced with
  a sticky **top navigation bar** (logo + primary nav + locale / theme /
  mode tag tools, plus a `Skip to main content` link), giving the kanban
  view back its full 6-column width on 1280–1440px laptops. The Command
  Center now uses a **hybrid inspector** — list view keeps a split-pane
  Review Packet that only takes space when a run is selected; board view
  surfaces the Review Packet in an on-demand right-side **Sheet** drawer
  (Esc / scrim / ✕ to close, focus restored on dismiss, `prefers-reduced-motion`
  aware). The five-status summary collapses from five large kpi cards into
  a single compact card with a horizontal **stacked health bar** plus a
  chip row of exact counts.
- Swiss Modernism 2.0 design system: HSL design tokens for light + dark,
  Fira Sans / Fira Code typography, top-bar shell with theme toggle,
  semantic `StatusDot` / `StatusPill` indicators (colour + text + dot),
  and zero-dep SVG sparkline / mini-bar / donut charts on the reports page.
- Dashboard i18n (English / 简体中文) powered by `next-intl` with a
  cookie-driven locale (`issuepilot-locale`), an EN / 中 toggle in the
  top-bar tools cluster, and message catalogs that intentionally keep technical tokens
  (status labels, readiness, `ai-*` labels, `IssuePilot` / `Codex` /
  `GitLab` / `MR` / `Workflow` / `Workspace`, run ids, branches, paths)
  in English while translating descriptive UI copy. Both server pages
  (`getTranslations`) and client components (`useTranslations`) are
  wired, and the locale toggle forces a full reload so SSR always
  observes the new cookie.
- End-to-end test harness (`tests/e2e`) with a stateful fake GitLab + scriptable
  fake Codex app-server, covering the happy path, retry path
  (`turn/timeout` → ai-failed after `max_attempts`), failure path
  (`turn/failed` → ai-failed + structured failure note),
  permission/escalation path (claim 401/403 → ai-blocked + structured blocked
  note + `claim_failed` event), and approval auto-approve path. The happy path
  also covers manual MR merge followed by a structured closing note and
  automatic issue closure.
- Real GitLab smoke runbook + `pnpm smoke` wrapper that boots the orchestrator,
  polls `/api/state` until ready, prints API + dashboard URLs, and forwards
  SIGINT/SIGTERM with a hard 5s SIGKILL escalation.

Current V1 progress:

- V1 local CLI packaging is available through `pnpm release:pack`; the generated
  tarball installs an `issuepilot` executable for local pilots.
- `pnpm release:check` has passed, covering format, lint, typecheck, build, unit
  tests, fake E2E, installed smoke, the smoke runner, and `git diff --check`.
- Installed `issuepilot --version`, `issuepilot doctor`, `issuepilot validate`,
  `issuepilot run`, and `issuepilot dashboard` have been verified locally.
- The operator has confirmed the real GitLab smoke passed; Issue / MR /
  dashboard evidence links still need to be archived.
- The package is still a local tarball release, not a published npm registry
  package.

## How It Works

```text
GitLab issue has ai-ready label
  -> IssuePilot claims it with ai-running
  -> IssuePilot creates or reuses an isolated worktree
  -> Codex app-server runs inside that worktree
  -> Code is committed and pushed to a branch
  -> A GitLab merge request is created or updated
  -> The issue receives a handoff note
  -> Labels move to human-review, ai-failed, or ai-blocked
  -> Human reviews and manually merges the MR
  -> IssuePilot writes a closing note, removes human-review, and closes the issue
```

P0 labels:

| Label | Meaning |
| --- | --- |
| `ai-ready` | Candidate issue that IssuePilot can pick up. |
| `ai-running` | Claimed issue with an active run. |
| `human-review` | MR is ready for human review. |
| `ai-rework` | Human requested another AI pass after review, or the MR was closed without merge. |
| `ai-failed` | Run failed and needs human intervention. |
| `ai-blocked` | Missing information, permission, or secret. |

## Repository Layout

```text
apps/
  orchestrator/                  Local daemon, CLI, HTTP API, and run loop
  dashboard/                     Read-only Next.js dashboard

packages/
  core/                          Shared domain primitives
  workflow/                      WORKFLOW.md parser and renderer
  tracker-gitlab/                GitLab issue, label, note, MR, pipeline adapter
  workspace/                     Mirror, worktree, branch, hook, and cleanup logic
  runner-codex-app-server/       Codex app-server JSON-RPC integration
  observability/                 Redaction, events, run store, and logging
  shared-contracts/              Types shared by orchestrator and dashboard

docs/superpowers/
  specs/                         Product and architecture specs
  plans/                         Implementation plans

elixir/                          Original Symphony reference implementation
SPEC.md                          Original language-agnostic Symphony spec
```

## Requirements

- Node.js `>=22 <23`
- pnpm `10.x`
- Git
- A GitLab project and token for real runs
- Codex with app-server support for real runs

The root `.npmrc` enables strict engine checks.

## Installable Local Release

Build and install the local V1 package:

```bash
corepack enable
pnpm install
pnpm release:pack
npm install -g ./dist/release/issuepilot-0.1.0.tgz
```

Then run IssuePilot from any directory:

```bash
issuepilot --version
issuepilot doctor
issuepilot validate --workflow /path/to/target-project/WORKFLOW.md
issuepilot run --workflow /path/to/target-project/WORKFLOW.md
issuepilot dashboard
```

The dashboard command starts the packaged Next.js dashboard and points at
`http://127.0.0.1:4738` by default. Use `--api-url` if the orchestrator runs on
a different port:

```bash
issuepilot dashboard --port 3000 --api-url http://127.0.0.1:4738
```

## Development Setup

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
```

Useful commands:

```bash
pnpm build
pnpm lint
pnpm format:check
pnpm release:check
pnpm --filter @issuepilot/workflow test
pnpm --filter @issuepilot/orchestrator test
```

For contributor workflows, the CLI can still be exercised from the workspace
root:

```bash
pnpm build
pnpm exec issuepilot doctor
pnpm exec issuepilot validate --workflow path/to/workflow.md
```

## Workflow File

IssuePilot expects each target repository to provide an agent contract file:

```text
WORKFLOW.md
```

The file contains YAML front matter for machine-readable configuration and a
Markdown body used as the agent prompt.

Minimal shape:

```md
---
tracker:
  kind: gitlab
  base_url: "https://gitlab.example.com"
  project_id: "group/project"
  token_env: "GITLAB_TOKEN"
  active_labels: ["ai-ready", "ai-rework"]
  running_label: ai-running
  handoff_label: human-review
  failed_label: ai-failed
  blocked_label: ai-blocked

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

{{ issue.description }}
```

Secrets are read from the environment variable named by `tracker.token_env`.
They must not be committed into workflow files.

## Security Model

IssuePilot is designed for trusted local development environments.

Important P0 boundaries:

- GitLab tokens are read from environment variables.
- Token-like values are redacted before being written to logs, events, stores,
  or API responses.
- Codex runs with a workflow-defined sandbox, but workflow files cannot request
  `danger-full-access` or `dangerFullAccess`.
- The Codex working directory is limited to the current issue worktree.
- Failed runs preserve workspace data and event logs for debugging.

Review generated code before merging it. IssuePilot creates reviewable merge
requests; it does not replace code review.

## Roadmap

The IssuePilot roadmap lives in
[`docs/superpowers/specs/2026-05-11-issuepilot-design.md`](docs/superpowers/specs/2026-05-11-issuepilot-design.md)
§20 — the section below is a summary so you can quickly see what's usable today
and where the project is heading.

Current roadmap principle: **make the local / shared-team edition complete
enough for the full engineering workflow before building the production-ready
platform**. Login, permissions, budgets, production deployment, centralized
storage, audit, and observability stay in V3; V4 first completes workflow
intelligence and product experience on the existing V2.x runtime.

### P0 — Local single-machine loop (closed)

The local single-machine loop is complete:

- ✅ Local daemon (orchestrator) with a Fastify HTTP API + SSE.
- ✅ GitLab issue label state machine (`ai-ready` → `ai-running` →
  `human-review` / `ai-failed` / `ai-blocked` / `ai-rework`).
- ✅ Codex app-server runner (thread/turn lifecycle + 14 normalized event
  types).
- ✅ Bare mirror + git worktree workspace; failed runs preserved in place.
- ✅ Automatic MR create/update + structured handoff note with marker-based
  recovery.
- ✅ Structured failure / blocked notes with status, run, branch, reason, and
  next action.
- ✅ Human-review closure: manually merged MRs close the GitLab issue; closed
  unmerged MRs return to the configured rework label.
- ✅ Structured closing note when IssuePilot removes `human-review` and closes
  the issue.
- ✅ Read-only Next.js dashboard (overview + run detail + SSE timeline).
- ✅ Fake GitLab + fake Codex end-to-end harness + real GitLab smoke runbook.
- ✅ Installable local CLI tarball with installed `issuepilot run` and
  `issuepilot dashboard` startup paths.
- ✅ Release evidence gate via `pnpm release:check`.
- ✅ Real GitLab smoke has been confirmed by the operator; fixed evidence links
  still need to be archived.
- ✅ Source-checkout usage remains available for contributors and rollback.

### V1 — Stable local release

Goal: make the current single-machine loop installable, repeatable, and safe for
internal pilot teams without changing the core execution model.

- ✅ Installable CLI distribution through npm-compatible package tooling, with
  `issuepilot` as the executable command.
- ✅ Installed startup path for the local loop: `issuepilot run --workflow ...`
  for daemon/API and an installed dashboard start command for the local UI.
- ✅ Release gate that combines unit tests, fake E2E, smoke wrapper, installed
  CLI smoke, and `git diff --check`.
- ✅ Installed daemon / dashboard startup paths and real GitLab smoke have passed
  local pilot verification.
- ✅ Operational docs for install, startup, auth, log redaction, and failed /
  blocked run debugging.
- 🚧 Versioned tags with release notes, rollback notes, and compatibility
  expectations for the local loop.
- 🚧 Stable workflow schema, event contract, CLI commands, and dashboard API for
  the local loop.
- ✅ Source-checkout remains supported for contributors and emergency rollback.

### V2 — Team-operable release

Goal: graduate from "single machine" to "shared team machine" so a team can
run IssuePilot on its day-to-day work.

Status: **all five V2 phases are merged into `main`.** A team can run a single
daemon against multiple GitLab projects, observe and act on runs via the
dashboard, and let the orchestrator handle CI flip-back / review feedback /
workspace cleanup. Visual versions:

- Architecture: [`docs/superpowers/diagrams/v2-architecture.svg`](docs/superpowers/diagrams/v2-architecture.svg)
- End-to-end lifecycle: [`docs/superpowers/diagrams/v2-flow.svg`](docs/superpowers/diagrams/v2-flow.svg)
- V2 master spec + per-phase progress: [`docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md`](docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md)
- Team-mode walkthrough: [`USAGE.md` — Part 5](USAGE.md#part-5--v2-team-mode-shared-machine--multiple-projects)

- ✅ Phase 1 — Team Runtime Foundation: `issuepilot run --config
  /path/to/issuepilot.team.yaml` team mode for multi-project loading,
  lease-backed scheduling, and project-aware dashboard state.
- ✅ Single daemon manages multiple projects on a shared box; concurrency
  is configurable from 1 to 5 with global + per-project lease slots.
- ✅ Dashboard gains `retry`, `stop`, and `archive run` actions (V2 Phase 2).
- ✅ CI status ingestion + automatic flip of CI failures back to `ai-rework`
  (V2 Phase 3; opt-in via `ci.enabled: true` in `WORKFLOW.md`). Note: the
  scanner is wired into the orchestrator loop only at daemon startup —
  toggling `ci.enabled` requires restarting `issuepilot run` for the change
  to take effect.
- ✅ Review feedback sweep (V2 Phase 4): the orchestrator polls human
  comments on the human-review MR, persists them as a `ReviewFeedbackSummary`
  on the run record, and — when the issue is recycled to `ai-rework` — the
  carried-forward summary is prepended to the next agent prompt as a
  standardised `## Review feedback` block. Always-on; no workflow toggle.
  The dashboard run detail view shows a `Latest review feedback` panel
  with deep-links back to each MR note.
- ✅ Workspace retention (V2 Phase 5): the orchestrator periodically
  sweeps `~/.issuepilot/workspaces`, deleting expired successful runs
  (default 7d), preserving failure forensics within the retention window
  (default 30d), and never touching active runs even under capacity
  pressure. Configure via the `retention` block in `issuepilot.team.yaml`
  or workflow front matter. Operators can preview a sweep with
  `issuepilot doctor --workspace --workflow <path>`; the dashboard service
  header surfaces `Workspace usage` + `Next cleanup`; every sweep emits
  `workspace_cleanup_planned` / `_completed` / `_failed` events. See
  `docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md` for the
  operator runbook.
  - **Limitation**: the V2 team daemon parses the `retention` schema but
    does not run the cleanup loop yet. For automatic cleanup today,
    launch each project through the V1 entrypoint
    (`issuepilot run --workflow ...`); team-mode wiring is tracked as a
    Phase 5 follow-up.

Items deferred beyond V2 (not blocking V2):

- Optional automated merge policy after CI/approval checks moves to V3, where
  it can be gated by production permissions, approvals, audit, and rollback
  controls. The P0/V2 default remains human-controlled merge.

### V2.5 — Command Center

Goal: collapse "Overview + Run detail" into a Linear-style Command Center so
operators get a single screen for triage, review, and quality metrics, while
GitLab notes and dashboard share one fact source.

- ✅ `RunReportArtifact` is persisted under `~/.issuepilot/.../reports/<runId>.json`
  alongside the JSONL event store, captured at claim time and updated through
  reconcile, CI scan, review sweep, and failure paths.
- ✅ Command Center home page supports **List view** and **Board view**
  (grouped by workflow label) with an inline Review Packet inspector.
- ✅ **Review Packet** on the run detail page surfaces the structured handoff
  summary, validation, risks, follow-ups, checks (CI / approvals / review
  feedback / risks), and merge-readiness verdict directly from the report.
- ✅ **Reports page** (`/reports`) aggregates per-run quality and timing
  metrics (ready-to-merge / blocked / failed counters, list of report
  summaries) from the local report artifacts.
- ✅ **Merge readiness** is a **dry-run** evaluator only: it reports whether
  CI, approvals, review feedback, and risks suggest the MR is ready to
  merge. IssuePilot still does not call any GitLab merge API; true
  auto-merge remains out of scope.
- ✅ Handoff / failure / closing GitLab notes render from the same
  `RunReportArtifact`, so dashboard, notes, and any future Markdown export
  stay aligned.

### V2.6 — Dashboard shell + layout refresh

Goal: tighten the Command Center information density after the V2.5
content build-out — guided by a `ui-ux-pro-max` system review.

Wave 2 follow-ups (post user dog-food):

- ✅ All three pages (Command Center / Reports / Run Detail) share
  `max-w-[1440px]` so the topbar feels stable across navigation.
- ✅ The board-view inspector Sheet is a **GitLab-style non-modal
  overlay**: no scrim, no body-scroll lock, `role="complementary"`
  instead of `dialog`. The sheet floats over the right edge of the
  kanban; the page container itself **does not reflow** (no
  `lg:pr-[440px]` squeeze) — the board keeps its natural
  `min-w-[1080px]` / `minmax(180px, 1fr)` columns and the covered
  columns stay reachable via horizontal scroll, exactly like
  GitLab's issue board side panel. Clicks outside the sheet still
  hit the kanban so operators swap the inspected run by clicking
  another card without dismissing first.
- ✅ Board cards get a subtle press-on / hover-up motion
  (`-translate-y-0.5` + `shadow-2`) and drop the verbose runId line
  (still in `title=` / `aria-label`); titles `line-clamp-2`.
- ✅ ServiceHeader collapses its forensic metadata (`Last config
  reload` / `Workspace usage` / `Next cleanup`) behind a
  `More details` disclosure so the strip stays compact.
- ✅ All four Reports counters (`Total` / `Ready` / `Blocked` /
  `Median duration`) now carry a 7-day inline sparkline driven by a
  reused `bucketByDay` predicate + a new `medianDurationByDay` helper.

Wave 1 (the original layout refresh):

- ✅ **Top-bar shell** replaces the 232px left sidebar. Primary nav and the
  locale / theme / mode-tag tools collapse into a sticky horizontal strip
  (`max-w-[1440px]`, `bg-surface/95 backdrop-blur`); a `Skip to main
  content` link is the first focusable element. The change frees ~232px of
  horizontal space — enough for the kanban view to render its six lifecycle
  columns without x-overflow on 1280px laptops.
- ✅ **Hybrid Review Packet inspector**. List view keeps the split-pane
  inspector but only mounts the right column when a row is selected (320–
  420px); board view promotes the inspector into an on-demand right-side
  **Sheet** drawer so the kanban stays full-width. The drawer follows
  Apple HIG / Material modal-escape rules: Esc closes, scrim click closes,
  ✕ button closes, body scroll is locked while open, focus is restored on
  dismiss, and `prefers-reduced-motion` is honoured globally via
  `globals.css`.
- ✅ **Stacked health bar**. The five large per-status kpi cards collapse
  into a single Card showing total + a 2px-tall horizontal stacked bar
  (running / retrying / human-review / failed / blocked) plus a chip row
  with exact counts. Operators read "is the queue healthy" in one glance
  instead of summing five numbers.
- ✅ **Workflow path repair**. The `service` strip now truncates long
  paths from the head (`bdo` + `dir="rtl"`) so the file name stays visible,
  with the full path exposed via the native `title=` tooltip.
- ✅ **Section header de-noising**. Mid-page `text-[11px] uppercase
  tracking-[0.18em]` micro-labels were rolled back to plain
  `text-base font-semibold`; the `font-mono` micro-label treatment is
  reserved for page-level overhead labels and `dt` metadata, where it
  reads as a kicker rather than visual noise.

Execution order after V2.6: **build the V4 intelligent engineering workbench
first, then productionize it through V3**. V3 / V4 are capability domains, not
a required numeric delivery order; the current product bet is to validate
workflow intelligence first and platformize the proven capabilities afterward.

### V4 — Intelligent engineering workbench

Goal: run on the existing V2.x local/shared-team runtime first and go beyond
"one issue, one run" to become a workbench that understands, decomposes,
orchestrates, and improves engineering work. V4 does not own deployment,
permissions, budgets, or observability; it owns workflow intelligence. V3 later
productionizes the capabilities that prove valuable here.

- **Work Items / Parent Review Packet for large issues** — *landed in V4.1*.
  An IssuePilot operator can plan a GitLab Issue from the Command Center,
  accept / edit / regenerate the LLM-drafted task plan in
  `/work-items/<id>`, watch every synthetic task run land its own MR, and
  read a Parent Review Packet (validation, risks, evidence index, MR links)
  before the parent Issue auto-flips to `human-review`. Spec:
  `docs/superpowers/specs/2026-05-17-issuepilot-v4-intelligent-workbench-design.md`;
  implementation plan:
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-1-workflow-spine.md`.
- **Task Graph + dependency execution + branch chaining** — *landed in
  V4.2*. The `/work-items/<id>` page now toggles between the grouped task
  list and an SVG Task Graph (topology layout, critical-path highlight).
  Orchestration honours `dependsOn`: when a downstream task has a single
  upstream that is `completed` but whose MR is still `opened`, the daemon
  dispatches the downstream task on `origin/<upstream-branch>` so a linear
  refactor chain can land without waiting for every MR to merge. Operators
  can replan a single task (new plan version, non-replanned tasks inherit
  status / runIds), mark a completed task back to `needs_rework`, and
  un-skip a previously-skipped task — all routed through the same
  aggregator path that drives parent Issue labels, never bypassing it.
  Team-mode `apps/orchestrator/src/team/daemon.ts` now wires per-project
  `WorkItemService` instances; every dashboard work-item API call sends
  `x-issuepilot-project` so two projects never see each other's WorkItems.
  Implementation plan:
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-2-task-graph.md`.
- **Review Packet + Evidence** — *landed in V4.3*. WorkItem reports now
  index reviewer evidence from task worktrees (`screenshot`, `recording`,
  `playwright`, `command_output`, `test_result`) and keep AI/system claims
  separate from human-confirmed evidence. The parent Review Packet derives
  checklist items, CI/test summaries, risks, and evidence links from one
  renderer shared by GitLab handoff notes and dashboard Markdown export.
  `/work-items/<id>?view=evidence` adds a kind-filtered Evidence view with
  per-entry confirmation, while `Copy as Markdown` reads
  `/api/work-items/<id>/report.md` from the orchestrator. Implementation
  plan:
  `docs/superpowers/plans/2026-05-17-issuepilot-v4-3-review-packet-evidence.md`.
- **Large-issue decomposition and orchestration**: split large issues into
  executable sub-tasks with ordering, parallelism, shared context, and rollback
  boundaries.
- **Cross-issue dependency analysis**: detect blockers, duplicated work,
  upstream/downstream dependencies, and mergeable tasks, then surface them as
  an engineering work graph.
- **Multi-agent collaboration**: coding agent, reviewer agent, and
  test/evidence agent roles that can collaborate per sub-task and summarize
  their results.
- **Intelligent review workflow**: summarize MR risks, classify review
  comments, generate rework plans, and turn review feedback into structured
  input for the next run.
- **Acceptance evidence generation**: screenshots, recordings, Playwright
  walkthrough videos, test evidence, risk lists, and MR / Issue-ready
  acceptance reports.
- **Quality and process analytics**: success rate, rework rate, CI pass rate,
  review hit rate, duration bottlenecks, and high-risk workflow detection.
- **Workflow / skills continuous improvement**: recommend workflow, skill,
  prompt, and project-rule changes from repeated failure patterns, with an
  auditable improvement loop.
- **Runner ecosystem**: Claude Code, internal coding agents, and other runner
  adapters managed through the same report and audit model.

### V3 — Productionized execution platform

Goal: turn the V2.x local/shared-machine product, plus the V4 workflow
intelligence that has been validated in practice, into an internal AI
engineering execution platform that can be deployed, governed, audited, and
scaled in production. V3 is not about reinventing smarter workflows; it is about
making proven capabilities controllable, observable, and recoverable.

- **Deployment shape**: Docker / Compose / Kubernetes paths with explicit
  process boundaries for API server, dashboard, workers, and storage.
- **Multi-worker execution**: local / SSH / container workers with heartbeat,
  capacity reporting, task dispatch, failure recovery, and queue reclamation.
- **Production sandboxing**: Docker / Kubernetes sandboxes replace the
  single-host sandbox model, with per-project filesystem, network, and secret
  injection policies.
- **Identity and permissions**: login/session support plus project, team, and
  admin scopes; every dashboard action and automated action is written to an
  operator-aware audit log.
- **Budgets and quotas**: project/team limits for tokens, runtime, concurrency,
  cost, and retry count, with explainable blocked / approval flows on breach.
- **Persistent storage**: Postgres for production run history, reports, leases,
  audit, and configuration state; SQLite / JSONL remain for local development
  or single-machine mode.
- **Webhook + poll scheduling**: GitLab webhooks for low-latency triggers,
  with polling retained as a recovery path.
- **GitLab audit and secret governance**: centralized credential store, token
  rotation, least-privilege access, end-to-end redaction, and leak regression
  tests.
- **Production merge policy**: optional approval-, CI-, permission-, and
  audit-gated auto-merge built on top of the V2.5 merge-readiness dry run.
- **Observability and operations**: OpenTelemetry, structured logs, metrics,
  traces, Grafana / Loki or an internal observability stack, plus backup /
  restore, migration, upgrade, and rollback runbooks.

> The roadmap evolves with the project. Every meaningful change is reflected
> in the design spec and `CHANGELOG.md` in the same PR — treat the design
> spec as the source of truth.

## Documentation

- **[User Guide — English](USAGE.md)** — First time running IssuePilot? Start here. Walks you from install to first end-to-end run in ~30 minutes. Part 5 covers V2 team mode.
- [使用指南（中文）](USAGE.zh-CN.md) — Chinese user guide (mirrors `USAGE.md`).
- **[V2 architecture diagram](docs/superpowers/diagrams/v2-architecture.svg)** — Visual map of the V2 team-operable runtime (config → registry → scheduler → loop → adapters → events → dashboard).
- **[V2 end-to-end flow diagram](docs/superpowers/diagrams/v2-flow.svg)** — Issue lifecycle from `ai-ready` through CI flip-back / review feedback / workspace cleanup.
- [Diagram source files](docs/superpowers/diagrams/) — Mermaid sources and render instructions.
- [IssuePilot V2 roadmap and document map](docs/superpowers/specs/2026-05-15-issuepilot-v2-team-operable-design.md) — V2 phase order, progress, and spec/plan mapping (Phases 1-5 merged).
- [Workspace cleanup runbook](docs/superpowers/runbooks/2026-05-15-workspace-cleanup.md) — Operator SOP for V2 Phase 5 retention.
- [IssuePilot real GitLab smoke runbook](docs/superpowers/plans/2026-05-11-issuepilot-smoke-runbook.md) — Real GitLab + Codex end-to-end acceptance checklist.
- [IssuePilot design spec](docs/superpowers/specs/2026-05-11-issuepilot-design.md) — Architecture, protocols, state machine.
- [IssuePilot implementation plan](docs/superpowers/plans/2026-05-11-issuepilot-implementation-plan.md) — The 8-phase implementation plan and task breakdown.
- [Original Symphony spec](SPEC.md)
- [Elixir reference implementation](elixir/README.md)

## Contributing

Contributions are welcome while the project is still early. The most useful
contributions right now are:

- Bug reports with exact commands, logs, and environment details.
- Tests that tighten workflow, GitLab, workspace, runner, or orchestrator
  contracts.
- Documentation fixes that make local setup easier to reproduce.
- Focused PRs that keep TypeScript implementation work separate from design
  spec updates.

Before opening a PR, run the checks relevant to your change:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

For changes that affect product behavior, architecture, workflow labels, runner
behavior, or roadmap scope, update the IssuePilot design spec in the same PR.

## License

IssuePilot is licensed under the [Apache License 2.0](LICENSE).
