import { choroplethFor, mapProviderFor, regionCentres } from '@civora/geo';
import type { Choropleth } from '@civora/geo';
import type {
  Alert,
  AlertSeverity,
  Facility,
  ItemId,
  MovementEvidence,
  RiskBand,
  RiskDriver,
} from '@civora/domain';

import { getEnv } from '@/env';
import { countEvent } from './counters';
import { readScoredPopulation } from './intelligence-service';
import { getLiveStore } from './live-store';
import { loopBreaker } from './loop-breaker';
import { sharedSlot } from './process-cache';
import { canReadDistrict, scopeRefusalFor } from './session';
import type { Session } from './session';
import { tierLabelOf } from './tiers';

/**
 * The control tower's read model.
 *
 * **It assembles; it does not create.** Every figure here is read from a
 * computation that already exists — the ledger projection Phase 3 built, the
 * scored population Phase 4 built, the alert set Phase 4 keeps, the seeded
 * network — and this file's only job is to arrange them so an officer can see
 * the country and then walk down to the record behind one item. A control tower
 * that recomputed a risk score or re-planned a transfer would make two numbers
 * for one fact, which is the failure this whole phase exists to avoid.
 *
 * Three rules are inherited rather than reinvented:
 *
 *  - **Scope first.** Every facility in a read is one `canReadDistrict` admitted,
 *    and a district outside the session's scope is refused rather than silently
 *    dropped — the same rule the visibility read applies, applied to a national
 *    list.
 *  - **Absence is a state.** A facility the platform has not heard from appears
 *    as `never-heard`, counted in the tower's own figures and coloured as its own
 *    map class; it is never a facility with an empty shelf or a good score.
 *  - **The bands are Phase 4's.** The map colours the pairs the risk engine put
 *    in `unknown`, `critical` or `high`, counted, not re-derived. A pair's band
 *    and its drivers come from the scored population, so the tower and the
 *    intelligence surface cannot disagree about the same pair.
 *
 * What it is not: a second store, a second projection or a cache. The expensive
 * parts (`getLiveStore`, the scored population) are memoised per process by the
 * modules that own them, and everything in this file is arithmetic over those.
 */

/** How the tower aggregates: one row per region, per district or per facility. */
export const COMMAND_TIERS = ['state', 'district', 'facility'] as const;
export type CommandTier = (typeof COMMAND_TIERS)[number];

export const isCommandTier = (value: string | undefined): value is CommandTier =>
  value !== undefined && (COMMAND_TIERS as readonly string[]).includes(value);

/** The bands the tower counts as risk, mirrored from the domain's alert rule. */
const AT_RISK_BANDS: ReadonlySet<RiskBand> = new Set<RiskBand>(['unknown', 'critical', 'high']);

/** How many movements the change strip lists, having counted them all. */
const CHANGE_SAMPLE = 6;

export interface FacilityFact {
  readonly facility: Facility;
  readonly districtId: string;
  readonly districtName: string;
  readonly regionId: string;
  readonly regionName: string;
  readonly tierLabel: string;
  readonly status: 'current' | 'stale' | 'never-heard';
  readonly newestReadingOn: string | null;
  readonly daysSinceReading: number | null;
  readonly itemsTracked: number;
  readonly itemsOutOfStock: number;
  readonly itemsBelowCritical: number;
  readonly bedOccupancy: number | null;
  readonly bedsObservedOn: string | null;
  /** Facility-item pairs Phase 4's risk engine put in an alerting band. */
  readonly atRiskPairs: number;
  readonly openAlerts: number;
  readonly criticalAlerts: number;
  readonly gapDays: number;
}

export interface CommandAggregate {
  readonly id: string;
  readonly name: string;
  readonly level: 'region' | 'district';
  readonly parent: string | null;
  readonly facilities: number;
  readonly heard: number;
  readonly stale: number;
  readonly neverHeard: number;
  readonly atRiskPairs: number;
  readonly openAlerts: number;
  readonly criticalAlerts: number;
  readonly itemsOutOfStock: number;
  readonly itemsBelowCritical: number;
  readonly bedOccupancy: number | null;
}

export interface CommandChange {
  /** The platform's latest day, which is what "the last 24 hours" means here. */
  readonly day: string;
  readonly movements: number;
  readonly facilitiesReporting: number;
  readonly bySource: readonly { readonly label: string; readonly count: number }[];
  readonly sample: readonly {
    readonly facilityId: string;
    readonly facilityName: string;
    readonly itemName: string;
    readonly kind: string;
    readonly quantity: number;
    readonly captureSource: string;
  }[];
  /** Said on the surface rather than implied: there is no change feed locally. */
  readonly note: string;
}

export interface TowerMap {
  readonly renderer: 'google-maps' | 'schematic';
  readonly refusal: string | null;
  readonly keyVariable: string;
  readonly classes: Choropleth;
  readonly markers: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: number | null;
    readonly classIndex: number | null;
    readonly x: number;
    readonly y: number;
    readonly inside: boolean;
  }[];
  readonly valueLabel: string;
}

export interface CommandTower {
  readonly asOf: string;
  readonly seed: string;
  readonly fingerprint: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly session: {
    readonly role: string;
    readonly label: string;
    readonly scopeId: string | null;
  };
  /** False when the read is narrowed to part of the country. */
  readonly national: boolean;
  readonly tier: CommandTier;
  readonly regions: readonly CommandAggregate[];
  readonly districts: readonly CommandAggregate[];
  readonly facilities: readonly FacilityFact[];
  readonly change: CommandChange;
  readonly map: TowerMap;
  readonly counts: {
    readonly regions: number;
    readonly districts: number;
    readonly facilities: number;
    readonly heard: number;
    readonly stale: number;
    readonly neverHeard: number;
    readonly atRiskPairs: number;
    readonly openAlerts: number;
  };
  /** False when the read found no facility at all, which is its own answer. */
  readonly readiness: boolean;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/**
 * One pass over the seeded network and the projections, scoped to a session.
 *
 * Written as one function rather than four readers because the four public reads
 * below are views of the same scan, and four scans would be four chances for the
 * tower and the drill-down to disagree about a facility.
 *
 * **Measured, and the reason a memo exists.** Unmemoised, the first read of the
 * country cost 13.3 s of application time in the development server — every
 * facility's reading is a replay of ninety days of its own ledger, and the tower
 * asks for all of them. So a scan is kept per session scope and **per ledger
 * revision**: the ledger's own write counter, which is what makes a capture
 * invalidate the memo instead of leaving a stale country on the screen. The
 * measurement is recorded in `docs/control-tower.md` beside the aggregation
 * strategy, because a claim of precomputation without a number is a claim.
 */
interface Scanned {
  readonly facts: readonly FacilityFact[];
  readonly hiddenDistricts: number;
  readonly regionNames: ReadonlyMap<string, string>;
  readonly districtNames: ReadonlyMap<string, string>;
  readonly districtRegion: ReadonlyMap<string, string>;
  readonly regionOrder: readonly string[];
  readonly districtOrder: readonly string[];
}

/**
 * The memo table, parked where every copy of this module finds the same one.
 *
 * A scan filled in by the start-up warm-up must be the scan a route handler reads,
 * and the two live in bundles Next compiles separately — `process-cache.ts` has the
 * build output that shows it. Without the slot the warm would fill a table nobody
 * reads, and the first visitor would pay the whole scan as though nothing had run.
 */
const scans = sharedSlot<Map<string, ScanEntry>>('__civoraCommandScans').ensure(() => new Map());

interface ScanEntry {
  readonly revision: number;
  readonly value: Promise<Scanned>;
}

async function scan(session: Session): Promise<Scanned> {
  const store = await getLiveStore();
  const revision = store.ledger.revision();
  const key = `${session.role}|${session.scopeId ?? ''}`;
  const cached = scans.get(key);

  if (cached?.revision === revision) {
    // Counted, because the memo's effect is otherwise a claim: `/api/metrics`
    // reports the cold scans against the ones the memo answered, which is the
    // figure the performance note in `docs/control-tower.md` is about.
    countEvent('tower.scan.warm');
    return await cached.value;
  }

  countEvent('tower.scan.cold');

  // One entry per scope, replaced when a record arrives: a memo table that grew
  // per write would be a leak wearing a cache's clothes, and one that ignored
  // writes would show a capture that was just filed as though it had not been.
  const value = scanUncached(session);
  scans.set(key, { revision, value });
  return await value;
}

async function scanUncached(session: Session): Promise<Scanned> {
  const store = await getLiveStore();
  const population = await readScoredPopulation();

  // Phase 4's scored population, keyed by facility, so a band is read and never
  // re-derived. Built once here rather than filtered per facility.
  const riskByFacility = new Map<string, { atRisk: number; bands: Map<string, RiskBand> }>();
  const alertCounts = new Map<string, { open: number; critical: number }>();
  for (const assessment of population.assessments) {
    const entry = riskByFacility.get(assessment.facilityId) ?? {
      atRisk: 0,
      bands: new Map<string, RiskBand>(),
    };
    entry.bands.set(assessment.itemId, assessment.risk.band);
    if (AT_RISK_BANDS.has(assessment.risk.band)) {
      entry.atRisk += 1;
    }
    riskByFacility.set(assessment.facilityId, entry);
  }
  for (const alert of population.alerts) {
    const counts = alertCounts.get(alert.facilityId) ?? { open: 0, critical: 0 };
    if (alert.state !== 'resolved') {
      counts.open += 1;
    }
    if (alert.severity === 'critical' && alert.state !== 'resolved') {
      counts.critical += 1;
    }
    alertCounts.set(alert.facilityId, counts);
  }

  const regionNames = new Map(store.dataset.network.regions.map((r) => [r.id, r.name]));
  const districtNames = new Map(store.dataset.network.districts.map((d) => [d.id, d.name]));
  const districtRegion = new Map(store.dataset.network.districts.map((d) => [d.id, d.regionId]));

  const facts: FacilityFact[] = [];
  let hiddenDistricts = 0;
  // The scan is short work repeated: yielding on a time budget keeps the process
  // answering its own health check while it runs (`loop-breaker.ts`).
  const breathe = loopBreaker();
  for (const district of store.dataset.network.districts) {
    if (!canReadDistrict(session, district.id, store.scope)) {
      hiddenDistricts += 1;
      continue;
    }
    for (const facility of store.dataset.network.facilities.filter(
      (candidate) => candidate.districtId === district.id,
    )) {
      await breathe();
      const reading = store.ledger.readingFor(facility.id);
      const stock = reading.stock;
      const risk = riskByFacility.get(facility.id);
      const alerts = alertCounts.get(facility.id);
      facts.push({
        facility,
        districtId: district.id,
        districtName: district.name,
        regionId: district.regionId,
        regionName: regionNames.get(district.regionId) ?? district.regionId,
        tierLabel: tierLabelOf(facility.tier),
        status: reading.status,
        newestReadingOn: reading.newestReadingOn,
        daysSinceReading: reading.daysSinceReading,
        itemsTracked: stock?.itemsTracked ?? 0,
        itemsOutOfStock: stock?.itemsOutOfStock ?? 0,
        itemsBelowCritical: stock?.itemsBelowCritical ?? 0,
        bedOccupancy: reading.beds?.occupancy ?? null,
        bedsObservedOn: reading.beds?.observedOn ?? null,
        atRiskPairs: risk?.atRisk ?? 0,
        openAlerts: alerts?.open ?? 0,
        criticalAlerts: alerts?.critical ?? 0,
        gapDays: reading.gaps.reduce((longest, gap) => Math.max(longest, gap.days), 0),
      });
    }
  }

  const regionOrder = store.dataset.network.regions.map((region) => region.id);
  const districtOrder = store.dataset.network.districts
    .filter((district) => canReadDistrict(session, district.id, store.scope))
    .map((district) => district.id);

  return {
    facts,
    hiddenDistricts,
    regionNames,
    districtNames,
    districtRegion,
    regionOrder,
    districtOrder,
  };
}

function aggregate(
  id: string,
  name: string,
  level: 'region' | 'district',
  parent: string | null,
  facts: readonly FacilityFact[],
): CommandAggregate {
  let heard = 0;
  let stale = 0;
  let neverHeard = 0;
  let bedsOccupied = 0;
  let bedsTotal = 0;
  for (const fact of facts) {
    if (fact.status === 'never-heard') {
      neverHeard += 1;
    } else {
      heard += 1;
    }
    if (fact.status === 'stale') {
      stale += 1;
    }
    if (fact.status !== 'never-heard' && fact.bedOccupancy !== null) {
      const beds = fact.facility.sanctionedBeds;
      bedsTotal += beds;
      bedsOccupied += beds * fact.bedOccupancy;
    }
  }

  return {
    id,
    name,
    level,
    parent,
    facilities: facts.length,
    heard,
    stale,
    neverHeard,
    atRiskPairs: facts.reduce((total, fact) => total + fact.atRiskPairs, 0),
    openAlerts: facts.reduce((total, fact) => total + fact.openAlerts, 0),
    criticalAlerts: facts.reduce((total, fact) => total + fact.criticalAlerts, 0),
    itemsOutOfStock: facts.reduce((total, fact) => total + fact.itemsOutOfStock, 0),
    itemsBelowCritical: facts.reduce((total, fact) => total + fact.itemsBelowCritical, 0),
    bedOccupancy: bedsTotal === 0 ? null : bedsOccupied / bedsTotal,
  };
}

/** What changed on the platform's latest day, and how it arrived. */
function changeFor(
  store: Awaited<ReturnType<typeof getLiveStore>>,
  facts: readonly FacilityFact[],
): CommandChange {
  const day = store.ledger.asOf();
  const itemName = (itemId: string): string =>
    store.catalogue.find((item) => item.id === itemId)?.genericName ?? itemId;

  let movements = 0;
  let facilitiesReporting = 0;
  const bySource = new Map<string, number>();
  const sample: CommandChange['sample'][number][] = [];

  for (const fact of facts) {
    const recent = store.ledger.recentMovements(fact.facility.id, 20);
    const onDay = recent.filter((movement) => movement.occurredOn === day);
    if (onDay.length > 0) {
      facilitiesReporting += 1;
    }
    for (const movement of onDay) {
      movements += 1;
      bySource.set(movement.captureSource, (bySource.get(movement.captureSource) ?? 0) + 1);
      if (sample.length < CHANGE_SAMPLE) {
        sample.push({
          facilityId: fact.facility.id,
          facilityName: fact.facility.name,
          itemName: itemName(movement.itemId),
          kind: movement.kind,
          quantity: movement.quantity,
          captureSource: movement.captureSource,
        });
      }
    }
  }

  return {
    day,
    movements,
    facilitiesReporting,
    bySource: [...bySource]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .map(([label, count]) => ({ label, count })),
    sample,
    note: 'The local adapter has no change feed, so this is what moved on the platform’s latest day rather than a push notification.',
  };
}

/** The map, from the region rollup — markers placed and shaded, never recomputed. */
function mapFor(
  regions: readonly CommandAggregate[],
  facts: readonly FacilityFact[],
  regionOrder: readonly string[],
): TowerMap {
  const centres = new Map(
    regionCentres(
      facts.map((fact) => ({
        regionId: fact.regionId,
        latitude: fact.facility.coordinates.latitude,
        longitude: fact.facility.coordinates.longitude,
      })),
    ).map((centre) => [centre.regionId, centre.point]),
  );

  const byRegion = new Map(regions.map((region) => [region.id, region]));
  // One marker per region the read covers, in the network's own order, so the
  // map's squares do not shuffle between two renders of one read.
  const markers = regionOrder
    .map((regionId) => {
      const region = byRegion.get(regionId);
      const point = centres.get(regionId);
      return region === undefined || point === undefined
        ? null
        : {
            id: regionId,
            label: region.name,
            point,
            value: region.atRiskPairs,
          };
    })
    .filter(
      (
        marker,
      ): marker is {
        id: string;
        label: string;
        point: { latitude: number; longitude: number };
        value: number;
      } => marker !== null,
    );

  const decision = mapProviderFor({
    apiKey: getEnv().mapsApiKey,
    markers,
    zoom: 4,
  });

  const classes = choroplethFor(markers.map((marker) => marker.value));
  const placed = decision.renderer.markers.map((marker) => ({
    id: marker.id,
    label: marker.label,
    value: marker.value,
    classIndex: classes.classIndexFor(marker.value),
    x: marker.placement.x,
    y: marker.placement.y,
    inside: marker.placement.inside,
  }));

  return {
    renderer: decision.renderer.kind,
    refusal: decision.refusal,
    keyVariable: decision.keyVariable,
    classes,
    markers: placed,
    valueLabel: 'facility-item pairs at risk',
  };
}

/** The national picture, aggregated at the level the caller asks for. */
export async function readCommandTower(
  session: Session,
  options: { readonly tier?: CommandTier | undefined } = {},
): Promise<CommandTower> {
  const store = await getLiveStore();
  const scanned = await scan(session);
  const tier = options.tier ?? 'state';

  const regions = scanned.regionOrder
    .map((regionId) => {
      const regionFacts = scanned.facts.filter((fact) => fact.regionId === regionId);
      return regionFacts.length === 0
        ? null
        : aggregate(
            regionId,
            scanned.regionNames.get(regionId) ?? regionId,
            'region',
            null,
            regionFacts,
          );
    })
    .filter((region): region is CommandAggregate => region !== null);

  const districts = scanned.districtOrder.map((districtId) =>
    aggregate(
      districtId,
      scanned.districtNames.get(districtId) ?? districtId,
      'district',
      scanned.districtRegion.get(districtId) ?? null,
      scanned.facts.filter((fact) => fact.districtId === districtId),
    ),
  );

  const heard = scanned.facts.filter((fact) => fact.status !== 'never-heard').length;

  return {
    asOf: store.ledger.asOf(),
    seed: store.info.seed,
    fingerprint: store.info.fingerprint,
    scenarioId: store.info.scenarioId,
    scenarioLabel: store.info.scenarioLabel,
    window: store.info.window,
    session: { role: session.role, label: session.label, scopeId: session.scopeId },
    national: scanned.hiddenDistricts === 0,
    tier,
    regions,
    districts,
    facilities: scanned.facts,
    change: changeFor(store, scanned.facts),
    map: mapFor(regions, scanned.facts, scanned.regionOrder),
    counts: {
      regions: regions.length,
      districts: districts.length,
      facilities: scanned.facts.length,
      heard,
      stale: scanned.facts.filter((fact) => fact.status === 'stale').length,
      neverHeard: scanned.facts.length - heard,
      atRiskPairs: regions.reduce((total, region) => total + region.atRiskPairs, 0),
      openAlerts: regions.reduce((total, region) => total + region.openAlerts, 0),
    },
    readiness: scanned.facts.length > 0,
  };
}

/** One district's facilities, as the drill-down's second step. */
export async function readDistrictStep(
  session: Session,
  districtId: string,
): Promise<
  | { readonly allowed: false; readonly refusal: string }
  | {
      readonly allowed: true;
      readonly district: { id: string; name: string; regionName: string };
      readonly facilities: readonly FacilityFact[];
    }
> {
  const store = await getLiveStore();
  const district = store.dataset.network.districts.find((candidate) => candidate.id === districtId);
  if (district === undefined) {
    return {
      allowed: false,
      refusal: `no district in this network has the identifier ${districtId}`,
    };
  }
  if (!canReadDistrict(session, district.id, store.scope)) {
    return { allowed: false, refusal: scopeRefusalFor(session, 'district') };
  }

  const scanned = await scan(session);
  const facilities = scanned.facts
    .filter((fact) => fact.districtId === district.id)
    // Attention first: what the platform cannot see, then the worst risk, then
    // by name — the same order the visibility surface lists a district in.
    .sort((left, right) => {
      const rank = (fact: FacilityFact): number =>
        fact.status === 'never-heard' ? 0 : fact.status === 'stale' ? 1 : 2;
      const byStatus = rank(left) - rank(right);
      if (byStatus !== 0) {
        return byStatus;
      }
      const byRisk = right.atRiskPairs - left.atRiskPairs;
      return byRisk !== 0 ? byRisk : left.facility.name < right.facility.name ? -1 : 1;
    });

  return {
    allowed: true,
    district: {
      id: district.id,
      name: district.name,
      regionName: scanned.regionNames.get(district.regionId) ?? district.regionId,
    },
    facilities,
  };
}

export interface CommandItem {
  /** Typed as the catalogue's own identifier, so a ledger read cannot take a name. */
  readonly itemId: ItemId;
  readonly name: string;
  readonly unit: string;
  readonly essentiality: string;
  readonly coldChain: boolean;
  readonly onHand: number;
  readonly inTransit: number;
  readonly daysOfStock: number | null;
  readonly demandBasis: string;
  readonly lastMovementOn: string | null;
  readonly band: RiskBand | null;
}

export interface FacilityStep {
  readonly facility: FacilityFact;
  readonly items: readonly CommandItem[];
  /** The item whose record is open, when the caller asked for one. */
  readonly item: CommandItem | null;
  readonly drivers: readonly {
    readonly driver: RiskDriver;
    readonly contribution: number;
    readonly detail: string;
  }[];
  readonly missing: readonly string[];
  readonly shortfallWindowDays: number | null;
  readonly horizonDays: number | null;
  readonly alerts: readonly CommandAlert[];
}

/** One alert, as the drill-down reads it. */
export interface CommandAlert {
  readonly id: string;
  readonly severity: AlertSeverity;
  readonly state: string;
  readonly raisedOn: string;
  readonly itemId: string;
}

/** The alerts on a facility, or on one item at it, newest first. */
const alertsFor = (
  alerts: readonly Alert[],
  facilityId: string,
  itemId?: string,
): readonly CommandAlert[] =>
  alerts
    .filter(
      (alert) =>
        alert.facilityId === facilityId && (itemId === undefined || alert.itemId === itemId),
    )
    .sort((left, right) => (left.raisedOn < right.raisedOn ? 1 : -1))
    .map((alert) => ({
      id: alert.id,
      severity: alert.severity,
      state: alert.state,
      raisedOn: alert.raisedOn,
      itemId: alert.itemId,
    }));

/**
 * One facility's items, and the risk facts behind one of them.
 *
 * The terminal step of the drill-down is `readItemEvidence` below; this is the
 * level above it, and the two are separated because a reader looking at a
 * facility's shelves and a reader checking one item's record are asking two
 * different questions of the same records.
 */
export async function readFacilityStep(
  session: Session,
  districtId: string,
  facilityId: string,
  itemId?: string,
): Promise<
  | { readonly allowed: false; readonly refusal: string }
  | ({ readonly allowed: true } & FacilityStep)
> {
  const store = await getLiveStore();
  const district = await readDistrictStep(session, districtId);
  if (!district.allowed) {
    return district;
  }

  const facility = district.facilities.find((fact) => fact.facility.id === facilityId);
  if (facility === undefined) {
    return {
      allowed: false,
      refusal: `facility ${facilityId} is not in district ${districtId}`,
    };
  }

  const population = await readScoredPopulation();
  // The ledger and the catalogue are read with the identifiers the network and
  // the catalogue themselves carry, not with the strings that arrived in a URL:
  // a facility id that is not in this district was refused above, and an item id
  // that is not in the catalogue falls out as "no such item" below.
  const facilityKey = facility.facility.id;
  const assessments = population.assessments.filter(
    (assessment) => assessment.facilityId === facilityKey,
  );
  const byItem = new Map(assessments.map((assessment) => [assessment.itemId, assessment.risk]));
  const stock = store.ledger.stockFor(facilityKey);

  const items: CommandItem[] = (stock?.items ?? []).map((position) => ({
    itemId: position.itemId,
    name: position.name,
    unit: position.unit,
    essentiality: position.essentiality,
    coldChain: position.coldChain,
    onHand: position.onHand,
    inTransit: position.inTransit,
    daysOfStock: position.daysOfStock,
    demandBasis: position.demandBasis,
    lastMovementOn: position.lastMovementOn,
    band: byItem.get(position.itemId)?.band ?? null,
  }));

  // The item the URL asked for, matched once against the catalogue's own
  // identifiers: an item the catalogue does not hold falls out here as "no such
  // item" rather than as a position of zero.
  const chosen =
    itemId === undefined
      ? undefined
      : store.catalogue.find((item) => (item.id as string) === itemId);
  const position =
    chosen === undefined ? undefined : items.find((entry) => entry.itemId === chosen.id);
  const risk = chosen === undefined ? undefined : byItem.get(chosen.id);

  return {
    allowed: true,
    facility,
    items,
    item:
      chosen === undefined
        ? null
        : {
            itemId: chosen.id,
            name: chosen.genericName,
            unit: chosen.unit,
            essentiality: chosen.essentiality,
            coldChain: chosen.coldChain,
            onHand: position?.onHand ?? 0,
            inTransit: position?.inTransit ?? 0,
            daysOfStock: position?.daysOfStock ?? null,
            demandBasis: position?.demandBasis ?? 'unavailable',
            lastMovementOn: position?.lastMovementOn ?? null,
            band: risk?.band ?? null,
          },
    drivers: risk?.drivers ?? [],
    missing: risk?.missing ?? [],
    shortfallWindowDays:
      risk?.facts.find((fact) => fact.name === 'shortfallWindowDays')?.value ?? null,
    horizonDays: risk?.horizonDays ?? null,
    alerts: alertsFor(population.alerts, facilityKey, chosen?.id),
  };
}

/**
 * The record behind one item's figure: the movements, with their batches.
 *
 * This is where the drill-down is required to stop being a set of linked pages
 * and start being evidence: the day each movement belongs to, the day it reached
 * the platform, the batch and its expiry, how it was captured, and whether the
 * record is simulated. A stock figure and a forecast are derivations; this is
 * what they were derived from.
 */
export async function readItemEvidence(
  session: Session,
  districtId: string,
  facilityId: string,
  itemId: string,
): Promise<
  | { readonly allowed: false; readonly refusal: string }
  | {
      readonly allowed: true;
      readonly facility: FacilityFact;
      readonly item: CommandItem;
      readonly movements: readonly MovementEvidence[];
      readonly alerts: readonly CommandAlert[];
      readonly drivers: readonly {
        readonly driver: RiskDriver;
        readonly contribution: number;
        readonly detail: string;
      }[];
      readonly missing: readonly string[];
      readonly shortfallWindowDays: number | null;
      readonly horizonDays: number | null;
    }
> {
  const store = await getLiveStore();
  const step = await readFacilityStep(session, districtId, facilityId, itemId);
  if (!step.allowed) {
    return step;
  }
  if (step.item === null) {
    return {
      allowed: false,
      refusal: `this facility tracks no item with the identifier ${itemId}`,
    };
  }

  return {
    allowed: true,
    facility: step.facility,
    item: step.item,
    movements: store.ledger.evidenceFor(step.facility.facility.id, step.item.itemId, 10),
    alerts: step.alerts,
    drivers: step.drivers,
    missing: step.missing,
    shortfallWindowDays: step.shortfallWindowDays,
    horizonDays: step.horizonDays,
  };
}

/** The share of a facility's items at risk, for a tower row's hint text. */
export const riskShareOf = (fact: FacilityFact): number =>
  share(fact.atRiskPairs, Math.max(fact.itemsTracked, 1));
