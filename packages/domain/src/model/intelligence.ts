import { z } from 'zod';

import {
  dateSchema,
  districtIdSchema,
  facilityIdSchema,
  instantSchema,
  itemIdSchema,
  provenanceSchema,
  recordIdSchema,
  regionIdSchema,
  syntheticSchema,
} from './common';
import { roleSchema } from './identity';
import { syndromeSchema } from './sensing';

/**
 * What the platform concludes, and why.
 *
 * Every record here carries either its inputs or its reasons. A score with no
 * visible drivers is indistinguishable from a guess, and a decision support
 * tool that cannot be argued with will not be trusted by the people who have to
 * act on it.
 */

export const FORECAST_METHODS = [
  'croston',
  'croston-sba',
  'tsb',
  'holt-winters',
  'seasonal-naive',
  'moving-average',
  'pooled-prior',
  'zero',
] as const;

export const forecastMethodSchema = z.enum(FORECAST_METHODS);
export type ForecastMethod = z.infer<typeof forecastMethodSchema>;

/**
 * Which correction was applied to censored days before fitting.
 *
 * Recorded per series so a result can be audited later: an imputed history that
 * is not recorded is indistinguishable from an invented one.
 */
export const IMPUTATIONS = ['facility-mean', 'peer-mean', 'tobit', 'none'] as const;
export const imputationSchema = z.enum(IMPUTATIONS);
export type Imputation = z.infer<typeof imputationSchema>;

export const forecastSchema = z
  .strictObject({
    facilityId: facilityIdSchema,
    itemId: itemIdSchema,
    asOf: dateSchema,
    horizonDays: z.int().positive(),
    /** Median demand per day, from `asOf` + 1. */
    p50: z.array(z.number().nonnegative()),
    /** 90th-percentile demand per day, same horizon. Must be a calibrated quantile. */
    p90: z.array(z.number().nonnegative()),
    method: forecastMethodSchema,
    modelVersion: z.string().trim().min(1),
    /** How many days of history were censored, and therefore imputed. */
    censoredDaysImputed: z.int().nonnegative(),
    imputation: imputationSchema,
    /**
     * The named numbers the fit was made on.
     *
     * Stored with the forecast rather than recomputed, because a forecaster that
     * cannot say what it looked at cannot be argued with — and because the
     * federated training in Phase 7 shares exactly this list across silos.
     */
    features: z.array(z.strictObject({ name: z.string().trim().min(1), value: z.number() })),
    /**
     * Everything a reader is entitled to know about how the number was reached:
     * a censored history that could not be repaired, a series too short to
     * measure its own error, a rate borrowed from comparable facilities.
     */
    warnings: z.array(z.string().trim().min(1)),
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((forecast) => forecast.p50.length === forecast.horizonDays, {
    message: 'the median forecast must cover exactly the requested horizon',
    path: ['p50'],
  })
  .refine((forecast) => forecast.p90.length === forecast.horizonDays, {
    message: 'the upper forecast must cover exactly the requested horizon',
    path: ['p90'],
  })
  .refine((forecast) => forecast.p90.every((value, index) => value >= (forecast.p50[index] ?? 0)), {
    message: 'the upper quantile cannot fall below the median',
    path: ['p90'],
  });

export type Forecast = z.infer<typeof forecastSchema>;

/**
 * The nine things that can drive a stock-out risk.
 *
 * Named rather than combined into one opaque number, because an officer who is
 * asked to move stock between districts is entitled to know which of these
 * produced the recommendation.
 */
export const RISK_DRIVERS = [
  'daysOfStock',
  'consumptionTrend',
  'reportingGap',
  'surgeSignal',
  'leadTime',
  'coldChain',
  'expiry',
  'seasonality',
  'supplyDisruption',
] as const;

export const riskDriverSchema = z.enum(RISK_DRIVERS);
export type RiskDriver = z.infer<typeof riskDriverSchema>;

export const RISK_BANDS = ['low', 'watch', 'high', 'critical'] as const;
export const riskBandSchema = z.enum(RISK_BANDS);
export type RiskBand = z.infer<typeof riskBandSchema>;

export const riskScoreSchema = z.strictObject({
  facilityId: facilityIdSchema,
  itemId: itemIdSchema,
  asOf: dateSchema,
  horizonDays: z.int().positive(),
  /** Probability that demand exceeds stock within the horizon. */
  stockOutProbability: z.number().min(0).max(1),
  band: riskBandSchema,
  /**
   * The evidence behind the score. Each driver is listed with its signed
   * contribution and a human-readable reason, so the total can be challenged.
   */
  drivers: z
    .array(
      z.strictObject({
        driver: riskDriverSchema,
        contribution: z.number(),
        detail: z.string().trim().min(1),
      }),
    )
    .min(1),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type RiskScore = z.infer<typeof riskScoreSchema>;

export const SURGE_METHODS = ['cusum', 'ewma', 'ears'] as const;
export const surgeMethodSchema = z.enum(SURGE_METHODS);
export type SurgeMethod = z.infer<typeof surgeMethodSchema>;

/**
 * A detected change in syndromic reporting.
 *
 * The growth rate is the quantity a decision is made on; a reproduction-number
 * proxy may be reported alongside it for narrative purposes but must not drive
 * anything, because it depends on assumptions this platform cannot verify.
 */
export const epidemicEventSchema = z.strictObject({
  id: recordIdSchema,
  regionId: regionIdSchema,
  /** Null when the signal only resolves to the region. */
  districtId: districtIdSchema.nullable(),
  syndrome: syndromeSchema,
  /** Exponential growth rate of case counts per day. */
  growthRate: z.number(),
  detectedOn: dateSchema,
  windowDays: z.int().positive(),
  /** Expected case count from the facility's own baseline. */
  baselineCaseCount: z.number().nonnegative(),
  observedCaseCount: z.number().nonnegative(),
  method: surgeMethodSchema,
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type EpidemicEvent = z.infer<typeof epidemicEventSchema>;

export const ALERT_STATES = ['open', 'acknowledged', 'snoozed', 'escalated', 'resolved'] as const;
export const alertStateSchema = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof alertStateSchema>;

export const ALERT_SEVERITIES = ['watch', 'high', 'critical'] as const;
export const alertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertSchema = z
  .strictObject({
    id: recordIdSchema,
    facilityId: facilityIdSchema,
    itemId: itemIdSchema,
    raisedOn: dateSchema,
    severity: alertSeveritySchema,
    state: alertStateSchema,
    /**
     * The alert in each supported language, keyed by BCP-47 tag.
     *
     * Bodies are stored rather than generated on read so that what a nurse was
     * shown on a given day can be reproduced exactly afterwards.
     */
    bodies: z.record(z.string().min(2), z.string().trim().min(1)),
    riskScoreId: recordIdSchema.nullable(),
    /**
     * Identity of the condition, not of the alert. The same condition must not
     * raise a second alert while the first is open.
     */
    dedupeKey: z.string().trim().min(1),
    acknowledgedBy: z.string().trim().min(1).nullable(),
    acknowledgedByRole: roleSchema.nullable(),
    acknowledgedAt: instantSchema.nullable(),
    resolvedAt: instantSchema.nullable(),
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((alert) => Object.keys(alert.bodies).length > 0, {
    message: 'an alert must carry at least one language the user can read',
    path: ['bodies'],
  })
  .refine(
    (alert) =>
      alert.state === 'open' ||
      alert.state === 'snoozed' ||
      (alert.acknowledgedBy !== null && alert.acknowledgedAt !== null),
    {
      message: 'an alert cannot be acknowledged or resolved without recording who did it',
      path: ['acknowledgedBy'],
    },
  );

export type Alert = z.infer<typeof alertSchema>;
