import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The hand-off between the start-up warm-up and the request path.
 *
 * `instrumentation.ts` is bundled *separately* from the route handlers, so the two
 * copies of `live-store.ts` do not share a module registry. That makes "the world
 * is built once per process" a claim that can quietly stop being true — and if it
 * stops being true the warm-up builds a world nobody reads, which is precisely the
 * cost it exists to avoid. These two tests hold the mechanism:
 *
 *  - a module instance that never saw the warm-up **adopts** the warmed store
 *    rather than building a second one;
 *  - with no warm-up at all, the request path still builds its own, because a
 *    failed warm-up must leave a working platform behind.
 */

const slot = () =>
  (
    globalThis as typeof globalThis & {
      __civoraLiveStore?: Promise<{ readonly info: { readonly documents: number } }>;
    }
  ).__civoraLiveStore;

describe('the start-up warm-up', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __civoraLiveStore?: unknown }).__civoraLiveStore;
    vi.resetModules();
  });

  it('parks the warmed world where a separately bundled copy finds it', async () => {
    const first = await import('./live-store');
    const warmed = await first.warmLiveStore();

    // What is parked is the build rather than the finished world, so a copy that
    // asks mid-build waits for the work already running instead of starting a
    // second 444 MB world — which is how a process dies on a small host rather than
    // merely slowing down.
    expect(await slot()).toBe(warmed);

    // A second copy of the module, as the route handlers see it: no `pending` of
    // its own, and the warmed world waiting on the global.
    vi.resetModules();
    const second = await import('./live-store');
    expect(await second.getLiveStore()).toBe(warmed);
  }, 60_000);

  it('builds the world itself when no warm-up has run, and parks that build too', async () => {
    vi.resetModules();
    const cold = await import('./live-store');
    const store = await cold.getLiveStore();
    expect(store.info.documents).toBeGreaterThan(0);
    expect(store.info.facilitiesWithHistory).toBeGreaterThan(0);

    // The request path leaves the same hand-off behind as the warm-up, so a second
    // copy behind it does not pay for the world again.
    expect(await slot()).toBe(store);
  }, 60_000);
});
