import {
  blockIdSchema,
  blockSchema,
  countryIdSchema,
  countrySchema,
  districtIdSchema,
  districtSchema,
  facilityIdSchema,
  facilitySchema,
  regionIdSchema,
  regionSchema,
  FACILITY_TIER_NORMS,
} from '@civora/domain';
import type { Block, Country, District, Facility, FacilityTier, Region } from '@civora/domain';

import { createRng, deriveSeed } from './rng';
import {
  ALLOCATED_STATE_WEIGHTS,
  ALLOCATED_STATES,
  DEMO_STATES,
  EXTRA_ANCHORED_STATES,
  NATIONAL_POPULATION,
  NATIONAL_POPULATION_SOURCE_ID,
  slugify,
} from './anchors/geography';
import type { Anchoring, CensusDistrict, NamedDistrict, StateAnchor } from './anchors/geography';

/**
 * The network: a country, its states, districts, blocks and facilities.
 *
 * Everything here is generated from anchored inputs, and every record says
 * which parts of itself were read and which were assumed. Facility counts are
 * derived from population and the published care norms rather than read from a
 * facility register, so a district with a million people gets the number of
 * primary health centres a million people implies.
 *
 * The demo profile covers a *sample* of each block's real network rather than
 * all of it: a block of 90,000 people has far more facilities than the four
 * modelled here, and pretending otherwise would misstate what the platform
 * covers. The sample size is a profile parameter and is recorded with the
 * dataset.
 */

/**
 * Approximate state centroids, in degrees.
 *
 * Written from general geographic knowledge rather than read from a gazetteer,
 * and therefore recorded as an assumption: they are good enough to place a
 * facility marker in the right state, and not good enough to navigate by. Every
 * facility coordinate is jittered around its state's centroid by a documented
 * radius, so no coordinate in this dataset is a real facility's location.
 */
const STATE_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
  Odisha: [20.29, 85.82],
  Bihar: [25.61, 85.14],
  Maharashtra: [19.75, 75.71],
  'Tamil Nadu': [11.13, 78.66],
  Kerala: [10.51, 76.34],
  'Uttar Pradesh': [26.85, 80.91],
  'West Bengal': [22.99, 87.85],
  'Andhra Pradesh': [15.91, 79.74],
  'Madhya Pradesh': [23.47, 78.66],
  Rajasthan: [27.02, 74.22],
  Karnataka: [15.32, 75.71],
  Gujarat: [22.26, 71.19],
  Jharkhand: [23.61, 85.28],
  Assam: [26.2, 92.94],
  Punjab: [31.15, 75.34],
  Chhattisgarh: [21.28, 81.87],
  Haryana: [29.06, 76.09],
  Delhi: [28.61, 77.21],
  'Jammu and Kashmir': [33.78, 74.71],
  Uttarakhand: [30.07, 79.13],
  'Himachal Pradesh': [31.92, 77.17],
  Tripura: [23.94, 91.99],
  Meghalaya: [25.47, 91.37],
  Sikkim: [27.53, 88.51],
  Telangana: [17.91, 79.16],
  Goa: [15.3, 74.09],
  'Arunachal Pradesh': [28.22, 94.73],
  Manipur: [24.66, 93.91],
  Mizoram: [23.16, 92.94],
  Nagaland: [26.16, 94.56],
  Puducherry: [11.94, 79.81],
  Chandigarh: [30.73, 76.78],
  Ladakh: [34.15, 77.58],
  'Andaman and Nicobar Islands': [11.74, 92.66],
  'Dadra and Nagar Haveli and Daman and Diu': [20.27, 73.02],
  Lakshadweep: [10.57, 72.64],
};

/** Half-width of the coordinate jitter around a state centroid, in degrees. */
const COORDINATE_JITTER_DEGREES = 0.6;

export interface Network {
  readonly country: Country;
  readonly regions: readonly Region[];
  readonly districts: readonly District[];
  readonly blocks: readonly Block[];
  readonly facilities: readonly Facility[];
}

export interface NetworkOptions {
  readonly seed: string;
  /** `demo` covers the six anchored states; `all` adds the rest of the country. */
  readonly coverage: 'demo' | 'all';
  /** Districts to model per state. Anchored districts are always included first. */
  readonly districtsPerState: number;
  readonly blocksPerDistrict: number;
  /** Facilities to model per block, by tier, taken in this order. */
  readonly facilityTiersPerBlock: readonly FacilityTier[];
  readonly countryName: string;
  readonly currency: string;
  readonly languages: readonly string[];
}

const COUNTRY_ID = countryIdSchema.parse('SIM-IN');

/** A district's population when it was not read from the census. */
const ALLOCATED_DISTRICT_BAND: readonly [number, number] = [0.02, 0.06];

/**
 * Districts modelled for a state that has no census district table.
 *
 * Named after the state and numbered, which is deliberately obvious: a
 * plausible-looking district name attached to an invented population would be
 * the worst of both worlds in a dataset a reviewer is checking.
 */
const generatedDistrictNames = (stateName: string, count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `${stateName} district ${String(index + 1).padStart(2, '0')}`,
  );

/** A state with whatever district information this build actually has. */
interface ResolvedState extends StateAnchor {
  readonly id: string;
  readonly districts?: readonly (CensusDistrict | NamedDistrict)[];
  readonly districtAnchoring?: Anchoring;
}

const resolveStatePopulations = (coverage: 'demo' | 'all'): readonly ResolvedState[] => {
  // The anchored states keep their census district tables at either coverage.
  // Dropping them once the rest of the country was added would replace the
  // districts the demonstration is built on with numbered placeholders.
  const anchored: ResolvedState[] = DEMO_STATES.map((state) => ({
    ...state,
    id: slugify(state.name),
  }));

  if (coverage !== 'all') {
    return anchored;
  }

  const base: ResolvedState[] = [
    ...anchored,
    ...EXTRA_ANCHORED_STATES.map((state): ResolvedState => ({
      ...state,
      id: slugify(state.name),
      districts: [],
      districtAnchoring: 'generated',
    })),
  ];

  const readTotal = base.reduce((total, state) => total + state.population, 0);
  const residual = NATIONAL_POPULATION - readTotal;
  const weightTotal = ALLOCATED_STATES.reduce(
    (total, state) => total + (ALLOCATED_STATE_WEIGHTS[state.name] ?? 1),
    0,
  );

  let allocatedSoFar = 0;
  const allocated = ALLOCATED_STATES.map((state, index): ResolvedState => {
    const weight = ALLOCATED_STATE_WEIGHTS[state.name] ?? 1;
    const isLast = index === ALLOCATED_STATES.length - 1;
    const population = isLast
      ? residual - allocatedSoFar
      : Math.round((weight / weightTotal) * residual);
    allocatedSoFar += population;
    return {
      ...state,
      id: slugify(state.name),
      population,
      populationSourceId: NATIONAL_POPULATION_SOURCE_ID,
      populationAnchoring: 'allocated',
    };
  });

  return [...base, ...allocated];
};

const tierPopulationBand = (tier: FacilityTier): readonly [number, number] =>
  FACILITY_TIER_NORMS[tier].population;

const tierBedBand = (tier: FacilityTier): readonly [number, number] =>
  FACILITY_TIER_NORMS[tier].beds;

export function buildNetwork(options: NetworkOptions): Network {
  const rng = createRng(deriveSeed(options.seed, 'network'));
  const states = resolveStatePopulations(options.coverage);

  const country: Country = countrySchema.parse({
    id: COUNTRY_ID,
    name: options.countryName,
    currency: options.currency,
    languages: options.languages,
    synthetic: true,
    provenance: { kind: 'simulated', reference: 'simulator' },
  });

  const regions: Region[] = [];
  const districts: District[] = [];
  const blocks: Block[] = [];
  const facilities: Facility[] = [];

  for (const state of states) {
    const regionId = regionIdSchema.parse(`SIM-${state.id.toUpperCase().slice(0, 6)}`);
    const centroid = STATE_CENTROIDS[state.name] ?? [22.0, 79.0];

    regions.push(
      regionSchema.parse({
        id: regionId,
        countryId: COUNTRY_ID,
        name: state.name,
        // The directory was not retrievable, so this is not an official code and
        // is not dressed up as one. See sources.ts, entry `lgd-directory`.
        lgdCode: `SIM-REG-${state.id.toUpperCase().slice(0, 6)}`,
        population: state.population,
        language: state.language,
        synthetic: true,
        provenance:
          state.populationAnchoring === 'census'
            ? { kind: 'source', reference: state.populationSourceId }
            : { kind: 'assumption', reference: 'state-population-allocation' },
      }),
    );

    const districtAnchoring: Anchoring = state.districtAnchoring ?? 'generated';
    const districtNames: { readonly name: string; readonly population: number | null }[] = [
      ...(state.districts ?? []).map((district) => ({
        name: district.name,
        population: 'population' in district ? district.population : null,
      })),
    ];

    if (districtNames.length < options.districtsPerState) {
      const missing = options.districtsPerState - districtNames.length;
      for (const name of generatedDistrictNames(state.name, missing)) {
        districtNames.push({ name, population: null });
      }
    }

    for (const [index, district] of districtNames.slice(0, options.districtsPerState).entries()) {
      // An anchored district keeps its census population; an allocated one is
      // drawn from the documented band of the state total; a generated one takes
      // an equal share of what is left, which is the least invented option.
      const population =
        district.population ??
        (districtAnchoring === 'allocated'
          ? Math.round(state.population * rng.float(...ALLOCATED_DISTRICT_BAND))
          : Math.round(state.population / options.districtsPerState));

      const anchored = district.population !== null;
      const districtId = districtIdSchema.parse(
        `SIM-${state.id.toUpperCase().slice(0, 6)}-${slugify(district.name).toUpperCase()}`,
      );
      const centroidWithJitter = (): { latitude: number; longitude: number } => ({
        latitude: Number(
          (centroid[0] + rng.float(-COORDINATE_JITTER_DEGREES, COORDINATE_JITTER_DEGREES)).toFixed(
            4,
          ),
        ),
        longitude: Number(
          (centroid[1] + rng.float(-COORDINATE_JITTER_DEGREES, COORDINATE_JITTER_DEGREES)).toFixed(
            4,
          ),
        ),
      });

      districts.push(
        districtSchema.parse({
          id: districtId,
          regionId,
          name: district.name,
          lgdCode: `SIM-DIS-${state.id.toUpperCase().slice(0, 6)}-${String(index + 1).padStart(3, '0')}`,
          population,
          urbanShare: Math.max(
            0,
            Math.min(1, rng.float(state.urbanShare * 0.6, state.urbanShare * 1.4)),
          ),
          synthetic: true,
          provenance: anchored
            ? { kind: 'source', reference: 'census2011-districts' }
            : districtAnchoring === 'allocated'
              ? { kind: 'assumption', reference: 'district-population-band' }
              : { kind: 'assumption', reference: 'district-population-share' },
        }),
      );

      const blockPopulation = Math.round(population / options.blocksPerDistrict);

      for (let blockIndex = 0; blockIndex < options.blocksPerDistrict; blockIndex += 1) {
        const blockId = blockIdSchema.parse(`${districtId}-B${String(blockIndex + 1)}`);
        blocks.push(
          blockSchema.parse({
            id: blockId,
            districtId,
            name: `${district.name} block ${String(blockIndex + 1)}`,
            lgdCode: `SIM-BLK-${String(blocks.length + 1).padStart(4, '0')}`,
            population: blockPopulation,
            synthetic: true,
            provenance: { kind: 'assumption', reference: 'block-population-share' },
          }),
        );

        for (const [tierIndex, tier] of options.facilityTiersPerBlock.entries()) {
          const [minPopulation, maxPopulation] = tierPopulationBand(tier);
          const [minBeds, maxBeds] = tierBedBand(tier);
          const coordinates = centroidWithJitter();
          const coldChainAvailable = rng.chance(
            tier === 'CHC' ? 0.92 : tier === 'PHC' ? 0.7 : 0.35,
          );

          facilities.push(
            facilitySchema.parse({
              id: facilityIdSchema.parse(
                `${blockId}-${tier}-${String(tierIndex + 1).padStart(2, '0')}`,
              ),
              name: `${tier} ${district.name} ${String(blockIndex + 1)}-${String(tierIndex + 1)}`,
              tier,
              blockId,
              districtId,
              regionId,
              lgdCode: `SIM-FAC-${String(facilities.length + 1).padStart(5, '0')}`,
              coordinates,
              catchmentPopulation: rng.int(minPopulation, maxPopulation),
              normPopulation: Math.round((minPopulation + maxPopulation) / 2),
              sanctionedPosts: rng.int(
                tier === 'CHC' ? 18 : tier === 'PHC' ? 9 : 3,
                tier === 'CHC' ? 30 : tier === 'PHC' ? 16 : 6,
              ),
              sanctionedBeds: rng.int(minBeds, maxBeds),
              connectivity:
                tier === 'CHC'
                  ? rng.weighted([
                      ['good', 3],
                      ['intermittent', 2],
                      ['poor', 1],
                    ])
                  : rng.weighted([
                      ['good', 1],
                      ['intermittent', 3],
                      ['poor', 3],
                      ['none', 1],
                    ]),
              coldChain: {
                available: coldChainAvailable,
                reliability: coldChainAvailable ? rng.float(0.6, 0.99) : rng.float(0, 0.2),
              },
              synthetic: true,
              provenance: {
                kind: 'assumption',
                reference: 'iphs-norms',
              },
            }),
          );
        }
      }
    }
  }

  return { country, regions, districts, blocks, facilities };
}
