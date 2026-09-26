import { InMemoryDataProvider } from '@civora/domain';
import type { DataProvider, DistrictId, FacilityId, Item, LedgerService } from '@civora/domain';
import {
  DEMO_SEED,
  ITEMS,
  buildDemoDataset,
  projectSimulation,
  seedDataProvider,
} from '@civora/simulator';
import type { DemoDataset } from '@civora/simulator';

import { NATIONAL_SESSION } from './session';
import type { Principal, ScopeLookup } from './session';

/**
 * The demonstration environment: one dataset, stored and projected.
 *
 * Three things are bound together here, and the binding is the point.
 *
 *  - The **store** is the persistence port, seeded from the generator. It is
 *    what the ingest boundary reads to find a receipt or an existing record, so
 *    a resend from an offline client addresses the document the seeder wrote.
 *  - The **projection** is derived from the same records by replaying them, once
 *    at start-up and then incrementally as captures arrive. A dashboard that
 *    re-read a quarter of a million entries per request would be unusable, and
 *    one that read a different dataset than the store holds would be wrong.
 *  - The **principals** are the fixture identities the sign-in control offers,
 *    built from the network so a scope can only name a place that exists.
 *
 * Everything is generated, and every surface built on this says so. The seed is
 * published (`civora-demo-2026`), so the exact dataset below can be regenerated
 * and the fingerprints compared.
 *
 * The store is built once per process and reused. In a deployment the same
 * wiring would point the port at a managed database and the projection at a
 * materialised view; nothing above this file knows which of the two it has.
 */

export interface StoreInfo {
  readonly seed: string;
  readonly scenarioId: string;
  readonly scenarioLabel: string;
  readonly expectation: string;
  readonly negativeControl: boolean;
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly fingerprint: string;
  readonly documents: number;
  readonly generatedInMs: number;
  readonly seededInMs: number;
  readonly collections: readonly { readonly collection: string; readonly documents: number }[];
  readonly facilities: number;
  readonly facilitiesWithHistory: number;
  readonly districts: number;
  readonly items: number;
}

export interface LiveStore {
  readonly dataset: DemoDataset;
  readonly provider: DataProvider;
  readonly ledger: LedgerService;
  readonly info: StoreInfo;
  /** The catalogue the dataset was generated against. */
  readonly catalogue: readonly Item[];
  /** Facilities the generated dataset holds a history for. */
  readonly historyFacilities: readonly FacilityId[];
  /** The district the interface opens on: the first one with any history. */
  readonly defaultDistrictId: DistrictId;
  readonly principals: readonly Principal[];
  readonly scope: ScopeLookup;
}

const ascending = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * The identities the development build offers.
 *
 * Fixtures rather than accounts, and named as such wherever they are shown.
 * Real sign-in replaces this list; the rules it feeds do not change, because
 * they are written against the role and the scope rather than against a name.
 */
function buildPrincipals(
  dataset: DemoDataset,
  historyFacilities: readonly FacilityId[],
): readonly Principal[] {
  const { network } = dataset;
  const districtById = new Map(network.districts.map((district) => [district.id, district]));
  const regionById = new Map(network.regions.map((region) => [region.id, region]));
  const facilityById = new Map(network.facilities.map((facility) => [facility.id, facility]));

  const principals: Principal[] = [{ ...NATIONAL_SESSION, id: 'national', place: 'India' }];

  // One district officer per district that has anything to look at, plus the
  // district the interface opens on, so a demonstration can show both a scoped
  // read and a refusal without inventing an account.
  const districtsWithHistory = new Map<DistrictId, string>();
  for (const facilityId of historyFacilities) {
    const facility = facilityById.get(facilityId);
    if (facility === undefined) {
      continue;
    }
    const district = districtById.get(facility.districtId);
    const region = district === undefined ? undefined : regionById.get(district.regionId);
    districtsWithHistory.set(
      facility.districtId,
      `${district?.name ?? facility.districtId} · ${region?.name ?? ''}`.trim(),
    );
  }

  // One state officer per region the demonstration can show something in: a
  // region with no district holding history would be a scope whose every read is
  // empty, which teaches a reader nothing about the role.
  const regionsWithHistory = new Set(
    historyFacilities
      .map((facilityId) => facilityById.get(facilityId))
      .map((facility) =>
        facility === undefined ? undefined : districtById.get(facility.districtId),
      )
      .map((district) => district?.regionId)
      .filter((regionId): regionId is NonNullable<typeof regionId> => regionId !== undefined),
  );

  for (const [regionId, region] of [...regionById]
    .filter(([id]) => regionsWithHistory.has(id))
    .sort(([left], [right]) => ascending(left, right))) {
    principals.push({
      id: `state_officer:${regionId}`,
      role: 'state_officer',
      scopeId: regionId,
      label: `State officer — ${region.name}`,
      place: region.name,
    });
  }

  for (const [districtId, place] of [...districtsWithHistory].sort(([left], [right]) =>
    ascending(left, right),
  )) {
    principals.push({
      id: `district_officer:${districtId}`,
      role: 'district_officer',
      scopeId: districtId,
      label: `District officer — ${place}`,
      place,
    });
  }

  for (const [facilityId, facility] of [...facilityById]
    .filter(([id]) => historyFacilities.includes(id))
    .sort(([left], [right]) => ascending(left, right))) {
    principals.push({
      id: `phc_staff:${facilityId}`,
      role: 'phc_staff',
      scopeId: facilityId,
      label: `Facility staff — ${facility.name}`,
      place: facility.name,
    });
  }

  // The auditor is not scoped to a place: it reads every district and writes to
  // none, which is why its offered surfaces are the reads and its refusals are
  // the writes rather than a scope.
  principals.push({
    id: 'auditor',
    role: 'auditor',
    scopeId: null,
    label: 'Auditor — read-only',
    place: 'Every district, no writes',
  });

  return principals;
}

async function build(): Promise<LiveStore> {
  const dataset = buildDemoDataset();
  const provider = new InMemoryDataProvider();
  const seeded = await seedDataProvider(provider, {
    network: dataset.network,
    simulation: dataset.simulation,
    items: ITEMS,
  });

  // Replayed rather than queried, so the projection is built by the same methods
  // the ingest boundary calls. `projectSimulation` is that replay, shared with
  // the batch jobs: one reading of the generated world, so a figure a surface
  // shows and a figure a worker plans from cannot come from two of them.
  const ledger = projectSimulation(dataset.simulation, ITEMS);

  const districtOfFacility = new Map(
    dataset.network.facilities.map((facility) => [
      facility.id as string,
      facility.districtId as string,
    ]),
  );
  const regionOfDistrict = new Map(
    dataset.network.districts.map((district) => [
      district.id as string,
      district.regionId as string,
    ]),
  );

  const historyFacilities = [...dataset.facilityIds].sort(ascending);
  const firstFacility = historyFacilities[0];
  const defaultDistrictId: DistrictId | undefined =
    firstFacility === undefined
      ? dataset.network.districts[0]?.id
      : dataset.network.facilities.find((facility) => facility.id === firstFacility)?.districtId;

  if (defaultDistrictId === undefined) {
    throw new Error('the demonstration network is expected to contain at least one district');
  }

  return {
    dataset,
    provider,
    ledger,
    catalogue: ITEMS,
    info: {
      seed: DEMO_SEED,
      scenarioId: dataset.simulation.scenario.id,
      scenarioLabel: dataset.simulation.scenario.label,
      expectation: dataset.simulation.scenario.expectation,
      negativeControl: dataset.simulation.scenario.negativeControl,
      window: {
        from: dataset.simulation.from,
        to: dataset.simulation.to,
        days: dataset.summary.window.days,
      },
      fingerprint: seeded.fingerprint,
      documents: seeded.documents,
      generatedInMs: dataset.generatedInMs,
      seededInMs: seeded.elapsedMs,
      collections: seeded.collections,
      facilities: dataset.network.facilities.length,
      facilitiesWithHistory: dataset.simulation.counts.facilities,
      districts: dataset.network.districts.length,
      items: ITEMS.length,
    },
    historyFacilities,
    defaultDistrictId,
    principals: buildPrincipals(dataset, historyFacilities),
    scope: {
      districtOfFacility: (facilityId) => districtOfFacility.get(facilityId) ?? null,
      regionOfDistrict: (districtId) => regionOfDistrict.get(districtId) ?? null,
      districtsInRegion: (regionId) =>
        dataset.network.districts
          .filter((district) => district.regionId === regionId)
          .map((district) => district.id as string),
    },
  };
}

let pending: Promise<LiveStore> | undefined;

/** The demonstration environment, built on first use and then shared. */
export const getLiveStore = (): Promise<LiveStore> => (pending ??= build());
