import { addDays } from '@civora/domain';
import type { DateOnly, FacilityId, ItemId } from '@civora/domain';
import { FACILITY_A, ITEM_PARACETAMOL, aReceipt } from '@civora/domain/testing';
import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY_OPTIONS, comparePolicies, pairsFromSimulation } from './policy';
import type { PlannedOrder, PolicyPair } from './policy';

/**
 * The counterfactual, held to the two things that make it worth publishing.
 *
 * First, that a replay driven by the world's own quantities reproduces the
 * world's own shortage. Without that check the two arms below could both be
 * measuring the replay, and the comparison would be decoration. Second, that the
 * platform's arm actually changes something and does not make matters worse —
 * with the correction entering through a censored history, which is the only
 * mechanism this project claims.
 */

const FROM = '2026-01-01';

const days = (count: number): DateOnly[] =>
  Array.from({ length: count }, (_, index) => addDays(FROM, index));

const repeat = (value: number, count: number): number[] =>
  Array.from({ length: count }, () => value);

const pairWith = (overrides: Partial<PolicyPair>): PolicyPair => {
  const window = days(20);
  return {
    facilityId: FACILITY_A,
    itemId: ITEM_PARACETAMOL,
    openingOnHand: 0,
    leadTimeDays: 8,
    orders: [] as PlannedOrder[],
    days: window,
    latent: repeat(10, window.length),
    recorded: repeat(10, window.length),
    onHandHistory: repeat(0, window.length),
    actualShortDays: 0,
    actualUnmetUnits: 0,
    ...overrides,
  };
};

describe('replaying the world against itself', () => {
  it('reproduces the world’s own short days when driven by the world’s own quantities', () => {
    // No stock, nothing ordered, ten wanted a day for ten days: the replay must
    // find exactly the ten short days the world recorded, and say so.
    const window = days(10);
    const dry = pairWith({
      days: window,
      latent: repeat(10, window.length),
      recorded: repeat(0, window.length),
      actualShortDays: 10,
      actualUnmetUnits: 100,
    });

    const comparison = comparePolicies([dry]);

    expect(comparison.baseline.unsuppliedDays).toBe(10);
    expect(comparison.baseline.unmetUnits).toBe(100);
    expect(comparison.fidelity).toBe(1);
    expect(comparison.ordersResized).toBe(0);
  });

  it('says the replay is measuring something else when it cannot reproduce the world', () => {
    // The same pair with the world claiming a hundred short days it did not
    // have. Fidelity is a comparison and not a constant, so it has to fall.
    const window = days(10);
    const wrong = pairWith({
      days: window,
      recorded: repeat(0, window.length),
      actualShortDays: 100,
    });

    expect(comparePolicies([wrong]).fidelity).toBeLessThan(0.95);
  });
});

describe('the platform’s arm against the facility’s own ordering', () => {
  /**
   * A censored history, an order placed inside the stock-out, and one placed
   * before it. The facility's rule reads the dry fortnight as a fall in demand
   * and orders less; the platform reads the same days as unmet need.
   */
  const censoredPair = (): PolicyPair => {
    const window = days(90);
    const dryStart = 20;
    const dryDays = 20;

    return pairWith({
      days: window,
      latent: repeat(10, window.length),
      recorded: window.map((_, index) =>
        index >= dryStart && index < dryStart + dryDays ? 0 : 10,
      ),
      onHandHistory: window.map((_, index) =>
        index >= dryStart && index < dryStart + dryDays ? 0 : 500,
      ),
      orders: [
        { placedOn: addDays(FROM, 1), arrivesOn: addDays(FROM, 9), quantity: 120 },
        { placedOn: addDays(FROM, 30), arrivesOn: addDays(FROM, 38), quantity: 10 },
      ],
      actualShortDays: dryDays,
      actualUnmetUnits: dryDays * 10,
    });
  };

  it('orders more from a censored history and gives out at least as much', () => {
    const comparison = comparePolicies([censoredPair()]);

    // The mechanism, asserted directly: the platform resized the order the
    // facility placed while it could not see its own demand.
    expect(comparison.ordersResized).toBeGreaterThan(0);
    expect(comparison.platform.dispensedUnits).toBeGreaterThanOrEqual(
      comparison.baseline.dispensedUnits,
    );
    expect(comparison.platform.unsuppliedDays).toBeLessThanOrEqual(
      comparison.baseline.unsuppliedDays,
    );
    expect(comparison.platform.fillRate).toBeGreaterThanOrEqual(comparison.baseline.fillRate);
    expect(comparison.platform.unmetUnits).toBeLessThanOrEqual(comparison.baseline.unmetUnits);
  });

  it('carries the units of the comparison so a rate is readable', () => {
    const comparison = comparePolicies([censoredPair()]);

    // Both arms see the same demand and the same days; only the shelf differs.
    expect(comparison.platform.demandedUnits).toBe(comparison.baseline.demandedUnits);
    expect(comparison.pairDays).toBe(90);
    expect(comparison.platform.fillRate).toBeLessThanOrEqual(1);
    expect(comparison.platform.shortageRatePerThousandDays).toBeGreaterThanOrEqual(0);
  });

  it('answers on a sample and reports how big the sample was', () => {
    const pairs = Array.from({ length: 5 }, () => censoredPair());

    const comparison = comparePolicies(pairs, { ...DEFAULT_POLICY_OPTIONS, maxPairs: 2 });

    expect(comparison.pairs).toBe(2);
    expect(comparison.pairsAvailable).toBe(5);
    // The cap is on the replay, not on the sample: the pair-days below count only
    // what was actually replayed.
    expect(comparison.pairDays).toBe(180);
  });
});

type Simulation = Parameters<typeof pairsFromSimulation>[0];

/** The parts of a generated world a replay reads, with nothing else filled in. */
const worldWith = (
  entries: readonly ReturnType<typeof aReceipt>[],
  orders: readonly {
    facilityId: FacilityId;
    itemId: ItemId;
    placedOn: DateOnly;
    receivedOn: DateOnly | null;
    quantity: number;
  }[],
): Simulation =>
  ({
    from: FROM,
    to: addDays(FROM, 10),
    ledgerEntries: entries,
    orders,
    shortfalls: [],
  }) as unknown as Simulation;

describe('assembling a replay from the generated world', () => {
  it('skips a pair that never placed an order, because there is nothing to resize', () => {
    const world = worldWith([aReceipt({ quantity: 50 })], []);

    expect(pairsFromSimulation(world)).toEqual([]);
  });

  it('takes the lead time from the deliveries the world actually made', () => {
    const world = worldWith(
      [aReceipt({ quantity: 50, occurredOn: addDays(FROM, 8) })],
      [
        {
          facilityId: FACILITY_A,
          itemId: ITEM_PARACETAMOL,
          placedOn: FROM,
          receivedOn: addDays(FROM, 8),
          quantity: 50,
        },
      ],
    );

    const pairs = pairsFromSimulation(world);

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.leadTimeDays).toBe(8);
    expect(pairs[0]?.orders).toHaveLength(1);
    // The window is the replayed ledger's own days, not the orders' span.
    expect(pairs[0]?.days).toHaveLength(11);
    expect(pairs[0]?.latent).toHaveLength(11);
  });
});
