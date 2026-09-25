/**
 * `@civora/federated` — the Samvad federation.
 *
 * Scope: round coordination between administrative silos, gradient
 * aggregation, and the differential-privacy accountant that spends a budget
 * and refuses to exceed it.
 *
 * The invariant this package protects: raw facility records never cross a silo
 * boundary. Only aggregated, noised updates travel, and a test asserts that no
 * payload contains a record identifier.
 *
 * The algorithm and control plane are real and run locally. The managed
 * multi-organisation substrate is a documented production path, not something
 * this prototype claims to operate.
 *
 * Not implemented yet. The federation work lands with the Samvad module.
 */
export {};
