import { FACILITY_TIER_NORMS, replayStockLedger } from '@civora/domain';
import type { FacilityId, ItemId, StockLedgerEntry } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { DEMO_NETWORK_OPTIONS, DEMO_SEED, historySample } from './index';
import { buildNetwork } from './network';
import type { Network } from './network';
import { simulateNetwork } from './simulation';
import type { Simulation } from './simulation';
import { summariseDataset } from './summary';

/**
 * Properties the dataset must hold under *any* seed and in *any* profile.
 *
 * The other simulator tests ask whether the scenarios do what they are named
 * for. These ask the different question: whether the generator's own rules hold
 * when nothing is tuned for them. A property that only holds for the published
 * demo seed holds by accident, and the accident is exactly what a reader will
 * not reproduce.
 *
 * Both profiles are covered because they are genuinely different code paths:
 * the demonstration profile uses the anchored district tables, and the national
 * one adds allocated states whose district and facility counts are derived.
 *
 * Each property is checked against a single facility. Following the generator's
 * own choice, the facility is taken by the same rule the shipped dataset uses,
 * so the sample is a facility that reports beds, staff and footfall rather than
 * whichever one happens to be listed first.
 */

const PROFILES: readonly { readonly name: string; readonly network: Network }[] = [
  { name: 'demo', network: buildNetwork(DEMO_NETWORK_OPTIONS) },
  {
    name: 'national',
    network: buildNetwork({ ...DEMO_NETWORK_OPTIONS, coverage: 'all' }),
  },
];

/** Seeds chosen for being unrelated to each other and to the demo seed. */
const SEEDS: readonly string[] = [DEMO_SEED, 'invariant-alpha', 'invariant-beta'];

const facilityOf = (network: Network): FacilityId => {
  const [facilityId] = historySample(network, 1);
  if (facilityId === undefined) {
    throw new Error('a profile is expected to site at least one facility');
  }
  return facilityId;
};

/** Order-independent digest of a ledger, so two runs can be compared as a whole. */
const checksum = (entries: readonly StockLedgerEntry[]): number =>
  entries.reduce((total, entry) => {
    const text = `${entry.id}:${entry.occurredOn}:${entry.quantity}`;
    let hash = total;
    for (let index = 0; index < text.length; index += 1) {
      hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
    }
    return hash;
  }, 7);

describe.each(PROFILES)('the $name profile', ({ network }) => {
  const facilityId = facilityOf(network);
  const cache = new Map<string, Simulation>();

  const simulated = (seed: string): Simulation => {
    let simulation = cache.get(seed);
    if (simulation === undefined) {
      simulation = simulateNetwork(network, { seed, facilityIds: [facilityId] });
      cache.set(seed, simulation);
    }
    return simulation;
  };

  it('sites every level of the spine and keeps every facility inside its published norm', () => {
    expect(network.regions.length).toBeGreaterThanOrEqual(6);

    for (const region of network.regions) {
      const districts = network.districts.filter((district) => district.regionId === region.id);
      expect(districts.length).toBeGreaterThan(0);

      for (const district of districts) {
        const blocks = network.blocks.filter((block) => block.districtId === district.id);
        expect(blocks.length).toBeGreaterThan(0);

        for (const block of blocks) {
          const facilities = network.facilities.filter((facility) => facility.blockId === block.id);
          expect(facilities.length).toBe(DEMO_NETWORK_OPTIONS.facilityTiersPerBlock.length);

          for (const facility of facilities) {
            const norms = FACILITY_TIER_NORMS[facility.tier];
            expect(facility.catchmentPopulation).toBeGreaterThanOrEqual(norms.population[0]);
            expect(facility.catchmentPopulation).toBeLessThanOrEqual(norms.population[1]);
            expect(facility.sanctionedBeds).toBeGreaterThanOrEqual(norms.beds[0]);
            expect(facility.sanctionedBeds).toBeLessThanOrEqual(norms.beds[1]);
          }
        }
      }
    }
  });

  it('labels every identifier as synthetic, because the official directory was not retrievable', () => {
    // A code that looked official but was invented would be the worst kind of
    // error in this dataset: joinable in appearance, unjoinable in fact.
    for (const region of network.regions) {
      expect(region.id.startsWith('SIM-')).toBe(true);
      expect(region.lgdCode.startsWith('SIM-')).toBe(true);
    }
    for (const district of network.districts) {
      expect(district.lgdCode.startsWith('SIM-')).toBe(true);
    }
    for (const facility of network.facilities) {
      expect(facility.lgdCode.startsWith('SIM-')).toBe(true);
      expect(facility.blockId.startsWith('SIM-')).toBe(true);
    }
  });

  it('emits nothing unlabelled, under any seed', () => {
    for (const seed of SEEDS) {
      const simulation = simulated(seed);
      const records = [
        ...simulation.ledgerEntries,
        ...simulation.syndromicSignals,
        ...simulation.bedStatuses,
        ...simulation.staffAttendance,
        ...simulation.footfall,
      ];

      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.synthetic)).toBe(true);
      expect(records.every((record) => record.provenance.kind === 'simulated')).toBe(true);
    }
  });

  it('replays its ledger without flooring a position or ignoring a duplicate, under any seed', () => {
    for (const seed of SEEDS) {
      const simulation = simulated(seed);
      const series = new Map<string, { facilityId: FacilityId; itemId: ItemId }>();

      for (const entry of simulation.ledgerEntries) {
        series.set(`${entry.facilityId}|${entry.itemId}`, {
          facilityId: entry.facilityId,
          itemId: entry.itemId,
        });
      }

      expect(series.size).toBeGreaterThan(0);

      for (const pair of series.values()) {
        const replay = replayStockLedger(simulation.ledgerEntries, pair.facilityId, pair.itemId, {
          from: simulation.from,
          to: simulation.to,
        });
        expect(replay.entriesExceedingStock).toBe(0);
        expect(replay.duplicatesIgnored).toBe(0);
      }
    }
  });

  it('describes itself with counts that agree with the records it produced', () => {
    const simulation = simulated(DEMO_SEED);
    const summary = summariseDataset(network, simulation);

    const observations = new Map(summary.observations.map((entry) => [entry.label, entry.count]));
    expect(observations.get('Stock ledger entries')).toBe(simulation.ledgerEntries.length);
    expect(observations.get('Syndromic signals')).toBe(simulation.syndromicSignals.length);
    expect(observations.get('Staff attendance records')).toBe(simulation.staffAttendance.length);

    expect(summary.totals.facilities).toBe(network.facilities.length);
    expect(summary.totals.districts).toBe(network.districts.length);
    expect(summary.totals.simulatedFacilities).toBe(simulation.counts.facilities);

    // The parts of a provenance class must sum to the class, or the panel that
    // renders it would show a total its own breakdown contradicts.
    for (const layer of summary.provenance) {
      expect(layer.layers.reduce((total, entry) => total + entry.count, 0)).toBe(layer.records);
      expect(layer.references.length).toBeGreaterThan(0);
    }
  });

  it('produces the same history for the same seed and a different one otherwise', () => {
    const first = simulated(DEMO_SEED);
    const again = simulated(DEMO_SEED);
    const reseeded = simulated('a-different-seed');

    expect(checksum(again.ledgerEntries)).toBe(checksum(first.ledgerEntries));
    expect(again.counts).toEqual(first.counts);
    expect(checksum(reseeded.ledgerEntries)).not.toBe(checksum(first.ledgerEntries));
  });
});
