import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import type { DateOnly, FacilityId, ItemId } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { MAX_LEAD_TIME_DAYS } from './feasibility';
import type { TransferEdge } from './feasibility';
import { MAX_IMPROVEMENT_PASSES, planTransfers } from './planner';
import type { PlanRequest, TransferNeed } from './planner';
import { donorPriorityOf, rankDonors, rankReceivers, receiverPriorityOf } from './priorities';

/**
 * What a plan is allowed to do.
 *
 * Two of these assertions are the phase's blocking evidence, as far as the
 * planner can carry it: across generated states, **no plan ever draws more from a
 * donor than that donor had above its own safety floor**, and every transfer it
 * proposes inherits the graph's guarantees rather than inventing its own. The
 * validator's independent re-check of the same property arrives with the
 * validator, and this file is deliberately not that check — a solver that
 * validates itself proves nothing.
 *
 * The rest are about the two-phase method being real rather than decorative. The
 * re-sourcing test below is built so that greedy cannot find the answer: the
 * better plan needs a delivery moved to a second-best supplier so a scarce batch
 * is released, which is exactly why the improvement phase exists. If that test
 * ever passes with the improvement phase disabled, the phase has stopped doing
 * anything.
 */

const AS_OF: DateOnly = '2026-09-24';

const facility = (value: string): FacilityId => facilityIdSchema.parse(value);
const item = (value: string): ItemId => itemIdSchema.parse(value);

const anEdge = (input: {
  readonly donor: string;
  readonly receiver: string;
  readonly itemId?: string;
  readonly batchId?: string;
  readonly quantity: number;
  readonly distanceKm: number;
  readonly expiresOn?: string;
}): TransferEdge => ({
  donorId: facility(input.donor),
  receiverId: facility(input.receiver),
  itemId: item(input.itemId ?? 'item-1'),
  batchId: input.batchId ?? 'B-1',
  quantity: input.quantity,
  distanceKm: input.distanceKm,
  leadTimeDays: 1 + Math.ceil(input.distanceKm / 150),
  expiresOn: input.expiresOn ?? '2027-12-31',
  shelfLifeOnArrivalDays: 400,
  coldChain: false,
});

/** A donor as the ranking sees it, with the floor it keeps to itself. */
interface DonorFixture {
  readonly facilityId: string;
  readonly itemId?: string;
  readonly onHand: number;
  readonly dailyDemand: number | null;
  readonly earliestExpiryDays?: number | null;
}

const donorsOf = (fixtures: readonly DonorFixture[]) =>
  rankDonors(
    fixtures.map((fixture) =>
      donorPriorityOf({
        facilityId: facility(fixture.facilityId),
        itemId: item(fixture.itemId ?? 'item-1'),
        onHand: fixture.onHand,
        dailyDemand: fixture.dailyDemand,
        earliestExpiryDays: fixture.earliestExpiryDays ?? null,
      }),
    ),
  );

interface ReceiverFixture {
  readonly facilityId: string;
  readonly itemId?: string;
  readonly shortfallProbability: number | null;
  readonly essentiality?: 'essential' | 'programme' | 'supplementary';
  readonly populationAtRisk: number;
}

const receiversOf = (fixtures: readonly ReceiverFixture[]) =>
  rankReceivers(
    fixtures.map((fixture) =>
      receiverPriorityOf({
        facilityId: facility(fixture.facilityId),
        itemId: item(fixture.itemId ?? 'item-1'),
        shortfallProbability: fixture.shortfallProbability,
        essentiality: fixture.essentiality ?? 'essential',
        populationAtRisk: fixture.populationAtRisk,
      }),
    ),
  );

const planFor = (input: {
  readonly edges: readonly TransferEdge[];
  readonly needs: readonly TransferNeed[];
  readonly donorFixtures: readonly DonorFixture[];
  readonly receiverFixtures: readonly ReceiverFixture[];
  readonly maxImprovementPasses?: number;
}): ReturnType<typeof planTransfers> =>
  planTransfers({
    asOf: AS_OF,
    edges: input.edges,
    needs: input.needs,
    receivers: receiversOf(input.receiverFixtures),
    donors: donorsOf(input.donorFixtures),
    ...(input.maxImprovementPasses === undefined
      ? {}
      : { options: { maxImprovementPasses: input.maxImprovementPasses } }),
  });

const need = (facilityId: string, units: number, itemId = 'item-1'): TransferNeed => ({
  facilityId: facility(facilityId),
  itemId: item(itemId),
  units,
});

describe('the two-phase method', () => {
  // Greedy serves the highest-ranked receiver from the cheapest batch. Here that
  // batch is the *only* supply the second receiver has, while the first has a
  // second-best option. Greedy strands the second receiver; the re-sourcing move
  // is what unsticks it.
  const edges = [
    anEdge({
      donor: 'donor-a',
      receiver: 'recv-high',
      quantity: 100,
      distanceKm: 10,
      batchId: 'B1',
    }),
    anEdge({
      donor: 'donor-b',
      receiver: 'recv-high',
      quantity: 100,
      distanceKm: 20,
      batchId: 'B2',
    }),
    anEdge({
      donor: 'donor-a',
      receiver: 'recv-low',
      quantity: 100,
      distanceKm: 10,
      batchId: 'B1',
    }),
  ];
  const needs = [need('recv-high', 100), need('recv-low', 100)];
  const donorFixtures: DonorFixture[] = [
    { facilityId: 'donor-a', onHand: 220, dailyDemand: 10, earliestExpiryDays: null },
    { facilityId: 'donor-b', onHand: 220, dailyDemand: 10, earliestExpiryDays: null },
  ];
  const receiverFixtures: ReceiverFixture[] = [
    { facilityId: 'recv-high', shortfallProbability: 0.9, populationAtRisk: 100_000 },
    { facilityId: 'recv-low', shortfallProbability: 0.9, populationAtRisk: 90_000 },
  ];

  it('improves on what greedy alone produces, by re-sourcing a delivery', () => {
    const greedy = planFor({
      edges,
      needs,
      donorFixtures,
      receiverFixtures,
      maxImprovementPasses: 0,
    });
    const improved = planFor({ edges, needs, donorFixtures, receiverFixtures });

    // Greedy answers the first receiver and strands the second.
    expect(greedy.transfers).toHaveLength(1);
    expect(greedy.transfers[0]?.receiverId).toBe('recv-high');
    expect(greedy.transfers[0]?.donorId).toBe('donor-a');
    expect(greedy.unserved.map((each) => each.facilityId)).toEqual(['recv-low']);

    // The improvement phase moves that delivery to the dearer supplier, which
    // releases the scarce batch for the receiver that had no alternative.
    expect(improved.transfers).toHaveLength(2);
    const by = new Map(improved.transfers.map((transfer) => [transfer.receiverId, transfer]));
    expect(by.get(facility('recv-high'))?.donorId).toBe('donor-b');
    expect(by.get(facility('recv-low'))?.donorId).toBe('donor-a');
    expect(improved.unserved).toEqual([]);
    expect(improved.objective.total).toBeLessThan(greedy.objective.total);
  });

  it('reports the objective against moving nothing, so a plan can be judged', () => {
    const plan = planFor({ edges, needs, donorFixtures, receiverFixtures });

    expect(plan.baseline.unmetDemandPenalty).toBeGreaterThan(0);
    expect(plan.baseline.transportCost).toBe(0);
    expect(plan.objective.total).toBeLessThan(plan.baseline.total);
    // Both receivers answered, so what is left is transport and nothing else.
    expect(plan.objective.unmetDemandPenalty).toBe(0);
    expect(plan.objective.transportCost).toBeCloseTo(
      plan.transfers.reduce(
        (sum, transfer) => sum + transfer.quantity * transfer.distanceKm * 0.002,
        0,
      ),
      9,
    );
  });

  it('moves nothing at all when nothing is short', () => {
    // The negative control, at the planner's scale: a request with no need is
    // answered with an empty plan rather than with a transfer nobody asked for.
    const plan = planFor({
      edges,
      needs: [],
      donorFixtures,
      receiverFixtures: [],
    });
    expect(plan.transfers).toEqual([]);
    expect(plan.objective.total).toBe(0);
  });

  it('proposes nothing when every donor is sitting on its own floor', () => {
    const plan = planFor({
      edges,
      needs,
      donorFixtures: [
        { facilityId: 'donor-a', onHand: 50, dailyDemand: 10 },
        { facilityId: 'donor-b', onHand: 50, dailyDemand: 10 },
      ],
      receiverFixtures,
    });
    expect(plan.transfers).toEqual([]);
    expect(plan.objective).toEqual(plan.baseline);
  });

  it('refuses to draw on a donor whose demand was never measured', () => {
    const plan = planFor({
      edges,
      needs,
      donorFixtures: [
        { facilityId: 'donor-a', onHand: 50_000, dailyDemand: null },
        { facilityId: 'donor-b', onHand: 220, dailyDemand: 10 },
      ],
      receiverFixtures,
    });

    // The unmeasured facility looks like the richest donor in the network and is
    // drawn on for nothing.
    expect(plan.transfers.every((transfer) => transfer.donorId === 'donor-b')).toBe(true);
    expect(plan.assumptions.ineligibleDonors.map((each) => each.basis)).toEqual([
      'demand-unmeasured',
    ]);
  });

  it('reports a receiver it cannot measure instead of ranking it as calm', () => {
    const plan = planFor({
      edges: [
        ...edges,
        anEdge({ donor: 'donor-b', receiver: 'recv-dark', quantity: 10, distanceKm: 30 }),
      ],
      needs: [...needs, need('recv-dark', 10)],
      donorFixtures,
      receiverFixtures: [
        ...receiverFixtures,
        { facilityId: 'recv-dark', shortfallProbability: null, populationAtRisk: 10_000 },
      ],
    });

    expect(plan.assumptions.unmeasuredReceivers.map((each) => each.facilityId)).toEqual([
      'recv-dark',
    ]);
    // Not planned for, and in particular not silently planned for badly.
    expect(plan.transfers.some((transfer) => transfer.receiverId === 'recv-dark')).toBe(false);
  });

  it('names the weight scale it used, because the scale is the request’s own', () => {
    const plan = planFor({ edges, needs, donorFixtures, receiverFixtures });
    expect(plan.weightReference).toBe('recv-high');
    expect(plan.assumptions.unmetDemandPenaltyPerUnit).toBe(1);
    expect(plan.assumptions.transportCostPerUnitKm).toBe(0.002);
    expect(plan.assumptions.maxImprovementPasses).toBe(MAX_IMPROVEMENT_PASSES);
  });
});

describe('determinism and the pass budget', () => {
  const edges = [
    anEdge({
      donor: 'donor-a',
      receiver: 'recv-high',
      quantity: 100,
      distanceKm: 10,
      batchId: 'B1',
    }),
    anEdge({
      donor: 'donor-b',
      receiver: 'recv-high',
      quantity: 100,
      distanceKm: 20,
      batchId: 'B2',
    }),
    anEdge({
      donor: 'donor-a',
      receiver: 'recv-low',
      quantity: 100,
      distanceKm: 10,
      batchId: 'B1',
    }),
  ];
  const donorFixtures: DonorFixture[] = [
    { facilityId: 'donor-a', onHand: 220, dailyDemand: 10 },
    { facilityId: 'donor-b', onHand: 220, dailyDemand: 10 },
  ];
  const receiverFixtures: ReceiverFixture[] = [
    { facilityId: 'recv-high', shortfallProbability: 0.9, populationAtRisk: 100_000 },
    { facilityId: 'recv-low', shortfallProbability: 0.9, populationAtRisk: 90_000 },
  ];
  const needs = [need('recv-high', 100), need('recv-low', 100)];

  it('produces the same plan whatever order its inputs arrive in', () => {
    const request: PlanRequest = {
      asOf: AS_OF,
      edges,
      needs,
      receivers: receiversOf(receiverFixtures),
      donors: donorsOf(donorFixtures),
    };
    const forward = planTransfers(request);
    const reversed = planTransfers({
      asOf: AS_OF,
      edges: [...edges].reverse(),
      needs: [...needs].reverse(),
      // The rankings sort their own input, so reversing the fixtures and
      // reversing the edges are the two orders the caller genuinely controls.
      receivers: receiversOf([...receiverFixtures].reverse()),
      donors: donorsOf([...donorFixtures].reverse()),
    });

    expect(reversed).toEqual(forward);
  });

  it('reports whether it ran out of passes rather than stopping quietly', () => {
    const onePass = planFor({
      edges,
      needs,
      donorFixtures,
      receiverFixtures,
      maxImprovementPasses: 1,
    });
    // One pass is enough here: the re-sourcing move is available immediately, and
    // the second pass is the one that finds nothing to do.
    expect(onePass.improvementPasses).toBe(1);
    expect(onePass.improvementBudgetReached).toBe(true);

    const full = planFor({ edges, needs, donorFixtures, receiverFixtures });
    expect(full.improvementBudgetReached).toBe(false);
    expect(full.objective.total).toBeLessThanOrEqual(onePass.objective.total);
  });
});

describe('across generated states', () => {
  const draw = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  interface State {
    readonly edges: TransferEdge[];
    readonly needs: TransferNeed[];
    readonly donorFixtures: DonorFixture[];
    readonly receiverFixtures: ReceiverFixture[];
    readonly receivers: ReturnType<typeof rankReceivers>;
  }

  const generate = (next: () => number): State => {
    const facilities = Array.from({ length: 8 }, (_unused, index) => `fac-${String(index)}`);
    const edges: TransferEdge[] = [];
    const donorFixtures: DonorFixture[] = [];
    const receiverFixtures: ReceiverFixture[] = [];
    const needs: TransferNeed[] = [];

    // Two donors per facility lot: half the facilities can give, all can need.
    for (const id of facilities) {
      donorFixtures.push({
        facilityId: id,
        onHand: Math.floor(next() * 900) + 20,
        dailyDemand: next() < 0.2 ? null : Math.floor(next() * 20),
        earliestExpiryDays: next() < 0.4 ? null : Math.floor(next() * 120),
      });
      receiverFixtures.push({
        facilityId: id,
        shortfallProbability: next() < 0.2 ? null : Number(next().toFixed(2)),
        essentiality:
          (['essential', 'programme', 'supplementary'] as const)[Math.floor(next() * 3)] ??
          'essential',
        populationAtRisk: Math.floor(next() * 100_000),
      });
      needs.push(need(id, Math.floor(next() * 200)));
    }

    const lots = 6;
    for (let lot = 0; lot < lots; lot += 1) {
      const donor = facilities[Math.floor(next() * facilities.length)] ?? 'fac-0';
      const batchId = `B${String(lot)}`;
      const quantity = Math.floor(next() * 300) + 10;
      for (const receiver of facilities) {
        if (receiver === donor) {
          continue;
        }
        const distanceKm = Number((next() * 500 + 1).toFixed(1));
        if (1 + Math.ceil(distanceKm / 150) > MAX_LEAD_TIME_DAYS) {
          continue;
        }
        edges.push(anEdge({ donor, receiver, quantity, distanceKm, batchId }));
      }
    }

    return {
      edges,
      needs,
      donorFixtures,
      receiverFixtures,
      receivers: receiversOf(receiverFixtures),
    };
  };

  const planOf = (state: State) =>
    planTransfers({
      asOf: AS_OF,
      edges: state.edges,
      needs: state.needs,
      receivers: state.receivers,
      donors: donorsOf(state.donorFixtures),
    });

  it('never draws a donor below the floor it keeps for itself', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const state = generate(draw(seed));
      const plan = planOf(state);

      const ranked = donorsOf(state.donorFixtures).ranked;
      const floorByDonorItem = new Map(
        ranked.map((donor) => [
          `${donor.facilityId}|${donor.itemId}`,
          { onHand: donor.onHand, safetyStock: donor.safetyStock ?? 0 },
        ]),
      );
      const moved = new Map<string, number>();
      for (const transfer of plan.transfers) {
        const key = `${transfer.donorId}|${transfer.itemId}`;
        moved.set(key, (moved.get(key) ?? 0) + transfer.quantity);
      }

      for (const [key, quantity] of moved) {
        const donor = floorByDonorItem.get(key);
        expect(donor).toBeDefined();
        // **The blocking property.** What the plan moves leaves the floor intact,
        // in the units the floor is stated in.
        expect((donor?.onHand ?? 0) - quantity).toBeGreaterThanOrEqual(donor?.safetyStock ?? 0);
      }

      // And nothing is drawn from a donor the ranking refused.
      const ineligible = new Set(
        plan.assumptions.ineligibleDonors.map((donor) => `${donor.facilityId}|${donor.itemId}`),
      );
      for (const key of moved.keys()) {
        expect(ineligible.has(key)).toBe(false);
      }
    }
  });

  it('proposes only moves the graph already admitted', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const state = generate(draw(seed));
      const plan = planOf(state);

      for (const transfer of plan.transfers) {
        expect(transfer.quantity).toBeGreaterThan(0);
        expect(transfer.distanceKm).toBeGreaterThan(0);
        expect(transfer.leadTimeDays).toBeLessThanOrEqual(MAX_LEAD_TIME_DAYS);
        expect(transfer.shelfLifeOnArrivalDays).toBeGreaterThanOrEqual(0);
        expect(
          state.edges.some(
            (edge) =>
              edge.donorId === transfer.donorId &&
              edge.receiverId === transfer.receiverId &&
              edge.itemId === transfer.itemId &&
              edge.batchId === transfer.batchId,
          ),
        ).toBe(true);
      }

      // No batch is moved twice over, and no need is over-answered.
      const byLot = new Map<string, number>();
      for (const transfer of plan.transfers) {
        const key = `${transfer.donorId}|${transfer.itemId}|${transfer.batchId}`;
        byLot.set(key, (byLot.get(key) ?? 0) + transfer.quantity);
      }
      const lotQuantity = new Map<string, number>();
      for (const edge of state.edges) {
        const key = `${edge.donorId}|${edge.itemId}|${edge.batchId}`;
        lotQuantity.set(key, Math.max(lotQuantity.get(key) ?? 0, edge.quantity));
      }
      for (const [key, quantity] of byLot) {
        expect(quantity).toBeLessThanOrEqual(lotQuantity.get(key) ?? 0);
      }

      const byReceiver = new Map<string, number>();
      for (const transfer of plan.transfers) {
        const key = `${transfer.receiverId}|${transfer.itemId}`;
        byReceiver.set(key, (byReceiver.get(key) ?? 0) + transfer.quantity);
      }
      for (const each of state.needs) {
        if (each.units <= 0) {
          continue;
        }
        expect(byReceiver.get(`${each.facilityId}|${each.itemId}`) ?? 0).toBeLessThanOrEqual(
          each.units,
        );
      }
    }
  });

  it('never increases total unmet need when more supply is added', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const state = generate(draw(seed));
      const before = planOf(state);

      const extra = state.edges[0];
      if (extra === undefined) {
        continue;
      }
      const withExtra: State = {
        ...state,
        // A new donor with stock to spare, able to reach everyone.
        donorFixtures: [
          ...state.donorFixtures,
          { facilityId: 'fac-extra', onHand: 5_000, dailyDemand: 5, earliestExpiryDays: null },
        ],
        edges: [
          ...state.edges,
          ...state.needs.map((each) =>
            anEdge({
              donor: 'fac-extra',
              receiver: each.facilityId,
              itemId: each.itemId,
              batchId: 'B-extra',
              quantity: 2_000,
              distanceKm: 50,
            }),
          ),
        ],
      };
      const after = planOf(withExtra);

      const unservedBefore = before.unserved.reduce((sum, each) => sum + each.units, 0);
      const unservedAfter = after.unserved.reduce((sum, each) => sum + each.units, 0);
      expect(unservedAfter).toBeLessThanOrEqual(unservedBefore);
      expect(after.objective.unmetDemandPenalty).toBeLessThanOrEqual(
        before.objective.unmetDemandPenalty,
      );
    }
  });

  it('is reproducible from the same state', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const state = generate(draw(seed));
      expect(planOf(state)).toEqual(planOf(state));
    }
  });
});
