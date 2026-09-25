import { deriveInTransit, ingestRequestSchema, provenanceSchema } from '@civora/domain';
import type { StockLedgerEntry } from '@civora/domain';
import {
  FACILITY_A,
  FACILITY_B,
  aBedReport,
  aLedgerEntry,
  aReceipt,
  anItem,
} from '@civora/domain/testing';
import { describe, expect, it } from 'vitest';

import { CRITICAL_COVER_DAYS, LedgerService, STALE_AFTER_DAYS } from './ledger-service';

/**
 * What a facility looks like, derived from what it reported.
 *
 * The projection is the only thing between the ledger and every figure an
 * officer sees, so its rules are asserted directly: when a position may be shown
 * at all, that an unmeasurable demand rate produces no cover figure rather than
 * a zero, and that stock in transit stays a derived quantity. The staleness rules
 * get the most attention because they decide whether the platform says anything
 * at all about a facility that has gone quiet — the case where a wrong answer is
 * most dangerous.
 */

const PROVENANCE = provenanceSchema.parse({
  kind: 'derived',
  reference: 'reporting-gap-detection',
});

const service = (through: string, items = [anItem()]): LedgerService =>
  new LedgerService({
    from: '2026-01-01',
    through,
    items,
    synthetic: true,
    provenance: PROVENANCE,
  });

/** A receipt of `quantity` units, on a given day. */
const receiptOn = (
  day: string,
  quantity = 100,
  overrides: Record<string, unknown> = {},
): StockLedgerEntry =>
  aReceipt({
    id: `receipt-${day}`,
    occurredOn: day,
    recordedAt: `${day}T09:00:00.000Z`,
    quantity,
    ...overrides,
  });

describe('a facility the platform has never heard from', () => {
  it('has no status, no position and no reading, rather than zeroes', () => {
    const reading = service('2026-01-31').readingFor(FACILITY_A);

    expect(reading.status).toBe('never-heard');
    expect(reading.stock).toBeNull();
    expect(reading.beds).toBeNull();
    expect(reading.attendance).toBeNull();
    expect(reading.footfall).toBeNull();
    expect(reading.syndromic).toBeNull();
    expect(reading.newestReadingOn).toBeNull();
    expect(reading.daysSinceReading).toBeNull();
    expect(reading.daysHeard).toBe(0);
  });

  it('reports the whole window as one open gap', () => {
    const reading = service('2026-03-01').readingFor(FACILITY_A);

    expect(reading.gaps).toHaveLength(1);
    expect(reading.gaps[0]?.from).toBe('2026-01-01');
    expect(reading.gaps[0]?.to).toBeNull();
    expect(reading.gaps[0]?.missing).toContain('stock');
  });
});

describe('how old a reading is', () => {
  it('is current while the newest reading is within the tolerance', () => {
    const ledger = service('2026-01-10');
    ledger.applyEntry(receiptOn('2026-01-10'));

    const reading = ledger.readingFor(FACILITY_A);
    expect(reading.status).toBe('current');
    expect(reading.daysSinceReading).toBe(0);
    expect(reading.newestReadingOn).toBe('2026-01-10');
  });

  it('is stale once it is older than the tolerance, and says how old', () => {
    const ledger = service('2026-01-20');
    ledger.applyEntry(receiptOn('2026-01-10'));

    const reading = ledger.readingFor(FACILITY_A);
    expect(STALE_AFTER_DAYS).toBe(3);
    expect(reading.daysSinceReading).toBe(10);
    expect(reading.status).toBe('stale');
  });

  it('keeps the last known position for a stale facility, and the day it describes', () => {
    const ledger = service('2026-01-20');
    ledger.applyEntry(receiptOn('2026-01-10', 100));

    const stock = ledger.stockFor(FACILITY_A);
    // A position that exists is still shown — the staleness is in the reading,
    // and the surface judges what to do with it rather than being handed a
    // figure with no date on it.
    expect(stock?.asOf).toBe('2026-01-20');
    expect(stock?.items[0]?.onHand).toBe(100);
    expect(stock?.items[0]?.lastMovementOn).toBe('2026-01-10');
  });

  it("moves the platform's present forward when a later day arrives", () => {
    const ledger = service('2026-01-10');
    ledger.applyEntry(receiptOn('2026-01-12'));

    // A capture made today is today's news, not a reading from the future.
    expect(ledger.asOf()).toBe('2026-01-12');
    expect(ledger.readingFor(FACILITY_A).status).toBe('current');
  });

  it('does not move backwards when an older day arrives afterwards', () => {
    const ledger = service('2026-01-10');
    ledger.applyEntry(receiptOn('2026-01-12'));
    ledger.applyEntry(receiptOn('2026-01-05', 10, { id: 'receipt-late' }));

    expect(ledger.asOf()).toBe('2026-01-12');
    expect(ledger.readingFor(FACILITY_A).newestReadingOn).toBe('2026-01-12');
  });
});

describe('cover, and the days it may not be computed from', () => {
  it('reports no cover figure when demand is not measurable', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(receiptOn('2026-01-31', 100));

    const position = ledger.stockFor(FACILITY_A)?.items[0];
    expect(position?.daysOfStock).toBeNull();
    expect(ledger.stockFor(FACILITY_A)?.itemsWithUnknownCover).toBe(1);

    // The window also holds days on which the shelf was empty, so the platform
    // says the rate was corrected rather than measured — which for a facility
    // with a day of history is the truthful description: there was nothing to
    // measure a rate from.
    expect(position?.demandBasis).toBe('censoring-corrected');
  });

  it('computes cover from the rate of issue across the days the shelf held stock', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(receiptOn('2026-01-01', 1000));

    // Ten units a day for the last twenty days of the window. The days before
    // the receipt were days with nothing on the shelf, so the rate is measured
    // over the thirty-one days it did hold stock: not ten a day, but the average
    // including the days it held stock and issued nothing.
    for (let day = 12; day <= 31; day += 1) {
      const date = `2026-01-${String(day).padStart(2, '0')}`;
      ledger.applyEntry(
        aLedgerEntry({
          id: `issue-${date}`,
          kind: 'issue',
          quantity: 10,
          occurredOn: date,
          recordedAt: `${date}T09:00:00.000Z`,
        }),
      );
    }

    const stock = ledger.stockFor(FACILITY_A);
    const position = stock?.items[0];
    expect(position?.onHand).toBe(800);
    expect(position?.issuedLast30Days).toBe(200);
    expect(position?.daysOfStock).toBeCloseTo(800 / (200 / 31), 5);
    expect(stock?.itemsBelowCritical).toBe(0);
  });

  it('corrects the rate when the shelf was empty, rather than reading supply as need', () => {
    const ledger = service('2026-01-31');
    // Ten units a day until the stock runs out, and nothing at all afterwards:
    // the recorded rate measures what could be dispensed, not what was needed.
    for (let day = 1; day <= 10; day += 1) {
      const date = `2026-01-${String(day).padStart(2, '0')}`;
      ledger.applyEntry(
        aLedgerEntry({
          id: `issue-${date}`,
          kind: 'issue',
          quantity: 10,
          occurredOn: date,
          recordedAt: `${date}T09:00:00.000Z`,
        }),
      );
    }

    const position = ledger.stockFor(FACILITY_A)?.items[0];
    expect(position?.demandBasis).toBe('censoring-corrected');
    expect(position?.onHand).toBe(0);
    expect(ledger.stockFor(FACILITY_A)?.itemsOutOfStock).toBe(1);
  });

  it('sorts a list of the worst-covered items, and puts an unknown last', () => {
    const fast = anItem({ id: 'item-fast', genericName: 'Fast mover' });
    const slow = anItem({ id: 'item-slow', genericName: 'Slow mover' });
    const ledger = service('2026-01-31', [fast, slow]);

    // The fast mover is issued faster than it arrives and is emptied by the end
    // of the window; the slow mover has a receipt and no history of use at all.
    ledger.applyEntry(receiptOn('2026-01-01', 1000, { itemId: fast.id }));
    ledger.applyEntry(receiptOn('2026-01-31', 500, { itemId: slow.id, id: 'receipt-slow' }));
    for (let day = 28; day <= 31; day += 1) {
      const date = `2026-01-${String(day).padStart(2, '0')}`;
      ledger.applyEntry(
        aLedgerEntry({
          id: `fast-${date}`,
          itemId: fast.id,
          kind: 'issue',
          quantity: 250,
          occurredOn: date,
          recordedAt: `${date}T09:00:00.000Z`,
        }),
      );
    }

    const stock = ledger.stockFor(FACILITY_A);
    const items = stock?.items ?? [];
    expect(items.map((position) => position.itemId)).toEqual(['item-fast', 'item-slow']);
    expect(items[0]?.daysOfStock).toBe(0);
    expect(items[0]!.daysOfStock).toBeLessThan(CRITICAL_COVER_DAYS);
    expect(stock?.itemsBelowCritical).toBe(1);
    expect(stock?.itemsOutOfStock).toBe(1);
    // Unknown cover sorts last: it is not a small number, and a list of the
    // worst-covered items is not where an unknown belongs.
    expect(items[1]?.daysOfStock).toBeNull();
  });
});

describe('stock on its way', () => {
  it('shows stock on the way to a facility that has reported nothing at all', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(
      aLedgerEntry({
        id: 'transfer-out-1',
        facilityId: FACILITY_A,
        kind: 'transfer_out',
        quantity: 30,
        occurredOn: '2026-01-10',
        recordedAt: '2026-01-10T09:00:00.000Z',
        transferId: 'transfer-1',
        counterpartFacilityId: FACILITY_B,
      }),
    );

    // Nothing has ever arrived from B, but a delivery is on its way to it. That
    // is a fact about B, and B reordering into a delivery it cannot see is how
    // stock ends up expiring in one store while another runs out.
    const stock = ledger.stockFor(FACILITY_B);
    expect(stock?.itemsTracked).toBe(1);
    expect(stock?.items[0]?.onHand).toBe(0);
    expect(stock?.items[0]?.inTransit).toBe(30);
    expect(stock?.items[0]?.daysOfStock).toBeNull();

    // But nothing has been *reported* by B, so its reading is still that it has
    // never been heard from: the platform knows something about B, not from B.
    expect(ledger.readingFor(FACILITY_B).status).toBe('never-heard');
  });

  it('stops counting stock as in transit once it lands', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(
      aLedgerEntry({
        id: 'transfer-out-1',
        facilityId: FACILITY_A,
        kind: 'transfer_out',
        quantity: 30,
        occurredOn: '2026-01-10',
        recordedAt: '2026-01-10T09:00:00.000Z',
        transferId: 'transfer-1',
        counterpartFacilityId: FACILITY_B,
      }),
    );
    ledger.applyEntry(
      aLedgerEntry({
        id: 'transfer-in-1',
        facilityId: FACILITY_B,
        kind: 'transfer_in',
        quantity: 30,
        occurredOn: '2026-01-12',
        recordedAt: '2026-01-12T09:00:00.000Z',
        transferId: 'transfer-1',
        counterpartFacilityId: FACILITY_A,
        batchId: 'batch-transfer-1',
        expiresOn: '2027-01-01',
      }),
    );

    const position = ledger.stockFor(FACILITY_B)?.items[0];
    expect(position?.inTransit).toBe(0);
    expect(position?.onHand).toBe(30);
  });

  it('agrees with the derivation it optimises', () => {
    // The projection maintains in-transit as entries arrive; `deriveInTransit`
    // scans the whole ledger to answer the same question. An optimisation that
    // disagrees with its definition is a wrong answer delivered quickly, so the
    // two are compared over the same entries.
    const entries: StockLedgerEntry[] = [
      aLedgerEntry({
        id: 'transfer-out-1',
        facilityId: FACILITY_A,
        kind: 'transfer_out',
        quantity: 30,
        occurredOn: '2026-01-10',
        recordedAt: '2026-01-10T09:00:00.000Z',
        transferId: 'transfer-1',
        counterpartFacilityId: FACILITY_B,
      }),
      aLedgerEntry({
        id: 'transfer-out-2',
        facilityId: FACILITY_A,
        kind: 'transfer_out',
        quantity: 12,
        occurredOn: '2026-01-11',
        recordedAt: '2026-01-11T09:00:00.000Z',
        transferId: 'transfer-2',
        counterpartFacilityId: FACILITY_B,
      }),
      aLedgerEntry({
        id: 'transfer-in-1',
        facilityId: FACILITY_B,
        kind: 'transfer_in',
        quantity: 30,
        occurredOn: '2026-01-12',
        recordedAt: '2026-01-12T09:00:00.000Z',
        transferId: 'transfer-1',
        counterpartFacilityId: FACILITY_A,
        batchId: 'batch-transfer-1',
        expiresOn: '2027-01-01',
      }),
    ];

    const ledger = service('2026-01-31');
    for (const entry of entries) {
      ledger.applyEntry(entry);
    }

    expect(ledger.stockFor(FACILITY_B)?.items[0]?.inTransit).toBe(
      deriveInTransit(entries, FACILITY_B, anItem().id),
    );
    expect(ledger.stockFor(FACILITY_B)?.items[0]?.inTransit).toBe(12);
  });
});

describe('the rest of what a facility reports', () => {
  it('reads beds, attendance, footfall and syndromic counts as the latest day only', () => {
    const ledger = service('2026-01-31');
    ledger.applyBedStatus(aBedReport({ observedOn: '2026-01-30', bedsTotal: 6, bedsOccupied: 5 }));
    ledger.applyBedStatus(aBedReport({ observedOn: '2026-01-31', bedsTotal: 6, bedsOccupied: 2 }));

    const reading = ledger.readingFor(FACILITY_A);
    expect(reading.beds).toEqual({
      observedOn: '2026-01-31',
      total: 6,
      occupied: 2,
      occupancy: 2 / 6,
    });
    expect(reading.status).toBe('current');
    expect(reading.daysHeard).toBe(2);
  });

  it('applies a submission through the envelope, which is how the boundary feeds it', () => {
    const ledger = service('2026-01-31');
    const request = ingestRequestSchema.parse({
      type: 'bed_status',
      idempotencyKey: 'capture-1',
      captureSource: 'manual',
      capturedAt: '2026-01-31T10:00:00.000Z',
      observation: {
        facilityId: FACILITY_A,
        observedOn: '2026-01-31',
        bedsTotal: 6,
        bedsOccupied: 3,
        recordedAt: '2026-01-31T09:00:00.000Z',
        idempotencyKey: 'capture-1',
        captureSource: 'manual',
        synthetic: true,
        provenance: { kind: 'simulated', reference: 'capture-surface' },
      },
    });

    ledger.applyRequest(request);
    expect(ledger.readingFor(FACILITY_A).beds?.occupied).toBe(3);
  });

  it('lists the latest movements newest first, named from the catalogue', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(receiptOn('2026-01-05', 10, { id: 'entry-old' }));
    ledger.applyEntry(receiptOn('2026-01-20', 20, { id: 'entry-new' }));

    const movements = ledger.readingFor(FACILITY_A).recentMovements;
    expect(movements.map((movement) => movement.id)).toEqual(['entry-new', 'entry-old']);
    expect(movements[0]?.itemName).toBe('Paracetamol');
    expect(movements[0]?.kind).toBe('receipt');
  });

  it('notices nothing changed when a stale reading is asked for twice', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(receiptOn('2026-01-10', 100));

    const first = ledger.readingFor(FACILITY_A);
    const second = ledger.readingFor(FACILITY_A);
    expect(second).toBe(first);
  });

  it('recomputes the reading after a new movement arrives', () => {
    const ledger = service('2026-01-31');
    ledger.applyEntry(receiptOn('2026-01-10', 100));
    const before = ledger.stockFor(FACILITY_A)?.items[0]?.onHand;

    ledger.applyEntry(
      aLedgerEntry({
        id: 'issue-after',
        kind: 'issue',
        quantity: 25,
        occurredOn: '2026-01-20',
        recordedAt: '2026-01-20T09:00:00.000Z',
      }),
    );

    expect(before).toBe(100);
    expect(ledger.stockFor(FACILITY_A)?.items[0]?.onHand).toBe(75);
  });
});
