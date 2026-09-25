/**
 * `@civora/domain` — schemas, boundary ports and the local-first adapters.
 *
 * Everything in this package is pure TypeScript with no environment
 * assumptions: no clock reads, no network, no filesystem. That is what lets the
 * platform be tested and demoed without credentials, and what keeps the
 * forecasting and planning code that arrives later unit-testable without mocks.
 */

export * from './errors';

export * from './ports/data-provider';
export * from './ports/auth-provider';
export * from './ports/reasoning-provider';

export * from './adapters/in-memory-data-provider';
export * from './adapters/fixture-auth-provider';
export * from './adapters/fixture-reasoning-provider';
