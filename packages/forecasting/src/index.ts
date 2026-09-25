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
 * The entry point is `forecastDemand`, which corrects censored demand before it
 * fits anything, chooses an engine from the shape of the series, and returns a
 * `Forecast` that carries its method, its features and every reason it may be
 * wrong.
 */

export * from './types';
export * from './series';
export * from './randomness';
export * from './impute';
export * from './methods';
export * from './quantiles';
export * from './select';
export * from './priors';
export * from './engine';
export * from './backtest';
export * from './bqml';
export * from './parity';
export * from './assess';
