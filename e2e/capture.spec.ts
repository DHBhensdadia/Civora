import { expect, test } from '@playwright/test';

import {
  bedEnvelope,
  districtIdNamed,
  facilityOfTier,
  postIngest,
  readVisibility,
  today,
} from './support';

/**
 * Capture with the network down, and what happens when it comes back.
 *
 * The requirement this phase exists to meet is that a facility at the end of a
 * bad connection can still record what it counted, so the browser here is put
 * genuinely offline — not with the API stubbed, but with no network at all —
 * and the entries are made against a facility the platform has never heard from.
 * Nothing is asserted about how the queue is stored: what is asserted is that
 * the captures survive, that the platform is told about each of them exactly
 * once, and that the facility stops being invisible as a result.
 *
 * The journeys act on their own district, so they can run beside the others
 * against one shared server.
 */

const DISTRICT = 'Ernakulam';

test.describe('capture at a facility with no connection', () => {
  test('queues what is captured offline and reconciles it when the network returns', async ({
    page,
    context,
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'SHC');

    // The starting point the journey is worth: a facility the platform has never
    // heard from, whose position is therefore unknown rather than empty.
    expect(facility.reading.status).toBe('never-heard');
    expect(facility.reading.stock).toBeNull();

    await page.goto('/capture');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Capture what the facility counted',
    );

    await page.getByLabel('District', { exact: true }).selectOption(districtId);
    await page
      .getByLabel('Facility', { exact: true })
      .locator(`option[value="${facility.id}"]`)
      .waitFor({ state: 'attached' });
    await page.getByLabel('Facility', { exact: true }).selectOption(facility.id);

    await context.setOffline(true);
    await expect(page.getByTestId('sync-state')).toContainText('No connection');

    // A receipt of sixty units, which the form validates against the platform's
    // own schema before it will queue it.
    await page.getByRole('radio', { name: 'Medicine movement' }).check();
    await page.getByLabel('Movement', { exact: true }).selectOption('receipt');
    await page.getByLabel(/^Quantity/).fill('60');
    await page.getByLabel('Batch').fill('E2E-BATCH-1');
    await page.getByLabel('Expires').fill('2027-12-31');
    await page.getByRole('button', { name: 'Queue capture' }).click();

    await page.getByRole('radio', { name: 'Beds' }).check();
    await page.getByLabel('Beds', { exact: true }).fill('6');
    await page.getByLabel('Occupied', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Queue capture' }).click();

    await page.getByRole('radio', { name: 'Footfall' }).check();
    await page.getByLabel('Outpatients').fill('40');
    await page.getByLabel('Inpatients').fill('3');
    await page.getByRole('button', { name: 'Queue capture' }).click();

    // Three captures, all still on this device.
    await expect(page.getByTestId('sync-state')).toContainText('3 changes pending');
    await expect(page.locator('[data-testid="outbox-item"][data-status="pending"]')).toHaveCount(3);

    await context.setOffline(false);
    await page.getByRole('button', { name: 'Retry now' }).click();

    await expect(page.locator('[data-testid="outbox-item"][data-status="delivered"]')).toHaveCount(
      3,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('sync-state')).toContainText('0 changes pending');

    // What the platform now holds: the facility is no longer invisible, and the
    // delivery that arrived three times is in the ledger once.
    const payload = await readVisibility(request, { districtId });
    const stored = payload.facilities.find((candidate) => candidate.id === facility.id);
    expect(stored?.reading.status).toBe('current');
    expect(stored?.reading.beds).toEqual({
      observedOn: today(),
      total: 6,
      occupied: 2,
      occupancy: 2 / 6,
    });
    expect(stored?.reading.footfall?.opd).toBe(40);
    expect(
      stored?.reading.recentMovements.filter((movement) => movement.quantity === 60),
    ).toHaveLength(1);
  });

  test('opens the capture screen with no connection at all, once it has been saved to the device', async ({
    page,
    context,
  }) => {
    await page.goto('/capture');
    // The screen is only saved once the worker says it has stored something, so
    // this waits for the device to have the shell rather than for the worker to
    // exist — those are different facts and only the first one is useful.
    await expect(page.getByTestId('shell-state')).toContainText('Screen saved on this device', {
      timeout: 20_000,
    });

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load' });

    // The screen came out of the device, not off the wire: the browser was told
    // there is no network before it asked for anything.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Capture what the facility counted',
    );
    await expect(page.getByTestId('sync-state')).toContainText('No connection');
    await expect(page.getByTestId('shell-state')).toContainText('Screen saved on this device');
    // And the page that came back is the worker's: a document that loaded out of
    // the browser's own cache would not be controlled by it, which is what
    // separates a stored shell from a lucky hit.
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await context.setOffline(false);

    // Reading the platform's own interface is not something the device is
    // allowed to answer for itself: with no connection it must say so rather
    // than show a facility list it remembered from an hour ago.
    await expect(page.getByTestId('context-state')).toContainText('could not be reached', {
      timeout: 20_000,
    });
  });

  test('keeps a refused capture in the queue with the reason, rather than retrying it', async ({
    page,
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'CHC');

    // A record for the same observation already stored with different numbers:
    // the platform refuses the second one and records the disagreement, and no
    // amount of retrying will change that.
    const stored = await postIngest(
      request,
      bedEnvelope({
        facilityId: facility.id,
        key: `e2e-capture-conflict-${String(Date.now())}`,
        observedOn: today(),
        bedsTotal: 30,
        bedsOccupied: 11,
      }),
    );
    expect(stored.body.outcome).toBe('accepted');

    await page.goto('/capture');
    await page.getByLabel('District', { exact: true }).selectOption(districtId);
    await page
      .getByLabel('Facility', { exact: true })
      .locator(`option[value="${facility.id}"]`)
      .waitFor({ state: 'attached' });
    await page.getByLabel('Facility', { exact: true }).selectOption(facility.id);

    await page.getByRole('radio', { name: 'Beds' }).check();
    await page.getByLabel('Beds', { exact: true }).fill('30');
    await page.getByLabel('Occupied', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Queue capture' }).click();
    await page.getByRole('button', { name: 'Retry now' }).click();

    await expect(page.locator('[data-testid="outbox-item"][data-status="refused"]')).toHaveCount(
      1,
      {
        timeout: 20_000,
      },
    );
    await expect(page.getByText(/the stored record stands/)).toBeVisible();
    await expect(page.getByTestId('sync-state')).toContainText('0 changes pending');
  });
});
