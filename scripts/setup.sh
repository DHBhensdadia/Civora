#!/usr/bin/env bash
#
# One-time local setup. Run from anywhere; it resolves the repository root
# itself. No cloud credentials are required or requested.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Checking the toolchain"
command -v node >/dev/null 2>&1 || { echo "node is required but was not found" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required but was not found" >&2; exit 1; }
echo "    node $(node --version)"
echo "    pnpm $(pnpm --version)"

echo "==> Installing workspace dependencies"
pnpm install

echo "==> Adding a local environment file"
if [ -f .env.local ]; then
  echo "    .env.local already exists; leaving it alone"
else
  cp .env.example .env.local
  echo "    created .env.local from .env.example (leave it empty for local adapters)"
fi

echo "==> Installing the Chromium build for browser tests"
pnpm exec playwright install chromium

echo
echo "Setup complete. Start the platform with:"
echo
echo "    pnpm dev"
