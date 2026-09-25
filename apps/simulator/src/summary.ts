import {
  FACILITY_TIER_NORMS,
  REPORTING_DOMAINS,
  SIMULATED_PROVENANCE,
  detectReportingGaps,
} from '@civora/domain';
import type { DateOnly, FacilityTier, ProvenanceKind } from '@civora/domain';

import { ITEMS, itemsForTier } from './anchors/catalogue';
import type { Network } from './network';
import type { Simulation } from './simulation';

/**
 * What a generated dataset contains, counted.
 *
 * The generator answers "produce a nation"; this answers "describe the one you
 * produced". The distinction matters because the description is what a reviewer
 * reads before deciding whether to believe the demonstration, and it has to be
 * derived from the data rather than restated from the configuration: a summary
 * that repeated the options it was called with could agree with them while the
 * generator did something else.
 *
 * Two counts are deliberately kept apart throughout:
 *
 *  - **The network covers more than the history does.** Coverage of the country
 *    is cheap to state and the depth of history is expensive to generate, so a
 *    run has far more facilities than facilities with a past. Every figure that
 *    could be read either way says which one it is.
 *  - **The platform observes less than happened.** Unmet demand is
 *    unobservable by construction — a facility that ran out dispensed nothing,
 *    and nothing is what its ledger recorded. The summary therefore reports
 *    ground truth beside the observations rather than merging the two.
 */

/** A count with the name a reader would use for it. */
export interface LabelledCount {
  readonly label: string;
  readonly count: number;
}

export interface StateSummary {
  readonly id: string;
  readonly name: string;
  readonly population: number;
  /** True when the state population was read from a published table. */
  readonly populationAnchored: boolean;
  readonly districts: number;
  readonly blocks: number;
  /** Facilities in this state, whether or not a history was generated for them. */
  readonly facilities: number;
  /** Facilities in this state the run actually generated a history for. */
  readonly simulatedFacilities: number;
}

export interface DistrictSummary {
  readonly id: string;
  readonly name: string;
  readonly stateName: string;
  readonly population: number;
  /** True when the district population was read from a published table. */
  readonly anchored: boolean;
  readonly facilities: number;
  readonly simulatedFacilities: number;
}

export interface TierSummary {
  readonly tier: FacilityTier;
  readonly label: string;
  readonly facilities: number;
  readonly simulatedFacilities: number;
  /** Population band the tier is sited against, from the published norms. */
  readonly normPopulation: readonly [number, number];
  /** Bed band the tier is staffed for. */
  readonly normBeds: readonly [number, number];
  readonly coldChainCapable: number;
  /** Catalogue items the tier is expected to hold. */
  readonly itemsHeld: number;
}

/**
 * Where a class of records came from, and how many of them there are.
 *
 * The counts are read off the records themselves rather than declared, so the
 * panel that renders this cannot state an origin the data does not carry.
 */
export interface ProvenanceSummary {
  readonly kind: ProvenanceKind;
  readonly records: number;
  /** The distinct sources, assumptions or generators this kind names. */
  readonly references: readonly string[];
  /** The record kinds carrying it, so the total can be read back into its parts. */
  readonly layers: readonly LabelledCount[];
}

export interface DatasetSummary {
  readonly window: {
    readonly from: DateOnly;
    readonly to: DateOnly;
    readonly days: number;
  };
  readonly totals: {
    readonly states: number;
    readonly districts: number;
    readonly blocks: number;
    readonly facilities: number;
    readonly simulatedFacilities: number;
    readonly items: number;
    readonly itemHistories: number;
  };
  readonly byState: readonly StateSummary[];
  readonly byDistrict: readonly DistrictSummary[];
  readonly byTier: readonly TierSummary[];
  readonly byConnectivity: readonly LabelledCount[];
  readonly catalogue: {
    readonly total: number;
    readonly coldChainItems: number;
    readonly surgeSensitiveItems: number;
    readonly byCategory: readonly LabelledCount[];
    readonly byStorage: readonly LabelledCount[];
    readonly byEssentiality: readonly LabelledCount[];
    readonly byCareLevel: readonly LabelledCount[];
  };
  /** What the network heard. Every record here carries its own provenance. */
  readonly observations: readonly LabelledCount[];
  /** What actually happened, including what no facility could report. */
  readonly groundTruth: readonly LabelledCount[];
  /**
   * What the facilities ordered.
   *
   * Kept apart from the observations because these are the generator's own
   * bookkeeping rather than records the platform stores: nothing reads an order
   * as evidence yet. Phase 6 turns orders into a first-class record when the
   * redistribution engine needs to reason about replenishment already in
   * flight.
   */
  readonly ordering: {
    readonly ordersPlaced: number;
    readonly ordersPlacedDuringDisruption: number;
    readonly ordersStillInFlight: number;
  };
  readonly reporting: {
    readonly facilitiesReporting: number;
    readonly facilitiesWithGaps: number;
    readonly gaps: number;
    readonly longestGapDays: number;
    readonly offlineSpans: number;
  };
  readonly provenance: readonly ProvenanceSummary[];
}

/**
 * The order provenance kinds are reported in.
 *
 * Fixed rather than sorted by size, so the panel reads the same way for every
 * dataset and a change in the numbers is visible as a change in the numbers.
 * Simulated comes first because it dominates every dataset this repository
 * generates, and a reader should meet that fact before any other.
 */
const PROVENANCE_ORDER: readonly ProvenanceKind[] = [
  'simulated',
  'source',
  'assumption',
  'derived',
];

const ascending = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** A record carrying the two fields every generated record carries. */
interface Provenanced {
  readonly provenance: { readonly kind: ProvenanceKind; readonly reference: string };
}

interface KindTally {
  records: number;
  readonly references: Set<string>;
  readonly layers: Map<string, number>;
}

type Tallies = Map<ProvenanceKind, KindTally>;

/** The counts accumulated per state while the network is walked once. */
interface StateTally {
  districts: number;
  blocks: number;
  facilities: number;
  simulatedFacilities: number;
}

const tally = (tallies: Tallies, layer: string, records: readonly Provenanced[]): void => {
  for (const record of records) {
    const { kind, reference } = record.provenance;
    let entry = tallies.get(kind);
    if (entry === undefined) {
      entry = { records: 0, references: new Set<string>(), layers: new Map<string, number>() };
      tallies.set(kind, entry);
    }
    entry.records += 1;
    entry.references.add(reference);
    entry.layers.set(layer, (entry.layers.get(layer) ?? 0) + 1);
  }
};

const countBy = <T>(
  values: readonly T[],
  key: (value: T) => string | readonly string[],
): readonly LabelledCount[] => {
  const counts = new Map<string, number>();
  for (const value of values) {
    const keys = key(value);
    for (const each of typeof keys === 'string' ? [keys] : keys) {
      counts.set(each, (counts.get(each) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || ascending(left.label, right.label));
};

export function summariseDataset(network: Network, simulation: Simulation): DatasetSummary {
  const districtById = new Map(network.districts.map((district) => [district.id, district]));
  const regionById = new Map(network.regions.map((region) => [region.id, region]));
  const simulatedFacilityIds = new Set(simulation.reporting.keys());

  const stateTallies = new Map<string, StateTally>(
    network.regions.map((region) => [
      region.id,
      { districts: 0, blocks: 0, facilities: 0, simulatedFacilities: 0 },
    ]),
  );
  const byBlock = new Map(
    network.blocks.map((block) => [block.id, { facilities: 0, simulated: 0 }]),
  );
  const byDistrictTally = new Map(
    network.districts.map((district) => [district.id, { facilities: 0, simulated: 0 }]),
  );

  for (const block of network.blocks) {
    const regionId = districtById.get(block.districtId)?.regionId;
    const tally = regionId === undefined ? undefined : stateTallies.get(regionId);
    if (tally !== undefined) {
      tally.blocks += 1;
    }
  }

  for (const district of network.districts) {
    const tally = stateTallies.get(district.regionId);
    if (tally !== undefined) {
      tally.districts += 1;
    }
  }

  for (const facility of network.facilities) {
    const simulated = simulatedFacilityIds.has(facility.id);
    const tally = stateTallies.get(facility.regionId);
    if (tally !== undefined) {
      tally.facilities += 1;
      if (simulated) {
        tally.simulatedFacilities += 1;
      }
    }
    const block = byBlock.get(facility.blockId);
    if (block !== undefined) {
      block.facilities += 1;
      if (simulated) {
        block.simulated += 1;
      }
    }
    const district = byDistrictTally.get(facility.districtId);
    if (district !== undefined) {
      district.facilities += 1;
      if (simulated) {
        district.simulated += 1;
      }
    }
  }

  const byState: StateSummary[] = network.regions.map((region) => {
    const tally = stateTallies.get(region.id);
    return {
      id: region.id,
      name: region.name,
      population: region.population,
      populationAnchored: region.provenance.kind === 'source',
      districts: tally?.districts ?? 0,
      blocks: tally?.blocks ?? 0,
      facilities: tally?.facilities ?? 0,
      simulatedFacilities: tally?.simulatedFacilities ?? 0,
    };
  });

  const byDistrict: DistrictSummary[] = network.districts.map((district) => {
    const tallyForDistrict = byDistrictTally.get(district.id);
    return {
      id: district.id,
      name: district.name,
      stateName: regionById.get(district.regionId)?.name ?? district.regionId,
      population: district.population,
      anchored: district.provenance.kind === 'source',
      facilities: tallyForDistrict?.facilities ?? 0,
      simulatedFacilities: tallyForDistrict?.simulated ?? 0,
    };
  });

  const byTier: TierSummary[] = (Object.keys(FACILITY_TIER_NORMS) as readonly FacilityTier[]).map(
    (tier) => {
      const facilities = network.facilities.filter((facility) => facility.tier === tier);
      return {
        tier,
        label: FACILITY_TIER_NORMS[tier].label,
        facilities: facilities.length,
        simulatedFacilities: facilities.filter((facility) => simulatedFacilityIds.has(facility.id))
          .length,
        normPopulation: FACILITY_TIER_NORMS[tier].population,
        normBeds: FACILITY_TIER_NORMS[tier].beds,
        coldChainCapable: facilities.filter((facility) => facility.coldChain.available).length,
        itemsHeld: itemsForTier(tier).length,
      };
    },
  );

  const tallies: Tallies = new Map();
  tally(tallies, 'country', [network.country]);
  tally(tallies, 'regions', network.regions);
  tally(tallies, 'districts', network.districts);
  tally(tallies, 'blocks', network.blocks);
  tally(tallies, 'facilities', network.facilities);
  tally(tallies, 'catalogue items', ITEMS);
  tally(tallies, 'stock ledger entries', simulation.ledgerEntries);
  tally(tallies, 'syndromic signals', simulation.syndromicSignals);
  tally(tallies, 'bed status reports', simulation.bedStatuses);
  tally(tallies, 'staff attendance', simulation.staffAttendance);
  tally(tallies, 'footfall observations', simulation.footfall);

  const provenance: ProvenanceSummary[] = PROVENANCE_ORDER.flatMap((kind) => {
    const entry = tallies.get(kind);
    if (entry === undefined) {
      return [];
    }
    return [
      {
        kind,
        records: entry.records,
        references: [...entry.references].sort(ascending),
        layers: [...entry.layers.entries()]
          .map(([label, count]) => ({ label, count }))
          .sort((left, right) => right.count - left.count || ascending(left.label, right.label)),
      },
    ];
  });

  // A gap is counted with the same tolerance the platform uses, so the summary
  // reports what the detector would report rather than a second opinion.
  let facilitiesReporting = 0;
  let facilitiesWithGaps = 0;
  let gaps = 0;
  let longestGapDays = 0;
  let offlineSpans = 0;

  for (const [facilityId, reporting] of simulation.reporting) {
    if (reporting.reportedDays.length > 0) {
      facilitiesReporting += 1;
    }
    offlineSpans += reporting.offlineSpans.length;

    const detected = detectReportingGaps(facilityId, {
      reportedDays: reporting.reportedDays,
      missing: [...REPORTING_DOMAINS],
      from: simulation.from,
      to: simulation.to,
      synthetic: true,
      provenance: SIMULATED_PROVENANCE,
    });
    if (detected.length > 0) {
      facilitiesWithGaps += 1;
    }
    gaps += detected.length;
    for (const gap of detected) {
      longestGapDays = Math.max(longestGapDays, gap.days);
    }
  }

  return {
    window: { from: simulation.from, to: simulation.to, days: simulation.counts.days },
    totals: {
      states: network.regions.length,
      districts: network.districts.length,
      blocks: network.blocks.length,
      facilities: network.facilities.length,
      simulatedFacilities: simulation.counts.facilities,
      items: ITEMS.length,
      itemHistories: simulation.counts.itemHistories,
    },
    byState: [...byState].sort((left, right) => ascending(left.name, right.name)),
    byDistrict,
    byTier,
    byConnectivity: countBy(network.facilities, (facility) => facility.connectivity),
    catalogue: {
      total: ITEMS.length,
      coldChainItems: ITEMS.filter((item) => item.coldChain).length,
      surgeSensitiveItems: ITEMS.filter((item) => item.unitsPerCase > 0).length,
      byCategory: countBy(ITEMS, (item) => item.category),
      byStorage: countBy(ITEMS, (item) => item.storage),
      byEssentiality: countBy(ITEMS, (item) => item.essentiality),
      byCareLevel: countBy(ITEMS, (item) => item.careLevels),
    },
    observations: [
      { label: 'Stock ledger entries', count: simulation.ledgerEntries.length },
      { label: 'Syndromic signals', count: simulation.syndromicSignals.length },
      { label: 'Bed status reports', count: simulation.bedStatuses.length },
      { label: 'Staff attendance records', count: simulation.staffAttendance.length },
      { label: 'Footfall observations', count: simulation.footfall.length },
    ],
    groundTruth: [
      { label: 'Unmet-demand spells', count: simulation.shortfalls.length },
      {
        label: 'Facility-item-days short',
        count: simulation.shortfalls.reduce((total, shortfall) => total + shortfall.days, 0),
      },
      {
        label: 'Units wanted and not dispensed',
        count: simulation.shortfalls.reduce((total, shortfall) => total + shortfall.unmetUnits, 0),
      },
    ],
    ordering: {
      ordersPlaced: simulation.orders.length,
      ordersPlacedDuringDisruption: simulation.orders.filter((order) => order.disrupted).length,
      ordersStillInFlight: simulation.orders.filter((order) => order.receivedOn === null).length,
    },
    reporting: { facilitiesReporting, facilitiesWithGaps, gaps, longestGapDays, offlineSpans },
    provenance,
  };
}
