/**
 * `@civora/geo` — geography behind a port.
 *
 * Scope: the projection a schematic map draws in, the classes a choropleth is
 * coloured by, and the choice between the Google Maps renderer and the fallback
 * that works without a key.
 *
 * The map this serves is **schematic and labelled as such**. The platform's
 * coordinates are approximate state centroids jittered by a documented
 * half-degree, and the provenance table records them as good enough to place a
 * marker in the right state and not good enough to navigate by; a projection that
 * dressed them up as precise would be the dishonest part of the surface. What
 * the package contributes is the arithmetic — bounds, placement, classes, and
 * which renderer is configured — with the honesty carried in the return values
 * (`inside`, `unplaced`, the refusal sentence) rather than in a comment.
 *
 * **Built today:** `projectPoint` and `regionCentres`; `choroplethFor` with an
 * explicit unknown and a single-class answer when every value is equal;
 * `mapProviderFor`, which prefers Google Maps when `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`
 * is set and otherwise refuses it **by name** and returns the schematic renderer.
 *
 * **Not built:** tile rendering, real polygon boundaries, or any geographic
 * analysis. This package places markers and shades regions; it does not measure
 * distance, area or adjacency, and nothing in the platform reads a `x`/`y` as a
 * real position.
 */

export { INDIA_BOUNDS, MAP_EXTENT, projectPoint, regionCentres } from './projection';
export type { LocatedFacility, MapMarker, Placement, Point } from './projection';

export { DEFAULT_CLASS_COUNT, choroplethFor } from './choropleth';
export type { Choropleth, ChoroplethClass } from './choropleth';

export { GOOGLE_MAPS_KEY_VARIABLE, mapProviderFor } from './provider';
export type {
  GoogleMapsRenderer,
  MapMarkerRequest,
  MapProviderDecision,
  MapRenderer,
  MapRequest,
  SchematicRenderer,
} from './provider';
