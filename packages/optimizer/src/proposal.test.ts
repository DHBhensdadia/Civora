import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import type { PlanImpact } from './impact';
import type { PlannedTransfer, TransferPlan } from './planner';
import { dailyRateOf, proposalsFrom, stockOutOnFrom } from './proposal';
import type { PairFacts } from './proposal';
import type { StrategyOutcome, StrategySelection } from './strategy';
import type { PlanVerdict, ValidationWorld } from './validator';

/**
 * The record-building step, held to the rule the phase rests on.
 *
 * The blocking property of Phase 6 is that a plan no validator admits never
 * becomes something a person can approve, and this is where that is decided: the
 * shape of the world decides whether a proposal exists at all. The test below
 * moves one identical transfer between two worlds that differ in one number —
 * the donor's own daily demand — and asserts that the record appears in one and
 * not the other, for a stated reason. Nothing here needs a dataset.
 */

const FACILITY_A = facilityIdSchema.parse('facility-a');
const FACILITY_B = facilityIdSchema.parse('facility-b');
const ITEM = itemIdSchema.parse('item-paracetamol');

const AS_OF = '2026-09-24';

const transfer: PlannedTransfer = {
  donorId: FACILITY_A,
  receiverId: FACILITY_B,
  itemId: ITEM,
  batchId: 'batch-1',
  quantity: 10,
  distanceKm: 40,
  leadTimeDays: 2,
  shelfLifeOnArrivalDays: 120,
  expiresOn: '2027-01-21',
  coldChain: false,
  receiverWeight: 1,
};

/** A world in which the move is physically inside the graph, and one donor floor. */
const world = (donorDailyDemand: number): ValidationWorld => ({
  asOf: AS_OF,
  facilities: [
    {
      facilityId: FACILITY_A,
      tier: 'CHC',
      coordinates: { latitude: 24.8, longitude: 85.0 },
      coldChain: { available: true, reliability: 0.95 },
    },
    {
      facilityId: FACILITY_B,
      tier: 'PHC',
      coordinates: { latitude: 24.9, longitude: 85.1 },
      coldChain: { available: true, reliability: 0.95 },
    },
  ],
  items: [
    {
      itemId: ITEM,
      genericName: 'Paracetamol',
      storage: 'ambient',
      coldChain: false,
      careLevels: ['primary'],
    },
  ],
  lots: [
    {
      facilityId: FACILITY_A,
      itemId: ITEM,
      batchId: 'batch-1',
      quantity: 100,
      expiresOn: '2027-01-21',
    },
  ],
  donorPositions: [{ facilityId: FACILITY_A, itemId: ITEM, dailyDemand: donorDailyDemand }],
  receiverLimits: [
    {
      facilityId: FACILITY_B,
      itemId: ITEM,
      capacityUnits: 40,
      projectedStockOutOn: AS_OF,
    },
  ],
  transport: { budgetUnitKm: 100_000, edgeCapacityUnits: 10_000, reactionBufferDays: 2 },
});

/** The selection a strategy layer would have produced, with the plan under test. */
const selectionOf = (): StrategySelection => {
  const plan: TransferPlan = {
    asOf: AS_OF,
    transfers: [transfer],
    objective: { unmetDemandPenalty: 0, transportCost: 0.8, expiryPenalty: 0, total: 0.8 },
    baseline: { unmetDemandPenalty: 10, transportCost: 0, expiryPenalty: 0, total: 10 },
    unserved: [],
    improvementPasses: 0,
    improvementBudgetReached: false,
    weightReference: FACILITY_B,
    assumptions: {
      maxImprovementPasses: 8,
      unmetDemandPenaltyPerUnit: 1,
      transportCostPerUnitKm: 0.002,
      expiryLossPerUnit: 0.1,
      unmeasuredReceivers: [],
      ineligibleDonors: [],
    },
  };
  const impact: PlanImpact = {
    transfers: [
      {
        donorId: FACILITY_A,
        receiverId: FACILITY_B,
        itemId: ITEM,
        batchId: 'batch-1',
        units: 10,
        distanceKm: 40,
        leadTimeDays: 2,
        expectedUnmetDemandAvoided: 10,
        expectedStockOutDaysAverted: 0.5,
        baselineUnmetDemand: 10,
        withTransferUnmetDemand: 0,
        transportCost: 0.8,
        netBenefit: 9.2,
        assessment: 'beneficial',
        note: 'projected over the median path alone',
      },
    ],
    unquantified: [],
    totalExpectedUnmetDemandAvoided: 10,
    totalExpectedStockOutDaysAverted: 0.5,
    totalTransportCost: 0.8,
    totalNetBenefit: 9.2,
    marginalOrNegative: [],
    assumptions: {
      method: 'two-quantile-stock-projection',
      scenarios: ['median path', 'upper path'],
      horizonDays: 14,
      costPerUnitKm: 0.002,
      weightedByShortfallProbability: true,
    },
  };
  const outcome = {
    name: 'balanced',
    description: 'as shipped',
    plan,
    verdict: {
      valid: true,
      violations: [],
      unchecked: [],
      measured: { transfers: 1, units: 10, unitKm: 400 },
      policy: {},
    } as unknown as PlanVerdict,
    impact,
    acceptable: true,
    refusal: null,
    benefitPerUnitKm: 0.025,
  } as unknown as StrategyOutcome;

  return {
    name: 'balanced',
    decidedBy: 'fallback',
    reason: 'highest benefit per unit-kilometre',
    outcome,
    outcomes: [outcome],
    refusals: [],
  };
};

const facts: ReadonlyMap<string, PairFacts> = new Map([
  [`${FACILITY_A}|${ITEM}`, { onHand: 100, rate: 10 }],
  [`${FACILITY_B}|${ITEM}`, { onHand: 0, rate: 2 }],
]);

describe('the proposal a plan earns', () => {
  it('is built when the world admits the move, and carries the estimator’s numbers and assumptions', () => {
    const built = proposalsFrom({ selection: selectionOf(), world: world(1), facts });

    expect(built.refused).toEqual([]);
    expect(built.proposals).toHaveLength(1);

    const proposal = built.proposals[0]?.proposal;
    expect(proposal?.verdict).toBe('proposed');
    expect(proposal?.violations).toEqual([]);
    expect(proposal?.quantity).toBe(10);
    expect(proposal?.fromFacilityId).toBe(FACILITY_A);
    expect(proposal?.toFacilityId).toBe(FACILITY_B);
    expect(proposal?.batchId).toBe('batch-1');
    // The estimator avoids 10 units; the record rounds them to whole units and
    // says the method that produced them.
    expect(proposal?.expectedImpact.unmetDemandAvoided).toBe(10);
    expect(proposal?.expectedImpact.donorDaysOfStockAfter).toBe(9);
    expect(proposal?.expectedImpact.receiverDaysOfStockAfter).toBe(5);
    expect(proposal?.expectedImpact.assumptions.join(' ')).toContain(
      'two-quantile-stock-projection',
    );
    expect(proposal?.expectedImpact.assumptions.join(' ')).toContain('beneficial');
    expect(proposal?.approvals).toEqual([]);
    expect(proposal?.synthetic).toBe(true);
  });

  it('does not exist at all when the donor’s own floor refuses the move, and the refusal names the rule', () => {
    // The same movement, judged against a world that knows the donor dispenses
    // ten a day — its floor is twelve days of that, and the plan takes it below.
    const built = proposalsFrom({ selection: selectionOf(), world: world(10), facts });

    expect(built.proposals).toEqual([]);
    expect(built.refused.map((refusal) => refusal.rule)).toEqual(['donor-floor']);
    expect(built.refused[0]?.detail).toContain('facility-a');
    // A code, not a sentence: the surface keys on it and prints the detail.
    expect(built.refused[0]?.code.length).toBeGreaterThan(0);
  });

  it('takes the last expiry and the fastest rate from the numbers it is given, and refuses to invent either', () => {
    // A rate nobody measured has no days-of-cover answer; the record carries the
    // domain's only non-negative stand-in and says the suit is empty in the
    // assumptions rather than presenting zero as a measurement.
    const unmeasured = proposalsFrom({
      selection: selectionOf(),
      world: world(1),
      facts: new Map([
        [`${FACILITY_A}|${ITEM}`, { onHand: 100, rate: 0 }],
        [`${FACILITY_B}|${ITEM}`, { onHand: 0, rate: 0 }],
      ]),
    });

    const proposal = unmeasured.proposals[0]?.proposal;
    expect(proposal?.expectedImpact.donorDaysOfStockAfter).toBe(0);
    expect(proposal?.expectedImpact.receiverDaysOfStockAfter).toBe(0);
    expect(proposal?.expectedImpact.assumptions.join(' ')).toContain(
      'two-quantile-stock-projection',
    );
  });
});

describe('the two small readings the pipeline makes', () => {
  it('reads a daily rate as the mean over the horizon, and zero over nothing', () => {
    expect(dailyRateOf([1, 2, 3, 4])).toBe(2.5);
    expect(dailyRateOf([])).toBe(0);
  });

  it('names the first day the median path empties the shelf, or says the path does not', () => {
    expect(stockOutOnFrom({ asOf: AS_OF, onHand: 5, p50: [1, 1, 1, 1, 1, 1] })).toBe('2026-09-30');
    expect(stockOutOnFrom({ asOf: AS_OF, onHand: 100, p50: [1, 1] })).toBeNull();
    // A first day with no demand pushes the empty day out by one, rather than
    // reporting a stock-out that day has not asked for.
    expect(stockOutOnFrom({ asOf: AS_OF, onHand: 0, p50: [0, 3] })).toBe('2026-09-26');
  });
});
