import { describe, expect, it } from 'vitest';

import { SIMULATED_PROVENANCE } from '../model/common';
import {
  FACILITY_A,
  FACILITY_B,
  ITEM_PARACETAMOL,
  aLedgerEntry,
  aReceipt,
  dailyIssues,
} from '../testing/factories';
import { addDays } from './dates';
import { daysOfStock } from './inventory';
import { deriveStockSnapshot } from './snapshot';

/**
 * A snapshot is what an officer reads to decide whether a facility is in
 * trouble, so each case here is a way that reading could mislead.
 */

const options = (asOf: string, windowDays: number) => ({
  asOf,
  windowDays,
  synthetic: true,
  provenance: SIMULATED_PROVENANCE,
});

const windowFrom = (asOf: string, windowDays: number): string => addDays(asOf, -(windowDays - 1));

describe('deriving a stock snapshot', () => {
  it('refuses a window too short to report a 30-day total from', () => {
    // The 30-day issue total is published next to the position, and a window
    // that cannot support it would make that figure describe something other
    // than the last 30 days.
    expect(() =>
      deriveStockSnapshot([], FACILITY_A, ITEM_PARACETAMOL, options('2026-01-30', 29)),
    ).toThrow(/at least 30 days/);
  });

  it('reports the position and the observed demand rate when nothing was censored', () => {
    const asOf = '2026-01-30';
    const windowDays = 30;
    const from = windowFrom(asOf, windowDays);
    const snapshot = deriveStockSnapshot(
      [
        aReceipt({ occurredOn: from, quantity: 500 }),
        ...dailyIssues(Array.from({ length: windowDays }, () => 2), from),
      ],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );

    expect(snapshot.onHand).toBe(440);
    expect(snapshot.demandBasis).toBe('observed');
    expect(snapshot.demandRate).toBe(2);
    expect(snapshot.daysOfStock).toBe(220);
    expect(snapshot.censoredDays).toBe(0);
    expect(snapshot.issuedLast30Days).toBe(60);
    expect(snapshot.lastMovementOn).toBe(asOf);
  });

  it('corrects for a stock-out instead of reporting the facility as well covered', () => {
    // Ten days with an empty shelf, then thirty days of steady use. Read
    // literally, the ledger says the facility used 150 units in 40 days and so
    // has thirteen days of cover left. It actually has ten.
    const asOf = '2026-02-09';
    const windowDays = 40;
    const from = windowFrom(asOf, windowDays);
    const stockArrived = addDays(from, 10);
    const snapshot = deriveStockSnapshot(
      [
        aReceipt({ occurredOn: stockArrived, quantity: 200 }),
        ...dailyIssues(Array.from({ length: 30 }, () => 5), stockArrived),
      ],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );

    const recordedRate = 150 / windowDays;

    expect(snapshot.onHand).toBe(50);
    expect(snapshot.censoredDays).toBe(10);
    expect(snapshot.demandBasis).toBe('censoring-corrected');
    expect(snapshot.demandRate).toBe(5);
    expect(snapshot.daysOfStock).toBe(10);
    expect(daysOfStock(snapshot.onHand, recordedRate) ?? 0).toBeGreaterThan(snapshot.daysOfStock ?? 0);
  });

  it('reports unmeasurable demand as unknown cover rather than as none', () => {
    const asOf = '2026-01-30';
    const windowDays = 30;
    const snapshot = deriveStockSnapshot(
      [aReceipt({ occurredOn: windowFrom(asOf, windowDays), quantity: 100 })],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );

    expect(snapshot.onHand).toBe(100);
    expect(snapshot.daysOfStock).toBeNull();
    expect(snapshot.demandRate).toBe(0);
  });

  it('reports a 30-day issue total that is not the whole window', () => {
    const asOf = '2026-02-09';
    const windowDays = 40;
    const from = windowFrom(asOf, windowDays);
    const snapshot = deriveStockSnapshot(
      [
        aReceipt({ occurredOn: from, quantity: 500 }),
        ...dailyIssues(Array.from({ length: 10 }, () => 1), from),
        ...dailyIssues(Array.from({ length: 30 }, () => 5), addDays(from, 10)),
      ],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );

    expect(snapshot.issuedLast30Days).toBe(150);
    expect(snapshot.onHand).toBe(340);
  });

  it('shows stock dispatched towards the facility without counting it as on hand', () => {
    // The facility cannot see the truck. If the platform cannot either, it
    // reports a shortage that is already being solved and the order is placed
    // again.
    const asOf = '2026-01-30';
    const windowDays = 30;
    const from = windowFrom(asOf, windowDays);
    const receipt = aReceipt({ occurredOn: from, quantity: 100 });
    const dispatched = aLedgerEntry({
      id: 'dispatch-1',
      kind: 'transfer_out',
      facilityId: FACILITY_B,
      counterpartFacilityId: FACILITY_A,
      transferId: 'transfer-1',
      quantity: 30,
      occurredOn: '2026-01-20',
    });

    const awaiting = deriveStockSnapshot(
      [receipt, dispatched],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );
    expect(awaiting.onHand).toBe(100);
    expect(awaiting.inTransit).toBe(30);

    const received = aLedgerEntry({
      id: 'receive-1',
      kind: 'transfer_in',
      counterpartFacilityId: FACILITY_B,
      transferId: 'transfer-1',
      batchId: 'batch-1',
      expiresOn: '2027-01-01',
      quantity: 30,
      occurredOn: '2026-01-25',
    });

    const landed = deriveStockSnapshot(
      [receipt, dispatched, received],
      FACILITY_A,
      ITEM_PARACETAMOL,
      options(asOf, windowDays),
    );
    expect(landed.onHand).toBe(130);
    expect(landed.inTransit).toBe(0);
  });
});
