import { z } from 'zod';

import {
  batchIdSchema,
  captureSourceSchema,
  dateSchema,
  facilityIdSchema,
  idempotencyKeySchema,
  instantSchema,
  itemIdSchema,
  provenanceSchema,
  recordIdSchema,
  syntheticSchema,
} from './common';

/**
 * What the front line reports.
 *
 * These are observations, never balances. The distinction is the point of the
 * whole design: a recorded balance cannot tell you whether a facility had no
 * demand or no stock, and that ambiguity is the reason facilities under-order
 * during exactly the shortages the platform exists to prevent.
 */

export const LEDGER_ENTRY_KINDS = [
  'receipt',
  'issue',
  'adjust',
  'expiry',
  'transfer_in',
  'transfer_out',
] as const;

export const ledgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);
export type LedgerEntryKind = z.infer<typeof ledgerEntryKindSchema>;

/** The kinds that increase on-hand stock. Every other kind decreases it. */
export const LEDGER_INCREASE_KINDS = ['receipt', 'transfer_in'] as const;

/** Kinds that describe stock arriving into the facility, and so carry a batch. */
export const LEDGER_INCOMING_KINDS = ['receipt', 'transfer_in'] as const;

/**
 * Direction of a stock correction.
 *
 * An adjustment can move stock either way, so its direction cannot be inferred
 * from the entry kind. It is a required field exactly when the kind is
 * `adjust`, and null otherwise, so the direction of every entry is total and a
 * replay never has to guess.
 */
export const adjustmentDirectionSchema = z.enum(['increase', 'decrease']);
export type AdjustmentDirection = z.infer<typeof adjustmentDirectionSchema>;

export const stockLedgerEntrySchema = z
  .strictObject({
    id: recordIdSchema,
    facilityId: facilityIdSchema,
    itemId: itemIdSchema,
    kind: ledgerEntryKindSchema,
    /** Always positive; the kind and direction carry the sign. */
    quantity: z.int().positive(),
    adjustmentDirection: adjustmentDirectionSchema.nullable(),
    /** The business day the movement belongs to. */
    occurredOn: dateSchema,
    /** When the entry was recorded, which is later than `occurredOn` offline. */
    recordedAt: instantSchema,
    /** Batch the stock came from or went to, where the ledger knows it. */
    batchId: batchIdSchema.nullable(),
    expiresOn: dateSchema.nullable(),
    /** Retries from an offline client must not double-count. */
    idempotencyKey: idempotencyKeySchema,
    /** Set when this entry supersedes an earlier one. */
    correctsEntryId: recordIdSchema.nullable(),
    /**
     * The other end of a transfer. Present on `transfer_out` — where the stock
     * is going — and on `transfer_in` — where it came from.
     */
    counterpartFacilityId: facilityIdSchema.nullable(),
    /**
     * Identity of the transfer a movement belongs to.
     *
     * Both halves of a transfer carry the same value, which is what makes stock
     * in transit derivable: dispatched but not yet received is a real quantity,
     * and a platform that cannot see it will double-order.
     */
    transferId: recordIdSchema.nullable(),
    captureSource: captureSourceSchema,
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((entry) => entry.expiresOn === null || entry.expiresOn > entry.occurredOn, {
    message: 'a batch cannot expire on or before the day it moved',
    path: ['expiresOn'],
  })
  .refine(
    (entry) =>
      entry.adjustmentDirection !== null ? entry.kind === 'adjust' : entry.kind !== 'adjust',
    {
      message: 'adjustmentDirection is required for an adjustment and must be null otherwise',
      path: ['adjustmentDirection'],
    },
  )
  .refine(
    (entry) =>
      !(LEDGER_INCOMING_KINDS as readonly string[]).includes(entry.kind) ||
      (entry.batchId !== null && entry.expiresOn !== null),
    {
      message: 'stock arriving at a facility must name its batch and its expiry',
      path: ['batchId'],
    },
  )
  .refine((entry) => entry.kind !== 'expiry' || entry.batchId !== null, {
    message: 'an expiry must name the batch that expired',
    path: ['batchId'],
  })
  .refine(
    (entry) =>
      entry.kind === 'transfer_in' || entry.kind === 'transfer_out'
        ? entry.transferId !== null &&
          entry.counterpartFacilityId !== null &&
          entry.counterpartFacilityId !== entry.facilityId
        : entry.transferId === null && entry.counterpartFacilityId === null,
    {
      message: 'a transfer must name its transfer and its other end, and nothing else may',
      path: ['transferId'],
    },
  );

export type StockLedgerEntry = z.infer<typeof stockLedgerEntrySchema>;

export const bedStatusSchema = z
  .strictObject({
    facilityId: facilityIdSchema,
    observedOn: dateSchema,
    bedsTotal: z.int().nonnegative(),
    bedsOccupied: z.int().nonnegative(),
    recordedAt: instantSchema,
    idempotencyKey: idempotencyKeySchema,
    captureSource: captureSourceSchema,
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((status) => status.bedsOccupied <= status.bedsTotal, {
    message: 'occupied beds cannot exceed the beds the facility reports',
    path: ['bedsOccupied'],
  });

export type BedStatus = z.infer<typeof bedStatusSchema>;

export const CADRES = [
  'medical_officer',
  'staff_nurse',
  'anm',
  'mpw',
  'pharmacist',
  'lab_technician',
  'asha',
  'support',
] as const;

export const cadreSchema = z.enum(CADRES);
export type Cadre = z.infer<typeof cadreSchema>;

/**
 * Attendance by cadre.
 *
 * Counts, not people: the platform records how many posts were filled and how
 * many of those turned up. There is no individual attendance record and no
 * medical detail, which is why this dataset needs no personal-data handling.
 */
export const staffAttendanceSchema = z
  .strictObject({
    facilityId: facilityIdSchema,
    observedOn: dateSchema,
    cadre: cadreSchema,
    postsSanctioned: z.int().nonnegative(),
    postsFilled: z.int().nonnegative(),
    presentToday: z.int().nonnegative(),
    recordedAt: instantSchema,
    idempotencyKey: idempotencyKeySchema,
    captureSource: captureSourceSchema,
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((attendance) => attendance.postsFilled <= attendance.postsSanctioned, {
    message: 'filled posts cannot exceed sanctioned posts',
    path: ['postsFilled'],
  })
  .refine((attendance) => attendance.presentToday <= attendance.postsFilled, {
    message: 'attendance cannot exceed the posts that are filled',
    path: ['presentToday'],
  });

export type StaffAttendance = z.infer<typeof staffAttendanceSchema>;

export const footfallObservationSchema = z.strictObject({
  facilityId: facilityIdSchema,
  observedOn: dateSchema,
  opdCount: z.int().nonnegative(),
  ipdCount: z.int().nonnegative(),
  recordedAt: instantSchema,
  idempotencyKey: idempotencyKeySchema,
  captureSource: captureSourceSchema,
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type FootfallObservation = z.infer<typeof footfallObservationSchema>;

/**
 * Syndromes reported to the platform.
 *
 * Aligned with the categories the national integrated disease surveillance
 * programme reports, so the platform consumes a real surveillance concept
 * rather than an invented one. Counts are aggregate by construction: a
 * syndromic signal is a number per facility per day, and there is nowhere in
 * this model to put a person.
 */
export const SYNDROMES = [
  'fever',
  'cough',
  'diarrhoea',
  'rash',
  'jaundice',
  'conjunctivitis',
  'bleeding',
  'neurological',
] as const;

export const syndromeSchema = z.enum(SYNDROMES);
export type Syndrome = z.infer<typeof syndromeSchema>;

export const syndromicSignalSchema = z.strictObject({
  facilityId: facilityIdSchema,
  observedOn: dateSchema,
  syndrome: syndromeSchema,
  caseCount: z.int().nonnegative(),
  recordedAt: instantSchema,
  idempotencyKey: idempotencyKeySchema,
  captureSource: captureSourceSchema,
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type SyndromicSignal = z.infer<typeof syndromicSignalSchema>;
