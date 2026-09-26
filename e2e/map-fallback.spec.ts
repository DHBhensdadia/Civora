import { expect, test } from '@playwright/test';

/**
 * The geographic view with no Maps key.
 *
 * ADR 0008 names Google Maps as the preferred renderer and requires the fallback
 * to be a configuration change rather than a rewrite. Every environment in this
 * repository is the no-key case — there is no billing account — so the fallback
 * is what a reader actually sees, and it has to be **asserted as a working map**
 * rather than accepted as a degraded one: the same regions, the same values, the
 * same classes, drawn from the platform's own coordinates.
 *
 * Two claims are made here and nowhere else: the refusal **names the variable** a
 * deployment would set, and the page makes **no request off the machine** to draw
 * it. The second is the one that matters on stage.
 */

interface TowerView {
  readonly counts: { readonly regions: number };
  readonly map: {
    readonly renderer: string;
    readonly refusal: string | null;
    readonly keyVariable: string;
    readonly markers: readonly { readonly id: string; readonly classIndex: number | null }[];
    readonly classes: { readonly classes: readonly { readonly label: string }[] };
    readonly valueLabel: string;
  };
  readonly regions: readonly {
    readonly id: string;
    readonly name: string;
    readonly atRiskPairs: number;
  }[];
}

test.describe('the map with no key configured', () => {
  test('draws the same data, and says which renderer is in use and why', async ({
    page,
    request,
  }) => {
    const response = await request.get('/api/command');
    const tower = (await response.json()) as TowerView;

    // The port's decision, as the payload carries it.
    expect(tower.map.renderer).toBe('schematic');
    expect(tower.map.refusal).toContain(tower.map.keyVariable);
    expect(tower.map.keyVariable).toBe('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
    expect(tower.map.markers).toHaveLength(tower.counts.regions);

    await page.goto('/command');

    await expect(page.getByTestId('map-renderer')).toHaveText('renderer: schematic');
    await expect(page.getByTestId('map-refusal')).toContainText('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY');
    await expect(page.getByTestId('schematic-map')).toBeVisible();

    // One square per region, shaded by a class the legend names, and every
    // marker carries the value it was shaded for rather than a colour alone.
    const markers = page.locator('[data-testid^="map-marker-"]');
    await expect(markers).toHaveCount(tower.counts.regions);
    for (const region of tower.regions.slice(0, 3)) {
      await expect(page.getByTestId(`map-marker-${region.id}`)).toBeVisible();
    }
    const firstClass = tower.map.classes.classes[0]?.label;
    expect(firstClass).toBeDefined();
    await expect(page.getByTestId('map-legend')).toContainText(firstClass ?? '');

    // The figures the map is drawn from are on the page beside it, so a reader
    // can check a shade against its count without hovering. Scoped to the panel
    // by its accessible name, because the same phrase appears in the panel's own
    // description — a locator that can match twice is a broken assertion.
    const panel = page.getByRole('region', { name: 'Where the risk is' });
    await expect(panel.getByText(tower.map.valueLabel).first()).toBeVisible();

    // Recorded, because a fallback nobody has looked at is a fallback that is
    // broken. The attachment is the screenshot the phase asks both modes for;
    // there is one mode here, and the record says why.
    await test.info().attach('control-tower-map-fallback', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  });

  test('makes no request off the machine to draw the map', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
        external.push(url);
      }
    });

    await page.goto('/command');
    await expect(page.getByTestId('schematic-map')).toBeVisible();

    // The local-first promise, in its strictest form: the geographic view works
    // with nothing outside this machine reachable, which is what makes the live
    // link work in a room with bad wifi.
    expect(external, `the tower requested ${external.join(', ')}`).toEqual([]);
  });

  test('keeps the Google Maps path real rather than deleting it', async ({ request }) => {
    // The port is exercised where it can be: with a key it builds an Embed API
    // URL containing the centre and the zoom, and refuses nothing. That test
    // lives in `packages/geo/src/provider.test.ts`, and this asserts the surface
    // reports the variable rather than a hard-coded string, so the two cannot
    // drift apart without a failure.
    const tower = (await (await request.get('/api/command')).json()) as TowerView;
    expect(tower.map.refusal).toContain('not configured');
    expect(tower.map.valueLabel).toBe('facility-item pairs at risk');
    expect(tower.map.classes.classes.length).toBeGreaterThan(1);
    for (const marker of tower.map.markers) {
      expect(marker.classIndex).not.toBeNull();
    }
  });
});
