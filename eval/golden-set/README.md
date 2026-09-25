# The golden set

One file per recorded reading, scored by `pnpm ai:eval --golden-set`.

**This directory is empty of cases, and that is a result rather than an oversight.** A case is
only a case if the response in it was captured from a **real call**: the model read the media, and
what it returned is what is stored here. Every live Google AI path on this project is blocked on
**B2** (no Gemini API key), so no legitimate case exists yet, the evaluator prints `NOT MEASURED`
with the reason, and it reports no percentage. A percentage over an empty set would be a
measurement pretending to exist, which is the one thing this corpus must never be.

## The rule

- **The response is the model's, verbatim.** Recorded, not written, not tidied. It was captured
  once and it is a regression test from then on: the corpus measures the reader that produced it,
  not a live model.
- **The provenance is complete or the case is refused.** Every case names the exact command that
  obtained the response, the day it was captured, the model that answered, and the `sha256:` digest
  of the media the response belongs to. The loader checks that the media is present and that its
  digest matches; a case without any of these is **refused by name** and the run exits `1` rather
  than quietly scoring one case fewer.
- **The labels are a person's.** They are the truth about the media, written by somebody looking at
  it — never derived from the response being scored, which would make the evaluation a tautology.
- **The catalogue entry is the label, not the name.** A case says which `itemId` a line must resolve
  to. The written name is there for the failure message, and a name that resolves unambiguously to a
  _different_ entry is refused as a self-contradicting label.
- **The media must be publishable.** A real register page carries patient names and batch records
  belonging to a real facility. Capture a **demonstration** register — the simulator's own facility,
  printed and photographed — or redact before capturing, and never commit anything a public
  repository should not carry.

## Format

`<id>.case.json` in this directory, media wherever the case points. Two tasks are scorable:
`stock-extraction@1` (a photograph) and `voice-command-parsing@1` (a recording).

```jsonc
{
  "id": "phc-khed-register-2026-09-24",
  "task": "stock-extraction@1",
  "provenance": {
    "command": "the exact line that obtained the response, as it was run",
    "capturedOn": "2026-09-24",
    "model": "the model the provider named in its own reply",
    "mediaDigest": "sha256:… of the media file below",
  },
  "media": "media/phc-khed-register-2026-09-24.jpg",
  "recorded": {
    // the response, verbatim, validated against the prompt's own output schema
    "facilityName": "PHC Khed",
    "registerDate": "2026-09-24",
    "lines": [
      {
        "itemName": "Tab. Paracetamol 500mg",
        "quantity": 40,
        "unit": "tab",
        "batchId": "B-2291",
        "expiresOn": "2027-06-30",
        "confidence": 0.93,
        "note": null,
      },
    ],
    "notes": [],
  },
  "expected": {
    "registerDate": "2026-09-24",
    "lines": [
      {
        "itemId": "item-paracetamol-500",
        "itemName": "Tab. Paracetamol 500mg",
        "quantity": 40,
        "batchId": "B-2291",
        "expiresOn": "2027-06-30",
        "routing": "write",
      },
    ],
  },
}
```

Two fields deserve a note.

- `tolerance` (`{ "by": 2, "reason": "…" }`) is **opt-in and has to be argued for in the case
  itself**, because a tolerance is the shape a fudge takes. Quantity is exact by default. Confidence
  is not compared as a number at all: what is scored is the _decision_ it produces, through the
  platform's own threshold and review rule.
- `routing` is what the platform must do with the line — `write`, or `review`. A line the platform
  would write that the labels say a person should have decided is a **false accept**, and that count
  has to be zero. It is not an average and cannot be traded against accuracy.

A voice case labels `observedOn`, `intent`, `itemId`, `quantity`, `batchId`, `expiresOn`, `language`
and `openQuestions` — the questions the parse must leave open, named the way the platform names them
(`decideVoiceCommand`'s problem codes). A question the platform should have asked and did not is
counted as a false accept for the same reason.

## Running it

```bash
pnpm ai:eval --golden-set              # the corpus in this directory
pnpm ai:eval --golden-set --corpus .   # somewhere else
```

Exit codes, which CI acts on:

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | measured, and met the stated threshold (`0.95` field accuracy, `0` false accepts) |
| `1`  | measured and below it — **or** a corpus file that cannot be scored                |
| `2`  | not measured: there was nothing legitimate to measure                             |
| `3`  | the command was asked for something it does not do                                |

## Adding the first case

1. Clear **B2** and configure a key (`CIVORA_REASONING_PROVIDER=gemini`, `GEMINI_API_KEY`,
   `GEMINI_MODEL`).
2. Capture a demonstration register photograph or recording. Keep the file — the digest is the tie
   between it and the response.
3. Ask the model with the platform's own prompt and record the response exactly as it came back.
   Save the command you ran.
4. Fill in the labels by hand, from the media, not from the response.
5. Compute the digest — `sha256sum <media>` — and write `<id>.case.json` here.
6. Run `pnpm ai:eval --golden-set`. It will now report an accuracy, the threshold it was measured
   against, and **every failure**, which is the part worth reading.
