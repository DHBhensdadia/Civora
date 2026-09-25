import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import type { EssentialityTier, FacilityId, ItemId } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { MAX_LEAD_TIME_DAYS } from './feasibility';
import {
  CRITICALITY_WEIGHTS,
  EXPIRY_PRESSURE_HORIZON_DAYS,
  EXPIRY_PRESSURE_MAX,
  SAFETY_COVER_BUFFER_DAYS,
  donorPriorityOf,
  expiryPressureOf,
  rankDonors,
  rankReceivers,
  receiverPriorityOf,
  safetyStockFor,
} from './priorities';
import type { DonorPriority, ReceiverPriority } from './priorities';

/**
 * What the two ranking functions are allowed to prefer.
 *
 * A ranking is an argument made in arithmetic, so the tests here are about
 * whether the argument is the one written down: each term moves the score the
 * way it claims to, a term nobody measured produces a refusal rather than a low
 * score, and two runs over the same positions produce the same order. The
 * property test at the end is the one that matters most, though — across
 * generated positions, nothing the platform cannot measure is ever treated as
 * spare stock.
 */

const facility = (value: string): FacilityId => facilityIdSchema.parse(value);
const item = (value: string): ItemId => itemIdSchema.parse(value);

const aReceiver = (overrides: Partial<Parameters<typeof receiverPriorityOf>[0]> = {}) =>
  receiverPriorityOf({
    facilityId: facility('fac-a'),
    itemId: item('item-paracetamol'),
    shortfallProbability: 0.5,
    essentiality: 'essential',
    populationAtRisk: 10_000,
    ...overrides,
  });

const aDonor = (overrides: Partial<Parameters<typeof donorPriorityOf>[0]> = {}) =>
  donorPriorityOf({
    facilityId: facility('fac-a'),
    itemId: item('item-paracetamol'),
    onHand: 500,
    dailyDemand: 10,
    earliestExpiryDays: null,
    ...overrides,
  });

describe('the donor safety floor', () => {
  it('keeps its own demand over the replenishment window plus a week of slippage', () => {
    expect(safetyStockFor({ dailyDemand: 10 })).toBe(
      10 * (MAX_LEAD_TIME_DAYS + SAFETY_COVER_BUFFER_DAYS),
    );
    expect(safetyStockFor({ dailyDemand: 10, leadTimeDays: 3 })).toBe(
      10 * (3 + SAFETY_COVER_BUFFER_DAYS),
    );
    // A fractional rate rounds up: half a tablet is not a floor anybody can keep.
    expect(safetyStockFor({ dailyDemand: 0.5, leadTimeDays: 0 })).toBe(4);
  });

  it('is zero for zero demand and unknown for unmeasurable demand', () => {
    expect(safetyStockFor({ dailyDemand: 0 })).toBe(0);
    expect(safetyStockFor({ dailyDemand: null })).toBeNull();
  });
});

describe('ranking a receiver', () => {
  it('multiplies the measured probability, the criticality and the people exposed', () => {
    const position = aReceiver({ shortfallProbability: 0.5 });
    expect(position.priority).toBeCloseTo(0.5 * CRITICALITY_WEIGHTS.essential * 10_000, 9);
    expect(position.basis).toBe('measured');
  });

  it('moves with each term and with nothing else', () => {
    const base = aReceiver();
    const likelier = aReceiver({ shortfallProbability: 0.9 });
    const moreCritical = aReceiver({ essentiality: 'supplementary' });
    const morePeople = aReceiver({ populationAtRisk: 100_000 });

    expect(likelier.priority ?? 0).toBeGreaterThan(base.priority ?? 0);
    expect(moreCritical.priority ?? 0).toBeLessThan(base.priority ?? 0);
    expect(morePeople.priority ?? 0).toBeGreaterThan(base.priority ?? 0);
    // Two positions differing only in identity score the same.
    expect(aReceiver({ facilityId: facility('fac-zz') }).priority).toBe(base.priority);
  });

  it('reports an unforecast pair as unmeasured rather than as calm', () => {
    const position = aReceiver({ shortfallProbability: null });
    expect(position.priority).toBeNull();
    expect(position.basis).toBe('probability-not-forecast');

    const ranking = rankReceivers([position, aReceiver({ facilityId: facility('fac-b') })]);
    expect(ranking.ranked).toHaveLength(1);
    expect(ranking.unmeasured).toHaveLength(1);
    // The unmeasured pair is on the surface, not dropped.
    expect(ranking.unmeasured[0]?.facilityId).toBe('fac-a');
  });

  it('orders by score and breaks ties by name, so the order is reproducible', () => {
    const positions: ReceiverPriority[] = [
      aReceiver({ facilityId: facility('fac-c'), shortfallProbability: 0.2 }),
      aReceiver({ facilityId: facility('fac-b'), shortfallProbability: 0.8 }),
      aReceiver({ facilityId: facility('fac-a'), shortfallProbability: 0.8 }),
    ];

    const ranking = rankReceivers(positions);
    expect(ranking.ranked.map((each) => each.facilityId)).toEqual(['fac-a', 'fac-b', 'fac-c']);
    expect(ranking.ranked.map((each) => each.rank)).toEqual([1, 2, 3]);
    expect(rankReceivers([...positions].reverse())).toEqual(ranking);
  });
});

describe('expiry pressure', () => {
  it('is one when there is time to spare, and rises as the batch runs down', () => {
    expect(expiryPressureOf(null)).toBe(1);
    expect(expiryPressureOf(EXPIRY_PRESSURE_HORIZON_DAYS)).toBe(1);
    expect(expiryPressureOf(EXPIRY_PRESSURE_HORIZON_DAYS * 2)).toBe(1);
    expect(expiryPressureOf(0)).toBe(EXPIRY_PRESSURE_MAX);
    expect(expiryPressureOf(EXPIRY_PRESSURE_HORIZON_DAYS / 2)).toBeCloseTo(
      (1 + EXPIRY_PRESSURE_MAX) / 2,
      9,
    );
  });

  it('is bounded, so expiry can never outrank the benefit of the transfer', () => {
    // Already expired reads as no life left, and still cannot exceed the cap.
    expect(expiryPressureOf(-30)).toBe(EXPIRY_PRESSURE_MAX);
  });
});

describe('ranking a donor', () => {
  it('offers only what is above the floor it keeps for itself', () => {
    const position = aDonor({ onHand: 500, dailyDemand: 10 });
    const floor = 10 * (MAX_LEAD_TIME_DAYS + SAFETY_COVER_BUFFER_DAYS);

    expect(position.safetyStock).toBe(floor);
    expect(position.surplus).toBe(500 - floor);
    expect(position.basis).toBe('surplus');
    expect(position.onHand - (position.safetyStock ?? 0)).toBe(position.surplus);
  });

  it('has nothing to offer a facility sitting on its floor, and says which it is', () => {
    const onFloor = aDonor({ onHand: 120, dailyDemand: 10 });
    expect(onFloor.surplus).toBe(0);
    expect(onFloor.priority).toBe(0);
    expect(onFloor.basis).toBe('at-or-below-floor');

    // Below the floor is the same answer, not a negative surplus.
    const below = aDonor({ onHand: 30, dailyDemand: 10 });
    expect(below.surplus).toBe(0);
    expect(below.basis).toBe('at-or-below-floor');
  });

  it('refuses to call stock spare when the facility’s demand was never measured', () => {
    const unmeasured = aDonor({ dailyDemand: null, onHand: 5_000, earliestExpiryDays: 2 });

    expect(unmeasured.safetyStock).toBeNull();
    expect(unmeasured.surplus).toBe(0);
    expect(unmeasured.priority).toBeNull();
    expect(unmeasured.basis).toBe('demand-unmeasured');

    // And a big shelf with no measurable demand is not a big opportunity.
    const ranking = rankDonors([unmeasured, aDonor({ onHand: 130, dailyDemand: 10 })]);
    expect(ranking.ranked).toHaveLength(1);
    expect(ranking.ranked[0]?.onHand).toBe(130);
    expect(ranking.ineligible.map((each) => each.basis)).toEqual(['demand-unmeasured']);
  });

  it('prefers the donor whose stock is about to expire, at equal surplus', () => {
    const fresh = aDonor({ facilityId: facility('fac-fresh'), earliestExpiryDays: null });
    const expiring = aDonor({ facilityId: facility('fac-expiring'), earliestExpiryDays: 5 });

    expect(fresh.surplus).toBe(expiring.surplus);
    expect(expiring.priority ?? 0).toBeGreaterThan(fresh.priority ?? 0);

    const ranking = rankDonors([fresh, expiring]);
    expect(ranking.ranked.map((each) => each.facilityId)).toEqual(['fac-expiring', 'fac-fresh']);
  });

  it('orders by score and breaks ties by name, so the order is reproducible', () => {
    const positions: DonorPriority[] = [
      aDonor({ facilityId: facility('fac-c'), onHand: 200 }),
      aDonor({ facilityId: facility('fac-b'), onHand: 900 }),
      aDonor({ facilityId: facility('fac-a'), onHand: 900 }),
    ];

    const ranking = rankDonors(positions);
    // Identical surpluses and identical expiry pressure, so the tie is broken by
    // name rather than by whichever the caller happened to pass first.
    expect(ranking.ranked.map((each) => each.facilityId)).toEqual(['fac-a', 'fac-b', 'fac-c']);
    expect(rankDonors([...positions].reverse())).toEqual(ranking);
  });
});

describe('across generated positions', () => {
  const draw = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const ESSENTIALITY: readonly EssentialityTier[] = ['essential', 'programme', 'supplementary'];

  it('never treats an unmeasured shelf as spare, and never draws below the floor', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = draw(seed);
      const positions: DonorPriority[] = Array.from({ length: 12 }, (_unused, index) =>
        aDonor({
          facilityId: facility(`fac-${String(index)}`),
          itemId: item('item-paracetamol'),
          onHand: Math.floor(next() * 2_000),
          dailyDemand: next() < 0.25 ? null : next() * 40,
          earliestExpiryDays: next() < 0.3 ? null : Math.floor(next() * 200),
        }),
      );

      const ranking = rankDonors(positions);

      for (const donor of ranking.ranked) {
        expect(donor.safetyStock).not.toBeNull();
        expect(donor.surplus).toBeGreaterThan(0);
        // The property: what a plan may draw on leaves the floor intact.
        expect(donor.onHand - donor.surplus).toBeGreaterThanOrEqual(donor.safetyStock ?? Infinity);
        expect(donor.expiryPressure).toBeGreaterThanOrEqual(1);
        expect(donor.expiryPressure).toBeLessThanOrEqual(EXPIRY_PRESSURE_MAX);
      }

      for (const donor of ranking.ineligible) {
        expect(donor.basis).not.toBe('surplus');
        // An unmeasured demand is never reported as an empty shelf either.
        if (donor.basis === 'demand-unmeasured') {
          expect(donor.safetyStock).toBeNull();
          expect(donor.surplus).toBe(0);
        }
      }

      const receivers = Array.from({ length: 12 }, (_unused, index) =>
        aReceiver({
          facilityId: facility(`fac-${String(index)}`),
          essentiality: ESSENTIALITY[Math.floor(next() * ESSENTIALITY.length)] ?? 'essential',
          populationAtRisk: Math.floor(next() * 200_000),
          shortfallProbability: next() < 0.25 ? null : next(),
        }),
      );

      const ranked = rankReceivers(receivers);
      for (const position of ranked.ranked) {
        expect(position.priority).toBeGreaterThanOrEqual(0);
      }
      for (const position of ranked.unmeasured) {
        expect(position.priority).toBeNull();
      }
      expect(ranked.ranked.length + ranked.unmeasured.length).toBe(receivers.length);

      // And the order does not depend on the order the caller passed.
      expect(rankReceivers([...receivers].reverse()).ranked.map((each) => each.facilityId)).toEqual(
        ranked.ranked.map((each) => each.facilityId),
      );
      expect(rankDonors([...positions].reverse()).ranked.map((each) => each.facilityId)).toEqual(
        ranking.ranked.map((each) => each.facilityId),
      );
    }
  });
});
