/**
 * What this process counts about its own work.
 *
 * A leaf module with no imports, because its whole job is to be callable from
 * anywhere: a counter that can only be incremented by asking another module first
 * is a counter somebody will skip. The names are a union rather than a string,
 * so a metric read and a metric written cannot drift apart silently — adding one
 * here is what makes it readable at `/api/metrics`, and removing one stops the
 * build rather than answering zero for ever.
 *
 * Counters are per process and reset when it restarts, which is the same fact the
 * platform states about its store, its queues and its chain: correct for a
 * single-process demonstration, and in a deployment these are the numbers an
 * operations stack scrapes rather than a page anybody reads.
 */
export const COUNTER_NAMES = ['tower.scan.cold', 'tower.scan.warm'] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

const counts = new Map<CounterName, number>();

/** Count one occurrence. */
export const countEvent = (name: CounterName, by = 1): void => {
  counts.set(name, (counts.get(name) ?? 0) + by);
};

/** What has been counted since this process started. */
export const counterValue = (name: CounterName): number => counts.get(name) ?? 0;
