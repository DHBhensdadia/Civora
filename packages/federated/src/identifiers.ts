/**
 * The country axis, as configuration rather than as code.
 *
 * Hackathon rule 4 asks for cross-border applicability, and the way to fail it
 * is the small way: a hardwired `SIM-IN`, a region code parsed as if it were a
 * state code, an identifier format that only holds Indian registrations.
 * Nothing in the round, the aggregation or the accountant may know which country
 * it is running in — a federation between administrative silos is the same
 * algorithm whether the silo is a state, a county or a province.
 *
 * So a country is a *set*: the code it gives itself, what it calls its
 * first-level administrative unit, and how that unit's code is written. Sets are
 * held in a registry and read by id. A country that is not in the registry must
 * be added as data; if a code path ever needs a branch on country, that branch is
 * the defect this module exists to prevent.
 */

export interface RegionIdentifier {
  /** The id a silo is addressed by, in the country's own vocabulary. */
  readonly siloId: string;
  readonly label: string;
}

export interface CountryIdentifierSet {
  readonly countryId: string;
  readonly countryName: string;
  readonly currency: string;
  /** What this country calls its first-level administrative unit. */
  readonly regionLevelName: string;
  /**
   * The code a silo is addressed by, from its position in the network, its name,
   * and the identifier the network already carries.
   *
   * A country whose network was built with its own codes returns the network's
   * own identifier unchanged, so the demonstration's silo ids are exactly the
   * region ids the dataset was generated with rather than a second spelling of
   * them.
   */
  readonly regionCode: (position: number, name: string, networkCode: string) => string;
}

const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** India, as the demonstration world is built. `state` is the silo level. */
export const INDIA_IDENTIFIER_SET: CountryIdentifierSet = {
  countryId: 'SIM-IN',
  countryName: 'India',
  currency: 'INR',
  regionLevelName: 'state',
  regionCode: (_position, _name, networkCode) => networkCode,
};

/**
 * A second country's code set, deliberately not a copy of the first.
 *
 * Kenya's first-level administrative unit is the county and its codes carry a
 * numbering that India's do not. That is the point: this set is the difficult
 * case, and running a round under it is what would fail if any code path —
 * identifier, ordering, label, ledger row — assumed the Indian format.
 */
export const KENYA_IDENTIFIER_SET: CountryIdentifierSet = {
  countryId: 'SIM-KE',
  countryName: 'Kenya',
  currency: 'KES',
  regionLevelName: 'county',
  regionCode: (position, name) =>
    `SIM-KE-C${String(position + 1).padStart(2, '0')}-${slug(name).toUpperCase().slice(0, 8)}`,
};

/** Every country this build can address silos in. */
export const COUNTRY_IDENTIFIER_SETS: readonly CountryIdentifierSet[] = [
  INDIA_IDENTIFIER_SET,
  KENYA_IDENTIFIER_SET,
];

/** The set registered for a country, by its id. */
export function countryIdentifiersFor(countryId: string): CountryIdentifierSet {
  const found = COUNTRY_IDENTIFIER_SETS.find((set) => set.countryId === countryId);
  if (found === undefined) {
    throw new Error(
      `no identifier set is registered for country "${countryId}"; registering one is data, not a code change`,
    );
  }
  return found;
}

/** The identifier one region becomes when it is a silo. */
export const regionIdentifierFor = (
  set: CountryIdentifierSet,
  region: { readonly id: string; readonly name: string },
  position: number,
): RegionIdentifier => ({
  siloId: set.regionCode(position, region.name, region.id),
  label: `${region.name} (${set.regionLevelName})`,
});

/**
 * A network's regions as silos, in the country's vocabulary.
 *
 * The order is the network's own order — taken from the records, not sorted
 * here — because a position is part of a country's code format and a second sort
 * would be a second opinion about which county is number one.
 */
export const siloIdentifiersFor = (
  set: CountryIdentifierSet,
  regions: readonly { readonly id: string; readonly name: string }[],
): readonly RegionIdentifier[] =>
  regions.map((region, position) => regionIdentifierFor(set, region, position));
