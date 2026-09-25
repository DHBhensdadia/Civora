/**
 * `@civora/optimizer` — redistribution planning.
 *
 * Scope: proposing transfers from surplus facilities to facilities at risk,
 * and a constraint validator that can refuse any proposal. The validator is
 * the authority: a plan that would push a donor below its own safety floor,
 * exceed a cold-chain window, or violate a licence restriction is rejected
 * rather than adjusted.
 *
 * This package decides every outcome. A language model may summarise a
 * proposal but never originates a quantity.
 *
 * Not implemented yet. The redistribution work lands with the Setu module.
 */
export {};
