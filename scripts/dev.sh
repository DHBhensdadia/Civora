#!/usr/bin/env bash
#
# Start the local platform: the emulator suite (if it can start) and the web
# application. Neither needs cloud credentials.
#
# Set CIVORA_SKIP_EMULATORS=1 to run the application on its in-memory adapters
# alone, which is what CI and a quick look at the UI do.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

EMULATOR_PID=""

cleanup() {
  if [ -n "$EMULATOR_PID" ] && kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo
    echo "==> Stopping the emulator suite"
    kill "$EMULATOR_PID" 2>/dev/null || true
    wait "$EMULATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "${CIVORA_SKIP_EMULATORS:-0}" = "1" ]; then
  echo "==> Skipping the emulator suite (CIVORA_SKIP_EMULATORS=1)"
elif [ -f infra/firebase.json ]; then
  echo "==> Starting the Firebase emulator suite in the background"
  # The application is designed to run without this: if the suite fails to
  # start, the local adapters still serve it.
  pnpm exec firebase emulators:start \
    --config infra/firebase.json \
    --project civora-local \
    >.firebase-emulators.log 2>&1 &
  EMULATOR_PID=$!
  echo "    logs: .firebase-emulators.log (pid ${EMULATOR_PID})"
fi

# The port is pinned rather than left to the framework's default, which is not
# stable across versions. Override with CIVORA_WEB_PORT.
WEB_PORT="${CIVORA_WEB_PORT:-3000}"

if lsof -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${WEB_PORT} is already in use. Stop the process holding it, or set" >&2
  echo "CIVORA_WEB_PORT to a free port and try again." >&2
  exit 1
fi

echo "==> Starting the web application on http://localhost:${WEB_PORT}"
# `exec` rather than `run` so the port argument reaches the framework directly
# instead of being forwarded as a literal second `--`.
pnpm --filter @civora/web exec next dev --port "$WEB_PORT"
