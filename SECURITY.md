# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately to **dhbhensdadia@gmail.com**. Please
include what you observed, how to reproduce it, and the affected version or
commit. Do not open a public issue for a security report.

There is no bug-bounty programme. Acknowledgement is intended within a few days.

## What this project is

Civora is a **prototype** built for an evaluated build-and-ship exercise. It runs
on simulated data. It is not in service anywhere and it processes no real health
records.

That is a statement about its intended use, not a claim about its safety, and the
following are all known and accepted limitations of the current build rather than
vulnerabilities to report:

- The offline identity adapter resolves fixed, simulated accounts and performs no
  credential verification. It exists for local development and tests only.
- The default persistence adapter holds data in process memory and loses it on
  restart.
- The database security ruleset is deny-by-default. Collection rules are added
  together with the collections they protect.
- There is no rate limiting, no session hardening and no production deployment
  configuration in the repository yet.

## What is in scope

Anything that contradicts the above: a path where the local identity adapter can
be reached in a deployed configuration, a committed secret, a dependency with a
known high-severity advisory, or a place where simulated data is presented as
real.

## Known advisories

`pnpm audit --audit-level high` passes. Two moderate advisories are present, both
reached only through the development-only emulator tooling and absent from the
runtime image; they are enumerated in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md#known-advisories).

## Handling of secrets

Credentials are never committed. `.env*` files are ignored except for
`.env.example`, which contains placeholders only. If you believe a credential has
been committed to this repository, treat it as compromised and report it
immediately rather than opening an issue.
