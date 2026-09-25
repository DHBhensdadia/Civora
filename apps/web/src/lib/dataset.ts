import { RETRIEVAL_DATE, SOURCES, buildDemoDataset } from '@civora/simulator';
import type { DemoDataset, SourceRecord } from '@civora/simulator';

/**
 * The demonstration dataset, and the record of what it is built on.
 *
 * The platform's data reaches the control tower through the `DataProvider`
 * port. The dataset inspector is the one screen that deliberately does not:
 * its subject is the generator's output *before* anything is stored, so it
 * reads the generator directly and reports what it produced, including which
 * layers are read from a publication and which are invented. A page that read
 * the same figures back out of storage could only prove that storage
 * round-trips.
 *
 * The dataset is deterministic, so it is generated once per process and reused.
 * Regenerating per request would cost about a second of simulation to produce
 * the same bytes.
 */

let cached: DemoDataset | undefined;

/** Generate the demonstration dataset, or return the one already generated. */
export function getDemoDataset(): DemoDataset {
  cached ??= buildDemoDataset();
  return cached;
}

/**
 * Every source the dataset rests on, including the ones that could not be
 * retrieved.
 *
 * All nine rather than the three the records cite, because the three failures
 * are the more informative half: they are why administrative identifiers carry
 * a `SIM-` prefix and why facility counts are derived rather than read.
 */
export const SOURCE_REGISTRY: readonly SourceRecord[] = SOURCES;

export { RETRIEVAL_DATE };
