import { z } from 'zod';

/**
 * Shared value types.
 *
 * Every schema in this package is the single definition of a shape: the
 * TypeScript type is inferred from it rather than written alongside it, so a
 * contract can never drift from its validator.
 */

/**
 * A moment in time, always UTC and always with a `Z` suffix.
 *
 * Offsets are rejected deliberately. A platform spanning one country can get
 * away with local time; one designed to span several cannot, and a timestamp
 * that is ambiguous by an hour is worse than one that fails to parse.
 */
export const instantSchema = z.iso.datetime();

/** A calendar date with no time and no zone, for values that are dates. */
export const dateSchema = z.iso.date();

export type Instant = z.infer<typeof instantSchema>;
export type DateOnly = z.infer<typeof dateSchema>;

/**
 * Identifiers.
 *
 * Administrative identifiers are branded so the compiler rejects a district
 * code passed where a facility code belongs — the mistake this domain makes
 * most often, and the one that produces a plausible-looking wrong answer
 * rather than a crash. Identifiers of events carry no brand: they are opaque
 * and never exchanged for one another.
 */
export const countryIdSchema = z.string().trim().min(1).brand<'CountryId'>();
export const regionIdSchema = z.string().trim().min(1).brand<'RegionId'>();
export const districtIdSchema = z.string().trim().min(1).brand<'DistrictId'>();
export const blockIdSchema = z.string().trim().min(1).brand<'BlockId'>();
export const facilityIdSchema = z.string().trim().min(1).brand<'FacilityId'>();
export const itemIdSchema = z.string().trim().min(1).brand<'ItemId'>();
export const batchIdSchema = z.string().trim().min(1).brand<'BatchId'>();

/** An opaque identifier for a record: a ledger entry, an alert, a transfer. */
export const recordIdSchema = z.string().trim().min(1);

/**
 * Supplied by the client on every ingest so that a retry cannot double-count.
 * Offline clients resend; duplicates must be impossible, not unlikely.
 */
export const idempotencyKeySchema = z.string().trim().min(1).brand<'IdempotencyKey'>();

export type CountryId = z.infer<typeof countryIdSchema>;
export type RegionId = z.infer<typeof regionIdSchema>;
export type DistrictId = z.infer<typeof districtIdSchema>;
export type BlockId = z.infer<typeof blockIdSchema>;
export type FacilityId = z.infer<typeof facilityIdSchema>;
export type ItemId = z.infer<typeof itemIdSchema>;
export type BatchId = z.infer<typeof batchIdSchema>;
export type RecordId = z.infer<typeof recordIdSchema>;
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/**
 * Where a value came from.
 *
 * `kind` distinguishes a value read from a cited source from one produced by a
 * derivation, a stated assumption, or the simulator. `reference` names it, so
 * every figure the platform displays can be traced back to an entry in
 * `docs/DATA_PROVENANCE.md`.
 */
export const PROVENANCE_KINDS = ['source', 'derived', 'simulated', 'assumption'] as const;

export const provenanceSchema = z.strictObject({
  kind: z.enum(PROVENANCE_KINDS),
  reference: z.string().trim().min(1),
});

export type ProvenanceKind = z.infer<typeof provenanceSchema>['kind'];
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * Whether a record is generated.
 *
 * Present on every record the platform can display, because a reader must never
 * have to guess whether a figure came from a health facility or from this
 * repository's simulator. Real data is `false`; there is no third state.
 */
export const syntheticSchema = z.boolean();

/** The provenance attached to anything the simulator emits. */
export const SIMULATED_PROVENANCE: Provenance = {
  kind: 'simulated',
  reference: 'simulator',
};

/**
 * How a record reached the platform.
 *
 * This is the field that makes the trust story checkable rather than asserted.
 * A stock position is worth different things depending on whether a pharmacist
 * counted it, a photograph was interpreted, a voice note was transcribed, an
 * incumbent system was imported, or a generator invented it — and a reader of
 * the record is entitled to know which without asking.
 *
 * `simulation` is in the enum so that generated data says so in its own fields
 * rather than only in a provenance object, and it is deliberately absent from
 * the sources a client may claim: `CLIENT_CAPTURE_SOURCES` is what the ingest
 * boundary accepts, and accepting `simulation` from an upload would let anyone
 * label their own records as generated and unusable. The boundary refuses it.
 */
export const CAPTURE_SOURCES = ['manual', 'vision', 'voice', 'import', 'simulation'] as const;

export const captureSourceSchema = z.enum(CAPTURE_SOURCES);
export type CaptureSource = z.infer<typeof captureSourceSchema>;

/**
 * Sources an upload may claim.
 *
 * Everything except `simulation`, for the reason given above. Written as a
 * literal rather than derived from `CAPTURE_SOURCES`, because `z.enum` needs the
 * literal type to survive; a test asserts the two lists differ by exactly
 * `simulation`, so a new capture path cannot be added to one and forgotten in
 * the other.
 */
export const CLIENT_CAPTURE_SOURCES = ['manual', 'vision', 'voice', 'import'] as const;

export const clientCaptureSourceSchema = z.enum(CLIENT_CAPTURE_SOURCES);
export type ClientCaptureSource = z.infer<typeof clientCaptureSourceSchema>;

/** The capture source attached to anything the simulator emits. */
export const SIMULATED_CAPTURE_SOURCE: CaptureSource = 'simulation';
