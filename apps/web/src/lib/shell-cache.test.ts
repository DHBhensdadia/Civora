import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHELL_CACHE, SHELL_WORKER_URL } from './shell-cache';

/**
 * The contract between the page and the worker.
 *
 * The two files run in different worlds — one is bundled, one is served as it
 * is written — so they cannot share a module and they cannot be type-checked
 * against each other. What they must agree on is small but load-bearing: the
 * cache name, and the rule that a platform read never comes out of a cache.
 * Both are asserted here against the worker's own source, because a test that
 * only restated the page's side of the agreement would pass while the worker
 * quietly disagreed.
 */

const workerSource = readFileSync(
  fileURLToPath(new URL('../../public/sw.js', import.meta.url)),
  'utf8',
);

describe('the worker the page registers', () => {
  it('is served from where the page says it is', () => {
    expect(SHELL_WORKER_URL).toBe('/sw.js');
    expect(workerSource.length).toBeGreaterThan(0);
  });

  it('opens the same cache the page names', () => {
    expect(workerSource).toContain(`const SHELL_CACHE = '${SHELL_CACHE}'`);
  });

  it('claims open pages, so a first load is controlled without a reload', () => {
    expect(workerSource).toContain('clients.claim()');
  });

  it('keeps nothing from the platform interface, so a stale reading can never be served', () => {
    expect(workerSource).toContain("startsWith('/api/')");
    expect(workerSource).toContain('request.method !== ');
  });

  it('serves the stored copy only when the network could not be reached', () => {
    // The cached branch lives inside the `catch`; a worker that consulted the
    // cache first would show a facility a position that has already moved.
    const fetchHandler = workerSource.slice(workerSource.indexOf("self.addEventListener('fetch'"));
    expect(fetchHandler.indexOf('catch')).toBeLessThan(fetchHandler.indexOf('cache.match'));
  });
});
