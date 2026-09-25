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
 *  - `impact` prices a plan against the forecasts the platform already stores,
 *    and is written so it can report a transfer that buys nothing as readily as
 *    one that pays for itself.
 *  - `strategy` is the only place a language model has a lever. It selects one
 *    of four stated weightings and writes a rationale; the plan and every
 *    quantity are still the optimiser's, judged by the validator, with a
 *    deterministic fallback that is what runs when no provider is configured.
 *  - `proposal` runs the whole pipeline over a world the caller supplies and
 *    emits `TransferProposal` records — or, when the validator refuses the plan,
 *    no records at all and the refusals instead.
 *
 * A language model may select a strategy and write a rationale. It never
 * originates a quantity: every number in a proposal comes from here.
 */

export * from './feasibility';
export * from './impact';
export * from './planner';
export * from './priorities';
export * from './proposal';
export * from './strategy';
export * from './validator';
