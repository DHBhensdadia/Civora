/**
 * How a facility tier is named to a reader.
 *
 * One map, read by every surface that lists facilities, because two surfaces
 * naming the same tier differently is how a reader concludes they are looking at
 * two different things. The abbreviations are the ones the generator sites its
 * network against.
 */

export const TIER_LABELS: Readonly<Record<string, string>> = {
  SHC: 'Sub Health Centre',
  AAM: 'Ayushman Arogya Mandir',
  PHC: 'Primary Health Centre',
  CHC: 'Community Health Centre',
};

/** The label for a tier, or the abbreviation itself when this build has no name for it. */
export const tierLabelOf = (tier: string): string => TIER_LABELS[tier] ?? tier;
