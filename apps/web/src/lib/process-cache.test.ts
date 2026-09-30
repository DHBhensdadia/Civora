import { afterEach, describe, expect, it } from 'vitest';

import { sharedSlot } from './process-cache';

/**
 * The slot is three lines of behaviour, and everything that depended on the hand-off
 * before it existed was written by hand at each call site. It is tested here so the
 * service tests can be about their own subject — a scan that is not re-run, a world
 * that is not rebuilt — rather than about this.
 */

const KEY = '__civoraTestSlot';

const host = () => globalThis as unknown as { __civoraTestSlot?: unknown };

describe('a shared slot', () => {
  afterEach(() => {
    delete host().__civoraTestSlot;
  });

  it('is empty until something writes to it', () => {
    expect(sharedSlot<number>(KEY).read()).toBeUndefined();
  });

  it('parks a value where a separately bundled copy finds it', () => {
    const warmed = { documents: 218_719 };
    sharedSlot<typeof warmed>(KEY).write(warmed);

    // A second copy of a module, as the route handlers see it: no module-level
    // variable of its own, and the value waiting on the process.
    const copy = sharedSlot<typeof warmed>(KEY);
    expect(copy.read()).toBe(warmed);
  });

  it('creates once however many copies ask', () => {
    let built = 0;
    const slot = sharedSlot<number>(KEY);
    const create = (): number => (built += 1);

    expect(slot.ensure(create)).toBe(1);
    expect(sharedSlot<number>(KEY).ensure(create)).toBe(1);
    expect(built).toBe(1);
  });
});
