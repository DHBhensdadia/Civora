# Contributing

## Getting started

Two commands, and no credentials:

```bash
pnpm bootstrap   # installs dependencies, creates .env.local, fetches the test browser
pnpm dev         # starts the local platform on http://localhost:3000
```

`pnpm bootstrap` is not called `setup` because `pnpm setup` is a reserved command
that reconfigures your shell environment instead of running the script.

Everything runs against local adapters. There is deliberately no cloud setup
step: a change that requires a credential to develop or test will be asked to
remove that requirement rather than to document it.

## The layout

| Path              | What lives there                                                                  |
| ----------------- | --------------------------------------------------------------------------------- |
| `apps/web`        | The Next.js application: planning dashboard, capture surface, federation console. |
| `apps/worker`     | Scheduled jobs that do not belong in a request handler.                           |
| `apps/simulator`  | The deterministic generator for the synthetic facility network.                   |
| `packages/*`      | Libraries more than one deployable needs. Pure logic by default.                  |
| `packages/domain` | Schemas, boundary ports and the local-first adapters. Start here.                 |
| `packages/config` | Shared TypeScript, ESLint and Prettier presets.                                   |
| `infra/`          | Container image, emulator configuration, deployment scripts.                      |
| `e2e/`            | Browser tests that drive the real application.                                    |
| `docs/`           | Provenance, architecture and evaluation notes.                                    |

## Before you open a change

Run the same gate CI runs, in the same order, from the repository root:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
```

A change is not ready while any of these fails locally, and "it works on my
machine" is not a substitute — the local adapters exist so that every gate runs
without external services.

## Conventions

### Commits

Conventional Commits, and the subject line names the **effect**, not the
activity:

```
feat(domain): model the stock ledger as an append-only event stream
fix(forecasting): impute demand for censored stock-out days
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`,
`chore`, `data`, `sec`. Scopes follow the layout above. A body is expected
wherever behaviour changes, and it should explain _why_ the change exists.

### Code

- TypeScript everywhere. `strict` is on, and so are `noUncheckedIndexedAccess`
  and `exactOptionalPropertyTypes`. Do not weaken them to make a type error go
  away.
- Domain packages are pure: no clock reads, no randomness, no network, no
  filesystem. Side effects belong at the edges, behind a port.
- Validation is schema-first. A Zod schema is the single definition of a shape;
  the TypeScript type is inferred from it rather than written alongside it.
- Anything fetched from outside the process goes behind a port in
  `packages/domain`, so the system keeps running without that dependency.

### Tests

- Unit tests cover logic. They do not cover a user journey.
- Any user-facing flow needs a browser test that drives the real application,
  including at least one failure or edge path.
- A bug fix arrives with the test that would have caught it.

### Data

Nothing sourced from outside the repository is added without a
`docs/DATA_PROVENANCE.md` entry recording its source, licence, retrieval date
and transformation. Simulated data is labelled as simulated wherever it is
displayed.

## Reporting

Security issues: see [SECURITY.md](SECURITY.md) — do not open a public issue.
Conduct concerns: see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
