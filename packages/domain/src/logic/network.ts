import type { ConnectivityBand, FacilityTier } from '../model/administrative';
import { CONNECTIVITY_BANDS, FACILITY_TIERS } from '../model/administrative';
import type { Facility } from '../model/administrative';
import type { RegionId } from '../model/common';

/**
 * Rolling the network up.
 *
 * A national view cannot be a list of 31,000 facilities, so every screen above
 * the facility level is an aggregate of these figures. They are computed rather
 * than stored, so a change to a facility is reflected everywhere at once.
 */

export interface NetworkSummary {
  readonly facilities: number;
  readonly districts: number;
  readonly regions: number;
  readonly byTier: Readonly<Record<FacilityTier, number>>;
  readonly byRegion: Readonly<Record<string, number>>;
  readonly byConnectivity: Readonly<Record<ConnectivityBand, number>>;
  /** Population the network is responsible for, summed across facilities. */
  readonly catchmentPopulation: number;
  readonly sanctionedBeds: number;
  /** Facilities with a working cold chain, and therefore able to hold vaccines. */
  readonly withColdChain: number;
}

const emptyTierCounts = (): Record<FacilityTier, number> =>
  Object.fromEntries(FACILITY_TIERS.map((tier) => [tier, 0])) as Record<FacilityTier, number>;

const emptyConnectivityCounts = (): Record<ConnectivityBand, number> =>
  Object.fromEntries(CONNECTIVITY_BANDS.map((band) => [band, 0])) as Record<
    ConnectivityBand,
    number
  >;

export function summariseNetwork(facilities: readonly Facility[]): NetworkSummary {
  const byTier = emptyTierCounts();
  const byConnectivity = emptyConnectivityCounts();
  const byRegion: Record<string, number> = {};
  const districts = new Set<string>();
  const regions = new Set<RegionId>();
  let catchmentPopulation = 0;
  let sanctionedBeds = 0;
  let withColdChain = 0;

  for (const facility of facilities) {
    byTier[facility.tier] += 1;
    byConnectivity[facility.connectivity] += 1;
    byRegion[facility.regionId] = (byRegion[facility.regionId] ?? 0) + 1;

    districts.add(facility.districtId);
    regions.add(facility.regionId);

    catchmentPopulation += facility.catchmentPopulation;
    sanctionedBeds += facility.sanctionedBeds;
    if (facility.coldChain.available) {
      withColdChain += 1;
    }
  }

  return {
    facilities: facilities.length,
    districts: districts.size,
    regions: regions.size,
    byTier,
    byRegion,
    byConnectivity,
    catchmentPopulation,
    sanctionedBeds,
    withColdChain,
  };
}
