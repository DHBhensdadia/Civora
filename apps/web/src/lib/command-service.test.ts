import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The control tower's scan must be shared with every copy of this module, and that was
 * found by measuring the deployed host rather than by reasoning about it.
 *
 * **A memo filled in one copy has to be readable from another.** The start-up warm-up
 * runs from a bundle Next compiles separately from the route handlers, so a memo
 * filled there is invisible to a route unless it is parked on the process — see
 * `process-cache.ts`. Invisible, the first visitor pays the whole scan, which on the
 * deployed host was **51.33 s** (`docs/DEPLOYMENT.md` §8.8).
 *
 * The store and the scored population are process-wide and deliberately left warm by
 * the test's own imports: rebuilding them here would spend two seconds of simulation
 * to observe something this test is not about. The *yield* the scan uses while it
 * runs is asserted, deterministically, in `loop-breaker.test.ts` — a test that
 * watched this scan instead would pass or fail with the speed of the machine.
 */

const slots = globalThis as unknown as Record<string, unknown>;

const clearScanMemo = (): void => {
  delete slots.__civoraCommandScans;
};

describe('the control tower scan', () => {
  beforeEach(() => {
    clearScanMemo();
  });

  afterEach(() => {
    clearScanMemo();
    vi.resetModules();
  });

  it('is adopted by a copy that never ran it, rather than paid for again', async () => {
    const { NATIONAL_SESSION } = await import('./session');
    const first = await import('./command-service');

    const warmed = await first.readCommandTower(NATIONAL_SESSION, { tier: 'state' });
    expect(warmed.facilities.length).toBeGreaterThan(0);
    expect(warmed.districts.length).toBeGreaterThan(0);

    // A second copy, as the route handlers see it: fresh module state, the warmed
    // memo waiting on the process.
    vi.resetModules();
    const second = await import('./command-service');
    const tower = await second.readCommandTower(NATIONAL_SESSION, { tier: 'state' });

    expect(tower.facilities.length).toBe(warmed.facilities.length);
    expect(tower.districts.length).toBe(warmed.districts.length);

    // The counters are per copy, which is what makes them the proof: this copy
    // answered from the memo it did not fill, and never scanned the country itself.
    const metrics = await (await import('./observability')).metricsSummaryOf();
    expect(metrics.reads.towerWarm).toBeGreaterThan(0);
    expect(metrics.reads.towerCold).toBe(0);
  }, 60_000);
});
