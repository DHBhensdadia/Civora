import { addDays, replayStockLedger } from '@civora/domain';
import type { DateOnly, FacilityId, ItemId, StockLedgerEntry } from '@civora/domain';
import { forecastDemand } from '@civora/forecasting';
import type { DemandPoint, DemandSeries } from '@civora/forecasting';
import type { Simulation } from '@civora/simulator';

/**
 * What the platform's forecast would have done to the shelves.
 *
 * The phase asks for operational metrics — stock-out rate and fill rate — with
 * the forecast on and off, and the obvious way to produce them is to re-run the
 * whole generator twice. That is rejected here, and the reason matters: the
 * generator's ordering rule is tangled with its demand, its reporting and its
 * disruptions, so two runs would differ in ways that have nothing to do with
 * forecasting, and the resulting number would be a property of the simulator
 * rather than of the platform.
 *
 * What happens instead is a **replay**. The generated world says what each
 * facility ordered, when, and how long it waited. Both arms are then run over
 * the *same* days, the *same* lead times and the *same* demand, and the only
 * thing that changes is the quantity on the order:
 *
 *  - **Forecast off** orders exactly what the facility ordered, which is what
 *    its own rule computed from the issues it recorded — including, during a
 *    stock-out, the issues it could not record.
 *  - **Forecast on** orders on the same days, but sizes each order from the
 *    platform's own forecast of the history available that day, targeting the
 *    upper quantile over the lead time rather than the median.
 *
 * Three things are deliberately not modelled, and all three are stated in the
 * report rather than left to be found:
 *
 *  1. **Expiry and cold-chain losses are ignored.** The replay keeps one
 *     undated pool of stock. Both arms ignore them equally, so the comparison is
 *     unaffected; the absolute rates are optimistic in both.
 *  2. **Stock is not moved between facilities.** Phase 6 does that, and a policy
 *     replay that quietly redistributed would be measuring Phase 6.
 *  3. **Demand is latent demand, not recorded issues**, because the question is
 *     whether people got the medicine. Latent demand is what only the generated
 *     world knows, and it is the only target a stock-out policy can honestly be
 *     scored on.
 *
 * And the whole thing is checked against the world it came from: driven by the
 * world's own order quantities, the replay should reproduce the world's own
 * stock-outs. That figure is reported as `fidelity`, because a counterfactual
 * built on a replay that cannot reproduce the observed outcome is decoration.
 */

/** One order the world placed, reduced to what a replay needs. */
export interface PlannedOrder {
  readonly placedOn: DateOnly;
  readonly arrivesOn: DateOnly;
  readonly quantity: number;
}

export interface PolicyPair {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  /** Stock on hand at the start of the window, from the replayed ledger. */
  readonly openingOnHand: number;
  /** Median wait the pair actually experienced, in days. */
  readonly leadTimeDays: number;
  readonly orders: readonly PlannedOrder[];
  readonly days: readonly DateOnly[];
  /** What was wanted each day, in the same order as `days`. */
  readonly latent: readonly number[];
  /** Recorded issues each day. What the facility's own rule learned from. */
  readonly recorded: readonly number[];
  readonly onHandHistory: readonly number[];
  /** Days the world itself recorded as short, for the fidelity check. */
  readonly actualShortDays: number;
  readonly actualUnmetUnits: number;
}

export interface PolicyOutcome {
  readonly unsuppliedDays: number;
  readonly demandedUnits: number;
  readonly dispensedUnits: number;
  readonly unmetUnits: number;
  /** Share of pair-days on which somebody wanted something and got none of it. */
  readonly unsuppliedDayRate: number;
  /** Dispensed divided by demanded. One means nobody was turned away. */
  readonly fillRate: number;
  /** Short days per thousand pair-days, which is the rate an officer reads. */
  readonly shortageRatePerThousandDays: number;
}

export interface PolicyComparison {
  readonly baseline: PolicyOutcome;
  readonly platform: PolicyOutcome;
  /**
   * How closely the replay reproduces the world it was built from.
   *
   * One minus the total short-day discrepancy over the world's own short days,
   * driven by the world's own order quantities. A number near one says the replay
   * is describing the same system; a number near zero says the two arms below are
   * measuring the replay rather than the policy.
   */
  readonly fidelity: number;
  readonly pairs: number;
  readonly pairsAvailable: number;
  readonly pairDays: number;
  readonly meanLeadTimeDays: number;
  /** Orders the forecast was shown at all, across the replayed pairs. */
  readonly ordersTotal: number;
  /**
   * Orders placed with enough history behind them to be judged.
   *
   * Published because it separates two very different readings of a small
   * `ordersResized`: the forecast looked at every order and agreed with the
   * world, or it was never shown one. The number below is a comparison, and a
   * comparison whose left-hand side was empty is not a comparison.
   */
  readonly ordersJudged: number;
  readonly ordersResized: number;
  readonly elapsedMs: number;
}

export interface PolicyOptions {
  /**
   * Pairs to replay, spread evenly across the catalogue.
   *
   * The forecaster is the expensive part — one fit per order per pair — and a
   * sample answers the operational question as well as the whole catalogue
   * would, because the question is a rate rather than a total. The cap travels
   * with the numbers so a reader knows what was measured.
   */
  readonly maxPairs: number;
  readonly bootstrapReplications: number;
  readonly seasonLength: number;
  /** Safety margin on top of forecast demand. One means the upper quantile alone. */
  readonly coverMultiplier: number;
}

export const DEFAULT_POLICY_OPTIONS: PolicyOptions = {
  maxPairs: 60,
  // Lower than the engine default: the replay fits thousands of times and only
  // the upper quantile is read, which is stable well before 400 replications.
  bootstrapReplications: 40,
  seasonLength: 7,
  coverMultiplier: 1,
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return Number.isInteger(middle)
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[Math.floor(middle)] ?? 0);
};

const daysBetween = (from: DateOnly, to: DateOnly): number =>
  Math.max(
    0,
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ),
  );

const outcomeOf = (
  unsuppliedDays: number,
  demanded: number,
  dispensed: number,
  pairDays: number,
): PolicyOutcome => ({
  unsuppliedDays,
  demandedUnits: demanded,
  dispensedUnits: dispensed,
  unmetUnits: demanded - dispensed,
  unsuppliedDayRate: pairDays === 0 ? 0 : unsuppliedDays / pairDays,
  fillRate: demanded === 0 ? 1 : dispensed / demanded,
  shortageRatePerThousandDays: pairDays === 0 ? 0 : (unsuppliedDays / pairDays) * 1000,
});

/**
 * Run one arm over one pair: arrivals, dispensing, then the day's orders.
 *
 * `quantityFor` is the whole experiment. Returning the world's own quantity
 * replays what happened; returning anything else is the counterfactual.
 */
function replayArm(
  pair: PolicyPair,
  quantityFor: (order: PlannedOrder, index: number) => number,
): { outcome: PolicyOutcome; shortDays: number } {
  const arrivals = new Map<DateOnly, number>();
  const ordersOnDay = new Map<DateOnly, number[]>();

  pair.orders.forEach((order, index) => {
    const existing = ordersOnDay.get(order.placedOn) ?? [];
    existing.push(index);
    ordersOnDay.set(order.placedOn, existing);
  });

  let onHand = pair.openingOnHand;
  let unsuppliedDays = 0;
  let demanded = 0;
  let dispensed = 0;

  for (const [dayIndex, day] of pair.days.entries()) {
    onHand += arrivals.get(day) ?? 0;
    arrivals.delete(day);

    const wanted = pair.latent[dayIndex] ?? 0;
    const given = Math.max(0, Math.min(wanted, onHand));
    onHand -= given;
    demanded += wanted;
    dispensed += given;
    if (wanted - given > 1e-9) {
      unsuppliedDays += 1;
    }

    for (const orderIndex of ordersOnDay.get(day) ?? []) {
      const order = pair.orders[orderIndex];
      if (order === undefined) {
        continue;
      }
      const quantity = Math.max(0, Math.round(quantityFor(order, orderIndex)));
      // An order arriving on the day it was placed is credited the same day;
      // otherwise it lands on the day the world says it did.
      const landsOn = order.arrivesOn > day ? order.arrivesOn : day;
      arrivals.set(landsOn, (arrivals.get(landsOn) ?? 0) + quantity);
    }
  }

  return {
    outcome: outcomeOf(unsuppliedDays, demanded, dispensed, pair.days.length),
    shortDays: unsuppliedDays,
  };
}

/** Take pairs from a list, evenly spaced, so the sample is not just the first N. */
const spread = <T>(values: readonly T[], count: number): readonly T[] => {
  if (values.length <= count) {
    return values;
  }
  const step = values.length / count;
  return Array.from({ length: count }, (_, index) => values[Math.floor(index * step)]).filter(
    (value): value is T => value !== undefined,
  );
};

/** The next forecast horizon the platform orders against. */
const horizonFor = (leadTimeDays: number): number => Math.max(7, leadTimeDays * 2);

/**
 * Compare the two arms over a set of pairs.
 *
 * The platform's arm sizes each order from a forecast of the history available on
 * the day the order was placed, which includes the censored-demand correction.
 * That correction is the entire mechanism: the facility's own rule reads a
 * stock-out as a fall in use and orders less, and the platform reads the same
 * days as unmet need and orders more.
 */
export function comparePolicies(
  pairs: readonly PolicyPair[],
  options: PolicyOptions = DEFAULT_POLICY_OPTIONS,
): PolicyComparison {
  const startedAt = Date.now();
  const live = spread(pairs, options.maxPairs);

  let baselineUnsupplied = 0;
  let baselineDemanded = 0;
  let baselineDispensed = 0;
  let pairDays = 0;
  let replayShortDays = 0;
  let actualShortDays = 0;

  for (const pair of live) {
    const { outcome, shortDays } = replayArm(pair, (order) => order.quantity);
    baselineUnsupplied += outcome.unsuppliedDays;
    baselineDemanded += outcome.demandedUnits;
    baselineDispensed += outcome.dispensedUnits;
    pairDays += pair.days.length;
    replayShortDays += shortDays;
    actualShortDays += pair.actualShortDays;
  }

  let platformUnsupplied = 0;
  let platformDemanded = 0;
  let platformDispensed = 0;
  let ordersResized = 0;
  let ordersTotal = 0;
  let ordersJudged = 0;

  for (const pair of live) {
    const horizon = horizonFor(pair.leadTimeDays);
    ordersTotal += pair.orders.length;

    // One forecast per order, fitted on nothing after the day it was placed.
    const quantities = pair.orders.map((order) => {
      const historyDays = pair.days.filter((day) => day <= order.placedOn).length;
      if (historyDays < 14) {
        return order.quantity;
      }
      ordersJudged += 1;

      const points: DemandPoint[] = pair.days.slice(0, historyDays).map((day, dayIndex) => ({
        on: day,
        issued: pair.recorded[dayIndex] ?? 0,
        onHand: pair.onHandHistory[dayIndex] ?? 0,
      }));

      const history: DemandSeries = {
        facilityId: pair.facilityId,
        itemId: pair.itemId,
        points,
      };

      const outcome = forecastDemand(
        history,
        {
          facilityId: pair.facilityId,
          itemId: pair.itemId,
          asOf: order.placedOn,
          horizonDays: horizon,
          seed: `policy:${pair.facilityId}:${pair.itemId}:${order.placedOn}`,
          synthetic: true,
          provenance: { kind: 'derived', reference: 'policy-replay' },
        },
        {
          bootstrapReplications: options.bootstrapReplications,
          seasonLength: options.seasonLength,
        },
      );

      const throughLeadTime =
        outcome.cumulativeP90[Math.min(horizon, outcome.cumulativeP90.length) - 1] ?? 0;
      const target = throughLeadTime * options.coverMultiplier;
      const onHandAtOrder = pair.onHandHistory[historyDays - 1] ?? 0;

      // Never below what the world itself ordered: the comparison isolates the
      // forecast, and must not accidentally model a lazier reviewer than the one
      // that actually placed the order.
      const suggested = Math.max(order.quantity, target - onHandAtOrder);
      if (suggested > order.quantity + 0.5) {
        ordersResized += 1;
      }
      return suggested;
    });

    const { outcome } = replayArm(pair, (_order, index) => quantities[index] ?? 0);
    platformUnsupplied += outcome.unsuppliedDays;
    platformDemanded += outcome.demandedUnits;
    platformDispensed += outcome.dispensedUnits;
  }

  const discrepancy = Math.abs(replayShortDays - actualShortDays);

  return {
    baseline: outcomeOf(baselineUnsupplied, baselineDemanded, baselineDispensed, pairDays),
    platform: outcomeOf(platformUnsupplied, platformDemanded, platformDispensed, pairDays),
    fidelity: actualShortDays === 0 ? 1 : Math.max(0, 1 - discrepancy / actualShortDays),
    pairs: live.length,
    pairsAvailable: pairs.length,
    pairDays,
    meanLeadTimeDays: mean(live.map((pair) => pair.leadTimeDays)),
    ordersTotal,
    ordersJudged,
    ordersResized,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Assemble the pairs a replay needs from a generated world. */
export function pairsFromSimulation(simulation: Simulation): readonly PolicyPair[] {
  const entriesByPair = new Map<string, StockLedgerEntry[]>();
  for (const entry of simulation.ledgerEntries) {
    const key = `${entry.facilityId}|${entry.itemId}`;
    const list = entriesByPair.get(key) ?? [];
    list.push(entry);
    entriesByPair.set(key, list);
  }

  const ordersByPair = new Map<string, PlannedOrder[]>();
  for (const order of simulation.orders) {
    if (order.receivedOn === null) {
      continue;
    }
    const key = `${order.facilityId}|${order.itemId}`;
    const list = ordersByPair.get(key) ?? [];
    list.push({ placedOn: order.placedOn, arrivesOn: order.receivedOn, quantity: order.quantity });
    ordersByPair.set(key, list);
  }

  const shortfallByPair = new Map<string, { days: number; byDay: Map<DateOnly, number> }>();
  for (const shortfall of simulation.shortfalls) {
    const key = `${shortfall.facilityId}|${shortfall.itemId}`;
    const existing = shortfallByPair.get(key) ?? { days: 0, byDay: new Map<DateOnly, number>() };
    const share = shortfall.days === 0 ? 0 : shortfall.unmetUnits / shortfall.days;
    let day: DateOnly = shortfall.from;
    while (day <= shortfall.to) {
      existing.byDay.set(day, (existing.byDay.get(day) ?? 0) + share);
      day = addDays(day, 1);
    }
    existing.days += shortfall.days;
    shortfallByPair.set(key, existing);
  }

  const pairs: PolicyPair[] = [];

  for (const [key, entries] of [...entriesByPair].sort(([left], [right]) =>
    left < right ? -1 : 1,
  )) {
    const orders = (ordersByPair.get(key) ?? []).sort((left, right) =>
      left.placedOn < right.placedOn ? -1 : 1,
    );
    if (orders.length === 0) {
      continue;
    }

    const separator = key.indexOf('|');
    const facility = key.slice(0, separator) as FacilityId;
    const item = key.slice(separator + 1) as ItemId;

    const replay = replayStockLedger(entries, facility, item, {
      from: simulation.from,
      to: simulation.to,
    });
    const first = replay.days[0];
    if (first === undefined) {
      continue;
    }

    const unmet = shortfallByPair.get(key);
    const waits = orders.map((order) => daysBetween(order.placedOn, order.arrivesOn));

    pairs.push({
      facilityId: facility,
      itemId: item,
      openingOnHand: first.onHand,
      leadTimeDays: waits.length === 0 ? 7 : Math.round(median(waits)),
      orders,
      days: replay.days.map((day) => day.on),
      latent: replay.days.map((day) => day.issued + (unmet?.byDay.get(day.on) ?? 0)),
      recorded: replay.days.map((day) => day.issued),
      onHandHistory: replay.days.map((day) => day.onHand),
      actualShortDays: unmet?.days ?? 0,
      actualUnmetUnits:
        unmet === undefined ? 0 : [...unmet.byDay.values()].reduce((a, b) => a + b, 0),
    });
  }

  return pairs;
}
