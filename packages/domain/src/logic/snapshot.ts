import { CivoraError } from '../errors';
import type { DateOnly, FacilityId, ItemId, Provenance } from '../model/common';
import { stockSnapshotSchema } from '../model/derived';
import type { StockSnapshot } from '../model/derived';
import type { StockLedgerEntry } from '../model/sensing';
import { countCensoredDays, detectCensoredIntervals } from './censoring';
import { addDays } from './dates';
import { daysOfStock, demandRateFromLedger, totalIssued } from './inventory';
import { deriveInTransit, replayStockLedger } from './ledger';

export interface SnapshotOptions {
  readonly asOf: DateOnly;
  /** Observation window, defaulting to 90 days. Must cover at least 30. */
  readonly windowDays?: number;
  readonly minimumDispenseLevel?: number;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

const DEFAULT_WINDOW_DAYS = 90;
const MINIMUM_WINDOW_DAYS = 30;

/**
 * Read a stock position out of the ledger.
 *
 * The snapshot is a view, never the record. It is derived — never assigned —
 * so a snapshot that disagrees with the ledger means the derivation is wrong,
 * and there is exactly one place to look.
 *
 * It has to be given the full entry list rather than one facility's, because
 * stock in transit only exists as a relationship between two facilities.
 */
export function deriveStockSnapshot(
  entries: readonly StockLedgerEntry[],
  facilityId: FacilityId,
  itemId: ItemId,
  options: SnapshotOptions,
): StockSnapshot {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (windowDays < MINIMUM_WINDOW_DAYS) {
    throw new CivoraError(
      `a snapshot window must cover at least ${String(MINIMUM_WINDOW_DAYS)} days, because the 30-day issue total is reported alongside the position; received ${String(windowDays)}`,
    );
  }

  const from = addDays(options.asOf, -(windowDays - 1));
  const replay = replayStockLedger(entries, facilityId, itemId, { from, to: options.asOf });

  const censoring = { minimumDispenseLevel: options.minimumDispenseLevel ?? 0 };
  const intervals = detectCensoredIntervals(replay.days, censoring);
  const demand = demandRateFromLedger(replay.days, censoring);

  return stockSnapshotSchema.parse({
    facilityId,
    itemId,
    asOf: options.asOf,
    onHand: replay.closingOnHand,
    inTransit: deriveInTransit(entries, facilityId, itemId),
    issuedLast30Days: totalIssued(replay.days.slice(-30)),
    demandRate: demand.rate,
    demandBasis: demand.basis,
    daysOfStock: daysOfStock(replay.closingOnHand, demand.rate),
    censoredDays: countCensoredDays(intervals),
    lastMovementOn: replay.lastMovementOn,
    synthetic: options.synthetic,
    provenance: options.provenance,
  });
}
