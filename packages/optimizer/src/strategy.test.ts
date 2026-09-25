import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import type { CareLevel, DateOnly, FacilityId, FacilityTier } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { buildTransferGraph } from './feasibility';
import type { StockLot, TransferItem, TransferNode } from './feasibility';
import type { ReceiverDemand } from './impact';
import type { PlannedTransfer } from './planner';
import { donorPriorityOf, rankDonors, rankReceivers, receiverPriorityOf } from './priorities';
import {
  MAX_STRATEGY_ITERATIONS,
  STRATEGY_DEFINITIONS,
  STRATEGY_NAMES,
  decideStrategy,
  evaluateStrategies,
  proposePlan,
} from './strategy';
import type { StrategySetInput } from './strategy';
import type { DonorPosition, ReceiverLimit, ValidationWorld } from './validator';

/**
 * The strategy layer is the only place a model has a lever, and this file is
 * about what happens when it pulls the wrong one.
 *
 * A model selects one of four stated weightings. It cannot compute a plan and it
 * cannot supply a quantity, so the adversarial case is not "the model wrote a
 * bad number into the record" — the platform never lets a model write a number
 * at all. It is that a provider *volunteers* a plan, and the layer has to judge
 * it like anything else: a plan that puts a donor under its safety floor is
 * refused **by name**, refusing it is fed back, and after a bounded loop the
 * deterministic fallback stands. A layer that has never refused an attempt is
 * not evidence that attempts are sound.
 *
 * The fallback itself is the path that runs while no provider is configured,
 * which is this build's shipping state, so it is tested as a decision rule in
 * its own right: deterministic, stated, and the same answer every time.
 */

const AS_OF: DateOnly = '2026-09-24';

const D1 = facilityIdSchema.parse('fac-d1');
const D2 = facilityIdSchema.parse('fac-d2');
const R1 = facilityIdSchema.parse('fac-r1');
const R2 = facilityIdSchema.parse('fac-r2');
const ITEM = itemIdSchema.parse('item-paracetamol');

const facility = (
  id: FacilityId,
  latitude: number,
  longitude: number,
  tier: FacilityTier,
): TransferNode => ({
  facilityId: id,
  tier,
  coordinates: { latitude, longitude },
  coldChain: { available: false, reliability: 1 },
});

const theItem: TransferItem = {
  itemId: ITEM,
  genericName: 'Paracetamol',
  storage: 'ambient',
  coldChain: false,
  careLevels: ['primary'] satisfies readonly CareLevel[],
};

const lots: readonly StockLot[] = [
  { facilityId: D1, itemId: ITEM, batchId: 'B-d1', quantity: 800, expiresOn: '2027-06-30' },
  { facilityId: D2, itemId: ITEM, batchId: 'B-d2', quantity: 400, expiresOn: '2027-06-30' },
  { facilityId: R1, itemId: ITEM, batchId: 'B-r1', quantity: 60, expiresOn: '2027-06-30' },
  { facilityId: R2, itemId: ITEM, batchId: 'B-r2', quantity: 40, expiresOn: '2027-06-30' },
];

const nodes: readonly TransferNode[] = [
  facility(D1, 20, 78, 'PHC'),
  facility(D2, 20.1, 78, 'CHC'),
  facility(R1, 20.2, 78, 'CHC'),
  facility(R2, 20.3, 78, 'PHC'),
];

const dailyDemandOf: Readonly<Record<string, number>> = {
  'fac-d1': 5,
  'fac-d2': 10,
  'fac-r1': 10,
  'fac-r2': 10,
};

const donorPositions: readonly DonorPosition[] = nodes.map((node) => ({
  facilityId: node.facilityId,
  itemId: ITEM,
  dailyDemand: dailyDemandOf[node.facilityId] ?? 0,
}));

const receiverLimits: readonly ReceiverLimit[] = [
  { facilityId: R1, itemId: ITEM, capacityUnits: 100, projectedStockOutOn: '2026-12-31' },
  { facilityId: R2, itemId: ITEM, capacityUnits: 80, projectedStockOutOn: '2026-12-31' },
];

const world: ValidationWorld = {
  asOf: AS_OF,
  facilities: nodes,
  items: [theItem],
  lots,
  donorPositions,
  receiverLimits,
  transport: { budgetUnitKm: 1e9, edgeCapacityUnits: 1e6, reactionBufferDays: 3 },
};

const buildSet = (): StrategySetInput => {
  const graph = buildTransferGraph({ nodes, items: [theItem], lots, options: { asOf: AS_OF } });
  const receiverFixtures = [
    {
      facilityId: R1,
      itemId: ITEM,
      shortfallProbability: 0.6,
      essentiality: 'essential' as const,
      populationAtRisk: 20_000,
    },
    {
      facilityId: R2,
      itemId: ITEM,
      shortfallProbability: 0.3,
      essentiality: 'essential' as const,
      populationAtRisk: 10_000,
    },
  ];
  const donorFixtures = nodes.map((node) => ({
    facilityId: node.facilityId,
    itemId: ITEM,
    onHand: lots.find((lot) => lot.facilityId === node.facilityId)?.quantity ?? 0,
    dailyDemand: dailyDemandOf[node.facilityId] ?? 0,
    earliestExpiryDays: null,
  }));

  const demands: readonly ReceiverDemand[] = [
    {
      facilityId: R1,
      itemId: ITEM,
      onHandUnits: 60,
      p50: Array<number>(14).fill(10),
      p90: Array<number>(14).fill(20),
      shortfallProbability: 0.6,
    },
    {
      facilityId: R2,
      itemId: ITEM,
      onHandUnits: 40,
      p50: Array<number>(14).fill(8),
      p90: Array<number>(14).fill(16),
      shortfallProbability: 0.3,
    },
  ];

  return {
    base: {
      asOf: AS_OF,
      edges: graph.edges,
      needs: [
        { facilityId: R1, itemId: ITEM, units: 100 },
        { facilityId: R2, itemId: ITEM, units: 80 },
      ],
      receivers: rankReceivers(receiverFixtures.map((fixture) => receiverPriorityOf(fixture))),
      donors: rankDonors(donorFixtures.map((fixture) => donorPriorityOf(fixture))),
    },
    demands,
    world,
  };
};

const anAttemptPlan = (overrides: Partial<PlannedTransfer> = {}): PlannedTransfer => ({
  donorId: D1,
  receiverId: R1,
  itemId: ITEM,
  batchId: 'B-d1',
  quantity: 780,
  distanceKm: 20,
  leadTimeDays: 2,
  shelfLifeOnArrivalDays: 277,
  expiresOn: '2027-06-30',
  coldChain: false,
  receiverWeight: 1,
  ...overrides,
});

describe('the strategies are four stated weightings, not four names', () => {
  it('differs in exactly the one trade-off each is named for', () => {
    expect(STRATEGY_DEFINITIONS).toHaveLength(STRATEGY_NAMES.length);
    expect(new Set(STRATEGY_NAMES).size).toBe(STRATEGY_NAMES.length);
    // The options really are different — a set of four identical weightings
    // would make the choice meaningless.
    expect(new Set(STRATEGY_DEFINITIONS.map((each) => JSON.stringify(each.options))).size).toBe(4);
  });
});

describe('every strategy is judged by the independent validator', () => {
  it('admits the planner’s plans and prices each one', () => {
    const outcomes = evaluateStrategies(buildSet());

    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome.verdict.valid).toBe(true);
      expect(outcome.refusal).toBeNull();
      expect(outcome.plan.transfers.length).toBeGreaterThan(0);
      // The impact travels with the outcome, its assumptions included.
      expect(outcome.impact.assumptions.scenarios).toHaveLength(2);
      expect(outcome.impact.assumptions.horizonDays).toBe(14);
    }
    // At least one strategy answers the shortage, or the scenario proves nothing.
    expect(
      outcomes.reduce((total, outcome) => total + outcome.plan.transfers.length, 0),
    ).toBeGreaterThan(0);
  });
});

describe('the fallback is a decision rule that actually runs', () => {
  it('picks deterministically and says what decided it', () => {
    const outcomes = evaluateStrategies(buildSet());
    const first = decideStrategy({ outcomes, world });
    const second = decideStrategy({ outcomes, world });

    expect(first.decidedBy).toBe('fallback');
    expect(first.name).toBe(second.name);
    expect(first.outcome.verdict.valid).toBe(true);
    expect(first.reason).toContain('fallback');
    expect(first.refusals).toEqual([]);
  });
});

describe('a model’s attempt is judged, and a bad one is refused by name', () => {
  it('accepts a selection that names a strategy this build ships', () => {
    const outcomes = evaluateStrategies(buildSet());
    const decided = decideStrategy({
      outcomes,
      world,
      attempt: { strategy: 'cost-minimising' },
    });

    expect(decided.decidedBy).toBe('model');
    expect(decided.name).toBe('cost-minimising');
    expect(decided.refusals).toEqual([]);
  });

  it('refuses a strategy this build does not ship', () => {
    const outcomes = evaluateStrategies(buildSet());
    const decided = decideStrategy({
      outcomes,
      world,
      attempt: { strategy: 'maximise-margin' as never },
    });

    expect(decided.decidedBy).toBe('fallback');
    expect(decided.refusals).toHaveLength(1);
    expect(decided.refusals[0]?.reason).toContain('not a strategy this build ships');
  });

  it('refuses a plan that puts a donor under its floor, and falls back', () => {
    const outcomes = evaluateStrategies(buildSet());
    // The donor holds 800 and keeps a floor of 60; taking 780 leaves 20.
    const decided = decideStrategy({
      outcomes,
      world,
      attempt: { strategy: 'risk-averse', plan: [anAttemptPlan({ quantity: 780 })] },
    });

    expect(decided.decidedBy).toBe('fallback');
    expect(decided.refusals[0]?.violations).toContain('donor-left-below-floor');
    // And the fallback plan is one the validator admits, so the refusal did not
    // leave the caller with nothing.
    expect(decided.outcome.verdict.valid).toBe(true);
  });
});

describe('the tool loop is bounded and feeds refusals back', () => {
  it('stands aside without asking anyone when no selector is configured', async () => {
    const result = await proposePlan({ set: buildSet() });

    expect(result.iterations).toBe(0);
    expect(result.selection.decidedBy).toBe('fallback');
    expect(result.budgetReached).toBe(false);
  });

  it('collects refusals and stops at the budget', async () => {
    const seen: number[] = [];
    const result = await proposePlan({
      set: buildSet(),
      select: (feedback) => {
        seen.push(feedback.iteration);
        return Promise.resolve({
          strategy: 'risk-averse',
          plan: [anAttemptPlan({ quantity: 780 })],
        });
      },
    });

    expect(result.selection.decidedBy).toBe('fallback');
    expect(result.iterations).toBe(MAX_STRATEGY_ITERATIONS);
    expect(result.budgetReached).toBe(true);
    expect(result.selection.refusals).toHaveLength(MAX_STRATEGY_ITERATIONS);
    // The loop never stopped early, so it asked exactly the budget's worth.
    expect(seen).toEqual([1, 2, 3]);
  });

  it('accepts a corrected attempt on a later iteration', async () => {
    const result = await proposePlan({
      set: buildSet(),
      select: (feedback) =>
        Promise.resolve(
          feedback.iteration === 1
            ? { strategy: 'risk-averse' as const, plan: [anAttemptPlan({ quantity: 780 })] }
            : { strategy: 'risk-averse' as const },
        ),
    });

    expect(result.selection.decidedBy).toBe('model');
    expect(result.selection.name).toBe('risk-averse');
    expect(result.iterations).toBe(2);
    expect(result.selection.refusals).toHaveLength(1);
  });
});
