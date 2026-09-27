# AI approach — every call site, and what happens when the model says nothing

> Gate 16 of the verification matrix is an adversarial review: _enumerate every AI call site, and
> for each, state what breaks if it returns nothing; any call site where nothing meaningful breaks
> is decoration and must either be removed or justified._ This file is that review, written down
> where a judge or a reviewer can argue with it rather than reconstructed from the code.
>
> Everything below is read off the repository at the submission commit. The live evidence — what
> each task actually wrote when a real model was asked — is in `state/RUN_STATE.md` §3f; the
> command that produces it is named beside each claim.

## 1. What the integration is

The platform speaks one port and nothing else. `ReasoningProvider` (in `@civora/domain`) has a
single method — `reason(request)` — and returns a value the caller's own zod schema has already
validated, or throws. Two adapters implement it: `GeminiReasoningProvider` for a real model and a
fixture adapter that replays recorded responses. **One rule selects between them**
(`selectReasoningProvider`, `packages/ai/src/select-provider.ts`) and both the web process and the
batch jobs obey it, so a surface and a worker cannot disagree about which writer is behind a
sentence.

Three properties are structural rather than stylistic:

- **The model never receives a bare question and never returns free text.** Every call is a
  registered prompt asset (`packages/ai/src/prompts/`) carrying a system instruction, a facts
  block and an output schema. The schema the model is constrained by and the schema the answer is
  validated against are the _same zod object_: `z.toJSONSchema` bridges it into the request's
  `response_format` (`packages/ai/src/request.ts`), so the instruction and the validation cannot
  drift apart.
- **Quantities originate in the deterministic engines.** `factsTextOf` writes the admissible facts
  out in full for every call, and a draft whose numerals are not in that block is rejected before
  it leaves the adapter (`grounded`, `packages/ai/src/grounding.ts`). Commitments A7 and the
  honesty rules of ADR 0005 rest on this, and `pnpm ai:eval --grounding` is a CI gate that
  exercises it adversarially.
- **A refusal is a result, not an exception.** Each of the narrative call sites returns an
  `…Attempt` record with `status: 'written' | 'refused'` and the provider's own sentence in
  `refusal`. That is what lets a surface say _why_ a panel is empty instead of showing an empty
  panel a reader could take for agreement.

The key is read from the server's environment only; `pnpm check:bundle` reads the built client
bundles and fails if the endpoint, the SDK class, the key's name or the provider configuration
appears in one, with two positive controls proving the check can fail.

## 2. The six registered prompts

| Asset                     | Input                         | What it produces                                | Called from                                                            |
| ------------------------- | ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `stock-extraction@1`      | a photograph                  | a register reading, per line, with a confidence | `POST /api/vision`                                                     |
| `voice-command-parsing@1` | a recording                   | a capture command and what was heard            | `POST /api/voice`                                                      |
| `advisory-generation@2`   | an alert's facts + a language | one advisory body per language                  | `pnpm worker:advisories`, `POST /api/advisories`                       |
| `transfer-rationale@2`    | a proposal's facts            | prose beside one proposal                       | the redistribution read (`apps/web/src/lib/redistribution-service.ts`) |
| `federation-narrative@2`  | a round's facts               | a narrative for one federated round             | the federation console build                                           |
| `driver-explanation@1`    | an alert's drivers            | an explanation of one risk driver               | **no caller** (§4)                                                     |

## 3. The five call sites, and the nothing-case

### 3.1 `stock-extraction@1` — reading a paper register

**What it is for.** A health worker photographs a stock register; the reading becomes ledger lines,
and lines below the confidence threshold are _held_ rather than written.

**If it returns nothing.** `POST /api/vision` answers `503` with
`outcome: 'unavailable'`, `reason: 'reasoning-provider-unavailable'`, and the provider's own
sentence in `detail`. Nothing is written to the ledger: a photograph never becomes a ledger entry
by accident. The screen shows the refusal in the panel that would otherwise carry the reading
(`vision-refusal`), and the journeys assert the wording rather than only the status code —
`e2e/vision-intake.spec.ts`, "the button that would read a photograph says it cannot", which runs
against this build with no key and asserts the sentence and that the ledger is untouched.

**What still works.** The whole capture path. A person may supply the reading themselves — the
route accepts an `extraction` instead of an image and records it with `source: 'supplied'` — and
the review queue, the ledger write, the batch report and the district surface are all
model-independent. The offline capture and reconciliation journey (`e2e/capture.spec.ts`) is
executed in exactly that state.

**Is it decoration?** No. It is the only path by which a photographed register becomes structured
data, and the live run read a rendered register page into the ledger with four lines written and
one held (`RUN_STATE.md` §3f, `pnpm e2e live-ai.spec.ts` / the register journey).

### 3.2 `voice-command-parsing@1` — hearing a spoken update

**What it is for.** A worker speaks a stock update in the field; the platform turns what was said
into a capture command — item, quantity, direction — that a person then confirms.

**If it returns nothing.** `POST /api/voice` answers `503` `unavailable` in the same shape as the
vision route, nothing is held as a pending write, and the surface shows the sentence in
`voice-refusal`. The e2e voice journey runs against this state.

**What still works.** Everything downstream of the confirmation. A voice proposal is written only
by `POST /api/voice/confirm` carrying `confirm: true` literally, and that route works from a
supplied command as well as from a listened-to recording. Without a model, nothing is guessed at
from an utterance: the utterance is not heard, and the platform says so.

**Is it decoration?** No — it is the only path from audio to a structured command, and it was
executed live: a synthesised recording was heard, held, and written only after a person confirmed
(`RUN_STATE.md` §3f; the sample input is labelled generated in
`apps/web/public/samples/README.md`).

### 3.3 `advisory-generation@2` — writing bodies before the burst

**What it is for.** When an alert is raised, a body is written for **every language the record
carries**, ahead of anybody opening a screen: a demonstration whose prose arrives when a judge
clicks is one that fails when the quota does. `generateAdvisories` walks the whole set;
`withAdvisoryBodies` puts only the written bodies onto the record.

**If it returns nothing.** Each language is reported as `refused` with the writer's own sentence,
and the alert **keeps the body it was raised with** rather than losing it to a writer that could not
improve it. The surface shows, per language, "No prose was written: <reason>" beside the record's
own body (`advisory-refusal`), and the set reports `attempted / written / refused` counts. With no
key the shipping state is `written: 0` and every row refused; `e2e/advisories.spec.ts` asserts that
state, including that a refusal is never rendered as an empty space.

**What still works.** Alerts, their drivers, their severities, their projections and their bodies
in the record are all computed deterministically. The `donor`-independent advisory _panel_ is
absent prose, named.

**Is it decoration?** No — the phase's own requirement is that an advisory exists before anybody
opens a screen, and the live run wrote **6/6** (from 1–2 of 6 before the citation defect was
fixed, `RUN_STATE.md` §3f).

### 3.4 `transfer-rationale@2` — explaining a proposal

**What it is for.** Each redistribution proposal carries prose — why this transfer, from this
donor, to this receiver, in the light of its own measured impact. The writer is given the
proposal's facts and may cite only those.

**If it returns nothing.** The proposal row shows the writer's refusal in the place the explanation
would be (`rationale-refusal`, "no recorded response …" with the task named). The plan, the four
weightings, the constraint verdict, the impact estimate with its assumptions, the decision route
and the audit chain are all independent of it. `e2e/redistribution.spec.ts` asserts that every row
carries either prose or the refusal — never an empty space.

**Is it decoration?** No, and this is the site where that question was most worth asking. The
proposal, its admission by the validator and its numbers are arithmetic. What the writer adds is
the one thing arithmetic cannot: a sentence a district officer can act on. The live run wrote
**6/6**.

### 3.5 `federation-narrative@2` — summarising a round

**What it is for.** Each federated round produces a narrative for the console: what the round did,
with its privacy bound stated as the round's own ε.

**If it returns nothing.** The console prints, per round, the attempt and its refusal — "N of M
round(s) refused a narrative, and no fixture was invented to fill the panel: a summary no model
wrote would be the most convincing thing on this page and the least true." The ε curve, the
payload assertion, the silo table and the DP accounting are deterministic and unaffected. The live
run wrote **4/4**.

**Is it decoration?** No: it is the only place a round's _meaning_ is stated in language rather
than in a table, and it is written from the round's own facts under the same grounding rule as the
other two narratives.

## 4. The prompt asset with no caller

`driver-explanation@1` is registered with a system instruction, a schema and its place in the
corpus — and **nothing calls it**. The honest handling of that is to say so, in the places a
reviewer looks: this file, `README.md`'s status table, `state/FEATURES.md` and `RUN_STATE.md` §3f.
It is not counted as a capability, it is not in the five live-verified tasks, and it is not shown
on any surface. It survives the adversarial review in the only way an unwired asset can: as a
**named deferral** with the wiring it would take (a field on the alert record, and a place to read
it) rather than as a silent gap.

Two other unevidenced items are named in the same way rather than being quietly promoted:

- **`pnpm ai:eval --golden-set` prints `NOT MEASURED` and exits `2`.** A case is only a case if its
  response came from a real call, and no labelled corpus exists, so the loader refuses a case
  without provenance by name. CI accepts `0` and `2` and prints which it saw.
- **The BigQuery ML path (`bqml`) has never executed.** It needs a Google Cloud project (blocker
  B1); the backtest says so in its own row rather than estimating a figure.

## 5. What the platform would still do if the model layer returned nothing at all

This is the strongest form of the question, and it has a demonstrable answer, because it is the
state CI runs in: the provider selected in the gate is the fixture adapter with no recorded
corpus, which **refuses every request** rather than pretending. In that state:

- every unit, contract and rule test passes; the build, the bundle check and the full e2e suite
  pass, with each refusal asserted on the surface it belongs to;
- capture, visibility, forecasting, alerting, the command tower, redistribution, federation, the
  importers and the audit chain are all exercised end to end;
- the five gated live-model journeys **skip with their reason printed**, rather than passing
  vacuously.

So the AI layer is load-bearing where it is wired — intake, prose, explanation — and nothing
_structural_ depends on it, which is the property a deployment needs: a quota-exhausted day is a
day of refusals with their reasons attached, not a platform that stops working.

## 6. The adversarial finding, in one paragraph

Every one of the five wired call sites survived the question _"what breaks if it returns nothing?"_
with a specific, asserted answer: a refusal sentence on the surface that would otherwise carry the
output, nothing written into the record, and the deterministic path around it unaffected — vision
and voice refuse the intake and still accept a person's own reading or command; the three narrative
tasks refuse per item and leave the record's existing content in place. **Nothing was removed,
because nothing was found to be decorative**; the one asset that _is_ unwired
(`driver-explanation@1`) is named as deferred rather than counted, and the two evaluation gaps
(`--golden-set` unmeasured, `bqml` unexecuted) are published as what they are. The claim this
project makes about its AI layer is therefore bounded: five tasks, all executed against a real
model, all refusing honestly when the model cannot answer, and all of them unable to put a number
into the record that a deterministic engine did not compute.
