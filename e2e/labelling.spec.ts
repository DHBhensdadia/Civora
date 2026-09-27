import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { sessionCookie } from './support';
import type { Session } from './support';

/**
 * Nothing simulated is unlabelled.
 *
 * This build serves a generated national network, and every surface and payload
 * that shows a figure from it has to say so — not once, on the home page, but
 * wherever a reader lands. The disclosure travels with the shell (the header
 * badge and the footer sentence in `app/layout.tsx`), and each payload carries
 * its own provenance marker beside the data it describes.
 *
 * The sweep is the phase-11 gate as a durable instrument rather than a note in a
 * report: it walks every surface and asserts the disclosure is there **exactly
 * once** (a second copy would mean two places to keep true), and it reads every
 * GET payload and names the key that carries its marker.
 *
 * Two payloads carry no `simulated` marker and are asserted as themselves rather
 * than waved through:
 *
 *  - **`/api/audit`** reports a hash-chained trail whose entries are decisions
 *    *people* took. The chain is not generated; what it describes is. Asserting a
 *    marker there would be asserting a label on a real record, so the page-level
 *    disclosure is what covers it, and this file asserts that instead.
 *  - **`/api/telemetry`** reports the platform's own counters — calls, tokens,
 *    refusals — which are measurements of what happened, not simulated data. Its
 *    honesty obligation is naming the adapter it measured, which is asserted here.
 *
 * A new generated payload that carries no marker fails this file, which is the
 * point: adding one is a decision, not an omission.
 */

const DEMO_SEED = 'civora-demo-2026';

/** Every surface a reader can land on, with the landmark that proves it rendered. */
const SURFACES = [
  { path: '/', landmark: 'Civora' },
  { path: '/command', landmark: 'Control tower' },
  { path: '/dataset', landmark: 'What this platform is running on' },
  { path: '/provenance', landmark: 'Provenance' },
  { path: '/visibility', landmark: 'What the district can see' },
  { path: '/intelligence', landmark: 'Poorvadarshan · Chetavani' },
  { path: '/redistribution', landmark: 'Setu — redistribution workbench' },
  { path: '/federation', landmark: 'Federated learning across state silos' },
  { path: '/capture', landmark: 'Capture what the facility counted' },
  { path: '/vision', landmark: 'Read a paper stock register' },
  { path: '/voice', landmark: 'Say it, then confirm it' },
  { path: '/import', landmark: 'Bring a file the ministry already has' },
  { path: '/audit', landmark: 'What was decided, and whether it holds' },
] as const;

const read = async (request: APIRequestContext, path: string): Promise<Record<string, unknown>> => {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path} answered ${String(response.status())}`).toBe(true);
  return (await response.json()) as Record<string, unknown>;
};

/** A nested value by dotted path, so a marker is asserted where it lives. */
const at = (payload: unknown, path: string): unknown => {
  let current: unknown = payload;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

test.describe('the simulated-data disclosure', () => {
  test('travels with the shell, so a deep link cannot open a surface without it', async ({
    page,
  }) => {
    for (const surface of SURFACES) {
      await page.goto(surface.path);

      // The landmark is what separates a rendered surface from Next's 404, which
      // renders *inside* this layout and would otherwise carry the badge too.
      await expect(
        // Exact, because a substring match is how "Provenance" also matches
        // "Data provenance" — a broken assertion rather than a missing heading.
        page.getByRole('heading', { name: surface.landmark, exact: true }),
        `${surface.path} did not render its own heading`,
      ).toBeVisible();

      // The badge is in the header: visible without scrolling, on every surface.
      const badge = page.getByTestId('simulated-badge');
      await expect(badge, `${surface.path} has no simulated-data badge`).toBeVisible();
      await expect(badge).toBeInViewport();

      // And the sentence is in the footer, exactly once.
      await expect(
        page.getByTestId('simulation-disclosure'),
        `${surface.path} has no disclosure sentence`,
      ).toHaveCount(1);
      await expect(page.getByTestId('simulation-disclosure')).toContainText(
        'All data the platform shows is simulated',
      );
    }
  });

  test('is on the surfaces a scoped or read-only identity is offered, too', async ({ page }) => {
    // A role that is offered a different set of surfaces still meets the
    // disclosure: the label is a property of the shell, not of the role.
    const auditor: Session = { role: 'auditor', scopeId: null, label: 'Auditor' };
    await page.goto('/audit');
    // `sessionCookie` returns the whole `name=value` pair, which is what a
    // request header wants and not what a cookie jar wants.
    const raw = sessionCookie(auditor);
    const separator = raw.indexOf('=');
    await page.context().addCookies([
      {
        name: raw.slice(0, separator),
        value: raw.slice(separator + 1),
        url: new URL(page.url()).origin,
      },
    ]);
    await page.reload();

    await expect(
      page.getByRole('heading', { name: 'What was decided, and whether it holds' }),
    ).toBeVisible();
    await expect(page.getByTestId('simulated-badge')).toBeVisible();
    await expect(page.getByTestId('simulation-disclosure')).toHaveCount(1);
  });

  test('is carried by every generated payload, beside the data it describes', async ({
    request,
  }) => {
    // The marker, and the key that carries it, per route.
    const markers: readonly { readonly path: string; readonly key: string }[] = [
      { path: '/api/visibility', key: 'simulated' },
      { path: '/api/visibility', key: 'store.seed' },
      { path: '/api/intelligence', key: 'simulated' },
      { path: '/api/intelligence', key: 'alerts.0.synthetic' },
      { path: '/api/redistribution', key: 'seed' },
      { path: '/api/redistribution', key: 'rows.0.proposal.synthetic' },
      { path: '/api/command', key: 'simulated' },
      { path: '/api/federation', key: 'honesty.simulated' },
      { path: '/api/federation', key: 'world.seed' },
      { path: '/api/advisories', key: 'simulated' },
      { path: '/api/catalogue', key: 'simulated' },
      { path: '/api/session', key: 'simulated' },
      { path: '/api/metrics', key: 'metrics.store.seed' },
      { path: '/healthz', key: 'simulated' },
    ];

    const payloads = new Map<string, Record<string, unknown>>();
    for (const marker of markers) {
      let payload = payloads.get(marker.path);
      if (payload === undefined) {
        payload = await read(request, marker.path);
        payloads.set(marker.path, payload);
      }

      const value = at(payload, marker.key);
      expect(
        value,
        `${marker.path} carries no ${marker.key}: a generated figure without its marker`,
      ).toBeDefined();
      if (marker.key.endsWith('seed')) {
        expect(value).toBe(DEMO_SEED);
      } else {
        // Boolean markers are `true`; narrative ones are a sentence naming the
        // generated world, and a sentence of one word would be a placeholder.
        if (typeof value === 'boolean') {
          expect(value).toBe(true);
        } else {
          expect(String(value).length).toBeGreaterThan(20);
        }
      }
    }

    // The two payloads with no simulated marker, asserted as themselves.
    const audit = await read(request, '/api/audit');
    expect(audit.outcome).toBe('read');
    const trail = audit.trail as {
      readonly report?: { readonly valid?: boolean };
      readonly registered?: readonly unknown[];
    };
    // The chain re-verifies, and the vocabulary of auditable actions is read
    // from the record rather than hard-coded here.
    expect(trail.report?.valid).toBe(true);
    expect((trail.registered ?? []).length).toBeGreaterThan(0);

    const telemetry = await read(request, '/api/telemetry');
    // Its honesty obligation is naming the adapter it measured, not claiming a
    // provenance it does not have.
    expect(['fixture', 'gemini']).toContain(String(telemetry.provider));
    expect(typeof telemetry.reported).toBe('boolean');
  });
});
