# Third-party notices

This project is licensed under Apache-2.0 (see [LICENSE](LICENSE)). It depends
on the third-party packages listed below.

## Direct dependencies

Licence identifiers were read from the npm registry for each package at the exact
version pinned in `pnpm-workspace.yaml`, on 2026-09-25.

| Package                                                                          | Version | Licence    |
| -------------------------------------------------------------------------------- | ------- | ---------- |
| [`next`](https://www.npmjs.com/package/next)                                     | 16.3.6  | MIT        |
| [`react`](https://www.npmjs.com/package/react)                                   | 19.3.0  | MIT        |
| [`react-dom`](https://www.npmjs.com/package/react-dom)                           | 19.3.0  | MIT        |
| [`zod`](https://www.npmjs.com/package/zod)                                       | 4.6.5   | MIT        |
| [`tailwindcss`](https://www.npmjs.com/package/tailwindcss)                       | 4.3.3   | MIT        |
| [`@tailwindcss/postcss`](https://www.npmjs.com/package/@tailwindcss/postcss)     | 4.3.3   | MIT        |
| [`postcss`](https://www.npmjs.com/package/postcss)                               | 8.5.28  | MIT        |
| [`vite`](https://www.npmjs.com/package/vite)                                     | 8.3.1   | MIT        |
| [`vitest`](https://www.npmjs.com/package/vitest)                                 | 5.0.1   | MIT        |
| [`@playwright/test`](https://www.npmjs.com/package/@playwright/test)             | 1.63.0  | Apache-2.0 |
| [`typescript`](https://www.npmjs.com/package/typescript)                         | 6.0.3   | Apache-2.0 |
| [`eslint`](https://www.npmjs.com/package/eslint)                                 | 10.11.0 | MIT        |
| [`@eslint/js`](https://www.npmjs.com/package/@eslint/js)                         | 10.0.1  | MIT        |
| [`typescript-eslint`](https://www.npmjs.com/package/typescript-eslint)           | 8.70.1  | MIT        |
| [`eslint-config-prettier`](https://www.npmjs.com/package/eslint-config-prettier) | 10.1.8  | MIT        |
| [`prettier`](https://www.npmjs.com/package/prettier)                             | 3.9.9   | MIT        |
| [`@types/node`](https://www.npmjs.com/package/@types/node)                       | 26.6.2  | MIT        |
| [`@types/react`](https://www.npmjs.com/package/@types/react)                     | 19.3.0  | MIT        |
| [`@types/react-dom`](https://www.npmjs.com/package/@types/react-dom)             | 19.3.0  | MIT        |
| [`firebase-tools`](https://www.npmjs.com/package/firebase-tools)                 | 15.31.0 | MIT        |

Every license above is permissive and compatible with redistribution under
Apache-2.0. No copyleft dependency is used.

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
[docs/DATA_PROVENANCE.md](docs/DATA_PROVENANCE.md). No external dataset has been
incorporated yet.
