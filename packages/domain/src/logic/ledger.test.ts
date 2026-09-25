import { describe, expect, it } from 'vitest';

import type { StockLedgerEntry } from '../model/sensing';
import {
  FACILITY_A,
  FACILITY_B,
  ITEM_PARACETAMOL,
  aLedgerEntry,
  aReceipt,
  dailyIssues,
} from '../testing/factories';
import { eachDay } from './dates';
import { deriveInTransit, replayStockLedger } from './ledger';

/**
 * The ledger is the record of truth, so these tests are about the properties an
 * auditor would check: that the same entries always produce the same series,
 * that a retry cannot invent stock, and that an impossible position is reported
 * rather than smoothed away.
 */

const FROM = '2026-01-01';
const TO = '2026-01-05';

const replay = (entries: readonly StockLedgerEntry[]) =>
  replayStockLedger(entries, FACILITY_A, ITEM_PARACETAMOL, { from: FROM, to: TO });

describe('replaying the stock ledger', () => {
  it('returns one row for every day in the window, ascending', () => {
    const result = replay([]);

    expect(result.days.map((day) => day.on)).toEqual(eachDay(FROM, TO));
    expect(result.days.map((day) => day.onHand)).toEqual([0, 0, 0, 0, 0]);
    expect(result.closingOnHand).toBe(0);
    expect(result.lastMovementOn).toBeNull();
  });

  it('absorbs movements before the window into an opening balance', () => {
    const result = replay([
      aReceipt({ id: 'opening', occurredOn: '2025-12-31', quantity: 40 }),
      ...dailyIssues([10, 5], FROM),
    ]);

    expect(result.days.map((day) => day.onHand)).toEqual([30, 25, 25, 25, 25]);
    expect(result.days.map((day) => day.issued)).toEqual([10, 5, 0, 0, 0]);
    expect(result.lastMovementOn).toBe('2026-01-02');
  });

  it('produces the same series whatever order the entries arrived in', () => {
    const entries = [
      aReceipt({ id: 'r-1', occurredOn: '2026-01-01', quantity: 60 }),
      ...dailyIssues([4, 4, 4], '2026-01-02'),
      aLedgerEntry({
        id: 'a-1',
        kind: 'adjust',
        adjustmentDirection: 'decrease',
        quantity: 3,
        occurredOn: '2026-01-05',
      }),
    ];

    // Arrival order is a property of the transport, not of the record.
    expect(replay([...entries].reverse()).days).toEqual(replay(entries).days);
  });

  it('ignores a resent entry rather than counting it twice', () => {
    const result = replay([
      aReceipt({ id: 'r-1', idempotencyKey: 'k-receipt', quantity: 40 }),
      aReceipt({
        id: 'r-1-retry',
        idempotencyKey: 'k-receipt',
        quantity: 40,
        recordedAt: '2026-01-01T10:00:00.000Z',
      }),
    ]);

    expect(result.duplicatesIgnored).toBe(1);
    expect(result.closingOnHand).toBe(40);
  });

  it('voids an entry that a later entry corrects', () => {
    const result = replay([
      aReceipt({ id: 'r-1', occurredOn: '2026-01-01', quantity: 100 }),
      aLedgerEntry({ id: 'i-1', kind: 'issue', quantity: 50, occurredOn: '2026-01-02' }),
      aLedgerEntry({
        id: 'i-2',
        kind: 'issue',
        quantity: 30,
        occurredOn: '2026-01-02',
        correctsEntryId: 'i-1',
        recordedAt: '2026-01-02T11:00:00.000Z',
      }),
    ]);

    // The corrected entry contributes nothing and the correction stands in its
    // place, so the day reports what actually left the store.
    expect(result.supersededEntries).toBe(1);
    expect(result.days.map((day) => day.issued)).toEqual([0, 30, 0, 0, 0]);
    expect(result.closingOnHand).toBe(70);
  });

  it('floors stock at zero and reports the ledger defect instead of hiding it', () => {
    const result = replay([
      aReceipt({ id: 'r-1', occurredOn: '2026-01-01', quantity: 10 }),
      aLedgerEntry({ id: 'i-1', kind: 'issue', quantity: 25, occurredOn: '2026-01-02' }),
    ]);

    expect(result.days.map((day) => day.onHand)).toEqual([10, 0, 0, 0, 0]);
    expect(result.entriesExceedingStock).toBe(1);
  });

  it('counts dispensations separately from stock moved out by transfer', () => {
    const result = replay([
      aReceipt({ id: 'r-1', occurredOn: '2026-01-01', quantity: 100 }),
      aLedgerEntry({
        id: 't-1',
        kind: 'transfer_out',
        quantity: 5,
        occurredOn: '2026-01-02',
        counterpartFacilityId: FACILITY_B,
        transferId: 'transfer-1',
      }),
    ]);

    // Stock sent to another facility is not consumption, and a demand model fed
    // on it would learn a shortage that never happened.
    expect(result.days.map((day) => day.onHand)).toEqual([100, 95, 95, 95, 95]);
    expect(result.days.every((day) => day.issued === 0)).toBe(true);
  });

  it('ignores entries belonging to another facility or another item', () => {
    const result = replay([
      aReceipt({ id: 'r-1', occurredOn: '2026-01-01', quantity: 50 }),
      aReceipt({ id: 'r-2', facilityId: FACILITY_B, occurredOn: '2026-01-01', quantity: 999 }),
      aReceipt({ id: 'r-3', itemId: 'item-other', occurredOn: '2026-01-01', quantity: 999 }),
    ]);

    expect(result.closingOnHand).toBe(50);
  });
});

describe('stock in transit', () => {
  const dispatch = aLedgerEntry({
    id: 'dispatch-1',
    kind: 'transfer_out',
    facilityId: FACILITY_B,
    counterpartFacilityId: FACILITY_A,
    transferId: 'transfer-1',
    quantity: 30,
    occurredOn: '2026-01-02',
  });

  const receipt = aLedgerEntry({
    id: 'receive-1',
    kind: 'transfer_in',
    counterpartFacilityId: FACILITY_B,
    transferId: 'transfer-1',
    batchId: 'batch-1',
    expiresOn: '2027-01-01',
    quantity: 30,
    occurredOn: '2026-01-04',
  });

  it('counts stock dispatched towards a facility until that facility receives it', () => {
    // Dispatch that is invisible looks like a shortage already solved, and the
    // facility orders again.
    expect(deriveInTransit([dispatch], FACILITY_A, ITEM_PARACETAMOL)).toBe(30);
  });

  it('stops counting it once the receiving facility records the receipt', () => {
    expect(deriveInTransit([dispatch, receipt], FACILITY_A, ITEM_PARACETAMOL)).toBe(0);
  });

  it('is not in transit for the facility that dispatched it', () => {
    expect(deriveInTransit([dispatch], FACILITY_B, ITEM_PARACETAMOL)).toBe(0);
  });
});
