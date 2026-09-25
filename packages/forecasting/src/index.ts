/**
 * `@civora/forecasting` — demand forecasting.
 *
 * Scope: statistical engines for intermittent consumption (moving average,
 * Croston, SBA, TSB), the censored-demand correction that precedes them, and
 * the contract for the optional BigQuery ML backend.
 *
 * Every engine here is pure: given the same ledger history it returns the same
 * forecast, with no network access and no clock reads. The Cloud backend sits
 * behind an adapter so local development and CI never need credentials.
 *
 * Not implemented yet. The forecasting work lands with the Poorvadarshan and
 * Chetavani modules.
 */
export {};
