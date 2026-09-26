import { ledgerDelta } from '@civora/domain';
import type {
  DateOnly,
  FacilityId,
  Item,
  ItemId,
  LedgerService,
  StockLedgerEntry,
} from '@civora/domain';
import { planRedistribution } from '@civora/optimizer';
import type {
  PairPosition,
  RedistributionFacility,
  RedistributionItem,
  RedistributionPlan,
  ScoredPair,
  StockLot,
} from '@civora/optimizer';

import { scorePopulation } from './intelligence';
import type { ScoredPopulation } from './intelligence';
import type { Network } from './network';
import type { Simulation } from './simulation';

/**
 * The redistribution pipeline over a generated world.
 *
 * This is the gather: everything the optimiser reads, derived from one dataset
 * in one place, so the workbench the demonstration opens and the batch command
 * that refreshes it cannot disagree about the same world. `planRedistribution`
 * itself is `@civora/optimizer`'s and stays pure; what lives here is the
 * plumbing around it — the scoring options the plan's needs are ranked from, the
 * lots the ledger holds, the positions the projection reports, and the mapping
 * into the optimiser's own vocabulary.
 *
 * The precedent is `intelligence.ts` beside it: the surge, forecast, score and
 * alert pipeline lives in this package for the same reason — a batch job and a
 * surface running the same computation must call the same function, not two
 * copies of it.
 */

/**
 * The scoring options the redistribution pipeline reads.
 *
 * Fewer bootstrap replications than the batch job uses, because this runs inside
 * a request and only the upper quantile is read — and the number travels on
 * every forecast's own features, so nothing here claims the batch's precision
 * for a lighter computation. Shared rather than restated at each call site, so a
 * plan built by the surface and a plan built by the command are built from the
 * same scored population, term for term.
 */
export const REDISTRIBUTION_SCORING = {
  horizonDays: 14,
  seedPrefix: 'intelligence',
  bootstrapReplications: 60,
} as const;

/** The scored population the redistribution plan is built from. */
export function scoredPopulationFor(simulation: Simulation, network: Network): ScoredPopulation {
  return scorePopulation(simulation, network, REDISTRIBUTION_SCORING);
}

/**
 * Every batch the ledger still holds stock in, at the day the plan is made for.
 *
 * Two things are easy to get wrong and both matter: an **outgoing** movement
 * states its batch but not an expiry (the schema only requires an expiry where
 * stock arrives), so a reader that skipped entries without an expiry would never
 * draw a batch down; and the expiry belongs to whichever entry first states it,
 * not to every entry. A batch whose remaining quantity has fallen to zero, or
 * whose expiry the ledger never stated anywhere, is left out — the graph can
 * only refuse a lot it was told about, and inventing one would be inventing
 * stock.
 */
export function lotsFrom(entries: readonly StockLedgerEntry[]): readonly StockLot[] {
  interface Held {
    readonly facilityId: FacilityId;
    readonly itemId: ItemId;
    readonly batchId: string;
    quantity: number;
    expiresOn: DateOnly | null;
  }

  const byKey = new Map<string, Held>();

  for (const entry of entries) {
    if (entry.batchId === null) {
      continue;
    }
    const key = `${entry.facilityId}|${entry.itemId}|${entry.batchId}`;
    const held = byKey.get(key) ?? {
      facilityId: entry.facilityId,
      itemId: entry.itemId,
      batchId: entry.batchId,
      quantity: 0,
      expiresOn: null,
    };
    held.quantity = Math.max(0, held.quantity + ledgerDelta(entry));
    // The expiry may arrive on any entry of the batch, and an issue carries none.
    held.expiresOn ??= entry.expiresOn;
    byKey.set(key, held);
  }

  // The predicate narrows the type, so the mapping below reads `expiresOn` as a
  // date: a lot without one is not a lot this platform promises to move.
  const live = [...byKey.values()].filter(
    (lot): lot is Held & { readonly expiresOn: DateOnly } =>
      lot.quantity > 0 && lot.expiresOn !== null,
  );

  return live
    .sort((left, right) => {
      const leftKey = `${left.facilityId}|${left.itemId}|${left.batchId}`;
      const rightKey = `${right.facilityId}|${right.itemId}|${right.batchId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((lot) => ({
      facilityId: lot.facilityId,
      itemId: lot.itemId,
      batchId: lot.batchId,
      quantity: lot.quantity,
      expiresOn: lot.expiresOn,
    }));
}

/**
 * What the platform's own projection says each pair holds.
 *
 * Read from the projection rather than summed here, so the position a plan is
 * built from is the position the visibility surface shows — including stock
 * already on its way, which the need calculation counts and the impact
 * projection deliberately does not.
 */
export function positionsFrom(
  ledger: LedgerService,
  facilitiesWithHistory: readonly FacilityId[],
): readonly PairPosition[] {
  const positions: PairPosition[] = [];

  for (const facilityId of facilitiesWithHistory) {
    const reading = ledger.readingFor(facilityId);
    for (const item of reading.stock?.items ?? []) {
      positions.push({
        facilityId,
        itemId: item.itemId,
        onHand: item.onHand,
        inTransit: item.inTransit,
      });
    }
  }

  return positions;
}

/**
 * The world one run of the pipeline is made from.
 *
 * Everything the plan reads, supplied explicitly, so the same function serves
 * the surface (which wires it to the process's live store), a batch command
 * (which wires it to a dataset of its own) and a test. No clock and no store are
 * touched: `asOf` is the day the world's own history ends.
 */
export interface PlanWorld {
  readonly network: Network;
  readonly simulation: Simulation;
  readonly catalogue: readonly Item[];
  readonly ledger: LedgerService;
  readonly facilitiesWithHistory: readonly FacilityId[];
  readonly scored: readonly ScoredPair[];
}

/** Run the whole redistribution pipeline over one dataset. */
export async function planWorld(world: PlanWorld): Promise<RedistributionPlan> {
  const { network, simulation } = world;

  const facilities: readonly RedistributionFacility[] = network.facilities.map((facility) => ({
    facilityId: facility.id,
    tier: facility.tier,
    coordinates: facility.coordinates,
    coldChain: facility.coldChain,
    catchmentPopulation: facility.catchmentPopulation,
  }));
  const items: readonly RedistributionItem[] = world.catalogue.map((item) => ({
    itemId: item.id,
    genericName: item.genericName,
    storage: item.storage,
    coldChain: item.coldChain,
    careLevels: item.careLevels,
    essentiality: item.essentiality,
  }));

  return await planRedistribution({
    asOf: simulation.to,
    facilities,
    items,
    lots: lotsFrom(simulation.ledgerEntries),
    positions: positionsFrom(world.ledger, world.facilitiesWithHistory),
    scored: world.scored,
  });
}
