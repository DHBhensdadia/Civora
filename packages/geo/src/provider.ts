import { projectPoint } from './projection';
import type { MapMarker, Point } from './projection';

/**
 * The geography port, and the two renderers behind it.
 *
 * ADR 0008 names Google Maps Platform as the preferred geospatial renderer and
 * requires a fallback that is a **configuration change rather than a rewrite**.
 * This is that port: a surface asks for a map, states which markers it has, and
 * is handed a renderer. The renderer it is handed does not change what the
 * markers mean.
 *
 * The rule that matters is what happens with **no key configured**, which is the
 * state of every environment in this repository (no cloud billing yet). Silence
 * would be the wrong answer twice over: the surface would have no map, and no
 * reader would know whether the platform *could* draw one. So the decision
 * carries a **refusal in a sentence**, naming the variable a deployment sets to
 * switch renderers, and the schematic renderer is returned as an equally
 * first-class answer — the same markers, the same values, drawn from the
 * platform's own coordinates.
 *
 * The embed URL is built here rather than in a component because it is a claim
 * about an external service: `provider.test.ts` asserts the centre, the zoom and
 * the key are in it, and that no key means no URL rather than a broken one.
 */

/** The variable a deployment sets to select the Google Maps renderer. */
export const GOOGLE_MAPS_KEY_VARIABLE = 'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY';

/** What the surface wants placed. A marker without a value is a marker with no reading. */
export interface MapMarkerRequest {
  readonly id: string;
  readonly label: string;
  readonly point: Point;
  readonly value: number | null;
}

export interface GoogleMapsRenderer {
  readonly kind: 'google-maps';
  /** The Embed API URL for the map's centre and zoom, with the configured key. */
  readonly embedUrl: string;
  /** The service that has to be attributed wherever the map is drawn. */
  readonly attribution: string;
  readonly markers: readonly MapMarker[];
}

export interface SchematicRenderer {
  readonly kind: 'schematic';
  /** The reason the preferred renderer is not in use, when a page prints one. */
  readonly markers: readonly MapMarker[];
}

export type MapRenderer = GoogleMapsRenderer | SchematicRenderer;

export interface MapProviderDecision {
  readonly renderer: MapRenderer;
  /**
   * Why the preferred renderer was not selected, in a sentence a page can print.
   *
   * Null when it was selected. This is not an error: an unconfigured map key is
   * a supported configuration, and the sentence says which one is in use.
   */
  readonly refusal: string | null;
  /** The variable a deployment sets, named on both paths. */
  readonly keyVariable: string;
}

export interface MapRequest {
  /** The configured key, if the deployment has one. */
  readonly apiKey?: string | undefined;
  readonly markers: readonly MapMarkerRequest[];
  /** Maps zoom, 1–20. Defaults to a whole-country view. */
  readonly zoom?: number | undefined;
  /** Maps centre. Defaults to the middle of the markers. */
  readonly centre?: Point | undefined;
}

const INDIA_CENTRE: Point = { latitude: 22, longitude: 79 };

const place = (markers: readonly MapMarkerRequest[]): readonly MapMarker[] =>
  markers.map((marker) => ({
    id: marker.id,
    label: marker.label,
    point: marker.point,
    placement: projectPoint(marker.point),
    value: marker.value,
    unplaced: false,
  }));

const mean = (markers: readonly MapMarkerRequest[]): Point => {
  if (markers.length === 0) {
    return INDIA_CENTRE;
  }
  const total = markers.reduce(
    (running, marker) => ({
      latitude: running.latitude + marker.point.latitude,
      longitude: running.longitude + marker.point.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: Number((total.latitude / markers.length).toFixed(4)),
    longitude: Number((total.longitude / markers.length).toFixed(4)),
  };
};

const embedUrlFor = (key: string, centre: Point, zoom: number): string => {
  // Written out rather than assembled with `URL`/`URLSearchParams`, because this
  // package is read by the browser surface and by the batch jobs and neither
  // platform's globals should be a dependency of a URL with four parameters.
  const query = [
    ['key', key],
    ['center', `${centre.latitude},${centre.longitude}`],
    ['zoom', String(zoom)],
  ]
    .map(([name, value]) => `${name ?? ''}=${encodeURIComponent(value ?? '')}`)
    .join('&');
  return `https://www.google.com/maps/embed/v1/view?${query}`;
};

/** Choose the renderer for a request, and say which one was chosen and why. */
export function mapProviderFor(request: MapRequest): MapProviderDecision {
  const markers = place(request.markers);
  const key = request.apiKey?.trim();

  if (key === undefined || key === '') {
    return {
      renderer: { kind: 'schematic', markers },
      refusal: `the google-maps renderer is not configured: ${GOOGLE_MAPS_KEY_VARIABLE} is unset, so the map is drawn from the platform's own coordinates`,
      keyVariable: GOOGLE_MAPS_KEY_VARIABLE,
    };
  }

  return {
    renderer: {
      kind: 'google-maps',
      embedUrl: embedUrlFor(key, request.centre ?? mean(request.markers), request.zoom ?? 4),
      attribution: 'Google Maps',
      markers,
    },
    refusal: null,
    keyVariable: GOOGLE_MAPS_KEY_VARIABLE,
  };
}
