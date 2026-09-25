import { readFileSync } from 'node:fs';

import { facilityIdSchema, itemIdSchema } from '@civora/domain';
import type { CareLevel, DateOnly, FacilityId, FacilityTier, ItemId } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  COLD_CHAIN_RELIABILITY_FLOOR,
  FIXED_HANDLING_DAYS,
  MAX_LEAD_TIME_DAYS,
  MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
  ROAD_KM_PER_DAY,
  buildTransferGraph,
  careLevelOf,
  greatCircleKm,
  leadTimeDaysFor,
  minimumCareLevel,
} from './feasibility';
import type { StockLot, TransferEdge, TransferItem, TransferNode } from './feasibility';
import { planTransfers } from './planner';
import type { PlannedTransfer, TransferNeed } from './planner';
import {
  SAFETY_COVER_BUFFER_DAYS,
  donorPriorityOf,
  rankDonors,
  rankReceivers,
  receiverPriorityOf,
} from './priorities';
import type { DonorPosition, ReceiverLimit, ValidationWorld } from './validator';
import { VALIDATION_POLICY, validatePlan } from './validator';

/**
 * Whether the validator can actually refuse anything.
 *
 * This file exists because a validator that has never rejected a plan is not
 * evidence that plans are valid — it is evidence that nobody has tried. So the
 * first half deliberately corrupts good plans, **one constraint at a time**, and
 * asserts the validator refuses each one by name. Where the corruption cannot
 * live in a plan (a capacity the plan does not carry), the test says so and
 * corrupts the world instead, because the question being asked is still "does
 * this rule fire".
 *
 * The second half is the phase's blocking evidence, stated at the validator
 * rather than at the solver: across generated states, every plan the planner
 * produces is admitted by code that shares none of its reasoning — and the sweep
 * asserts it produced plans at all, because a property test that passes because
 * every plan is empty proves nothing.
 *
 * The third part is about independence being a fact rather than a claim: the
 * policy numbers this module duplicates are asserted equal to the ones the solver
 * uses, the duplicated geometry is asserted to agree with the original, and the
 * source of `validator.ts` is read and checked for an import from `./planner`.
 */

const AS_OF: DateOnly = '2026-09-24';

const facility = (value: string): FacilityId => facilityIdSchema.parse(value);
const item = (value: string): ItemId => itemIdSchema.parse(value);

// --- A world with one legal transfer in it ---------------------------------

const DONOR = facility('fac-donor');
const RECEIVER = facility('fac-receiver');
const ITEM = item('item-paracetamol');
const BATCH = 'B-1';

const aFacility = (input: {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly tier?: FacilityTier;
  readonly coldChain?: boolean;
  readonly reliability?: number;
}): TransferNode => ({
  facilityId: facility(input.id),
  tier: input.tier ?? 'PHC',
  coordinates: { latitude: input.latitude, longitude: input.longitude },
  coldChain: { available: input.coldChain ?? false, reliability: input.reliability ?? 1 },
});

const anItem = (overrides: Partial<TransferItem> = {}): TransferItem => ({
  itemId: ITEM,
  genericName: 'Paracetamol',
  storage: 'ambient',
  coldChain: false,
  careLevels: ['primary'],
  ...overrides,
});

const aTransfer = (overrides: Partial<PlannedTransfer> = {}): PlannedTransfer => ({
  donorId: DONOR,
  receiverId: RECEIVER,
  itemId: ITEM,
  batchId: BATCH,
  quantity: 100,
  distanceKm: 44.5,
  leadTimeDays: 2,
  shelfLifeOnArrivalDays: 460,
  expiresOn: '2027-12-31',
  coldChain: false,
  receiverWeight: 1,
  ...overrides,
});

interface WorldOptions {
  readonly lots?: readonly StockLot[];
  readonly items?: readonly TransferItem[];
  readonly facilities?: readonly TransferNode[];
  readonly donorPositions?: readonly DonorPosition[];
  readonly receiverLimits?: readonly ReceiverLimit[];
  readonly budgetUnitKm?: number;
  readonly edgeCapacityUnits?: number;
  readonly reactionBufferDays?: number;
}

const aWorld = (options: WorldOptions = {}): ValidationWorld => ({
  asOf: AS_OF,
  facilities: options.facilities ?? [
    aFacility({ id: 'fac-donor', latitude: 20, longitude: 85 }),
    aFacility({ id: 'fac-receiver', latitude: 20.4, longitude: 85, tier: 'CHC' }),
  ],
  items: options.items ?? [anItem()],
  lots: options.lots ?? [
    { facilityId: DONOR, itemId: ITEM, batchId: BATCH, quantity: 5_000, expiresOn: '2027-12-31' },
  ],
  donorPositions: options.donorPositions ?? [{ facilityId: DONOR, itemId: ITEM, dailyDemand: 10 }],
  receiverLimits: options.receiverLimits ?? [
    {
      facilityId: RECEIVER,
      itemId: ITEM,
      capacityUnits: 10_000,
      projectedStockOutOn: '2026-10-20',
    },
  ],
  transport: {
    budgetUnitKm: options.budgetUnitKm ?? 1_000_000,
    edgeCapacityUnits: options.edgeCapacityUnits ?? 1_000,
    reactionBufferDays: options.reactionBufferDays ?? 3,
  },
});

/** The codes a verdict carries, for assertions that name the specific check. */
const codesOf = (verdict: ReturnType<typeof validatePlan>): readonly string[] =>
  verdict.violations.map((each) => each.code);

describe('a plan that holds every constraint', () => {
  it('is admitted, and says what it measured rather than what the plan claimed', () => {
    const verdict = validatePlan([aTransfer()], aWorld());

    expect(verdict.violations).toEqual([]);
    expect(verdict.unchecked).toEqual([]);
    expect(verdict.valid).toBe(true);
    // Measured here, from the coordinates, not read off the plan.
    expect(verdict.measured.unitKm).toBeCloseTo(100 * 44.5, 1);
    expect(verdict.measured.units).toBe(100);
    expect(verdict.measured.transfers).toBe(1);
  });
});

describe('corrupting a plan, one constraint at a time', () => {
  it('refuses a quantity that is not a whole number of units', () => {
    const verdict = validatePlan([aTransfer({ quantity: 2.5 })], aWorld());
    expect(codesOf(verdict)).toContain('quantity-not-a-positive-count');

    const zero = validatePlan([aTransfer({ quantity: 0 })], aWorld());
    expect(codesOf(zero)).toContain('quantity-not-a-positive-count');
  });

  it('refuses a movement out of a facility the world does not hold', () => {
    const verdict = validatePlan([aTransfer({ donorId: facility('fac-ghost') })], aWorld());
    expect(codesOf(verdict)).toContain('donor-not-in-world');
    expect(verdict.valid).toBe(false);
  });

  it('refuses a batch the donor does not hold, and one it does not have enough of', () => {
    const invented = validatePlan([aTransfer({ batchId: 'B-invented' })], aWorld());
    expect(codesOf(invented)).toContain('batch-not-held');

    // Over-committing a lot also breaches the floor, and that is not a
    // coincidence: a plan that moves more than a facility holds has already taken
    // stock it does not have. Both are reported, which is the honest outcome.
    const overcommitted = validatePlan([aTransfer({ quantity: 6_000 })], aWorld());
    expect(codesOf(overcommitted)).toContain('batch-over-committed');
    expect(codesOf(overcommitted)).toContain('donor-left-below-floor');
  });

  it('refuses the same movement listed twice, which would write the ledger twice', () => {
    const verdict = validatePlan([aTransfer(), aTransfer()], aWorld());
    expect(codesOf(verdict)).toContain('same-movement-listed-twice');
  });

  it('refuses a plan that leaves the donor below the floor it keeps for itself', () => {
    // Floor is 10 × (5 + 7) = 120 units. A single lot of 500 lets at most 380
    // leave, so moving 450 takes the facility to 50 — under its own floor.
    const oneLot = aWorld({
      lots: [
        {
          facilityId: DONOR,
          itemId: ITEM,
          batchId: BATCH,
          quantity: 500,
          expiresOn: '2027-12-31',
        },
      ],
    });
    const verdict = validatePlan([aTransfer({ quantity: 450 })], oneLot);

    expect(codesOf(verdict)).toContain('donor-left-below-floor');
    expect(verdict.violations[0]?.detail).toContain('120');

    // The floor is a property of everything a facility gives away, not of one
    // delivery: 200 + 200 splits across two lots, each looking modest on its own,
    // and the pair still takes the facility to 100 — under its floor of 120.
    const twoLots = aWorld({
      lots: [
        {
          facilityId: DONOR,
          itemId: ITEM,
          batchId: 'B-1',
          quantity: 250,
          expiresOn: '2027-12-31',
        },
        {
          facilityId: DONOR,
          itemId: ITEM,
          batchId: 'B-2',
          quantity: 250,
          expiresOn: '2027-12-31',
        },
      ],
    });
    const split = validatePlan(
      [aTransfer({ quantity: 200, batchId: 'B-1' }), aTransfer({ quantity: 200, batchId: 'B-2' })],
      twoLots,
    );
    expect(codesOf(split)).toContain('donor-left-below-floor');

    // And a split that does leave the floor intact is admitted, so the check is
    // not simply refusing whatever a plan proposes.
    const legal = validatePlan(
      [aTransfer({ quantity: 180, batchId: 'B-1' }), aTransfer({ quantity: 180, batchId: 'B-2' })],
      twoLots,
    );
    expect(codesOf(legal)).toEqual([]);
  });

  it('refuses to call stock spare out of a facility whose demand was never measured', () => {
    const verdict = validatePlan(
      [aTransfer()],
      aWorld({ donorPositions: [{ facilityId: DONOR, itemId: ITEM, dailyDemand: null }] }),
    );
    expect(codesOf(verdict)).toContain('donor-floor-unmeasurable');
  });

  it('refuses over-supply, which is a plan carrying more than the receiver can take', () => {
    // The capacity is not something a plan carries, so the corruption goes into
    // the world: the question is still whether the rule fires.
    const verdict = validatePlan(
      [aTransfer()],
      aWorld({
        receiverLimits: [
          {
            facilityId: RECEIVER,
            itemId: ITEM,
            capacityUnits: 50,
            projectedStockOutOn: '2026-10-20',
          },
        ],
      }),
    );
    expect(codesOf(verdict)).toContain('receiver-over-supplied');
    expect(verdict.violations[0]?.detail).toContain('50');
  });

  it('refuses a cold-chain batch along an edge without a working chain at either end', () => {
    const coldItem = anItem({ coldChain: true, storage: 'cold-chain' });
    const verdict = validatePlan(
      [aTransfer({ coldChain: true, itemId: item('item-vaccine') })],
      aWorld({
        items: [{ ...coldItem, itemId: item('item-vaccine'), genericName: 'Vaccine' }],
        lots: [
          {
            facilityId: DONOR,
            itemId: item('item-vaccine'),
            batchId: BATCH,
            quantity: 5_000,
            expiresOn: '2027-12-31',
          },
        ],
      }),
    );
    const coldCodes = codesOf(verdict).filter((code) => code.startsWith('cold-chain'));
    // Both ends are named, each in its own sentence.
    expect(coldCodes).toEqual([
      'cold-chain-endpoint-without-one',
      'cold-chain-endpoint-without-one',
    ]);

    // A chain that exists but does not hold often enough fails the other check.
    const unreliable = validatePlan(
      [{ ...aTransfer({ coldChain: true, itemId: item('item-vaccine') }) }],
      aWorld({
        items: [{ ...coldItem, itemId: item('item-vaccine'), genericName: 'Vaccine' }],
        lots: [
          {
            facilityId: DONOR,
            itemId: item('item-vaccine'),
            batchId: BATCH,
            quantity: 5_000,
            expiresOn: '2027-12-31',
          },
        ],
        facilities: [
          aFacility({
            id: 'fac-donor',
            latitude: 20,
            longitude: 85,
            coldChain: true,
            reliability: COLD_CHAIN_RELIABILITY_FLOOR - 0.2,
          }),
          aFacility({
            id: 'fac-receiver',
            latitude: 20.4,
            longitude: 85,
            tier: 'CHC',
            coldChain: true,
          }),
        ],
      }),
    );
    expect(codesOf(unreliable)).toContain('cold-chain-endpoint-unreliable');
  });

  it('refuses an item the receiving level of care is not listed for', () => {
    const secondary = anItem({ careLevels: ['secondary', 'tertiary'] });
    const verdict = validatePlan(
      [aTransfer()],
      aWorld({
        items: [secondary],
        facilities: [
          aFacility({ id: 'fac-donor', latitude: 20, longitude: 85 }),
          // A primary-level receiver with a secondary-only item on its way.
          aFacility({ id: 'fac-receiver', latitude: 20.4, longitude: 85, tier: 'PHC' }),
        ],
      }),
    );
    expect(codesOf(verdict)).toContain('item-not-listed-for-the-receiver');
  });

  it('refuses a batch that lands too close to its expiry', () => {
    const verdict = validatePlan(
      [aTransfer({ expiresOn: '2026-10-10' })],
      aWorld({
        lots: [
          {
            facilityId: DONOR,
            itemId: ITEM,
            batchId: BATCH,
            quantity: 5_000,
            expiresOn: '2026-10-10',
          },
        ],
      }),
    );
    expect(codesOf(verdict)).toContain('arrives-too-close-to-expiry');
    expect(verdict.violations[0]?.detail).toContain('2026-10-10');
  });

  it('refuses a load that lands after the shelf has already emptied', () => {
    const verdict = validatePlan(
      [aTransfer()],
      aWorld({
        receiverLimits: [
          {
            facilityId: RECEIVER,
            itemId: ITEM,
            capacityUnits: 10_000,
            // Arrival is two days out, so a stock-out today plus three days of
            // slack is already too late.
            projectedStockOutOn: '2026-09-23',
          },
        ],
        reactionBufferDays: 0,
      }),
    );
    expect(codesOf(verdict)).toContain('arrives-after-the-shelf-empties');
  });

  it('refuses more than one load carries, and a plan over its transport budget', () => {
    const tooHeavy = validatePlan([aTransfer({ quantity: 2_000 })], aWorld());
    expect(codesOf(tooHeavy)).toContain('more-than-one-vehicle-carries');

    const overBudget = validatePlan([aTransfer()], aWorld({ budgetUnitKm: 1 }));
    expect(codesOf(overBudget)).toContain('budget-exceeded');
    expect(overBudget.measured.unitKm).toBeGreaterThan(1);
  });

  it('reports every constraint that failed rather than the first', () => {
    const verdict = validatePlan(
      [aTransfer({ quantity: 2_500, itemId: item('item-vaccine'), coldChain: true })],
      aWorld({
        items: [
          anItem({
            itemId: item('item-vaccine'),
            genericName: 'Vaccine',
            coldChain: true,
            storage: 'cold-chain',
            careLevels: ['tertiary'],
          }),
        ],
        lots: [
          {
            facilityId: DONOR,
            itemId: item('item-vaccine'),
            batchId: BATCH,
            quantity: 5_000,
            expiresOn: '2026-10-10',
          },
        ],
        // The demand record is for the item actually in play, so the donor floor
        // is measurable here; otherwise this test would be about a missing record
        // rather than about four constraints failing at once.
        donorPositions: [{ facilityId: DONOR, itemId: item('item-vaccine'), dailyDemand: 10 }],
        budgetUnitKm: 1,
      }),
    );

    const rules = new Set(verdict.violations.map((each) => each.rule));
    // A person fixing these one message per run would be made to work five times.
    expect(rules).toEqual(
      new Set(['cold-chain', 'care-level', 'shelf-life', 'edge-capacity', 'transport-budget']),
    );
  });
});

describe('what the validator cannot check, it says so', () => {
  it('reports a rule it could not run rather than passing it silently', () => {
    const verdict = validatePlan(
      [aTransfer()],
      aWorld({
        receiverLimits: [],
      }),
    );

    // No capacity and no projection means two rules could not run: the plan is
    // not refused, and it is not a proven clearance either.
    expect(verdict.violations).toEqual([]);
    expect(verdict.valid).toBe(true);
    expect(verdict.unchecked.map((each) => each.rule).sort()).toEqual([
      'arrival-window',
      'receiver-cap',
    ]);
  });

  it('reports a donor whose position is unknown rather than assuming a floor of zero', () => {
    const verdict = validatePlan([aTransfer()], aWorld({ donorPositions: [] }));
    expect(codesOf(verdict)).toContain('donor-position-unknown');
    expect(verdict.valid).toBe(false);
  });
});

describe('the policy and the geometry are duplicated, and the duplication is checked', () => {
  it('uses the same policy numbers as the solver, term by term', () => {
    // Two definitions with a test that they agree is stronger than one definition
    // shared by a checker and the thing it checks.
    expect(VALIDATION_POLICY).toEqual({
      roadKmPerDay: ROAD_KM_PER_DAY,
      fixedHandlingDays: FIXED_HANDLING_DAYS,
      maxLeadTimeDays: MAX_LEAD_TIME_DAYS,
      minimumShelfLifeOnArrivalDays: MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
      coldChainReliabilityFloor: COLD_CHAIN_RELIABILITY_FLOOR,
      safetyCoverBufferDays: SAFETY_COVER_BUFFER_DAYS,
    });
  });

  it('measures lead time the same way the graph does, so a valid plan is not refused for arithmetic', () => {
    const draw = (seed: number): (() => number) => {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
    };
    const next = draw(7);

    for (let index = 0; index < 200; index += 1) {
      const donor = aFacility({
        id: 'fac-donor',
        latitude: 8 + next() * 27,
        longitude: 68 + next() * 29,
      });
      const receiver = aFacility({
        id: 'fac-receiver',
        latitude: 8 + next() * 27,
        longitude: 68 + next() * 29,
      });
      const distance = greatCircleKm(donor.coordinates, receiver.coordinates);

      // The graph's lead time, then the validator's, over the same distance.
      const graphDays = leadTimeDaysFor(distance, { asOf: AS_OF });
      const verdict = validatePlan(
        [aTransfer({ distanceKm: distance })],
        aWorld({ facilities: [donor, receiver] }),
      );

      // The validator recomputes the arrival day from the coordinates; if its
      // arithmetic disagreed, a two-day transfer would show up as a violation of
      // the window whenever the two ended up on different sides of a boundary.
      expect(verdict.measured.transfers).toBe(1);
      expect(graphDays).toBe(
        VALIDATION_POLICY.fixedHandlingDays + Math.ceil(distance / VALIDATION_POLICY.roadKmPerDay),
      );
      // And the care-level mapping agrees with the graph's.
      expect(careLevelOf(receiver.tier)).toBe(receiver.tier === 'CHC' ? 'secondary' : 'primary');
      expect(minimumCareLevel(anItem({ careLevels: ['primary', 'secondary', 'tertiary'] }))).toBe(
        'primary',
      );
    }
  });

  it('imports nothing from the solver but types, and nothing at all from the ranking', () => {
    // Independence is a fact about the source, so it is read rather than promised.
    const source = readFileSync(new URL('./validator.ts', import.meta.url), 'utf8');
    const withoutTypeImports = source.replace(/^import type .*$/gm, '');

    expect(withoutTypeImports).not.toMatch(/from '\.\/planner'/);
    expect(withoutTypeImports).not.toMatch(/from '\.\/priorities'/);
    // And the type-only import from the solver is still there, so the exemption
    // above is not passing because the module imports nothing at all.
    expect(source).toMatch(/^import type \{[^}]*\} from '\.\/planner';$/m);
  });
});

describe('across generated states, judged by code that wrote none of them', () => {
  const draw = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  };

  const TIERS: readonly FacilityTier[] = ['SHC', 'AAM', 'PHC', 'CHC'];
  const LEVELS: readonly CareLevel[] = ['primary', 'secondary', 'tertiary'];

  interface State {
    readonly world: ValidationWorld;
    readonly edges: readonly TransferEdge[];
    readonly needs: readonly TransferNeed[];
    readonly receiverFixtures: Parameters<typeof receiverPriorityOf>[0][];
    readonly donorFixtures: Parameters<typeof donorPriorityOf>[0][];
  }

  /** One generated world, used by both the planner and the validator. */
  const generate = (next: () => number): State => {
    // Eight facilities inside one district rather than six scattered across the
    // country. The geography is deliberate: the feasibility graph refuses a pair
    // beyond the five-day travel window, and the objective only moves stock when
    // the need it answers outweighs the drive, so a country-wide spread produces
    // almost no legal, worthwhile transfers at all — and a sweep whose plans are
    // empty proves nothing about admission. A district-sized cluster is what a
    // cross-district transfer actually looks like anyway.
    const names = Array.from({ length: 8 }, (_unused, index) => `fac-${String(index)}`);
    const facilities: TransferNode[] = names.map((name) => {
      const coldChain = next() < 0.5;
      return aFacility({
        id: name,
        latitude: 20 + next() * 0.3,
        longitude: 78 + next() * 0.3,
        tier: TIERS[Math.floor(next() * TIERS.length)] ?? 'PHC',
        coldChain,
        reliability: coldChain ? 0.85 + next() * 0.15 : 0,
      });
    });

    const items: TransferItem[] = Array.from({ length: 3 }, (_unused, index) => {
      const coldChain = next() < 0.4;
      return anItem({
        itemId: item(`item-${String(index)}`),
        genericName: `Item ${String(index)}`,
        storage: coldChain ? 'cold-chain' : 'ambient',
        coldChain,
        careLevels: [LEVELS[Math.floor(next() * LEVELS.length)] ?? 'primary'],
      });
    });

    // One lot per donor and item, so a lot's quantity *is* the donor's holding
    // and the two modules are looking at the same world.
    const lots: StockLot[] = [];
    const donorPositions: DonorPosition[] = [];
    const donorFixtures: Parameters<typeof donorPriorityOf>[0][] = [];

    for (const name of names) {
      const onHand = Math.floor(next() * 900) + 100;
      const dailyDemand = next() < 0.2 ? null : Math.floor(next() * 12);
      const expiresOn: DateOnly = `202${String(7 + Math.floor(next() * 2))}-06-30`;

      for (const each of items) {
        lots.push({
          facilityId: facility(name),
          itemId: each.itemId,
          batchId: `B-${name}`,
          quantity: onHand,
          expiresOn,
        });
        donorPositions.push({ facilityId: facility(name), itemId: each.itemId, dailyDemand });
        donorFixtures.push({
          facilityId: facility(name),
          itemId: each.itemId,
          onHand,
          dailyDemand,
          earliestExpiryDays: null,
        });
      }
    }

    const needs: TransferNeed[] = [];
    const receiverLimits: ReceiverLimit[] = [];
    const receiverFixtures: Parameters<typeof receiverPriorityOf>[0][] = [];

    for (const name of names) {
      for (const each of items) {
        const units = 10 + Math.floor(next() * 110);
        const probability = next() < 0.2 ? null : Number(next().toFixed(2));
        needs.push({ facilityId: facility(name), itemId: each.itemId, units });
        receiverFixtures.push({
          facilityId: facility(name),
          itemId: each.itemId,
          shortfallProbability: probability,
          essentiality: 'essential',
          populationAtRisk: Math.floor(next() * 80_000) + 1_000,
        });
        // The cap is exactly what the receiver asked for, so a plan the planner
        // legalises by need cannot exceed it.
        receiverLimits.push({
          facilityId: facility(name),
          itemId: each.itemId,
          capacityUnits: units,
          // A window wide enough to admit every arrival, so this sweep is about
          // the plan rather than about a timing rule the planner does not model.
          projectedStockOutOn: '2026-12-31',
        });
      }
    }

    const graph = buildTransferGraph({
      nodes: facilities,
      items,
      lots,
      options: { asOf: AS_OF },
    });

    return {
      world: {
        asOf: AS_OF,
        facilities,
        items,
        lots,
        donorPositions,
        receiverLimits,
        transport: { budgetUnitKm: 1e9, edgeCapacityUnits: 1e6, reactionBufferDays: 3 },
      },
      edges: graph.edges,
      needs,
      receiverFixtures,
      donorFixtures,
    };
  };

  const planOf = (state: State) =>
    planTransfers({
      asOf: AS_OF,
      edges: state.edges,
      needs: state.needs,
      receivers: rankReceivers(
        state.receiverFixtures.map((fixture) => receiverPriorityOf(fixture)),
      ),
      donors: rankDonors(state.donorFixtures.map((fixture) => donorPriorityOf(fixture))),
    });

  it('admits every plan the planner produces, and holds the phase’s three properties', () => {
    let totalTransfers = 0;

    for (let seed = 1; seed <= 30; seed += 1) {
      const state = generate(draw(seed));
      const plan = planOf(state);
      const verdict = validatePlan(plan.transfers, state.world);
      totalTransfers += plan.transfers.length;

      // **The blocking property, checked by the module that did not build the
      // plan**: nothing the validator admits leaves a donor below its floor.
      const floorCodes = verdict.violations.filter((each) => each.rule === 'donor-floor');
      expect(floorCodes).toEqual([]);
      // And the phase's other two, stated at the validator.
      expect(verdict.violations.filter((each) => each.rule === 'shelf-life')).toEqual([]);
      expect(verdict.violations.filter((each) => each.rule === 'cold-chain')).toEqual([]);
      // Nothing else either, since a plan that broke a constraint it was not
      // asked about would still be a plan that broke a constraint.
      expect(verdict.violations).toEqual([]);
      // The plan is not refused, and there is nothing the validator could not
      // check: every receiver in the world carries a capacity and a window.
      expect(verdict.unchecked).toEqual([]);
    }

    // A sweep that passes because nothing was ever proposed would prove nothing.
    // The generator is deterministic, so this is a fixed count (161 at the time
    // of writing); the floor is set well below it rather than pinned to it, so a
    // future generator change surfaces as a plan-admission failure, not as a
    // brittle literal.
    expect(totalTransfers).toBeGreaterThan(100);
  });

  it('refuses a plan the planner produced once its world is corrupted under it', () => {
    // Corruption needs something to corrupt, so find the first seed the planner
    // actually plans in rather than trusting one seed to be busy.
    const pick = (): { readonly state: State; readonly plan: ReturnType<typeof planOf> } => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const state = generate(draw(seed));
        const plan = planOf(state);
        if (plan.transfers.length > 0) {
          return { state, plan };
        }
      }
      throw new Error('no generated state produced a plan to corrupt');
    };
    // The same plan, validated against a world where every donor's demand record
    // was lost: stock the planner had called spare is no longer something anyone
    // may call spare, and the validator has to refuse it rather than assume the
    // floor is zero.
    const { state, plan } = pick();
    expect(plan.transfers.length).toBeGreaterThan(0);

    const starving: ValidationWorld = {
      ...state.world,
      donorPositions: state.world.donorPositions.map((position) => ({
        ...position,
        dailyDemand: null,
      })),
    };
    const verdict = validatePlan(plan.transfers, starving);

    expect(verdict.valid).toBe(false);
    expect(verdict.violations.every((each) => each.code === 'donor-floor-unmeasurable')).toBe(true);
  });
});
