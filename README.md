# Civora

A federated AI platform for health resource and supply-chain planning across a
national primary health centre network.

> **Status: sensing plane.** The platform can now capture stock, beds,
> attendance and footfall at a facility **offline**, accept it idempotently and
> scoped to the facility that sent it, and show a district officer what the
> district can see — including the facilities it cannot. Forecasting, early
> warning, redistribution and federation are **not** implemented. Nothing below
> is claimed to work beyond what the test suite exercises; the modules that do
> not exist say so on the overview page.

---

## The problem

Primary health centres run out of essential medicines that are sitting unused a
district away, because stock positions are reported too late, too coarsely or not
at all — and a facility that has no stock and a facility that has no patients
look identical in the records.

The consequence is avoidable: a platform that can tell the difference, predict
demand per facility, and propose a transfer that respects every safety constraint
turns a national shortage into a routing problem.

## What happens next

The prototype is being built in phases, each ending in something that runs. The
first end-to-end slice will take a stock capture at one facility, propagate it
into a national risk view, forecast its consumption, explain the resulting
stock-out risk in the facility's own language, and propose a constraint-checked
transfer from a facility that can spare the stock.

So far the repository can generate the world that slice operates on. `pnpm test`
runs the simulator against the same seeded inputs every time, and its scenarios —
a monsoon surge, a diarrhoeal outbreak, a facility that goes offline, a disrupted
state warehouse, a cold-chain failure, a district expiry cliff — are asserted to
produce the effects they are named for, alongside two negative controls that are
asserted to produce nothing at all.

`pnpm db:seed` generates that dataset and stores it through the persistence port,
and running it again stores the same documents under the same identifiers. What
the dataset is, how much of it is real rather than generated, and which sources
it set out to use but could not obtain are all on the **dataset inspector** at
<http://localhost:3000/dataset>.

The **capture surface** at <http://localhost:3000/capture> queues what a facility
records on the device and delivers it when the platform can be reached, and the
**visibility surface** at <http://localhost:3000/visibility> reads the resulting
stock positions, bed pressure and reporting gaps. Turn the network off in the
browser and capture anyway: that is the path the platform is built around, and
`docs/ARCHITECTURE.md` states each rule it rests on and the file that enforces
it. The capture screen is also stored on the device once it has been opened, so
it reopens with no connection at all — the form, the queue and what each holds —
while the platform's own facility list is deliberately not stored, because a
list of facilities is a statement about the world that only the platform is
entitled to make.

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

## Google AI

Google AI is the reasoning layer, behind the `ReasoningProvider` port defined in
`packages/domain` and implemented in `packages/ai`. The adapter exists, is
contract-tested, and every response is validated against the caller's schema
before it leaves it; a narrative that states a number nobody computed is refused.
It is used for register extraction, spoken-command parsing, advisory bodies and
risk-driver explanations, and **no live call has been made yet**: the project has
no API key, so the recorded-fixture adapter answers in its place, the fixture
corpus is empty, and the intake surfaces say which reading was supplied rather
than read. Every attempt, refusal, cache hit, token and millisecond is counted by
the adapter itself and shown on the intelligence surface, so what a burst would
cost is the platform's own figure rather than an estimate.

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
The corpus is empty, so that mode prints `NOT MEASURED` with the reason and **no
percentage at all** — a rate over nothing is not a measurement — and exits `2`,
which CI accepts while the key is missing and prints that it did.

## Development

```bash
pnpm lint         # ESLint over the workspace
pnpm typecheck    # tsc --noEmit across every package and app
pnpm test         # Vitest: unit and contract tests
pnpm build        # production build of the web application
pnpm e2e          # Playwright against the built application
pnpm db:seed      # generate the demonstration dataset and store it
pnpm check:bundle # the built client bundle carries no reasoning endpoint or key
pnpm ai:eval      # the grounding assertion, and extraction accuracy against a corpus
pnpm verify       # lint, typecheck, test, build and the bundle check
```

CI runs the same gates in the same order, plus a container build.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the layers, the capture path,
  the ingest and tenancy rules, and where each is enforced.
- [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md) — every dataset, its
  licence, and what is simulated.
- [`docs/REDISTRIBUTION.md`](docs/REDISTRIBUTION.md) — the redistribution plan
  for the demonstration dataset, with its proposals, its impact assumptions and
  the digest two runs are compared by. Generated by
  `pnpm worker:propose --report docs/REDISTRIBUTION.md`.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to work in this repository.
- [`SECURITY.md`](SECURITY.md) — scope and how to report a problem.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — Contributor Covenant 2.1.

## Data

No real data is used. This repository reads no facility, patient or stock record,
and no personal health information is collected by construction. The facility
network is synthetic, generated from a fixed seed so that any result can be
reproduced exactly. See [`docs/DATA_PROVENANCE.md`](docs/DATA_PROVENANCE.md).

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
