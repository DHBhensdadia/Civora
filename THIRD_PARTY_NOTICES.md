# Third-party notices

This project is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It depends
on the third-party packages listed below.

## Direct dependencies

Every package any workspace manifest declares, at the version `pnpm-lock.yaml`
resolves, with the licence read from the installed package's own `package.json`
on 2026-09-27 — re-checked this date, and reproducible with `pnpm licenses list`,
which prints the whole tree including transitive dependencies.

**Runtime:**

| Package                                                        | Version | Licence    |
| -------------------------------------------------------------- | ------- | ---------- |
| [`next`](https://www.npmjs.com/package/next)                   | 16.3.6  | MIT        |
| [`react`](https://www.npmjs.com/package/react)                 | 19.3.0  | MIT        |
| [`react-dom`](https://www.npmjs.com/package/react-dom)         | 19.3.0  | MIT        |
| [`zod`](https://www.npmjs.com/package/zod)                     | 4.6.5   | MIT        |
| [`@google/genai`](https://www.npmjs.com/package/@google/genai) | 2.24.0  | Apache-2.0 |

**Build and development:**

| Package                                                                                      | Version | Licence    |
| -------------------------------------------------------------------------------------------- | ------- | ---------- |
| [`tailwindcss`](https://www.npmjs.com/package/tailwindcss)                                   | 4.3.3   | MIT        |
| [`@tailwindcss/postcss`](https://www.npmjs.com/package/@tailwindcss/postcss)                 | 4.3.3   | MIT        |
| [`vite`](https://www.npmjs.com/package/vite)                                                 | 8.3.1   | MIT        |
| [`vitest`](https://www.npmjs.com/package/vitest)                                             | 5.0.1   | MIT        |
| [`@playwright/test`](https://www.npmjs.com/package/@playwright/test)                         | 1.63.0  | Apache-2.0 |
| [`typescript`](https://www.npmjs.com/package/typescript)                                     | 6.0.3   | Apache-2.0 |
| [`eslint`](https://www.npmjs.com/package/eslint)                                             | 10.11.0 | MIT        |
| [`@eslint/js`](https://www.npmjs.com/package/@eslint/js)                                     | 10.0.1  | MIT        |
| [`typescript-eslint`](https://www.npmjs.com/package/typescript-eslint)                       | 8.70.1  | MIT        |
| [`eslint-config-prettier`](https://www.npmjs.com/package/eslint-config-prettier)             | 10.1.8  | MIT        |
| [`prettier`](https://www.npmjs.com/package/prettier)                                         | 3.9.9   | MIT        |
| [`@types/node`](https://www.npmjs.com/package/@types/node)                                   | 26.6.2  | MIT        |
| [`@types/react`](https://www.npmjs.com/package/@types/react)                                 | 19.3.0  | MIT        |
| [`@types/react-dom`](https://www.npmjs.com/package/@types/react-dom)                         | 19.3.0  | MIT        |
| [`firebase`](https://www.npmjs.com/package/firebase)                                         | 12.19.0 | Apache-2.0 |
| [`@firebase/rules-unit-testing`](https://www.npmjs.com/package/@firebase/rules-unit-testing) | 5.0.2   | Apache-2.0 |
| [`firebase-tools`](https://www.npmjs.com/package/firebase-tools)                             | 15.31.0 | MIT        |

Every licence above is permissive and compatible with redistribution under
Apache-2.0. No copyleft dependency is used.

Two entries are worth a sentence each, because their presence says something
about the build. **`@google/genai` is the one runtime SDK that reaches a network
service**, and it is imported only by the live reasoning adapter
(`packages/ai/src/gemini-client.ts`), which is the only file that reads an API
key. **`firebase` and `@firebase/rules-unit-testing` are development
dependencies**: they are used by the rules tests against the emulator
(`rules-tests/`), not by the application — the tenancy rules in
`infra/firestore.rules` are the artefact, and nothing in the running platform
imports the Firebase SDK. The demonstration's adapters are in-memory and
fixture; selecting a hosted one throws `ProviderNotAvailableError` by name
(`apps/web/src/providers.ts`) rather than failing obscurely later.

## Transitive dependencies

The complete transitive tree, with resolved versions for every package, is
recorded in `pnpm-lock.yaml` and can be reproduced with
`pnpm install --frozen-lockfile`. The table above covers direct dependencies; the
full text of each licence is shipped inside the corresponding package in
`node_modules`.

## Known advisories

`pnpm audit --audit-level high` passes: there are no high or critical
advisories. Two moderate advisories are present, both reached only through
`firebase-tools`, which is a development dependency for the local emulator suite
and is not part of the application's runtime dependencies or its container image.

| Advisory                                                                 | Module                | Severity | Path                                                          | Patched in |
| ------------------------------------------------------------------------ | --------------------- | -------- | ------------------------------------------------------------- | ---------- |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid`                | moderate | `firebase-tools > gaxios > uuid`                              | `>=11.1.1` |
| [GHSA-8988-4f7v-96qf](https://github.com/advisories/GHSA-8988-4f7v-96qf) | `@opentelemetry/core` | moderate | `firebase-tools > @google-cloud/pubsub > @opentelemetry/core` | `>=2.8.0`  |

Neither is reachable from the application: the emulator tooling is not installed
in the runtime image, and neither module handles untrusted input on the paths
this project exercises. Both will clear when `firebase-tools` picks up the
patched versions. This is a documented exception, not an accepted risk in
shipped code.

## Data

Third-party **data** is recorded separately, with its licence and provenance, in
[docs/DATA_PROVENANCE.md](docs/DATA_PROVENANCE.md). The values this build uses
verbatim are the 2011 census district populations for Odisha and Bihar, the
census state listing (truncated before the smaller states, which are allocated by
documented rule instead) and the National List of Essential Medicines 2022 —
whose section codes, generic names, dosage forms, strengths and level-of-care
markers are parsed by the same importer a real extract would go through, seventy
items carried into the catalogue. Two Indian Public Health Standards norms are
cited rather than reproduced; three further sources — the Local Government
Directory, the IDSP syndrome taxonomy and Rural Health Statistics — could not be
retrieved at all, and are recorded as failures rather than replaced with
something plausible.

**No ministry file is redistributed here.** Two CSV files are tracked under
`apps/web/public/samples/`, and both were written for this repository in the
documented shape (their own README says which is which and how to regenerate
them); an importer reads them exactly as it would read a real export.
