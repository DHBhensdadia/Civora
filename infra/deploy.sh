#!/usr/bin/env bash
#
# Civora — build the image and deploy it to Cloud Run.
#
#     bash infra/deploy.sh --dry-run          # print every step, execute nothing
#     CIVORA_GCP_PROJECT=civora-demo bash infra/deploy.sh
#     CIVORA_GCP_PROJECT=civora-demo bash infra/deploy.sh --warm --smoke
#
# The build happens in Cloud Build by default, so this script does not need a
# Docker daemon on the machine that runs it. Building on the same host instead is
# `CIVORA_BUILD=local bash infra/deploy.sh`, which does.
#
# What this script deliberately sets, and why:
#
#   --min-instances=0        scale to zero. An idle instance over an evaluation
#                            window is the one way this deployment could produce a
#                            real bill; see docs/DEPLOYMENT.md §5.
#   --max-instances=2        a ceiling on runaway scale, in front of the budget alert.
#   --set-secrets=...        the Gemini key and model are *bindings* from Secret
#                            Manager. They are never a file, never an image layer,
#                            never an environment value in this repository.
#   --startup-probe=/healthz the platform answers a health check with no cloud
#                            credentials configured, so the probe is honest.
#
# Environment:
#   CIVORA_GCP_PROJECT             required, unless `gcloud config get-value project` answers
#   CIVORA_GCP_REGION              default `asia-south1`
#   CIVORA_SERVICE                 default `civora-web`
#   CIVORA_REASONING_PROVIDER      default `gemini`; `fixture` deploys without a key
#   CIVORA_MIN_INSTANCES           default 0; 1 keeps the instance and its advisory set warm
#   CIVORA_BUILD                   `cloud` (default) or `local`
#   GEMINI_MODEL                   only used to say which model the deployment pins
#
# Exit: 0 deployed or planned · 1 a step failed · 3 a prerequisite is missing.

set -euo pipefail

DRY_RUN=0
WARM=0
SMOKE=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --warm) WARM=1 ;;
    --smoke) SMOKE=1 ;;
    -h | --help)
      sed -n '3,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $argument (try --dry-run, --warm, --smoke or --help)" >&2
      exit 3
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT="${CIVORA_GCP_PROJECT:-}"
REGION="${CIVORA_GCP_REGION:-asia-south1}"
SERVICE="${CIVORA_SERVICE:-civora-web}"
REASONING_PROVIDER="${CIVORA_REASONING_PROVIDER:-gemini}"
MIN_INSTANCES="${CIVORA_MIN_INSTANCES:-0}"
BUILD="${CIVORA_BUILD:-cloud}"
ARTIFACT_REPOSITORY="civora"
SERVICE_ACCOUNT_NAME="civora-run"
MODEL_NOTE="${GEMINI_MODEL:-gemini-3.1-flash-lite}"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}
missing() {
  printf '\n%s\n' "$*" >&2
  exit 3
}

have_gcloud() { command -v gcloud >/dev/null 2>&1; }

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

if [ "$DRY_RUN" = 0 ]; then
  have_gcloud ||
    missing 'gcloud was not found. Install the Google Cloud SDK and authenticate, or run with
--dry-run to read the plan. Nothing has been changed.'
  if [ -z "$PROJECT" ]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] ||
    missing 'no project id. Set CIVORA_GCP_PROJECT, or run `gcloud config set project`. Nothing has been changed.'
else
  [ -n "$PROJECT" ] || PROJECT='<CIVORA_GCP_PROJECT>'
fi

IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${ARTIFACT_REPOSITORY}/web"
if have_gcloud && [ "$DRY_RUN" = 0 ]; then
  TAG="$(git rev-parse --short HEAD)"
else
  TAG='<short-sha>'
fi

say 'Civora — deployment plan'
say "    project   $PROJECT"
say "    region    $REGION"
say "    service   $SERVICE"
say "    image     $IMAGE:$TAG"
say "    build     $BUILD"
say "    reasoning $REASONING_PROVIDER (model pinned: $MODEL_NOTE)"
say "    scaling   min-instances=$MIN_INSTANCES, max-instances=2, 1 vCPU, 512 MiB"
if [ "$DRY_RUN" = 1 ]; then
  say '    mode      dry run — every step is printed and none is executed'
fi
say ''

# --- 1. the image ----------------------------------------------------------

say '1. build the image'
if [ "$BUILD" = 'local' ]; then
  command -v docker >/dev/null 2>&1 || missing 'CIVORA_BUILD=local needs docker on this machine.
Nothing has been changed; the default (cloud) build does not need a daemon.'
  run docker build --file=infra/Dockerfile --tag="$IMAGE:$TAG" --tag="$IMAGE:latest" .
  run docker push "$IMAGE:$TAG"
  run docker push "$IMAGE:latest"
else
  run gcloud builds submit \
    --config=infra/cloudbuild.yaml \
    --substitutions="_IMAGE=$IMAGE,_TAG=$TAG" \
    --project="$PROJECT" \
    .
fi
say ''

# --- 2. the service --------------------------------------------------------

say '2. deploy the service'

env_vars="NODE_ENV=production"
env_vars="$env_vars,CIVORA_DATA_PROVIDER=in-memory"
env_vars="$env_vars,CIVORA_AUTH_PROVIDER=fixture"
env_vars="$env_vars,CIVORA_REASONING_PROVIDER=$REASONING_PROVIDER"

deploy=(gcloud run deploy "$SERVICE"
  --project="$PROJECT"
  --region="$REGION"
  --image="$IMAGE:$TAG"
  --platform=managed
  --allow-unauthenticated
  --port=3000
  --cpu=1
  --memory=512Mi
  --concurrency=40
  --timeout=300
  --min-instances="$MIN_INSTANCES"
  --max-instances=2
  --labels=app=civora,component=web
  --set-env-vars="$env_vars"
  --startup-probe="httpGet.path=/healthz,httpGet.port=3000,initialDelaySeconds=5,timeoutSeconds=3,periodSeconds=5,failureThreshold=12"
  --liveness-probe="httpGet.path=/healthz,httpGet.port=3000,timeoutSeconds=3,periodSeconds=30,failureThreshold=3")

if [ "$REASONING_PROVIDER" = 'gemini' ]; then
  # A binding, not a value: the platform reads GEMINI_API_KEY and GEMINI_MODEL
  # from the environment Secret Manager fills in. `infra/provision.sh` creates
  # both secrets and grants this service account access to them.
  deploy+=(--service-account="$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com")
  deploy+=(--set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,GEMINI_MODEL=GEMINI_MODEL:latest")
else
  say '    note: reasoning is the fixture adapter, so no secret is bound and no model is called.'
fi

run "${deploy[@]}"
say ''

# --- 3. the URL ------------------------------------------------------------

say '3. the URL'
url=''
if [ "$DRY_RUN" = 1 ]; then
  say '    would run: gcloud run services describe ... --format=value(status.url)'
  url='<service url>'
else
  url="$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
  say "    $url"
fi
say ''

# --- 4. warm the advisory set ---------------------------------------------

say '4. warm the advisory set'
if [ "$WARM" = 0 ]; then
  say '    skipped. Pass --warm to write the demonstration advisory set once, now,'
  say '    rather than when a reviewer first opens the panel. It spends real quota:'
  say '    one pass is six calls (three alerts × two languages) against the measured'
  say '    free-tier ceiling of twenty requests a day per model.'
else
  if [ "$DRY_RUN" = 1 ]; then
    say "    would run: curl -sS \"$url/api/advisories\""
  else
    run curl -sS "$url/api/advisories"
  fi
fi
say ''

# --- 5. smoke --------------------------------------------------------------

say '5. the live smoke test'
if [ "$DRY_RUN" = 1 ]; then
  say "    would run: CIVORA_LIVE_URL=$url pnpm e2e live-smoke.spec.ts"
elif [ "$SMOKE" = 0 ]; then
  say '    skipped. Run it with --smoke, or by hand:'
  say "        CIVORA_LIVE_URL=$url pnpm e2e live-smoke.spec.ts"
else
  run env CIVORA_LIVE_URL="$url" pnpm e2e live-smoke.spec.ts
fi
say ''

say 'Deployment complete.'
if [ "$DRY_RUN" = 1 ]; then
  say 'This was a dry run: nothing was built, deployed or charged.'
fi
if [ "$REASONING_PROVIDER" = 'gemini' ]; then
  say 'The Gemini key is a Secret Manager binding on this service. It is not in the'
  say 'image, not in this repository and not in the environment of any shell here.'
fi
say 'Record the URL and the smoke result in state/RUN_STATE.md; ADR 0006 governs what'
say 'may be claimed about it.'
