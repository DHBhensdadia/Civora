import {
  CADRES,
  SIMULATED_PROVENANCE,
  SYNDROMES,
  addDays,
  batchIdSchema,
  bedStatusSchema,
  footfallObservationSchema,
  idempotencyKeySchema,
  staffAttendanceSchema,
  stockLedgerEntrySchema,
  syndromicSignalSchema,
} from '@civora/domain';
import type {
  BatchId,
  BedStatus,
  Cadre,
  ConnectivityBand,
  DateOnly,
  District,
  Facility,
  FacilityId,
  FacilityTier,
  FootfallObservation,
  Item,
  ItemId,
  Region,
  StaffAttendance,
  StockLedgerEntry,
  Syndrome,
  SyndromicSignal,
} from '@civora/domain';

import { ROUTINE_UNITS_PER_THOUSAND_PER_DAY } from './anchors/catalogue';
import { createRng, deriveSeed } from './rng';
import type { Rng } from './rng';
import { surgeFactorOn, targets, within } from './scenarios';
import type { DistrictTarget, ScenarioSpec, SupplyDisruptionSpec } from './scenarios';

/**
 * How a facility actually behaves over a season.
 *
 * The point of this module is that nothing downstream has to be told what
 * happened. A facility dispenses what it has, runs down, reorders against what
 * it *thinks* it has been using, and either receives the order or waits. A
 * stock-out therefore emerges from the interaction of demand, a lead time and a
 * reordering rule — it is never written down as a fact. The same goes for a
 * reporting gap: a facility that cannot reach the network still works, and the
 * platform simply does not hear from it.
 *
 * Two consequences are worth stating because they are the whole demonstration:
 *
 *  - **The censoring is real.** A facility that runs dry stops dispensing, so
 *    its own issue history falls. Its reordering rule reads that history, so it
 *    orders less than it needs, so it stays short. That is the failure the
 *    platform exists to remove, and it is produced here rather than asserted.
 *  - **Absence of data is not absence of activity.** A facility in an outage
 *    keeps consuming and keeps stocking out. The observations for those days
 *    exist and are delivered when it reconnects; what is missing is that the
 *    network heard nothing while it was away.
 *
 * Every rate below is an assumption of the same kind as the catalogue's
 * consumption figures, documented in `docs/DATA_PROVENANCE.md`. They are
 * order-of-magnitude values chosen to be plausible at the scale of a primary
 * health centre, not measured ones, and the simulations built on them are
 * tested for the direction of their effects rather than their magnitude.
 */

/** Reported presentations per 1,000 catchment population per day, by syndrome. */
const PRESENTATIONS_PER_THOUSAND_PER_DAY: Readonly<Record<Syndrome, number>> = {
  fever: 2.4,
  cough: 1.7,
  diarrhoea: 0.62,
  rash: 0.28,
  jaundice: 0.07,
  conjunctivitis: 0.14,
  bleeding: 0.04,
  neurological: 0.03,
};

/** Syndromes whose reporting follows the monsoon rather than the calendar year. */
const SEASONAL_SYNDROMES: ReadonlySet<Syndrome> = new Set<Syndrome>([
  'fever',
  'cough',
  'diarrhoea',
]);

/** Monthly multiplier on presentations and routine consumption, January first. */
const SEASONAL_FACTOR: readonly number[] = [
  0.72, 0.72, 0.82, 0.92, 1.0, 1.18, 1.38, 1.5, 1.28, 1.02, 0.84, 0.76,
];

/** Day-of-week attendance factor, Sunday first. Outpatient footfall falls at the weekend. */
const WEEKDAY_FACTOR: readonly number[] = [0.55, 1.08, 1.08, 1.08, 1.08, 1.08, 0.72];

/**
 * The share of a district's presentations a facility of each tier sees.
 *
 * A community health centre is where a district's serious cases end up and sees
 * more than its population share; a sub-centre sees the routine end of the
 * same population. Applied on top of the catchment population, which is already
 * larger for a higher tier.
 */
const TIER_PRESENTATION_SHARE: Readonly<Record<FacilityTier, number>> = {
  SHC: 0.45,
  AAM: 0.5,
  PHC: 1,
  CHC: 1.25,
};

/** Syndromes a facility of each tier is expected to report on, including zero counts. */
const SYNDROMES_BY_TIER: Readonly<Record<FacilityTier, readonly Syndrome[]>> = {
  SHC: ['fever', 'cough', 'diarrhoea', 'rash'],
  AAM: ['fever', 'cough', 'diarrhoea', 'rash'],
  PHC: [...SYNDROMES],
  CHC: [...SYNDROMES],
};

/** Outpatient attendances per 1,000 catchment per day, before any surge. */
const OPD_PER_THOUSAND_PER_DAY = 14;

/** Share of outpatient attendances admitted. */
const ADMISSION_SHARE = 0.05;

/** Beds occupied on an ordinary day, and the extra occupancy at a surge peak. */
const BASELINE_BED_OCCUPANCY = 0.58;
const SURGE_BED_OCCUPANCY = 0.22;

/** Share of sanctioned posts filled, and of those filled, present on an ordinary day. */
const POSTS_FILLED_SHARE = 0.82;
const DAILY_PRESENCE_SHARE = 0.88;

/** Share of the establishment each cadre accounts for. Sums to one. */
const CADRE_SHARE: Readonly<Record<Cadre, number>> = {
  medical_officer: 0.08,
  staff_nurse: 0.25,
  anm: 0.15,
  mpw: 0.12,
  pharmacist: 0.08,
  lab_technician: 0.07,
  asha: 0.15,
  support: 0.1,
};

/**
 * Probability that a facility's day reaches the network at all.
 *
 * By connectivity band rather than by state: the platform is told what a
 * facility can do, and a dataset that made connectivity irrelevant would make
 * the offline story untestable.
 */
const REPORT_PROBABILITY: Readonly<Record<ConnectivityBand, number>> = {
  good: 0.97,
  intermittent: 0.86,
  poor: 0.62,
  none: 0.14,
};

/** Chance on an ordinary day that a facility drops off for a spell, and how long a spell runs. */
const OUTAGE_START_CHANCE = 0.004;
const OUTAGE_MIN_DAYS = 3;
const OUTAGE_MAX_DAYS = 9;

/**
 * Baseline replenishment lead time by tier, in days.
 *
 * Shorter for a higher tier, which is closer to the district store it is
 * supplied from — the same reason a community health centre holds more stock
 * than a sub-centre and needs less of it in absolute terms.
 */
const LEAD_TIME_DAYS_BY_TIER: Readonly<Record<FacilityTier, number>> = {
  SHC: 12,
  AAM: 12,
  PHC: 8,
  CHC: 5,
};

/** Days of demand a facility opens the window with, before any scenario override. */
const DEFAULT_OPENING_COVER_DAYS = 40;

/**
 * Cover at or below which a review reorders, before any scenario override.
 *
 * Tight, and deliberately so. A fortnight's cover against a weekly review and a
 * lead time of five to twelve days leaves a facility occasionally short even in
 * an ordinary season, which is what a real primary health centre's ordering
 * rule does and what makes the platform's correction worth having.
 */
const REORDER_COVER_DAYS = 14;

/** Cover a review aims to restore, measured against what the facility believes it uses. */
const DEFAULT_TARGET_COVER_DAYS = 30;

/** Days of its own issue history a facility's reordering rule looks back over. */
const RATE_WINDOW_DAYS = 28;

/** Share of opening batches that arrive already short-dated, and the days until they expire. */
const SHORT_DATED_OPENING_SHARE = 0.1;
const SHORT_DATED_MIN_DAYS = 45;
const SHORT_DATED_MAX_DAYS = 110;

/** Share of the stock a broken cold chain destroys, as opposed to spoiling unseen. */
const COLD_CHAIN_LOSS_SHARE = 0.7;

/** Days of demand a district expiry cliff delivers, before the near-expiry share is applied. */
const EXPIRY_CLIFF_COVER_DAYS = 180;

/** Days from an expiry cliff receipt until the stock it delivers expires. */
const EXPIRY_CLIFF_SHELF_LIFE_DAYS = 45;

/**
 * Days before expiry that a batch is withdrawn.
 *
 * The ledger requires a movement to be recorded on a day the batch was still
 * valid, so the last day it can be dispensed is the day before it expires — and
 * that is the day the store writes off what is left. A withdrawal recorded on
 * the expiry date itself would be a movement that the domain rejects, which is
 * a useful constraint rather than an inconvenience: it forces the record to
 * describe a decision someone actually made.
 */
const WITHDRAWAL_DAYS_BEFORE_EXPIRY = 1;

/** Times of day the movements and observations of a single day were recorded. */
const RECORDED_AT = {
  receipt: '08:00:00.000Z',
  issue: '13:00:00.000Z',
  expiry: '18:30:00.000Z',
  adjust: '18:45:00.000Z',
  observation: '17:00:00.000Z',
};

/** Daily variation in demand and presentation counts: mean one, symmetric, bounded. */
const DEMAND_NOISE_STANDARD_DEVIATION = 0.18;

/** A spell during which a facility wanted more than it could dispense. */
export interface DemandShortfall {
  readonly facilityId: string;
  readonly itemId: ItemId;
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Consecutive days on which demand went unmet, at least one. */
  readonly days: number;
  /** Units that were wanted and could not be dispensed. */
  readonly unmetUnits: number;
  /** Units dispensed over the same days, which is what the ledger recorded. */
  readonly dispensedUnits: number;
}

/** A replenishment order the facility placed, and whether it ever arrived. */
export interface SimulatedOrder {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly placedOn: DateOnly;
  /** When the facility was told to expect delivery, from the lead time it was given. */
  readonly expectedOn: DateOnly;
  /** When it actually arrived, or null while it is still in flight at the end of the window. */
  readonly receivedOn: DateOnly | null;
  readonly quantity: number;
  /** True when the order was placed while a supply disruption was in force. */
  readonly disrupted: boolean;
}

/**
 * A spell during which nothing reached the network from a facility.
 *
 * Recorded separately from the observations themselves, because the
 * observations for those days were captured locally and arrive later. What the
 * gap describes is that the network heard nothing, which is what makes a
 * position stale and what the ingest layer has to be able to raise.
 */
export interface OfflineSpan {
  readonly from: DateOnly;
  /** Last silent day, inclusive, bounded by the end of the window. */
  readonly to: DateOnly;
  readonly days: number;
  /** The day the facility next reached the network, or null if it had not by the window's end. */
  readonly resumedOn: DateOnly | null;
  /** Observation days captured during the span and delivered on resume. */
  readonly backfilledDays: number;
}

export interface BehaviourInput {
  readonly facility: Facility;
  readonly district: District;
  readonly region: Region;
  readonly scenario: ScenarioSpec;
  /** Items the facility is expected to hold, in any order. */
  readonly items: readonly Item[];
  /** Every day to simulate, ascending. */
  readonly days: readonly DateOnly[];
  readonly seed: string;
}

/** Everything one facility produced over the window. */
export interface FacilityBehaviour {
  readonly ledgerEntries: readonly StockLedgerEntry[];
  readonly syndromicSignals: readonly SyndromicSignal[];
  readonly bedStatuses: readonly BedStatus[];
  readonly staffAttendance: readonly StaffAttendance[];
  readonly footfall: readonly FootfallObservation[];
  /** Demand the facility could not meet. The platform cannot see this. */
  readonly shortfalls: readonly DemandShortfall[];
  /** Orders placed, including any still in flight. */
  readonly orders: readonly SimulatedOrder[];
  /** Days on which something reached the network. */
  readonly reportedDays: readonly DateOnly[];
  readonly offlineSpans: readonly OfflineSpan[];
}

interface BatchState {
  readonly batchId: BatchId;
  readonly expiresOn: DateOnly;
  remaining: number;
}

interface InFlightOrder {
  readonly placedOn: DateOnly;
  readonly expectedOn: DateOnly;
  arrivesOn: DateOnly;
  readonly quantity: number;
  readonly disrupted: boolean;
  receivedOn: DateOnly | null;
}

interface ItemState {
  readonly item: Item;
  /**
   * This item's own stream, so that what happens to one item cannot shift the
   * history of another. Adding an item to the catalogue would otherwise change
   * every figure already generated for the same facility.
   */
  readonly rng: Rng;
  /** Batches in the order they should be drawn down: earliest expiry first. */
  batches: BatchState[];
  /** Fractional units carried between days, so a slow mover still moves. */
  carry: number;
  pending: InFlightOrder[];
  /** Units dispensed over the last `RATE_WINDOW_DAYS` days, oldest first. */
  recent: number[];
  /** Shortfall run in progress, if any. */
  open: { from: DateOnly; to: DateOnly; days: number; unmet: number; dispensed: number } | null;
}

const SYNDROME_SET: ReadonlySet<string> = new Set<string>(SYNDROMES);

const isSyndrome = (value: string): value is Syndrome => SYNDROME_SET.has(value);

const weekdayOf = (day: DateOnly): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();

const monthOf = (day: DateOnly): number => Number(day.slice(5, 7));

const seasonalFactorOn = (day: DateOnly, syndrome: Syndrome | null): number => {
  if (syndrome !== null && !SEASONAL_SYNDROMES.has(syndrome)) {
    return 1;
  }
  return SEASONAL_FACTOR[monthOf(day) - 1] ?? 1;
};

const weekdayFactorOn = (day: DateOnly): number => WEEKDAY_FACTOR[weekdayOf(day)] ?? 1;

const emptyCaseCounts = (): Record<Syndrome, number> => ({
  fever: 0,
  cough: 0,
  diarrhoea: 0,
  rash: 0,
  jaundice: 0,
  conjunctivitis: 0,
  bleeding: 0,
  neurological: 0,
});

const instantOf = (day: DateOnly, timeOfDay: string): string => `${day}T${timeOfDay}`;

const sumOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0);

const roundToInt = (value: number): number => Math.max(0, Math.round(value));

interface ReportingPlan {
  readonly reportedDays: readonly DateOnly[];
  readonly offlineSpans: readonly OfflineSpan[];
}

/**
 * When a facility manages to reach the network.
 *
 * A spell of silence is not the same as a bad day: facilities with poor
 * connectivity drop off for a week at a time, which is what makes a gap worth
 * raising, and a facility's ordinary misses are single days, which a tolerance
 * of one day exists to absorb. The scenario's forced outage is applied on top,
 * so a scripted outage and an incidental one behave identically to everything
 * downstream.
 */
const planReporting = (
  facility: Facility,
  scenario: ScenarioSpec,
  days: readonly DateOnly[],
  region: Region,
  district: District,
  rng: Rng,
): ReportingPlan => {
  const forced = scenario.offline;
  const forcedHere =
    forced !== undefined && targets(forced.target, region.name, district.name) ? forced : undefined;
  const base = REPORT_PROBABILITY[facility.connectivity];

  const reported: DateOnly[] = [];
  const spans: OfflineSpan[] = [];
  let outageUntil: DateOnly | null = null;
  let spanFrom: DateOnly | null = null;
  let silentDays = 0;

  const closeSpan = (lastSilent: DateOnly, resumedOn: DateOnly | null): void => {
    spans.push({
      from: spanFrom ?? lastSilent,
      to: lastSilent,
      days: silentDays,
      resumedOn,
      backfilledDays: resumedOn === null ? 0 : silentDays,
    });
    spanFrom = null;
    silentDays = 0;
  };

  for (const [index, day] of days.entries()) {
    const forcedToday = forcedHere !== undefined && within(forcedHere, day);

    let reached = false;
    if (!forcedToday) {
      if (outageUntil !== null && day <= outageUntil) {
        reached = false;
      } else {
        outageUntil = null;
        if (rng.chance(OUTAGE_START_CHANCE)) {
          outageUntil = addDays(day, rng.int(OUTAGE_MIN_DAYS, OUTAGE_MAX_DAYS));
          reached = false;
        } else {
          reached = rng.chance(base);
        }
      }
    }

    if (reached) {
      if (spanFrom !== null) {
        closeSpan(addDays(day, -1), day);
      }
      reported.push(day);
      continue;
    }

    spanFrom ??= day;
    silentDays += 1;

    // A gap that runs to the end of the window is left open rather than being
    // given an end it did not have.
    if (index === days.length - 1) {
      closeSpan(day, null);
    }
  }

  return { reportedDays: reported, offlineSpans: spans };
};

export function simulateFacilityBehaviour(input: BehaviourInput): FacilityBehaviour {
  const { facility, district, region, scenario, days } = input;
  const provenance = SIMULATED_PROVENANCE;
  const rng = createRng(deriveSeed(input.seed, `behaviour:${facility.id}`));

  const items = [...input.items].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  const itemRng = (item: Item): Rng =>
    createRng(deriveSeed(input.seed, `behaviour:${facility.id}:${item.id}`));

  const openingCoverDays = scenario.openingCoverDays ?? DEFAULT_OPENING_COVER_DAYS;
  const targetCoverDays = scenario.orderingTargetDays ?? DEFAULT_TARGET_COVER_DAYS;
  const reorderCoverDays = scenario.reorderCoverDays ?? REORDER_COVER_DAYS;

  const targetedHere = (target: DistrictTarget | undefined): boolean =>
    target !== undefined && targets(target, region.name, district.name);

  const surgeHere = scenario.surge;
  const surgeApplies = targetedHere(surgeHere?.target);
  const disruption: SupplyDisruptionSpec | undefined = targetedHere(
    scenario.supplyDisruption?.target,
  )
    ? scenario.supplyDisruption
    : undefined;
  const coldChainFailure = targetedHere(scenario.coldChainFailure?.target)
    ? scenario.coldChainFailure
    : undefined;
  const expiryCliff = targetedHere(scenario.expiryCliff?.target) ? scenario.expiryCliff : undefined;
  const reporting = planReporting(facility, scenario, days, region, district, rng);

  const ledgerEntries: StockLedgerEntry[] = [];
  const syndromicSignals: SyndromicSignal[] = [];
  const bedStatuses: BedStatus[] = [];
  const staffAttendance: StaffAttendance[] = [];
  const footfall: FootfallObservation[] = [];
  const shortfalls: DemandShortfall[] = [];
  const orders: SimulatedOrder[] = [];
  const caseCounts = emptyCaseCounts();

  const firstDay = days[0];
  if (firstDay === undefined) {
    return {
      ledgerEntries,
      syndromicSignals,
      bedStatuses,
      staffAttendance,
      footfall,
      shortfalls,
      orders,
      reportedDays: [],
      offlineSpans: reporting.offlineSpans,
    };
  }

  /** Units the facility expects to dispense of an item on a day, at a given case load. */
  const expectedUnits = (
    item: Item,
    load: Readonly<Record<Syndrome, number>>,
    day: DateOnly,
  ): number => {
    const perThousand = facility.catchmentPopulation / 1000;
    let units =
      perThousand *
      ROUTINE_UNITS_PER_THOUSAND_PER_DAY[item.category] *
      seasonalFactorOn(day, null) *
      weekdayFactorOn(day);

    for (const name of item.syndromes) {
      if (isSyndrome(name)) {
        units += load[name] * item.unitsPerCase;
      }
    }

    return Math.max(0, units);
  };

  const nextBatchId = (item: Item, day: DateOnly, suffix: string): BatchId =>
    batchIdSchema.parse(`${facility.id}:${item.id}:${day}:${suffix}`);

  const addBatch = (state: ItemState, batch: BatchState): void => {
    const at = state.batches.findIndex((existing) => existing.expiresOn > batch.expiresOn);
    if (at === -1) {
      state.batches.push(batch);
      return;
    }
    state.batches.splice(at, 0, batch);
  };

  const onHandOf = (state: ItemState): number =>
    state.batches.reduce((total, batch) => total + batch.remaining, 0);

  /** Draw down the given quantity, earliest expiry first. Returns what was actually drawn. */
  const drawDown = (
    state: ItemState,
    wanted: number,
  ): { drawn: number; batch: BatchState | null } => {
    let drawn = 0;
    let last: BatchState | null = null;

    for (const batch of state.batches) {
      if (drawn >= wanted) {
        break;
      }
      const taken = Math.min(batch.remaining, wanted - drawn);
      batch.remaining -= taken;
      drawn += taken;
      if (taken > 0) {
        last = batch;
      }
    }

    state.batches = state.batches.filter((batch) => batch.remaining > 0);
    return { drawn, batch: last };
  };

  const recordShortfall = (
    state: ItemState,
    day: DateOnly,
    unmet: number,
    dispensed: number,
  ): void => {
    if (state.open === null) {
      state.open = { from: day, to: day, days: 1, unmet, dispensed };
      return;
    }
    state.open.to = day;
    state.open.days += 1;
    state.open.unmet += unmet;
    state.open.dispensed += dispensed;
  };

  const closeShortfall = (state: ItemState): void => {
    if (state.open === null) {
      return;
    }
    shortfalls.push({
      facilityId: facility.id,
      itemId: state.item.id,
      from: state.open.from,
      to: state.open.to,
      days: state.open.days,
      unmetUnits: state.open.unmet,
      dispensedUnits: state.open.dispensed,
    });
    state.open = null;
  };

  const openingLoad = emptyCaseCounts();
  for (const syndrome of SYNDROMES) {
    const perThousand = facility.catchmentPopulation / 1000;
    openingLoad[syndrome] = roundToInt(
      perThousand *
        PRESENTATIONS_PER_THOUSAND_PER_DAY[syndrome] *
        TIER_PRESENTATION_SHARE[facility.tier] *
        seasonalFactorOn(firstDay, syndrome),
    );
  }

  // --- opening position -----------------------------------------------------
  // Every facility starts stocked and says so, with a receipt dated the first
  // day of the window. Seeding the position without a record of it would leave
  // the ledger unable to explain the stock it is holding.
  const states: ItemState[] = items
    // An item with no expected use is not on this facility's shelf, and the
    // ledger is silent about it rather than recording a permanent zero.
    .filter((item) => expectedUnits(item, openingLoad, firstDay) > 0)
    .map((item) => {
      const state: ItemState = {
        item,
        rng: itemRng(item),
        batches: [],
        carry: 0,
        pending: [],
        recent: [],
        open: null,
      };
      const opening = roundToInt(expectedUnits(item, openingLoad, firstDay) * openingCoverDays);

      if (opening <= 0) {
        return state;
      }

      const shortDated = rng.chance(SHORT_DATED_OPENING_SHARE);
      const longLifeDays = shortDated
        ? rng.int(SHORT_DATED_MIN_DAYS, SHORT_DATED_MAX_DAYS)
        : Math.round(item.shelfLifeDays * rng.float(0.55, 0.85));
      const bulk = Math.max(1, Math.round(opening * rng.float(0.45, 0.7)));

      for (const [index, quantity] of [bulk, opening - bulk].entries()) {
        if (quantity <= 0) {
          continue;
        }
        const lifetime = index === 0 ? longLifeDays : Math.round(longLifeDays * 1.4);
        const expiresOn = addDays(firstDay, lifetime);
        if (expiresOn <= firstDay) {
          continue;
        }

        const entry = stockLedgerEntrySchema.parse({
          id: `${facility.id}:${item.id}:opening:${String(index)}`,
          facilityId: facility.id,
          itemId: item.id,
          kind: 'receipt',
          quantity,
          adjustmentDirection: null,
          occurredOn: firstDay,
          recordedAt: instantOf(firstDay, RECORDED_AT.receipt),
          batchId: nextBatchId(item, firstDay, `opening-${String(index)}`),
          expiresOn,
          idempotencyKey: idempotencyKeySchema.parse(
            `${facility.id}:${item.id}:opening:${String(index)}`,
          ),
          correctsEntryId: null,
          counterpartFacilityId: null,
          transferId: null,
          synthetic: true,
          provenance,
        });

        ledgerEntries.push(entry);
        addBatch(state, {
          batchId: nextBatchId(item, firstDay, `opening-${String(index)}`),
          expiresOn,
          remaining: quantity,
        });
      }

      return state;
    });

  // A district expiry cliff is a bulk receipt, close to its expiry, of stock the
  // district did not ask for. It arrives on the first day of the window at the
  // latest, because a receipt dated before the window would be absorbed into an
  // opening balance and the platform would never see how short-dated it is.
  const cliffDay =
    expiryCliff === undefined
      ? undefined
      : expiryCliff.from < firstDay
        ? firstDay
        : expiryCliff.from;
  if (expiryCliff !== undefined && cliffDay !== undefined) {
    const cliffExpiry = addDays(cliffDay, EXPIRY_CLIFF_SHELF_LIFE_DAYS);
    for (const state of states) {
      const quantity = roundToInt(
        expectedUnits(state.item, openingLoad, cliffDay) *
          EXPIRY_CLIFF_COVER_DAYS *
          expiryCliff.nearExpiryShare,
      );
      if (quantity <= 0) {
        continue;
      }

      ledgerEntries.push(
        stockLedgerEntrySchema.parse({
          id: `${facility.id}:${state.item.id}:cliff:${cliffDay}`,
          facilityId: facility.id,
          itemId: state.item.id,
          kind: 'receipt',
          quantity,
          adjustmentDirection: null,
          occurredOn: cliffDay,
          recordedAt: instantOf(cliffDay, RECORDED_AT.receipt),
          batchId: nextBatchId(state.item, cliffDay, 'cliff'),
          expiresOn: cliffExpiry,
          idempotencyKey: idempotencyKeySchema.parse(
            `${facility.id}:${state.item.id}:cliff:${cliffDay}`,
          ),
          correctsEntryId: null,
          counterpartFacilityId: null,
          transferId: null,
          synthetic: true,
          provenance,
        }),
      );
      addBatch(state, {
        batchId: nextBatchId(state.item, cliffDay, 'cliff'),
        expiresOn: cliffExpiry,
        remaining: quantity,
      });
    }
  }

  const coldChainLossApplied = { done: false };
  const reviewWeekday = rng.int(0, 6);

  for (const day of days) {
    const coldChainFailingToday = coldChainFailure !== undefined && within(coldChainFailure, day);
    const disruptedToday = disruption !== undefined && within(disruption, day);

    // --- presentations ------------------------------------------------------
    for (const syndrome of SYNDROMES) {
      const perThousand = facility.catchmentPopulation / 1000;
      const expected =
        perThousand *
        PRESENTATIONS_PER_THOUSAND_PER_DAY[syndrome] *
        TIER_PRESENTATION_SHARE[facility.tier] *
        seasonalFactorOn(day, syndrome) *
        weekdayFactorOn(day);
      const surgeFactor =
        surgeApplies && surgeHere?.syndrome === syndrome ? surgeFactorOn(surgeHere, day) : 1;
      caseCounts[syndrome] = roundToInt(
        expected * surgeFactor * Math.max(0, 1 + rng.normal(0, DEMAND_NOISE_STANDARD_DEVIATION)),
      );
    }

    if (SYNDROMES_BY_TIER[facility.tier].length > 0) {
      for (const syndrome of SYNDROMES_BY_TIER[facility.tier]) {
        syndromicSignals.push(
          syndromicSignalSchema.parse({
            facilityId: facility.id,
            observedOn: day,
            syndrome,
            caseCount: caseCounts[syndrome],
            recordedAt: instantOf(day, RECORDED_AT.observation),
            idempotencyKey: idempotencyKeySchema.parse(
              `${facility.id}:syndromic:${day}:${syndrome}`,
            ),
            synthetic: true,
            provenance,
          }),
        );
      }
    }

    // --- stock arriving -----------------------------------------------------
    for (const state of states) {
      const arrived = state.pending.filter((order) => order.arrivesOn === day);
      if (arrived.length === 0) {
        continue;
      }

      // A facility whose refrigeration has failed cannot take a vaccine
      // delivery, and the store does not send one. The order waits.
      if (state.item.coldChain && coldChainFailingToday) {
        for (const order of state.pending) {
          order.arrivesOn = addDays(coldChainFailure.to, 1);
        }
        continue;
      }

      state.pending = state.pending.filter((order) => order.arrivesOn !== day);

      for (const order of arrived) {
        order.receivedOn = day;
        const expiresOn = addDays(day, state.item.shelfLifeDays);
        const batchId = nextBatchId(state.item, day, `order-${order.placedOn}`);
        ledgerEntries.push(
          stockLedgerEntrySchema.parse({
            id: `${facility.id}:${state.item.id}:receipt:${day}:${order.placedOn}`,
            facilityId: facility.id,
            itemId: state.item.id,
            kind: 'receipt',
            quantity: order.quantity,
            adjustmentDirection: null,
            occurredOn: day,
            recordedAt: instantOf(day, RECORDED_AT.receipt),
            batchId,
            expiresOn,
            idempotencyKey: idempotencyKeySchema.parse(
              `${facility.id}:${state.item.id}:receipt:${day}:${order.placedOn}`,
            ),
            correctsEntryId: null,
            counterpartFacilityId: null,
            transferId: null,
            synthetic: true,
            provenance,
          }),
        );
        addBatch(state, { batchId, expiresOn, remaining: order.quantity });
        orders.push({
          facilityId: facility.id,
          itemId: state.item.id,
          placedOn: order.placedOn,
          expectedOn: order.expectedOn,
          receivedOn: day,
          quantity: order.quantity,
          disrupted: order.disrupted,
        });
      }
    }

    // --- dispensing ---------------------------------------------------------
    // What the facility dispenses is what it has, not what it needs. The gap
    // between the two is recorded as a shortfall, which is the quantity the
    // platform exists to make visible and which the ledger, by construction,
    // cannot express.
    for (const state of states) {
      const demand =
        expectedUnits(state.item, caseCounts, day) *
        Math.max(0, 1 + state.rng.normal(0, DEMAND_NOISE_STANDARD_DEVIATION));

      state.carry += demand;
      const wanted = Math.floor(state.carry);
      state.carry -= wanted;

      const { drawn, batch } = drawDown(state, wanted);

      if (drawn > 0 && batch !== null) {
        ledgerEntries.push(
          stockLedgerEntrySchema.parse({
            id: `${facility.id}:${state.item.id}:issue:${day}`,
            facilityId: facility.id,
            itemId: state.item.id,
            kind: 'issue',
            quantity: drawn,
            adjustmentDirection: null,
            occurredOn: day,
            recordedAt: instantOf(day, RECORDED_AT.issue),
            batchId: batch.batchId,
            expiresOn: batch.expiresOn,
            idempotencyKey: idempotencyKeySchema.parse(
              `${facility.id}:${state.item.id}:issue:${day}`,
            ),
            correctsEntryId: null,
            counterpartFacilityId: null,
            transferId: null,
            synthetic: true,
            provenance,
          }),
        );
      }

      const unmet = wanted - drawn;
      if (unmet > 0) {
        recordShortfall(state, day, unmet, drawn);
      } else {
        closeShortfall(state);
      }

      state.recent.push(drawn);
      if (state.recent.length > RATE_WINDOW_DAYS) {
        state.recent.shift();
      }
    }

    // --- batches reaching the end of their life -----------------------------
    for (const state of states) {
      const withdrawing = state.batches.filter(
        (batch) => batch.expiresOn === addDays(day, WITHDRAWAL_DAYS_BEFORE_EXPIRY),
      );
      for (const batch of withdrawing) {
        ledgerEntries.push(
          stockLedgerEntrySchema.parse({
            id: `${facility.id}:${state.item.id}:expiry:${day}:${batch.batchId}`,
            facilityId: facility.id,
            itemId: state.item.id,
            kind: 'expiry',
            quantity: batch.remaining,
            adjustmentDirection: null,
            occurredOn: day,
            recordedAt: instantOf(day, RECORDED_AT.expiry),
            batchId: batch.batchId,
            expiresOn: batch.expiresOn,
            idempotencyKey: idempotencyKeySchema.parse(
              `${facility.id}:${state.item.id}:expiry:${batch.batchId}`,
            ),
            correctsEntryId: null,
            counterpartFacilityId: null,
            transferId: null,
            synthetic: true,
            provenance,
          }),
        );
        state.batches = state.batches.filter((other) => other.batchId !== batch.batchId);
      }
    }

    // --- a broken cold chain, seen as a loss --------------------------------
    // What a failed refrigerator destroys is not reported as an expiry, because
    // it did not expire. It is a correction to the count, which is also the
    // signal a redistribution rule needs: stock that was written off in an
    // adjustment is stock whose quality nobody should have to vouch for.
    if (coldChainFailingToday && !coldChainLossApplied.done) {
      coldChainLossApplied.done = true;
      for (const state of states) {
        if (!state.item.coldChain) {
          continue;
        }
        const loss = Math.floor(onHandOf(state) * COLD_CHAIN_LOSS_SHARE);
        if (loss <= 0) {
          continue;
        }
        let remainingLoss = loss;
        for (const batch of [...state.batches]) {
          if (remainingLoss <= 0) {
            break;
          }
          const taken = Math.min(batch.remaining, remainingLoss);
          remainingLoss -= taken;
          batch.remaining -= taken;
          ledgerEntries.push(
            stockLedgerEntrySchema.parse({
              id: `${facility.id}:${state.item.id}:cold-chain:${day}:${batch.batchId}`,
              facilityId: facility.id,
              itemId: state.item.id,
              kind: 'adjust',
              quantity: taken,
              adjustmentDirection: 'decrease',
              occurredOn: day,
              recordedAt: instantOf(day, RECORDED_AT.adjust),
              batchId: batch.batchId,
              expiresOn: batch.expiresOn,
              idempotencyKey: idempotencyKeySchema.parse(
                `${facility.id}:${state.item.id}:cold-chain:${batch.batchId}`,
              ),
              correctsEntryId: null,
              counterpartFacilityId: null,
              transferId: null,
              synthetic: true,
              provenance,
            }),
          );
        }
        state.batches = state.batches.filter((batch) => batch.remaining > 0);
      }
    }

    // --- the facility's own reordering rule ---------------------------------
    // Deliberately not clever. It reviews weekly, estimates demand from the
    // issues it recorded over the last four weeks, and tops up to a month of
    // that estimate. When it has been out of stock, those recorded issues are
    // the wrong number and the rule orders too little — which is the failure
    // described in the module comment, produced here without being asserted.
    // A review on one weekday a week, which is a seven-day review period: the
    // facility's own rule, and the reason it is caught short by a lead time
    // longer than that week.
    if (weekdayOf(day) === reviewWeekday) {
      for (const state of states) {
        const observedRate = sumOf(state.recent) / Math.max(state.recent.length, 1);
        if (observedRate <= 0) {
          continue;
        }

        const inFlight = state.pending.reduce((total, order) => total + order.quantity, 0);
        const cover = (onHandOf(state) + inFlight) / observedRate;
        if (cover > reorderCoverDays) {
          continue;
        }

        const quantity = roundToInt(observedRate * targetCoverDays) - (onHandOf(state) + inFlight);
        if (quantity <= 0) {
          continue;
        }

        // The lead time a facility is given, and the one it actually gets: three
        // times as long while its state's store is disrupted, so cover that was
        // comfortable stops being comfortable without anything else changing.
        const baseLeadTime = LEAD_TIME_DAYS_BY_TIER[facility.tier];
        const leadTime =
          disruption === undefined || !disruptedToday
            ? baseLeadTime
            : Math.round(baseLeadTime * disruption.leadTimeMultiplier);

        state.pending.push({
          placedOn: day,
          expectedOn: addDays(day, leadTime),
          arrivesOn: addDays(day, leadTime),
          quantity,
          disrupted: disruptedToday,
          receivedOn: null,
        });
      }
    }

    // --- the rest of what the facility reports ------------------------------
    const attendanceRecords = buildAttendance(facility, day, rng, provenance);
    staffAttendance.push(...attendanceRecords);

    if (facility.sanctionedBeds > 0) {
      const feverShare =
        caseCounts.fever > 0 ? 1 + SURGE_BED_OCCUPANCY * Math.min(caseCounts.fever / 40, 2) : 1;
      const occupancy = Math.min(
        1,
        Math.max(0, BASELINE_BED_OCCUPANCY * feverShare * (1 + rng.normal(0, 0.08))),
      );
      bedStatuses.push(
        bedStatusSchema.parse({
          facilityId: facility.id,
          observedOn: day,
          bedsTotal: facility.sanctionedBeds,
          bedsOccupied: Math.min(
            facility.sanctionedBeds,
            Math.max(0, Math.round(facility.sanctionedBeds * occupancy)),
          ),
          recordedAt: instantOf(day, RECORDED_AT.observation),
          idempotencyKey: idempotencyKeySchema.parse(`${facility.id}:beds:${day}`),
          synthetic: true,
          provenance,
        }),
      );
    }

    const opdCount = roundToInt(
      (facility.catchmentPopulation / 1000) *
        OPD_PER_THOUSAND_PER_DAY *
        seasonalFactorOn(day, null) *
        weekdayFactorOn(day) *
        (1 + rng.normal(0, 0.1)),
    );
    footfall.push(
      footfallObservationSchema.parse({
        facilityId: facility.id,
        observedOn: day,
        opdCount,
        ipdCount: Math.min(opdCount, roundToInt(opdCount * ADMISSION_SHARE)),
        recordedAt: instantOf(day, RECORDED_AT.observation),
        idempotencyKey: idempotencyKeySchema.parse(`${facility.id}:footfall:${day}`),
        synthetic: true,
        provenance,
      }),
    );
  }

  for (const state of states) {
    closeShortfall(state);
    for (const order of state.pending) {
      orders.push({
        facilityId: facility.id,
        itemId: state.item.id,
        placedOn: order.placedOn,
        expectedOn: order.expectedOn,
        receivedOn: null,
        quantity: order.quantity,
        disrupted: order.disrupted,
      });
    }
  }

  return {
    ledgerEntries,
    syndromicSignals,
    bedStatuses,
    staffAttendance,
    footfall,
    shortfalls,
    orders,
    reportedDays: reporting.reportedDays,
    offlineSpans: reporting.offlineSpans,
  };
}

/**
 * Attendance by cadre, on the establishment's own posts.
 *
 * Counts, not people: the platform records how many posts exist, how many are
 * filled and how many of those were present. Nothing here identifies anyone,
 * which is why a facility roster needs no personal-data handling at all.
 */
const buildAttendance = (
  facility: Facility,
  day: DateOnly,
  rng: Rng,
  provenance: typeof SIMULATED_PROVENANCE,
): StaffAttendance[] => {
  const records: StaffAttendance[] = [];

  for (const cadre of CADRES) {
    const postsSanctioned = Math.round(facility.sanctionedPosts * CADRE_SHARE[cadre]);
    if (postsSanctioned <= 0) {
      continue;
    }

    const postsFilled = Math.min(
      postsSanctioned,
      Math.max(0, Math.round(postsSanctioned * POSTS_FILLED_SHARE * (1 + rng.normal(0, 0.06)))),
    );
    const presentToday = Math.min(
      postsFilled,
      Math.max(0, Math.round(postsFilled * DAILY_PRESENCE_SHARE * (1 + rng.normal(0, 0.12)))),
    );

    records.push(
      staffAttendanceSchema.parse({
        facilityId: facility.id,
        observedOn: day,
        cadre,
        postsSanctioned,
        postsFilled,
        presentToday,
        recordedAt: instantOf(day, RECORDED_AT.observation),
        idempotencyKey: idempotencyKeySchema.parse(`${facility.id}:attendance:${day}:${cadre}`),
        synthetic: true,
        provenance,
      }),
    );
  }

  return records;
};
