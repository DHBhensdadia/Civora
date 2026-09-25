import { InMemoryDataProvider } from '@civora/domain';
import type { DataProvider, DistrictId, FacilityId, Item } from '@civora/domain';
import { DEMO_SEED, ITEMS, buildDemoDataset, seedDataProvider } from '@civora/simulator';
import type { DemoDataset } from '@civora/simulator';

import { LedgerService } from './ledger-service';
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

  const ledger = new LedgerService({
    from: dataset.simulation.from,
    through: dataset.simulation.to,
    items: ITEMS,
    synthetic: true,
    // A reporting gap is not observed and not generated: it is computed from
    // what the platform received, so it says so rather than inheriting the
    // simulator's label from the records it was derived over.
    provenance: { kind: 'derived', reference: 'reporting-gap-detection' },
  });

  // Replayed rather than queried, so the projection is built by the same
  // methods the ingest boundary calls. A collection-wide scan would be the
  // alternative, and it would need a query the persistence port does not have.
  for (const entry of dataset.simulation.ledgerEntries) {
    ledger.applyEntry(entry);
  }
  for (const status of dataset.simulation.bedStatuses) {
    ledger.applyBedStatus(status);
  }
  for (const attendance of dataset.simulation.staffAttendance) {
    ledger.applyAttendance(attendance);
  }
  for (const observation of dataset.simulation.footfall) {
    ledger.applyFootfall(observation);
  }
  for (const signal of dataset.simulation.syndromicSignals) {
    ledger.applySyndromic(signal);
  }

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
