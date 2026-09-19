#!/usr/bin/env bash
# Polaris — run the desktop shell in dev mode (Vite HMR + Tauri window).
#
#   bash scripts/dev.sh
#
# Uses `cargo tauri` (installed toolchain) so the script works even before npm
# dependencies exist; Vite is started by Tauri's `beforeDevCommand`.
set -euo pipefail

cd "$(dirname "$0")/../app"

if [[ ! -d node_modules ]]; then
  echo "== node_modules missing, running npm install at the repo root"
  (cd .. && npm install)
fi

exec caffeinate -i cargo tauri dev