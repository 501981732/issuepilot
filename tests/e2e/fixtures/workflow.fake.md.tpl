---
tracker:
  kind: gitlab
  base_url: __GITLAB_URL__
  project_id: __PROJECT_ID__
  token_env: GITLAB_TOKEN
  active_labels: __ACTIVE_LABELS__
  running_label: "ai-running"
  handoff_label: "human-review"
  failed_label: "ai-failed"
  blocked_label: "ai-blocked"
  rework_label: "ai-rework"
  merging_label: "ai-merging"
workspace:
  root: __WORKSPACE_ROOT__
  strategy: worktree
  repo_cache_root: __REPO_CACHE_ROOT__
git:
  repo_url: __REPO_URL__
  base_branch: main
  branch_prefix: ai
agent:
  runner: codex-app-server
  max_concurrent_agents: 1
  max_turns: 2
  max_attempts: __MAX_ATTEMPTS__
  retry_backoff_ms: 100
codex:
  command: __CODEX_CMD__
  approval_policy: never
  thread_sandbox: workspace-write
  turn_timeout_ms: __TURN_TIMEOUT_MS__
  turn_sandbox_policy:
    type: workspaceWrite
runners:
  codex_app_server:
    kind: codex_app_server
    display_name: Codex App Server
    capabilities:
      - roles.coder
      - roles.reviewer
      - roles.test_evidence
      - events.streaming
      - cancel
      - artifacts
      - gitlab.tools
      - filesystem.worktree_write
    timeout_seconds: 1800
    options:
      command: __CODEX_CMD__
      max_turns: 20
      turn_timeout_ms: __TURN_TIMEOUT_MS__
      approval_policy: never
      thread_sandbox: workspace-write
hooks:
  before_run: |
    set -euo pipefail
    git config user.email "ci@issuepilot.local"
    git config user.name "issuepilot-ci"
    echo "CHANGELOG updated by IssuePilot" > CHANGELOG_AI.md
    git add CHANGELOG_AI.md
    # Idempotent commit: skip when nothing changed (e.g. on retry the file
    # already matches HEAD). Without this `git commit` would exit non-zero
    # and the hook would surface as `HookFailedError`, masking the actual
    # failure path under test.
    git diff --cached --quiet || git commit -m "feat: ai changelog entry"
ci:
  enabled: __CI_ENABLED__
  on_failure: __CI_ON_FAILURE__
  wait_for_pipeline: true
poll_interval_ms: 1000
---
Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Workspace: {{ workspace.path }}
Branch: {{ git.branch }}
Attempt: {{ attempt }}

Description:
{{ issue.description }}
