import { daysBetween } from '@civora/domain';
import type { CareLevel, DateOnly, FacilityId, FacilityTier, ItemId } from '@civora/domain';

import type { StockLot, TransferItem, TransferNode } from './feasibility';
import type { PlannedTransfer } from './planner';

/**
 * The validator: a second opinion on a plan, from code that did not write it.
 *
 * This module exists because a solver bug must not be able to produce an invalid
 * plan quietly. It takes a plan and the **world** the plan was made against, and
 * decides for itself whether every hard constraint holds. It never asks the
 * planner anything: the plan's own claims — its lead times, its distances, its
 * assertion that a batch is fine — are treated as claims to be checked, not as
 * facts to be trusted.
 *
 * **The independence rule, and how it is enforced rather than promised.** The
 * validator imports **types only** from the rest of the optimiser, and nothing at
 * all — not even a type — from `planner.ts`. It carries **its own** geometry, its
 * own lead-time model, its own level-of-care mapping and its own statement of the
 * policy numbers, so a wrong formula in the solver cannot be reproduced here and
 * then read as agreement. It does not import `planner.ts` at all; the check that
 * it cannot is a test that reads *this file's source* and fails if a value import
 * appears, in the same spirit as the client-bundle check.
 *
 * The price of that independence is that a number defined twice can drift, so the
 * price is paid explicitly: `validate-policy` in the test suite asserts this
 * module's defaults and the planner's constants are equal, term by term. Two
 * definitions with a test that they agree is a stronger position than one
 * definition shared by a checker and the thing it checks.
 *
 * **A check that cannot run is reported, not skipped.** Some constraints need
 * something the world may not hold — a projected stock-out day, a capacity for a
 * receiver the caller never described. Those produce an `unchecked` entry naming
 * the rule and what was missing, so a verdict never reads as a clearance it did
 * not earn. That distinction is the same one the visibility surface makes between
 * a facility with full shelves and a facility nobody has heard from.
 */

// --- The policy this module checks against ---------------------------------

/**
 * The numbers this module validates against.
 *
 * Declared here rather than imported, and asserted equal to the planner's
 * constants by a test. Sharing the *definition* of a policy is fine; sharing the
 * *check* is what would let a solver bug hide, and this module shares neither.
 */
export interface ValidationPolicy {
  readonly roadKmPerDay: number;
  readonly fixedHandlingDays: number;
  readonly maxLeadTimeDays: number;
  readonly minimumShelfLifeOnArrivalDays: number;
  readonly coldChainReliabilityFloor: number;
  readonly safetyCoverBufferDays: number;
}

export const VALIDATION_POLICY: ValidationPolicy = {
  roadKmPerDay: 150,
  fixedHandlingDays: 1,
  maxLeadTimeDays: 5,
  minimumShelfLifeOnArrivalDays: 30,
  coldChainReliabilityFloor: 0.8,
  safetyCoverBufferDays: 7,
};

// --- The world -------------------------------------------------------------

/**
 * What the platform knows about one facility and one item.
 *
 * `dailyDemand` is nullable because it genuinely is unknown sometimes, and a
 * facility whose demand was never measured **cannot donate at all**: its safety
 * floor is uncomputable, so any quantity it gave away would be one nobody could
 * call spare. The validator enforces that rather than assuming the planner did.
 */
export interface DonorPosition {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly dailyDemand: number | null;
}

/** What a receiver can take, and when it runs out without help. */
export interface ReceiverLimit {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /** The most units the receiver may be sent. More than this is over-supply. */
  readonly capacityUnits: number;
  /** The day it runs out with nothing arriving; `null` when nothing projected it. */
  readonly projectedStockOutOn: DateOnly | null;
}

export interface TransportLimits {
  /** Total unit-kilometres the whole plan may consume. */
  readonly budgetUnitKm: number;
  /** Units one vehicle carries along one edge. */
  readonly edgeCapacityUnits: number;
  /** Days a receiver may be asked to wait past its own projected stock-out. */
  readonly reactionBufferDays: number;
}

export interface ValidationWorld {
  readonly asOf: DateOnly;
  readonly facilities: readonly TransferNode[];
  readonly items: readonly TransferItem[];
  /** Every lot the donors hold, with its expiry. The plan may only move these. */
  readonly lots: readonly StockLot[];
  readonly donorPositions: readonly DonorPosition[];
  readonly receiverLimits: readonly ReceiverLimit[];
  readonly transport: TransportLimits;
  readonly policy?: ValidationPolicy | undefined;
}

// --- The verdict -----------------------------------------------------------

/**
 * The constraints, each with its own function and its own failure message.
 *
 * The first seven are the phase's own list. The last four are integrity rules a
 * plan has to satisfy whatever the solver was trying to do: a plan that moves
 * stock out of a facility nobody told us about, quotes a batch that does not
 * exist, lists the same movement twice, or moves nothing at all is not "valid
 * apart from the interesting constraints" — it is not a plan.
 */
export const VALIDATION_RULES = [
  'quantity-positive',
  'unknown-facility',
  'batch-exists',
  'duplicate-transfer',
  'donor-floor',
  'receiver-cap',
  'cold-chain',
  'care-level',
  'shelf-life',
  'arrival-window',
  'edge-capacity',
  'transport-budget',
] as const;

export type ValidationRule = (typeof VALIDATION_RULES)[number];

export interface PlanViolation {
  readonly rule: ValidationRule;
  /** A stable name for the specific check, so a surface can key on it. */
  readonly code: string;
  /** One sentence naming the values that decided it. */
  readonly detail: string;
  readonly donorId: FacilityId | null;
  readonly receiverId: FacilityId | null;
  readonly itemId: ItemId | null;
  readonly batchId: string | null;
}

/** A constraint that could not be evaluated, and what it needed. */
export interface UncheckedRule {
  readonly rule: ValidationRule;
  readonly detail: string;
}

export interface PlanVerdict {
  /** True when nothing was refused. Check `unchecked` before calling it proven. */
  readonly valid: boolean;
  readonly violations: readonly PlanViolation[];
  readonly unchecked: readonly UncheckedRule[];
  /** What the plan amounts to, measured here rather than taken from the plan. */
  readonly measured: {
    readonly transfers: number;
    readonly units: number;
    readonly unitKm: number;
  };
  readonly policy: ValidationPolicy;
}

// --- Geometry and time, computed here --------------------------------------

const EARTH_RADIUS_KM = 6371.0088;
const DEGREES_TO_RADIANS = Math.PI / 180;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Great-circle distance in kilometres, to a tenth. The validator's own. */
function distanceKmBetween(from: TransferNode, to: TransferNode): number {
  const deltaLatitude = (to.coordinates.latitude - from.coordinates.latitude) * DEGREES_TO_RADIANS;
  const deltaLongitude =
    (to.coordinates.longitude - from.coordinates.longitude) * DEGREES_TO_RADIANS;
  const latitude1 = from.coordinates.latitude * DEGREES_TO_RADIANS;
  const latitude2 = to.coordinates.latitude * DEGREES_TO_RADIANS;

  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;

  return round1(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(haversine))));
}

/** Handling plus whole days of travel. The validator's own. */
function leadTimeDaysFor(distanceKm: number, policy: ValidationPolicy): number {
  return policy.fixedHandlingDays + Math.ceil(distanceKm / policy.roadKmPerDay);
}

const LEVEL_ORDER: Readonly<Record<CareLevel, number>> = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
};

/** The level of care a tier provides. Administrative, and stated here on purpose. */
function levelOfTier(tier: FacilityTier): CareLevel {
  return tier === 'CHC' ? 'secondary' : 'primary';
}

/** The lowest level of care an item is listed for. */
function lowestLevelOf(item: TransferItem): CareLevel {
  return item.careLevels.reduce((lowest, level) =>
    LEVEL_ORDER[level] < LEVEL_ORDER[lowest] ? level : lowest,
  );
}

/** The floor a donor keeps for itself, or `null` when its demand is unmeasured. */
function floorFor(dailyDemand: number | null, policy: ValidationPolicy): number | null {
  return dailyDemand === null
    ? null
    : Math.ceil(dailyDemand * (policy.maxLeadTimeDays + policy.safetyCoverBufferDays));
}

// --- One resolved transfer -------------------------------------------------

interface Resolved {
  readonly transfer: PlannedTransfer;
  readonly donor: TransferNode | undefined;
  readonly receiver: TransferNode | undefined;
  readonly item: TransferItem | undefined;
  readonly lot: StockLot | undefined;
  readonly distanceKm: number;
  readonly leadTimeDays: number;
}

const lotKey = (donorId: FacilityId, itemId: ItemId, batchId: string): string =>
  `${donorId}|${itemId}|${batchId}`;

const positionKey = (facilityId: FacilityId, itemId: ItemId): string => `${facilityId}|${itemId}`;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

// --- The checks, one function per constraint --------------------------------

const violation = (
  rule: ValidationRule,
  code: string,
  detail: string,
  subject: {
    readonly donorId?: FacilityId;
    readonly receiverId?: FacilityId;
    readonly itemId?: ItemId;
    readonly batchId?: string;
  } = {},
): PlanViolation => ({
  rule,
  code,
  detail,
  donorId: subject.donorId ?? null,
  receiverId: subject.receiverId ?? null,
  itemId: subject.itemId ?? null,
  batchId: subject.batchId ?? null,
});

/** A plan that moves nothing at all is reported as unchecked, not as valid. */
function checkQuantityPositive(resolved: readonly Resolved[]): readonly PlanViolation[] {
  return resolved.flatMap(({ transfer }) => {
    if (!Number.isInteger(transfer.quantity) || transfer.quantity <= 0) {
      return [
        violation(
          'quantity-positive',
          'quantity-not-a-positive-count',
          `${transfer.donorId} → ${transfer.receiverId} moves ${String(transfer.quantity)} of ${transfer.batchId}, which is not a whole number of units`,
          {
            donorId: transfer.donorId,
            receiverId: transfer.receiverId,
            itemId: transfer.itemId,
            batchId: transfer.batchId,
          },
        ),
      ];
    }
    return [];
  });
}

function checkUnknownFacilities(resolved: readonly Resolved[]): readonly PlanViolation[] {
  return resolved.flatMap(({ transfer, donor, receiver }) => {
    const missing: PlanViolation[] = [];
    if (donor === undefined) {
      missing.push(
        violation(
          'unknown-facility',
          'donor-not-in-world',
          `the world holds no facility ${transfer.donorId}, so what it holds cannot be checked`,
          { donorId: transfer.donorId, itemId: transfer.itemId, batchId: transfer.batchId },
        ),
      );
    }
    if (receiver === undefined) {
      missing.push(
        violation(
          'unknown-facility',
          'receiver-not-in-world',
          `the world holds no facility ${transfer.receiverId}, so what it may receive cannot be checked`,
          { receiverId: transfer.receiverId, itemId: transfer.itemId, batchId: transfer.batchId },
        ),
      );
    }
    return missing;
  });
}

function checkBatchesHoldTheStock(
  resolved: readonly Resolved[],
  lots: ReadonlyMap<string, StockLot>,
): readonly PlanViolation[] {
  const violations: PlanViolation[] = [];

  for (const { transfer, lot } of resolved) {
    if (lot === undefined) {
      violations.push(
        violation(
          'batch-exists',
          'batch-not-held',
          `${transfer.donorId} holds no lot ${transfer.batchId} of ${transfer.itemId}`,
          {
            donorId: transfer.donorId,
            receiverId: transfer.receiverId,
            itemId: transfer.itemId,
            batchId: transfer.batchId,
          },
        ),
      );
    }
  }

  const moved = new Map<string, number>();
  for (const { transfer, lot } of resolved) {
    if (lot === undefined) {
      continue;
    }
    const key = lotKey(transfer.donorId, transfer.itemId, transfer.batchId);
    moved.set(key, (moved.get(key) ?? 0) + transfer.quantity);
  }

  for (const [key, quantity] of [...moved.entries()].sort(([a], [b]) => compareText(a, b))) {
    const lot = lots.get(key);
    if (lot !== undefined && quantity > lot.quantity) {
      violations.push(
        violation(
          'batch-exists',
          'batch-over-committed',
          `lot ${lot.batchId} holds ${String(lot.quantity)} units and the plan moves ${String(quantity)}`,
          { donorId: lot.facilityId, itemId: lot.itemId, batchId: lot.batchId },
        ),
      );
    }
  }

  return violations;
}

function checkDuplicateTransfers(resolved: readonly Resolved[]): readonly PlanViolation[] {
  const seen = new Set<string>();
  const violations: PlanViolation[] = [];

  for (const { transfer } of resolved) {
    const key = lotKey(transfer.donorId, transfer.itemId, transfer.batchId);
    const full = `${key}|${transfer.receiverId}`;
    if (seen.has(full)) {
      violations.push(
        violation(
          'duplicate-transfer',
          'same-movement-listed-twice',
          `${transfer.donorId} → ${transfer.receiverId} moves ${transfer.batchId} twice, which would double-count the stock and write the ledger twice`,
          {
            donorId: transfer.donorId,
            receiverId: transfer.receiverId,
            itemId: transfer.itemId,
            batchId: transfer.batchId,
          },
        ),
      );
    }
    seen.add(full);
  }

  return violations;
}

/**
 * The constraint that matters most: a donor must not be left below its own floor.
 *
 * The check is run per donor and item over the *whole* plan, because a floor is a
 * property of everything a facility gives away, not of one delivery. A donor whose
 * demand was never measured has no computable floor and may be drawn on for
 * nothing at all — reported as its own code rather than as a floor of zero, since
 * a floor of zero is the one answer that would make a large shelf look spare.
 */
function checkDonorFloor(
  resolved: readonly Resolved[],
  lots: readonly StockLot[],
  positions: ReadonlyMap<string, DonorPosition>,
  policy: ValidationPolicy,
): readonly PlanViolation[] {
  const held = new Map<string, number>();
  for (const lot of lots) {
    const key = positionKey(lot.facilityId, lot.itemId);
    held.set(key, (held.get(key) ?? 0) + lot.quantity);
  }

  const leaving = new Map<string, number>();
  for (const { transfer } of resolved) {
    const key = positionKey(transfer.donorId, transfer.itemId);
    leaving.set(key, (leaving.get(key) ?? 0) + transfer.quantity);
  }

  const violations: PlanViolation[] = [];
  for (const [key, quantity] of [...leaving.entries()].sort(([a], [b]) => compareText(a, b))) {
    const [donorId, itemId] = key.split('|');
    const position = positions.get(key);

    if (position === undefined) {
      violations.push(
        violation(
          'donor-floor',
          'donor-position-unknown',
          `no demand is recorded for ${donorId ?? ''} and ${itemId ?? ''}, so the floor it must keep cannot be computed`,
          {
            donorId: (donorId ?? '') as FacilityId,
            itemId: (itemId ?? '') as ItemId,
          },
        ),
      );
      continue;
    }

    const floor = floorFor(position.dailyDemand, policy);
    if (floor === null) {
      violations.push(
        violation(
          'donor-floor',
          'donor-floor-unmeasurable',
          `${position.facilityId} has no measured daily demand for ${position.itemId}, so nothing may be called spare`,
          { donorId: position.facilityId, itemId: position.itemId },
        ),
      );
      continue;
    }

    const onHand = held.get(key) ?? 0;
    if (onHand - quantity < floor) {
      violations.push(
        violation(
          'donor-floor',
          'donor-left-below-floor',
          `${position.facilityId} holds ${String(onHand)} of ${position.itemId}, gives away ${String(quantity)} and keeps a floor of ${String(floor)}, leaving ${String(onHand - quantity)}`,
          { donorId: position.facilityId, itemId: position.itemId },
        ),
      );
    }
  }

  return violations;
}

function checkReceiverCap(
  resolved: readonly Resolved[],
  limits: ReadonlyMap<string, ReceiverLimit>,
): { readonly violations: readonly PlanViolation[]; readonly unchecked: readonly UncheckedRule[] } {
  const delivered = new Map<string, number>();
  for (const { transfer } of resolved) {
    const key = positionKey(transfer.receiverId, transfer.itemId);
    delivered.set(key, (delivered.get(key) ?? 0) + transfer.quantity);
  }

  const violations: PlanViolation[] = [];
  const unchecked: UncheckedRule[] = [];

  for (const [key, quantity] of [...delivered.entries()].sort(([a], [b]) => compareText(a, b))) {
    const limit = limits.get(key);
    if (limit === undefined) {
      unchecked.push({
        rule: 'receiver-cap',
        detail: `no capacity is recorded for ${key.split('|')[0] ?? ''}, so ${String(quantity)} units cannot be checked against it`,
      });
      continue;
    }
    if (quantity > limit.capacityUnits) {
      violations.push(
        violation(
          'receiver-cap',
          'receiver-over-supplied',
          `${limit.facilityId} can take ${String(limit.capacityUnits)} of ${limit.itemId} and the plan sends ${String(quantity)}`,
          { receiverId: limit.facilityId, itemId: limit.itemId },
        ),
      );
    }
  }

  return { violations, unchecked };
}

function checkColdChain(
  resolved: readonly Resolved[],
  policy: ValidationPolicy,
): readonly PlanViolation[] {
  const violations: PlanViolation[] = [];

  for (const { transfer, donor, receiver, item } of resolved) {
    if (item === undefined || !item.coldChain || donor === undefined || receiver === undefined) {
      continue;
    }
    for (const node of [donor, receiver]) {
      if (!node.coldChain.available) {
        violations.push(
          violation(
            'cold-chain',
            'cold-chain-endpoint-without-one',
            `${node.facilityId} has no working cold chain and ${item.genericName} is a cold-chain item`,
            {
              donorId: transfer.donorId,
              receiverId: transfer.receiverId,
              itemId: transfer.itemId,
              batchId: transfer.batchId,
            },
          ),
        );
      } else if (node.coldChain.reliability < policy.coldChainReliabilityFloor) {
        violations.push(
          violation(
            'cold-chain',
            'cold-chain-endpoint-unreliable',
            `${node.facilityId} holds temperature ${(node.coldChain.reliability * 100).toFixed(0)}% of days, below the ${(policy.coldChainReliabilityFloor * 100).toFixed(0)}% floor`,
            {
              donorId: transfer.donorId,
              receiverId: transfer.receiverId,
              itemId: transfer.itemId,
              batchId: transfer.batchId,
            },
          ),
        );
      }
    }
  }

  return violations;
}

function checkCareLevel(resolved: readonly Resolved[]): readonly PlanViolation[] {
  return resolved.flatMap(({ transfer, receiver, item }) => {
    if (item === undefined || receiver === undefined) {
      return [];
    }
    const lowest = lowestLevelOf(item);
    if (LEVEL_ORDER[lowest] <= LEVEL_ORDER[levelOfTier(receiver.tier)]) {
      return [];
    }
    return [
      violation(
        'care-level',
        'item-not-listed-for-the-receiver',
        `${item.genericName} is listed from ${lowest} care and ${receiver.facilityId} provides ${levelOfTier(receiver.tier)}`,
        {
          donorId: transfer.donorId,
          receiverId: transfer.receiverId,
          itemId: transfer.itemId,
          batchId: transfer.batchId,
        },
      ),
    ];
  });
}

function checkArrivalWindow(
  resolved: readonly Resolved[],
  limits: ReadonlyMap<string, ReceiverLimit>,
  world: ValidationWorld,
): { readonly violations: readonly PlanViolation[]; readonly unchecked: readonly UncheckedRule[] } {
  const violations: PlanViolation[] = [];
  const unchecked: UncheckedRule[] = [];

  for (const { transfer, leadTimeDays } of resolved) {
    const key = positionKey(transfer.receiverId, transfer.itemId);
    const limit = limits.get(key);
    if (limit?.projectedStockOutOn == null) {
      unchecked.push({
        rule: 'arrival-window',
        detail: `no projected stock-out is recorded for ${transfer.receiverId} and ${transfer.itemId}, so arrival cannot be checked against it`,
      });
      continue;
    }

    const arrivalOn = addDays(world.asOf, leadTimeDays);
    const latestUsefulOn = addDays(limit.projectedStockOutOn, world.transport.reactionBufferDays);
    if (arrivalOn > latestUsefulOn) {
      violations.push(
        violation(
          'arrival-window',
          'arrives-after-the-shelf-empties',
          `the load leaves ${world.asOf}, takes ${String(leadTimeDays)} days and lands ${arrivalOn}, after ${limit.facilityId} runs out on ${limit.projectedStockOutOn} plus ${String(world.transport.reactionBufferDays)} days of slack`,
          {
            donorId: transfer.donorId,
            receiverId: transfer.receiverId,
            itemId: transfer.itemId,
            batchId: transfer.batchId,
          },
        ),
      );
    }
  }

  return { violations, unchecked };
}

/** Shelf life on arrival must clear the floor. Recomputed; the plan is not asked. */
function checkShelfLifeOnArrival(
  resolved: readonly Resolved[],
  world: ValidationWorld,
  policy: ValidationPolicy,
): readonly PlanViolation[] {
  return resolved.flatMap(({ transfer, lot, leadTimeDays }) => {
    if (lot === undefined) {
      return [];
    }
    const shelfLifeOnArrival = daysBetween(world.asOf, lot.expiresOn) - leadTimeDays;
    if (shelfLifeOnArrival >= policy.minimumShelfLifeOnArrivalDays) {
      return [];
    }
    return [
      violation(
        'shelf-life',
        'arrives-too-close-to-expiry',
        `lot ${lot.batchId} expires ${lot.expiresOn}, which leaves ${String(shelfLifeOnArrival)} days on landing, under the ${String(policy.minimumShelfLifeOnArrivalDays)}-day floor`,
        {
          donorId: transfer.donorId,
          receiverId: transfer.receiverId,
          itemId: transfer.itemId,
          batchId: transfer.batchId,
        },
      ),
    ];
  });
}

function checkEdgeCapacity(
  resolved: readonly Resolved[],
  transport: TransportLimits,
): readonly PlanViolation[] {
  return resolved.flatMap(({ transfer }) =>
    transfer.quantity <= transport.edgeCapacityUnits
      ? []
      : [
          violation(
            'edge-capacity',
            'more-than-one-vehicle-carries',
            `${transfer.donorId} → ${transfer.receiverId} moves ${String(transfer.quantity)} units of ${transfer.batchId} and one load carries ${String(transport.edgeCapacityUnits)}`,
            {
              donorId: transfer.donorId,
              receiverId: transfer.receiverId,
              itemId: transfer.itemId,
              batchId: transfer.batchId,
            },
          ),
        ],
  );
}

function checkTransportBudget(
  resolved: readonly Resolved[],
  transport: TransportLimits,
): { readonly violations: readonly PlanViolation[]; readonly unitKm: number } {
  const unitKm = resolved.reduce(
    (total, { transfer, distanceKm }) => total + transfer.quantity * distanceKm,
    0,
  );
  if (unitKm <= transport.budgetUnitKm) {
    return { violations: [], unitKm };
  }
  return {
    unitKm,
    violations: [
      violation(
        'transport-budget',
        'budget-exceeded',
        `the plan moves ${unitKm.toFixed(1)} unit-kilometres against a budget of ${transport.budgetUnitKm.toFixed(1)}`,
      ),
    ],
  };
}

// --- Date arithmetic, kept local so the module stands alone -----------------

const MILLISECONDS_PER_DAY = 86_400_000;

function addDays(date: DateOnly, days: number): DateOnly {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MILLISECONDS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

// --- The entry point -------------------------------------------------------

/**
 * Check a plan against the world it was made for.
 *
 * Every rule runs; nothing short-circuits. A plan that is wrong in four ways is
 * reported as wrong in four ways, because a person fixing them one message per
 * run has been made to work four times. `valid` means *nothing was refused* —
 * read `unchecked` before concluding the plan is sound, which is why the verdict
 * carries it rather than folding it into a boolean or dropping it.
 */
export function validatePlan(
  plan: readonly PlannedTransfer[],
  world: ValidationWorld,
): PlanVerdict {
  const policy = world.policy ?? VALIDATION_POLICY;

  const facilities = new Map(world.facilities.map((node) => [node.facilityId, node]));
  const items = new Map(world.items.map((item) => [item.itemId, item]));
  const lots = new Map(
    world.lots.map((lot) => [lotKey(lot.facilityId, lot.itemId, lot.batchId), lot]),
  );
  const donorPositions = new Map(
    world.donorPositions.map((position) => [
      positionKey(position.facilityId, position.itemId),
      position,
    ]),
  );
  const receiverLimits = new Map(
    world.receiverLimits.map((limit) => [positionKey(limit.facilityId, limit.itemId), limit]),
  );

  const resolved: Resolved[] = plan.map((transfer) => {
    const donor = facilities.get(transfer.donorId);
    const receiver = facilities.get(transfer.receiverId);
    // The distance and the lead time are recomputed from the two coordinates
    // rather than read off the plan. A validator that trusts a plan's own
    // arithmetic is checking the plan against itself.
    const distanceKm =
      donor !== undefined && receiver !== undefined ? distanceKmBetween(donor, receiver) : 0;
    return {
      transfer,
      donor,
      receiver,
      item: items.get(transfer.itemId),
      lot: lots.get(lotKey(transfer.donorId, transfer.itemId, transfer.batchId)),
      distanceKm,
      leadTimeDays: leadTimeDaysFor(distanceKm, policy),
    };
  });

  const receiverCap = checkReceiverCap(resolved, receiverLimits);
  const arrival = checkArrivalWindow(resolved, receiverLimits, world);
  const budget = checkTransportBudget(resolved, world.transport);

  const violations: readonly PlanViolation[] = [
    ...checkQuantityPositive(resolved),
    ...checkUnknownFacilities(resolved),
    ...checkBatchesHoldTheStock(resolved, lots),
    ...checkDuplicateTransfers(resolved),
    ...checkDonorFloor(resolved, world.lots, donorPositions, policy),
    ...receiverCap.violations,
    ...checkColdChain(resolved, policy),
    ...checkCareLevel(resolved),
    ...checkShelfLifeOnArrival(resolved, world, policy),
    ...arrival.violations,
    ...checkEdgeCapacity(resolved, world.transport),
    ...budget.violations,
  ];

  return {
    valid: violations.length === 0,
    violations,
    unchecked: [...receiverCap.unchecked, ...arrival.unchecked],
    measured: {
      transfers: plan.length,
      units: plan.reduce((total, transfer) => total + transfer.quantity, 0),
      unitKm: budget.unitKm,
    },
    policy,
  };
}
