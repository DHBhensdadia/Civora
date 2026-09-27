#!/usr/bin/env bash
#
# Civora — tear the deployment down, and stop what costs money.
#
#     bash infra/teardown.sh --dry-run        # print every step, execute nothing
#     CIVORA_GCP_PROJECT=civora-demo bash infra/teardown.sh
#     CIVORA_GCP_PROJECT=civora-demo bash infra/teardown.sh --delete-secrets
#
# What it deletes:
#
#   - the Cloud Run service (this is the thing that bills by the second);
#   - the Artifact Registry repository and the images in it (storage is billed
#     per GiB-month).
#
# What it keeps unless told otherwise, and why:
#
#   - the Secret Manager secrets and their versions. They are the Gemini key and
#     the pinned model; deleting them means re-provisioning before any redeploy,
#     and they cost nothing while nothing reads them.
#   - the Firestore database. It is inside the always-free allowance for the
#     shape this deployment uses and holds whatever was written to it.
#   - the project and its billing link. Costs nothing on its own once the service
#     is gone.
#
# `--delete-project` removes everything including the project, behind an
# explicit confirmation word, because it cannot be undone.
#
# Exit: 0 torn down or planned · 1 a step failed · 3 a prerequisite is missing.

set -euo pipefail

DRY_RUN=0
DELETE_PROJECT=0
DELETE_SECRETS=0
CONFIRM=''

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --delete-secrets) DELETE_SECRETS=1 ;;
    --delete-project) DELETE_PROJECT=1 ;;
    --confirm)
      CONFIRM="${2:-}"
      [ -n "$CONFIRM" ] || fail '--confirm needs the project id after it, e.g. --confirm civora-demo'
      ;;
    -h | --help)
      sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $argument (try --dry-run, --delete-secrets, --delete-project or --help)" >&2
      exit 3
      ;;
  esac
done

PROJECT="${CIVORA_GCP_PROJECT:-}"
REGION="${CIVORA_GCP_REGION:-asia-south1}"
SERVICE="${CIVORA_SERVICE:-civora-web}"
ARTIFACT_REPOSITORY="civora"
SERVICE_ACCOUNT_NAME="civora-run"

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


present() {
  [ "$DRY_RUN" = 0 ] && have_gcloud && "$@" >/dev/null 2>&1
}

# The destructive path asks for its confirmation before anything else is read or
# reached, and names the project from the environment rather than from the SDK: a
# refusal must not depend on a tool that may not be there.
if [ "$DELETE_PROJECT" = 1 ]; then
  [ -n "$PROJECT" ] ||
    missing '--delete-project needs CIVORA_GCP_PROJECT set, because the confirmation is the project id.
Nothing has been changed.'
  if [ "$CONFIRM" != "$PROJECT" ]; then
    say 'Refusing: --delete-project removes the project and everything in it, irreversibly.'
    say "To confirm, pass --confirm $PROJECT on the command line. Nothing has been changed."
    exit 3
  fi
fi

if [ "$DRY_RUN" = 0 ]; then
  have_gcloud ||
    missing 'gcloud was not found. Nothing has been changed. Use --dry-run to read the plan.'
  if [ -z "$PROJECT" ]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] ||
    missing 'no project id. Set CIVORA_GCP_PROJECT. Nothing has been changed.'
else
  [ -n "$PROJECT" ] || PROJECT='<CIVORA_GCP_PROJECT>'
fi

say 'Civora — teardown plan'
say "    project  $PROJECT"
say "    region   $REGION"
say "    service  $SERVICE"
if [ "$DRY_RUN" = 1 ]; then
  say '    mode     dry run — every step is printed and none is executed'
fi
say ''

say '1. the Cloud Run service'
if present gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT"; then
  run gcloud run services delete "$SERVICE" --region="$REGION" --project="$PROJECT" --quiet
else
  say '    nothing to delete'
fi
say ''

say '2. the image repository (and the images in it)'
if present gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
  --location="$REGION" --project="$PROJECT"; then
  run gcloud artifacts repositories delete "$ARTIFACT_REPOSITORY" \
    --location="$REGION" --project="$PROJECT" --quiet
else
  say '    nothing to delete'
fi
say ''

say '3. the service account'
if present gcloud iam service-accounts describe \
  "$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT"; then
  run gcloud iam service-accounts delete \
    "$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT" --quiet
else
  say '    nothing to delete'
fi
say ''

say '4. secrets'
if [ "$DELETE_SECRETS" = 0 ]; then
  say '    kept: GEMINI_API_KEY and GEMINI_MODEL. They cost nothing while nothing reads'
  say '    them, and keeping them means a redeploy needs no key handling. Pass'
  say '    --delete-secrets to remove them instead.'
else
  for name in GEMINI_API_KEY GEMINI_MODEL; do
    if present gcloud secrets describe "$name" --project="$PROJECT"; then
      run gcloud secrets delete "$name" --project="$PROJECT" --quiet
    else
      say "    $name: nothing to delete"
    fi
  done
fi
say ''

say '5. the project'
if [ "$DELETE_PROJECT" = 0 ]; then
  say '    kept. Deleting a project is irreversible and is not needed to stop spend —'
  say '    the service above is what bills. If no billing account should remain linked:'
  say "        gcloud billing projects unlink $PROJECT"
else
  run gcloud projects delete "$PROJECT" --quiet
fi
say ''

say 'Teardown complete.'
if [ "$DRY_RUN" = 1 ]; then
  say 'This was a dry run: nothing was deleted.'
fi
say 'After a teardown, the live link in README.md and state/RUN_STATE.md no longer answers.'
say 'ADR 0006: say that plainly rather than leaving a URL that is dead.'
