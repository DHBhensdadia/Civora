import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { sessionCookie } from './support';
import type { Session } from './support';

/**
 * The intelligence surface, in a browser.
 *
 * Three claims are asserted here and nothing else: that a person can see what the
 * platform expects and read the reason for it driver by driver; that an alert
 * moves through its life with who moved it recorded; and that what looks like a
 * decision is refused when it is not one — no reason given, an identity that only
 * reads, or a move the model does not allow.
 *
 * Everything the tests act on is read from the platform's own API first, so a
 * journey cannot pass by naming a facility, an item or an alert that no longer
 * exists. The demonstration dataset is fixed and so is the set of alerts it
 * raises, but the assertions do not depend on which they are.
 *
 * The lifecycle tests run in order and share one server, because they move the
 * same alerts through their states: acknowledging, then escalating what was
 * acknowledged. Running them in parallel against one record would be a race
 * rather than a test.
 */

test.describe.configure({ mode: 'serial' });

interface AlertView {
  readonly id: string;
  readonly facilityId: string;
  readonly itemId: string;
  readonly state: string;
  readonly severity: string;
  readonly dedupeKey: string;
  readonly acknowledgedBy: string | null;
  readonly history: readonly {
    readonly to: string;
    readonly actor: string;
    readonly reason: string;
  }[];
}

interface RowView {
  readonly itemName: string;
  readonly band: string;
  readonly riskIndex: number;
  readonly shortfallProbability: number | null;
  readonly shortfallWindowDays: number | null;
  readonly drivers: readonly {
    readonly driver: string;
    readonly contribution: number;
    readonly detail: string;
  }[];
}

interface IntelligenceView {
  readonly asOf: string;
  readonly pairsScored: number;
  readonly liftedForecasts: number;
  readonly rows: readonly RowView[];
  readonly alerts: readonly AlertView[];
  readonly events: readonly { readonly syndrome: string; readonly growthRate: number }[];
}

const read = async (request: APIRequestContext, session?: Session): Promise<IntelligenceView> => {
  const response = await request.get('/api/intelligence', {
    headers: session === undefined ? {} : { cookie: sessionCookie(session) },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as IntelligenceView;
};

const AUSTERE: Session = { role: 'auditor', scopeId: null, label: 'Auditor' };

const openIntelligence = async (page: Page): Promise<void> => {
  await page.goto('/intelligence');
  await expect(page.getByRole('heading', { name: 'Poorvadarshan · Chetavani' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alert inbox' })).toBeVisible();
};

test.describe('the intelligence surface', () => {
  test('ranks the population and shows what each band was chosen from', async ({
    page,
    request,
  }) => {
    const payload = await read(request);
    expect(payload.pairsScored).toBeGreaterThan(0);

    await page.goto('/intelligence');

    // Reachable from the navigation, like every other surface.
    await expect(page.getByRole('link', { name: 'Intelligence' })).toBeVisible();
    // The summary counts the whole scored population, not only the rows sent.
    await expect(
      page.getByText(
        `${payload.pairsScored.toLocaleString('en-IN')} pairs scored at ${payload.asOf}`,
      ),
    ).toBeVisible();

    const worst = payload.rows[0];
    expect(worst, 'the ranked list is expected to hold at least one pair').toBeDefined();
    if (worst === undefined) {
      return;
    }

    const row = page.locator('tr', { hasText: worst.itemName }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText(worst.band, { exact: true })).toBeVisible();

    // The drivers behind the band are readable rather than hidden behind an
    // unexplained composite: the largest contribution first, each with its own
    // sentence naming the number it used.
    await row.getByText('Nine drivers').first().click();
    const top = worst.drivers[0];
    expect(top).toBeDefined();
    if (top !== undefined) {
      await expect(row.getByText(top.detail)).toBeVisible();
    }
    // All nine, not only the one that moved the number: the list is the working,
    // and a reader has to be able to disagree with any part of it.
    expect(worst.drivers).toHaveLength(9);
    for (const driver of worst.drivers.slice(1)) {
      await expect(row.getByText(driver.detail)).toBeVisible();
    }

    // A probability is never shown without the window it was measured over: "in
    // the next five days" and "over a fortnight" are different claims.
    if (worst.shortfallProbability !== null) {
      await expect(
        row.getByText(
          `${String(Math.round(worst.shortfallProbability * 100))}% in ${String(worst.shortfallWindowDays)}d`,
        ),
      ).toBeVisible();
    }
  });

  test('names the epidemic signals the forecasts were lifted for', async ({ page, request }) => {
    const payload = await read(request);

    await page.goto('/intelligence');

    const signal = payload.events[0];
    if (signal === undefined) {
      await expect(page.getByTestId('events-empty')).toBeVisible();
      return;
    }

    await expect(
      page.getByText(`growth ${String(Math.round(signal.growthRate * 100))}% a day`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(`${payload.liftedForecasts.toLocaleString('en-IN')} forecasts lifted`, {
        exact: false,
      }),
    ).toBeVisible();
  });
});

test.describe('the alert lifecycle', () => {
  test('acknowledges with a reason, records who did it, and keeps it after a reload', async ({
    page,
    request,
  }) => {
    const before = await read(request);
    const alert = before.alerts.find((candidate) => candidate.state === 'raised');
    expect(
      alert,
      'the demonstration profile is expected to raise at least one open alert',
    ).toBeDefined();
    if (alert === undefined) {
      return;
    }

    await openIntelligence(page);

    const entry = page.getByTestId(`alert-${alert.id}`);
    await expect(entry).toBeVisible();
    await expect(entry.getByText(alert.severity, { exact: true })).toBeVisible();

    // A move with no reason is refused rather than recorded: an alert whose
    // history says somebody moved it for no stated reason is not auditable.
    await entry.getByRole('button', { name: `Acknowledge ${alert.itemId}` }).click();
    await expect(page.getByTestId('move-refusal')).toBeVisible();
    await expect(page.getByText('a move has to say why it was made')).toBeVisible();

    const reason = 'checked the shelf against the ledger';
    await entry.getByLabel(`Reason for ${alert.itemId}`).fill(reason);
    await entry.getByRole('button', { name: `Acknowledge ${alert.itemId}` }).click();

    await expect(entry.getByText('Acknowledged', { exact: true })).toBeVisible();
    await expect(entry.getByText(reason)).toBeVisible();
    await expect(entry.getByText('National control room (national)')).toBeVisible();

    // The move is on the server rather than in the page: the read says the same.
    const after = await read(request);
    const moved = after.alerts.find((candidate) => candidate.id === alert.id);
    expect(moved?.state).toBe('acknowledged');
    expect(moved?.acknowledgedBy).toBe('National control room');
    expect(moved?.history.at(-1)?.to).toBe('acknowledged');

    await page.reload();
    await expect(
      page.getByTestId(`alert-${alert.id}`).getByText('Acknowledged', { exact: true }),
    ).toBeVisible();
  });

  test('escalates after acknowledging without losing who picked it up', async ({
    page,
    request,
  }) => {
    const before = await read(request);
    const alert = before.alerts.find((candidate) => candidate.state === 'acknowledged');
    expect(alert, 'the previous journey acknowledges one').toBeDefined();
    if (alert === undefined) {
      return;
    }

    await openIntelligence(page);
    const entry = page.getByTestId(`alert-${alert.id}`);

    await entry
      .getByLabel(`Reason for ${alert.itemId}`)
      .fill('no stock in the district store either');
    await entry.getByRole('button', { name: `Escalate ${alert.itemId}` }).click();

    await expect(entry.getByText('Escalated', { exact: true })).toBeVisible();

    const after = await read(request);
    const escalated = after.alerts.find((candidate) => candidate.id === alert.id);
    expect(escalated?.state).toBe('escalated');
    // The escalation does not overwrite the acknowledgement: whoever picked it up
    // first is still the one who picked it up.
    expect(escalated?.acknowledgedBy).toBe(alert.acknowledgedBy);
    expect(escalated?.history.map((move) => move.to)).toEqual([
      ...alert.history.map((move) => move.to),
      'escalated',
    ]);
  });

  test('refuses a read-only identity, and says which rule stopped it', async ({ request }) => {
    const payload = await read(request);
    const alert = payload.alerts[0];
    expect(alert).toBeDefined();
    if (alert === undefined) {
      return;
    }

    const refused = await request.post('/api/alerts', {
      headers: { cookie: sessionCookie(AUSTERE) },
      data: { alertId: alert.id, to: 'resolved', reason: 'reviewing' },
    });

    expect(refused.status()).toBe(403);
    const body = (await refused.json()) as { reason?: string; detail?: string };
    expect(body.reason).toBe('not-permitted');
    expect(body.detail).toContain('auditor reads the record');

    // And nothing moved: a refusal leaves the record exactly as it was.
    const after = await read(request);
    expect(after.alerts.find((candidate) => candidate.id === alert.id)?.state).toBe(alert.state);
  });

  test('refuses a move the model does not allow instead of clamping it', async ({ request }) => {
    const payload = await read(request);
    // Deliberately an alert still `raised`: earlier journeys moved one on, and
    // `escalated` *can* propose an action, so picking any open alert would make
    // this assertion depend on which alert the run happened to leave behind.
    const open = payload.alerts.find((candidate) => candidate.state === 'raised');
    expect(
      open,
      'the demonstration profile is expected to raise more than one alert',
    ).toBeDefined();
    if (open === undefined) {
      return;
    }

    // `raised` cannot go straight to `action_proposed`: acknowledging is what
    // creates the acknowledgement the next move depends on. A store that clamped
    // this would record a decision nobody made.
    const refused = await request.post('/api/alerts', {
      data: { alertId: open.id, to: 'action_proposed', reason: 'jumping ahead' },
    });

    expect(refused.status()).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ reason: 'not-permitted' });
  });
});

test.describe('keeping the inbox from filling up', () => {
  test('holds one alert per condition, and a resolved one leaves the list', async ({
    page,
    request,
  }) => {
    const payload = await read(request);

    // The identity of an alert is the condition, not the alert: the same
    // facility, item and set of reasons never appears twice in the inbox.
    const conditions = payload.alerts.map((alert) => alert.dedupeKey);
    expect(new Set(conditions).size).toBe(conditions.length);

    await openIntelligence(page);

    const open = payload.alerts.filter((alert) => alert.state !== 'resolved');
    expect(open.length).toBeGreaterThan(0);
    const resolvable = open.find((alert) => alert.state !== 'raised') ?? open[0];
    if (resolvable === undefined) {
      return;
    }

    const entry = page.getByTestId(`alert-${resolvable.id}`);
    await entry
      .getByLabel(`Reason for ${resolvable.itemId}`)
      .fill('a transfer from the district store arrived');
    await entry.getByRole('button', { name: `Resolve ${resolvable.itemId}` }).click();

    await expect(page.getByTestId(`alert-${resolvable.id}`)).toHaveCount(0);

    const after = await read(request);
    expect(after.alerts.find((candidate) => candidate.id === resolvable.id)?.state).toBe(
      'resolved',
    );
    // Resolved alerts are hidden from the inbox, not deleted: the record of a
    // decision that was made is not something a surface gets to remove.
    expect(after.alerts.some((candidate) => candidate.id === resolvable.id)).toBe(true);
  });
});
