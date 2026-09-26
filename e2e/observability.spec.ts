import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { sessionCookie } from './support';
import type { Session } from './support';

/**
 * What an operator can see from outside this process.
 *
 * Four claims, and each is about a mechanism rather than a sentence on a page:
 *
 *  - **liveness** is about the process, and says which adapters are serving it;
 *  - **readiness** is about the platform's ability to serve a decision — it reads
 *    the store, the dataset, the projection and the audit chain, and this journey
 *    asserts the four checks are named and passing rather than that the word
 *    "ready" appears;
 *  - **the correlation id** is on every request: a caller's own id comes back on
 *    the response, and one is minted when the caller sends none, which is what
 *    makes a log line findable from a bug report;
 *  - **the metrics summary** moves when the platform works. The one instrument this
 *    journey can watch from outside is the control tower's own memo, so it reads
 *    the summary, causes a scan, and reads the summary again — a counter that never
 *    moves is a counter nobody is keeping.
 *
 * The unhealthy case is proven in `observability.test.ts` rather than here,
 * deliberately: it requires altering a stored audit record, and the only way to do
 * that from outside the process would be a route that writes records — which is a
 * route this platform must not have.
 */

test.beforeEach(() => {
  test.setTimeout(120_000);
});

const PATIENCE_MS = 60_000;

const headersFor = (session?: Session): Record<string, string> => ({
  connection: 'close',
  ...(session === undefined ? {} : { cookie: sessionCookie(session) }),
});

const principalsOf = async (
  request: APIRequestContext,
): Promise<readonly (Session & { readonly id: string })[]> => {
  const response = await request.get('/api/session', {
    timeout: PATIENCE_MS,
    headers: headersFor(),
  });
  const body = (await response.json()) as {
    readonly principals: readonly (Session & { readonly id: string })[];
  };
  return body.principals;
};

interface Readiness {
  readonly ready: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly ok: boolean;
    readonly detail: string;
  }[];
  readonly capabilities: Readonly<Record<string, string | boolean>>;
  readonly simulated: boolean;
}

interface Metrics {
  readonly store: {
    readonly documents: number;
    readonly fingerprint: string;
    readonly kind: string;
  };
  readonly ledger: { readonly asOf: string | null; readonly revision: number };
  readonly reads: {
    readonly towerCold: number;
    readonly towerWarm: number;
    readonly cacheHitRate: number | null;
  };
  readonly audit: { readonly entries: number; readonly valid: boolean };
  readonly imports: { readonly files: number; readonly rowsWritten: number };
  readonly ai: { readonly provider: string; readonly cacheHitRate: number | null };
}

test.describe('what this process reports about itself', () => {
  test('answers liveness with the adapters that are actually serving it', async ({ request }) => {
    const response = await request.get('/healthz', { timeout: PATIENCE_MS, headers: headersFor() });
    expect(response.status()).toBe(200);

    const body = (await response.json()) as {
      readonly status: string;
      readonly service: string;
      readonly simulated: boolean;
      readonly adapters: { readonly data: { readonly kind: string } };
      readonly runtime: { readonly node: string };
    };

    expect(body.status).toBe('ok');
    expect(body.service).toBe('civora-web');
    expect(body.simulated).toBe(true);
    expect(body.adapters.data.kind.length).toBeGreaterThan(0);
    expect(body.runtime.node).toContain('v');
  });

  test('answers readiness from the store, the dataset, the projection and the chain', async ({
    request,
  }) => {
    const sent = `e2e-observability-${String(Date.now())}`;
    const response = await request.get('/readyz', {
      timeout: PATIENCE_MS,
      headers: { ...headersFor(), 'x-correlation-id': sent },
    });
    expect(response.status()).toBe(200);

    const readiness = (await response.json()) as Readiness;
    expect(readiness.ready).toBe(true);
    expect(readiness.simulated).toBe(true);
    expect(readiness.checks.map((check) => check.name)).toEqual([
      'store',
      'dataset',
      'projection',
      'audit',
    ]);
    for (const check of readiness.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
      // A check that does not say what it looked at cannot be diagnosed when it
      // fails, which is the whole reason readiness is a report rather than a word.
      expect(check.detail.length).toBeGreaterThan(10);
    }
    expect(readiness.capabilities.dataProviderOk).toBe(true);

    // The caller's own id comes back, which is what lets a bug report quote
    // something that finds the lines this request wrote.
    expect(response.headers()['x-correlation-id']).toBe(sent);

    // And one is minted when the caller sends none.
    const minted = await request.get('/healthz', { timeout: PATIENCE_MS, headers: headersFor() });
    expect(minted.headers()['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('reports a metrics summary that moves when the platform works', async ({ request }) => {
    const read = async (): Promise<Metrics> => {
      const response = await request.get('/api/metrics', {
        timeout: PATIENCE_MS,
        headers: headersFor(),
      });
      expect(response.status()).toBe(200);
      const body = (await response.json()) as { readonly metrics: Metrics };
      return body.metrics;
    };

    const before = await read();
    expect(before.store.documents).toBeGreaterThan(0);
    expect(before.store.fingerprint).toMatch(/^sha256:/);
    expect(before.store.kind.length).toBeGreaterThan(0);
    expect(before.ledger.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(before.audit.entries).toBeGreaterThanOrEqual(0);
    expect(before.audit.valid).toBe(true);
    expect(before.imports.files).toBeGreaterThanOrEqual(0);
    // The adapter that serves this build, and `null` rather than a zero for a
    // share nobody has measured yet.
    expect(before.ai.provider.length).toBeGreaterThan(0);
    expect(
      before.reads.cacheHitRate === null ||
        (before.reads.cacheHitRate >= 0 && before.reads.cacheHitRate <= 1),
    ).toBe(true);

    // Cause a scan of the control tower, then read the summary again: the memo's
    // own counters are the instrument, and a counter that never moves is a counter
    // nobody is keeping.
    const tower = await request.get('/api/command', {
      timeout: PATIENCE_MS,
      headers: headersFor(),
    });
    expect(tower.status()).toBe(200);

    const after = await read();
    const scannedBefore = before.reads.towerCold + before.reads.towerWarm;
    const scannedAfter = after.reads.towerCold + after.reads.towerWarm;
    expect(scannedAfter).toBeGreaterThan(scannedBefore);
    // The revision the summary reports is the ledger's own write counter, which is
    // what the memo is keyed on — so the two figures are read from one mechanism.
    expect(after.ledger.revision).toBeGreaterThanOrEqual(before.ledger.revision);
  });

  test('refuses a scoped officer the country-wide operation summary', async ({ request }) => {
    const officer = (await principalsOf(request)).find(
      (principal) => principal.role === 'district_officer',
    );
    expect(officer).toBeDefined();
    if (officer === undefined) {
      return;
    }

    const response = await request.get('/api/metrics', {
      timeout: PATIENCE_MS,
      headers: headersFor({ role: officer.role, scopeId: officer.scopeId, label: officer.label }),
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { readonly detail: string };
    expect(body.detail).toContain(officer.label);
    expect(body.detail).toContain('control room and the auditor');

    // Readiness is a probe and is not scoped: a container runtime has no session.
    const probe = await request.get('/readyz', { timeout: PATIENCE_MS, headers: headersFor() });
    expect(probe.status()).toBe(200);
  });
});
