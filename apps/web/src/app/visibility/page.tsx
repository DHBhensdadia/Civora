'use client';

import { useCallback, useEffect, useState } from 'react';

import { CountList, DataTable, Notice, Panel, StatCard, formatCount } from '@/components/ui';
import { captureBadge } from '@/lib/capture-label';
import type { CaptureTone } from '@/lib/capture-label';

/**
 * What the district can see, and what it cannot.
 *
 * The officer's surface, and the one that carries the platform's central claim:
 * a facility that has stopped reporting is shown as unknown, never as stocked.
 * The distinction is not decoration. A dashboard that renders silence as green
 * tells a district officer that everything is fine in exactly the places where
 * it is least likely to be, and that is the failure this platform exists to
 * remove.
 *
 * The data is read over HTTP from the visibility route rather than streamed.
 * The local in-process adapter has no change feed, so the page polls on a short
 * interval and says so in the interface — "refreshes every 5 seconds" is honest;
 * a label claiming a live subscription the platform does not have would not be.
 */

/** How often to re-read. Short enough to look live, long enough to be cheap. */
const REFRESH_INTERVAL_MS = 5000;

/**
 * How many movements the panel lists across the whole district.
 *
 * Twelve, newest first, rather than five per facility: the question the panel
 * answers is "did the thing I captured land, and does it read as a capture", and
 * a per-facility window pushes a single capture off the end of the list as the
 * facility's own history moves on.
 */
const MOVEMENTS_SHOWN = 12;

/** How each capture family is drawn, so the words and the colour agree. */
const CAPTURE_TONES: Readonly<Record<CaptureTone, string>> = {
  extracted: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  typed: 'border-slate-600 bg-slate-800/60 text-slate-300',
  imported: 'border-violet-500/40 bg-violet-500/10 text-violet-200',
  generated: 'border-slate-700 bg-slate-900/60 text-slate-400',
  unknown: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
};

interface ReadItem {
  readonly itemId: string;
  readonly name: string;
  readonly unit: string;
  readonly onHand: number;
  readonly inTransit: number;
  readonly daysOfStock: number | null;
  readonly demandBasis: string;
  readonly lastMovementOn: string | null;
}

interface FacilityView {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly tierLabel: string;
  readonly connectivity: string;
  readonly coldChain: boolean;
  readonly sanctionedBeds: number;
  readonly reading: {
    readonly status: 'current' | 'stale' | 'never-heard';
    readonly newestReadingOn: string | null;
    readonly daysSinceReading: number | null;
    readonly daysHeard: number;
    readonly ledgerEntries: number;
    readonly beds: {
      readonly total: number;
      readonly occupied: number;
      readonly occupancy: number;
    } | null;
    readonly attendance: {
      readonly present: number;
      readonly filled: number;
      readonly compliance: number | null;
    } | null;
    readonly footfall: { readonly opd: number; readonly ipd: number } | null;
    readonly syndromic: { readonly cases: number } | null;
    readonly recentMovements: readonly {
      readonly id: string;
      readonly itemName: string;
      readonly kind: string;
      readonly quantity: number;
      readonly occurredOn: string;
      readonly recordedAt: string;
      readonly captureSource: string;
    }[];
    readonly stock: {
      readonly asOf: string;
      readonly itemsTracked: number;
      readonly itemsOutOfStock: number;
      readonly itemsBelowCritical: number;
      readonly itemsWithUnknownCover: number;
      readonly atRisk: readonly ReadItem[];
    } | null;
    readonly gap: {
      readonly count: number;
      readonly longestDays: number;
      readonly openSince: string | null;
    };
  };
}

interface VisibilityPayload {
  readonly session: { readonly role: string; readonly label: string };
  readonly district: {
    readonly id: string;
    readonly name: string;
    readonly regionName: string;
    readonly population: number;
  };
  readonly districts: readonly {
    readonly id: string;
    readonly name: string;
    readonly regionName: string;
    readonly facilities: number;
    readonly heard: number;
    readonly stale: number;
    readonly neverHeard: number;
  }[];
  readonly facilities: readonly FacilityView[];
  readonly thresholds: { readonly staleAfterDays: number; readonly criticalCoverDays: number };
  readonly ledger: { readonly asOf: string; readonly windowDays: number };
  readonly store: {
    readonly seed: string;
    readonly fingerprint: string;
    readonly facilitiesWithHistory: number;
    readonly window: { readonly from: string; readonly to: string };
  };
}

const STATUS_WORDS: Readonly<Record<FacilityView['reading']['status'], string>> = {
  current: 'Current',
  stale: 'Stale',
  'never-heard': 'Never heard from',
};

const STATUS_CLASSES: Readonly<Record<FacilityView['reading']['status'], string>> = {
  current: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  stale: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  'never-heard': 'border-rose-500/40 bg-rose-500/10 text-rose-200',
};

const UNKNOWN = 'unknown';

const percent = (value: number): string => `${String(Math.round(value * 100))}%`;

const cover = (value: number | null): string =>
  value === null ? UNKNOWN : `${value.toFixed(1)} days`;

export default function VisibilityPage() {
  const [payload, setPayload] = useState<VisibilityPayload | null>(null);
  const [districtId, setDistrictId] = useState<string>('');
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const open = async (): Promise<void> => {
      const sessionResponse = await fetch('/api/session');
      const session = (await sessionResponse.json()) as { openingDistrictId: string };
      if (!cancelled) {
        setDistrictId((current) => (current === '' ? session.openingDistrictId : current));
      }
    };

    void open();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (districtId === '') {
      return;
    }

    const response = await fetch(`/api/visibility?districtId=${encodeURIComponent(districtId)}`);
    const body = (await response.json()) as VisibilityPayload & { detail?: string };

    if (!response.ok) {
      setError(body.detail ?? 'this district is outside the scope you are signed in with');
      setPayload(null);
      return;
    }

    setError(null);
    setPayload(body);
    setUpdatedAt(new Date().toISOString());
  }, [districtId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [load]);

  if (payload === null) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">What the district can see</h1>
        <p className="text-slate-400">{error ?? 'Reading the district…'}</p>
      </main>
    );
  }

  const { district, facilities, thresholds, store, ledger } = payload;
  const neverHeard = facilities.filter((facility) => facility.reading.status === 'never-heard');
  const stale = facilities.filter((facility) => facility.reading.status === 'stale');

  // Everything the district holds that is running out, worst first. This is the
  // question an officer actually asks — where do I send stock — so it is one
  // list rather than a table per facility.
  const atRisk = facilities
    .flatMap((facility) =>
      (facility.reading.stock?.atRisk ?? []).map((item) => ({ facility: facility.name, item })),
    )
    .filter(
      (entry) =>
        entry.item.daysOfStock !== null && entry.item.daysOfStock < thresholds.criticalCoverDays,
    )
    .sort((left, right) => (left.item.daysOfStock ?? 0) - (right.item.daysOfStock ?? 0))
    .slice(0, 12);

  // The district's newest movements, which is where a capture is read back. The
  // badge beside each one says how it arrived, so a movement a person typed and
  // one a photograph produced are told apart without opening the ledger.
  const movements = facilities
    .flatMap((facility) =>
      facility.reading.recentMovements.map((movement) => ({ facility, movement })),
    )
    .sort((left, right) => {
      if (left.movement.occurredOn !== right.movement.occurredOn) {
        return left.movement.occurredOn < right.movement.occurredOn ? 1 : -1;
      }
      if (left.movement.recordedAt !== right.movement.recordedAt) {
        return left.movement.recordedAt < right.movement.recordedAt ? 1 : -1;
      }
      return left.movement.id < right.movement.id ? 1 : -1;
    })
    .slice(0, MOVEMENTS_SHOWN);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-widest text-sky-400 uppercase">
          Drishti · visibility
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">What the district can see</h1>
        <p className="max-w-3xl text-slate-300">
          Live stock positions, bed pressure and attendance for every facility in {district.name},{' '}
          {district.regionName} — and, alongside them, the facilities the platform has heard nothing
          from. Silence is reported as silence: an unreported facility has unknown stock, not full
          shelves.
        </p>
        <p className="text-sm text-slate-400">
          Signed in as {payload.session.label} · reading as of {ledger.asOf} · refreshes every{' '}
          {String(REFRESH_INTERVAL_MS / 1000)} seconds (polling, because the local adapter has no
          change feed)
          {updatedAt === '' ? '' : ` · last read ${updatedAt.slice(11, 19)}Z`}
        </p>
      </header>

      <Notice id="unknown-not-safe" tone="warning" title="No reading is not a clearance">
        <p>
          A facility whose last reading is more than {formatCount(thresholds.staleAfterDays)} days
          old is marked <span className="font-mono">stale</span>, and one that has never reported is
          marked <span className="font-mono">never heard from</span>. Neither is given a stock
          figure: the columns read <span className="font-mono">unknown</span>, because the platform
          has nothing to stand a number on. All data here is simulated.
        </p>
      </Notice>

      {error === null ? null : (
        <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {error}
        </p>
      )}

      <Panel
        id="district"
        title="The district"
        description="Counts over the facilities this district is responsible for, with the ones the platform cannot see called out rather than folded into a total."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Facilities"
            value={formatCount(facilities.length)}
            hint={district.name}
          />
          <StatCard
            label="Reporting"
            value={formatCount(facilities.length - neverHeard.length - stale.length)}
            hint="reading is current"
          />
          <StatCard
            label="Stale"
            value={formatCount(stale.length)}
            hint={`nothing for more than ${String(thresholds.staleAfterDays)} days`}
          />
          <StatCard
            label="Never heard from"
            value={formatCount(neverHeard.length)}
            hint="position unknown"
          />
        </div>
        <label className="mt-4 flex max-w-sm flex-col gap-1 text-sm">
          <span className="text-slate-300">District</span>
          <select
            aria-label="District"
            className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
            onChange={(event) => {
              setDistrictId(event.target.value);
            }}
            value={districtId}
          >
            {payload.districts.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name} · {option.regionName} ({formatCount(option.neverHeard)} never heard)
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-slate-500">
          The list is scoped: a district officer sees the districts their scope covers and nothing
          else.
        </p>
      </Panel>

      <Panel
        id="facilities"
        title="Facilities"
        description="One row per facility, attention first. Every figure carries the day it describes; a figure the platform does not have is absent rather than zero."
      >
        <DataTable
          caption="Facility status, beds, attendance, footfall and stock coverage"
          columns={[
            { header: 'Facility' },
            { header: 'Tier' },
            { header: 'Status' },
            { header: 'Newest reading' },
            { header: 'Beds occupied' },
            { header: 'Attendance' },
            { header: 'Outpatients' },
            { header: 'Items tracked', numeric: true },
            { header: 'Out of stock', numeric: true },
            { header: 'Below cover', numeric: true },
            { header: 'Cover unknown', numeric: true },
          ]}
          rows={facilities.map((facility) => {
            const reading = facility.reading;
            const stock = reading.stock;
            return [
              <span key="name" className="flex flex-col">
                <span className="text-slate-200">{facility.name}</span>
                <span className="text-xs text-slate-500">
                  {facility.tierLabel} · {facility.connectivity} connectivity
                  {facility.coldChain ? ' · cold chain' : ''}
                </span>
              </span>,
              facility.tier,
              <span
                key="status"
                className={`inline-block rounded-full border px-2 py-0.5 font-mono text-xs whitespace-nowrap ${STATUS_CLASSES[reading.status]}`}
              >
                {STATUS_WORDS[reading.status]}
              </span>,
              reading.newestReadingOn === null
                ? UNKNOWN
                : `${reading.newestReadingOn}${reading.daysSinceReading === null ? '' : ` (${String(reading.daysSinceReading)}d ago)`}`,
              reading.beds === null
                ? UNKNOWN
                : `${formatCount(reading.beds.occupied)}/${formatCount(reading.beds.total)} · ${percent(reading.beds.occupancy)}`,
              reading.attendance === null
                ? UNKNOWN
                : `${formatCount(reading.attendance.present)}/${formatCount(reading.attendance.filled)}${
                    reading.attendance.compliance === null
                      ? ''
                      : ` · ${percent(reading.attendance.compliance)}`
                  }`,
              reading.footfall === null ? UNKNOWN : formatCount(reading.footfall.opd),
              stock === null ? UNKNOWN : formatCount(stock.itemsTracked),
              stock === null ? UNKNOWN : formatCount(stock.itemsOutOfStock),
              stock === null ? UNKNOWN : formatCount(stock.itemsBelowCritical),
              stock === null ? UNKNOWN : formatCount(stock.itemsWithUnknownCover),
            ];
          })}
        />
      </Panel>

      <Panel
        id="gaps"
        title="Facilities the platform cannot see"
        description="A reporting gap is a period for which nothing arrived. An open gap is the one that has not ended, and it is the one an officer has to act on."
      >
        {neverHeard.length === 0 && stale.length === 0 ? (
          <p
            className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100"
            data-testid="no-gaps"
          >
            Every facility in this district has reported within the last{' '}
            {formatCount(thresholds.staleAfterDays)} days.
          </p>
        ) : (
          <DataTable
            caption="Facilities with no reading, or none recent, with the length of the gap"
            columns={[
              { header: 'Facility' },
              { header: 'Status' },
              { header: 'What is missing' },
              { header: 'Gap' },
              { header: 'Still open' },
            ]}
            rows={[...neverHeard, ...stale].map((facility) => {
              const reading = facility.reading;
              return [
                facility.name,
                <span
                  key="status"
                  className={`font-mono text-xs ${STATUS_CLASSES[reading.status]}`}
                >
                  {STATUS_WORDS[reading.status]}
                </span>,
                reading.newestReadingOn === null
                  ? 'everything: no observation of any kind has ever arrived'
                  : `stock, beds, attendance, footfall and syndromic counts since ${reading.newestReadingOn}`,
                reading.gap.count === 0
                  ? UNKNOWN
                  : `${formatCount(reading.gap.count)} gap(s), longest ${formatCount(reading.gap.longestDays)} days`,
                reading.gap.openSince ?? 'no',
              ];
            })}
          />
        )}
      </Panel>

      <Panel
        id="at-risk"
        title="Where cover is shortest"
        description={`Items with less than ${formatCount(thresholds.criticalCoverDays)} days of cover at the current rate of use, across the district. Cover is computed from the ledger, corrected for days on which the shelf was empty — the recorded issue rate during a stock-out measures supply, not need.`}
      >
        {atRisk.length === 0 ? (
          <p className="text-sm text-slate-400">
            No facility with a current reading has an item below{' '}
            {formatCount(thresholds.criticalCoverDays)} days of cover.
          </p>
        ) : (
          <DataTable
            caption="The items with the least cover, by facility, with on-hand stock and demand basis"
            columns={[
              { header: 'Item' },
              { header: 'Facility' },
              { header: 'On hand', numeric: true },
              { header: 'In transit', numeric: true },
              { header: 'Cover' },
              { header: 'Demand basis' },
              { header: 'Last movement' },
            ]}
            rows={atRisk.map((entry) => [
              <span key="item" className="flex flex-col">
                <span className="text-slate-200">{entry.item.name}</span>
                <span className="font-mono text-xs text-slate-500">{entry.item.itemId}</span>
              </span>,
              entry.facility,
              `${formatCount(entry.item.onHand)} ${entry.item.unit}`,
              formatCount(entry.item.inTransit),
              cover(entry.item.daysOfStock),
              entry.item.demandBasis,
              entry.item.lastMovementOn ?? UNKNOWN,
            ])}
          />
        )}
      </Panel>

      <Panel
        id="movements"
        title="How the record arrived"
        description={`The ${formatCount(MOVEMENTS_SHOWN)} most recent movements across the district, each labelled with the channel that produced it — extracted from a photograph or a voice note, typed by a person, imported from another system, or generated for the demonstration. A capture reads differently from the seeded history it sits beside, and a movement the platform cannot place is labelled with its raw source rather than folded into the nearest known one.`}
      >
        {movements.length === 0 ? (
          <p className="text-sm text-slate-400">No movements are held for this district.</p>
        ) : (
          <ul
            className="flex flex-col divide-y divide-slate-800 rounded-lg border border-slate-800"
            data-testid="movement-list"
          >
            {movements.map(({ facility, movement }) => {
              const badge = captureBadge(movement.captureSource);
              return (
                <li
                  key={movement.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
                  data-testid="movement-row"
                  data-capture={movement.captureSource}
                >
                  <span className="text-sm text-slate-200">
                    {facility.name} · {movement.itemName} · {movement.kind}{' '}
                    {formatCount(movement.quantity)} · {movement.occurredOn}
                  </span>
                  <span
                    className={`rounded border px-2 py-1 text-xs whitespace-nowrap ${CAPTURE_TONES[badge.tone]}`}
                  >
                    {badge.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        id="districts"
        title="Every district in scope"
        description="The same count across the districts this session may read, so a district that is quiet is visible before anyone opens it."
      >
        <CountList
          id="districts-quiet"
          title="Facilities never heard from, by district"
          counts={payload.districts
            .map((option) => ({ label: option.name, count: option.neverHeard }))
            .filter((entry) => entry.count > 0)
            .sort((left, right) => right.count - left.count || (left.label < right.label ? -1 : 1))}
          footnote="A district absent from this list has heard from every facility it is responsible for."
        />
      </Panel>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800 pt-6 text-sm text-slate-500">
        <span>
          Generated from seed <code className="font-mono">{store.seed}</code> ·{' '}
          {formatCount(store.facilitiesWithHistory)} facilities with a history · window{' '}
          {store.window.from} → {store.window.to} ({formatCount(ledger.windowDays)} days)
        </span>
        <span>
          Dataset fingerprint <code className="font-mono">{store.fingerprint}</code>
        </span>
        <span>All data simulated</span>
      </footer>
    </main>
  );
}
