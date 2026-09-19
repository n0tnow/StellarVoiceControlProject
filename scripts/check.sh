#!/usr/bin/env bash
# Polaris — full static check: JS typecheck (all workspaces) + Rust check.
#
#   bash scripts/check.sh            # JS + Tauri shell
#   bash scripts/check.sh --chain    # also build/test the Soroban crate
#
# Long operations are wrapped in `caffeinate -i` (AGENTS.md §4).
set -euo pipefail

cd "$(dirname "$0")/.."
WITH_CHAIN=0
[[ "${1:-}" == "--chain" ]] && WITH_CHAIN=1

echo "== JS: typecheck all workspaces"
npm run check --workspaces --if-present

echo "== JS: workspace tests (keeper node:test + anchor vitest)"
caffeinate -i npm test -w @polaris/stellar

echo "== JS: production build of the shell (vite)"
npm run build -w @polaris/app

echo "== JS: agent skeleton smoke test"
npm run start -w @polaris/agent

echo "== Rust: cargo check (Tauri shell)"
caffeinate -i cargo check --manifest-path app/src-tauri/Cargo.toml

if [[ "$WITH_CHAIN" == "1" ]]; then
  echo "== Rust: cargo test (Soroban contracts, host)"
  caffeinate -i cargo test --manifest-path contracts/Cargo.toml

  if command -v stellar >/dev/null 2>&1; then
    echo "== Rust: stellar contract build (Soroban wasm; needs stellar-cli >= 25.2.0)"
    caffeinate -i stellar contract build --manifest-path contracts/Cargo.toml
  else
    echo "!! stellar-cli not found — skipping the wasm build (install it before deploying)"
  fi
fi

echo "== all checks passed"