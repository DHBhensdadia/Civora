import { describe, expect, it } from 'vitest';

import { aFacility, anItem } from '../testing/factories';
import {
  SIMULATED_CAPTURE_SOURCE,
  SIMULATED_PROVENANCE,
  dateSchema,
  instantSchema,
} from './common';
import { facilitySchema } from './administrative';
import { itemSchema } from './catalogue';
import { federationRoundSchema, transferProposalSchema } from './coordination';
import { reportingGapSchema, stockSnapshotSchema } from './derived';
import { alertSchema, forecastSchema } from './intelligence';
import { bedStatusSchema, staffAttendanceSchema, stockLedgerEntrySchema } from './sensing';

/**
 * The schemas are the contract, so they are tested like one.
 *
 * Each case below corresponds to a way the platform could be told something
 * that is arithmetically impossible, physically impossible, or ambiguous. The
 * point of rejecting them here is that no downstream calculation then has to
 * wonder what an impossible value meant.
 */

const accepts = (result: { success: boolean }): boolean => result.success;

const rawEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'entry-1',
  facilityId: 'facility-a',
  itemId: 'item-paracetamol',
  kind: 'issue',
  quantity: 1,
  adjustmentDirection: null,
  occurredOn: '2026-01-01',
  recordedAt: '2026-01-01T09:00:00.000Z',
  batchId: null,
  expiresOn: null,
  idempotencyKey: 'key-1',
  correctsEntryId: null,
  counterpartFacilityId: null,
  transferId: null,
  captureSource: SIMULATED_CAPTURE_SOURCE,
  synthetic: true,
  provenance: SIMULATED_PROVENANCE,
  ...overrides,
});

const entryAccepts = (overrides: Record<string, unknown> = {}): boolean =>
  accepts(stockLedgerEntrySchema.safeParse(rawEntry(overrides)));

const incoming = {
  kind: 'receipt',
  batchId: 'batch-1',
  expiresOn: '2027-01-01',
};

describe('time values', () => {
  it('accepts a UTC instant', () => {
    expect(accepts(instantSchema.safeParse('2026-01-01T09:00:00.000Z'))).toBe(true);
  });

  it('rejects an instant carrying a timezone offset', () => {
    // A country can use local time. A platform designed to span several cannot:
    // an offset makes the same recorded moment mean two different things.
    expect(accepts(instantSchema.safeParse('2026-01-01T09:00:00+05:30'))).toBe(false);
    expect(accepts(instantSchema.safeParse('2026-01-01T09:00:00.000+00:00'))).toBe(false);
  });

  it('rejects a datetime with no zone at all', () => {
    expect(accepts(instantSchema.safeParse('2026-01-01T09:00:00'))).toBe(false);
  });

  it('rejects an impossible calendar date', () => {
    expect(accepts(dateSchema.safeParse('2026-02-30'))).toBe(false);
    expect(accepts(dateSchema.safeParse('2026-13-01'))).toBe(false);
  });

  it('accepts a leap day only in a leap year', () => {
    expect(accepts(dateSchema.safeParse('2028-02-29'))).toBe(true);
    expect(accepts(dateSchema.safeParse('2026-02-29'))).toBe(false);
  });
});

describe('the stock ledger entry', () => {
  it('accepts a dispensation', () => {
    expect(entryAccepts()).toBe(true);
  });

  it('rejects a quantity of zero or a fraction of a unit', () => {
    expect(entryAccepts({ quantity: 0 })).toBe(false);
    expect(entryAccepts({ quantity: 2.5 })).toBe(false);
    expect(entryAccepts({ quantity: -5 })).toBe(false);
  });

  it('requires stock arriving to name its batch and expiry', () => {
    // Without a batch there is no expiry, and without an expiry the platform
    // cannot warn anyone before stock becomes waste.
    expect(entryAccepts({ kind: 'receipt' })).toBe(false);
    expect(entryAccepts({ kind: 'receipt', batchId: 'batch-1' })).toBe(false);
    expect(entryAccepts({ kind: 'receipt', expiresOn: '2027-01-01' })).toBe(false);
    expect(entryAccepts(incoming)).toBe(true);
  });

  it('rejects a batch that expires on the day it moved', () => {
    expect(entryAccepts({ ...incoming, expiresOn: '2026-01-01' })).toBe(false);
  });

  it('requires an adjustment to state its direction and forbids anything else from doing so', () => {
    // The direction of an adjustment cannot be inferred from its kind, so it
    // must be stated; every other kind has a direction implied by the kind, so
    // a stated direction there is a contradiction rather than a hint.
    expect(entryAccepts({ kind: 'adjust' })).toBe(false);
    expect(entryAccepts({ kind: 'adjust', adjustmentDirection: 'decrease' })).toBe(true);
    expect(entryAccepts({ kind: 'issue', adjustmentDirection: 'decrease' })).toBe(false);
  });

  it('requires an expiry to name the batch that expired', () => {
    expect(entryAccepts({ kind: 'expiry' })).toBe(false);
    expect(entryAccepts({ kind: 'expiry', batchId: 'batch-1' })).toBe(true);
  });

  it('requires both ends of a transfer to be named', () => {
    const transfer = {
      kind: 'transfer_out',
      transferId: 'transfer-1',
      counterpartFacilityId: 'facility-b',
    };
    expect(entryAccepts(transfer)).toBe(true);
    expect(entryAccepts({ kind: 'transfer_out', transferId: 'transfer-1' })).toBe(false);
    expect(entryAccepts({ kind: 'transfer_out', counterpartFacilityId: 'facility-b' })).toBe(false);
  });

  it('rejects a transfer between a facility and itself', () => {
    expect(
      entryAccepts({
        kind: 'transfer_out',
        transferId: 'transfer-1',
        counterpartFacilityId: 'facility-a',
      }),
    ).toBe(false);
  });

  it('rejects a movement that is not a transfer naming one', () => {
    expect(entryAccepts({ transferId: 'transfer-1' })).toBe(false);
    expect(entryAccepts({ counterpartFacilityId: 'facility-b' })).toBe(false);
  });

  it('rejects fields it does not know about', () => {
    // A field the schema silently drops is a field that silently does nothing.
    expect(entryAccepts({ notes: 'free text' })).toBe(false);
  });
});

describe('observations', () => {
  const rawBeds = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    facilityId: 'facility-a',
    observedOn: '2026-01-01',
    bedsTotal: 6,
    bedsOccupied: 4,
    recordedAt: '2026-01-01T09:00:00.000Z',
    idempotencyKey: 'key-beds-1',
    captureSource: SIMULATED_CAPTURE_SOURCE,
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  const rawAttendance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    facilityId: 'facility-a',
    observedOn: '2026-01-01',
    cadre: 'staff_nurse',
    postsSanctioned: 4,
    postsFilled: 3,
    presentToday: 2,
    recordedAt: '2026-01-01T09:00:00.000Z',
    idempotencyKey: 'key-attendance-1',
    captureSource: SIMULATED_CAPTURE_SOURCE,
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a plausible bed position', () => {
    expect(accepts(bedStatusSchema.safeParse(rawBeds()))).toBe(true);
  });

  it('rejects more occupied beds than beds reported', () => {
    expect(accepts(bedStatusSchema.safeParse(rawBeds({ bedsOccupied: 7 })))).toBe(false);
  });

  it('rejects attendance above the posts filled, and filled above the sanctioned strength', () => {
    expect(accepts(staffAttendanceSchema.safeParse(rawAttendance()))).toBe(true);
    expect(accepts(staffAttendanceSchema.safeParse(rawAttendance({ presentToday: 4 })))).toBe(
      false,
    );
    expect(accepts(staffAttendanceSchema.safeParse(rawAttendance({ postsFilled: 5 })))).toBe(false);
  });
});

describe('derived values', () => {
  const rawSnapshot = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    facilityId: 'facility-a',
    itemId: 'item-paracetamol',
    asOf: '2026-01-31',
    onHand: 10,
    inTransit: 0,
    issuedLast30Days: 20,
    demandRate: 2,
    demandBasis: 'observed',
    daysOfStock: 5,
    censoredDays: 0,
    lastMovementOn: null,
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a position whose cover is known', () => {
    expect(accepts(stockSnapshotSchema.safeParse(rawSnapshot()))).toBe(true);
  });

  it('accepts cover that is unknown, and never as a negative or infinite figure', () => {
    // `null` is the only representation of "not measurable" the schema offers,
    // so a caller has to decide what to show instead of defaulting to a number.
    expect(accepts(stockSnapshotSchema.safeParse(rawSnapshot({ daysOfStock: null })))).toBe(true);
    expect(accepts(stockSnapshotSchema.safeParse(rawSnapshot({ daysOfStock: -1 })))).toBe(false);
  });

  it('rejects a negative position or a negative demand rate', () => {
    expect(accepts(stockSnapshotSchema.safeParse(rawSnapshot({ onHand: -1 })))).toBe(false);
    expect(accepts(stockSnapshotSchema.safeParse(rawSnapshot({ demandRate: -0.5 })))).toBe(false);
  });

  const rawGap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    facilityId: 'facility-a',
    from: '2026-01-05',
    to: '2026-01-08',
    days: 4,
    missing: ['stock'],
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a reporting gap, including one that has not ended', () => {
    expect(accepts(reportingGapSchema.safeParse(rawGap()))).toBe(true);
    expect(accepts(reportingGapSchema.safeParse(rawGap({ to: null })))).toBe(true);
  });

  it('rejects a gap that ends before it begins or names nothing missing', () => {
    expect(accepts(reportingGapSchema.safeParse(rawGap({ to: '2026-01-04' })))).toBe(false);
    expect(accepts(reportingGapSchema.safeParse(rawGap({ missing: [] })))).toBe(false);
  });
});

describe('intelligence records', () => {
  const rawForecast = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    facilityId: 'facility-a',
    itemId: 'item-paracetamol',
    asOf: '2026-01-31',
    horizonDays: 3,
    p50: [1, 2, 3],
    p90: [2, 3, 4],
    method: 'croston-sba',
    modelVersion: '0.0.0',
    censoredDaysImputed: 0,
    imputation: 'none',
    features: [{ name: 'days', value: 120 }],
    warnings: [],
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a forecast that covers its horizon', () => {
    expect(accepts(forecastSchema.safeParse(rawForecast()))).toBe(true);
  });

  it('rejects a forecast that does not cover exactly the horizon asked for', () => {
    expect(accepts(forecastSchema.safeParse(rawForecast({ p50: [1, 2] })))).toBe(false);
    expect(accepts(forecastSchema.safeParse(rawForecast({ p90: [1, 2] })))).toBe(false);
  });

  it('rejects an upper quantile below the median', () => {
    expect(accepts(forecastSchema.safeParse(rawForecast({ p90: [0, 3, 4] })))).toBe(false);
  });

  it('accepts a forecast that states what it looked at, and refuses one that does not', () => {
    // A forecast with no features cannot be argued with, and one with a warning
    // that names nothing is noise rather than disclosure.
    expect(accepts(forecastSchema.safeParse(rawForecast({ features: [] })))).toBe(true);
    expect(
      accepts(forecastSchema.safeParse(rawForecast({ warnings: ['pooled from peers'] }))),
    ).toBe(true);
    expect(accepts(forecastSchema.safeParse(rawForecast({ warnings: ['  '] })))).toBe(false);
    expect(
      accepts(
        forecastSchema.safeParse(rawForecast({ features: [{ name: 'days', value: 'many' }] })),
      ),
    ).toBe(false);
  });

  const rawAlert = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'alert-1',
    facilityId: 'facility-a',
    itemId: 'item-paracetamol',
    raisedOn: '2026-01-31',
    severity: 'high',
    state: 'open',
    bodies: {
      en: 'Stock-out expected within 7 days',
      hi: 'सात दिनों में स्टॉक खत्म होने की संभावना',
    },
    riskScoreId: null,
    dedupeKey: 'facility-a::item-paracetamol::2026-01-31',
    acknowledgedBy: null,
    acknowledgedByRole: null,
    acknowledgedAt: null,
    resolvedAt: null,
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts an alert written in more than one language', () => {
    expect(accepts(alertSchema.safeParse(rawAlert()))).toBe(true);
  });

  it('rejects an alert with no language a user can read', () => {
    // An empty record satisfies a record-of-strings validator on its own, which
    // is exactly why this case has to be asserted.
    expect(accepts(alertSchema.safeParse(rawAlert({ bodies: {} })))).toBe(false);
  });

  it('rejects an alert that was acted on without recording who acted', () => {
    expect(accepts(alertSchema.safeParse(rawAlert({ state: 'acknowledged' })))).toBe(false);
    expect(
      accepts(
        alertSchema.safeParse(
          rawAlert({
            state: 'acknowledged',
            acknowledgedBy: 'uid-1',
            acknowledgedByRole: 'district_officer',
            acknowledgedAt: '2026-01-31T10:00:00.000Z',
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe('coordination records', () => {
  const rawProposal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'proposal-1',
    itemId: 'item-paracetamol',
    fromFacilityId: 'facility-a',
    toFacilityId: 'facility-b',
    quantity: 50,
    batchId: 'batch-1',
    verdict: 'proposed',
    violations: [],
    expectedImpact: {
      unmetDemandAvoided: 40,
      donorDaysOfStockAfter: 21,
      receiverDaysOfStockAfter: 12,
      assumptions: ['donor keeps 14 days of cover', 'receiver demand stays at the observed rate'],
    },
    approvals: [],
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a proposal between two facilities', () => {
    expect(accepts(transferProposalSchema.safeParse(rawProposal()))).toBe(true);
  });

  it('rejects a transfer between a facility and itself', () => {
    expect(
      accepts(transferProposalSchema.safeParse(rawProposal({ toFacilityId: 'facility-a' }))),
    ).toBe(false);
  });

  it('requires a rejected proposal to name the constraint that refused it', () => {
    expect(accepts(transferProposalSchema.safeParse(rawProposal({ verdict: 'rejected' })))).toBe(
      false,
    );
    expect(
      accepts(
        transferProposalSchema.safeParse(
          rawProposal({
            verdict: 'rejected',
            violations: [
              { constraint: 'cold-chain', detail: 'receiving facility has no working cold chain' },
            ],
          }),
        ),
      ),
    ).toBe(true);
  });

  it('rejects a standing proposal that also carries a violation', () => {
    expect(
      accepts(
        transferProposalSchema.safeParse(
          rawProposal({
            violations: [{ constraint: 'budget', detail: 'exceeds the district transport budget' }],
          }),
        ),
      ),
    ).toBe(false);
  });

  it('requires an impact estimate to state its assumptions', () => {
    // An estimate without its assumptions is a claim, and this is what stops it
    // becoming one.
    expect(
      accepts(
        transferProposalSchema.safeParse(
          rawProposal({
            expectedImpact: {
              unmetDemandAvoided: 40,
              donorDaysOfStockAfter: 21,
              receiverDaysOfStockAfter: 12,
              assumptions: [],
            },
          }),
        ),
      ),
    ).toBe(false);
  });

  const rawRound = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'round-1',
    round: 1,
    algorithm: 'fedprox',
    participantRegionIds: ['region-a', 'region-b'],
    startedAt: '2026-01-01T02:00:00.000Z',
    completedAt: '2026-01-01T02:04:00.000Z',
    epsilonSpent: 0.5,
    delta: 1e-5,
    containsRecordIdentifiers: false,
    federatedMetric: 0.31,
    localOnlyBaselineMetric: 0.38,
    synthetic: true,
    provenance: SIMULATED_PROVENANCE,
    ...overrides,
  });

  it('accepts a federation round between two silos', () => {
    expect(accepts(federationRoundSchema.safeParse(rawRound()))).toBe(true);
  });

  it('refuses to represent a round that claims to have carried record identifiers', () => {
    // The load-bearing assertion of the federation story: a payload that could
    // name a patient's record is a breach, so the schema does not offer a way
    // to describe one.
    expect(
      accepts(federationRoundSchema.safeParse(rawRound({ containsRecordIdentifiers: true }))),
    ).toBe(false);
  });

  it('rejects a round with fewer than two participants or no privacy cost', () => {
    expect(
      accepts(federationRoundSchema.safeParse(rawRound({ participantRegionIds: ['region-a'] }))),
    ).toBe(false);
    expect(accepts(federationRoundSchema.safeParse(rawRound({ epsilonSpent: 0 })))).toBe(false);
  });
});

describe('the catalogue and the network', () => {
  it('accepts an item and a facility that describe themselves consistently', () => {
    expect(accepts(itemSchema.safeParse(anItem()))).toBe(true);
    expect(accepts(facilitySchema.safeParse(aFacility()))).toBe(true);
  });

  it('rejects an item whose cold-chain claim contradicts its storage class', () => {
    // A vaccine that claims to travel at ambient temperature would be cleared
    // for a redistribution that ruins it.
    expect(accepts(itemSchema.safeParse({ ...anItem(), coldChain: true }))).toBe(false);
    expect(
      accepts(itemSchema.safeParse({ ...anItem(), coldChain: true, storage: 'cold-chain' })),
    ).toBe(true);
  });

  it('rejects a surge-sensitive item that names no syndrome', () => {
    // A consumption-per-case figure with nowhere to apply it cannot turn a
    // surveillance surge into a demand lift.
    expect(accepts(itemSchema.safeParse({ ...anItem(), unitsPerCase: 12, syndromes: [] }))).toBe(
      false,
    );
    expect(accepts(itemSchema.safeParse({ ...anItem(), unitsPerCase: 0, syndromes: [] }))).toBe(
      true,
    );
  });

  it('rejects a facility sited against no population', () => {
    expect(accepts(facilitySchema.safeParse({ ...aFacility(), normPopulation: 0 }))).toBe(false);
  });
});
