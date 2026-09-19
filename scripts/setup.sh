#!/usr/bin/env bash
# Polaris — one-shot setup for a fresh clone.
#
#   bash scripts/setup.sh
#
# Installs JS workspace dependencies and generates the app icons. Rust
# dependencies are fetched by the first `make check` / `make dev`.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== node $(node -v 2>/dev/null || echo 'MISSING — need Node >= 22')"
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "== created .env from .env.example (fill in ANTHROPIC_API_KEY before step A2)"
else
  echo "== .env already present, left untouched"
fi

echo "== npm install (workspaces: interfaces, agent, stellar, app)"
npm install

echo "== icons"
python3 scripts/generate-icons.py

cat <<'EOF'

Setup complete. Next steps:
  make check        # typecheck JS + cargo check the Tauri app
  make check-chain  # cargo test the Soroban crate
  make dev          # run the desktop shell (Tauri dev)
  npm run agent     # run the agent skeleton smoke test
EOF