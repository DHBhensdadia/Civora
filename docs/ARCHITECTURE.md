# Architecture

What the platform is made of, and where each rule lives. Written for a reader who
is deciding whether to believe the demonstration: every claim below names the
file that enforces it.

The one-line version: **a facility's capture is queued on the device, accepted
once, stored as an observation, and derived into a position — and a facility the
platform has not heard from is reported as unknown rather than as stocked.**

---

## 1. Layers

```
apps/web        Next.js surfaces and route handlers
apps/worker     one-off commands and, later, scheduled jobs (pnpm db:seed)
apps/simulator  the synthetic nation, and the writer that seeds a provider
packages/
  domain        schemas, ports, pure rules, local adapters
  interop       importers for incumbent formats
  ...           forecasting, optimizer, federated, ai, i18n (not implemented)
```

Three rules hold the layers apart:

**Ports at every boundary.** Storage, identity and reasoning are interfaces in
`packages/domain/src/ports`, with local in-process implementations in
`packages/domain/src/adapters`. The web application composes them from validated
configuration in `apps/web/src/providers.ts`. Nothing above a port knows which
adapter is behind it, which is why the platform builds, tests and demonstrates
with no cloud credentials at all.

**Algorithms are pure.** Demand estimation, ledger replay and gap detection are
pure functions of their inputs — no clock, no network, no filesystem. That is
what lets the rules of the offline story be tested as rules rather than through a
database.

**The model is the only definition of a shape.** Every record type is a zod
schema in `packages/domain/src/model`; TypeScript types are inferred from the
schemas, never written beside them. The capture form and the ingest boundary
validate with the same schemas, so a rule cannot exist on one side only.

---

## 2. The path a capture takes

```
form (apps/web/src/app/capture)      the fields a person fills in
  ↓  completion + validation
outbox (apps/web/src/lib/outbox.ts)  IndexedDB, on the device, survives a reload
  ↓  POST /api/ingest (retried, backed off, with a stable key)
boundary (apps/web/src/app/api/ingest/route.ts)
  ↓  decideIngest (packages/domain/src/logic/ingest.ts)
provider (DataProvider port)         the record, its receipt, its conflicts
  ↓  applyRequest
projection (apps/web/src/lib/ledger-service.ts)
  ↓
surfaces (apps/web/src/app/visibility, /api/visibility)
```

### 2.1 The outbox

A capture is written to the device **before** it is sent, and delivery is
attempted when the page opens, when the browser reports connectivity has
returned, and on an interval while anything is waiting. Three decisions matter:

- **The idempotency key is generated when the capture is queued, not when it is
  sent.** A retry that regenerates its key is a new submission, and the platform
  would store the same count twice — which it is entitled to do, because it was
  asked to.
- **A refusal is kept, not retried.** If the platform refuses a submission because
  it contradicts a record already stored, retrying cannot help; the queue shows
  the disagreement to the person who can resolve it.
- **A failure to reach the platform is not a failure of the capture.** The item
  stays pending with its attempt count and last error, and the schedule backs off.

### 2.2 The stored screen

The outbox covers a request that fails; it does not cover a browser that was
closed and reopened where there is no connection, because the screen itself then
fails to load and the queue is unreachable. `apps/web/public/sw.js` is
registered by the capture page (`apps/web/src/lib/shell-cache.ts`), which sends
it the list of assets the page actually loaded — content-hashed chunk names are
not knowable in advance — and reports back how many were stored. Two rules hold:

- **Nothing under `/api/` is stored or served by the worker.** A stock position
  read ten minutes ago is not a stock position, and an offline read must fail as
  _unknown_ rather than succeed with a stale figure.
- **The network wins wherever it exists.** The stored copy is a fallback for a
  request that could not be made, never a substitute for making it.

The screen is stored; the platform's facility list is not. A reopening with no
connection therefore shows the queue and the form but cannot offer a facility to
record against, and it says so rather than offering a remembered choice.

### 2.3 The boundary

Four steps, in this order, in `apps/web/src/app/api/ingest/route.ts`:

1. **Complete and validate.** The observation schemas describe the _stored_
   record, so they require the fields the platform owns. `completeSubmission`
   (`packages/domain/src/logic/ingest.ts`) fills them from the envelope and the
   build's stamp, and the result is validated against the declared type — a
   malformed capture is reported against the field that is wrong.
2. **Authorise.** The session's scope is checked against the facility the
   submission names. A capture form is not a way into another facility's ledger.
3. **Decide.** `decideIngest` returns one of four outcomes from the submission and
   what is already stored.
4. **Persist.** The record, the receipt that makes a retry answerable, and the
   conflict record if there was one.

---

## 3. The ingest rules

| Outcome     | When                                                                 | What is written                                              |
| ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `accepted`  | The key is new and no record exists for this observation             | the record and a receipt                                     |
| `replayed`  | The key has been seen before                                         | nothing; the first answer is returned                        |
| `duplicate` | A new key, but the same observation with the same contents is stored | nothing                                                      |
| `conflict`  | A new key, the same observation, different contents                  | a `SyncConflict` and a receipt; **the stored record stands** |

**An observation is never overwritten.** A facility's report is evidence, and
evidence that silently changes is not evidence. The disagreement is recorded per
field, with both values, so a supervisor can see what each device actually sent.

**The platform decides provenance.** The stamp — whether a record is simulated,
and where it came from — is applied after the client's payload and in place of
anything the client claimed (`PLATFORM_STAMP`), so a device can neither have its
data believed nor have it discarded by asserting its own provenance. `simulation`
is deliberately absent from the sources a client may claim.

**A device clock is evidence, not authority.** A capture more than five minutes
ahead of the server is refused, because a record stamped in the future cannot be
ordered against anything. The device keeps it in its outbox and a corrected clock
delivers it.

**Observations are keyed by their natural identity**: the type, the facility, and
whatever identifies the observation itself — the day, the cadre, the syndrome, or
for a ledger entry its own identifier (`subjectKeyOf`). This is the same addressing
the seed command uses, so a resend through the API lands on the document the
seeder wrote rather than beside it.

### 3.1 Scope

Roles and their scopes are declared in `packages/domain/src/model/identity.ts`;
the rules that apply them are `canSubmitForFacility` and `canReadDistrict` in
`apps/web/src/lib/session.ts`.

| Role               | May write                    | May read                   |
| ------------------ | ---------------------------- | -------------------------- |
| `phc_staff`        | its own facility             | its own district           |
| `district_officer` | any facility in its district | its district               |
| `state_officer`    | any facility in its region   | any district in its region |
| `national`         | any facility                 | any district               |
| `auditor`          | nothing                      | any district               |

A read of a district outside the scope is **refused**, not silently replaced with
one inside it, and the district list an officer is shown contains only the
districts they may open: a list is disclosure.

This build serves identity from a fixture adapter and exposes the identities as a
sign-in control, so the rules can be demonstrated. Replacing the adapter with real
sign-in changes no rule.

---

## 4. What a facility looks like

`apps/web/src/lib/ledger-service.ts` is a projection: it replays observations
into the readings every surface displays. It is derived — never authoritative —
and is built by the same methods the boundary calls, once from the generated
dataset and then incrementally as captures arrive.

**Positions come from the ledger.** A stock position is a reading of the
append-only entry stream at a point in time, derived by
`deriveStockSnapshot`/`replayStockLedger` (`packages/domain/src/logic`). Nothing
stores a balance, because a stored balance cannot distinguish a facility with no
demand from one with no stock.

**Cover is not a division.** `daysOfStock` returns `null` — not zero, not
infinity — when demand cannot be measured, so every caller has to decide how to
present an unknown instead of silently presenting a safe quantity.

**A stock-out corrects the demand rate.** Recorded issues during a stock-out
measure supply, not need. Where any day in the window had an empty shelf, the
rate is taken from the days that were not censored, and `demandBasis` says so.

**Stock in transit is derived from both ends of a transfer**, so a facility that
cannot see a delivery heading for it still shows it as on its way — the
double-ordering that makes stock expire in one store while another runs out.

### 4.1 Unknown is not safe

| Status        | Meaning                                         | What is shown                                  |
| ------------- | ----------------------------------------------- | ---------------------------------------------- |
| `current`     | something arrived within `STALE_AFTER_DAYS` (3) | the derived figures                            |
| `stale`       | the newest reading is older than that           | the figures, dated, and the status             |
| `never-heard` | nothing has ever arrived from this facility     | no figures at all — the columns read `unknown` |

The gap panel is computed by `detectReportingGaps`, with the same rule the
dataset inspector reports, and a gap that reaches the end of the observation
window is left **open** rather than given an end it did not have.

---

## 5. What the platform expects, and what it asks of somebody

The analytical path runs in one place and is imported by two callers:
`apps/simulator/src/intelligence.ts` takes a generated world and returns
forecasts, scores and alerts, and both `pnpm worker:score` and the intelligence
surface call it. A second implementation on the web side would be the easiest way
for a card and a report to disagree about the same dataset.

```
syndromic signals → de-noised baseline → CUSUM → growth rate
   ↓ (item treats the syndrome)
ledger → demand series → censored-demand correction → forecast (p50, p90)
   ↓                              ↓
   └── surge lift ────────────────┴→ nine drivers → band → alert
```

**An alert's explanation is written ahead of the burst, in one place for two
callers.** `@civora/ai` walks the whole alert set for every language the records
carry (`generateAdvisories`), reports a refusal as a result rather than throwing
it, and puts back only the languages a draft was actually written for
(`withAdvisoryBodies`) — so a language that could not be written keeps the body
the alert was raised with, and prose that failed validation never reaches a
record. `apps/worker/src/advisories.ts` (`pnpm worker:advisories`) is the batch
form and `apps/web/src/lib/advisory-service.ts` is the form the surface reads;
both call the same function, and the languages come off `Object.keys(alert.bodies)`
rather than from a list, so what is written for cannot drift from what a reader
can be shown. Nothing generates a body per row: the set is one pass, before
anybody opens an alert.

**What the reasoning layer cost is counted at the call, not estimated.**
`packages/domain/src/ports/reasoning-provider.ts` carries an optional `telemetry()`
and both adapters implement it: the cloud adapter counts requests, attempts, cache
hits, refusals, tokens and milliseconds **per task**, and the recorded-replay
adapter counts the same shape while sending nothing anywhere — no model is named,
no tokens are reported, and attempts stays at zero. `apps/web/src/lib/telemetry.ts`
turns those counts into what a reader sees: the adapter is named beside the
numbers because the same panel under a replay adapter is not a measurement of a
model, a token count nobody reported reads as _not reported_ rather than as `0`,
and the volume figures are labelled as arithmetic over the current inbox — one
request per alert per language, paid once per pass — against which a free tier can
be assessed. Nothing in the panel makes a call: `/api/telemetry` is a read, which
is why it is polled while the advisory read beside it is deliberately not.

**An evaluation that cannot fail is not evidence, so both evaluations carry a
control.** `pnpm ai:eval` has two modes and they are deliberately different kinds
of claim. `--grounding` (`packages/ai/src/eval/grounding-cases.ts`) injects an
alert whose facts take the shapes that break a numeral comparison — a seven-digit
figure, a negative change, a three-place decimal — and states, for each draft,
whether a reader may be shown it. Every accepted draft is then re-run with a
figure no fact carries, and the run fails unless it stops being accepted: that
control is what makes the acceptances mean something, and it is why the mode needs
neither credentials nor a corpus. It also prints the rule refusing a draft written
without it. `--golden-set` (`packages/ai/src/eval/golden-set.ts`) scores readings
against hand-written labels, and its own integrity is part of the contract — a case
without provenance, without its media, or whose media digest does not match is
**refused by name** rather than skipped, because a corpus that cannot be read is
not a smaller corpus. It scores the platform's _decision_, not only the reader's
answer: each labelled line goes through `decideLine`, and a line that would have
been written where the label says a person should have decided is a false accept,
which is not a rate and cannot be traded against accuracy. The accuracy figures
carry the threshold they were measured against and every failure beside them, and
with an empty corpus the mode prints `NOT MEASURED` with the reason and **no
percentage**, because a rate over nothing is the one output that would make a green
run mean nothing was checked. CI runs both, accepts `0` (measured and passing) and
`2` (not measured) for the golden set, fails on `1`, and prints which one it saw.

**Censored demand is corrected before anything is fitted**, and the count and the
method travel on every forecast (`packages/domain/src/logic/censoring.ts`,
`packages/forecasting/src/impute.ts`). The measurement of what that correction is
worth is generated, not asserted: `pnpm forecast:backtest` writes
`docs/EVALUATION.md`, which runs the engine twice over the same origins — once
corrected, once not — and publishes the populations where it helps and the
population where it does not.

**The band is decided by what was measured about the shelf.**
`SHELF_DRIVERS` (shortfall probability, cover, surge, expiry) carry the index;
the other five drivers are reported with their contributions and their sentences
as context, because measurement on three generated worlds showed them identical to
two decimal places across all three — every catalogue item is essential, every
district serves a similar population, resupply takes about a week everywhere. A
band that moved with those would report the catalogue rather than anybody's shelf.

**A probability is never shown without its window.** `shortfallProbability` is
the forecast's own measured number over the facility's replenishment window (its
observed lead time, floored at a week and capped at the horizon), and
`shortfallWindowDays` travels with it on the score's facts. `riskIndex` is the
composite: it orders a list and picks a band, and it is not a probability.

**An alert is a condition, not a notification.** Its identity is the facility,
the item and the set of contributing reasons, so a daily re-run does not raise the
same alert again; its history is append-only and carries the actor, the role, the
time and the reason for every move; and a move the transition table does not allow
is refused rather than clamped (`packages/domain/src/logic/alert.ts`).

---

## 6. Honesty boundaries

Stated here so they cannot drift into a claim:

- Every observation in this build is **simulated**, and every record says so in
  its own fields (`synthetic: true`, with a provenance naming the generator). The
  anchors the dataset rests on — census populations, the national essential
  medicines list — are cited in `docs/DATA_PROVENANCE.md`; the three sources that
  could not be retrieved are recorded as failures rather than substituted.
- The **federation** is not deployed. Nothing here is a multi-organisation
  deployment, and no differential-privacy mechanism is running.
- The visibility surface **polls**; the local adapter has no change feed. The
  interface says so rather than implying a live subscription.
- **Forecasts, risk scores and alerts are real computations over generated data.**
  They are produced by the code in this repository, reproducible from a published
  seed, and measured in `docs/EVALUATION.md`. What they are _not_ is a statement
  about any real facility: every series is generated.
- **Nothing is redistributed.** No transfer has ever been recommended or made,
  and no optimiser has been run (Phase 6).
- **The Cloud backend has never been executed.** The `bqml` adapter is unit-tested
  against fixtures and the report records the live path as unexecuted, because
  there are no Google Cloud credentials in this environment.
- **No model has been called.** Every reasoning test drives a stub, the recorded
  adapter has no recordings, and the intake surfaces accept a supplied reading
  instead of reading a photograph or hearing a recording. So the **golden set is
  empty**, and every report of extraction accuracy says `NOT MEASURED` rather than
  quoting a figure: a fixture is only a fixture if it was captured from a real
  call, with the command and the day recorded, and writing one by hand would be
  manufacturing the evidence the command exists to produce. The grounding
  assertion does not depend on a model — it checks a rule against injected facts —
  and it is the half of this that is genuinely measured today.
- **The negative controls are tested, not asserted.** `apps/simulator/src/intelligence.test.ts`
  runs the whole pipeline over the generated scenarios with nothing wrong in them
  and asserts what it finds: no surge, nothing lifted, six alerts out of 789 pairs,
  698 of them in the low band. It is not zero, and the tests say which pairs cross
  and why — a shelf holding less than the wait for its next delivery is a pair to
  alert on, not a false positive to tune away.
