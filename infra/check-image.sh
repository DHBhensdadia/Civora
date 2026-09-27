#!/usr/bin/env bash
#
# Civora — check the container image before it is deployed.
#
#     bash infra/check-image.sh --dry-run    # print every step, execute nothing
#     bash infra/check-image.sh
#
# This is the local instrument for `infra/Dockerfile`. It builds the image from
# the repository root, then asserts the four things a deployment would be wrong
# to discover later:
#
#   1. the container runs as a non-root user;
#   2. NODE_ENV is production, so nothing ships development behaviour;
#   3. the image carries no API key — neither the `AIza…` prefix nor the value of
#      GEMINI_API_KEY from this shell, and the browser bundle carries no key name;
#   4. the container answers `/healthz` and `/readyz` on the port it exposes,
#      which is what the Cloud Run probes are wired to.
#
# It needs a running container runtime. When there is none the script says so in
# one sentence and exits 3 — it never reports a check it did not perform.
#
# Exit: 0 every check passed · 1 a check failed · 3 a prerequisite is missing.

set -euo pipefail

DRY_RUN=0
KEEP_RUNNING=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --keep-running) KEEP_RUNNING=1 ;;
    -h | --help)
      sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $argument (try --dry-run, --keep-running or --help)" >&2
      exit 3
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${CIVORA_IMAGE:-civora-web:local}"
PORT="${CIVORA_IMAGE_PORT:-8080}"
CONTAINER="civora-image-check"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}
missing() {
  printf '\n%s\n' "$*" >&2
  exit 3
}

# Arguments a shell would interpret are quoted, so a line copied out of the plan
# behaves exactly like the line that would have run.
printable() {
  local out='' argument
  for argument in "$@"; do
    case "$argument" in
      '' | *[!A-Za-z0-9_./:=@,+-]*) out="$out $(printf '%q' "$argument")" ;;
      *) out="$out $argument" ;;
    esac
  done
  printf '%s' "${out# }"
}

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    would run: %s\n' "$(printable "$@")"
    return 0
  fi
  printf '    $ %s\n' "$(printable "$@")"
  "$@"
}

# What a check found, for the summary at the end. A run that reports only at the
# end is fine; a run that reports only its successes is not.
FAILURES=0
record() {
  local result="$1" name="$2" detail="${3:-}"
  if [ "$result" = 'ok' ]; then
    say "    ok    $name${detail:+ — $detail}"
  else
    say "    FAIL  $name${detail:+ — $detail}"
    FAILURES=$((FAILURES + 1))
  fi
}

if [ "$DRY_RUN" = 0 ]; then
  command -v docker >/dev/null 2>&1 ||
    missing 'docker was not found. Nothing has been built or checked. Use --dry-run to read the plan.'
  docker info >/dev/null 2>&1 ||
    missing 'no container runtime is answering. Start the container runtime (on this machine, OrbStack)
and run this script again. Nothing has been built or checked — and a check that did not
run is not a passing check.'
fi

say 'Civora — container image check'
say "    image  $IMAGE"
say "    port   $PORT"
if [ "$DRY_RUN" = 1 ]; then
  say '    mode   dry run — every step is printed and none is executed'
fi
say ''

container_id=''
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm --force "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- 1. build --------------------------------------------------------------

say '1. build'
# The context is the repository root, not infra/: the lockfile, the workspace
# manifest and every package span it.
run docker build --file=infra/Dockerfile --tag="$IMAGE" .
say ''

# --- 2. the image's own facts ---------------------------------------------

say "2. what the image is"
if [ "$DRY_RUN" = 1 ]; then
  say '    would run: docker run --rm --entrypoint sh <image> -c "id -u"'
  say '    would run: docker run --rm --entrypoint sh <image> -c "printf %s \$NODE_ENV"'
else
  uid="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u')"
  if [ "$uid" = '0' ]; then
    record fail 'runs as a non-root user' "uid $uid"
  else
    record ok 'runs as a non-root user' "uid $uid"
  fi

  node_env="$(docker run --rm --entrypoint sh "$IMAGE" -c 'printf %s "$NODE_ENV"')"
  if [ "$node_env" = 'production' ]; then
    record ok 'NODE_ENV is production'
  else
    record fail 'NODE_ENV is production' "found '${node_env:-empty}'"
  fi
fi
say ''

# --- 3. secret hygiene -----------------------------------------------------

say '3. no key in the image, and none in the browser bundle'
prefix_hits=''
name_hits=''
value_hits=''
if [ "$DRY_RUN" = 1 ]; then
  say '    would run: docker run --rm --entrypoint sh <image> -c "grep -rl -- AIza /app"'
  say '    would run: the same, for GEMINI_API_KEY in the client bundle and for the'
  say '               live key value from this shell'
else
  # The provider's key prefix. Empty output is the expected result.
  prefix_hits="$(docker run --rm --entrypoint sh "$IMAGE" -c 'grep -rl -- "AIza" /app 2>/dev/null || true')"
  # The variable's name in anything a browser could fetch. `pnpm check:bundle`
  # makes this claim about .next/static on the build host; this repeats it inside
  # the artefact the deployment actually runs.
  name_hits="$(docker run --rm --entrypoint sh "$IMAGE" -c 'grep -rl -- "GEMINI_API_KEY" /app/apps/web/.next/static /app/apps/web/public 2>/dev/null || true')"
  # The deployed key itself, if this shell holds one, compared without printing it.
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    value_hits="$(docker run --rm -e CIVORA_PROBE_VALUE="$GEMINI_API_KEY" --entrypoint sh "$IMAGE" \
      -c 'grep -rl -- "$CIVORA_PROBE_VALUE" /app 2>/dev/null || true')"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  say ''
else
  if [ -z "$prefix_hits" ]; then
    record ok 'no API-key prefix anywhere in the image'
  else
    record fail 'no API-key prefix anywhere in the image' "matches: $prefix_hits"
  fi
  if [ -z "$name_hits" ]; then
    record ok 'no key name in the browser bundle'
  else
    record fail 'no key name in the browser bundle' "matches: $name_hits"
  fi
  if [ -z "${GEMINI_API_KEY:-}" ]; then
    say '    note  GEMINI_API_KEY is not set in this shell, so the value comparison was skipped'
  elif [ -z "$value_hits" ]; then
    record ok 'the live key value is not in the image'
  else
    record fail 'the live key value is not in the image' "matches: $value_hits"
  fi
  say ''
fi

# --- 4. it answers ---------------------------------------------------------

say '4. the container answers its probes'
if [ "$DRY_RUN" = 1 ]; then
  say "    would run: docker run --detach --publish $PORT:3000 $IMAGE"
  say "    would run: curl --fail http://127.0.0.1:$PORT/healthz, then /readyz"
else
  container_id="$(docker run --detach --publish "$PORT:3000" "$IMAGE")"

  health=''
  for _ in $(seq 1 30); do
    if health="$(curl --silent --fail "http://127.0.0.1:$PORT/healthz" 2>/dev/null)"; then
      break
    fi
    sleep 1
  done

  if [ -z "$health" ]; then
    record fail 'answers /healthz' "no answer on http://127.0.0.1:$PORT/healthz within 30s"
  else
    record ok 'answers /healthz' "$health"
  fi

  readiness="$(curl --silent "http://127.0.0.1:$PORT/readyz" 2>/dev/null || true)"
  if [ -z "$readiness" ]; then
    record fail 'answers /readyz'
  else
    record ok 'answers /readyz' "$readiness"
  fi

  if [ "$KEEP_RUNNING" = 1 ]; then
    say "    the container is left running on port $PORT (image $IMAGE); remove it with"
    say "        docker rm --force $container_id"
    container_id=''
  fi
fi
say ''

# --- 5. summary ------------------------------------------------------------

if [ "$DRY_RUN" = 1 ]; then
  say 'Dry run complete: nothing was built, started or checked.'
  exit 0
fi

if [ "$FAILURES" -gt 0 ]; then
  say "$FAILURES check(s) failed. Do not deploy this image."
  exit 1
fi

say 'Every check passed. The image runs as a non-root user, carries no key, and answers'
say 'its probes — which is what infra/deploy.sh hands to Cloud Run.'
