import { eachDay, replayStockLedger } from '@civora/domain';
import type { FacilityId, ItemId } from '@civora/domain';
import type { BacktestSeries } from '@civora/forecasting';

import type { Simulation } from './simulation';

/**
 * Turning the generated world into something a forecaster can be scored on.
 *
 * Two series come out of every facility-item pair, and the difference between
 * them is the point of the whole exercise:
 *
 *  - **What was recorded**, replayed from the ledger exactly as the platform
 *    would see it. During a stock-out this says zero, because nothing could be
 *    dispensed.
 *  - **What was wanted**, which only the generator knows. It is the recorded
 *    figure plus the demand the facility could not meet.
 *
 * Scoring against the first would reward a model for learning the shortage it
 * failed to prevent. Scoring against the second measures the thing the platform
 * is actually for — and the report states plainly that in a real deployment the
 * second does not exist.
 *
 * The allocation of unmet demand within a stock-out spell is an **assumption**:
 * the generator records a spell's total unmet units and its length, not its
 * day-by-day shape, so this spreads it evenly. The spell totals are exact; only
 * their distribution across the days is approximated. Phase 9 could record the
 * per-day figure instead if a real deployment needed it.
 */

const keyOf = (facilityId: string, itemId: string): string => `${facilityId}|${itemId}`;

export interface ScoredDataset {
  readonly entries: readonly BacktestSeries[];
  /** Facility-item pairs with enough history to score at all. */
  readonly pairs: number;
  /** Days on which demand went unmet anywhere in the dataset. */
  readonly unmetDays: number;
  readonly unitsWanted: number;
  readonly unitsDispensed: number;
}

export function buildScoredSeries(simulation: Simulation): ScoredDataset {
  const byPair = new Map<string, { facilityId: FacilityId; itemId: ItemId }>();
  for (const entry of simulation.ledgerEntries) {
    byPair.set(keyOf(entry.facilityId, entry.itemId), {
      facilityId: entry.facilityId,
      itemId: entry.itemId,
    });
  }

  const unmetByPair = new Map<string, Map<string, number>>();
  for (const shortfall of simulation.shortfalls) {
    const dayKey = keyOf(shortfall.facilityId, shortfall.itemId);
    const perDay = unmetByPair.get(dayKey) ?? new Map<string, number>();
    const share = shortfall.days === 0 ? 0 : shortfall.unmetUnits / shortfall.days;
    for (const day of eachDay(shortfall.from, shortfall.to)) {
      perDay.set(day, (perDay.get(day) ?? 0) + share);
    }
    unmetByPair.set(dayKey, perDay);
  }

  const window = { from: simulation.from, to: simulation.to };
  const entries: BacktestSeries[] = [];
  let unmetDays = 0;
  let unitsWanted = 0;
  let unitsDispensed = 0;

  for (const [key, pair] of [...byPair].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const replay = replayStockLedger(
      simulation.ledgerEntries,
      pair.facilityId,
      pair.itemId,
      window,
    );
    const unmet = unmetByPair.get(key);

    const latent = replay.days.map((day) => {
      const shortfall = unmet?.get(day.on) ?? 0;
      if (shortfall > 0) {
        unmetDays += 1;
      }
      unitsWanted += day.issued + shortfall;
      unitsDispensed += day.issued;
      return day.issued + shortfall;
    });

    entries.push({
      series: {
        facilityId: pair.facilityId,
        itemId: pair.itemId,
        points: replay.days.map((day) => ({
          on: day.on,
          issued: day.issued,
          onHand: day.onHand,
        })),
      },
      latent,
    });
  }

  return { entries, pairs: entries.length, unmetDays, unitsWanted, unitsDispensed };
}
