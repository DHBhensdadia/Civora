import { describe, expect, it } from 'vitest';

import { GOOGLE_MAPS_KEY_VARIABLE, mapProviderFor } from './index';

/**
 * The map port.
 *
 * The test that matters is the **no-key** path, because that is the state of
 * every environment this repository ships: the platform still draws the map, and
 * it says in a sentence which renderer is in use and which variable would change
 * it. The keyed path is asserted too — the URL is built here, so a page cannot
 * pass a coordinate it made up — but it is the refusal that a reader sees today.
 */

const markers = [
  {
    id: 'SIM-ODISHA',
    label: 'Odisha',
    point: { latitude: 20.95, longitude: 85.09 },
    value: 12,
  },
  {
    id: 'SIM-KERALA',
    label: 'Kerala',
    point: { latitude: 10.85, longitude: 76.27 },
    value: 3,
  },
];

describe('choosing a renderer', () => {
  it('refuses the preferred renderer by name when no key is configured', () => {
    const decision = mapProviderFor({ markers });

    expect(decision.renderer.kind).toBe('schematic');
    expect(decision.refusal).toContain(GOOGLE_MAPS_KEY_VARIABLE);
    expect(decision.refusal).toContain('not configured');
    expect(decision.keyVariable).toBe(GOOGLE_MAPS_KEY_VARIABLE);
    // The fallback is not a degraded answer: the same markers, placed.
    expect(decision.renderer.markers).toHaveLength(markers.length);
    expect(decision.renderer.markers[0]?.placement.inside).toBe(true);
  });

  it('treats an empty or whitespace key as no key, which is what a copied .env holds', () => {
    expect(mapProviderFor({ markers, apiKey: '' }).renderer.kind).toBe('schematic');
    expect(mapProviderFor({ markers, apiKey: '   ' }).renderer.kind).toBe('schematic');
  });

  it('selects the Google Maps renderer when a key is configured, centred on the markers', () => {
    const decision = mapProviderFor({ markers, apiKey: 'test-key', zoom: 5 });

    expect(decision.renderer.kind).toBe('google-maps');
    expect(decision.refusal).toBeNull();
    if (decision.renderer.kind !== 'google-maps') {
      throw new Error('expected the maps renderer');
    }

    // Parsed by hand rather than with `URL`, so this package needs neither the
    // browser's globals nor node's to state what the URL contains.
    const [base, query] = decision.renderer.embedUrl.split('?');
    expect(base).toBe('https://www.google.com/maps/embed/v1/view');
    const parameters = new Map(
      (query ?? '').split('&').map((pair) => {
        const [name, value] = pair.split('=');
        return [name ?? '', decodeURIComponent(value ?? '')];
      }),
    );
    expect(parameters.get('key')).toBe('test-key');
    expect(parameters.get('zoom')).toBe('5');
    // The centre is the mean of the markers, so a map with no configured centre
    // still opens where its data is.
    expect(parameters.get('center')).toBe('15.9,80.68');
    expect(decision.renderer.attribution).toBe('Google Maps');
  });

  it('asks for a named centre without inventing one when there is nothing to show', () => {
    const decision = mapProviderFor({ markers: [], apiKey: 'test-key' });
    if (decision.renderer.kind !== 'google-maps') {
      throw new Error('expected the maps renderer');
    }
    // The country's middle: a map with no data still has to open somewhere, and
    // this is a declared constant rather than a marker's coordinate.
    expect(decision.renderer.embedUrl).toContain('center=22%2C79');
  });
});
