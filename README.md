# Civora

A federated AI platform for health resource and supply-chain planning across a
national primary health centre network.

> **Status: the prototype is complete as a build; there is no live deployment.**
> Every build phase is in the repository and every gate is green: the seeded
> national simulation, intermittent-demand forecasting with a published
> evaluation, the risk inbox and early warning, constraint-checked
> redistribution that a person decides on, the federated-learning console with
> its privacy budget, offline capture, HMIS/NLEM interop, five languages, and a
> reasoning layer that has been executed against a real Gemini model.
> **No live deployment exists** — the project has no Google Cloud project or
> billing account — so [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the
> reproduction path, not a record of a deployment, and nothing here claims a URL
> answers. Nothing below is claimed beyond what the test suite and the recorded
> evidence exercise; the gaps this build does not close are named in [What this
> build does not claim](#what-this-build-does-not-claim).

---

## The problem

Primary health centres run out of essential medicines that are sitting unused a
district away, because stock positions are reported too late, too coarsely or not
at all — and a facility that has no stock and a facility that has no patients
look identical in the records.

The consequence is avoidable: a platform that can tell the difference, predict
demand per facility, and propose a transfer that respects every safety constraint
turns a national shortage into a routing problem.

## What this does, end to end

A **capture** at one facility — typed, photographed or spoken, and queued on the
device when there is no connection — reaches the ledger through one ingest
boundary, idempotently and scoped to the facility that sent it. From there the
platform **forecasts** consumption per facility and item, **raises alerts** with
the quantity that put each one there, **proposes transfers** that respect shelf
life, cold chain and handling limits, and **records a person's decision** on each
proposal in a hash-chained audit trail. A **console** shows the federated
learning round, its privacy budget and the honest measurement of what the noise
costs.

`pnpm test` runs the simulator against the same seeded inputs every time, and its
scenarios — a monsoon surge, a diarrhoeal outbreak, a facility that goes offline,
a disrupted state warehouse, a cold-chain failure, a district expiry cliff — are
asserted to produce the effects they are named for, alongside two negative
controls that are asserted to produce nothing at all.

`pnpm db:seed` generates that dataset and stores it through the persistence port,
and running it again stores the same documents under the same identifiers. What
the dataset is, how much of it is real rather than generated, and which sources
it set out to use but could not obtain are all on the **dataset inspector** at
<http://localhost:3000/dataset>.

The **capture surface** at <http://localhost:3000/capture> queues what a facility
records on the device and delivers it when the platform can be reached; the
**visibility surface** at <http://localhost:3000/visibility> reads the resulting
stock positions, bed pressure and reporting gaps; and the **control tower** at
<http://localhost:3000/command> drills from the national picture to a batch. Turn
the network off in the browser and capture anyway: that is the path the platform
is built around, and `docs/ARCHITECTURE.md` states each rule it rests on and the
file that enforces it. The capture screen is also stored on the device once it
has been opened, so it reopens with no connection at all — the form, the queue
and what each holds — while the platform's own facility list is deliberately not
stored, because a list of facilities is a statement about the world that only
the platform is entitled to make.

## Quickstart

Requires **Node 22 or newer** and **pnpm 10**. No cloud account, no credentials,
no configuration.

```bash
pnpm bootstrap
pnpm dev
```

`pnpm bootstrap` installs the workspace, creates `.env.local` from
`.env.example`, and fetches the browser used by the end-to-end tests. `pnpm dev`
starts the application on <http://localhost:3000>, with the Firebase emulator
suite if it is available.

(The script is `bootstrap` rather than `setup` because `pnpm setup` is a reserved
command that reconfigures your shell.)

Explicitly, this runs with **zero cloud credentials**. That is a design
constraint, not a fallback: every external boundary is a port with a local
adapter behind it, so the system is developed, tested and demoed without a cloud
account. Pointing it at a real backend is a configuration change.

## Layout

```
apps/
  web/          Next.js application — dashboard, capture surface, console
  worker/       Scheduled jobs: forecast batches, alerts, federation rounds
  simulator/    Deterministic generator for the synthetic facility network
packages/
  domain/       Schemas, boundary ports, local-first adapters
  forecasting/  Intermittent-demand forecasting engines
  optimizer/    Redistribution planning and constraint validation
  federated/    Federation rounds and differential-privacy accounting
  ai/           Adapters behind the reasoning port
  interop/      Importers for incumbent health-system formats
  i18n/         Locale bundles and formatting
  config/       Shared TypeScript, ESLint and Prettier presets
infra/          Container image, emulator configuration, deploy scripts
e2e/            Browser tests against the real application
docs/           Provenance, architecture, evaluation and plan notes
```

## Architecture

Three ideas carry the design.

**Ports at every boundary.** Storage, identity and reasoning are each an
interface in `packages/domain` with a local implementation behind it. The web
application composes them from validated configuration in one place, so swapping
an adapter touches nothing downstream.

**Simulation is labelled.** The platform is designed around a generated national
network, and simulated data is marked as simulated in the interface, in API
responses and in the documentation. A reader should never have to guess which
parts are real.

**Numbers are decided, not generated.** Planning and forecasting are
deterministic engines. A language model may explain a decision in the user's
language; it never authors a quantity that reaches the record.

**Every consequential decision is chained, and the chain is walked rather than
asserted.** A stock correction, an alert move, a transfer decision, an import and
a federated round each append an `AuditEvent` carrying who decided, in what
capacity, when, on what grounds, what changed — the on-hand figure before and
after, the state an alert left and entered — and the digest of the entry before
it. Altering one, removing one or reordering two breaks the chain at the point of
the change, so `/audit` reports _where_ it stops holding rather than that
something is wrong — and it reports that for the whole chain even when a reader
has filtered the rows to one actor, because a trail that held only inside the
rows somebody asked for would be a trail that can be broken anywhere else. The
viewer reads the chain through the same rule as the stored rules
(`infra/firestore.rules`), which is why a district officer is refused it in a
sentence: a decision is a line in one shared record, and reading it would mean
reading every other district's.

What is _not_ recorded is stated as plainly as what is: a refused action, a
replay, a read, a conflict (which is written to its own collection) and the
platform's own recomputations. `apps/web/src/lib/audit-service.ts` holds that list
as a value — the action vocabulary the chain accepts — and
`audit-service.test.ts` reads every file the list names, asserts each one appends
to the chain, and then asserts the converse: every file in the application that
appends to the chain is registered. A new consequential action that skips the
chain is a failing test rather than a second code path nobody reviewed.

**The tenancy model is enforced where the data lives.** `infra/firestore.rules`
implements the roles and scopes the application uses, so a read the database
refuses cannot be forgotten by a route: custom claims carry the role and the
place it is anchored to, one lookup up the facility spine resolves a district or
a state, and only alerts and transfer decisions accept a client write at all.
`pnpm test:rules` starts the Firestore emulator and runs twenty-five cases
against it, each access asserted twice — the access a role is meant to have and
the neighbouring access it must not.

**A file from a system the ministry already runs is a record like any other.** Three
readers live in `packages/interop`: the monthly HMIS stock statement, the Local
Government Directory extract and the national essential medicines list. The first
two are on the import path — `/import` is a two-step, **check** and then **accept**,
where the check runs the same code with writing turned off and reports per row what
the platform would do, including the rows it refuses and the sentence it refuses
them with. An importer does not decide what to write: the adapter reads the file into
the envelope a nurse's phone sends, and the ingest boundary decides each row — the
same idempotency keys, the same projection, the same audit chain — so an imported row
differs from a capture only by its source and by the provenance naming the file it
arrived in. Re-importing is a replay rather than a second movement of the same stock
(each row's identifier is derived from its own content and the file's digest), scope
is decided per row, and the act appends one `import-accepted` entry naming the file,
the rows it wrote and the person who accepted it. Every correspondence is
field-by-field and held in the code as a value, so a column the reader needs but the
table does not name fails the build: [`docs/INTEROP.md`](docs/INTEROP.md) prints
them, and says which shapes were confirmed against a retrieved source and which are
reconstructed.

**What an operator can see from outside is three small things, and the third can
fail.** A log line is one JSON object carrying the request's correlation id, minted
or taken from the caller and echoed on the response — never the query string, which
is where an identifier arrives when nobody meant to send one — and a field whose key
looks like a person's is withheld and _named_ in the line that would have carried it.
`/healthz` says the process is alive; `/readyz` says whether it should be given a
decision, reading the store, the dataset, the projection and **the audit chain**, so
a trail that has been altered is reported as not-ready with the entry named rather
than served as though nothing were wrong. `/api/metrics` is the operator's read —
chain entries and their actions, imported files and what they wrote, the control
tower's own cache counters, the reasoning adapter's calls and cache hits — every
figure read through the mechanism that already owns it, with `null` rather than zero
for anything nobody has measured.

**Localisation is partial, and the partiality is stated.** Two flows are
translated into English, Hindi, Marathi, Bengali and Tamil: **the
medicine-capture form** — its facility, item, movement, quantity, batch, expiry
and reason fields, its queue and refusal messages — and **the alert inbox** —
severity, state, raised-on date, the reason field and the five move buttons.
`@civora/i18n` holds the bundles, a bundle missing a phrase fails the build, and
dates, counts and percentages are rendered by the language's own locale rather
than by string replacement, so Hindi renders Devanagari numerals (asserted in
`e2e/i18n.spec.ts`). **The remaining hard-coded surfaces, named rather than
implied:** the navigation; the capture page's own framing prose and its other
four record kinds (adjustment, bed status, staff attendance, syndromic counts);
the visibility surface; the control tower and its drill-down; the redistribution
workbench; the federation console; the dataset inspector; the vision and voice
review screens; the advisory panel; the provenance page; and the ranked risk
catalogue with every driver sentence beside it. **Generated prose is whatever a
model wrote**, and an alert that holds no body in the language a reader is
reading says so rather than showing another language's words in its place —
`bodyIn` in `packages/i18n` is the rule, the advisory panel is where it is
visible, and the alert inbox's read-aloud control is that refusal in audio: a
body is spoken only in the language the record carries it in, with the voice
asked for in the registry's plain speech tag (`hi-IN`, never
`hi-IN-u-nu-deva`, which matches no installed voice).

## Google AI

Google AI is the reasoning layer, behind the `ReasoningProvider` port defined in
`packages/domain` and implemented in `packages/ai`. The adapter exists, is
contract-tested, and every response is validated against the caller's schema
before it leaves it; a narrative that states a number nobody computed is refused.
It is used for register extraction, spoken-command parsing, advisory bodies and
risk-driver explanations, and it **has been executed against a real model**: a
rendered register page read into the ledger, a spoken update heard, held and
written only after a person confirmed it, six advisories written in two
languages, six transfer rationales and four round narratives. That run is gated
and reproducible — `CIVORA_LIVE_AI=1 pnpm e2e live-ai.spec.ts` — and with no key
configured every surface shows the writer's own refusal rather than a
substitute, because the recorded-fixture adapter refuses rather than pretends.
Every attempt, refusal, cache hit, token and millisecond is counted by the
adapter itself and shown on the intelligence surface, so what a burst would cost
is the platform's own figure rather than an estimate. The free tier's ceiling on
one model — **twenty requests a day**, measured off a real `429` rather than read
from documentation — is why the demonstration pins `gemini-3.1-flash-lite` and
why the advisory set is written ahead of the demo rather than during it.

`pnpm check:bundle` is the standing check that none of this is reachable from the
browser: it reads the built client bundle and fails if the reasoning endpoint, the
SDK client or the key's name appears in it, with two positive controls so the
check cannot pass by scanning nothing.

`pnpm ai:eval` is how that layer is checked, in two modes that answer different
questions. `--grounding` injects an alert whose facts are a seven-digit figure, a
negative change and a three-place decimal, states for each draft whether it may be
published, and **fails unless every accepted draft stops being accepted once a
figure nobody measured is put in it** — a check that accepts everything and a
check that rejects everything both look like a green run, so it proves it is
neither, and it needs no key. `--golden-set` scores recorded readings against
hand-written labels, and a case is only a case if its response came from a real
call: the command, the day and the digest of the media it answers are all required,
and a corpus file without them is **refused by name** rather than quietly skipped.
No provenance-bearing corpus exists, so that mode still prints `NOT MEASURED`
with the reason and **no percentage at all** — a rate over nothing is not a
measurement — and exits `2`, which CI accepts and prints that it saw. That gap is
named rather than papered over: it is the one Phase 5 checklist item this build
does not satisfy.

## Deployment

**There is no live deployment.** The machine this was built on has no Google
Cloud project, no billing account and no running container runtime, so nothing
has been provisioned and no URL answers. That is stated here rather than left for
a reader to discover.

The deployment is scripted and reviewable without any of those credentials:

```bash
bash infra/provision.sh --dry-run   # every gcloud step, printed, none executed
bash infra/deploy.sh --dry-run      # the Cloud Run service and its cost caps
bash infra/check-image.sh           # non-root, production, no key, probes answer
bash infra/teardown.sh --dry-run    # what a teardown deletes, and what it keeps
```

[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the reproduction path: what is
deployed, the free-tier shape with its arithmetic, the budget alert and what an
alert is not, how the Gemini key and model are bound from Secret Manager, the
migration path off the free tier, the non-Google fallback, the teardown, and a
list of exactly what is unverified. When a URL exists, it is smoke-tested from
outside with `CIVORA_LIVE_URL=… pnpm smoke:live`; with no URL configured that
spec skips and prints why, so the gate stays green and honest.

## Development

```bash
pnpm lint         # ESLint over the workspace
pnpm typecheck    # tsc --noEmit across every package and app
pnpm test         # Vitest: unit and contract tests
pnpm test:rules   # the Firestore rules against the emulator
pnpm build        # production build of the web application
pnpm e2e          # Playwright against the built application
pnpm db:seed      # generate the demonstration dataset and store it
pnpm check:bundle # the built client bundle carries no reasoning endpoint or key
pnpm check:image  # build the container and check it (needs a container runtime)
pnpm smoke:live   # the deployed instance, when CIVORA_LIVE_URL is set
pnpm ai:eval      # the grounding assertion, and extraction accuracy against a corpus
pnpm verify       # lint, typecheck, test, build and the bundle check
```

CI runs the same gates in the same order, plus a container build.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the layers, the capture path,
  the ingest and tenancy rules, and where each is enforced.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — how the demonstration would be
  deployed, its free-tier shape and cost arithmetic, what is bound from Secret
  Manager, the fallback, the teardown, and what has not been verified.
- [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md) — every dataset, its
  licence, and what is simulated.
- [`docs/INTEROP.md`](docs/INTEROP.md) — each importer, its source format, its
  licence position and its field-by-field mapping table.
- [`infra/firestore.rules`](infra/firestore.rules) — the tenancy rules, with
  `pnpm test:rules` as their matrix of allowed and denied access.
- [`docs/REDISTRIBUTION.md`](docs/REDISTRIBUTION.md) — the redistribution plan
  for the demonstration dataset, with its proposals, its impact assumptions and
  the digest two runs are compared by. Generated by
  `pnpm worker:propose --report docs/REDISTRIBUTION.md`.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to work in this repository.
- [`SECURITY.md`](SECURITY.md) — scope and how to report a problem.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.

## What this build does not claim

The limits are listed here as well as in [`docs/INTEROP.md`](docs/INTEROP.md),
because an unstated limitation is the only kind that misleads.

- **Two importers are deferred.** `eaushadhi-csv` (warehouse receipt and issue
  extracts) and `ihip-json` (the syndromic feed) are named, with what implementing
  each would take, and are not silently omitted. `nlem-json` is implemented and
  drives the catalogue, but the import surface refuses it by name: a file that
  replaced the catalogue at runtime would change what every ledger entry means.
- **Two of the three source shapes are reconstructed.** The directory extract and
  the HMIS statement are written in the published field vocabulary, but neither
  could be retrieved to confirm its arrangement, which each table says at the top.
- **No ministry API is integrated and no FHIR/ABDM conformance is claimed.** No
  HMIS, e-Aushadhi, IHIP or LGD endpoint was called; the adapters, fixtures and
  mapping tables are the deliverable.
- **There is no live deployment, and the container image has never been built
  here.** The provisioning, deploy and image-check scripts have been dry-run and
  their failure paths exercised, but no Google Cloud project exists and no
  container runtime is available on this machine, so no image has been built and
  no URL answers. `docs/DEPLOYMENT.md` §10 lists every step that is unverified.
- **Every store, projection, queue, counter, chain and plan is per process and in
  memory.** Correct for a single-process demonstration, wrong for a deployment.
- **Two reasoning gaps are named, not hidden.** The accuracy evaluation still
  prints `NOT MEASURED` because no corpus with real-call provenance exists, and
  the `driver-explanation@1` prompt is registered with a schema and has no
  surface that calls it. Five of the six tasks are wired and live-verified. See
  `docs/DATA_PROVENANCE.md` and the project state files for the evidence.

## Data

No real data is used. This repository reads no facility, patient or stock record,
and no personal health information is collected by construction. The facility
network is synthetic, generated from a fixed seed so that any result can be
reproduced exactly. See [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md).

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
