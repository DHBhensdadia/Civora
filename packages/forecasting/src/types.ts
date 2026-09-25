import type { DateOnly, FacilityId, ItemId, Provenance } from '@civora/domain';

/**
 * What the forecasting engine is given, and what it must state about its answer.
 *
 * Two properties are contractual rather than stylistic.
 *
 *  - **Determinism.** The same series and the same request produce the same
 *    forecast, on any machine, with no clock reads and no network. A number the
 *    platform acts on has to be reproducible, and a random seed that is not
 *    passed in cannot be reproduced.
 *  - **Disclosure.** A forecast carries the method that produced it, the version
 *    of the engine, how many censored days were imputed and how, the features the
 *    fit was made on, and every reason it may be wrong. A forecast that hides its
 *    provenance is indistinguishable from an assumption.
 */

/**
 * The version of the statistical engine.
 *
 * Bumped when a change alters the numbers a given series produces, so a stored
 * forecast can be told apart from one the current code would emit.
 */
export const MODEL_VERSION = 'poorvadarshan-stat-1';

/** One day of a facility's history for one item. */
export interface DemandPoint {
  readonly on: DateOnly;
  /**
   * Units dispensed that day.
   *
   * Zero during a stock-out means *could not dispense*, not *did not need to*,
   * which is why `onHand` travels with it.
   */
  readonly issued: number;
  /** Units on hand at the end of the day. This is what makes censoring visible. */
  readonly onHand: number;
}

/** A facility-item history, one point per day, ascending and gapless. */
export interface DemandSeries {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly points: readonly DemandPoint[];
}

export interface ForecastRequest {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /** The last day the forecast may look at. Nothing after it is used. */
  readonly asOf: DateOnly;
  readonly horizonDays: number;
  /**
   * Seed for the residual resampling.
   *
   * Required rather than defaulted: a forecast is only reproducible if the seed
   * that produced it was recorded somewhere, and this is the only place it can
   * travel with the answer.
   */
  readonly seed: string;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

/** A named number the fit was made on. Phase 7 federates this list. */
export interface ForecastFeature {
  readonly name: string;
  readonly value: number;
}

/** A fit result, before it is turned into a `Forecast`. */
export interface FittedSeries {
  /** The rate forecast for each day of the horizon. */
  readonly rate: readonly number[];
  /**
   * The one-day-ahead prediction made at each day, from the history before it.
   *
   * The residual series is the difference between this and what actually
   * happened, which is what the quantiles are bootstrapped from. It is produced
   * by the same pass as the forecast so the two cannot disagree.
   */
  readonly oneStepAhead: readonly number[];
  /** Named parameters, so a fit can be re-derived from its own record. */
  readonly parameters: readonly ForecastFeature[];
  /** Days ignored at the start: a filter has no opinion before it has seen data. */
  readonly warmup: number;
}
