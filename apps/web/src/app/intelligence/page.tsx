'use client';

import { useCallback, useEffect, useState } from 'react';

import { CountList, Notice, Panel, StatCard, formatCount } from '@/components/ui';

/**
 * Poorvadarshan and Chetavani: what the platform expects, and what it is asking
 * somebody to do about it.
 *
 * Two lists, and the difference between them is the design. The **ranked list**
 * is a catalogue: every pair the platform scores, ordered by how bad things look,
 * with all nine drivers and the sentence each one used. The **inbox** is a
 * to-do list: the scores that justify waking somebody, each one carrying the
 * quantity that put it there, with an alert that moves through its life and
 * records who moved it and why.
 *
 * Everything on it is derived from the generated dataset by the same pipeline
 * `worker:score` runs, and the page says so. The forecast window a probability
 * was measured over travels with the number, because "70% in the next five days"
 * and "70% over a fortnight" are different claims and one of them is a stock-out
 * the facility cannot avoid.
 *
 * The data is polled over HTTP, like the visibility surface, and for the same
 * reason: the local in-process adapter has no change feed, and the interface says
 * so rather than implying a live subscription the platform does not have.
 */

/** How often to re-read. Short enough to look live, long enough to be cheap. */
const REFRESH_INTERVAL_MS = 5000;

interface DriverRow {
  readonly driver: string;
  readonly contribution: number;
  readonly detail: string;
}

interface IntelligenceRow {
  readonly facilityId: string;
  readonly facilityName: string;
  readonly districtId: string;
  readonly districtName: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly unit: string;
  readonly essentiality: string;
  readonly band: 'unknown' | 'low' | 'watch' | 'high' | 'critical';
  readonly riskIndex: number;
  readonly shortfallProbability: number | null;
  readonly shortfallWindowDays: number | null;
  readonly horizonDays: number;
  readonly severity: 'watch' | 'high' | 'critical' | null;
  readonly drivers: readonly DriverRow[];
  readonly missing: readonly string[];
}

interface AlertPayload {
  readonly id: string;
  readonly facilityId: string;
  readonly itemId: string;
  readonly raisedOn: string;
  readonly severity: 'watch' | 'high' | 'critical';
  readonly state: string;
  readonly bodies: Readonly<Record<string, string>>;
  readonly dedupeKey: string;
  readonly history: readonly {
    readonly from: string;
    readonly to: string;
    readonly actor: string;
    readonly actorRole: string;
    readonly at: string;
    readonly reason: string;
  }[];
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly resolvedAt: string | null;
}

interface EventPayload {
  readonly id: string;
  readonly facilityName: string;
  readonly districtName: string;
  readonly syndrome: string;
  readonly growthRate: number;
  readonly detectedOn: string;
  readonly windowDays: number;
  readonly baselineCaseCount: number;
  readonly observedCaseCount: number;
  readonly method: string;
}

interface IntelligencePayload {
  readonly session: { readonly role: string; readonly label: string };
  readonly asOf: string;
  readonly horizonDays: number;
  readonly scoredInMs: number;
  readonly pairsScored: number;
  readonly pairsListed: number;
  readonly rowLimit: number;
  readonly liftedForecasts: number;
  readonly bands: readonly { readonly label: string; readonly count: number }[];
  readonly rows: readonly IntelligenceRow[];
  readonly alerts: readonly AlertPayload[];
  readonly events: readonly EventPayload[];
  readonly scope: { readonly wholeCountry: boolean; readonly description: string };
  readonly store: {
    readonly seed: string;
    readonly scenarioId: string;
    readonly scenarioLabel: string;
  };
}

const BAND_CLASSES: Readonly<Record<IntelligenceRow['band'], string>> = {
  critical: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  high: 'border-orange-500/40 bg-orange-500/10 text-orange-200',
  watch: 'border-amber-500/30 bg-amber-500/5 text-amber-200',
  low: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-200',
  unknown: 'border-slate-500/40 bg-slate-500/10 text-slate-200',
};

const STATE_LABELS: Readonly<Record<string, string>> = {
  raised: 'Raised',
  acknowledged: 'Acknowledged',
  action_proposed: 'Action proposed',
  snoozed: 'Snoozed',
  escalated: 'Escalated',
  resolved: 'Resolved',
};

const MOVES: readonly { readonly to: string; readonly label: string }[] = [
  { to: 'acknowledged', label: 'Acknowledge' },
  { to: 'escalated', label: 'Escalate' },
  { to: 'action_proposed', label: 'Propose action' },
  { to: 'snoozed', label: 'Snooze' },
  { to: 'resolved', label: 'Resolve' },
];

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

const probability = (row: IntelligenceRow): string =>
  row.shortfallProbability === null
    ? 'no forecast'
    : `${percent(row.shortfallProbability)} in ${String(row.shortfallWindowDays ?? row.horizonDays)}d`;

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

export default function IntelligencePage() {
  const [payload, setPayload] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/intelligence');
      if (!response.ok) {
        setError(`the platform answered ${String(response.status)}`);
        return;
      }
      setPayload((await response.json()) as IntelligencePayload);
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the read failed');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  const move = async (alert: AlertPayload, to: string): Promise<void> => {
    const reason = (reasons[alert.id] ?? '').trim();
    setBusy(`${alert.id}:${to}`);
    setRefusal(null);

    try {
      const response = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alertId: alert.id, to, reason }),
      });
      const body = (await response.json()) as { detail?: string; outcome?: string };

      if (!response.ok) {
        setRefusal(body.detail ?? `the move was refused with ${String(response.status)}`);
        return;
      }

      setReasons((current) => ({ ...current, [alert.id]: '' }));
      await load();
    } catch (cause) {
      setRefusal(cause instanceof Error ? cause.message : 'the move failed');
    } finally {
      setBusy(null);
    }
  };

  if (payload === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold">Poorvadarshan · Chetavani</h1>
        <p className="text-sm text-slate-400">
          {error === null
            ? 'Scoring the demonstration dataset — forecast, surge lift, nine drivers, alerts…'
            : `The intelligence read failed: ${error}`}
        </p>
      </div>
    );
  }

  const inbox = payload.alerts.filter((alert) => alert.state !== 'resolved');

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold">Poorvadarshan · Chetavani</h1>
        <p className="max-w-3xl text-sm text-slate-400">
          What the platform expects to happen to each facility&apos;s stock, and what it is asking
          somebody to do about it. Every pair is scored from one run at one day, so two readers
          looking at the same district see the same figures.
        </p>
        <p className="text-xs text-slate-500">
          Every figure is derived from the generated dataset (`{payload.store.seed}`, scenario{' '}
          {payload.store.scenarioId}). The band is chosen from what was measured about the shelf;
          the item&apos;s essentiality and the district&apos;s population are shown beside it as
          context and never raise an alarm on their own. Refreshes every 5 seconds (polling, because
          the local adapter has no change feed). Last read {updatedAt}.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Scored"
          value={formatCount(payload.pairsScored)}
          hint={`${formatCount(payload.pairsListed)} listed, ${formatCount(
            payload.rowLimit,
          )}-row cap · ${payload.asOf}`}
        />
        <StatCard
          label="Inbox"
          value={formatCount(inbox.length)}
          hint={`${formatCount(payload.alerts.length)} raised, ${formatCount(
            payload.alerts.length - inbox.length,
          )} resolved`}
        />
        <StatCard
          label="Epidemic signals"
          value={formatCount(payload.events.length)}
          hint={`${formatCount(payload.liftedForecasts)} forecasts lifted for one`}
        />
        <StatCard
          label="Scoring run"
          value={`${formatCount(payload.scoredInMs)} ms`}
          hint={`${payload.horizonDays}-day horizon`}
        />
      </section>

      {payload.session.role === 'auditor' ? (
        <Notice id="auditor" tone="info" title="Read-only identity">
          This session is an auditor: it reads the record and does not write to it. Every alert move
          below will be refused, which is the rule working rather than the interface failing.
        </Notice>
      ) : null}

      {payload.scope.wholeCountry ? null : (
        <Notice id="scope" tone="info" title="Scoped read">
          {payload.scope.description}
        </Notice>
      )}

      {refusal === null ? null : (
        <div data-testid="move-refusal">
          <Notice id="refusal" tone="warning" title="That move was refused">
            {refusal}
          </Notice>
        </div>
      )}

      <Panel
        id="bands"
        title="Where the population sits"
        description="A band is a statement about the shelf. `unknown` is not `low`: it is what the platform says when it cannot measure a pair at all, and it sorts with the worst of them."
      >
        <CountList
          id="band-counts"
          title="Pairs by band"
          counts={payload.bands}
          footnote={`${formatCount(payload.pairsScored)} pairs scored at ${payload.asOf}.`}
        />
      </Panel>

      <Panel
        id="inbox"
        title="Alert inbox"
        description="Conditions that justify somebody acting today, each carrying the quantity that put it there. Acknowledging, escalating, proposing an action, snoozing or resolving an alert appends to its history with who did it, when, and why — and a move the model does not allow is refused rather than clamped."
      >
        {inbox.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="inbox-empty">
            Nothing in the inbox at this scoring day.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {inbox.map((alert) => (
              <li
                key={alert.id}
                aria-label={`Alert for ${alert.itemId} at ${alert.facilityId}`}
                data-testid={`alert-${alert.id}`}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-rose-200">
                    {alert.severity}
                  </span>
                  <span className="rounded border border-slate-700 px-2 py-0.5 text-slate-300">
                    {STATE_LABELS[alert.state] ?? alert.state}
                  </span>
                  <span className="text-slate-500">
                    raised {alert.raisedOn} · condition {alert.dedupeKey}
                  </span>
                </div>

                <p className="mt-2 text-sm text-slate-200">{alert.bodies.en}</p>

                {alert.history.length === 0 ? null : (
                  <ol className="mt-3 flex flex-col gap-1 text-xs text-slate-400">
                    {alert.history.map((move, index) => (
                      <li key={`${alert.id}:${String(index)}`}>
                        {move.from} → {move.to} · {move.actor} ({move.actorRole}) · {move.at} —{' '}
                        {move.reason}
                      </li>
                    ))}
                  </ol>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-slate-400">
                    Reason
                    <input
                      aria-label={`Reason for ${alert.itemId}`}
                      className="w-64 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
                      onChange={(event) => {
                        setReasons((current) => ({ ...current, [alert.id]: event.target.value }));
                      }}
                      value={reasons[alert.id] ?? ''}
                    />
                  </label>
                  {MOVES.map((move_) => (
                    <button
                      key={move_.to}
                      aria-label={`${move_.label} ${alert.itemId}`}
                      className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs text-sky-200 disabled:opacity-40"
                      disabled={busy !== null}
                      onClick={() => {
                        void move(alert, move_.to);
                      }}
                      type="button"
                    >
                      {move_.label}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        id="ranked"
        title="Risk-ranked list"
        description="Every scored pair, worst first, with the driver contributions behind the order. The index ranks and bands; it is not a probability, which is why the forecast's own measured probability and the window it was measured over are shown beside it."
      >
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Facility-item pairs ranked by stock-out risk, with drivers
            </caption>
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60 text-left">
                <th scope="col" className="px-4 py-2 font-medium text-slate-300">
                  Band
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-slate-300">
                  Facility · item
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-slate-300">
                  Index
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-slate-300">
                  Measured shortfall
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-slate-300">
                  Why
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {payload.rows.map((row) => (
                <tr
                  key={`${row.facilityId}|${row.itemId}`}
                  data-testid={`row-${row.facilityId}|${row.itemId}`}
                  className="align-top"
                >
                  <td className="px-4 py-2">
                    <span
                      className={`rounded border px-2 py-0.5 text-xs ${BAND_CLASSES[row.band]}`}
                    >
                      {row.band}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    <span className="block text-slate-200">{row.itemName}</span>
                    <span className="text-xs text-slate-500">
                      {row.facilityName} · {row.districtName} · {row.essentiality}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-200">
                    {row.riskIndex.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-300">{probability(row)}</td>
                  <td className="px-4 py-2 text-slate-400">
                    <details>
                      <summary className="cursor-pointer text-xs text-sky-300">
                        Nine drivers
                        <span className="ml-2 text-slate-500">
                          {row.drivers[0]?.driver ?? 'none'} first
                        </span>
                      </summary>
                      <ul className="mt-2 flex flex-col gap-1 text-xs">
                        {row.drivers.map((driver) => (
                          <li key={driver.driver} className="flex gap-2">
                            <span className="w-10 shrink-0 text-right font-mono text-slate-300">
                              {signed(driver.contribution)}
                            </span>
                            <span className="text-slate-300">
                              <span className="font-medium text-slate-200">{driver.driver}</span> —{' '}
                              {driver.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {row.missing.length === 0 ? null : (
                        <p className="mt-2 text-xs text-amber-200">
                          Could not be measured: {row.missing.join('; ')}
                        </p>
                      )}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        id="events"
        title="Epidemic signals"
        description="Syndromic series whose level moved beyond the facility's own seasonal and weekly pattern, with the growth rate a decision is made on. A signal lifts the forecast for every item that treats the syndrome."
      >
        {payload.events.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="events-empty">
            No epidemic signal was detected in this scoring run. A quiet year is a result.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {payload.events.map((event) => (
              <li
                key={event.id}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm"
              >
                <p className="text-slate-200">
                  {event.syndrome} · {event.facilityName} · {event.districtName}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  detected {event.detectedOn} by {event.method} over {event.windowDays} days ·
                  growth {percent(event.growthRate)} a day · {event.baselineCaseCount.toFixed(1)}{' '}
                  expected against {event.observedCaseCount.toFixed(1)} seen
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
