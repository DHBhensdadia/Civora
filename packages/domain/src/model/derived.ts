import { z } from 'zod';

import {
  dateSchema,
  facilityIdSchema,
  itemIdSchema,
  provenanceSchema,
  syntheticSchema,
} from './common';

/**
 * Values the platform computes, and never records as facts.
 *
 * A snapshot is a reading of the ledger at a point in time. It is stored for
 * speed and never treated as the record of truth, because the ledger is what
 * an auditor can reconstruct and a snapshot is what a cache holds.
 */

/**
 * How the demand rate underpinning days-of-stock was arrived at.
 *
 * `observed` means the recorded issues could be trusted. `censoring-corrected`
 * means at least one day in the window was a stock-out, so the recorded rate
 * describes what the facility could dispense rather than what it needed.
 */
export const DEMAND_BASES = ['observed', 'censoring-corrected'] as const;
export const demandBasisSchema = z.enum(DEMAND_BASES);
export type DemandBasis = z.infer<typeof demandBasisSchema>;

export const stockSnapshotSchema = z.strictObject({
  facilityId: facilityIdSchema,
  itemId: itemIdSchema,
  /** The day the snapshot describes, inclusive. */
  asOf: dateSchema,
  /** Units physically in the store, from the ledger. */
  onHand: z.int().nonnegative(),
  /**
   * Units dispatched towards this facility but not yet received.
   *
   * A platform that cannot see this orders twice, which is one of the ways
   * stock ends up expiring in a warehouse while a facility reports a shortage.
   */
  inTransit: z.int().nonnegative(),
  issuedLast30Days: z.int().nonnegative(),
  /**
   * The daily demand rate that cover was computed from.
   *
   * Not necessarily the rate the ledger recorded. See `demandBasis`.
   */
  demandRate: z.number().nonnegative(),
  /**
   * Where `demandRate` came from, and why it matters.
   *
   * Recorded issues during a stock-out measure *supply*, not need: the shelf
   * was empty, so nothing was dispensed, so the ledger says demand was low.
   * Taking that number at face value makes a facility with an empty store look
   * well covered — the exact error this platform exists to remove. When any
   * day in the window was censored, cover is computed from an estimate of
   * latent demand instead, and this field says so.
   */
  demandBasis: demandBasisSchema,
  /**
   * Days of cover at `demandRate`.
   *
   * `null` means demand is not measurable — an item with no history, or one
   * whose recorded issues all fall inside a stock-out. It is deliberately not
   * zero and not infinity: the interface must render it as *unknown*, because
   * presenting an unknown as a safe quantity is the failure this whole design
   * guards against.
   */
  daysOfStock: z.number().nonnegative().nullable(),
  /** Days in the window on which stock was exhausted while demand continued. */
  censoredDays: z.int().nonnegative(),
  lastMovementOn: dateSchema.nullable(),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type StockSnapshot = z.infer<typeof stockSnapshotSchema>;

export const REPORTING_DOMAINS = ['stock', 'beds', 'attendance', 'footfall', 'syndromic'] as const;
export const reportingDomainSchema = z.enum(REPORTING_DOMAINS);
export type ReportingDomain = z.infer<typeof reportingDomainSchema>;

/**
 * A period during which the platform received nothing from a facility.
 *
 * This record exists so that absence of data can be displayed as absence of
 * data. A facility that has stopped reporting is not a facility with nothing to
 * report, and the difference decides whether an officer sends stock or a
 * supervisor.
 */
export const reportingGapSchema = z
  .strictObject({
    facilityId: facilityIdSchema,
    /** First silent day, inclusive. */
    from: dateSchema,
    /** Last silent day, inclusive. Null while the gap is still open. */
    to: dateSchema.nullable(),
    days: z.int().positive(),
    /** Which observations stopped arriving. */
    missing: z.array(reportingDomainSchema).min(1),
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((gap) => gap.to === null || gap.to >= gap.from, {
    message: 'a reporting gap cannot end before it begins',
    path: ['to'],
  });

export type ReportingGap = z.infer<typeof reportingGapSchema>;
