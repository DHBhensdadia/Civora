import { MAP_EXTENT } from '@civora/geo';

import { formatCount } from './ui';
import type { TowerMap } from '@/lib/command-service';

/**
 * The map, drawn from the platform's own coordinates.
 *
 * This is the renderer `@civora/geo` returns whenever a Maps key is not
 * configured, which is every environment this repository ships. It is a
 * **first-class answer rather than a placeholder**: one square per region,
 * placed by the projection, shaded by the same choropleth classes the legend
 * names, with the value and the class printed in the title so the figure is
 * readable without relying on colour.
 *
 * Two things are said on the surface rather than left to be inferred: which
 * renderer is in use — with the refusal sentence naming the variable that would
 * select Google Maps — and that the placement is schematic. A reader who took
 * the squares for boundaries would conclude the platform knows where the borders
 * are, and it does not.
 */

export interface SchematicMapProps {
  readonly id: string;
  readonly map: TowerMap;
}

/**
 * Five shades, dark to hot, shared by the SVG fills and the legend swatches.
 *
 * Hex rather than Tailwind utility classes because the same value has to paint
 * an SVG shape and a legend chip, and one list is what keeps the legend honest
 * about the map.
 */
const COLOURS = ['#0c4a6e', '#0369a1', '#0ea5e9', '#f59e0b', '#e11d48'] as const;
const NO_READING = '#334155';

const colourFor = (index: number | null): string =>
  index === null ? NO_READING : (COLOURS[Math.min(index, COLOURS.length - 1)] ?? NO_READING);

export function SchematicMap({ id, map }: SchematicMapProps) {
  const unplaced = map.markers.filter((marker) => !marker.inside).length;
  const bands = map.classes.classes;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${id}-heading`} className="text-sm font-medium text-fg">
          Stock-out risk across the regions this session can read
        </h3>
        <p data-testid="map-renderer" className="font-mono text-xs text-fg-muted">
          renderer: {map.renderer}
        </p>
      </div>

      <p data-testid="map-refusal" className="max-w-measure text-xs text-fg-muted">
        {map.renderer === 'google-maps'
          ? 'Google Maps is configured for this deployment; the schematic view below is drawn from the same markers, so the figures do not depend on it.'
          : (map.refusal ??
            `the google-maps renderer is not configured, so the map is drawn from the platform's own coordinates`)}
      </p>

      <div className="flex flex-col gap-4 lg:flex-row">
        <svg
          aria-labelledby={`${id}-heading`}
          viewBox={`-4 -4 ${MAP_EXTENT + 8} ${MAP_EXTENT + 8}`}
          role="img"
          data-testid="schematic-map"
          className="h-72 w-72 shrink-0 rounded-instrument border border-ink-700 bg-ink-800"
        >
          <rect x="0" y="0" width={MAP_EXTENT} height={MAP_EXTENT} fill="#020617" opacity="0.6" />
          {map.markers.map((marker) => (
            <rect
              key={marker.id}
              x={marker.x - 3.5}
              y={marker.y - 3.5}
              width="7"
              height="7"
              rx="1"
              fill={colourFor(marker.classIndex)}
              data-testid={`map-marker-${marker.id}`}
            >
              <title>{`${marker.label}: ${
                marker.value === null ? 'no reading' : formatCount(marker.value)
              } ${map.valueLabel}${
                marker.inside ? '' : ' (outside the map bounds, drawn at the edge)'
              }`}</title>
            </rect>
          ))}
        </svg>

        <div className="flex flex-col gap-3">
          <p className="text-sm text-fg-muted">
            Value: <span className="text-fg-muted">{map.valueLabel}</span>, counted from the risk
            engine&rsquo;s own bands. A region with no reading is drawn in grey and never as the
            smallest value.
          </p>
          <ul data-testid="map-legend" className="flex flex-col gap-1 text-xs text-fg-muted">
            {bands.length === 0 ? (
              <li className="font-mono text-fg-muted">no values read</li>
            ) : (
              bands.map((band, index) => (
                <li key={band.label} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 rounded-sm"
                    style={{ backgroundColor: colourFor(index) }}
                  />
                  <span className="font-mono">{band.label}</span>
                </li>
              ))
            )}
            <li className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: NO_READING }}
              />
              <span className="font-mono">no reading</span>
            </li>
          </ul>
          <p className="text-xs text-fg-subtle">
            {map.classes.uniform
              ? 'Every region this session can read carries the same value, so there is one class and nothing to shade.'
              : `${formatCount(map.markers.length)} region markers, placed from facility coordinates. The placement is schematic: good enough to put a marker in the right region, not good enough to navigate by.`}
            {unplaced > 0 ? ` ${formatCount(unplaced)} marker(s) fall outside the map bounds.` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
