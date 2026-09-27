# Deployment

> **Status: there is no live deployment.** The machine this repository was built on has
> no Google Cloud project, no billing account and no running container runtime
> (`Workspace/state/BLOCKERS.md` B1 and B8, outside this repository), so the steps
> below are scripted, reviewed and dry-run, but **not one of them has been executed
> against a real project**. Every statement in this document is either a command that
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

| Prerequisite                            | Needed for                                           | Notes                                                                                                          |
| --------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `gcloud` (Google Cloud SDK)             | provisioning and deploying                           | **Not installed on the author's machine as of 2026-09-27.** Install per the SDK page, then `gcloud auth login` |
| A Google Cloud project                  | everything                                           | `infra/provision.sh` creates one if the id is free                                                             |
| A billing account with a spending limit | Cloud Run, Artifact Registry, Cloud Build            | A project without billing cannot deploy; the scripts say which steps they skipped                              |
| A Gemini API key                        | the reasoning layer                                  | `GEMINI_API_KEY`; see §6. Phase 5's live evidence is `Workspace/state/RUN_STATE.md` §3f                        |
| `docker` + a running daemon             | only `infra/check-image.sh` and `CIVORA_BUILD=local` | The cloud build needs no daemon; a daemon is not running on the author's machine (B8)                          |
| Node 22+ and `pnpm`                     | building locally and running the smoke test          | `pnpm install --frozen-lockfile` first                                                                         |

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

The image is a standard OCI image and every external boundary is a port
(ADR 0004), so the same artefact runs on any container host with a managed database:

```bash
docker build --file=infra/Dockerfile --tag=civora-web:local .
docker run --publish 8080:3000 \
  --env CIVORA_REASONING_PROVIDER=gemini \
  --env GEMINI_API_KEY="$GEMINI_API_KEY" --env GEMINI_MODEL=gemini-3.1-flash-lite \
  civora-web:local
```

**Gemini remains the reasoning layer in every deployment**; the fallback is about the
host, not about the model. On a host that offers a container registry from a repository
this is a configuration change; there is no Google-specific runtime dependency in the
image.

**Status: not verified.** No container runtime has been available (B8), so the fallback
is documented and scripted, and no instance of it exists. Deploying it once was the
phase's task 12; it is blocked by the same missing daemon and is named in §10.

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

| Unverified                                                    | Why                                                                                                               | What would close it                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Any provisioning step against a real project                  | no `gcloud`, no project, no billing account (B1)                                                                  | Run `infra/provision.sh` twice and record both runs                                                   |
| The container image building and running                      | no container runtime (B8)                                                                                         | `bash infra/check-image.sh`                                                                           |
| The Cloud Build path                                          | same as above, plus B1                                                                                            | `bash infra/deploy.sh`                                                                                |
| A live URL, its cold start, and the live smoke test           | no deployment exists                                                                                              | `CIVORA_LIVE_URL=… pnpm e2e live-smoke.spec.ts`, output recorded in `RUN_STATE.md`                    |
| The budget alert, and the billing spending limit              | B1                                                                                                                | `gcloud billing budgets list`                                                                         |
| The fallback instance (§8)                                    | B8                                                                                                                | Deploy once to a non-Google host and run the same smoke test                                          |
| The Firestore data provider and the Firebase identity adapter | neither adapter is part of this build (`apps/web/src/providers.ts` refuses them by name); a real project needs B1 | Write each behind its port, then provision, seed and run `pnpm test:rules` against the deployed rules |
| The deployed advisory set surviving a cold start              | no deployment                                                                                                     | Record the counts from `--warm`, then from the first read after an idle period                        |

**What was executed, on 2026-09-27:** all four scripts' `--dry-run` paths (plans printed,
exit `0`); the missing-prerequisite paths (one sentence, exit `3` for `provision.sh`,
`deploy.sh` and `check-image.sh`); and the destructive-path refusal
(`teardown.sh --delete-project` without a confirmation, exit `3`). Nothing was created,
deployed or charged.

## 11. Related documents

- [`infra/`](../infra) — the scripts and the image, whose `--dry-run` paths this document
  was written from.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — the ports the deployment pivots on.
- [`docs/DATA_PROVENANCE.md`](DATA_PROVENANCE.md) — what the seeded demonstration data is,
  and is not.
- ADR 0008 — the hosting decision and the fallback (workspace, outside this repository).
- `Workspace/state/RUN_STATE.md` §3f — the live reasoning evidence, including the measured
  twenty-requests-a-day ceiling (workspace, outside this repository).
