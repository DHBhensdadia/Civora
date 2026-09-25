/**
 * `@civora/domain` — schemas, boundary ports and the local-first adapters.
 *
 * Everything in this package is pure TypeScript with no environment
 * assumptions: no clock reads, no network, no filesystem. That is what keeps the
 * domain testable without mocks and what lets the platform be developed and
 * demoed with no cloud credentials.
 *
 * The model is the single source of truth for every shape in the platform.
 * TypeScript types are inferred from the schemas, never written beside them.
 */

export * from './errors';

export * from './model';
export * from './model/ingest';

export * from './logic/alert';
export * from './logic/case-demand';
export * from './logic/censoring';
export * from './logic/dates';
export * from './logic/extraction';
export * from './logic/ingest';
export * from './logic/inventory';
export * from './logic/keys';
export * from './logic/ledger';
export * from './logic/match';
export * from './logic/network';
export * from './logic/reporting';
export * from './logic/risk';
export * from './logic/snapshot';
export * from './logic/surge';

export * from './ports/data-provider';
export * from './ports/auth-provider';
export * from './ports/reasoning-provider';

export * from './adapters/in-memory-data-provider';
export * from './adapters/fixture-auth-provider';
export * from './adapters/fixture-reasoning-provider';
