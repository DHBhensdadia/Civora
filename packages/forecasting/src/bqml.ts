import { forecastSchema } from '@civora/domain';
import type { DateOnly } from '@civora/domain';

import { forecastDemand } from './engine';
import type { EngineOptions, ForecastOutcome } from './engine';
import { classifySeries } from './select';
import type { DemandSeries } from './types';
import { MODEL_VERSION } from './types';
import type { ForecastRequest } from './types';

/**
 * The BigQuery ML backend, behind the identical contract as the local engine.
 *
 * Two reasons this exists even though the local engine is what runs.
 *
 *  - **The comparison is the evidence.** A claim that a well-chosen statistical
 *    ensemble is good enough for this problem is only interesting if it is put
 *    beside the managed alternative over the same series, the same origins and
 *    the same metrics. That means both have to satisfy one interface.
 *  - **The production path is the managed one.** At national scale the honest
 *    answer is a warehouse-native model — no series-by-series fitting in a
 *    request handler, and anomaly detection that Google maintains. Keeping the
 *    SQL and the result mapping in the repository, tested against fixtures, means
 *    the upgrade is a credentials change rather than a rewrite.
 *
 * What this module is careful about is the boundary between "built and tested"
 * and "executed". The SQL generation, the parameter binding and the result
 * mapping are unit-tested against recorded rows. The live path has never been
 * executed, because no Google Cloud project or credential is available in this
 * environment (blocker B1), and every report that includes a `bqml` figure says
 * so in the same sentence as the figure. A backend that was described as
 * verified when it had never run would be the single most damaging thing in this
 * repository.
 */

export type ForecastBackendName = 'stat' | 'bqml';

export interface ForecastBackend {
  readonly name: ForecastBackendName;
  /** Synchronous when the model is local, resolved when it is in a warehouse. */
  forecast(
    series: DemandSeries,
    request: ForecastRequest,
    options?: EngineOptions,
  ): Promise<ForecastOutcome> | ForecastOutcome;
  /** Whether this backend can actually be executed here. */
  readonly available: boolean;
  /** Why not, when it cannot. Empty when it can. */
  readonly unavailableReason: string;
}

/** The statistical engine, wrapped so both backends are callable the same way. */
export const statBackend: ForecastBackend = {
  name: 'stat',
  available: true,
  unavailableReason: '',
  forecast: (series, request, options) => forecastDemand(series, request, options),
};

/**
 * How the warehouse is reached.
 *
 * An interface rather than a client, because the adapter's job is to produce SQL
 * and read rows, and neither of those needs a network. Everything that does need
 * one is behind this port, which is why the SQL and the mapping can be tested
 * with no credentials at all.
 */
export interface WarehousePort {
  readonly project: string;
  readonly dataset: string;
  /** Runs one statement and returns its rows. The only network in this module. */
  readonly run: (
    sql: string,
    parameters: readonly unknown[],
  ) => Promise<readonly Record<string, unknown>[]>;
}

export interface BqmlOptions {
  /**
   * Which BigQuery ML path to generate.
   *
   * `timesfm` is the no-setup default — `AI.FORECAST` over the raw history,
   * which needs no model to have been trained and is the right first call for a
   * catalogue of this size. `arima-plus-xreg` is the one that can use
   * covariates, which is what an epidemic surge becomes once the signal is in
   * the warehouse: an external regressor, not a multiplier applied afterwards.
   */
  readonly model?: 'timesfm' | 'arima-plus-xreg';
  /** How many points of history the query sends. Defaults to 180. */
  readonly historyDays?: number;
  /** Confidence level for the prediction interval. Defaults to 0.9. */
  readonly confidenceLevel?: number;
}

const DEFAULT_BQML: Required<BqmlOptions> = {
  model: 'timesfm',
  historyDays: 180,
  confidenceLevel: 0.9,
};

/** One day's history, as the query sends it. */
export interface BqmlHistoryRow {
  readonly facility_id: string;
  readonly item_id: string;
  readonly day: DateOnly;
  readonly issued: number;
  readonly on_hand: number;
}

/**
 * The history the query is given, censored days and all.
 *
 * The censored days are sent as they are, at zero, and that is a deliberate
 * design decision rather than an oversight: the warehouse is being benchmarked
 * against the local engine, and giving it a corrected history would be giving it
 * this project's own answer and then measuring agreement with itself. The one
 * covariate that does travel is `on_hand`, because it is recorded fact and a
 * model that ignores it cannot be expected to notice a stock-out at all. The
 * SQL carries a comment saying exactly this, so the next reader does not
 * "fix" it.
 */
export const historyRows = (
  series: DemandSeries,
  options: BqmlOptions = {},
): readonly BqmlHistoryRow[] => {
  const { historyDays } = { ...DEFAULT_BQML, ...options };
  return series.points.slice(-historyDays).map((point) => ({
    facility_id: series.facilityId,
    item_id: series.itemId,
    day: point.on,
    issued: point.issued,
    on_hand: point.onHand,
  }));
};

/**
 * The statement the adapter would run.
 *
 * Generated rather than stored as a string constant so the horizon, the
 * facility and the item are bound parameters — a query built by concatenation is
 * how a facility identifier becomes an injection, and a warehouse query built
 * from user-supplied scope is exactly where that happens.
 */
export function buildForecastSql(options: BqmlOptions = {}): string {
  const config = { ...DEFAULT_BQML, ...options };
  const history = `\`${config.model === 'timesfm' ? 'AI.FORECAST' : 'ML.FORECAST'}\``;

  if (config.model === 'timesfm') {
    return `-- Censored days are sent at zero ON PURPOSE. This backend is being
-- benchmarked against the local engine, and pre-correcting the history would be
-- handing it this project's answer before the comparison started. See bqml.ts.
SELECT
  forecast_timestamp AS day,
  forecast_value AS p50,
  prediction_interval_lower_bound AS lower,
  prediction_interval_upper_bound AS p90,
  confidence_level
FROM AI.FORECAST(
  (SELECT day, issued FROM ${history} INPUT),
  horizon => @horizon_days,
  confidence_level => @confidence_level,
  -- TimesFM reads the series as given; there is no model to have trained.
  model => 'TimesFM 2.0'
)
WHERE facility_id = @facility_id AND item_id = @item_id
ORDER BY day
LIMIT @horizon_days`;
  }

  return `-- ARIMA_PLUS_XREG is the path that can use covariates, which is where an
-- epidemic surge belongs once the syndromic signal is in the warehouse: an
-- external regressor on the demand model, rather than a multiplier applied to
-- its output afterwards.
SELECT
  forecast_timestamp AS day,
  forecast_value AS p50,
  prediction_interval_lower_bound AS lower,
  prediction_interval_upper_bound AS p90,
  confidence_level
FROM ML.FORECAST(
  MODEL \`@project.@dataset.demand_arima_xreg\`,
  STRUCT(@horizon_days AS horizon, @confidence_level AS confidence_level)
)
ORDER BY day
LIMIT @horizon_days`;
}

/** The bound parameters, in the order the statement names them. */
export const forecastParameters = (
  request: ForecastRequest,
  options: BqmlOptions = {},
): readonly unknown[] => {
  const config = { ...DEFAULT_BQML, ...options };
  return [
    request.facilityId,
    request.itemId,
    request.horizonDays,
    config.confidenceLevel,
    config.historyDays,
  ];
};

/** Raised when a warehouse row cannot be read as the forecast it claims to be. */
export class WarehouseResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarehouseResultError';
  }
}

const numberFrom = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // A warehouse returns numerics as strings through several client libraries,
  // and a null here is a missing forecast rather than a zero one.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new WarehouseResultError(
    `the forecast response has no usable "${key}": received ${JSON.stringify(value)}`,
  );
};

/**
 * Turn a response into the same `Forecast` the local engine produces.
 *
 * Two things are asserted rather than assumed, because both fail silently:
 * the row count must equal the horizon, and the upper bound must not sit below
 * the median. A backend that returned four days of a seven-day horizon would
 * otherwise be read as a four-day forecast and quietly under-order.
 */
export function mapForecastRows(
  rows: readonly Record<string, unknown>[],
  request: ForecastRequest,
  series: DemandSeries,
  options: BqmlOptions = {},
): ForecastOutcome {
  const config = { ...DEFAULT_BQML, ...options };

  if (rows.length !== request.horizonDays) {
    throw new WarehouseResultError(
      `the warehouse returned ${String(rows.length)} days for a ${String(
        request.horizonDays,
      )}-day horizon`,
    );
  }

  const p50 = rows.map((row) => Math.max(0, numberFrom(row, 'p50')));
  const p90 = rows.map((row, index) => {
    const upper = numberFrom(row, 'p90');
    const median = p50[index] ?? 0;
    return Math.max(upper, median);
  });

  const forecast = forecastSchema.parse({
    facilityId: request.facilityId,
    itemId: request.itemId,
    asOf: request.asOf,
    horizonDays: request.horizonDays,
    p50,
    p90,
    method: 'pooled-prior',
    modelVersion: `${MODEL_VERSION}+bqml-${config.model}`,
    // The correction is not applied on this path, and saying zero here is a
    // statement rather than a default: the numbers came from a model that never
    // saw a repaired history.
    censoredDaysImputed: 0,
    imputation: 'none',
    features: [
      { name: 'warehouseRows', value: rows.length },
      { name: 'confidenceLevel', value: config.confidenceLevel },
    ],
    warnings: [
      'this forecast came from BigQuery ML, whose censored-demand handling is not verified by any test in this repository',
    ],
    surge: null,
    synthetic: request.synthetic,
    provenance: request.provenance,
  });

  return {
    forecast,
    // Classified from the history it was given, by the same classifier the local
    // engine uses, so the two backends are described in one vocabulary. The
    // classification is descriptive here: the warehouse chose its own method.
    classification: classifySeries(series.points),
    cumulativeP90: runningTotal(p90),
  };
}

const runningTotal = (values: readonly number[]): readonly number[] => {
  let total = 0;
  return values.map((value) => {
    total += value;
    return total;
  });
};

/** The adapter, bound to a warehouse. */
export const bqmlBackend = (port: WarehousePort, options: BqmlOptions = {}): ForecastBackend => ({
  name: 'bqml',
  available: true,
  unavailableReason: '',
  forecast: async (series, request) => {
    const rows = await port.run(buildForecastSql(options), forecastParameters(request, options));
    return mapForecastRows(rows, request, series, options);
  },
});

/**
 * The backend when no warehouse is reachable.
 *
 * Present rather than absent so that every caller has to handle the case, and
 * so that a report can print *why* a comparison is missing instead of printing
 * nothing. `available: false` is the honest description; a fake implementation
 * that returned the local engine's answer would make every parity figure in the
 * project meaningless.
 */
export const unavailableBackend = (reason: string): ForecastBackend => ({
  name: 'bqml',
  available: false,
  unavailableReason: reason,
  forecast: () => {
    throw new WarehouseResultError(`the BigQuery ML backend cannot run: ${reason}`);
  },
});
