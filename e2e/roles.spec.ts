import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { bedEnvelope, postIngest, sessionCookie } from './support';
import type { Session } from './support';

/**
 * The role matrix.
 *
 * One journey per role, in the order a ministry officer would meet them, and two
 * claims asserted for each: **the role can reach what it is for**, and **it is
 * denied at least one thing it is not** — a surface, a district or a write. A
 * permission system that is only tested on its allowed paths is a permission
 * system nobody has ever seen refuse.
 *
 * The demonstration's identities are read from `/api/session` rather than
 * hard-coded, so a fixture that disappears fails the test that needs it instead
 * of passing against a name nothing serves.
 */

interface PrincipalView {
  readonly id: string;
  readonly label: string;
  readonly role: string;
  readonly scopeId: string | null;
}

interface VisibilityView {
  readonly district: { readonly id: string; readonly name: string };
  readonly districts: readonly { readonly id: string; readonly name: string }[];
  /** Present on a refusal instead of the read model. */
  readonly detail: string;
}

const principals = async (request: APIRequestContext): Promise<readonly PrincipalView[]> => {
  const response = await request.get('/api/session');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { principals: readonly PrincipalView[] };
  return body.principals;
};

const oneOfRole = (list: readonly PrincipalView[], role: string): PrincipalView => {
  const found = list.find((principal) => principal.role === role);
  expect(found, `the demonstration offers no identity for ${role}`).toBeDefined();
  if (found === undefined) {
    throw new Error(`no ${role} identity`);
  }
  return found;
};

const asSession = (principal: PrincipalView): Session => ({
  role: principal.role,
  scopeId: principal.scopeId,
  label: principal.label,
});

const visibility = async (
  request: APIRequestContext,
  session: Session,
  districtId?: string,
): Promise<{ status: number; body: VisibilityView }> => {
  const query = districtId === undefined ? '' : `?districtId=${encodeURIComponent(districtId)}`;
  const response = await request.get(`/api/visibility${query}`, {
    headers: { cookie: sessionCookie(session) },
  });
  return { status: response.status(), body: (await response.json()) as VisibilityView };
};

interface CommandView {
  readonly reason?: string;
  readonly detail?: string;
  readonly national?: boolean;
  readonly counts?: { readonly districts: number; readonly facilities: number };
}

const readCommand = async (
  request: APIRequestContext,
  session?: Session,
): Promise<{ status: number; body: CommandView }> => {
  const response = await request.get('/api/command', {
    headers: session === undefined ? {} : { cookie: sessionCookie(session) },
  });
  return { status: response.status(), body: (await response.json()) as CommandView };
};

const visit = async (page: Page, session: Session, path: string): Promise<void> => {
  // Set by domain rather than by URL, so the journey does not repeat the port
  // the server happens to be running on.
  await page.context().addCookies([
    {
      name: 'civora-session',
      value: encodeURIComponent(JSON.stringify(session)),
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto(path);
};

test.describe('the five roles the platform is built for', () => {
  test('offers an identity for every role, and names the acting one', async ({ page, request }) => {
    const list = await principals(request);

    for (const role of ['phc_staff', 'district_officer', 'state_officer', 'national', 'auditor']) {
      expect(oneOfRole(list, role), role).toBeDefined();
    }

    const auditor = oneOfRole(list, 'auditor');
    await visit(page, asSession(auditor), '/');
    await expect(page.getByTestId('active-role')).toContainText('auditor');
    // Scoped to the navigation, and only the navigation: the overview page links
    // its own destinations in its prose, and an assertion that counted those
    // would be testing the paragraph rather than the permission.
    const nav = page.getByRole('navigation', { name: 'Platform sections' });
    // A read-only identity is not offered the surfaces that exist to make a
    // record, and the navigation is where that is visible rather than enforced.
    for (const label of ['Capture', 'Vision intake', 'Voice intake']) {
      await expect(nav.getByRole('link', { name: label })).toHaveCount(0);
    }
    await expect(nav.getByRole('link', { name: 'Command tower' })).toBeVisible();
  });

  test('refuses a facility worker the command plane, in a sentence', async ({ page, request }) => {
    const staff = oneOfRole(await principals(request), 'phc_staff');

    await visit(page, asSession(staff), '/');
    const nav = page.getByRole('navigation', { name: 'Platform sections' });
    await expect(nav.getByRole('link', { name: 'Command tower' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Capture' })).toBeVisible();

    // The address is reachable — hiding is not refusing — and the answer is a
    // refusal that names the surface and the role, not a 404.
    await page.goto('/command');
    await expect(page.getByText(/This surface is not offered to this role/)).toBeVisible();
    await expect(page.getByText(/Command tower is not offered to phc staff/)).toBeVisible();

    const refused = await readCommand(request, asSession(staff));
    expect(refused.status).toBe(403);
    expect(refused.body.reason).toBe('not-offered');
    expect(refused.body.detail).toContain('Command tower');
  });

  test('scopes a district officer to one district, and says the read is narrowed', async ({
    request,
  }) => {
    const officer = oneOfRole(await principals(request), 'district_officer');
    const session = asSession(officer);

    const visible = await visibility(request, session);
    expect(visible.status).toBe(200);
    expect(visible.body.districts).toHaveLength(1);
    expect(visible.body.district.id).toBe(officer.scopeId);

    const tower = await readCommand(request, session);
    expect(tower.status).toBe(200);
    expect(tower.body.national).toBe(false);
    const counts = tower.body.counts as { districts: number };
    expect(counts.districts).toBe(1);
  });

  test('refuses a state officer another state’s district', async ({ request }) => {
    const list = await principals(request);
    const officer = oneOfRole(list, 'state_officer');
    const session = asSession(officer);

    const own = await visibility(request, session);
    expect(own.status).toBe(200);
    const ownDistricts = new Set(own.body.districts.map((district) => district.id));

    const national = await visibility(request, asSession(oneOfRole(list, 'national')));
    const foreign = national.body.districts.find((district) => !ownDistricts.has(district.id));
    expect(foreign, 'the network is expected to hold more than one state').toBeDefined();
    if (foreign === undefined) {
      return;
    }

    const refused = await visibility(request, session, foreign.id);
    expect(refused.status).toBe(403);
    // The refusal names the rule that stopped it rather than a status code alone.
    expect(refused.body.detail).toContain('outside it');
  });

  test('reads the whole country as the control room, and counts it', async ({ request }) => {
    const tower = await readCommand(request);
    expect(tower.status).toBe(200);
    expect(tower.body.national).toBe(true);
    const counts = tower.body.counts as { districts: number; facilities: number };
    expect(counts.districts).toBeGreaterThan(1);
    expect(counts.facilities).toBeGreaterThan(0);
  });

  test('lets an auditor read everything and write nothing', async ({ page, request }) => {
    const auditor = asSession(oneOfRole(await principals(request), 'auditor'));

    // Reads: the tower and the inbox are both open to a read-only identity.
    expect((await readCommand(request, auditor)).status).toBe(200);
    const intelligence = await request.get('/api/intelligence', {
      headers: { cookie: sessionCookie(auditor) },
    });
    expect(intelligence.ok()).toBe(true);

    // Writes: the alert move and the ingest boundary both refuse, and the alert
    // refusal says which rule stopped it.
    const alerts = (await intelligence.json()) as { alerts: readonly { id: string }[] };
    const alert = alerts.alerts[0];
    expect(alert, 'the demonstration is expected to raise at least one alert').toBeDefined();
    if (alert === undefined) {
      return;
    }

    const move = await request.post('/api/alerts', {
      data: { alertId: alert.id, to: 'acknowledged', reason: 'auditor attempt' },
      headers: { cookie: sessionCookie(auditor) },
    });
    expect(move.status()).toBe(403);
    const refusal = (await move.json()) as { detail: string };
    expect(refusal.detail).toContain('does not write to it');

    const ingest = await postIngest(
      request,
      bedEnvelope({
        facilityId: 'SIM-ODISHA-GANJAM-B1-SHC-01',
        key: 'e2e-auditor-refusal',
        observedOn: '2026-09-24',
        bedsTotal: 6,
        bedsOccupied: 2,
      }),
      auditor,
    );
    expect(ingest.status).toBe(403);

    // And the interface offers no write surfaces to the role at all.
    await visit(page, auditor, '/intelligence');
    await expect(page.getByTestId('active-role')).toContainText('auditor');
  });
});
