import { describe, expect, it } from 'vitest';

import { INDIA_BOUNDS, MAP_EXTENT, projectPoint, regionCentres } from './index';

/**
 * The projection.
 *
 * The claims worth holding are directional and about honesty rather than
 * precise: north is up, east is right, the bounds are what the map covers, and a
 * coordinate outside them is **reported** rather than silently moved. A test that
 * pinned a Delhi marker to three decimal places would be asserting arithmetic on
 * fabricated coordinates, which the provenance table already says are
 * approximations.
 */

describe('placing a coordinate on the schematic map', () => {
  it('puts the north-west corner at the origin and the south-east at the far corner', () => {
    const northWest = projectPoint({ latitude: INDIA_BOUNDS.north, longitude: INDIA_BOUNDS.west });
    const southEast = projectPoint({ latitude: INDIA_BOUNDS.south, longitude: INDIA_BOUNDS.east });

    expect(northWest).toEqual({ x: 0, y: 0, inside: true });
    expect(southEast).toEqual({ x: MAP_EXTENT, y: MAP_EXTENT, inside: true });
  });

  it('draws north above south and east to the right of west', () => {
    const delhi = projectPoint({ latitude: 28.61, longitude: 77.21 });
    const chennai = projectPoint({ latitude: 13.08, longitude: 80.27 });

    expect(delhi.y).toBeLessThan(chennai.y);
    expect(delhi.x).toBeLessThan(chennai.x);
    expect(delhi.inside).toBe(true);
  });

  it('clamps a coordinate outside the bounds and says that it did', () => {
    const outside = projectPoint({ latitude: 51.5, longitude: -0.12 });

    // London is north-west of the bounds, so it clamps to the north-west corner:
    // the drawing moves, and `inside` is what tells the surface it did.
    expect(outside.inside).toBe(false);
    expect(outside.x).toBe(0);
    expect(outside.y).toBe(0);
    expect(projectPoint({ latitude: 5, longitude: 100 }).inside).toBe(false);
  });
});

describe('a centre for each region', () => {
  it('averages the facility coordinates it is given, per region', () => {
    const centres = regionCentres([
      { regionId: 'SIM-A', latitude: 10, longitude: 70 },
      { regionId: 'SIM-B', latitude: 20, longitude: 70 },
      { regionId: 'SIM-A', latitude: 20, longitude: 80 },
    ]);

    expect(centres).toEqual([
      { regionId: 'SIM-A', point: { latitude: 15, longitude: 75 } },
      { regionId: 'SIM-B', point: { latitude: 20, longitude: 70 } },
    ]);
  });

  it('leaves a region with no located facility off the map rather than placing it elsewhere', () => {
    // The alternative — a fallback to the country's centre — would put a region
    // somewhere it is not, which is the one thing a map must not do.
    expect(regionCentres([])).toEqual([]);
  });
});
