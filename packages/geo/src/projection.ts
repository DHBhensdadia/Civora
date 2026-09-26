/**
 * Where a place sits on the platform's map.
 *
 * The map this serves is **schematic and says so**. India's bounding box is
 * projected onto a square viewBox in plain plate-carrée, which is not the shape
 * a cartographer would draw and is deliberately not pretending to be: the
 * platform's coordinates are approximate state centroids jittered by a
 * documented half-degree (`network.ts`), and the dataset's own provenance table
 * records them as "good enough to place a marker in the right state and not good
 * enough to navigate by". A projection that dressed those up as precise would be
 * the one dishonest thing here.
 *
 * Two consequences are carried in the return value rather than hidden:
 *
 *  - A point **outside the bounds is clamped** and reported as outside, so a
 *    surface can say a marker is at the edge instead of silently relocating a
 *    facility into the sea.
 *  - The value is a **placement**, not a geography: anything that needs a real
 *    position (a Maps link, a distance) reads `latitude`/`longitude` from the
 *    record, never from `x`/`y`.
 */

/** A coordinate, as the network models store it. */
export interface Point {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * India's approximate bounding box, in decimal degrees.
 *
 * Published values, not measured ones: 68.1°E at the western tip, 97.4°E at the
 * eastern, 6.7°N at the southern and 37.1°N at the northern. Rounded outward to
 * whole degrees here so a point on the boundary is not reported as outside it.
 */
export const INDIA_BOUNDS = {
  west: 68,
  east: 98,
  south: 6,
  north: 38,
} as const;

/** The viewBox the map renders in. Square, so both axes use the same units. */
export const MAP_EXTENT = 100;

export interface Placement {
  /** Horizontal position in the `MAP_EXTENT` square. 0 is the west bound. */
  readonly x: number;
  /** Vertical position. 0 is the north bound, because SVG's y grows downwards. */
  readonly y: number;
  /** False when the point lies outside `INDIA_BOUNDS` and was clamped to it. */
  readonly inside: boolean;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/** Place a coordinate in the schematic map. */
export function projectPoint(point: Point): Placement {
  const { west, east, south, north } = INDIA_BOUNDS;
  const inside =
    point.longitude >= west &&
    point.longitude <= east &&
    point.latitude >= south &&
    point.latitude <= north;

  const x = ((clamp(point.longitude, west, east) - west) / (east - west)) * MAP_EXTENT;
  const y = (1 - (clamp(point.latitude, south, north) - south) / (north - south)) * MAP_EXTENT;

  return { x: round(x), y: round(y), inside };
}

/** Two decimals is a fifth of a percent of the map: finer than the data. */
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * One marker, as a surface renders it.
 *
 * `value` is what the marker colours: a count, a share, a score. It is nullable
 * because "no reading" is a state on this map and not a zero — the platform's
 * central honesty rule again, applied to a coloured square.
 */
export interface MapMarker {
  readonly id: string;
  readonly label: string;
  readonly point: Point;
  readonly placement: Placement;
  readonly value: number | null;
  /** Set when the region has no facility to place it by. */
  readonly unplaced: boolean;
}

export interface LocatedFacility {
  readonly regionId: string;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * A centre for each region, averaged from the facilities it holds.
 *
 * Averaging the seeded facility coordinates rather than carrying a second table
 * of centroids keeps one source for a region's position: the state centroids in
 * the simulator are private to the generator, and a copy here would be a figure
 * that could drift from the records the map is describing. The record says the
 * result is approximate, and it is: a region with three facilities gets the
 * middle of three jittered points.
 *
 * A region with no located facility is **absent** from the map rather than
 * placed at the country's centre, which is a place it is not.
 */
export function regionCentres(
  facilities: readonly LocatedFacility[],
): readonly { readonly regionId: string; readonly point: Point }[] {
  const totals = new Map<string, { latitude: number; longitude: number; count: number }>();

  for (const facility of facilities) {
    const running = totals.get(facility.regionId) ?? { latitude: 0, longitude: 0, count: 0 };
    running.latitude += facility.latitude;
    running.longitude += facility.longitude;
    running.count += 1;
    totals.set(facility.regionId, running);
  }

  return [...totals]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([regionId, total]) => ({
      regionId,
      point: {
        latitude: round(total.latitude / total.count),
        longitude: round(total.longitude / total.count),
      },
    }));
}
