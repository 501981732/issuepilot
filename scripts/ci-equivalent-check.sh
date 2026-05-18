#!/usr/bin/env bash
# IssuePilot CI 等价 gate 脚本
#
# Why this script exists:
#   acceptance §验证 gate 显示，部分开发机的默认 runtime（含 Cursor /
#   Codex 自带的 node）会因为 Rollup native code-signature 启动失败，
#   并且某些机器没有 pnpm / corepack。这导致 plan §21 描述的 `pnpm -r
#   build|lint|test` 不一定能直接跑。本脚本把 V4.3 acceptance 列出的
#   等价 gate 串成单一入口，让 CI / reviewer 都能一次跑完，不再依赖
#   self-report。
#
# 使用：
#   scripts/ci-equivalent-check.sh         # 默认完整 gate
#   SKIP_E2E=1 scripts/ci-equivalent-check.sh
#       跳过端到端测试（用于快速本地反馈）
#   NODE_BIN_DIR=/path/to/node/bin scripts/ci-equivalent-check.sh
#       指定 Node runtime（默认尝试 codex bundled runtime，再回退 PATH）
#
# 退出码：
#   0  全部通过
#   1  任一阶段失败（输出会保留，方便定位）

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
echo "[ci-equivalent] repo root: ${ROOT_DIR}"

# ---------- runtime resolution ----------------------------------------------
DEFAULT_BUNDLED_NODE="${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
NODE_BIN_DIR="${NODE_BIN_DIR:-}"
if [[ -z "${NODE_BIN_DIR}" && -x "${DEFAULT_BUNDLED_NODE}/node" ]]; then
  NODE_BIN_DIR="${DEFAULT_BUNDLED_NODE}"
fi
if [[ -n "${NODE_BIN_DIR}" ]]; then
  export PATH="${NODE_BIN_DIR}:${PATH}"
  echo "[ci-equivalent] using node from ${NODE_BIN_DIR}"
fi
echo "[ci-equivalent] node version: $(node --version)"

# ---------- helpers ----------------------------------------------------------
TSC_BIN="${ROOT_DIR}/node_modules/.bin/tsc"
ESLINT_BIN="${ROOT_DIR}/node_modules/.bin/eslint"
NEXT_BIN="${ROOT_DIR}/apps/dashboard/node_modules/.bin/next"
if [[ ! -x "${NEXT_BIN}" ]]; then
  NEXT_BIN="${ROOT_DIR}/node_modules/.bin/next"
fi
VITEST_BIN="${ROOT_DIR}/node_modules/.bin/vitest"

require_bin() {
  if [[ ! -x "$1" ]]; then
    echo "[ci-equivalent] missing local bin: $1" >&2
    echo "[ci-equivalent] hint: run \`pnpm install --frozen-lockfile\` (or any package manager that materializes node_modules) first" >&2
    exit 1
  fi
}
require_bin "${TSC_BIN}"
require_bin "${ESLINT_BIN}"
require_bin "${NEXT_BIN}"
require_bin "${VITEST_BIN}"

# ---------- stages -----------------------------------------------------------
echo "[ci-equivalent] stage 1/5: tsc -b"
"${TSC_BIN}" -b
echo "[ci-equivalent] stage 1/5: ✓ ok"

echo "[ci-equivalent] stage 2/5: tsc -p scripts/tsconfig.json"
"${TSC_BIN}" -p scripts/tsconfig.json
echo "[ci-equivalent] stage 2/5: ✓ ok"

echo "[ci-equivalent] stage 3/5: next build (apps/dashboard)"
(
  cd "${ROOT_DIR}/apps/dashboard"
  "${NEXT_BIN}" build
)
echo "[ci-equivalent] stage 3/5: ✓ ok"

echo "[ci-equivalent] stage 4/5: eslint --max-warnings 0"
"${ESLINT_BIN}" \
  apps/orchestrator/src \
  apps/dashboard/app \
  apps/dashboard/lib \
  apps/dashboard/components \
  packages/*/src \
  tests/e2e \
  --max-warnings 0
echo "[ci-equivalent] stage 4/5: ✓ ok"

echo "[ci-equivalent] stage 5/5: vitest run (per-package)"
PACKAGES=(
  "packages/shared-contracts"
  "packages/core"
  "packages/credentials"
  "packages/observability"
  "packages/runner-codex-app-server"
  "packages/workflow"
  "packages/workspace"
  "packages/tracker-gitlab"
  "apps/orchestrator"
  "apps/dashboard"
)
if [[ "${SKIP_E2E:-0}" != "1" ]]; then
  PACKAGES+=("tests/e2e")
fi

for pkg in "${PACKAGES[@]}"; do
  echo "[ci-equivalent]   - vitest in ${pkg}"
  (
    cd "${ROOT_DIR}/${pkg}"
    # 每个 package 运行自己的 vitest，避免根 vitest workspace 在
    # bundled runtime 下出现 rollup native dlopen 失败。
    "${VITEST_BIN}" run --maxWorkers=1 --minWorkers=1
  )
done
echo "[ci-equivalent] stage 5/5: ✓ ok"

echo "[ci-equivalent] git diff --check"
git diff --check

echo "[ci-equivalent] all stages passed."
