import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * The control tower.
 *
 * Two kinds of claim, and the first is the one that keeps the phase honest: the
 * tower **assembles** what the other surfaces computed, so its figures are
 * asserted against `/api/intelligence`'s own bands and alerts rather than against
 * a number written down here. If a risk band changed, the tower would have to
 * change with it or this journey fails.
 *
 * The second is the drill-down. A chain of links that ends at an interesting
 * chart is a chain that a district officer learns to distrust, so the journey
 * walks country → district → facility → item → the movements themselves and
 * asserts the terminal evidence is on the page, with the count of movements
 * stated rather than the presence of a heading.
 */

interface TowerView {
  readonly asOf: string;
  readonly seed: string;
  readonly national: boolean;
  readonly counts: {
    readonly regions: number;
    readonly districts: number;
    readonly facilities: number;
    readonly heard: number;
    readonly atRiskPairs: number;
    readonly openAlerts: number;
  };
  readonly facilities: readonly {
    readonly districtId: string;
    readonly status: string;
    readonly itemsTracked: number;
    readonly atRiskPairs: number;
    readonly facility: { readonly id: string; readonly name: string };
  }[];
  readonly map: {
    readonly renderer: string;
    readonly refusal: string | null;
    readonly keyVariable: string;
    readonly markers: readonly { readonly id: string; readonly classIndex: number | null }[];
    readonly classes: { readonly classes: readonly { readonly label: string }[] };
  };
  readonly change: { readonly day: string; readonly movements: number };
}

interface IntelligenceView {
  readonly bands: readonly { readonly label: string; readonly count: number }[];
  readonly alerts: readonly { readonly state: string }[];
}

const readTower = async (request: APIRequestContext, tier?: string): Promise<TowerView> => {
  const query = tier === undefined ? '' : `?tier=${tier}`;
  const response = await request.get(`/api/command${query}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as TowerView;
};

test.describe('the control tower', () => {
  test('reads its figures from the surfaces beside it rather than computing again', async ({
    request,
  }) => {
    const tower = await readTower(request, 'facility');
    const intelligence = (await (
      await request.get('/api/intelligence')
    ).json()) as IntelligenceView;

    // The map's value is the risk engine's own alerting bands, counted.
    const alerting = intelligence.bands
      .filter((band) => ['unknown', 'critical', 'high'].includes(band.label))
      .reduce((total, band) => total + band.count, 0);
    expect(tower.counts.atRiskPairs).toBe(alerting);

    // Open alerts are the inbox's own, unresolved.
    expect(tower.counts.openAlerts).toBe(
      intelligence.alerts.filter((alert) => alert.state !== 'resolved').length,
    );

    expect(tower.counts.facilities).toBeGreaterThan(0);
    expect(tower.counts.regions).toBeGreaterThan(1);
    expect(tower.national).toBe(true);
    expect(tower.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(tower.seed).toBe('civora-demo-2026');
  });

  test('shows the country, the map and where every figure came from', async ({ page, request }) => {
    const tower = await readTower(request);

    await page.goto('/command');

    await expect(page.getByRole('heading', { level: 1, name: 'Control tower' })).toBeVisible();
    await expect(page.getByTestId('command-scope')).toContainText('every district');
    await expect(page.getByTestId('map-renderer')).toHaveText('renderer: schematic');
    await expect(page.getByTestId('map-refusal')).toContainText(tower.map.keyVariable);

    // One marker per region the read covers, and a legend with the classes the
    // markers were shaded by — not a decorative colour key.
    await expect(page.locator('[data-testid^="map-marker-"]')).toHaveCount(
      tower.map.markers.length,
    );
    expect(tower.map.markers.length).toBe(tower.counts.regions);
    await expect(page.getByTestId('map-legend').locator('li')).toHaveCount(
      tower.map.classes.classes.length + 1,
    );

    // The provenance panel is reachable from the page that shows the figures,
    // and it carries the active seed rather than a claim about one.
    await expect(page.getByText('Data provenance')).toBeVisible();
    await expect(page.getByTestId('command-provenance-seed')).toContainText(tower.seed);
  });

  test('aggregates the same read three ways, and says which one is on screen', async ({
    page,
    request,
  }) => {
    const facilityTier = await readTower(request, 'facility');

    await page.goto('/command?tier=facility');
    await expect(page.getByText(/Reading by/)).toContainText('facility');
    await expect(page.getByText(`${facilityTier.counts.facilities} facility row(s)`)).toBeVisible();

    await page.getByRole('link', { name: 'State', exact: true }).click();
    await expect(page).toHaveURL(/tier=state/);
    await expect(page.getByText(/Reading by/)).toContainText('state');
  });

  test('drills from the country to the batch behind an item', async ({ page, request }) => {
    const tower = await readTower(request, 'facility');
    // A facility the platform has heard from, which is where there is anything
    // to drill into: a never-heard facility is evidence of a gap, not of stock.
    const heard = tower.facilities.find(
      (facility) => facility.status !== 'never-heard' && facility.itemsTracked > 0,
    );
    expect(heard, 'the demonstration is expected to hold a facility with history').toBeDefined();
    if (heard === undefined) {
      return;
    }

    await page.goto('/command?tier=district');
    // The table names districts by name; the identifier is in the link, so the
    // row is found by its link rather than by the raw SIM id.
    const districtLink = page.locator(`a[href*="district=${heard.districtId}"]`).first();
    await expect(districtLink).toBeVisible();
    await districtLink.click();

    // A generous timeout on the drill-down, deliberately: the first read of the
    // country in a process pays for the projections (`docs/control-tower.md`
    // records the measurement), and several journeys run against one server.
    await page.waitForURL(new RegExp(`district=${heard.districtId}`), { timeout: 30_000 });
    await expect(page.getByRole('columnheader', { name: 'Reading' })).toBeVisible();

    const facilityLink = page.locator(`a[href*="facility=${heard.facility.id}"]`).first();
    await expect(facilityLink).toBeVisible();
    await facilityLink.click();

    await page.waitForURL(new RegExp(`facility=${heard.facility.id}`), { timeout: 30_000 });
    const itemLink = page.locator('a[href*="item="]').first();
    await expect(itemLink).toBeVisible();
    const href = await itemLink.getAttribute('href');
    await itemLink.click();

    // The terminal step. `evidence-count` states how many movements the position
    // rests on, so the assertion is a number rather than a heading.
    await page.waitForURL(/item=/, { timeout: 30_000 });
    const evidenceCount = page.getByTestId('evidence-count');
    await expect(evidenceCount).toContainText('movement(s) for this item at this facility');
    const stated = await evidenceCount.textContent();
    const movements =
      Number(/(\d[\d,]*)\s+movement/u.exec(stated ?? '')?.[1]?.replace(/,/gu, '')) || 0;
    expect(movements).toBeGreaterThan(0);
    expect(movements).toBeLessThanOrEqual(10);

    // The record itself: a table of movements whose columns are the ones a
    // person checking a register would ask for, and at least one row with a
    // batch on it, because a receipt without a batch is not evidence.
    for (const column of [
      'Belongs to day',
      'Reached the platform',
      'Batch',
      'Expires',
      'Arrived by',
      'Record',
    ]) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
    }
    const rows = page.locator('table').last().locator('tbody tr');
    await expect(rows).toHaveCount(movements);
    await expect(rows.first().getByText(/simulated|captured/)).toBeVisible();

    // Not a dead end: the same district and the dataset are one link away. The
    // link is matched exactly and taken first, because every panel on the way
    // down links to the same surface — a locator that can match twice is a
    // broken assertion, not a broken page.
    await expect(
      page.getByRole('link', { name: 'visibility surface', exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'dataset inspector' }).first()).toBeVisible();
    expect(href).toContain('item=');
  });

  test('says what changed on the platform’s latest day, and that there is no feed', async ({
    page,
  }) => {
    await page.goto('/command');
    // Scoped to the panel by its accessible name, because the same day is printed
    // in the header as well — a locator that can match twice is a broken
    // assertion, not a broken page.
    const change = page.getByRole('region', { name: /What changed on the platform/ });
    // The day is asserted as a civil day rather than as the exact string the API
    // answered with: journeys run in parallel and a capture filed by another one
    // moves the platform's present, which is the correct behaviour and would
    // otherwise look like a failure here.
    await expect(change.getByText(/^\d{4}-\d{2}-\d{2}$/u)).toBeVisible();
    // Exact, because the table beneath it has a screen-reader caption containing
    // the same words — a locator that can match twice is a broken assertion.
    await expect(change.getByText('Movements recorded', { exact: true })).toBeVisible();
    await expect(page.getByText(/has no change feed/)).toBeVisible();
  });
});
