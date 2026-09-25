import {
  alertFor,
  applyDeduplication,
  dedupeKeyOf,
  demandLiftFor,
  replenishmentWindowDays,
  scoreRisk,
} from '@civora/domain';
import type {
  Alert,
  DateOnly,
  FacilityId,
  Forecast,
  Item,
  ItemId,
  Provenance,
  RiskScore,
  SurgeAdjustment,
} from '@civora/domain';
import type { DemandLift, SurgeDetection } from '@civora/domain';

import { forecastDemand } from './engine';
import type { EngineOptions } from './engine';
import type { DemandSeries } from './types';

/**
 * One facility, one item, everything the platform concludes about it.
 *
 * This is the join the phase describes — forecast, then surge lift, then the
 * nine drivers, then the alert — and it lives here rather than in the batch job
 * so that the batch job and the interface cannot compute it differently. A
 * dashboard whose numbers come from a second implementation of the same pipeline
 * is a dashboard that will eventually disagree with the report.
 *
 * The order is the argument, and each step's output is kept rather than folded
 * into the next:
 *
 *  1. **Forecast**, on the recorded history, with censored days corrected.
 *  2. **Lift for a surge**, if one was detected in a syndrome this item treats.
 *     The multiplier and the event go onto the forecast, so the number a reader
 *     sees says what was done to it.
 *  3. **Score**, from the lifted forecast and everything else measured about the
 *     facility, into nine named drivers.
 *  4. **Alert**, if the score justifies one.
 *
 * Nothing is recomputed downstream. The risk score is handed the forecast's own
 * quantiles and the same stock figure the interface shows, so the probability on
 * a card and the probability in the drivers are the same number.
 */

/** The standard normal quantile at 0.9, used to fit a shape between the quantiles. */
const Z90 = 1.2815515655446004;

/**
 * Probability that demand over the horizon exceeds the stock available for it.
 *
 * Derived from the two quantiles the forecast actually carries, by fitting a
 * lognormal to them and reading the tail. The quantiles are measured — they come
 * from bootstrapped residuals — and the *shape between them* is an assumption,
 * stated here rather than buried: nothing in this project can observe the
 * distribution of future demand, so something has to be assumed, and a
 * two-parameter fit through two measured quantiles is the smallest assumption
 * that answers the question.
 *
 * It is monotone in stock and bounded at both ends, which are the two properties
 * a risk score has to have. Where the median is zero the distribution has
 * collapsed and the probability is 1 if there is no stock and a floor otherwise,
 * rather than the arithmetic error a logarithm would produce.
 */
export function probabilityOfShortfall(
  stock: number,
  cumulativeP50: number,
  cumulativeP90: number,
): number {
  if (stock <= 0) {
    return cumulativeP50 <= 0 && cumulativeP90 <= 0 ? 0.5 : 1;
  }
  if (cumulativeP90 <= 0) {
    // Nothing is expected at all, so only the floor of unmodelled variation
    // remains — the platform should not claim certainty about a quiet item.
    return 0.02;
  }
  if (cumulativeP50 <= 0) {
    return 0.1;
  }

  const median = Math.max(cumulativeP50, 1e-6);
  const upper = Math.max(cumulativeP90, median);
  const sigma = upper === median ? 0 : Math.log(upper / median) / Z90;
  const mu = Math.log(median);

  if (sigma <= 1e-9) {
    return stock >= median ? 0.05 : 0.95;
  }

  const z = (Math.log(stock) - mu) / sigma;
  // The standard normal cumulative distribution, via the error function.
  const probability = 1 - 0.5 * (1 + erf(z / Math.SQRT2));
  return Math.min(1, Math.max(0, probability));
}

/** Abramowitz and Stegun 7.1.26, accurate to better than 1.5e-7. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const value = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * value);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-value * value));
}

export interface AssessmentInput {
  readonly facilityId: FacilityId;
  readonly item: Item;
  /** The facility's own history for this item. */
  readonly series: DemandSeries;
  readonly asOf: DateOnly;
  readonly horizonDays: number;
  readonly onHand: number;
  readonly inTransit: number;
  readonly leadTimeDays: number;
  readonly leadTimeSpreadDays: number;
  /** An order is already on its way for this item. */
  readonly orderInFlight: boolean;
  readonly catchmentPopulation: number;
  /** Recent footfall over the prior period. Above one means rising attendances. */
  readonly footfallTrend: number | null;
  /** The strongest surge detected in a syndrome this item treats, if any. */
  readonly surge: SurgeDetection | null;
  readonly daysToNearestExpiry: number | null;
  readonly nearExpiryUnits: number;
  readonly daysSinceReading: number | null;
  readonly reportingGapDays: number;
  readonly coldChainBreachDays: number | null;
  readonly seed: string;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
  readonly engineOptions?: EngineOptions;
}

export interface Assessment {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly asOf: DateOnly;
  /** The forecast as stored, including any surge adjustment. */
  readonly forecast: Forecast;
  /** What the surge did to it, and why or why not. */
  readonly lift: DemandLift;
  readonly risk: RiskScore;
  /** The alert this score justifies, or null. */
  readonly alert: Alert | null;
  /** Stock plus stock on its way, which is what the probability was read against. */
  readonly available: number;
}

/** The cumulative median over a horizon, from the daily median series. */
const cumulative = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Apply a surge multiplier to a forecast.
 *
 * Both quantiles are multiplied by the same factor, which keeps the ordering the
 * schema requires and, more importantly, keeps the *shape* of the uncertainty —
 * a surge that doubled the median and left the upper bound alone would claim the
 * future became more certain at the moment it became less predictable.
 *
 * The adjustment applies from the day the run was detected, so a surge already
 * under way covers the whole horizon and one detected later covers the rest.
 */
export function applySurge(
  forecast: Forecast,
  multiplier: number,
  adjustment: SurgeAdjustment,
  reason: string,
): Forecast {
  if (multiplier <= 1) {
    return forecast;
  }

  const scale = (value: number): number => value * multiplier;

  return {
    ...forecast,
    p50: forecast.p50.map(scale),
    p90: forecast.p90.map(scale),
    surge: adjustment,
    warnings: [...forecast.warnings, reason],
  };
}

/** The surge a lift would attach to a forecast, for the record. */
export const surgeAdjustmentOf = (
  detection: SurgeDetection,
  multiplier: number,
  daysApplied: number,
): SurgeAdjustment => ({
  eventId: `epi:${detection.syndrome}:${detection.detectedOn}`,
  syndrome: detection.syndrome,
  growthRate: detection.growthRate,
  multiplier,
  daysApplied,
});

export function assess(input: AssessmentInput): Assessment {
  const { facilityId, item, series } = input;

  const outcome = forecastDemand(
    series,
    {
      facilityId,
      itemId: item.id,
      asOf: input.asOf,
      horizonDays: input.horizonDays,
      seed: input.seed,
      synthetic: input.synthetic,
      provenance: input.provenance,
    },
    input.engineOptions,
  );

  // The routine demand the lift is measured against: the median forecast, not
  // the recorded history, because during a stock-out the recorded history is the
  // number the correction exists to replace.
  const routineDaily = cumulative(outcome.forecast.p50) / Math.max(1, input.horizonDays);

  const lift =
    input.surge === null
      ? {
          multiplier: 1,
          addedUnitsPerDay: 0,
          daysApplied: 0,
          surgeSensitive: item.syndromes.length > 0,
          capped: false,
          reason: 'no surge was detected in any syndrome this item treats',
        }
      : demandLiftFor({
          item,
          syndrome: input.surge.syndrome,
          detection: input.surge,
          routineDailyDemand: routineDaily,
          horizonFrom: input.asOf,
          horizonDays: input.horizonDays,
        });

  const forecast =
    input.surge !== null && lift.multiplier > 1
      ? applySurge(
          outcome.forecast,
          lift.multiplier,
          surgeAdjustmentOf(input.surge, lift.multiplier, lift.daysApplied),
          lift.reason,
        )
      : outcome.forecast;

  const available = input.onHand + input.inTransit;
  const throughHorizonP50 = cumulative(forecast.p50);

  // The question the probability answers is whether demand outruns stock *before
  // a delivery can arrive*, not whether it outruns stock over the whole horizon —
  // a facility that can restock in five days does not have to survive a
  // fortnight on the shelf, and scoring it as if it did flags every well-run
  // facility in the country. The window comes from the facility's own observed
  // lead time and travels onto the score, so a reader can see what was measured.
  const shortfallWindowDays = replenishmentWindowDays(input.leadTimeDays, input.horizonDays);
  const shortfallProbability = probabilityOfShortfall(
    available,
    cumulative(forecast.p50.slice(0, shortfallWindowDays)),
    cumulative(forecast.p90.slice(0, shortfallWindowDays)),
  );

  const demandRate = throughHorizonP50 / Math.max(1, input.horizonDays);
  const daysOfStock = demandRate <= 0 ? null : available / demandRate;

  const risk = scoreRisk({
    facilityId,
    itemId: item.id,
    asOf: input.asOf,
    horizonDays: input.horizonDays,
    shortfallProbability,
    shortfallWindowDays,
    daysOfStock,
    onHand: input.onHand,
    inTransit: input.inTransit,
    leadTimeDays: input.leadTimeDays,
    leadTimeSpreadDays: input.leadTimeSpreadDays,
    orderInFlight: input.orderInFlight,
    essentiality: item.essentiality,
    catchmentPopulation: input.catchmentPopulation,
    footfallTrend: input.footfallTrend,
    surge:
      forecast.surge === null
        ? null
        : {
            syndrome: forecast.surge.syndrome,
            growthRate: forecast.surge.growthRate,
            multiplier: forecast.surge.multiplier,
            daysApplied: forecast.surge.daysApplied,
          },
    daysToNearestExpiry: input.daysToNearestExpiry,
    nearExpiryUnits: input.nearExpiryUnits,
    daysSinceReading: input.daysSinceReading,
    reportingGapDays: input.reportingGapDays,
    coldChain: item.coldChain,
    coldChainBreachDays: input.coldChainBreachDays,
    synthetic: input.synthetic,
    provenance: input.provenance,
  });

  return {
    facilityId,
    itemId: item.id,
    asOf: input.asOf,
    forecast,
    lift,
    risk,
    alert: null,
    available,
  };
}

/** A facility's own name and an item's own name, for the alert subject line. */
export interface Naming {
  readonly facilityNameOf: (facilityId: FacilityId) => string;
  readonly itemNameOf: (itemId: ItemId) => string;
}

/**
 * Assess a population, then raise the alerts and deduplicate them.
 *
 * Deduplication runs last and across the whole population, not per facility,
 * because the condition it keys on is global: two districts each with a silent
 * facility raising on the same driver set are two different conditions, and two
 * items at one facility on the same driver set are also two. What it collapses
 * is the same facility and item alerting repeatedly for the same reasons, which
 * is what a daily batch job would otherwise do every morning.
 */
export function assessPopulation(
  inputs: readonly AssessmentInput[],
  naming: Naming,
  existing: readonly Alert[] = [],
): { readonly assessments: readonly Assessment[]; readonly raised: readonly Alert[] } {
  const assessments: Assessment[] = [];
  const candidates: Alert[] = [];

  for (const input of inputs) {
    const assessment = assess(input);
    const alert = alertFor({
      score: assessment.risk,
      facilityName: naming.facilityNameOf(assessment.facilityId),
      itemName: naming.itemNameOf(assessment.itemId),
      raisedOn: assessment.asOf,
      raisedAt: `${assessment.asOf}T06:00:00.000Z`,
      actor: 'system:score',
      synthetic: input.synthetic,
      provenance: input.provenance,
    });

    assessments.push({ ...assessment, alert });
    if (alert !== null) {
      candidates.push(alert);
    }
  }

  return { assessments, raised: applyDeduplication(candidates, existing) };
}

/** The dedupe key a score would raise on, without building the alert. */
export const dedupeKeyFor = (score: RiskScore): string =>
  dedupeKeyOf(score.facilityId, score.itemId, score.drivers);
