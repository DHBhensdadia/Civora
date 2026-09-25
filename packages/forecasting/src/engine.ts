import { forecastSchema } from '@civora/domain';
import type { Forecast } from '@civora/domain';

import { imputeCensoredDemand } from './impute';
import type { ImputationMethod } from './impute';
import { fitMethod, residualsOf } from './methods';
import { bootstrapQuantiles } from './quantiles';
import { chooseMethod, classifySeries, isColdStart } from './select';
import type { Classification } from './select';
import { seriesFeatures } from './series';
import { MODEL_VERSION } from './types';
import type { DemandSeries, ForecastFeature, ForecastRequest } from './types';

/**
 * Making a forecast, in one place.
 *
 * The order is the argument:
 *
 *  1. **Correct censoring first.** Fitting before correcting is how a model learns
 *     that a stock-out is a quiet period, and no amount of care downstream
 *     recovers from it.
 *  2. **Classify, then choose.** Intermittent items and continuously consumed
 *     ones need different engines, and the choice is recorded rather than
 *     implicit.
 *  3. **Fit once**, producing both the forecast and the one-day-ahead predictions
 *     the uncertainty is measured from.
 *  4. **Quantify honestly.** A p90 with no residual evidence behind it is a
 *     number someone made up, so the interval is returned equal to the median and
 *     a warning says why.
 *
 * Everything the result depends on travels with it: the method, the model
 * version, the imputation and its day count, the features, and every warning.
 */

export interface EngineOptions {
  /** Overrides the classifier. Used by the backtest to compare engines fairly. */
  readonly requestedMethod?: Forecast['method'];
  readonly imputation?: ImputationMethod;
  /** Mean daily demand for comparable facilities, for a cold start. */
  readonly priorDailyDemand?: number | null;
  readonly priorSeriesUsed?: number;
  /** Below this many days of history, a pooled prior is used instead of a fit. */
  readonly minimumHistoryDays?: number;
  readonly seasonLength?: number;
  readonly bootstrapReplications?: number;
  /** The quantile reported in `p90`. */
  readonly bootstrapLevel?: number;
}

const DEFAULT_MINIMUM_HISTORY_DAYS = 14;
const DEFAULT_SEASON_LENGTH = 7;
const DEFAULT_REPLICATIONS = 400;
const DEFAULT_LEVEL = 0.9;

export interface ForecastOutcome {
  readonly forecast: Forecast;
  readonly classification: Classification;
  /**
   * The upper bound on demand accumulated through each day of the horizon.
   *
   * Not part of the stored forecast, because it is a function of the horizon
   * rather than a property of the series — but it is the quantity risk scoring
   * and redistribution both need, and it must come from the same resampled paths
   * the daily bound did. Computing it anywhere else would let the two disagree.
   */
  readonly cumulativeP90: readonly number[];
}

export function forecastDemand(
  series: DemandSeries,
  request: ForecastRequest,
  options: EngineOptions = {},
): ForecastOutcome {
  const seasonLength = options.seasonLength ?? DEFAULT_SEASON_LENGTH;
  const warnings: string[] = [];

  const imputed = imputeCensoredDemand(series, {
    ...(options.imputation === undefined ? {} : { method: options.imputation }),
    peerDailyDemand: options.priorDailyDemand ?? null,
  });
  warnings.push(...imputed.warnings);

  const values = imputed.points.map((point) => point.issued);
  const classification = classifySeries(imputed.points);
  const coldStart = isColdStart(
    classification,
    values.length,
    options.minimumHistoryDays ?? DEFAULT_MINIMUM_HISTORY_DAYS,
  );

  const priorDailyDemand = options.priorDailyDemand ?? 0;
  const usePrior = options.requestedMethod === undefined && coldStart && priorDailyDemand > 0;

  const method: Forecast['method'] = usePrior
    ? 'pooled-prior'
    : chooseMethod(classification, values.length, {
        ...(options.requestedMethod === undefined ? {} : { requested: options.requestedMethod }),
        seasonLength,
      });

  let rate: readonly number[];
  let residuals: readonly number[];
  let parameters: readonly ForecastFeature[];

  if (method === 'pooled-prior') {
    rate = Array.from({ length: request.horizonDays }, () => priorDailyDemand);
    residuals = [];
    parameters = [
      { name: 'pooledDailyDemand', value: priorDailyDemand },
      { name: 'pooledSeries', value: options.priorSeriesUsed ?? 0 },
      { name: 'historyDays', value: values.length },
    ];
    warnings.push(
      `this series has ${String(values.length)} days of usable history, so the forecast is a prior pooled from comparable facilities rather than a fit to its own past`,
    );
  } else {
    const fitted = fitMethod(method, values, {
      horizon: request.horizonDays,
      seasonLength,
    });
    rate = fitted.rate;
    residuals = residualsOf(values, fitted);
    parameters = fitted.parameters;

    if (residuals.length < 4) {
      warnings.push(
        'the history is too short to measure how wrong the fit has been, so the upper bound is not wider than the median',
      );
    }
    if (classification.pattern === 'empty') {
      warnings.push(
        'nothing has been dispensed from this facility in the window, which is a statement about the facility rather than about need',
      );
    }
    if (classification.pattern === 'fading') {
      warnings.push('this item is being dispensed less often than it was, so the rate is decaying');
    }
  }

  const bounds = bootstrapQuantiles(rate, residuals, {
    replications: options.bootstrapReplications ?? DEFAULT_REPLICATIONS,
    level: options.bootstrapLevel ?? DEFAULT_LEVEL,
    seed: `${request.seed}:${request.facilityId}:${request.itemId}`,
  });

  const features: ForecastFeature[] = [
    ...seriesFeatures(imputed.points),
    { name: 'censoredDaysFound', value: imputed.censoredDaysFound },
    { name: 'imputedDailyDemand', value: imputed.latentDailyDemand },
    { name: 'residuals', value: residuals.length },
    ...parameters,
  ];

  const forecast = forecastSchema.parse({
    facilityId: request.facilityId,
    itemId: request.itemId,
    asOf: request.asOf,
    horizonDays: request.horizonDays,
    p50: rate.map((value) => Math.max(0, value)),
    p90: bounds.daily,
    method,
    modelVersion: MODEL_VERSION,
    censoredDaysImputed: imputed.censoredDaysImputed,
    imputation: imputed.imputation,
    features,
    warnings,
    synthetic: request.synthetic,
    provenance: request.provenance,
  });

  return { forecast, classification, cumulativeP90: bounds.cumulative };
}
