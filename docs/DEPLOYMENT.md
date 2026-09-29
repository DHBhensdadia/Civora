# Deployment

> **Status: there is no live deployment.** The machine this repository was built on has
> no Google Cloud project, no billing account and no running container runtime
> (`Workspace/state/BLOCKERS.md` B1 and B8, outside this repository), so the steps
> below are scripted, reviewed and dry-run, but **not one of them has been executed
> against a real project**, and the non-Google fallback chosen for the demonstration (§8) is
> declared but not yet created. Every statement in this document is either a command that
> was run (`infra/*.sh --dry-run`, recorded in §10) or a fact read from the vendor's
> own page on the date named beside it. Where something is unverified, it says so.

This document is the reproduction path for the deployment described in **ADR 0008**
(Cloud Run plus Firebase, with a documented non-Google fallback). The decisions, phase
plans and state files referenced here live in the project workspace that accompanies
this repository, not inside it; the scripts are in [`infra/`](../infra).

## 1. What is deployed, and in what shape

One container: the Next.js application in its standalone output, serving the pages, the
API routes and its own static assets. Nothing else is required for the demonstration to
work.

| Concern                | Demonstration deployment (what `infra/deploy.sh` sets)                         | Ministry pilot (same image, different bindings)      |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Web + API              | Cloud Run service `civora-web`, `min-instances=0`                              | Same, larger instance and a higher `--max-instances` |
| Data                   | `CIVORA_DATA_PROVIDER=in-memory` — the deterministic seed, rebuilt per process | `CIVORA_DATA_PROVIDER=firestore`                     |
| Identity               | `CIVORA_AUTH_PROVIDER=fixture` — selectable demo identities                    | `CIVORA_AUTH_PROVIDER=firebase`                      |
| Reasoning              | `CIVORA_REASONING_PROVIDER=gemini`, key from Secret Manager                    | Same, on a paid key or Vertex AI                     |
| Scheduler / batch jobs | not deployed; the commands run locally (`pnpm worker:score`, `pnpm fl:run`)    | Cloud Run Jobs + Cloud Scheduler                     |
| Analytics              | none                                                                           | BigQuery, when a project exists for it               |

The demonstration shape is deliberate and is itself the deployability argument: every
external boundary is a port (ADR 0004), so the pilot column is configuration, not a
rewrite. What is _not_ the same between the columns is the data: the deployed
demonstration serves the generated network and says so on every surface.

## 2. Prerequisites

| Prerequisite                            | Needed for                                           | Notes                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gcloud` (Google Cloud SDK)             | provisioning and deploying                           | **Not installed on the author's machine as of 2026-09-27.** Install per the SDK page, then `gcloud auth login`                           |
| A Render account (the fallback host)    | only §8 — the non-Google fallback                    | Free, no credit card. The Blueprint is created once, from the Dashboard, which is also where `GEMINI_API_KEY` is prompted for (ADR 0010) |
| A Google Cloud project                  | everything                                           | `infra/provision.sh` creates one if the id is free                                                                                       |
| A billing account with a spending limit | Cloud Run, Artifact Registry, Cloud Build            | A project without billing cannot deploy; the scripts say which steps they skipped                                                        |
| A Gemini API key                        | the reasoning layer                                  | `GEMINI_API_KEY`; see §6. Phase 5's live evidence is `Workspace/state/RUN_STATE.md` §3f                                                  |
| `docker` + a running daemon             | only `infra/check-image.sh` and `CIVORA_BUILD=local` | The cloud build needs no daemon; a daemon is not running on the author's machine (B8)                                                    |
| Node 22+ and `pnpm`                     | building locally and running the smoke test          | `pnpm install --frozen-lockfile` first                                                                                                   |

`jq` is convenient for reading JSON output and is not required.

## 3. Step by step

### 3.1 Read the plan first — no credentials needed

```bash
CIVORA_GCP_PROJECT=civora-demo bash infra/provision.sh --dry-run
CIVORA_GCP_PROJECT=civora-demo bash infra/deploy.sh --dry-run
```

Both print every `gcloud` invocation they would make and execute none of them, including
the read-only existence checks. This is how the plan below can be reviewed on a machine
that has no SDK at all — and it is what was run to write this document.

### 3.2 Provision

```bash
CIVORA_GCP_PROJECT=civora-demo \
CIVORA_BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
GEMINI_API_KEY="$GEMINI_API_KEY" \
GEMINI_MODEL=gemini-3.1-flash-lite \
  bash infra/provision.sh
```

Creates, or verifies if present: the project; the billing link; the APIs
(`run`, `artifactregistry`, `cloudbuild`, `secretmanager`, `firestore`, `firebase`,
`bigquery`); a Firestore database in native mode; an Artifact Registry repository for the
image; the `GEMINI_API_KEY` and `GEMINI_MODEL` secrets; a service account `civora-run`
with `secretmanager.secretAccessor` on those two secrets and `artifactregistry.reader` on
the repository; and a monthly budget alert.

**Expected on a second run:** every step answers `already present`, and a secret whose
stored value already matches the local one reports `nothing added`. That is the
idempotency the phase's checklist asks to see recorded. A stored value that differs adds
a _version_ rather than overwriting, so the previous one remains readable.

**Without `CIVORA_BILLING_ACCOUNT`:** steps 2 and 8 print what they skipped and the
script still completes, because a project with no billing can be created and inspected.

### 3.3 Check the image locally (optional, needs a daemon)

```bash
bash infra/check-image.sh
```

Builds `infra/Dockerfile` from the repository root and asserts four things before the
image is ever deployed: the container runs as a non-root user; `NODE_ENV` is
`production`; the image contains neither the `AIza` key prefix, nor the value of
`GEMINI_API_KEY` from the shell, nor a key name in the browser bundle; and the container
answers `/healthz` and `/readyz` on the port it exposes. With no daemon it exits `3` with
one sentence rather than reporting a check it did not perform.

### 3.4 Build and deploy

```bash
CIVORA_GCP_PROJECT=civora-demo bash infra/deploy.sh --warm
```

Builds the image in Cloud Build from [`infra/cloudbuild.yaml`](../infra/cloudbuild.yaml)
(the same Dockerfile and the same context a local build uses, so the two paths cannot
diverge) and deploys it:

| Flag                      | Value                            | Why                                                                                                     |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--min-instances`         | `0`                              | Scale to zero: an idle instance over an evaluation window is the one way this could produce a real bill |
| `--max-instances`         | `2`                              | A ceiling on runaway scale, in front of the budget alert                                                |
| `--cpu` / `--memory`      | `1` / `512Mi`                    | Enough for the demo; the smallest defensible size                                                       |
| `--concurrency`           | `40`                             | The work is mostly waiting on a store                                                                   |
| `--allow-unauthenticated` | —                                | The submission requires a link a judge can open                                                         |
| `--startup-probe`         | `httpGet /healthz:3000`          | `/healthz` answers with no cloud credentials configured, so the probe is honest                         |
| `--set-secrets`           | `GEMINI_API_KEY`, `GEMINI_MODEL` | Bindings from Secret Manager (§6)                                                                       |
| `--service-account`       | `civora-run@…`                   | Reads the two secrets and nothing else                                                                  |
| `--set-env-vars`          | provider selection + `NODE_ENV`  | The demonstration configuration in §1                                                                   |

**Expected output:** `Service [civora-web] revision [civora-web-00001-…] has been deployed
and is serving 100% of traffic`, then the service URL, which the script prints.

### 3.5 Warm the advisory set

`--warm` asks the deployed instance for its advisory set once, so prose written by the
model exists before a reviewer opens the panel rather than arriving while they watch.
This spends real quota: **one pass is six calls** (three seeded alerts × two carried
languages). See §6 for the measured ceiling and what it means.

### 3.6 Smoke-test the live URL

```bash
CIVORA_LIVE_URL="https://civora-web-….run.app" pnpm e2e live-smoke.spec.ts
```

[`e2e/live-smoke.spec.ts`](../e2e/live-smoke.spec.ts) runs against the deployed URL and
nothing else: `/healthz` and `/readyz`, the seeded world and its fingerprint, the alerts
the pipeline has raised, and the golden path to a recorded decision — with the refusals
that must not be bypassed. **With `CIVORA_LIVE_URL` unset it skips and prints why**, so
`pnpm e2e` stays green and honest while no deployment exists.

## 4. Secrets

- The Gemini key and the pinned model live in **Secret Manager**, bound to the service as
  environment variables by `--set-secrets`. They are not in this repository, not in the
  image and not in a `.env` file on the deployed host. `.env.example` carries
  placeholders only.
- `infra/provision.sh` pipes a secret value on **stdin**; it never appears as an argument,
  so it does not appear in a process table or a shell history.
- Two standing checks that no key reaches a browser or an image layer:
  `pnpm check:bundle` (the client bundle, run on every gate) and
  `bash infra/check-image.sh` (§3.3, needs a daemon).
- **Rotate the key after the submission window.** The current one was pasted into a chat
  message; a new version in Secret Manager is one command
  (`gcloud secrets versions add GEMINI_API_KEY --data-file=-`) and no redeploy, because
  the binding is `:latest` — a redeploy only makes the new version certain everywhere.
- If a deploy reports that the service cannot read a secret, the Cloud Run _service
  agent_ also needs access; the fix is documented in the error and is a one-line
  `add-iam-policy-binding`.

## 5. Cost: the free-tier shape, and the ceiling

Figures in this table were read from the vendors' own pages on **2026-09-27**; quotas
change and the console is authoritative. The arithmetic in the right-hand column is ours.

| Service                | Always-free allowance                                                                                                                                                      | What the demonstration uses, and the arithmetic                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Run              | 2,000,000 requests, 180,000 vCPU-seconds, 360,000 GiB-seconds per month, aggregated across the billing account ([Cloud Run pricing](https://cloud.google.com/run/pricing)) | With `min-instances=0` and request-based billing, an idle instance costs nothing. A reviewer visit that processes 60 s of work at 1 vCPU / 512 MiB consumes 60 vCPU-s and 30 GiB-s — so the allowance is thousands of visits. **This is why scale-to-zero is the default**            |
| Cloud Run, kept warm   | —                                                                                                                                                                          | One always-on 1 vCPU / 512 MiB instance for 30 days is 2,592,000 vCPU-s and 1,296,000 GiB-s: **14× the monthly vCPU allowance and 3.6× the GiB allowance**, i.e. it is a paid configuration. `CIVORA_MIN_INSTANCES=1` is for the judging window only, with the budget alert set first |
| Firestore              | 1 GiB stored, 50,000 document reads, 20,000 document writes **per day**, per project ([Firestore pricing](https://cloud.google.com/firestore/pricing))                     | Not used by the demonstration configuration (§1). The pilot shape's daily writes are a fraction of this at demonstration volume                                                                                                                                                       |
| Artifact Registry      | billed per GiB-month beyond the always-free allowance                                                                                                                      | One image of a few hundred MiB, with old tags deleted; `infra/teardown.sh` deletes the repository                                                                                                                                                                                     |
| Cloud Build            | a daily always-free build allowance                                                                                                                                        | Two builds of one image with a warm pnpm store; the first is the slow one                                                                                                                                                                                                             |
| Secret Manager         | the always-free allowance covers six active versions and a monthly access allowance                                                                                        | Two secrets, one active version each                                                                                                                                                                                                                                                  |
| **Gemini (reasoning)** | **20 requests per day, per model, per project** — _measured_, not documented (`Workspace/state/RUN_STATE.md` §3f), buckets are per model                                   | One advisory pass is 6 calls, the rationale set 6, the console's narration 4, one capture 1. §6                                                                                                                                                                                       |

**Budget guard.** `infra/provision.sh` creates a monthly budget alert on the project at
50%, 90% and 100% of `CIVORA_BUDGET_USD` (default `$5`). **An alert notifies; it does not
stop spend** — the effective guards are `min-instances=0`, the `max-instances=2` ceiling,
Cloud Run's own quotas, and the teardown in §9. The billing account's spending limit is a
setting on the account, not a flag on a deployment; set it there before the first deploy.

**Cold start.** Not measured, because nothing has been deployed. A judge's first request
on a scaled-to-zero instance pays image pull and process start; `min-instances=1` for the
evaluation window removes it, at the cost in the table above. Record the measurement here
when a deployment exists.

## 6. The reasoning layer on a deployment

- **Bindings, never files:** `GEMINI_API_KEY` and `GEMINI_MODEL` come from Secret Manager
  through `--set-secrets`. The application validates them at startup and names the missing
  variable rather than degrading silently (`apps/web/src/env.ts`).
- **The model the demonstration pins** is `gemini-3.1-flash-lite`, chosen for its quota
  bucket, not for its name: the flash tier's free allowance is per model, and the lite
  model kept answering while the larger one's bucket was exhausted (§3f).
- **The per-process store is what the quota interacts with.** The seeded world, the
  advisory set and the rationale set live in the process. A cold start builds the world
  again (deterministic, no cost) and writes the advisory set only when a surface asks for
  it (§3.5): six calls. With a ceiling of twenty a day per model, the demonstration
  tolerates roughly three such passes a day; past that the surfaces show the writer's own
  refusal, which is a result the interface displays rather than a number it invents.
- **If the quota is exhausted:** every surface that depends on the model shows the
  refusal with its reason; the ledger, the plan, the alerts, the approvals and the audit
  chain are unaffected, because no model is in their path. A demo that cannot reach a
  model is degraded, not broken — and the platform says which.
- **After the window:** rotate the key (§4) and, if the link is retired, follow §9.

## 7. Scaling up and off the free tier

1. **Data and identity — an adapter to write, then a binding.** Neither hosted adapter is
   part of this build: selecting one throws `ProviderNotAvailableError` naming it
   (`apps/web/src/providers.ts`), which is why §1's table binds `in-memory` and `fixture`.
   The work is to implement the store and the identity resolution behind the ports that
   already exist — the rules they must agree with are written and tested — seed the store
   from the same deterministic generator, then bind `CIVORA_DATA_PROVIDER=firestore` and
   `CIVORA_AUTH_PROVIDER=firebase`. Deploy
   [`infra/firestore.rules`](../infra/firestore.rules) with them: 25 emulator tests assert
   each allowed and denied access (`pnpm test:rules`).
2. **Scheduled work:** run `apps/worker`'s commands as Cloud Run Jobs on Cloud Scheduler
   (`pnpm worker:score`, `pnpm worker:advisories`, `pnpm fl:run`), so forecasts, alerts
   and federation rounds happen whether or not a browser is open.
3. **Analytics:** enable BigQuery and the `bqml` forecasting path, which is behind the
   same port as the local engine (`packages/forecasting/src/bqml.ts`) and is untested
   against a live project.
4. **Reasoning at scale:** a paid key or Vertex AI, which removes the daily ceiling but
   not the design rule — the model narrates, the engines decide.
5. **Size:** raise `--max-instances`, drop to `min-instances=0` when there is no
   evaluation window, and revisit `--concurrency`.

## 8. The fallback (a non-Google container host)

The image is a standard OCI image and every external boundary is a port (ADR 0004), so the
same artefact runs on any container host. **The host chosen for the demonstration is
Render**, and the choice is declared in one reviewable file at the repository root:
[`render.yaml`](../render.yaml) (the decision and its arithmetic are ADR 0010, in the
project workspace).

| Concern        | Render — the demonstration                                                                                           | Cloud Run — the primary target                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Build          | Render builds `infra/Dockerfile` from this repository, so **no container runtime is needed on the author's machine** | Cloud Build builds the same Dockerfile from the same context                 |
| Port           | Render injects `PORT` (10000 by default) and routes to it; the standalone server reads it                            | `--port=3000`, same entry point                                              |
| Instances      | **one** — the free instance type cannot scale past one, which is the shape the in-process store needs                | `min-instances=0`, `max-instances=2`; two instances are two divergent worlds |
| Store          | `CIVORA_DATA_PROVIDER=in-memory`, rebuilt per process, deterministic                                                 | same                                                                         |
| Identity       | `CIVORA_AUTH_PROVIDER=fixture`                                                                                       | same                                                                         |
| Reasoning      | `CIVORA_REASONING_PROVIDER=gemini`; the key is entered in the Render Dashboard once and stored there                 | Secret Manager, bound with `--set-secrets`                                   |
| Secrets in git | none — `GEMINI_API_KEY` is declared `sync: false`, so Render prompts for it                                          | none                                                                         |
| Cost           | $0 on the free instance type                                                                                         | free tier, scale-to-zero                                                     |

**Gemini remains the reasoning layer in every deployment**; the fallback is about the host,
not about the model. There is no Google-specific runtime dependency in the image.

### 8.1 The owner's steps

1. **Push `Source/` to the repository.** A Blueprint reads the repository, so this comes
   first — and it is submission artefact 1 anyway.
2. In the Render Dashboard: **New → Blueprint**, connect the GitHub repository (grant the
   Render app access to that one repository), and confirm `render.yaml` as the Blueprint
   file. Render validates the file and creates one web service, `civora-web`.
3. When prompted for `GEMINI_API_KEY`, paste the AI Studio key. It is stored by Render and
   never written into the repository.
4. Wait for the first build, then open the service URL — `https://civora-web.onrender.com`
   unless the name was taken — and check `/healthz` answers.

Nothing else is required: the image, the port, the health check and the provider bindings
are all in the Blueprint.

### 8.2 Keep it warm, then warm it

The free instance type **spins down after 15 minutes without inbound traffic** and takes
about a minute to spin back up. That is not only a latency question: the seeded world is
rebuilt per process (free, deterministic), but the reads that ask the model are **written once
per process and cost 16 live calls** — advisories 6, rationales 6, the federation narrative 4
(`/api/command` is local and free) — against a measured ceiling of **20 calls a day per
model**. A cold start
that a reviewer triggers is those 16 calls; two in a day exhausts the day's budget and the
second surfaces the writer's own refusal.

So the deployed instance is kept warm the same way the presenting machine is:

- **A keep-warm monitor** (a free uptime service, one HTTPS check on `/healthz` every 5–10
  minutes) holds one process alive. The free instance-hours allowance is 750 a month and a
  month is 720–744 hours, so an always-on single service fits — with almost no margin, which
  is why nothing else on the account may run.
- **A restart is not free.** Do not restart or redeploy the service during the evaluation
  window unless something is broken; every restart re-pays the 16 calls.
- **If the model does refuse**, the ledger, the plan, the alerts, the approvals and the audit
  chain are unaffected — the refusal is displayed with its reason rather than hidden (§6).

Warm the deployed instance by reading the four surfaces once, in this order (they are the
same reads `warm-up-check.mjs` performs locally):

```bash
URL=https://civora-web.onrender.com   # the URL the Dashboard prints for the service
for path in /api/command /api/advisories /api/rationales /api/federation; do
  curl -sS "$URL$path" >/dev/null && echo "$path ok"
done
```

### 8.3 Smoke-test it, then record what was tested

```bash
CIVORA_LIVE_URL="$URL" pnpm smoke:live
```

This is the same instrument the primary path uses (§3.6) — `/healthz` and `/readyz`, the
seeded world and its fingerprint, the alerts the pipeline has raised, and the golden path to
a recorded decision with the refusals that must not be bypassed. **The URL, the date, the
region and what was smoke-tested are recorded in `README.md`, `Workspace/state/RUN_STATE.md`
and `Workspace/state/FEATURES.md` under ADR 0006's rules, and nothing else is claimed.**

### 8.4 What this does and does not prove

- It proves the image builds and runs on a host that is not Google's, that the seeded
  demonstration serves, and that a reviewer can reach it. That is what ADR 0008 asked the
  fallback to prove.
- It does **not** prove the Cloud Run path, the Secret Manager bindings, the budget alert or
  the Firestore/Firebase adapters — none of which this deployment touches (§10).
- It does **not** run `infra/check-image.sh`. The host builds the image, so the four
  assertions of §3.3 (non-root user, `NODE_ENV`, no key in any layer, both probes) are not
  executed by it; the live smoke test covers adjacent ground and is not the same check.
  Gate 10 stays `BLOCKED` until a container runtime exists locally.

### 8.5 The same image by hand (offline variant)

With a local container runtime, the identical artefact runs without any host:

```bash
docker build --file=infra/Dockerfile --tag=civora-web:local .
docker run --publish 8080:3000 \
  --env CIVORA_REASONING_PROVIDER=gemini \
  --env GEMINI_API_KEY="$GEMINI_API_KEY" --env GEMINI_MODEL=gemini-3.1-flash-lite \
  civora-web:local
```

**Status: not verified.** `render.yaml` and this section are written and reviewed;
**no Render account exists, no Blueprint has been created, nothing has been built or
deployed there, and no URL answers.**

What _was_ executed here, on **2026-09-29**:

- `render.yaml` validated against **Render's own published Blueprint JSON Schema**
  (`https://render.com/schema/render.yaml.json`, draft 2020-12, sha256
  `57aa0a1ff9c3b2d0fcb91b790b7b285aef6397adb0c92930e6e601054444cfe5`, fetched that day) with
  the repository's pinned `ajv` — **zero violations**, so every field name, the `free` plan
  and the `singapore` region are Render's spellings rather than this document's.
- `pnpm format:check` over the whole repository — green, so this file cannot fail CI's
  formatting step.
- **The Blueprint's environment, verbatim,** on **Render's injected port**: the standalone
  production build started with `NODE_ENV=production`, `CIVORA_DATA_PROVIDER=in-memory`,
  `CIVORA_AUTH_PROVIDER=fixture`, `CIVORA_REASONING_PROVIDER=gemini`,
  `GEMINI_MODEL=gemini-3.1-flash-lite`, `GEMINI_API_KEY` from the environment and `PORT=10000`
  answered on the first poll after **2 s**: `GET /healthz` **200** with `status: ok` and the
  adapters `in-memory` / `fixture` / `gemini`, `GET /readyz` **200**, `GET /` **200**. Nothing
  refused to boot, so the pair the cross-field rule demands (`GEMINI_API_KEY` **and**
  `GEMINI_MODEL` once `CIVORA_REASONING_PROVIDER=gemini`) is genuinely satisfied by the list
  above, and the injected port is honoured rather than the image's own `EXPOSE 3000`. **The
  health checks do not read the model, so this spent no quota.** It is a boot, not a build:
  Render's builder still has not seen this repository.

Render's CLI and its API's Validate Blueprint endpoint are the _authoritative_ validators and
**have not been run** (each needs a Render account). Neither the schema check nor the boot above
is that validation, and neither is a build. §10 carries the remaining gaps.

## 9. Teardown

```bash
CIVORA_GCP_PROJECT=civora-demo bash infra/teardown.sh --dry-run
CIVORA_GCP_PROJECT=civora-demo bash infra/teardown.sh
```

Deletes the Cloud Run service (the thing that bills by the second) and the image
repository with its images. It **keeps** the secrets, the service account and the project,
and says so — they cost nothing while nothing reads them. `--delete-secrets` removes the
secrets; `--delete-project --confirm <project-id>` removes everything, and refuses to run
without the confirmation.

After a teardown, the URL no longer answers. **Say that plainly** in the README and in
`Workspace/state/RUN_STATE.md` rather than leaving a dead link: ADR 0006 governs what may
be claimed about a deployment, and a URL that no longer responds is not a deployment.

## 10. What has not been verified

Every line here is a gap, not a footnote.

| Unverified                                                    | Why                                                                                                                                                                                                                   | What would close it                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Any provisioning step against a real project                  | no `gcloud`, no project, no billing account (B1)                                                                                                                                                                      | Run `infra/provision.sh` twice and record both runs                                                         |
| The image running, and its four runtime assertions            | the image **builds** — CI's `container` job is green on `41af8d1` (2026-09-25), `594e450` (2026-09-27) and `0830ca0` (2026-09-29) — but no container of it has ever started, and `check-image.sh` needs a daemon (B8) | `bash infra/check-image.sh` on a machine with a container runtime                                           |
| The Cloud Build path                                          | same as above, plus B1                                                                                                                                                                                                | `bash infra/deploy.sh`                                                                                      |
| A live URL, its cold start, and the live smoke test           | no deployment exists                                                                                                                                                                                                  | `CIVORA_LIVE_URL=… pnpm e2e live-smoke.spec.ts`, output recorded in `RUN_STATE.md`                          |
| The budget alert, and the billing spending limit              | B1                                                                                                                                                                                                                    | `gcloud billing budgets list`                                                                               |
| Render's own validation of `render.yaml`, and its first build | no Render account exists; the file validates against Render's published JSON Schema (2026-09-29, zero violations) and nothing further has been exercised                                                              | Create the Blueprint — Render validates the file and builds `infra/Dockerfile` itself, then reports a build |
| The fallback instance, its URL and its live smoke test (§8)   | nothing has been created on Render, and the push a Blueprint needs has not happened                                                                                                                                   | Create the Blueprint, warm it (§8.2), then `CIVORA_LIVE_URL=… pnpm smoke:live` and record the output        |
| The Firestore data provider and the Firebase identity adapter | neither adapter is part of this build (`apps/web/src/providers.ts` refuses them by name); a real project needs B1                                                                                                     | Write each behind its port, then provision, seed and run `pnpm test:rules` against the deployed rules       |
| The deployed advisory set surviving a cold start              | no deployment exists; the chosen host spins down after 15 idle minutes, and a cold start re-pays 16 model calls against a measured 20-a-day ceiling                                                                   | Warm the deployed instance (§8.2), record the counts, then read them again after a deliberate spin-down     |

**What was executed, on 2026-09-27:** all four scripts' `--dry-run` paths (plans printed,
exit `0`); the missing-prerequisite paths (one sentence, exit `3` for `provision.sh`,
`deploy.sh` and `check-image.sh`); and the destructive-path refusal
(`teardown.sh --delete-project` without a confirmation, exit `3`). Nothing was created,
deployed or charged.

**Also executed, off this machine, on 2026-09-25, 2026-09-27 and 2026-09-29:** CI's `container` job
(`docker build -f infra/Dockerfile -t civora-web:ci .`) succeeded on `41af8d1`, `594e450` and
`0830ca0`, so
this repository's image is known to build — on a builder that is not this machine, with no
container runtime here. That is a **build, not a run**: no container of this image has ever
started, which is why the table above still lists the running half as a gap.

**What was executed here, on 2026-09-29:** the two commands named in §8.5 — the JSON Schema
validation of `render.yaml`, and `pnpm format:check` — and nothing else. Nothing was created,
deployed or charged on that date either.

## 11. Related documents

- [`infra/`](../infra) — the scripts and the image, whose `--dry-run` paths this document
  was written from.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the ports the deployment pivots on.
- [`docs/DATA_PROVENANCE.md`](DATA_PROVENANCE.md) — what the seeded demonstration data is,
  and is not.
- ADR 0008 — the hosting decision and the fallback (workspace, outside this repository).
- `Workspace/state/RUN_STATE.md` §3f — the live reasoning evidence, including the measured
  twenty-requests-a-day ceiling (workspace, outside this repository).
