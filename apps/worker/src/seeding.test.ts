import { InMemoryDataProvider, bedStatusSchema, stockLedgerEntrySchema } from '@civora/domain';
import type { DataProvider } from '@civora/domain';
import {
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  ITEMS,
  buildNetwork,
  historySample,
  simulateNetwork,
} from '@civora/simulator';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COLLECTION_NAMES, seedDataProvider } from './seeding';

/**
 * Seeding is only useful if it can be run again.
 *
 * The claim these tests hold the command to is not "it does not crash on a
 * second run" but "a second run stores nothing new": same documents, same
 * identifiers, same fingerprint. That is the same property the ingest path
 * relies on when an offline client resends a receipt, so it is worth asserting
 * where a reviewer can see it rather than trusting the addressing scheme by
 * inspection.
 *
 * The dataset is a single facility rather than the shipped sample, because the
 * property is about addressing and the smallest dataset that exercises every
 * collection proves it in a fraction of the time.
 */

const dataset = (seed: string = DEMO_SEED) => {
  const network = buildNetwork(DEMO_NETWORK_OPTIONS);
  const [facility] = historySample(network, 1);
  if (facility === undefined) {
    throw new Error('the demonstration profile is expected to site at least one facility');
  }
  // One facility, chosen by the same rule the shipped dataset uses, so the test
  // exercises a facility that reports beds, staff and footfall rather than
  // whichever one the network happens to list first.
  const simulation = simulateNetwork(network, { seed, facilityIds: [facility] });
  return { network, simulation, items: ITEMS };
};

const data = dataset();

/** Documents actually held for a collection, read back through the port. */
const storedCount = async (provider: DataProvider, collection: string): Promise<number> => {
  const ref = provider.collection(collection, z.unknown());
  return (await ref.list()).length;
};

describe('seeding through the persistence port', () => {
  it('writes every collection the platform stores', async () => {
    const provider = new InMemoryDataProvider();
    const report = await seedDataProvider(provider, data);

    expect(report.collections.map((entry) => entry.collection)).toEqual([...COLLECTION_NAMES]);
    expect(report.documents).toBe(
      report.collections.reduce((total, entry) => total + entry.documents, 0),
    );
    expect(report.documents).toBeGreaterThan(0);
  });

  it('stores exactly what the generator produced', async () => {
    const provider = new InMemoryDataProvider();
    const report = await seedDataProvider(provider, data);
    const counts = new Map(report.collections.map((entry) => [entry.collection, entry.documents]));

    expect(counts.get('facilities')).toBe(data.network.facilities.length);
    expect(counts.get('districts')).toBe(data.network.districts.length);
    expect(counts.get('items')).toBe(ITEMS.length);
    expect(counts.get('stockLedgerEntries')).toBe(data.simulation.ledgerEntries.length);
    expect(counts.get('syndromicSignals')).toBe(data.simulation.syndromicSignals.length);
    expect(counts.get('staffAttendance')).toBe(data.simulation.staffAttendance.length);
  });

  it('holds no duplicate document after a second run', async () => {
    const provider = new InMemoryDataProvider();
    const first = await seedDataProvider(provider, data);
    const second = await seedDataProvider(provider, data);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.documents).toBe(first.documents);

    for (const entry of second.collections) {
      expect(await storedCount(provider, entry.collection)).toBe(entry.documents);
    }
  });

  it('keys a daily observation by its facility and day, so a resend cannot double-store it', async () => {
    const provider = new InMemoryDataProvider();
    await seedDataProvider(provider, data);

    const [bedStatus] = data.simulation.bedStatuses;
    if (bedStatus === undefined) {
      throw new Error('the simulated history is expected to contain bed reports');
    }

    // A facility coming back online resends the days the network missed. The
    // resend addresses the document that day already occupies, so the store is
    // the same size afterwards — and holds the report, not a hole.
    const before = await storedCount(provider, 'bedStatuses');
    const ref = provider.collection('bedStatuses', bedStatusSchema);
    const key = `${bedStatus.facilityId}|${bedStatus.observedOn}`;

    await ref.set(key, bedStatus);
    await ref.set(key, bedStatus);

    expect(await storedCount(provider, 'bedStatuses')).toBe(before);
    expect(await ref.get(key)).not.toBeNull();
  });

  it('stores every record labelled as simulated', async () => {
    const provider = new InMemoryDataProvider();
    await seedDataProvider(provider, data);

    const [entry] = data.simulation.ledgerEntries;
    if (entry === undefined) {
      throw new Error('the simulated history is expected to contain ledger entries');
    }

    const stored = await provider
      .collection('stockLedgerEntries', stockLedgerEntrySchema)
      .get(entry.id);
    expect(stored).not.toBeNull();
    expect(stored?.synthetic).toBe(true);
    expect(stored?.provenance).toEqual({ kind: 'simulated', reference: 'simulator' });
  });

  it('produces a different dataset, and a different fingerprint, from a different seed', async () => {
    const other = dataset('civora-not-the-demo-seed');

    const demoReport = await seedDataProvider(new InMemoryDataProvider(), data);
    const otherReport = await seedDataProvider(new InMemoryDataProvider(), other);

    expect(otherReport.fingerprint).not.toBe(demoReport.fingerprint);
  });
});
