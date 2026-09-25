import { z } from 'zod';

import {
  blockIdSchema,
  countryIdSchema,
  districtIdSchema,
  facilityIdSchema,
  provenanceSchema,
  regionIdSchema,
  syntheticSchema,
} from './common';

/**
 * The administrative spine.
 *
 * The hierarchy is country → region → district → block → facility, and it is
 * deliberately not India-specific: a country is a configuration value, a region
 * is a federation silo, and a district is the level at which redistribution
 * authority realistically sits. Nothing above this comment may assume otherwise.
 */

/** Facility tiers, from the community level up to the referral tier. */
export const FACILITY_TIERS = ['SHC', 'AAM', 'PHC', 'CHC'] as const;
export const facilityTierSchema = z.enum(FACILITY_TIERS);
export type FacilityTier = z.infer<typeof facilityTierSchema>;

/**
 * How reliably a facility can reach the network.
 *
 * This is a first-class attribute rather than telemetry: it decides whether the
 * platform may assume a report arrives at all, and therefore whether a missing
 * value means "nothing to report" or "unknown".
 */
export const CONNECTIVITY_BANDS = ['good', 'intermittent', 'poor', 'none'] as const;
export const connectivityBandSchema = z.enum(CONNECTIVITY_BANDS);
export type ConnectivityBand = z.infer<typeof connectivityBandSchema>;

export const coordinatesSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const coldChainCapabilitySchema = z.strictObject({
  available: z.boolean(),
  /**
   * How often the cold chain actually holds, between 0 and 1. A facility can
   * own a refrigerator and still fail to keep a vaccine at temperature, and the
   * redistribution rules care about the difference.
   */
  reliability: z.number().min(0).max(1),
});

/**
 * Normed population served and bed strength per tier.
 *
 * Sourced from IPHS norms; see `docs/DATA_PROVENANCE.md`. The simulator seeds
 * the network against these bands and the anchoring test asserts conformance,
 * which is why they are data rather than a schema refinement: a real facility
 * may legitimately sit outside its norm, and rejecting real data would be a
 * worse failure than accepting an unusual facility.
 */
export const FACILITY_TIER_NORMS: Readonly<
  Record<
    FacilityTier,
    {
      readonly label: string;
      readonly population: readonly [number, number];
      readonly beds: readonly [number, number];
    }
  >
> = {
  SHC: { label: 'Sub Health Centre', population: [3_000, 5_000], beds: [0, 2] },
  AAM: { label: 'Ayushman Arogya Mandir', population: [3_000, 5_000], beds: [0, 2] },
  PHC: { label: 'Primary Health Centre', population: [20_000, 30_000], beds: [4, 6] },
  CHC: { label: 'Community Health Centre', population: [80_000, 120_000], beds: [30, 30] },
};

export const countrySchema = z.strictObject({
  id: countryIdSchema,
  name: z.string().trim().min(1),
  /** ISO 4217, so cost figures are never bare numbers. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 currency code'),
  /** BCP-47 tags the platform must be able to localise into. */
  languages: z.array(z.string().trim().min(2)).min(1),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export const regionSchema = z.strictObject({
  id: regionIdSchema,
  countryId: countryIdSchema,
  name: z.string().trim().min(1),
  /** Official administrative code, so the record is joinable by an official. */
  lgdCode: z.string().trim().min(1),
  population: z.int().positive(),
  /** Primary language of the region, BCP-47. */
  language: z.string().trim().min(2),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export const districtSchema = z.strictObject({
  id: districtIdSchema,
  regionId: regionIdSchema,
  name: z.string().trim().min(1),
  lgdCode: z.string().trim().min(1),
  /** District population; the scaling factor for demand and for risk exposure. */
  population: z.int().positive(),
  urbanShare: z.number().min(0).max(1),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export const blockSchema = z.strictObject({
  id: blockIdSchema,
  districtId: districtIdSchema,
  name: z.string().trim().min(1),
  lgdCode: z.string().trim().min(1),
  population: z.int().positive(),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export const facilitySchema = z
  .strictObject({
    id: facilityIdSchema,
    name: z.string().trim().min(1),
    tier: facilityTierSchema,
    blockId: blockIdSchema,
    districtId: districtIdSchema,
    regionId: regionIdSchema,
    /** Official facility code where one exists, so the record is joinable. */
    lgdCode: z.string().trim().min(1),
    coordinates: coordinatesSchema,
    /** Population the facility is responsible for. */
    catchmentPopulation: z.int().positive(),
    /** Population the facility was sited against, per the tier's norm. */
    normPopulation: z.int().positive(),
    /** Posts on the establishment. */
    sanctionedPosts: z.int().nonnegative(),
    /** Beds the facility is staffed and equipped for. */
    sanctionedBeds: z.int().nonnegative(),
    connectivity: connectivityBandSchema,
    coldChain: coldChainCapabilitySchema,
    synthetic: syntheticSchema,
    provenance: provenanceSchema,
  })
  .refine((facility) => facility.normPopulation > 0, {
    message: 'a facility must be sited against a positive population',
    path: ['normPopulation'],
  });

export type Country = z.infer<typeof countrySchema>;
export type Region = z.infer<typeof regionSchema>;
export type District = z.infer<typeof districtSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Facility = z.infer<typeof facilitySchema>;
