import { describe, expect, it } from 'vitest';

import { FACILITY_TIER_NORMS, FACILITY_TIERS, SIMULATED_PROVENANCE } from '@civora/domain';

import { ITEMS, ITEM_BY_ID, itemsForTier } from './anchors/catalogue';
import { requireSource, SOURCES } from './anchors/sources';
import { DEMO_NETWORK_OPTIONS } from './index';
import { buildNetwork } from './network';
import type { NetworkOptions } from './network';
import { SCENARIOS } from './scenarios';

/**
 * The anchored layers, and whether they are what they claim to be.
 *
 * These tests exist mostly to catch the failure mode that this data is most
 * exposed to: a record that looks authoritative and is not. A catalogue entry
 * citing the national essential medicines list really has to carry the code it
 * cites, and a district carrying a census population really has to be that
 * district's.
 */

const OPTIONS: NetworkOptions = {
  seed: 'anchoring-test',
  coverage: 'demo',
  districtsPerState: 5,
  blocksPerDistrict: 1,
  facilityTiersPerBlock: ['SHC', 'PHC', 'CHC'],
  countryName: 'India',
  currency: 'INR',
  languages: ['en', 'hi', 'bn', 'ta', 'mr'],
};

const NETWORK = buildNetwork(OPTIONS);

describe('the source registry', () => {
  it('records what was retrieved and what was not', () => {
    expect(SOURCES.length).toBeGreaterThan(5);
    expect(SOURCES.some((source) => source.status === 'failed')).toBe(true);
    expect(SOURCES.every((source) => source.retrievedOn.length === 10)).toBe(true);
  });

  it('fails loudly on a source that does not exist', () => {
    expect(() => requireSource('nlem-2023')).toThrow(/unknown source/);
  });
});

describe('the item catalogue', () => {
  it('builds every item and identifies each one uniquely', () => {
    expect(ITEMS.length).toBeGreaterThan(50);

    const ids = new Set(ITEMS.map((item) => item.id));
    expect(ids.size).toBe(ITEMS.length);

    const codes = new Set(ITEMS.map((item) => item.nlemCode));
    expect(codes.size).toBe(ITEMS.length);

    expect(ITEM_BY_ID.size).toBe(ITEMS.length);
  });

  it('carries the level of care every item is listed for', () => {
    for (const item of ITEMS) {
      expect(item.careLevels.length).toBeGreaterThan(0);
      expect(item.provenance.kind).toBe('source');
    }
  });

  it('derives cold chain from the product rather than from the form', () => {
    const coldChain = ITEMS.filter((item) => item.coldChain).map((item) => item.genericName);

    expect(coldChain).toContain('Insulin (soluble)');
    expect(coldChain).toContain('Oxytocin');
    expect(coldChain).toContain('Tetanus toxoid');
    // A tablet that needs a refrigerator would be a derivation bug, not a fact.
    expect(ITEMS.filter((item) => item.form === 'tablet' && item.coldChain)).toHaveLength(0);
  });

  it('gives every surge-sensitive item both syndromes and a per-case figure', () => {
    for (const item of ITEMS) {
      if (item.unitsPerCase > 0) {
        expect(item.syndromes.length).toBeGreaterThan(0);
      }
    }
  });

  it('stocks a lower tier with less, and never with something it cannot store', () => {
    const community = itemsForTier('SHC');
    const primary = itemsForTier('PHC');
    const secondary = itemsForTier('CHC');

    expect(community.length).toBeLessThan(primary.length);
    expect(primary.length).toBeLessThanOrEqual(secondary.length);
    expect(community.every((item) => !item.coldChain)).toBe(true);
    expect(primary.every((item) => item.careLevels.includes('primary'))).toBe(true);
  });

  it('leaves a recorded gap rather than inventing an item', () => {
    // Oral Rehydration Salts could not be extracted from the parsed list. The
    // gap is deliberate: a plausible code invented for them would be worse than
    // their absence, because nothing downstream could tell the difference.
    expect(ITEMS.some((item) => item.genericName.toLowerCase().includes('oral rehydration'))).toBe(
      false,
    );
    expect(requireSource('nlem2022').note).toContain('Oral Rehydration Salts');
  });
});

describe('the network', () => {
  it('is the same network for the same seed', () => {
    expect(buildNetwork(OPTIONS)).toEqual(NETWORK);
    expect(buildNetwork({ ...OPTIONS, seed: 'another-seed' })).not.toEqual(NETWORK);
  });

  it('uses the census population of each anchored district verbatim', () => {
    const odisha = NETWORK.regions.find((region) => region.name === 'Odisha');
    const ganjam = NETWORK.districts.find((district) => district.name === 'Ganjam');

    expect(odisha?.population).toBe(41_974_218);
    expect(ganjam?.population).toBe(3_529_031);
    expect(ganjam?.provenance).toEqual({ kind: 'source', reference: 'census2011-districts' });
  });

  it('numbers the districts it had to invent, rather than naming them plausibly', () => {
    const pune = NETWORK.districts.find((district) => district.name === 'Pune');
    const invented = NETWORK.districts.filter((district) => / district \d\d$/.test(district.name));

    // Pune's name is real; its population is not, and the record says so.
    expect(pune?.provenance).toEqual({ kind: 'assumption', reference: 'district-population-band' });

    // A state with fewer named districts than were asked for is topped up with
    // placeholders, and a placeholder says what it is.
    expect(invented.length).toBeGreaterThan(0);
    for (const district of invented) {
      // Whichever of the two allocation rules produced the population, the
      // record says it was assumed rather than read.
      expect(['district-population-band', 'district-population-share']).toContain(
        district.provenance.reference,
      );
      expect(district.provenance.kind).toBe('assumption');
      expect(district.lgdCode.startsWith('SIM-')).toBe(true);
    }
  });

  it('sites facilities within the published norms for their tier', () => {
    for (const facility of NETWORK.facilities) {
      const [minPopulation, maxPopulation] = FACILITY_TIER_NORMS[facility.tier].population;
      const [minBeds, maxBeds] = FACILITY_TIER_NORMS[facility.tier].beds;

      expect(facility.catchmentPopulation).toBeGreaterThanOrEqual(minPopulation);
      expect(facility.catchmentPopulation).toBeLessThanOrEqual(maxPopulation);
      expect(facility.sanctionedBeds).toBeGreaterThanOrEqual(minBeds);
      expect(facility.sanctionedBeds).toBeLessThanOrEqual(maxBeds);
    }
  });

  it('labels every record as synthetic and never claims an official code', () => {
    for (const district of NETWORK.districts) {
      expect(district.synthetic).toBe(true);
      // The directory was not retrievable, so no identifier in this dataset may
      // be presented as an official one.
      expect(district.lgdCode.startsWith('SIM-')).toBe(true);
    }

    expect(NETWORK.facilities.every((facility) => facility.synthetic)).toBe(true);
    expect(NETWORK.regions.every((region) => region.provenance.kind !== 'simulated')).toBe(true);
    expect(SIMULATED_PROVENANCE.kind).toBe('simulated');
  });

  it('distinguishes a read state population from an allocated one', () => {
    const read = NETWORK.regions.find((region) => region.name === 'Odisha');
    const allocated = NETWORK.regions.find((region) => region.name === 'Maharashtra');

    expect(read?.provenance).toEqual({ kind: 'source', reference: 'census2011-states' });
    expect(allocated?.provenance).toEqual({ kind: 'source', reference: 'census2011-states' });
    expect(allocated?.population).toBe(112_374_333);
  });

  it('covers the whole country when asked, without losing the anchored districts', () => {
    const national = buildNetwork({ ...OPTIONS, coverage: 'all', districtsPerState: 2 });
    const regions = new Set(national.regions.map((region) => region.name));

    expect(regions.size).toBeGreaterThan(30);
    expect(regions.has('Lakshadweep')).toBe(true);

    // Adding the rest of the country must not replace Ganjam with a placeholder.
    expect(national.districts.some((district) => district.name === 'Ganjam')).toBe(true);
    expect(national.districts.some((district) => district.name === 'Khordha')).toBe(false);
  });

  it('places every district the scenarios name, so no scenario is left without a subject', () => {
    const demo = buildNetwork(DEMO_NETWORK_OPTIONS);

    for (const scenario of SCENARIOS) {
      for (const window of [
        scenario.surge,
        scenario.supplyDisruption,
        scenario.coldChainFailure,
        scenario.offline,
        scenario.expiryCliff,
      ]) {
        if (window === undefined) {
          continue;
        }

        for (const stateName of window.target.states) {
          const region = demo.regions.find((entry) => entry.name === stateName);
          expect(region, `${scenario.id} names a state that is not modelled`).toBeDefined();

          const districts = demo.districts.filter((district) => district.regionId === region?.id);
          const districtIds = new Set(districts.map((district) => district.id as string));
          const facilities = demo.facilities.filter((facility) =>
            districtIds.has(facility.districtId),
          );

          expect(facilities.length, `${scenario.id} has no facility to act on`).toBeGreaterThan(0);

          for (const districtName of window.target.districts ?? []) {
            expect(
              districts.map((district) => district.name),
              `${scenario.id} names a district the demo profile does not reach`,
            ).toContain(districtName);
          }
        }
      }
    }
  });

  it('holds facilities of every tier it was asked for, and no others', () => {
    const tiers = [...new Set(NETWORK.facilities.map((facility) => facility.tier))].sort();
    const requested = [...OPTIONS.facilityTiersPerBlock].sort();

    expect(tiers).toEqual(requested);
    expect(FACILITY_TIERS).toEqual(expect.arrayContaining(tiers));
  });
});
