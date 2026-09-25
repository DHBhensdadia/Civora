import type { DateOnly, FacilityId, ItemId } from '../model/common';
import type { LedgerEntryKind, StockLedgerEntry } from '../model/sensing';
import { compareDateOnly, eachDay } from './dates';

/**
 * Replaying the stock ledger.
 *
 * The ledger is the record of truth and this is the only supported way to read
 * a position out of it. Two properties matter more than speed:
 *
 *  - **Determinism.** Entries are ordered by business day, then by the moment
 *    they were recorded, then by identifier. Replaying the same entries always
 *    produces the same series, whatever order they arrived in.
 *  - **Idempotence.** Offline clients resend. An entry whose idempotency key has
 *    already been applied is ignored rather than counted twice, so a retry
 *    storm cannot invent stock.
 */

/** One day of the replay. */
export interface LedgerDay {
  readonly on: DateOnly;
  /** Units on hand at the end of the day. */
  readonly onHand: number;
  /** Units dispensed to patients during the day. Transfers are not issues. */
  readonly issued: number;
}

export interface LedgerReplayOptions {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

export interface LedgerReplay {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /** One entry per day in the requested window, in ascending order. */
  readonly days: readonly LedgerDay[];
  /** On-hand at the end of the window. */
  readonly closingOnHand: number;
  readonly lastMovementOn: DateOnly | null;
  /** Entries ignored because their idempotency key had already been applied. */
  readonly duplicatesIgnored: number;
  /** Entries voided by a later correction. */
  readonly supersededEntries: number;
  /**
   * Movements that would have taken stock below zero and were floored.
   *
   * Non-zero means the ledger is incomplete — a missing receipt, or a facility
   * that dispensed from a batch it never recorded. Surfaced rather than hidden,
   * because a silent floor is how a data-quality problem becomes a wrong answer.
   */
  readonly entriesExceedingStock: number;
}

/**
 * Which entry kinds bring stock in.
 *
 * Typed as a total record rather than a switch so that adding a kind to the
 * union is a compile error here, instead of an entry that silently moves stock
 * in the wrong direction.
 */
const KIND_INCREASES: Readonly<Record<LedgerEntryKind, boolean>> = {
  receipt: true,
  transfer_in: true,
  issue: false,
  transfer_out: false,
  expiry: false,
  adjust: false,
};

/** The stock movement an entry represents. Positive means stock arrived. */
export function ledgerDelta(entry: StockLedgerEntry): number {
  // An adjustment is the one kind whose direction is not implied by the kind,
  // which is why the schema requires it to be stated explicitly.
  if (entry.kind === 'adjust') {
    return entry.adjustmentDirection === 'increase' ? entry.quantity : -entry.quantity;
  }
  return KIND_INCREASES[entry.kind] ? entry.quantity : -entry.quantity;
}

const byLedgerOrder = (left: StockLedgerEntry, right: StockLedgerEntry): number => {
  const byDay = compareDateOnly(left.occurredOn, right.occurredOn);
  if (byDay !== 0) {
    return byDay;
  }
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt < right.recordedAt ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export function replayStockLedger(
  entries: readonly StockLedgerEntry[],
  facilityId: FacilityId,
  itemId: ItemId,
  options: LedgerReplayOptions,
): LedgerReplay {
  const relevant = entries
    .filter((entry) => entry.facilityId === facilityId && entry.itemId === itemId)
    .sort(byLedgerOrder);

  const applied = new Set<string>();
  const surviving: StockLedgerEntry[] = [];
  let duplicatesIgnored = 0;

  for (const entry of relevant) {
    if (applied.has(entry.idempotencyKey)) {
      duplicatesIgnored += 1;
      continue;
    }
    applied.add(entry.idempotencyKey);
    surviving.push(entry);
  }

  const superseded = new Set(
    surviving
      .map((entry) => entry.correctsEntryId)
      .filter((id): id is string => id !== null),
  );

  let supersededEntries = 0;
  let entriesExceedingStock = 0;
  let lastMovementOn: DateOnly | null = null;

  const movementsByDay = new Map<DateOnly, StockLedgerEntry[]>();
  let openingOnHand = 0;

  for (const entry of surviving) {
    if (superseded.has(entry.id)) {
      supersededEntries += 1;
      continue;
    }

    if (compareDateOnly(entry.occurredOn, options.from) < 0) {
      // Movements before the window collapse into an opening balance. Summing
      // them is exact; only the floor at zero loses information.
      openingOnHand += ledgerDelta(entry);
      continue;
    }

    const bucket = movementsByDay.get(entry.occurredOn);
    if (bucket === undefined) {
      movementsByDay.set(entry.occurredOn, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  if (openingOnHand < 0) {
    entriesExceedingStock += 1;
    openingOnHand = 0;
  }

  let runningOnHand = openingOnHand;
  const days: LedgerDay[] = [];

  for (const day of eachDay(options.from, options.to)) {
    let delta = 0;
    let issued = 0;

    for (const entry of movementsByDay.get(day) ?? []) {
      delta += ledgerDelta(entry);
      if (entry.kind === 'issue') {
        issued += entry.quantity;
      }
    }

    if (delta !== 0 || issued !== 0) {
      lastMovementOn = day;
    }

    const next = runningOnHand + delta;
    if (next < 0) {
      // Stock cannot be negative, so the remainder is a ledger defect rather
      // than a position. Floor it and say so.
      entriesExceedingStock += 1;
      runningOnHand = 0;
    } else {
      runningOnHand = next;
    }

    days.push({ on: day, onHand: runningOnHand, issued });
  }

  return {
    facilityId,
    itemId,
    days,
    closingOnHand: runningOnHand,
    lastMovementOn,
    duplicatesIgnored,
    supersededEntries,
    entriesExceedingStock,
  };
}

/**
 * Units dispatched towards a facility that it has not yet received.
 *
 * Derived from both ends of every transfer rather than from one facility's
 * ledger, because a facility cannot see stock that is on a truck heading for
 * it. Counting it matters: dispatch that is invisible looks like a shortage
 * that has already been solved, and the facility orders again.
 */
export function deriveInTransit(
  entries: readonly StockLedgerEntry[],
  facilityId: FacilityId,
  itemId: ItemId,
): number {
  const received = new Set(
    entries
      .filter(
        (entry) =>
          entry.facilityId === facilityId &&
          entry.itemId === itemId &&
          entry.kind === 'transfer_in' &&
          entry.transferId !== null,
      )
      .map((entry) => entry.transferId),
  );

  return entries
    .filter(
      (entry) =>
        entry.kind === 'transfer_out' &&
        entry.itemId === itemId &&
        entry.counterpartFacilityId === facilityId &&
        entry.transferId !== null &&
        !received.has(entry.transferId),
    )
    .reduce((total, entry) => total + entry.quantity, 0);
}
