# Interoperability

A ministry does not adopt a platform by retyping a decade of returns. It adopts one
by pointing it at the exports it already produces — a monthly HMIS statement, a
directory of administrative codes, the national list of essential medicines — and
by being able to see, before anything is written, exactly what the platform will do
with the file.

This document is the front door to each adapter: what its source format is, where
the format came from, what the licence position is, and a **field-by-field**
correspondence between the file and this platform's records. It follows
[`DATA_PROVENANCE.md`](DATA_PROVENANCE.md)'s discipline, and one rule from it in
particular: **a source whose shape cannot be confirmed is labelled as
reconstructed and never presented as authoritative.** Two of the three adapters
below are in that position, and each says so at the top of its own table rather
than in a footnote.

Every mapping table here is held in the code as a value — `LGD_FIELD_MAPPING`,
`HMIS_FIELD_MAPPING` — and a unit test asserts each table names every field its
reader requires and no more. A table in a document drifts; a table that fails the
build does not.

## How an import reaches the record

An importer does not decide what to write. The adapter reads the file into
**submissions** — the same envelope a nurse's phone sends, built and validated
through the platform's own contract — and the ingest boundary decides each one:
the same idempotency keys, the same projection, the same audit chain. Three
consequences follow, and they are the point:

- **An imported row is a record like any other.** It differs from a capture by its
  `captureSource` (`import`) and by the provenance naming the file it arrived in.
  A reader of the ledger can tell them apart without asking.
- **Re-importing is a replay, not a second movement.** Each row's identifier is
  derived from the row's own content and the file's digest, so importing the same
  file twice is answered from the receipts the first import wrote.
- **The act is on the chain.** Every row written appends the boundary's own
  `capture-recorded` entry, and accepting a file appends one `import-accepted`
  entry naming the file's digest, the rows it wrote and the person who accepted it.
  A file that changes nothing appends nothing: the chain is for what changed.

The in-app flow (`/import`, `apps/web/src/app/import/page.tsx`) is a two-step on
purpose. **Check** runs the same code the import runs, with writing turned off, and
reports per row what the platform would do — including the rows it refuses and the
sentence it refuses them with. **Accept** performs exactly what the check showed.
Scope is decided per row: a district officer's file may name another district's
facility, and that row is refused with the same sentence the capture surface gives
and left for whoever does cover it.

What a deployment changes and what it does not: the transport (a multipart upload
or a signed URL rather than the text in a JSON body) and the credentials of a
scheduled job. The boundary, the key scheme, the chain and the register are the
same.

## `hmis-csv` — the monthly stock statement

|                      |                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**           | Health Management Information System (HMIS) monthly facility returns, Ministry of Health and Family Welfare                                                                                                                                                                                        |
| **Shape**            | Reconstructed. HMIS publishes its indicators and its portal, but the _export_ a state department produces is not a fixed public artefact; the seven columns below are the ones a monthly stock statement carries, and a deployment's real extract is mapped column by column before it is imported |
| **Licence position** | Government of India health reporting format. No HMIS file is redistributed here: the two files in `apps/web/public/samples/` are written for this repository in the documented shape                                                                                                               |
| **Sample**           | `apps/web/public/samples/hmis-monthly-sample.csv` (6 rows) and `hmis-monthly-broken.csv` (the same statement with a receipt that names no batch — the ordinary way one of these arrives damaged)                                                                                                   |
| **Reader**           | `packages/interop/src/hmis-csv.ts`                                                                                                                                                                                                                                                                 |
| **Writes**           | One ledger entry per row, `captureSource: import`, dated on the last day of the month the return states                                                                                                                                                                                            |

| Source column   | Becomes                             | Note                                                                                   |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `facility_code` | `submission.observation.facilityId` | the platform's facility identifier; the LGD crosswalk is how a deployment gets it      |
| `month`         | `submission.observation.occurredOn` | the last day of the month, because the return totals a month and the ledger holds days |
| `item_code`     | `submission.observation.itemId`     | the platform's item identifier, as the NLEM importer builds it                         |
| `movement`      | `submission.observation.kind`       | `I` becomes issue and `R` becomes receipt; any other marker is refused                 |
| `quantity`      | `submission.observation.quantity`   | a positive whole number of dispensing units                                            |
| `batch_no`      | `submission.observation.batchId`    | required on a receipt: stock arriving must name the batch it arrived in                |
| `expiry`        | `submission.observation.expiresOn`  | required on a receipt, and must be after the day the movement belongs to               |

Five decisions are stated in the adapter rather than buried in it, because each is
one a ministry would have an opinion about:

1. **A month is not a day.** A row dated `2026-08` is written on 2026-08-31 — the
   day by which the movement it totals had certainly happened. A deployment with
   daily extracts gets daily movements and does not need the rule.
2. **`I` is an issue and `R` is a receipt**, which is the vocabulary the returns
   use. Anything else is refused rather than mapped to the nearest guess.
3. **The facility and item codes are the platform's own identifiers.** The crosswalk
   from a government's codes is the directory adapter's job and the catalogue's;
   doing it here as well would make two places answer the same question.
4. **A receipt names its batch and expiry or it is refused.** Inventing them would
   put an expiry the ministry never stated onto a batch somebody will later have to
   destroy.
5. **The month must be well formed** (`YYYY-MM`). `2026-8` and `08/2026` both appear
   in real extracts and both mean something a reader would have to guess.

The reader stops at the first row it cannot read and names the line. There is no
option to continue past a bad row, because a partial import is the failure a
ministry cannot audit: half a month's returns in the ledger and no record of which
half.

## `lgd-json` — the administrative directory

|                      |                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**           | Local Government Directory, Ministry of Panchayati Raj                                                                                                                                                                                                                                                                                             |
| **Shape**            | Reconstructed. The published district table is served through an interactive dashboard with no static listing, so **no extract was retrieved** — this is recorded as a failure in `DATA_PROVENANCE.md`. The field names below follow the directory's own published columns; the flat one-row-per-unit shape is this platform's arrangement of them |
| **Licence position** | Government of India directory, published for reuse. Nothing from it is redistributed: the fixture in `lgd.test.ts` is written for the repository                                                                                                                                                                                                   |
| **Reader**           | `packages/interop/src/lgd.ts`                                                                                                                                                                                                                                                                                                                      |
| **Writes**           | No ledger entries. An accepted file records, per district, which government code it files under, and reports what did not join                                                                                                                                                                                                                     |

| Source field               | Becomes                   | Note                                                                            |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `state_code`               | `lgdUnit.stateCode`       | two digits, kept as text so a leading zero survives                             |
| `state_name_english`       | `lgdUnit.stateName`       | matched against the platform region by name; the platform's region is the state |
| `district_code`            | `lgdUnit.districtCode`    | the code a district's HMIS return is keyed by                                   |
| `district_name_english`    | `lgdUnit.districtName`    | matched to the platform district by normalised name                             |
| `subdistrict_code`         | `lgdUnit.subdistrictCode` | the platform's block level; one sub-district is one block                       |
| `subdistrict_name_english` | `lgdUnit.subdistrictName` | recorded for a deployment whose block names differ from a register's            |

Three decisions, each stated rather than buried:

1. **Names are matched case- and space-insensitively**, because a directory writes
   `Gaya` where a facility register writes `GAYA` and both mean the district.
   **Aliases are not invented**: `Aurangabad` and `Chhatrapati Sambhajinagar` are
   the same district under a new name, and guessing that is exactly the decision an
   importer must not make for a ministry.
2. **What did not join is reported in both directions** — government units no
   platform district matched, and platform districts no government unit matched. A
   crosswalk that silently covered four of thirty districts is one that gets
   discovered at a reporting deadline.
3. **The identifier a crosswalk builds is `lgd-<stateCode>-<districtCode>`**, so a
   district's code is addressable and reproducible rather than allocated per import.

## `nlem-json` — the national list of essential medicines

|                      |                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source**           | National List of Essential Medicines 2022, Central Drugs Standard Control Organisation, Ministry of Health and Family Welfare (PDF)                             |
| **Shape**            | **Retrieved.** Section codes, generic names, dosage forms, strengths and level-of-care markers were extracted locally with `pdftotext` and are carried verbatim |
| **Licence position** | Government of India publication, used as reference values with attribution; the list itself is not redistributed                                                |
| **Retrieved**        | 2026-09-25                                                                                                                                                      |
| **Reader**           | `packages/interop/src/nlem.ts`                                                                                                                                  |
| **Used by**          | The demonstration's catalogue — the generator runs the same importer a real extract would go through — and therefore every surface that names a medicine        |

| Source field  | Becomes                                                            | Note                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section`     | section of `item.id` (`nlem-2-1-5-paracetamol`)                    | the list's own section code, kept as the identifier's spine                                                                                               |
| `genericName` | `item.genericName`                                                 | the published name, e.g. `Paracetamol`                                                                                                                    |
| `form`        | `item.form`, and the unit of consumption by rule                   | `tablet`, `injection`, `iv fluid` …                                                                                                                       |
| `strength`    | `item.strength`                                                    | e.g. `500 mg`                                                                                                                                             |
| `levels`      | `item.levels`                                                      | `P`, `S`, `T` → primary, secondary, tertiary                                                                                                              |
| `category`    | `item.category`                                                    | **not in the published list.** NLEM classifies by section; this is an assumption, carried in the extract as itself and documented in `DATA_PROVENANCE.md` |
| —             | `unit`, `packSize`, `shelfLifeMonths`, `storageClass`, consumption | derived by rule from form and category; every rule is an entry in `DATA_PROVENANCE.md`'s assumptions table                                                |

Two recorded limits: Oral Rehydration Salts are absent from the catalogue because
their section code could not be extracted from the parsed text — a recorded gap
rather than an invented code — and the derivation rules (unit, pack size, shelf
life, storage class) are assumptions, not published values.

## Deferred, and named rather than implied

Two adapters the phase names are **not** in this build, and they are listed as
deferred in this repository's README and in the project state file
(`state/RUN_STATE.md`, in the workspace beside the repository) rather than only
here:

| Adapter         | What it would read                                       | What implementing it would take                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eaushadhi-csv` | e-Aushadhi warehouse receipt and issue extracts          | A warehouse-side identifier for the receiving facility (the LGD crosswalk plus an HFR code), and a decision about which warehouse movements belong in a facility's own ledger — a receipt at a warehouse is not stock at a facility                   |
| `ihip-json`     | Integrated Health Information Platform syndromic signals | The programme's actual syndrome taxonomy, which could not be retrieved (recorded in `DATA_PROVENANCE.md`); importing a plausible taxonomy would put this platform's clinical grouping into a national feed, which is the opposite of interoperability |

`nlem-json` is implemented and exercised by the generator but is **not offered by
the import surface**: the catalogue is reference data the platform is built
against, and a file that replaced it at runtime would change what every record on
the ledger means. The reader exists; the flow refuses the format by name rather
than handing it to the monthly statement reader.

## What is not claimed

- **No live ministry API is integrated.** No HMIS, e-Aushadhi, IHIP or LGD endpoint
  was called: access is not obtainable in this window, and the adapter contracts,
  fixtures and mapping tables are the deliverable.
- **No FHIR or ABDM conformance is claimed.** The platform aligns to HFR/LGD
  identifier _shapes_ and documents the ABDM mapping direction; certification is a
  process this repository has not been through, and a prototype claiming it would be
  claiming a review that never happened.
- **Two of the three shapes are reconstructed**, as stated at the top of their
  tables. A ministry's real extract is mapped column by column before it is
  imported, which is what the mapping table is for.
