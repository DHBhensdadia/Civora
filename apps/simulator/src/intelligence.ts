import { addDays, daysBetween, detectSurge, epidemicEventOf, ledgerDelta } from '@civora/domain';
import type { Alert, DateOnly, EpidemicEvent, FacilityId, Item, SyndromeDay } from '@civora/domain';
import { assessPopulation } from '@civora/forecasting';
import type { Assessment, AssessmentInput } from '@civora/forecasting';

import { buildScoredSeries } from './dataset-series';
import type { Network } from './network';
import type { Simulation } from './simulation';
import { ITEMS } from './anchors/catalogue';

/**
 * The analytical pipeline, in one place, over a generated world.
 *
 * It lives here rather than in the batch job for the reason `seeding.ts` does:
 * two callers need it. The `worker:score` command runs it to fill a store and
 * print a summary; the intelligence surface runs it to show a person what the
 * platform concludes. A second implementation on the web side would be the
 * easiest way for the two to disagree about the same dataset, and the whole
 * point of this platform's claim is that a figure on screen can be traced to one
 * run.
 *
 * Everything here is pure with respect to the world it is given: the same
 * simulation produces the same forecasts, scores and alerts. Nothing reads a
 * clock or a network.
 *
 * The pipeline is: detect syndromic surges, build one demand series per
 * facility-item pair from the ledger, forecast each with censored demand
 * corrected, lift the forecasts a surge touches, score nine drivers, raise the
 * alerts the scores justify, and deduplicate them against each other.
 */

/** What a caller can vary without changing the world. */
export interface IntelligenceOptions {
  /** Days the forecast and the score cover. */
  readonly horizonDays?: number;
  /** Prefix for the per-pair forecast seed, so a run is reproducible by name. */
  readonly seedPrefix?: string;
  /**
   * Bootstrap replications behind the upper quantile.
   *
   * The engine's default is higher than most callers need. The batch job scores
   * a population once and can afford the default; a surface that has to keep a
   * request to a few seconds lowers it and says so, because the number travels
   * on the forecast as a feature.
   */
  readonly bootstrapReplications?: number;
  /** Score at most this many pairs, in pair order. Null scores all of them. */
  readonly limit?: number | null;
}

export interface ScoredPopulation {
  readonly asOf: DateOnly;
  readonly horizonDays: number;
  readonly assessments: readonly Assessment[];
  /** The alerts the scores justified, after deduplication. */
  readonly alerts: readonly Alert[];
  readonly epidemicEvents: readonly EpidemicEvent[];
  /** Facilities with at least one detected surge. */
  readonly surgingFacilities: number;
  /** Pairs with a forecast lifted by a surge. */
  readonly liftedForecasts: number;
  readonly elapsedMs: number;
}

export const DEFAULT_INTELLIGENCE_OPTIONS: Required<
  Pick<IntelligenceOptions, 'horizonDays' | 'seedPrefix' | 'bootstrapReplications'>
> = {
  horizonDays: 14,
  seedPrefix: 'score',
  bootstrapReplications: 200,
};

/** Wait assumed for a pair whose orders have not been received yet. */
const FALLBACK_LEAD_TIME_DAYS = 7;

/**
 * The strongest detected surge per facility.
 *
 * One per facility because an assessment is made per item and every item that
 * treats any syndrome at that facility is affected by its strongest signal. A
 * weaker second syndrome would raise the lift on a different item set, and
 * summing them would double-count a facility having a bad week.
 */
export function surgesByFacility(
  simulation: Simulation,
): ReadonlyMap<string, ReturnType<typeof detectSurge>> {
  const byFacilitySyndrome = new Map<string, SyndromeDay[]>();

  for (const signal of simulation.syndromicSignals) {
    const key = `${signal.facilityId}|${signal.syndrome}`;
    const list = byFacilitySyndrome.get(key) ?? [];
    list.push({ on: signal.observedOn, caseCount: signal.caseCount });
    byFacilitySyndrome.set(key, list);
  }

  const strongest = new Map<string, ReturnType<typeof detectSurge>>();

  for (const [key, days] of byFacilitySyndrome) {
    const separator = key.indexOf('|');
    const facilityId = key.slice(0, separator);
    const syndromeValue = key.slice(separator + 1);
    const ordered = [...days].sort((left, right) => (left.on < right.on ? -1 : 1));

    const detection = detectSurge({
      syndrome: syndromeValue as Parameters<typeof detectSurge>[0]['syndrome'],
      days: ordered,
    });
    if (!detection.detected) {
      continue;
    }

    const existing = strongest.get(facilityId);
    if (existing === undefined || detection.excessCasesPerDay > existing.excessCasesPerDay) {
      strongest.set(facilityId, detection);
    }
  }

  return strongest;
}

/**
 * Every detected change, resolved to the administrative levels it belongs to.
 *
 * A signal resolves to a facility, so the event names the district and the
 * region that contains it. A facility whose district is unknown is skipped
 * rather than filed against the country: an epidemic event with nowhere to go is
 * worse than a missing one, because somebody will act on it.
 */
export function detectEpidemicEvents(
  simulation: Simulation,
  network: Network,
): readonly EpidemicEvent[] {
  const byFacilitySyndrome = new Map<string, SyndromeDay[]>();

  for (const signal of simulation.syndromicSignals) {
    const key = `${signal.facilityId}|${signal.syndrome}`;
    const list = byFacilitySyndrome.get(key) ?? [];
    list.push({ on: signal.observedOn, caseCount: signal.caseCount });
    byFacilitySyndrome.set(key, list);
  }

  const districtOf = new Map(
    network.facilities.map((facility) => [facility.id as string, facility.districtId as string]),
  );
  const regionOf = new Map(
    network.districts.map((district) => [district.id as string, district.regionId as string]),
  );

  const events: EpidemicEvent[] = [];

  for (const [key, days] of byFacilitySyndrome) {
    const separator = key.indexOf('|');
    const facilityId = key.slice(0, separator);
    const syndromeValue = key.slice(separator + 1);
    const districtId = districtOf.get(facilityId);
    const regionId = districtId === undefined ? undefined : regionOf.get(districtId);
    if (districtId === undefined || regionId === undefined) {
      continue;
    }

    const ordered = [...days].sort((left, right) => (left.on < right.on ? -1 : 1));
    const detection = detectSurge({
      syndrome: syndromeValue as Parameters<typeof detectSurge>[0]['syndrome'],
      days: ordered,
    });

    const event = epidemicEventOf({
      facilityId: facilityId as FacilityId,
      regionId: regionId as EpidemicEvent['regionId'],
      districtId: districtId as EpidemicEvent['districtId'],
      detection,
      synthetic: true,
      provenance: { kind: 'simulated', reference: 'surge-detection' },
      windowDays: detection.windowDays,
    });

    if (event !== null) {
      events.push(event);
    }
  }

  return events;
}

interface OrderBook {
  /** Days between placing and receiving, for every order that has arrived. */
  readonly waits: readonly number[];
  /** Units ordered and not yet received on the scoring day. */
  readonly inTransit: number;
}

/**
 * What the pair's own orders say: how long deliveries take, and what is still on
 * its way.
 *
 * In-transit matters more than it looks. A facility that holds four days of
 * stock and has a fortnight's order arriving on Friday is not at risk, and a
 * score that counts only the shelf calls it a critical shortage — which is what
 * the negative-control scenario found before this was wired in: on a world with
 * nothing wrong in it, the top-scoring pairs were all facilities with a delivery
 * already placed and in flight.
 *
 * The order record is the same source the lead-time driver reads, and in this
 * generated world it is the facility's own record of what it ordered. A
 * deployment reads it from the same place the ordering workflow writes it.
 */
function orderBook(simulation: Simulation): ReadonlyMap<string, OrderBook> {
  const byPair = new Map<string, { waits: number[]; inTransit: number }>();

  for (const order of simulation.orders) {
    const key = `${order.facilityId}|${order.itemId}`;
    const existing = byPair.get(key) ?? { waits: [], inTransit: 0 };

    if (order.receivedOn === null) {
      // Placed and not received by the end of the window: on its way, which is
      // what the platform should be counting against the shelf.
      existing.inTransit += order.quantity;
    } else {
      existing.waits.push(
        Math.round(
          (Date.parse(`${order.receivedOn}T00:00:00.000Z`) -
            Date.parse(`${order.placedOn}T00:00:00.000Z`)) /
            86_400_000,
        ),
      );
    }

    byPair.set(key, existing);
  }

  return byPair;
}

/** What the pair's own batches say about stock about to expire. */
interface ExpiryFacts {
  readonly daysToNearestExpiry: number | null;
  readonly nearExpiryUnits: number;
}

/**
 * The batch ledger, read for what is closest to expiring.
 *
 * Built from the entries' own `batchId` and `expiresOn`, which Phase 2's contract
 * put on every movement for exactly this reason: a platform that only counts
 * units cannot tell stock that will still be there next quarter from stock that
 * will be waste in a fortnight, and the difference is a reason not to order.
 *
 * Without this the expiry driver could never fire — the pipeline passed a null
 * and a zero — and a driver that can never move is a constant wearing a name,
 * which is the one thing the phase's explainability criterion refuses.
 */
function expiryByPair(
  simulation: Simulation,
  asOf: DateOnly,
  horizonDays: number,
): ReadonlyMap<string, ExpiryFacts> {
  interface BatchPosition {
    remaining: number;
    expiresOn: DateOnly | null;
  }

  const byPair = new Map<string, Map<string, BatchPosition>>();

  for (const entry of simulation.ledgerEntries) {
    if (entry.batchId === null) {
      continue;
    }
    const key = `${entry.facilityId}|${entry.itemId}`;
    const batches = byPair.get(key) ?? new Map<string, BatchPosition>();
    const batch = batches.get(entry.batchId) ?? { remaining: 0, expiresOn: entry.expiresOn };
    batch.remaining = Math.max(0, batch.remaining + ledgerDelta(entry));
    batch.expiresOn ??= entry.expiresOn;
    batches.set(entry.batchId, batch);
    byPair.set(key, batches);
  }

  const facts = new Map<string, ExpiryFacts>();
  for (const [key, batches] of byPair) {
    let nearest: number | null = null;
    let nearExpiryUnits = 0;

    for (const batch of batches.values()) {
      if (batch.remaining <= 0 || batch.expiresOn === null) {
        continue;
      }
      const days = daysBetween(asOf, batch.expiresOn);
      nearest = nearest === null ? days : Math.min(nearest, days);
      if (days <= horizonDays) {
        nearExpiryUnits += batch.remaining;
      }
    }

    facts.set(key, { daysToNearestExpiry: nearest, nearExpiryUnits });
  }

  return facts;
}

/** How long a facility has been silent, and how much of the recent window it missed. */
interface ReportingFacts {
  readonly daysSinceReading: number | null;
  readonly reportingGapDays: number;
}

/** Days of the recent window a gap is measured over. */
const REPORTING_WINDOW_DAYS = 30;

/**
 * Staleness, measured from what the network actually heard.
 *
 * A facility that has gone quiet is not a facility with good news; it is one the
 * platform cannot see, and the score has a driver for exactly that. Measured
 * from the reported days rather than from the newest observation, because an
 * observation captured offline and delivered a fortnight later was not heard on
 * the day it describes.
 */
function reportingFacts(
  simulation: Simulation,
  asOf: DateOnly,
): ReadonlyMap<string, ReportingFacts> {
  const facts = new Map<string, ReportingFacts>();

  for (const [facilityId, reporting] of simulation.reporting) {
    const heard = new Set<string>(reporting.reportedDays);
    const newest = [...heard].sort().at(-1) ?? null;
    const windowStart = addDays(asOf, -(REPORTING_WINDOW_DAYS - 1));

    let heardInWindow = 0;
    for (const day of heard) {
      if (day >= windowStart && day <= asOf) {
        heardInWindow += 1;
      }
    }

    facts.set(facilityId, {
      daysSinceReading: newest === null ? null : daysBetween(newest, asOf),
      reportingGapDays: Math.max(0, REPORTING_WINDOW_DAYS - heardInWindow),
    });
  }

  return facts;
}

const medianOf = (values: readonly number[]): number =>
  values.length === 0
    ? FALLBACK_LEAD_TIME_DAYS
    : ([...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ??
      FALLBACK_LEAD_TIME_DAYS);

/**
 * Everything the forecaster and the scorer are given about one pair.
 *
 * The lead time is read off the orders the world actually placed rather than
 * assumed, because lead-time variability is one of the nine drivers and a
 * constant would make that driver a constant wearing a name.
 */
export function buildAssessmentInputs(
  simulation: Simulation,
  network: Network,
  options: IntelligenceOptions = {},
): { readonly inputs: readonly AssessmentInput[]; readonly itemOf: ReadonlyMap<string, Item> } {
  const bootstrapReplications =
    options.bootstrapReplications ?? DEFAULT_INTELLIGENCE_OPTIONS.bootstrapReplications;
  const seedPrefix = options.seedPrefix ?? DEFAULT_INTELLIGENCE_OPTIONS.seedPrefix;
  const horizonDays = options.horizonDays ?? DEFAULT_INTELLIGENCE_OPTIONS.horizonDays;

  const scored = buildScoredSeries(simulation);
  const surges = surgesByFacility(simulation);
  const books = orderBook(simulation);
  const reporting = reportingFacts(simulation, simulation.to);
  const expiry = expiryByPair(simulation, simulation.to, horizonDays);
  const itemById = new Map(ITEMS.map((item): [string, Item] => [item.id, item]));
  const facilityById = new Map(
    network.facilities.map((facility) => [facility.id as string, facility]),
  );
  const asOf: DateOnly = simulation.to;

  let entries = scored.entries;
  if (options.limit !== null && options.limit !== undefined) {
    entries = entries.slice(0, options.limit);
  }

  const inputs: AssessmentInput[] = [];
  const itemOf = new Map<string, Item>();

  for (const entry of entries) {
    const item = itemById.get(entry.series.itemId);
    // Unreachable while the series builder walks the catalogue, but a pair scored
    // against the wrong essentiality would be silently wrong, so it stops.
    if (item === undefined) {
      throw new Error(
        `the generated series names an item the catalogue does not hold: ${entry.series.itemId}`,
      );
    }
    const key = `${entry.series.facilityId}|${entry.series.itemId}`;
    const observed = books.get(key);
    const silence = reporting.get(entry.series.facilityId);
    const last = entry.series.points[entry.series.points.length - 1];
    const ordered = observed === undefined ? [] : [...observed.waits].sort((a, b) => a - b);
    const inTransit = observed?.inTransit ?? 0;

    itemOf.set(key, item);
    inputs.push({
      facilityId: entry.series.facilityId,
      item,
      series: entry.series,
      asOf,
      horizonDays,
      // The last day's closing position, which is what the platform last saw.
      onHand: last?.onHand ?? 0,
      // Stock already ordered and on its way, counted against the shelf for the
      // same reason a real platform counts it: the facility will not run out of
      // what is arriving inside the lead time.
      inTransit,
      leadTimeDays: medianOf(observed?.waits ?? []),
      leadTimeSpreadDays: ordered.length < 2 ? 0 : Math.max(...ordered) - Math.min(...ordered),
      orderInFlight: inTransit > 0,
      catchmentPopulation: facilityById.get(entry.series.facilityId)?.catchmentPopulation ?? 20000,
      footfallTrend: null,
      surge: surges.get(entry.series.facilityId) ?? null,
      daysToNearestExpiry: expiry.get(key)?.daysToNearestExpiry ?? null,
      nearExpiryUnits: expiry.get(key)?.nearExpiryUnits ?? 0,
      daysSinceReading: silence?.daysSinceReading ?? null,
      reportingGapDays: silence?.reportingGapDays ?? 0,
      coldChainBreachDays: null,
      seed: `${seedPrefix}:${key}:${asOf}`,
      synthetic: true,
      provenance: { kind: 'derived', reference: 'score-population' },
      engineOptions: { bootstrapReplications },
    });
  }

  return { inputs, itemOf };
}

/**
 * Score a whole generated world.
 *
 * The scored population has one `asOf` — the last day of the generated window —
 * so two readers looking at the same district see the same figures. Alerts are
 * deduplicated by condition, which is what stops a daily re-run from raising the
 * same alert again for every morning it persists.
 */
export function scorePopulation(
  simulation: Simulation,
  network: Network,
  options: IntelligenceOptions = {},
): ScoredPopulation {
  const startedAt = Date.now();
  const { inputs } = buildAssessmentInputs(simulation, network, options);

  const facilityById = new Map(
    network.facilities.map((facility) => [facility.id as string, facility]),
  );
  const itemById = new Map(ITEMS.map((item) => [item.id as string, item]));

  const { assessments, raised } = assessPopulation(inputs, {
    facilityNameOf: (facilityId) => facilityById.get(facilityId)?.name ?? facilityId,
    itemNameOf: (itemId) => itemById.get(itemId)?.genericName ?? itemId,
  });

  const epidemicEvents = detectEpidemicEvents(simulation, network);

  return {
    asOf: simulation.to,
    horizonDays: options.horizonDays ?? DEFAULT_INTELLIGENCE_OPTIONS.horizonDays,
    assessments,
    alerts: raised,
    epidemicEvents,
    surgingFacilities: new Set(epidemicEvents.map((event) => event.facilityId)).size,
    liftedForecasts: assessments.filter((assessment) => assessment.lift.multiplier > 1).length,
    elapsedMs: Date.now() - startedAt,
  };
}
