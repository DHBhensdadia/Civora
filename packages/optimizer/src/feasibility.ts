import { daysBetween } from '@civora/domain';
import type {
  CareLevel,
  DateOnly,
  Facility,
  FacilityId,
  FacilityTier,
  ItemId,
  StorageClass,
} from '@civora/domain';

/**
 * Feasibility: which transfers are physically possible at all.
 *
 * The redistribution problem is modelled as a capacitated min-cost flow, and
 * this module builds its graph. It answers one question per candidate — *can this
 * batch get from here to there, and still be worth having when it lands* — and
 * nothing else. Quantities, priorities and benefit belong to the phases that
 * follow, because a graph built after a preference has already been applied
 * cannot be inspected for the preference.
 *
 * Everything here is a property of the pair and the batch, never of the plan:
 *
 *  - a cold-chain item cannot travel between facilities where the chain does not
 *    hold;
 *  - a batch must arrive with enough life left to be dispensed;
 *  - a load must not take longer than the network's own replenishment window;
 *  - a facility must be a level of care the item is listed for.
 *
 * Five assumptions are named as constants with the reasoning beside them, rather
 * than buried in the arithmetic. They are configuration because a district's
 * roads and a district's paperwork are local facts; they are constants here
 * because a number nobody can point at is a number nobody can argue with. The
 * caller may override any of them, and the report the planner prints carries the
 * set that was used.
 *
 * The module is pure: no clock, no network, no filesystem. `asOf` is an input so
 * that shelf-life arithmetic is reproducible, and the output is ordered so that
 * the same inputs produce a byte-identical graph on every run and in every
 * process.
 */

// --- Assumptions -----------------------------------------------------------

/**
 * How far a load travels in a day on the roads this platform plans over.
 *
 * A loaded vehicle on district roads, one day's driving, with no assumption of
 * night movement. Stated as an assumption because it is one: a hill district and
 * a plains district do not move stock at the same speed, and a real deployment
 * would replace this with a measured figure per road.
 */
export const ROAD_KM_PER_DAY = 150;

/**
 * Dispatch time before a vehicle moves.
 *
 * Indenting, packing, paperwork and loading. One day, because a transfer that
 * could leave the same hour it was approved is not what a district store does.
 */
export const FIXED_HANDLING_DAYS = 1;

/**
 * The longest a transfer may take and still be a redistribution rather than a
 * procurement.
 *
 * Five days, matching the replenishment window the rest of the platform already
 * assumes: a community health centre receives stock within five days, so a
 * transfer that takes longer arrives after an order placed today would have.
 * Beyond that the right answer is an order, not a truck.
 */
export const MAX_LEAD_TIME_DAYS = 5;

/**
 * Shelf life a batch must still have once it lands.
 *
 * Thirty days, which is the point at which a transferred batch is usable rather
 * than merely not-yet-expired: the receiving facility has to be able to dispense
 * it at its own rate, and a batch with a week left moves the expiry problem from
 * one store to another without treating a patient.
 */
export const MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS = 30;

/**
 * How often a facility's cold chain must actually hold temperature.
 *
 * A facility can own a refrigerator and still fail to keep a vaccine cold, which
 * is why the capability carries a reliability rather than a yes. Four in five
 * days is the floor below which a cold-chain item is not moved there: the
 * alternative is a batch that arrives legally and is unusable.
 */
export const COLD_CHAIN_RELIABILITY_FLOOR = 0.8;

/** The assumptions a graph was built with, so a report can print them. */
export interface FeasibilityOptions {
  /** The day the graph is built for. Shelf life is measured from here. */
  readonly asOf: DateOnly;
  readonly roadKmPerDay?: number;
  readonly fixedHandlingDays?: number;
  readonly maxLeadTimeDays?: number;
  readonly minimumShelfLifeOnArrivalDays?: number;
  readonly coldChainReliabilityFloor?: number;
}

interface ResolvedOptions {
  readonly roadKmPerDay: number;
  readonly fixedHandlingDays: number;
  readonly maxLeadTimeDays: number;
  readonly minimumShelfLifeOnArrivalDays: number;
  readonly coldChainReliabilityFloor: number;
}

// --- Inputs ----------------------------------------------------------------

/** A facility's position, as the network records it. */
export type FacilityPoint = Facility['coordinates'];

/** A facility that could send or receive. */
export interface TransferNode {
  readonly facilityId: FacilityId;
  readonly tier: FacilityTier;
  readonly coordinates: FacilityPoint;
  readonly coldChain: Facility['coldChain'];
}

/** The item attributes that constrain movement. A subset, deliberately. */
export interface TransferItem {
  readonly itemId: ItemId;
  readonly genericName: string;
  readonly storage: StorageClass;
  readonly coldChain: boolean;
  /** Levels of care the national list marks the item for. Never empty. */
  readonly careLevels: readonly CareLevel[];
}

/** One batch of one item held at one facility, with the day it expires. */
export interface StockLot {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
  readonly quantity: number;
  readonly expiresOn: DateOnly;
}

export interface FeasibilityInput {
  readonly nodes: readonly TransferNode[];
  readonly items: readonly TransferItem[];
  readonly lots: readonly StockLot[];
  readonly options: FeasibilityOptions;
}

/**
 * One lot offered along one edge.
 *
 * The lot carries the donor, the item, the batch, the quantity and the expiry;
 * a candidate adds only the far end. That is deliberately the whole of it: a
 * constraint verdict is about a pair and a batch, and a shape that also carried
 * a plan would let a preference leak into a check that is supposed to be blind
 * to preference.
 */
export interface TransferCandidate extends StockLot {
  readonly receiverId: FacilityId;
}

// --- Verdicts --------------------------------------------------------------

/**
 * The rules a candidate is checked against, in the order they are checked.
 *
 * Ordered from the most fundamental to the most local, which is also cheapest
 * first: a facility the graph does not hold cannot be asked about its
 * refrigerator, and a pair too far apart has no lead time worth computing shelf
 * life against. The first rule to fail decides the candidate's verdict, so a
 * refusal names one cause rather than a pile of them.
 */
export const FEASIBILITY_RULES = [
  'unknown-facility',
  'unknown-item',
  'cold-chain-capability',
  'cold-chain-reliability',
  'care-level',
  'lead-time',
  'shelf-life',
] as const;

export type FeasibilityRule = (typeof FEASIBILITY_RULES)[number];

/** Why one candidate transfer cannot be made, naming the values that decided it. */
export interface FeasibilityRefusal {
  readonly rule: FeasibilityRule;
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
  /** One sentence a person can check, carrying the measured values. */
  readonly detail: string;
}

/** One transfer that is physically possible, with what decided it. */
export interface TransferEdge {
  readonly donorId: FacilityId;
  readonly receiverId: FacilityId;
  readonly itemId: ItemId;
  readonly batchId: string;
  /** Units in the lot. An upper bound the solver may draw on, not a decision. */
  readonly quantity: number;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
  readonly expiresOn: DateOnly;
  /** Shelf life the batch would still have on arrival, in days. */
  readonly shelfLifeOnArrivalDays: number;
  readonly coldChain: boolean;
}

export interface TransferGraph {
  readonly asOf: DateOnly;
  /** Every feasible transfer, ordered so the same inputs give the same output. */
  readonly edges: readonly TransferEdge[];
  /**
   * How many candidates each rule removed.
   *
   * Kept because a thin graph is otherwise indistinguishable from a broken one:
   * when the planner proposes nothing, this says whether the cause was distance,
   * refrigeration, shelf life or a facility that was not in the node set.
   */
  readonly removedByRule: Readonly<Record<FeasibilityRule, number>>;
  /** Facilities named by a lot that the graph holds no node for. */
  readonly unknownFacilities: readonly FacilityId[];
  /** Items named by a lot that the graph holds no profile for. */
  readonly unknownItems: readonly ItemId[];
  /** The assumptions this graph was built with. */
  readonly assumptions: ResolvedOptions;
}

/**
 * One candidate, checked by every rule.
 *
 * `buildTransferGraph` reports only the first failure, because a graph is a
 * summary. The validator and the workbench need the whole picture for one pair —
 * which rules held and which did not — so that is a function of its own rather
 * than something reconstructed from a summary that has thrown the detail away.
 */
export interface FeasibilityVerdict {
  readonly feasible: boolean;
  readonly refusals: readonly FeasibilityRefusal[];
}

// --- Geometry and time -----------------------------------------------------

const EARTH_RADIUS_KM = 6371.0088;
const DEGREES_TO_RADIANS = Math.PI / 180;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Great-circle distance in kilometres, rounded to a tenth. */
export function greatCircleKm(from: FacilityPoint, to: FacilityPoint): number {
  const deltaLatitude = (to.latitude - from.latitude) * DEGREES_TO_RADIANS;
  const deltaLongitude = (to.longitude - from.longitude) * DEGREES_TO_RADIANS;
  const latitude1 = from.latitude * DEGREES_TO_RADIANS;
  const latitude2 = to.latitude * DEGREES_TO_RADIANS;

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;

  return round1(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine))));
}

/** Handling plus travel, for a distance in kilometres. */
export function leadTimeDaysFor(distanceKm: number, options: FeasibilityOptions): number {
  const resolved = resolveOptions(options);
  return resolved.fixedHandlingDays + Math.ceil(distanceKm / resolved.roadKmPerDay);
}

/**
 * The level of care a facility provides.
 *
 * Administrative rather than clinical, and stated here because a redistribution
 * constraint needs it: a primary health centre is a primary-level facility and a
 * community health centre carries secondary care. The community tier is primary
 * as well, which is why two tiers map to one level.
 */
export function careLevelOf(tier: FacilityTier): CareLevel {
  return tier === 'CHC' ? 'secondary' : 'primary';
}

const CARE_LEVEL_ORDER: Readonly<Record<CareLevel, number>> = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

/**
 * The lowest level of care an item belongs at.
 *
 * The national list marks each item with every level it is listed for, so the
 * lowest one is what decides who may hold it: an item marked primary and
 * secondary belongs at a primary facility, while one marked secondary and
 * tertiary does not. Taking the minimum rather than requiring an exact match is
 * what keeps a community health centre from being refused the primary-care items
 * it also dispenses.
 */
export function minimumCareLevel(item: TransferItem): CareLevel {
  return item.careLevels.reduce((lowest, level) =>
    CARE_LEVEL_ORDER[level] < CARE_LEVEL_ORDER[lowest] ? level : lowest,
  );
}

// --- The rules -------------------------------------------------------------

function resolveOptions(options: FeasibilityOptions): ResolvedOptions {
  return {
    roadKmPerDay: options.roadKmPerDay ?? ROAD_KM_PER_DAY,
    fixedHandlingDays: options.fixedHandlingDays ?? FIXED_HANDLING_DAYS,
    maxLeadTimeDays: options.maxLeadTimeDays ?? MAX_LEAD_TIME_DAYS,
    minimumShelfLifeOnArrivalDays:
      options.minimumShelfLifeOnArrivalDays ?? MINIMUM_SHELF_LIFE_ON_ARRIVAL_DAYS,
    coldChainReliabilityFloor: options.coldChainReliabilityFloor ?? COLD_CHAIN_RELIABILITY_FLOOR,
  };
}

const refusal = (
  rule: FeasibilityRule,
  donorId: FacilityId,
  receiverId: FacilityId,
  itemId: ItemId,
  batchId: string,
  detail: string,
): FeasibilityRefusal => ({ rule, donorId, receiverId, itemId, batchId, detail });

/**
 * Every rule that refuses this candidate, checked in order.
 *
 * An empty list means the transfer is physically possible. The list is a list
 * rather than a first failure because a workbench showing a rejected proposal
 * has to say everything that was wrong with it at once — a person who fixes the
 * cold chain only to be told about the shelf life has been made to work twice.
 */
export function feasibilityOf(input: {
  readonly candidate: TransferCandidate;
  readonly donor: TransferNode | undefined;
  readonly receiver: TransferNode | undefined;
  readonly item: TransferItem | undefined;
  readonly options: FeasibilityOptions;
}): FeasibilityVerdict {
  const { candidate, donor, receiver, item } = input;
  const { facilityId: donorId, receiverId, itemId, batchId } = candidate;
  const resolved = resolveOptions(input.options);
  const refusals: FeasibilityRefusal[] = [];

  // Nothing can be checked without the two nodes, and a check that cannot run is
  // reported rather than skipped: a candidate the graph cannot place is a
  // wiring problem, and one recorded as feasible would be read as a constraint
  // that held.
  if (donor === undefined || receiver === undefined) {
    const missing = donor === undefined ? donorId : receiverId;
    return {
      feasible: false,
      refusals: [
        refusal(
          'unknown-facility',
          donorId,
          receiverId,
          itemId,
          batchId,
          `the graph holds no node for ${missing}`,
        ),
      ],
    };
  }

  if (item === undefined) {
    return {
      feasible: false,
      refusals: [
        refusal(
          'unknown-item',
          donorId,
          receiverId,
          itemId,
          batchId,
          `the graph holds no item profile for ${itemId}`,
        ),
      ],
    };
  }

  const push = (rule: FeasibilityRule, detail: string): void => {
    refusals.push(refusal(rule, donorId, receiverId, itemId, batchId, detail));
  };

  // Both ends of a cold-chain movement are checked, and each gets its own
  // sentence: on a pair with a broken chain at either end, "the chain is broken"
  // is not an answer an officer can act on, while naming the end is.
  if (item.coldChain) {
    for (const node of [donor, receiver]) {
      if (!node.coldChain.available) {
        push(
          'cold-chain-capability',
          `${node.facilityId} has no working cold chain and ${item.genericName} is a cold-chain item`,
        );
      } else if (node.coldChain.reliability < resolved.coldChainReliabilityFloor) {
        push(
          'cold-chain-reliability',
          `${node.facilityId} holds temperature ${(node.coldChain.reliability * 100).toFixed(0)}% of days, below the ${(resolved.coldChainReliabilityFloor * 100).toFixed(0)}% floor`,
        );
      }
    }
  }

  const lowestLevel = minimumCareLevel(item);
  if (CARE_LEVEL_ORDER[lowestLevel] > CARE_LEVEL_ORDER[careLevelOf(receiver.tier)]) {
    push(
      'care-level',
      `${item.genericName} is listed from ${lowestLevel} care and ${receiver.facilityId} provides ${careLevelOf(receiver.tier)}`,
    );
  }

  const distanceKm = greatCircleKm(donor.coordinates, receiver.coordinates);
  const leadTimeDays = leadTimeDaysFor(distanceKm, input.options);

  if (leadTimeDays > resolved.maxLeadTimeDays) {
    push(
      'lead-time',
      `${distanceKm.toFixed(1)} km is ${leadTimeDays} days of travel, beyond the ${resolved.maxLeadTimeDays}-day window`,
    );
  }

  const shelfLifeOnArrivalDays = shelfLifeOnArrivalDaysFor(candidate, distanceKm, input.options);
  if (shelfLifeOnArrivalDays < resolved.minimumShelfLifeOnArrivalDays) {
    push(
      'shelf-life',
      `batch ${batchId} expires ${candidate.expiresOn}, leaving ${shelfLifeOnArrivalDays} days on arrival against a ${resolved.minimumShelfLifeOnArrivalDays}-day floor`,
    );
  }

  return { feasible: refusals.length === 0, refusals };
}

/**
 * Shelf life a batch would still have on the day it lands.
 *
 * One definition, used by the rule that refuses a candidate and by the edge that
 * admits one, so the number in a refusal and the number on an edge cannot drift
 * apart. Negative when the batch has already expired.
 */
export function shelfLifeOnArrivalDaysFor(
  lot: StockLot,
  distanceKm: number,
  options: FeasibilityOptions,
): number {
  return daysBetween(options.asOf, lot.expiresOn) - leadTimeDaysFor(distanceKm, options);
}

// --- The graph -------------------------------------------------------------

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const emptyRemovals = (): Record<FeasibilityRule, number> => ({
  'unknown-facility': 0,
  'unknown-item': 0,
  'cold-chain-capability': 0,
  'cold-chain-reliability': 0,
  'care-level': 0,
  'lead-time': 0,
  'shelf-life': 0,
});

/**
 * The directed transfer graph: every feasible (donor, receiver, batch) triple.
 *
 * A lot with no quantity is not a candidate at all and produces no refusal, for
 * the same reason the forecasting engine reports an unmeasurable rate as absent
 * rather than zero: a batch with nothing left in it is a statement about the
 * future, not a constraint that failed.
 *
 * A candidate's verdict is the *first* rule to fail, so the removals counted
 * here sum to the number of ruled-out pairs. That is a summary and it is
 * deliberately the only summary — `feasibilityOf` answers about one pair in
 * full, so nothing downstream has to infer a constraint from a count.
 */
export function buildTransferGraph(input: FeasibilityInput): TransferGraph {
  const nodesById = new Map(input.nodes.map((node) => [node.facilityId, node]));
  const itemsById = new Map(input.items.map((item) => [item.itemId, item]));
  const removedByRule = emptyRemovals();
  const unknownFacilities = new Set<FacilityId>();
  const unknownItems = new Set<ItemId>();
  const edges: TransferEdge[] = [];

  for (const lot of input.lots) {
    const donor = nodesById.get(lot.facilityId);
    const item = itemsById.get(lot.itemId);

    if (donor === undefined) {
      unknownFacilities.add(lot.facilityId);
    }
    if (item === undefined) {
      unknownItems.add(lot.itemId);
    }

    // A lot the graph cannot place is a wiring problem rather than a constraint
    // that failed, and it is recorded as one: every receiver it might have gone
    // to is removed under the same rule, so the counts stay complete.
    if (donor === undefined || item === undefined) {
      const rule: FeasibilityRule = donor === undefined ? 'unknown-facility' : 'unknown-item';
      removedByRule[rule] += input.nodes.filter(
        (node) => node.facilityId !== lot.facilityId,
      ).length;
      continue;
    }

    // A lot with nothing left in it is a statement about the future, not a
    // constraint that failed, so it is not a candidate and is counted nowhere.
    if (lot.quantity <= 0) {
      continue;
    }

    for (const receiver of input.nodes) {
      // A transfer to itself is not a constrained transfer, it is not a
      // transfer. Counted nowhere, so the removals stay about constraints.
      if (receiver.facilityId === lot.facilityId) {
        continue;
      }

      const verdict = feasibilityOf({
        candidate: { ...lot, receiverId: receiver.facilityId },
        donor,
        receiver,
        item,
        options: input.options,
      });

      if (!verdict.feasible) {
        const first = verdict.refusals[0];
        if (first !== undefined) {
          removedByRule[first.rule] += 1;
        }
        continue;
      }

      const distanceKm = greatCircleKm(donor.coordinates, receiver.coordinates);
      const leadTimeDays = leadTimeDaysFor(distanceKm, input.options);

      edges.push({
        donorId: donor.facilityId,
        receiverId: receiver.facilityId,
        itemId: item.itemId,
        batchId: lot.batchId,
        quantity: lot.quantity,
        distanceKm,
        leadTimeDays,
        expiresOn: lot.expiresOn,
        shelfLifeOnArrivalDays: shelfLifeOnArrivalDaysFor(lot, distanceKm, input.options),
        coldChain: item.coldChain,
      });
    }
  }

  edges.sort(
    (left, right) =>
      compareText(left.donorId, right.donorId) ||
      compareText(left.receiverId, right.receiverId) ||
      compareText(left.itemId, right.itemId) ||
      compareText(left.batchId, right.batchId),
  );

  return {
    asOf: input.options.asOf,
    edges,
    removedByRule,
    unknownFacilities: [...unknownFacilities].sort(),
    unknownItems: [...unknownItems].sort(),
    assumptions: resolveOptions(input.options),
  };
}
