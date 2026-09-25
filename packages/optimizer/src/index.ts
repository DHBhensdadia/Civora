/**
 * `@civora/optimizer` — redistribution planning.
 *
 * Scope: proposing transfers from surplus facilities to facilities at risk,
 * and a constraint validator that can refuse any proposal.
 *
 * The package is built around a separation of powers, and the file layout
 * carries it:
 *
 *  - `feasibility` decides which transfers are physically possible at all —
 *    cold chain, lead time, shelf life, level of care. It is the input to
 *    everything else and it decides nothing about preference.
 *  - the planner (priority construction, then bounded local improvement) decides
 *    quantities. It is deterministic by contract: identical inputs produce an
 *    identical plan, or the audit trail behind a proposal is worthless.
 *  - the validator is a **separate module** that re-checks the planner's output
 *    against the hard constraints. It is not a call into the planner, and it
 *    does not share the planner's helpers, so a solver bug cannot make an
 *    invalid plan look valid by agreeing with itself.
 *
 * A language model may select a strategy and write a rationale. It never
 * originates a quantity: every number in a proposal comes from here.
 */

export * from './feasibility';
