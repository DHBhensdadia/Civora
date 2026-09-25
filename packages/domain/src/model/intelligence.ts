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

/**
 * A surge adjustment carried on the forecast that used it.
 *
 * The demand lift is recorded on the forecast rather than only in the surge
 * detector's own record, because a reader looking at a number that has been
 * multiplied is entitled to see the multiplier and the event behind it without
 * joining two collections.
 */
export const surgeAdjustmentSchema = z
  .strictObject({
    eventId: recordIdSchema,
    syndrome: syndromeSchema,
    /** Exponential growth rate of case counts per day. */
    growthRate: z.number(),
    /** Demand multiplier applied to the affected item. */
    multiplier: z.number().positive(),
    /** Days of the horizon the multiplier was applied over. */
    daysApplied: z.int().nonnegative(),
  })
  .refine((surge) => surge.multiplier >= 1, {
    message: 'a surge may only raise demand, never lower it',
    path: ['multiplier'],
  });

export type SurgeAdjustment = z.infer<typeof surgeAdjustmentSchema>;

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
    /**
     * The epidemic surge this forecast was adjusted for, or null.
     *
     * Null means no surge was detected, which is a statement the forecast makes
     * rather than an absence: a reader can tell "checked, nothing found" from
     * "not checked", because the surge pipeline records what it searched.
     */
    surge: surgeAdjustmentSchema.nullable(),
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
 * produced the recommendation. The list is closed: scoring may only ever
 * produce these nine, so a driver cannot be added to a score without being
 * named, documented and given a place in the interface.
 */
export const RISK_DRIVERS = [
  /** Forecast probability that demand outruns stock inside the horizon. */
  'shortfallProbability',
  /** Cover on hand plus in transit, measured in days of forecast demand. */
  'daysOfStock',
  /** Length and variability of the replenishment lead time. */
  'leadTime',
  /** How essential the item is, and whether it cannot be substituted. */
  'criticality',
  /** The population the facility serves, and how its footfall is moving. */
  'populationAtRisk',
  /** A detected epidemic surge in a syndrome this item treats. */
  'surgeSignal',
  /** Stock approaching expiry, which is both a loss and a reason not to order. */
  'expiryPressure',
  /** How long since the platform last heard from this facility at all. */
  'reportingGap',
  /** Cold-chain dependence, and any recorded breach. */
  'coldChain',
] as const;

export const riskDriverSchema = z.enum(RISK_DRIVERS);
export type RiskDriver = z.infer<typeof riskDriverSchema>;

/**
 * How urgently a score asks to be acted on.
 *
 * `unknown` is not a low score. It is what the platform says when it cannot
 * measure cover at all — a facility that has stopped reporting, or an item with
 * no history to derive a rate from. Rendering that as green is the single most
 * dangerous thing a risk surface can do, so it is its own band and it sorts at
 * the top of an investigation list beside `critical`.
 */
export const RISK_BANDS = ['unknown', 'low', 'watch', 'high', 'critical'] as const;
export const riskBandSchema = z.enum(RISK_BANDS);
export type RiskBand = z.infer<typeof riskBandSchema>;

export const riskScoreSchema = z.strictObject({
  facilityId: facilityIdSchema,
  itemId: itemIdSchema,
  asOf: dateSchema,
  horizonDays: z.int().positive(),
  /**
   * What the forecast says: the chance demand outruns stock inside the horizon.
   *
   * The *measured* number, straight off the forecast's own quantiles, and null
   * when there was no forecast to read it from. Kept apart from `riskIndex`
   * deliberately: a card that showed a composite where a probability belongs
   * would state one number and explain it with another.
   */
  shortfallProbability: z.number().min(0).max(1).nullable(),
  /**
   * The composite of the nine drivers, in [0, 1]. Higher is worse.
   *
   * It **ranks** and it **bands**; it is not a probability and is never presented
   * as one, because it is a sum of weighted log-odds across reasons that are not
   * independent. Its only job is to put a list in an order and its drivers to say
   * why that order is what it is.
   */
  riskIndex: z.number().min(0).max(1),
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
  /**
   * The measured inputs the drivers were computed from.
   *
   * Stored with the score so that a disputed number can be re-derived from what
   * the platform actually saw, rather than from what it holds now. A score whose
   * inputs were not kept cannot be told apart from a guess after the fact.
   */
  facts: z.array(z.strictObject({ name: z.string().trim().min(1), value: z.number() })),
  /**
   * Every input the score wanted and could not get.
   *
   * Non-empty does not invalidate the score; it tells a reader which parts of
   * it rest on less than a full picture, and it is what makes the `unknown` band
   * explainable rather than mysterious.
   */
  missing: z.array(z.string().trim().min(1)),
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

/**
 * Where an alert is in its life.
 *
 * `raised` is the unattended state; nothing else is a state a human chose. The
 * set is ordered the way an alert moves through it, and the legal transitions
 * live in `logic/alert` rather than being inferred from this list.
 */
export const ALERT_STATES = [
  'raised',
  'acknowledged',
  'action_proposed',
  'snoozed',
  'escalated',
  'resolved',
] as const;
export const alertStateSchema = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof alertStateSchema>;

/**
 * One move an alert made, and who made it.
 *
 * Kept as an append-only list on the alert itself rather than as a mutable
 * `state` field alone. A field records where an alert is; a history records
 * that somebody decided to put it there, which is the thing an audit asks about
 * and the thing a "resolved" alert cannot be told apart from without.
 */
export const alertTransitionSchema = z.strictObject({
  from: alertStateSchema,
  to: alertStateSchema,
  /** Who acted. A fixture identity today, an authenticated one later. */
  actor: z.string().trim().min(1),
  actorRole: roleSchema,
  at: instantSchema,
  reason: z.string().trim().min(1),
});

export type AlertTransition = z.infer<typeof alertTransitionSchema>;

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
    /**
     * The structured facts the alert was raised on.
     *
     * Phase 5 writes prose from this list and nothing else, so a narrative
     * cannot contain a number the alert does not carry. It is the same shape as
     * a forecast's features for that reason: one idea, one implementation.
     */
    facts: z.array(z.strictObject({ name: z.string().trim().min(1), value: z.number() })),
    /** The driver contributions behind the alert, largest first. */
    drivers: z
      .array(
        z.strictObject({
          driver: riskDriverSchema,
          contribution: z.number(),
          detail: z.string().trim().min(1),
        }),
      )
      .min(1),
    /** Every move the alert made, oldest first. Empty while nobody has acted. */
    history: z.array(alertTransitionSchema),
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
      alert.state === 'raised' ||
      alert.state === 'snoozed' ||
      (alert.acknowledgedBy !== null && alert.acknowledgedAt !== null),
    {
      message: 'an alert cannot be acknowledged or resolved without recording who did it',
      path: ['acknowledgedBy'],
    },
  )
  .refine((alert) => alert.facts.length > 0, {
    message: 'an alert must carry the evidence it was raised on',
    path: ['facts'],
  });

export type Alert = z.infer<typeof alertSchema>;
