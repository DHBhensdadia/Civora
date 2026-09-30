import { describe, expect, it } from 'vitest';

import { loopBreaker } from './loop-breaker';

/**
 * The contract of the yield, asserted deterministically.
 *
 * The loop this protects is machine-speed dependent — that is why its budget is
 * measured in time — so a test that watched a real scan would pass or fail with the
 * speed of the machine running it. What is tested here is the mechanism: a call that
 * has not spent the budget does **not** give the process back, and one that has does.
 *
 * "Giving the process back" is observed by queueing an immediate *before* the call
 * and reading the order afterwards. An `async` function that does not await anything
 * resolves in a microtask, which no queued immediate can overtake; one that awaits
 * `setImmediate` resumes only after the immediate queued before it has run. A timer
 * would not do: whether a due timer runs before or after a queued immediate depends
 * on which phase of the event loop the test happens to be sitting in.
 */

/** Busy-work for `ms`, standing in for an item the loop had to process. */
function spend(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Deliberate: the loop's own work is synchronous, and so is the wait for it.
  }
}

/** The order in which work reaches the loop: what was queued first, and when the call returned. */
const order = (): {
  readonly trace: string[];
  readonly queued: () => void;
  readonly returned: () => void;
} => {
  const trace: string[] = [];
  return {
    trace,
    queued: () => trace.push('queued-first'),
    returned: () => trace.push('returned'),
  };
};

describe('the loop breaker', () => {
  it('stays out of the way while the budget lasts', async () => {
    const breathe = loopBreaker(60);
    const { trace, queued, returned } = order();
    setImmediate(queued);

    await breathe();
    returned();

    // No yield: the call resumed in a microtask, before the queued immediate could run.
    expect(trace).toEqual(['returned']);
  });

  it('gives the process back once the budget is spent', async () => {
    const breathe = loopBreaker(40);
    spend(60);

    const { trace, queued, returned } = order();
    setImmediate(queued);

    await breathe();
    returned();

    // The queued immediate ran while the caller was suspended — which is the whole
    // point: work that was already waiting gets to happen.
    expect(trace).toEqual(['queued-first', 'returned']);
  });

  it('does not hand the process back twice for one budget', async () => {
    const breathe = loopBreaker(40);
    spend(60);
    await breathe();

    const { trace, queued, returned } = order();
    setImmediate(queued);

    await breathe();
    returned();

    expect(trace).toEqual(['returned']);
  });
});
