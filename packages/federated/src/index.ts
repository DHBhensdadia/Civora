/**
 * `@civora/federated` — the Samvad federation.
 *
 * Scope: round coordination between administrative silos, weighted aggregation
 * of differentiable models, secure aggregation by additive masking, and the
 * Rényi-DP accountant that prices the noise the coordinator adds.
 *
 * The invariant this package protects: **raw records never cross a silo
 * boundary.** Only a parameter vector, a sample count and a loss travel, and
 * `payload.ts` is the allow-list plus the sentinel scan that makes the claim
 * falsifiable — the phase's blocking test.
 *
 * What is real here: the algorithm, the physical partitioning (a silo's samples
 * are only ever touched inside `local.ts`), the privacy accounting over the
 * mechanism actually run, and the round ledger a reader compares against.
 * What is not: the managed substrate. `statement.ts` carries the sentence the
 * Console must display — a reference implementation, not a deployed
 * multi-organisation federation (ADR 0006).
 *
 * The model is deliberately differentiable — regularised linear regression and a
 * small MLP — because averaging parameters is only defined for one, and a
 * gradient-boosted ensemble cannot be FedAvg-ed by averaging its trees.
 */

export * from './accountant';
export * from './aggregate';
export * from './coordinator';
export * from './features';
export * from './identifiers';
export * from './local';
export * from './masking';
export * from './model';
export * from './payload';
export * from './rng';
export * from './scaling';
export * from './statement';
export * from './statistics';
export * from './types';
