import { createHash } from 'node:crypto';

import {
  OBSERVATION_COLLECTIONS,
  bedStatusSchema,
  blockSchema,
  countrySchema,
  districtSchema,
  facilitySchema,
  footfallObservationSchema,
  itemSchema,
  regionSchema,
  staffAttendanceSchema,
  stockLedgerEntrySchema,
  subjectKeyOf,
  syndromicSignalSchema,
} from '@civora/domain';
import type { DataProvider } from '@civora/domain';
import type { Item } from '@civora/domain';
import type { Network, Simulation } from '@civora/simulator';
import type { ZodType } from 'zod';

/**
 * Writing a generated dataset into whatever is behind the persistence port.
 *
 * Nothing here knows whether the port is a map in this process or a managed
 * database, which is the whole point of the boundary: the same call seeds a
 * developer's laptop and a deployment. What this module adds is the part that
 * makes seeding safe to repeat, and it is not a de-duplication step — it is the
 * choice of document identifier.
 *
 * Every observation is keyed by its natural identity: a ledger entry by its own
 * identifier, and everything else by the facility, the day and whatever
 * dimension it varies along. A second run therefore addresses exactly the
 * documents the first one wrote. That is what idempotency *is* here — not a
 * check that avoids writing, but an addressing scheme under which writing the
 * same record twice is not a duplicate. It is also the same boundary that stops
 * an offline client's retry from double-counting a receipt, so the property the
 * seed command demonstrates is the property the ingest path depends on.
 */

/** A collection and how many documents it holds. */
export interface CollectionCount {
  readonly collection: string;
  readonly documents: number;
}

export interface SeedReport {
  readonly collections: readonly CollectionCount[];
  /** Total documents written across every collection. */
  readonly documents: number;
  /**
   * A digest of every collection name and every document identifier, sorted.
   *
   * The counts alone would not distinguish two datasets of the same size, and
   * "it seeded the same number of records" is a weaker claim than "it seeded the
   * same records". Two runs that produce the same fingerprint contain the same
   * documents under the same identifiers.
   */
  readonly fingerprint: string;
  readonly elapsedMs: number;
}

/** What was generated, and is now to be stored. */
export interface SeedInput {
  readonly network: Network;
  readonly simulation: Simulation;
  /** The catalogue the network was built from. */
  readonly items: readonly Item[];
}

/**
 * The collections a dataset is written to, in the order they are written.
 *
 * Reference data first, so a reader of a seeded store meets the administrative
 * spine before the observations that refer to it — then the observations, whose
 * names come from the ingest contract's own table rather than from string
 * literals here. Two writers exist, this seeder and the ingest boundary, and if
 * they disagreed about where a bed report lives the platform would have two
 * half-empty collections and no error anywhere.
 */
export const COLLECTION_NAMES = [
  'countries',
  'regions',
  'districts',
  'blocks',
  'facilities',
  'items',
  ...Object.values(OBSERVATION_COLLECTIONS),
] as const;

export type CollectionName = (typeof COLLECTION_NAMES)[number];

/** The digest a dataset is identified by. Exported so a caller can check a store against it. */
export const fingerprintOf = (identifiers: ReadonlyMap<string, readonly string[]>): string => {
  const digest = createHash('sha256');
  for (const collection of COLLECTION_NAMES) {
    digest.update(collection);
    for (const identifier of [...(identifiers.get(collection) ?? [])].sort()) {
      digest.update(identifier);
    }
  }
  return `sha256:${digest.digest('hex').slice(0, 32)}`;
};

/**
 * Write a generated dataset through the persistence port.
 *
 * Reads nothing back: a caller that wants to prove the write landed, or that a
 * second write changed nothing, reads through the same port itself. That keeps
 * this function to one direction, which is what makes it usable against a store
 * too large to enumerate.
 */
export async function seedDataProvider(
  provider: DataProvider,
  input: SeedInput,
): Promise<SeedReport> {
  const startedAt = Date.now();
  const counts: CollectionCount[] = [];
  const identifiers = new Map<string, string[]>();

  const writeAll = async <T>(
    collection: CollectionName,
    schema: ZodType<T>,
    records: readonly T[],
    identify: (record: T) => string,
  ): Promise<void> => {
    const ref = provider.collection(collection, schema);
    const written: string[] = [];
    for (const record of records) {
      const identifier = identify(record);
      await ref.set(identifier, record);
      written.push(identifier);
    }
    identifiers.set(collection, written);
    counts.push({ collection, documents: written.length });
  };

  const writeOne = async <T extends { readonly id: string }>(
    collection: CollectionName,
    schema: ZodType<T>,
    record: T,
  ): Promise<void> => writeAll(collection, schema, [record], (only) => only.id);

  await writeOne('countries', countrySchema, input.network.country);
  await writeAll('regions', regionSchema, input.network.regions, (region) => region.id);
  await writeAll('districts', districtSchema, input.network.districts, (district) => district.id);
  await writeAll('blocks', blockSchema, input.network.blocks, (block) => block.id);
  await writeAll('facilities', facilitySchema, input.network.facilities, (facility) => facility.id);
  await writeAll('items', itemSchema, input.items, (item) => item.id);
  await writeAll(
    OBSERVATION_COLLECTIONS.stock_ledger_entry,
    stockLedgerEntrySchema,
    input.simulation.ledgerEntries,
    (entry) => subjectKeyOf('stock_ledger_entry', entry),
  );
  await writeAll(
    OBSERVATION_COLLECTIONS.bed_status,
    bedStatusSchema,
    input.simulation.bedStatuses,
    (status) => subjectKeyOf('bed_status', status),
  );
  await writeAll(
    OBSERVATION_COLLECTIONS.staff_attendance,
    staffAttendanceSchema,
    input.simulation.staffAttendance,
    (attendance) => subjectKeyOf('staff_attendance', attendance),
  );
  await writeAll(
    OBSERVATION_COLLECTIONS.footfall_observation,
    footfallObservationSchema,
    input.simulation.footfall,
    (observation) => subjectKeyOf('footfall_observation', observation),
  );
  await writeAll(
    OBSERVATION_COLLECTIONS.syndromic_signal,
    syndromicSignalSchema,
    input.simulation.syndromicSignals,
    (signal) => subjectKeyOf('syndromic_signal', signal),
  );

  return {
    collections: counts,
    documents: counts.reduce((total, entry) => total + entry.documents, 0),
    fingerprint: fingerprintOf(identifiers),
    elapsedMs: Date.now() - startedAt,
  };
}
