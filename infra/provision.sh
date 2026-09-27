#!/usr/bin/env bash
#
# Civora — provision the Google Cloud side of the deployment.
#
#     bash infra/provision.sh --dry-run      # print every step, execute nothing
#     CIVORA_GCP_PROJECT=civora-demo \
#     CIVORA_BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
#       bash infra/provision.sh
#
# Idempotent by construction: every step asks whether its resource exists before
# creating it, so a second run reports "already present" and changes nothing.
# That is the property the phase's checklist asks to see recorded, and it is why
# each step is an existence test rather than a create.
#
# `--dry-run` is not a toy. It prints the exact `gcloud` invocation of every step
# and executes none of them, so the plan can be read and reviewed on a machine
# with no SDK, no account and no project — which is the machine this was written
# on. In dry-run mode the existence questions are not asked either: a plan that
# performs reads is not a plan.
#
# Environment:
#   CIVORA_GCP_PROJECT      the project id. Required unless `gcloud config get-value project` answers.
#   CIVORA_GCP_REGION       default `asia-south1` (Mumbai): the demonstration network is Indian.
#   CIVORA_BILLING_ACCOUNT  optional. Without it the billing link and the budget alert step are
#                           skipped with a sentence naming what remains undone.
#   CIVORA_BUDGET_USD       default `5`. The monthly budget-alert amount in US dollars.
#   GEMINI_API_KEY          optional. Stored as a secret version, never on a command line.
#   GEMINI_MODEL            optional. Stored as a secret version.
#
# Exit: 0 provisioned or planned · 1 a step failed · 3 a prerequisite is missing.

set -euo pipefail

DRY_RUN=0

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $argument (try --dry-run, or --help)" >&2
      exit 3
      ;;
  esac
done

PROJECT="${CIVORA_GCP_PROJECT:-}"
REGION="${CIVORA_GCP_REGION:-asia-south1}"
BILLING_ACCOUNT="${CIVORA_BILLING_ACCOUNT:-}"
BUDGET_USD="${CIVORA_BUDGET_USD:-5}"
BUDGET_NAME="civora-monthly-alert"
SERVICE_ACCOUNT_NAME="civora-run"
ARTIFACT_REPOSITORY="civora"

say() { printf '%s\n' "$*"; }
# A step that failed, and a prerequisite that is not there: two exit codes,
# because a caller deciding whether to retry wants to tell them apart.
fail() {
  printf '\n%s\n' "$*" >&2
  exit 1
}
missing() {
  printf '\n%s\n' "$*" >&2
  exit 3
}

have_gcloud() { command -v gcloud >/dev/null 2>&1; }

# How a command is printed. Arguments a shell would interpret are quoted, so a
# line copied out of the plan behaves exactly like the line that would have run.
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

# The single place a command is executed. In dry-run it is printed instead, so
# the plan printed here and the plan that runs cannot drift apart.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '    would run: %s\n' "$(printable "$@")"
    return 0
  fi
  printf '    $ %s\n' "$(printable "$@")"
  "$@"
}

# A command whose value is passed on stdin rather than as an argument, so a
# secret never appears in an argument list, a process table or a shell history.
run_with_stdin() {
  local value="$1"
  shift
  if [ "$DRY_RUN" = 1 ]; then
    printf '    would run: %s   (value piped on stdin, never an argument)\n' "$*"
    return 0
  fi
  printf '    $ %s   (value piped on stdin)\n' "$*"
  printf '%s' "$value" | "$@"
}

# A read-only existence question. In dry-run nothing is asked, so the answer is
# "no", which makes the step print what it would do.
present() {
  [ "$DRY_RUN" = 0 ] && have_gcloud && "$@" >/dev/null 2>&1
}

if [ "$DRY_RUN" = 0 ]; then
  have_gcloud ||
    missing 'gcloud was not found. Install the Google Cloud SDK (https://cloud.google.com/sdk/docs/install)
and authenticate (`gcloud auth login`), then run this script again. Nothing has been changed.'
  if [ -z "$PROJECT" ]; then
    PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  [ -n "$PROJECT" ] && [ "$PROJECT" != "(unset)" ] ||
    missing 'no project id. Set CIVORA_GCP_PROJECT, or run `gcloud config set project`. Nothing has been changed.'
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -n 1 || true)"
  [ -n "$account" ] ||
    missing 'no active gcloud account. Run `gcloud auth login`, then run this script again. Nothing has been changed.'
else
  [ -n "$PROJECT" ] || PROJECT='<CIVORA_GCP_PROJECT>'
fi

say 'Civora — provisioning plan'
say "    project  $PROJECT"
say "    region   $REGION"
say "    billing  ${BILLING_ACCOUNT:-<not given: billing link and budget alert will be skipped>}"
say "    budget   \$$BUDGET_USD/month alert, if a billing account is given"
if [ "$DRY_RUN" = 1 ]; then
  say '    mode     dry run — every step is printed and none is executed'
fi
say ''

# --- 1. the project --------------------------------------------------------

say '1. project'
if present gcloud projects describe "$PROJECT"; then
  say '    already present'
else
  run gcloud projects create "$PROJECT" --name=Civora
fi
say ''

# --- 2. billing ------------------------------------------------------------

say '2. billing account link'
if [ -z "$BILLING_ACCOUNT" ]; then
  say '    skipped: no CIVORA_BILLING_ACCOUNT was given.'
  say '    Undone: linking billing, and the budget alert below. Both are in'
  say '    docs/DEPLOYMENT.md §4; a project without billing cannot deploy Cloud Run.'
else
  linked=''
  if [ "$DRY_RUN" = 0 ]; then
    linked="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' 2>/dev/null || true)"
  fi
  if [ "$linked" = "billingAccounts/$BILLING_ACCOUNT" ]; then
    say '    already present'
  else
    run gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
  fi
fi
say ''

# --- 3. services -----------------------------------------------------------

say '3. service APIs'
# One `services enable` for the set is idempotent: enabling an enabled service
# is a no-op, so this step needs no existence test per API.
run gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  firebase.googleapis.com \
  bigquery.googleapis.com \
  --project="$PROJECT"
say ''

# --- 4. the operational store ---------------------------------------------

say '4. Firestore database (native mode)'
if present gcloud firestore databases describe --database='(default)' --project="$PROJECT"; then
  say '    already present'
else
  run gcloud firestore databases create \
    --database='(default)' \
    --location="$REGION" \
    --type=firestore-native \
    --project="$PROJECT"
fi
say ''

# --- 5. the image repository ----------------------------------------------

say '5. Artifact Registry repository for the image'
if present gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
  --location="$REGION" --project="$PROJECT"; then
  say '    already present'
else
  run gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --description='Civora container images' \
    --project="$PROJECT"
fi
say ''

# --- 6. secrets ------------------------------------------------------------

say '6. Secret Manager'
say '    A secret is created once and a version is added only when the local value'
say '    differs from the latest stored one, so re-running does not spend versions.'
say '    The value is piped on stdin; it is never an argument and never printed.'

ensure_secret() {
  local name="$1" value="$2"

  if present gcloud secrets describe "$name" --project="$PROJECT"; then
    say "    $name: secret already present"
  else
    run gcloud secrets create "$name" \
      --replication-policy=automatic \
      --labels=app=civora \
      --project="$PROJECT"
  fi

  if [ "$DRY_RUN" = 1 ]; then
    run_with_stdin '<value>' gcloud secrets versions add "$name" --data-file=- --project="$PROJECT"
    return 0
  fi

  if [ -z "$value" ]; then
    say "    $name: no local value given; the latest stored version is left as it is"
    return 0
  fi

  local current
  current="$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT" 2>/dev/null || true)"
  if [ "$current" = "$value" ]; then
    say "    $name: latest version already matches the local value; nothing added"
  else
    run_with_stdin "$value" gcloud secrets versions add "$name" --data-file=- --project="$PROJECT"
  fi
}

ensure_secret GEMINI_API_KEY "${GEMINI_API_KEY:-}"
ensure_secret GEMINI_MODEL "${GEMINI_MODEL:-}"
say ''

# --- 7. the identity the service runs as ----------------------------------

say "7. service account $SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com"
if present gcloud iam service-accounts describe \
  "$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com" --project="$PROJECT"; then
  say '    already present'
else
  run gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --display-name='Civora Cloud Run service' \
    --project="$PROJECT"
fi

member="serviceAccount:$SERVICE_ACCOUNT_NAME@$PROJECT.iam.gserviceaccount.com"

# It reads the Gemini key and nothing else: no editor role, no project-wide
# permission. Setting a binding that is already set is a no-op, so this step is
# idempotent without an existence test.
run gcloud secrets add-iam-policy-binding GEMINI_API_KEY \
  --member="$member" \
  --role='roles/secretmanager.secretAccessor' \
  --project="$PROJECT"
run gcloud secrets add-iam-policy-binding GEMINI_MODEL \
  --member="$member" \
  --role='roles/secretmanager.secretAccessor' \
  --project="$PROJECT"
run gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPOSITORY" \
  --location="$REGION" \
  --member="$member" \
  --role='roles/artifactregistry.reader' \
  --project="$PROJECT"

# Cloud Build pushes the image it builds, so its own service account needs write
# access to the repository. This is the one grant that depends on the project
# number rather than the project id.
project_number='<project number>'
if [ "$DRY_RUN" = 0 ]; then
  project_number="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
fi
run gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$project_number@cloudbuild.gserviceaccount.com" \
  --role='roles/artifactregistry.writer' \
  --condition=None \
  --project="$PROJECT"
say ''

# --- 8. the budget alert ---------------------------------------------------

say '8. budget alert'
if [ -z "$BILLING_ACCOUNT" ]; then
  say '    skipped: no CIVORA_BILLING_ACCOUNT was given.'
  say "    Undone: the monthly alert at 50% / 90% / 100% of \$$BUDGET_USD."
  say '    An alert is a notification, not a spending cap; the real guards are'
  say '    min-instances=0 and the max-instances ceiling infra/deploy.sh sets.'
else
  existing='0'
  if [ "$DRY_RUN" = 0 ]; then
    existing="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
      --format='value(displayName)' 2>/dev/null | grep -cx "$BUDGET_NAME" || true)"
  fi
  if [ "$existing" != '0' ]; then
    say "    already present: $BUDGET_NAME"
  else
    run gcloud billing budgets create \
      --billing-account="$BILLING_ACCOUNT" \
      --display-name="$BUDGET_NAME" \
      --budget-amount="${BUDGET_USD}USD" \
      --calendar-period=month \
      --threshold-rule=percent=0.5 \
      --threshold-rule=percent=0.9 \
      --threshold-rule=percent=1.0 \
      --filter-projects="projects/$PROJECT"
  fi
  say '    note: a budget alert notifies; it does not stop spend.'
fi
say ''

# --- 9. done ---------------------------------------------------------------

say 'Provisioning complete.'
if [ "$DRY_RUN" = 1 ]; then
  say 'This was a dry run: nothing was created, changed or charged.'
  say 'Remove --dry-run on a machine with the SDK and an authenticated account to apply it.'
else
  say 'Re-run this script to prove idempotency: every step should answer "already present".'
fi
say ''
say 'Next:'
say '    bash infra/check-image.sh     # local image check (needs a container runtime)'
say '    bash infra/deploy.sh          # build in the cloud, deploy to Cloud Run'
