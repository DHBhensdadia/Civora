import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import type { CareLevel, DateOnly, FacilityTier, ItemId, StorageClass } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  COLD_CHAIN_RELIABILITY_FLOOR,
  FIXED_HANDLING_DAYS,
  MAX_LEAD_TIME_DAYS,
  MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
  buildTransferGraph,
  careLevelOf,
  feasibilityOf,
  greatCircleKm,
  leadTimeDaysFor,
  minimumCareLevel,
} from './feasibility';
import type { FeasibilityOptions, StockLot, TransferItem, TransferNode } from './feasibility';

/**
 * What the graph is allowed to admit.
 *
 * The graph decides which transfers exist, so everything downstream — the
 * priority pass, the local improvement, the validator, the number a pharmacist
 * is asked to act on — inherits its mistakes. The rules are therefore asserted
 * one at a time, each against a pair that fails that rule and nothing else, so a
 * rule that starts refusing for the wrong reason cannot hide behind another.
 *
 * The generated-state test at the bottom is the beginning of the phase's
 * blocking evidence. It does not yet prove the donor floor — that is a property
 * of a *plan*, and plans arrive with the solver — but it does hold every
 * property a graph can have on its own, across states nobody hand-picked.
 */

/** The day the graph is built for, and the day shelf life is measured from. */
const AS_OF: DateOnly = '2026-09-24';

const OPTIONS: FeasibilityOptions = { asOf: AS_OF };

const id = (value: string): ReturnType<typeof facilityIdSchema.parse> =>
  facilityIdSchema.parse(value);

const itemId = (value: string): ItemId => itemIdSchema.parse(value);

const aNode = (input: {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly tier?: FacilityTier;
  readonly coldChain?: boolean;
  readonly reliability?: number;
}): TransferNode => ({
  facilityId: id(input.id),
  tier: input.tier ?? 'PHC',
  coordinates: { latitude: input.latitude, longitude: input.longitude },
  coldChain: { available: input.coldChain ?? false, reliability: input.reliability ?? 1 },
});

const anItem = (overrides: Partial<TransferItem> = {}): TransferItem => ({
  itemId: itemId('item-paracetamol'),
  genericName: 'Paracetamol',
  storage: 'ambient',
  coldChain: false,
  careLevels: ['primary'],
  ...overrides,
});

const aLot = (overrides: Partial<StockLot> = {}): StockLot => ({
  facilityId: id('fac-a'),
  itemId: itemId('item-paracetamol'),
  batchId: 'B-1',
  quantity: 100,
  expiresOn: '2027-06-30',
  ...overrides,
});

/** A pair about 45 km apart: two days' lead time, comfortably inside the window. */
const NEAR_DONOR = aNode({ id: 'fac-a', latitude: 20, longitude: 85 });
const NEAR_RECEIVER = aNode({ id: 'fac-b', latitude: 20.4, longitude: 85 });

/**
 * One candidate's verdict, with the near pair filled in unless a test names an
 * absent node on purpose — which is why the defaults key off whether the field
 * was *passed*, not off whether its value is undefined.
 */
const verdictFor = (input: {
  readonly donor?: TransferNode | undefined;
  readonly receiver?: TransferNode | undefined;
  readonly item?: TransferItem | undefined;
  readonly lot?: StockLot;
  readonly options?: FeasibilityOptions;
}) => {
  const lot = input.lot ?? aLot();
  const receiver = input.receiver ?? NEAR_RECEIVER;

  return feasibilityOf({
    candidate: { ...lot, receiverId: receiver.facilityId },
    donor: 'donor' in input ? input.donor : NEAR_DONOR,
    receiver: 'receiver' in input ? input.receiver : NEAR_RECEIVER,
    item: 'item' in input ? input.item : anItem(),
    options: input.options ?? OPTIONS,
  });
};

describe('geometry and time', () => {
  it('measures a great-circle distance, symmetrically', () => {
    expect(greatCircleKm({ latitude: 20, longitude: 85 }, { latitude: 20, longitude: 85 })).toBe(0);

    // A degree of latitude is about 111 km anywhere; the round trip must agree.
    const north = greatCircleKm({ latitude: 20, longitude: 85 }, { latitude: 21, longitude: 85 });
    expect(north).toBeGreaterThan(110);
    expect(north).toBeLessThan(112.5);

    const there = greatCircleKm({ latitude: 20, longitude: 85 }, { latitude: 24, longitude: 89 });
    const back = greatCircleKm({ latitude: 24, longitude: 89 }, { latitude: 20, longitude: 85 });
    expect(there).toBe(back);
  });

  it('charges handling plus whole days of travel, and never a fraction of one', () => {
    expect(leadTimeDaysFor(0, OPTIONS)).toBe(FIXED_HANDLING_DAYS);
    expect(leadTimeDaysFor(150, OPTIONS)).toBe(FIXED_HANDLING_DAYS + 1);
    // A kilometre past the day's travel costs a whole further day, which is the
    // conservative reading: a vehicle that arrives at midnight is not available.
    expect(leadTimeDaysFor(151, OPTIONS)).toBe(FIXED_HANDLING_DAYS + 2);
    expect(leadTimeDaysFor(600, OPTIONS)).toBe(MAX_LEAD_TIME_DAYS);
    expect(leadTimeDaysFor(601, OPTIONS)).toBe(MAX_LEAD_TIME_DAYS + 1);
  });

  it('takes the level of care a facility provides from its tier', () => {
    expect(careLevelOf('SHC')).toBe('primary');
    expect(careLevelOf('AAM')).toBe('primary');
    expect(careLevelOf('PHC')).toBe('primary');
    expect(careLevelOf('CHC')).toBe('secondary');
  });

  it('reads an item’s own level as the lowest the national list marks it for', () => {
    expect(minimumCareLevel(anItem({ careLevels: ['primary', 'secondary', 'tertiary'] }))).toBe(
      'primary',
    );
    expect(minimumCareLevel(anItem({ careLevels: ['secondary', 'tertiary'] }))).toBe('secondary');
    expect(minimumCareLevel(anItem({ careLevels: ['tertiary'] }))).toBe('tertiary');
  });
});

describe('one candidate, checked against every rule', () => {
  it('admits a transfer that is possible, and says nothing about preference', () => {
    const verdict = verdictFor({});
    expect(verdict.feasible).toBe(true);
    expect(verdict.refusals).toEqual([]);
  });

  it('refuses a cold-chain item where an endpoint has no working chain, and names it', () => {
    const coldItem = anItem({ coldChain: true, storage: 'cold-chain' as StorageClass });

    // Both endpoints are checked, and each gets its own sentence: on a pair with
    // no working chain at either end, "the chain is broken" is not an answer an
    // officer can act on, and naming both ends is.
    const neitherEnd = verdictFor({ item: coldItem });
    expect(neitherEnd.feasible).toBe(false);
    expect(neitherEnd.refusals.map((each) => each.rule)).toEqual([
      'cold-chain-capability',
      'cold-chain-capability',
    ]);
    expect(neitherEnd.refusals[0]?.detail).toContain('fac-a');
    expect(neitherEnd.refusals[1]?.detail).toContain('fac-b');

    const atDonor = verdictFor({
      item: coldItem,
      donor: aNode({ id: 'fac-a', latitude: 20, longitude: 85, coldChain: true }),
      receiver: aNode({ id: 'fac-b', latitude: 20.4, longitude: 85, coldChain: true }),
    });
    expect(atDonor.feasible).toBe(true);

    const unreliableDonor = verdictFor({
      item: coldItem,
      donor: aNode({
        id: 'fac-a',
        latitude: 20,
        longitude: 85,
        coldChain: true,
        reliability: COLD_CHAIN_RELIABILITY_FLOOR - 0.1,
      }),
      receiver: aNode({ id: 'fac-b', latitude: 20.4, longitude: 85, coldChain: true }),
    });
    expect(unreliableDonor.refusals.map((each) => each.rule)).toEqual(['cold-chain-reliability']);
    // The detail carries the measured rate and the floor, not just a verdict.
    expect(unreliableDonor.refusals[0]?.detail).toContain('70%');
    expect(unreliableDonor.refusals[0]?.detail).toContain('80%');
  });

  it('does not refuse an ambient item for a facility with no refrigerator', () => {
    // The rule is about the item, not the facility: an ambient item at a
    // facility with no cold chain is ordinary, and refusing it would empty the
    // graph of most of the catalogue.
    expect(verdictFor({ item: anItem() }).feasible).toBe(true);
  });

  it('refuses an item listed only for a level of care the receiver is not', () => {
    const secondaryItem = anItem({ careLevels: ['secondary', 'tertiary'] });
    const toPhc = verdictFor({ item: secondaryItem });
    expect(toPhc.refusals.map((each) => each.rule)).toEqual(['care-level']);
    expect(toPhc.refusals[0]?.detail).toContain('secondary care');

    // The same item to a community health centre is ordinary practice.
    expect(
      verdictFor({
        item: secondaryItem,
        receiver: aNode({ id: 'fac-b', latitude: 20.4, longitude: 85, tier: 'CHC' }),
      }).feasible,
    ).toBe(true);
  });

  it('refuses a pair whose travel outruns the replenishment window', () => {
    const far = verdictFor({
      receiver: aNode({ id: 'fac-far', latitude: 30, longitude: 85 }),
    });
    expect(far.refusals.map((each) => each.rule)).toEqual(['lead-time']);
    expect(far.refusals[0]?.detail).toContain('day');
    expect(far.refusals[0]?.detail).toContain(`${String(MAX_LEAD_TIME_DAYS)}-day window`);
  });

  it('refuses a batch that would land too close to its expiry', () => {
    const soon = verdictFor({ lot: aLot({ expiresOn: '2026-10-20' }) });
    expect(soon.refusals.map((each) => each.rule)).toEqual(['shelf-life']);
    expect(soon.refusals[0]?.detail).toContain('2026-10-20');

    // Already expired is the same rule, not a special case that slips past it.
    const expired = verdictFor({ lot: aLot({ expiresOn: '2026-09-01' }) });
    expect(expired.refusals.map((each) => each.rule)).toEqual(['shelf-life']);
  });

  it('refuses a candidate it cannot place, rather than dropping it quietly', () => {
    const unplaced = verdictFor({ donor: undefined });
    expect(unplaced.feasible).toBe(false);
    expect(unplaced.refusals[0]?.rule).toBe('unknown-facility');
    expect(unplaced.refusals[0]?.detail).toContain('fac-a');

    // A missing item profile is its own rule, not a missing facility: the two
    // are fixed in different places, and a count that merges them sends somebody
    // looking through the network for a facility they will not find.
    const unknownItem = verdictFor({
      item: undefined,
      lot: aLot({ itemId: itemId('item-not-in-catalogue') }),
    });
    expect(unknownItem.refusals[0]?.rule).toBe('unknown-item');
    expect(unknownItem.refusals[0]?.detail).toContain('item-not-in-catalogue');
  });

  it('reports everything wrong at once, so a person fixes it in one pass', () => {
    const verdict = verdictFor({
      item: anItem({ coldChain: true, storage: 'cold-chain', careLevels: ['tertiary'] }),
      receiver: aNode({ id: 'fac-far', latitude: 30, longitude: 85 }),
    });
    expect(verdict.feasible).toBe(false);
    expect(verdict.refusals.map((each) => each.rule)).toEqual([
      'cold-chain-capability',
      'cold-chain-capability',
      'care-level',
      'lead-time',
    ]);
  });

  it('measures shelf life on arrival from the day the graph is built', () => {
    // Three days of travel plus a day of handling is four, so a batch expiring in
    // twenty-eight days arrives with twenty-five — under the floor, and refused.
    const verdict = verdictFor({
      receiver: aNode({ id: 'fac-b', latitude: 21.9, longitude: 85 }),
      lot: aLot({ expiresOn: '2026-10-22' }),
    });
    expect(verdict.refusals.map((each) => each.rule)).toEqual(['shelf-life']);
    expect(verdict.refusals[0]?.detail).toContain('25 days');
  });
});

describe('the transfer graph', () => {
  const network = {
    nodes: [NEAR_DONOR, NEAR_RECEIVER, aNode({ id: 'fac-c', latitude: 20.8, longitude: 85 })],
    items: [anItem()],
  };

  it('holds one edge per feasible pair, and no self-edges', () => {
    const graph = buildTransferGraph({
      ...network,
      lots: [aLot()],
      options: OPTIONS,
    });

    expect(graph.edges.map((edge) => [edge.donorId, edge.receiverId])).toEqual([
      ['fac-a', 'fac-b'],
      ['fac-a', 'fac-c'],
    ]);
    // Every edge carries what decided it, so a proposal can be explained.
    for (const edge of graph.edges) {
      expect(edge.quantity).toBe(100);
      expect(edge.distanceKm).toBeGreaterThan(0);
      expect(edge.leadTimeDays).toBeGreaterThanOrEqual(FIXED_HANDLING_DAYS);
      expect(edge.shelfLifeOnArrivalDays).toBeGreaterThanOrEqual(
        MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
      );
      expect(edge.expiresOn).toBe('2027-06-30');
    }
  });

  it('counts what each rule removed, so a thin graph is explainable', () => {
    const graph = buildTransferGraph({
      nodes: [...network.nodes, aNode({ id: 'fac-far', latitude: 31, longitude: 85 })],
      items: [
        anItem(),
        anItem({
          itemId: itemId('item-vaccine'),
          genericName: 'Vaccine',
          coldChain: true,
          storage: 'cold-chain',
        }),
      ],
      lots: [aLot(), aLot({ itemId: itemId('item-vaccine'), batchId: 'B-2' })],
      options: OPTIONS,
    });

    // The cold-chain lot cannot go to any of the three ambient facilities.
    expect(graph.removedByRule['cold-chain-capability']).toBe(3);
    // The ambient lot cannot reach the distant facility in time.
    expect(graph.removedByRule['lead-time']).toBe(1);
    // The four cold-chain-capable pairs... except there are none, so no shelf-life.
    expect(graph.removedByRule['shelf-life']).toBe(0);
    expect(graph.edges.every((edge) => edge.itemId === 'item-paracetamol')).toBe(true);

    const total = Object.values(graph.removedByRule).reduce((sum, count) => sum + count, 0);
    // Every candidate is either an edge or exactly one removal.
    const candidates = 2 * (network.nodes.length + 1 - 1);
    expect(graph.edges.length + total).toBe(candidates);
  });

  it('leaves an empty lot out of the count entirely, because it is not a candidate', () => {
    const graph = buildTransferGraph({
      ...network,
      lots: [aLot({ quantity: 0 })],
      options: OPTIONS,
    });
    expect(graph.edges).toEqual([]);
    expect(Object.values(graph.removedByRule).every((count) => count === 0)).toBe(true);
  });

  it('records a lot it cannot place rather than assuming a position for it', () => {
    const graph = buildTransferGraph({
      nodes: network.nodes,
      items: [],
      lots: [aLot()],
      options: OPTIONS,
    });
    expect(graph.edges).toEqual([]);
    expect(graph.unknownItems).toEqual(['item-paracetamol']);
    expect(graph.removedByRule['unknown-item']).toBe(2);
    expect(graph.removedByRule['unknown-facility']).toBe(0);
  });

  it('names the assumptions it was built with, so a report can print them', () => {
    const graph = buildTransferGraph({ ...network, lots: [aLot()], options: OPTIONS });
    expect(graph.assumptions).toEqual({
      roadKmPerDay: 150,
      fixedHandlingDays: FIXED_HANDLING_DAYS,
      maxLeadTimeDays: MAX_LEAD_TIME_DAYS,
      minimumShelfLifeOnArrivalDays: MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
      coldChainReliabilityFloor: COLD_CHAIN_RELIABILITY_FLOOR,
    });
  });

  it('produces the same graph whatever order its inputs arrive in', () => {
    const forward = buildTransferGraph({ ...network, lots: [aLot()], options: OPTIONS });
    const reversed = buildTransferGraph({
      nodes: [...network.nodes].reverse(),
      items: [...network.items].reverse(),
      lots: [aLot()],
      options: OPTIONS,
    });

    expect(reversed).toEqual(forward);
    // And a second call in the same process is byte-identical, which is what the
    // audit trail behind a proposal rests on.
    expect(buildTransferGraph({ ...network, lots: [aLot()], options: OPTIONS })).toEqual(forward);
  });
});

describe('across generated states', () => {
  /** A deterministic generator, so a failure can be reproduced from the seed. */
  const draw = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const TIERS: readonly FacilityTier[] = ['SHC', 'AAM', 'PHC', 'CHC'];
  const STORAGE: readonly StorageClass[] = ['ambient', 'cool', 'cold-chain'];
  const CARE_LEVELS: readonly CareLevel[] = ['primary', 'secondary', 'tertiary'];

  it('admits no edge that a rule should have refused', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = draw(seed);
      const nodes: TransferNode[] = Array.from({ length: 12 }, (_unused, index) =>
        aNode({
          id: `fac-${String(index)}`,
          latitude: 8 + next() * 27,
          longitude: 68 + next() * 29,
          tier: TIERS[Math.floor(next() * TIERS.length)] ?? 'PHC',
          coldChain: next() < 0.5,
          reliability: next(),
        }),
      );
      const items: TransferItem[] = Array.from({ length: 6 }, (_unused, index) => {
        const coldChain = next() < 0.4;
        const level = CARE_LEVELS[Math.floor(next() * CARE_LEVELS.length)] ?? 'primary';
        return anItem({
          itemId: itemId(`item-${String(index)}`),
          storage: coldChain ? 'cold-chain' : (STORAGE[Math.floor(next() * 2)] ?? 'ambient'),
          coldChain,
          careLevels: [level],
        });
      });
      const lots: StockLot[] = Array.from({ length: 10 }, (_unused, index) =>
        aLot({
          facilityId: id(`fac-${String(Math.floor(next() * nodes.length))}`),
          itemId: itemId(`item-${String(Math.floor(next() * items.length))}`),
          batchId: `B-${String(index)}`,
          quantity: Math.floor(next() * 500),
          expiresOn: `202${String(6 + Math.floor(next() * 2))}-${String(1 + Math.floor(next() * 12)).padStart(2, '0')}-15`,
        }),
      );

      const options: FeasibilityOptions = { asOf: AS_OF };
      const graph = buildTransferGraph({ nodes, items, lots, options });
      const byId = new Map(nodes.map((node) => [node.facilityId, node]));
      const itemById = new Map(items.map((item) => [item.itemId, item]));

      const seen = new Set<string>();
      for (const edge of graph.edges) {
        const donor = byId.get(edge.donorId);
        const receiver = byId.get(edge.receiverId);
        const item = itemById.get(edge.itemId);
        expect(donor).toBeDefined();
        expect(receiver).toBeDefined();
        expect(item).toBeDefined();

        // The properties the graph exists to hold.
        expect(edge.donorId).not.toBe(edge.receiverId);
        expect(edge.leadTimeDays).toBeLessThanOrEqual(MAX_LEAD_TIME_DAYS);
        expect(edge.shelfLifeOnArrivalDays).toBeGreaterThanOrEqual(
          MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
        );
        if (item?.coldChain === true) {
          expect(donor?.coldChain.available).toBe(true);
          expect(receiver?.coldChain.available).toBe(true);
          expect(donor?.coldChain.reliability).toBeGreaterThanOrEqual(COLD_CHAIN_RELIABILITY_FLOOR);
          expect(receiver?.coldChain.reliability).toBeGreaterThanOrEqual(
            COLD_CHAIN_RELIABILITY_FLOOR,
          );
        }
        if (item !== undefined && receiver !== undefined) {
          // Admissible, not equal: a community health centre may hold the
          // primary-care items it also dispenses, and the rule is the order.
          const lowest = minimumCareLevel(item);
          expect(lowest === 'primary' || careLevelOf(receiver.tier) === 'secondary').toBe(true);
        }

        const key = `${edge.donorId}|${edge.receiverId}|${edge.itemId}|${edge.batchId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }

      // And building it twice cannot disagree with itself.
      expect(buildTransferGraph({ nodes, items, lots, options })).toEqual(graph);
    }
  });
});
