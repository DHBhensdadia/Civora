import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COST_PER_UNIT_KM, IMPACT_METHOD, estimateImpact } from './impact';
import type { ReceiverDemand } from './impact';
import { TRANSPORT_COST_PER_UNIT_KM } from './planner';
import type { PlannedTransfer } from './planner';

/**
 * What a transfer is expected to buy — and the two cases that prove the
 * estimator is not a feel-good multiplier.
 *
 * The hand-computed cases below are the point. A stock projection is easy to
 * write and easy to write wrongly, so the first few tests work out the expected
 * unmet demand on paper and assert the number: a receiver holding nothing,
 * facing ten units a day for three days, is thirty units short; a load of twenty
 * landing on day one leaves ten units short, so it avoids twenty. If the
 * arithmetic drifts, these numbers move.
 *
 * The two that matter most for honesty are the ones where the answer is bad. A
 * load that lands after the shelf has emptied avoids nothing and its transport
 * is pure cost (`negative`), and a load that rescues one unit at the price of a
 * thousand kilometres is not worth the drive (`marginal`). An estimator that
 * cannot produce either is not measuring anything.
 */

const DONOR = facilityIdSchema.parse('fac-donor');
const RECEIVER = facilityIdSchema.parse('fac-receiver');
const ITEM = itemIdSchema.parse('item-paracetamol');

const aTransfer = (overrides: Partial<PlannedTransfer> = {}): PlannedTransfer => ({
  donorId: DONOR,
  receiverId: RECEIVER,
  itemId: ITEM,
  batchId: 'B-1',
  quantity: 20,
  distanceKm: 100,
  leadTimeDays: 0,
  shelfLifeOnArrivalDays: 460,
  expiresOn: '2027-12-31',
  coldChain: false,
  receiverWeight: 1,
  ...overrides,
});

const aDemand = (overrides: Partial<ReceiverDemand> = {}): ReceiverDemand => ({
  facilityId: RECEIVER,
  itemId: ITEM,
  onHandUnits: 0,
  p50: [10, 10, 10],
  p90: [10, 10, 10],
  shortfallProbability: 0,
  ...overrides,
});

const single = (transfer: PlannedTransfer, demand: ReceiverDemand) =>
  estimateImpact({ plan: [transfer], demands: [demand] });

describe('a transfer that lands in time', () => {
  it('avoids the units and the stock-out days the projection says it does', () => {
    const impact = single(aTransfer({ quantity: 20, distanceKm: 100, leadTimeDays: 0 }), aDemand());

    const only = impact.transfers[0];
    expect(only).toBeDefined();
    // Nothing on hand, ten a day for three days: thirty unmet, three days short.
    expect(only?.baselineUnmetDemand).toBe(30);
    expect(only?.expectedStockOutDaysAverted).toBe(2);
    // Twenty units landing on day one answer two of the three days: twenty unmet
    // avoided, one day still short.
    expect(only?.withTransferUnmetDemand).toBe(10);
    expect(only?.expectedUnmetDemandAvoided).toBe(20);
    expect(only?.assessment).toBe('beneficial');
    // 20 units × 100 km at the planner's own weight.
    expect(only?.transportCost).toBeCloseTo(20 * 100 * TRANSPORT_COST_PER_UNIT_KM, 6);
  });

  it('cannot avoid more than the demand that was going to go unmet anyway', () => {
    // A load far larger than the whole horizon's demand is bounded by the need.
    const impact = single(
      aTransfer({ quantity: 1_000, distanceKm: 10, leadTimeDays: 0 }),
      aDemand({ p50: [10, 10, 10], p90: [10, 10, 10] }),
    );
    expect(impact.transfers[0]?.expectedUnmetDemandAvoided).toBe(30);
    expect(impact.transfers[0]?.withTransferUnmetDemand).toBe(0);
  });
});

describe('the estimator can return a bad answer', () => {
  it('calls a load that lands after the shelf empties negative', () => {
    // A two-day horizon, a five-day journey: the stock runs out before it lands.
    const impact = single(
      aTransfer({ quantity: 50, distanceKm: 400, leadTimeDays: 5 }),
      aDemand({ p50: [10, 10], p90: [10, 10] }),
    );

    const only = impact.transfers[0];
    expect(only?.expectedUnmetDemandAvoided).toBe(0);
    expect(only?.assessment).toBe('negative');
    expect(only?.netBenefit).toBeLessThan(0);
    expect(only?.note).toContain('avoids no unmet demand');
  });

  it('calls a load that buys one unit over a thousand kilometres marginal', () => {
    const impact = single(
      aTransfer({ quantity: 1, distanceKm: 1_000, leadTimeDays: 0 }),
      aDemand({ p50: [1, 0, 0], p90: [1, 0, 0] }),
    );

    const only = impact.transfers[0];
    // It rescues the single unit — the answer is positive, not zero…
    expect(only?.expectedUnmetDemandAvoided).toBe(1);
    // …but it costs two units of transport to do it.
    expect(only?.transportCost).toBeCloseTo(2, 6);
    expect(only?.assessment).toBe('marginal');
  });
});

describe('the two forecast paths are combined, or the module says it could not', () => {
  it('weights the upper path by the measured shortfall probability', () => {
    // A median path with no demand and an upper path that wants ten a day, with a
    // shortfall probability of one — so the upper path is the whole estimate.
    const demand = aDemand({
      onHandUnits: 0,
      p50: [0, 0],
      p90: [10, 10],
      shortfallProbability: 1,
    });
    const atOne = single(aTransfer({ quantity: 10, leadTimeDays: 0 }), demand);
    expect(atOne.transfers[0]?.expectedUnmetDemandAvoided).toBe(10);
    expect(atOne.assumptions.weightedByShortfallProbability).toBe(true);

    // The same shapes with the probability at zero: the median path is all there
    // is, and it says nothing was needed.
    const atZero = single(aTransfer({ quantity: 10, leadTimeDays: 0 }), {
      ...demand,
      shortfallProbability: 0,
    });
    expect(atZero.transfers[0]?.expectedUnmetDemandAvoided).toBe(0);
  });

  it('reports the median path alone, and says so, when no probability was measured', () => {
    // A calm median path (ten a day) and a heavy upper path (fifty a day), with
    // a load of thirty. On the median the load clears both days; on the upper it
    // only takes the edge off, so the two paths disagree about the benefit and
    // the missing weight is the difference between them.
    const demand = aDemand({ p50: [10, 10], p90: [50, 50] });
    const unweighted = single(aTransfer({ quantity: 30, leadTimeDays: 0 }), {
      ...demand,
      shortfallProbability: null,
    });
    expect(unweighted.assumptions.weightedByShortfallProbability).toBe(false);
    // The median path alone: twenty units would have gone unmet, the load covers
    // them.
    expect(unweighted.transfers[0]?.expectedUnmetDemandAvoided).toBe(20);

    // Told the upper path was certain, the estimate moves — proving the missing
    // weight was a real omission and not a no-op.
    const weighted = single(aTransfer({ quantity: 30, leadTimeDays: 0 }), {
      ...demand,
      shortfallProbability: 1,
    });
    expect(weighted.transfers[0]?.expectedUnmetDemandAvoided).toBe(30);
  });

  it('projects over the shortest path the forecast actually carries', () => {
    const impact = single(
      aTransfer({ leadTimeDays: 0 }),
      aDemand({ p50: [10, 10, 10], p90: [10, 10] }),
    );
    expect(impact.assumptions.horizonDays).toBe(2);
  });
});

describe('what cannot be priced is named, not counted as zero', () => {
  it('leaves a receiver with no forecast out of the totals', () => {
    const impact = estimateImpact({
      plan: [aTransfer({ receiverId: facilityIdSchema.parse('fac-other') })],
      demands: [aDemand()],
    });

    expect(impact.transfers).toEqual([]);
    expect(impact.unquantified).toHaveLength(1);
    expect(impact.unquantified[0]?.reason).toContain('no forecast is stored');
    expect(impact.totalExpectedUnmetDemandAvoided).toBe(0);
  });

  it('treats a plan that moves nothing as an impact of nothing', () => {
    const impact = estimateImpact({ plan: [], demands: [aDemand()] });

    expect(impact.transfers).toEqual([]);
    expect(impact.totalNetBenefit).toBe(0);
    expect(impact.marginalOrNegative).toEqual([]);
    expect(impact.assumptions.horizonDays).toBe(0);
  });
});

describe('the assumptions travel with the number', () => {
  it('names the method, the scenarios and the cost weight', () => {
    const impact = single(aTransfer(), aDemand());

    expect(impact.assumptions.method).toBe(IMPACT_METHOD);
    expect(impact.assumptions.scenarios).toHaveLength(2);
    expect(impact.assumptions.costPerUnitKm).toBe(DEFAULT_COST_PER_UNIT_KM);
    // The report prices a kilometre the same way the objective does.
    expect(impact.assumptions.costPerUnitKm).toBe(TRANSPORT_COST_PER_UNIT_KM);
  });

  it('collects the transfers that are not worth making', () => {
    const impact = estimateImpact({
      plan: [
        aTransfer({ quantity: 20, distanceKm: 100, leadTimeDays: 0 }),
        aTransfer({ quantity: 50, distanceKm: 400, leadTimeDays: 5 }),
      ],
      demands: [aDemand({ p50: [10, 10], p90: [10, 10] })],
    });

    expect(impact.transfers).toHaveLength(2);
    expect(impact.marginalOrNegative).toHaveLength(1);
    expect(impact.marginalOrNegative[0]?.assessment).toBe('negative');
  });

  it('is deterministic: the same inputs give the same figures', () => {
    const build = (): ReturnType<typeof estimateImpact> =>
      estimateImpact({
        plan: [aTransfer()],
        demands: [aDemand({ shortfallProbability: 0.4, p90: [30, 20, 10] })],
      });

    expect(build()).toEqual(build());
  });
});
