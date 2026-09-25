/**
 * Entry point for `--import`, so a script can run against the workspace's
 * TypeScript sources without a build step:
 *
 *   node --import ./scripts/node/register-typescript.mjs path/to/script.ts
 *
 * The hook itself is in `resolve-extensionless.mjs`; this file exists only to
 * register it. `registerHooks` rather than `register`: the resolution is pure
 * string work with no I/O, so it can run synchronously on the main thread rather
 * than in a separate loader thread, and it is the API Node has not deprecated.
 */

import { registerHooks } from 'node:module';

import { resolve } from './resolve-extensionless.mjs';

registerHooks({ resolve });
