import { expect, test } from '@playwright/test';

import {
  bedEnvelope,
  districtIdNamed,
  facilityOfTier,
  postIngest,
  readCatalogue,
  readVisibility,
  stockEnvelope,
  today,
  unambiguousCatalogueItem,
} from './support';

/**
 * What a district officer sees, and what the platform refuses to claim.
 *
 * The claim under test is the phase's least fashionable and most important one:
 * a facility that has not reported is shown as unknown. Rendering silence as a
 * clearance is how a dashboard reassures a district officer about exactly the
 * facilities most likely to be in trouble, so the assertions here are about
 * absence — that no stock figure appears for a facility the platform has never
 * heard from, and that the gap panel names it.
 *
 * The journeys act on Gaya, whose facilities no other journey writes to, so the
 * three spec files can run beside each other against one server.
 */

const DISTRICT = 'Gaya';

test.describe('the district visibility surface', () => {
  test('is reachable from the overview and states what it does not know', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Visibility' })
      .click();

    await expect(page).toHaveURL(/\/visibility$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('What the district can see');
    await expect(
      page.getByRole('heading', { name: 'No reading is not a clearance' }),
    ).toBeVisible();
    await expect(page.getByText('All data simulated').first()).toBeVisible();
  });

  test('shows a facility it has never heard from as unknown rather than as stocked', async ({
    page,
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const silent = await facilityOfTier(request, districtId, 'SHC');
    const current = await facilityOfTier(request, districtId, 'CHC');

    // The preconditions that make the assertion meaningful.
    expect(silent.reading.status).toBe('never-heard');
    expect(silent.reading.stock).toBeNull();
    expect(current.reading.status).toBe('current');

    await page.goto('/visibility');

    // Scoped to the facilities panel: the same facility is named again in the
    // gap panel below, which is the point of that panel.
    const panel = page.getByRole('region', { name: 'Facilities', exact: true });
    const silentRow = panel.getByRole('row', { name: new RegExp(silent.name) });
    await expect(silentRow).toContainText('Never heard from');
    // No reading has ever arrived, so there is no position to show — the columns
    // say so rather than showing zeroes, which would read as empty shelves.
    await expect(silentRow).toContainText('unknown');
    await expect(silentRow).not.toContainText(/\d+ \/ \d+/);

    const currentRow = panel.getByRole('row', { name: new RegExp(current.name) });
    await expect(currentRow).toContainText('Current');
    await expect(currentRow).toContainText('70');
    await expect(currentRow).not.toContainText('unknown');
  });

  test('names the silent facility in the gap panel, with the gap still open', async ({
    page,
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const silent = await facilityOfTier(request, districtId, 'SHC');

    await page.goto('/visibility');

    await expect(
      page.getByRole('heading', { name: 'Facilities the platform cannot see' }),
    ).toBeVisible();

    const gapRow = page
      .getByRole('region', { name: 'Facilities the platform cannot see' })
      .getByRole('row', { name: new RegExp(silent.name) });
    await expect(gapRow).toContainText('everything: no observation of any kind has ever arrived');
    // Open, because a gap that reaches the end of the window has not ended.
    await expect(gapRow).toContainText('2026-03-01');
  });

  test('picks up a capture made elsewhere without a manual refresh', async ({ page, request }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'CHC');

    await page.goto('/visibility');
    const row = page
      .getByRole('region', { name: 'Facilities', exact: true })
      .getByRole('row', { name: new RegExp(facility.name) });
    await expect(row).toContainText('Current');

    // A capture by someone else — a pharmacist at the facility, say — while this
    // officer's page is open. Nothing is reloaded in the browser: the surface
    // polls, and the interval is short enough that the change appears on its own.
    const captured = await postIngest(
      request,
      bedEnvelope({
        facilityId: facility.id,
        key: `e2e-live-${String(Date.now())}`,
        observedOn: today(),
        bedsTotal: 30,
        bedsOccupied: 22,
      }),
    );
    expect(captured.body.outcome).toBe('accepted');

    await expect(row).toContainText('22/30', { timeout: 20_000 });
  });

  test('says a typed movement was typed, and the generated history generated', async ({
    page,
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');
    const item = unambiguousCatalogueItem(await readCatalogue(request));
    const stamp = String(Date.now());

    // A movement a person entered, through the ordinary ingest boundary. The
    // quantity is unique to this run, so the assertion is about *this* movement
    // rather than about a figure the seeded ledger already holds.
    const typed = await postIngest(
      request,
      stockEnvelope({
        facilityId: facility.id,
        itemId: item.id,
        entryId: `e2e-arrival-manual-${stamp}`,
        key: `e2e-arrival-manual-${stamp}`,
        quantity: 4321,
        occurredOn: today(),
      }),
    );
    expect(typed.body.outcome).toBe('accepted');

    // Read back on the district surface, which is where a movement is checked.
    await page.goto('/visibility');

    const rows = page.getByTestId('movement-row');
    const typedRow = rows.filter({ has: page.getByText('Typed · manual') });
    // The badge is built from the same field the ledger carries, so it cannot
    // read one thing while the record says another.
    await expect(typedRow.first()).toHaveAttribute('data-capture', 'manual');
    await expect(typedRow.filter({ hasText: item.name }).first()).toContainText('4,321');

    // The generated history it sits beside stays labelled as generated — the
    // label that keeps a capture and the seeded data apart in one list.
    await expect(rows.filter({ has: page.getByText('Simulated') }).first()).toBeVisible();
  });

  test('opens where a scoped identity is, and lists only the districts it may read', async ({
    page,
    request,
  }) => {
    const otherDistrictId = await districtIdNamed(request, 'Ernakulam');
    const otherDistrict = await readVisibility(request, { districtId: otherDistrictId });

    // Signed in through the interface as a district officer somewhere else. The
    // control sets a session cookie and reloads, so the assertion that it took
    // effect is that the form now shows that identity selected.
    await page.goto('/capture');
    const identity = page.getByLabel('Identity', { exact: true });
    await identity.selectOption(`district_officer:${otherDistrictId}`);
    await expect(identity).toHaveValue(`district_officer:${otherDistrictId}`, { timeout: 15_000 });

    await page.goto('/visibility');
    const district = page.getByLabel('District', { exact: true });
    await expect(district).toHaveValue(otherDistrictId);

    // And the platform lists only what that identity may read: a district
    // officer of Ernakulam is not shown the rest of the country as a menu of
    // places they cannot open.
    const options = await district.locator('option').allInnerTexts();
    expect(options).toHaveLength(1);
    expect(options[0]).toContain(otherDistrict.district.name);
  });
});
