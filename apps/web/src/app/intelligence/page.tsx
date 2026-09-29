'use client';

import { formatDate, messageFor, messageKeys } from '@civora/i18n';
import type { MessageKey } from '@civora/i18n';
import { useCallback, useEffect, useState } from 'react';

import { SpeakButton } from '@/components/speak';
import { PageHeader } from '@/components/page-header';
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

interface AdvisoryLanguagePayload {
  readonly language: string;
  readonly label: string;
  readonly offered: boolean;
  readonly status: 'written' | 'refused';
  readonly inRecord: string | null;
  readonly generated: string | null;
  readonly title: string | null;
  readonly actions: readonly string[];
  readonly reasoning: readonly string[];
  readonly citations: readonly string[];
  readonly refusal: string | null;
  readonly model: string | null;
  readonly cacheHit: boolean;
  readonly attemptedAt: string;
}

interface AdvisoryPayload {
  readonly provider: string;
  readonly offered: readonly { readonly code: string; readonly label: string }[];
  readonly languages: readonly string[];
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
  readonly regenerated: boolean;
  readonly generatedAt: string;
  readonly generatedInMs: number;
  /** True when the read was taken in presentation mode. */
  readonly presentationMode: boolean;
  /** Why a regeneration was refused, when presentation mode refused one. */
  readonly presentationRefusal: string | null;
  readonly alerts: readonly {
    readonly alertId: string;
    readonly facilityName: string;
    readonly itemName: string;
    readonly severity: string;
    readonly state: string;
    readonly raisedOn: string;
    readonly languages: readonly AdvisoryLanguagePayload[];
  }[];
}

interface TaskTelemetryPayload {
  readonly task: string;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
  readonly meanRequestMs: number | null;
}

interface TelemetryPayload {
  readonly provider: string;
  readonly model: string | null;
  readonly reported: boolean;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
  readonly meanRequestMs: number | null;
  readonly perTask: readonly TaskTelemetryPayload[];
  readonly projection: {
    readonly alerts: number;
    readonly languages: number;
    readonly advisoryPass: number;
    readonly perCapture: number;
  };
  readonly readAt: string;
}

const BAND_CLASSES: Readonly<Record<IntelligenceRow['band'], string>> = {
  critical: 'border-signal-critical/40 bg-signal-critical/10 text-signal-critical',
  high: 'border-signal-high/40 bg-signal-high/10 text-signal-high',
  watch: 'border-signal-watch/30 bg-signal-watch/5 text-signal-watch',
  low: 'border-signal-ok/30 bg-signal-ok/5 text-signal-ok',
  unknown: 'border-hairline bg-paper-sunken text-ink',
};

/**
 * The rail an alert card carries, by severity.
 *
 * The band colour on a ranked row answers "how bad is this pair"; on the inbox
 * the same question is asked of a card a reader may act on, and a rail down the
 * edge of the card answers it before a single word is read. `watch` is the
 * default rather than nothing, so an unexpected severity still gets a rail
 * instead of silently losing its colour.
 */
const SEVERITY_RAIL: Readonly<Record<string, string>> = {
  critical: 'border-l-signal-critical',
  high: 'border-l-signal-high',
  watch: 'border-l-signal-watch',
};

/**
 * What an alert's state is called, in the reader's language.
 *
 * The states are the domain's own identifiers; the bundle names each of them, and
 * a state this build does not know is shown as itself rather than as a neighbour,
 * because a wrong word on an alert is how somebody acts on the wrong one.
 */
const STATE_KEYS: Readonly<Record<string, MessageKey>> = {
  raised: 'alert.state.raised',
  open: 'alert.state.open',
  acknowledged: 'alert.state.acknowledged',
  action_proposed: 'alert.state.action_proposed',
  snoozed: 'alert.state.snoozed',
  escalated: 'alert.state.escalated',
  resolved: 'alert.state.resolved',
};

const stateLabel = (state: string, language: string): string => {
  const key = STATE_KEYS[state];
  return key === undefined ? state : messageFor(language, key);
};

const severityLabel = (severity: string, language: string): string => {
  const key = `alert.severity.${severity}` as MessageKey;
  return messageKeys.includes(key) ? messageFor(language, key) : severity;
};

/**
 * What to say about an advisory read, in the order the answers matter.
 *
 * A presentation-mode refusal comes first because it is the one case where a
 * reader pressed a control and the platform declined to act: that has to be said
 * rather than replaced by a summary of a regeneration that did not happen.
 */
const advisoryResultFor = (payload: AdvisoryPayload, regenerate: boolean): string | null => {
  if (payload.presentationRefusal !== null) {
    return payload.presentationRefusal;
  }
  if (!regenerate) {
    return null;
  }
  return `Asked the writer again for ${String(payload.attempted)} language(s) across ${String(payload.alerts.length)} alert(s): ${String(payload.written)} written, ${String(payload.refused)} refused.`;
};

const movesFor = (language: string): readonly { readonly to: string; readonly label: string }[] => [
  { to: 'acknowledged', label: messageFor(language, 'alert.acknowledge') },
  { to: 'escalated', label: messageFor(language, 'alert.escalate') },
  { to: 'action_proposed', label: messageFor(language, 'alert.propose') },
  { to: 'snoozed', label: messageFor(language, 'alert.snooze') },
  { to: 'resolved', label: messageFor(language, 'alert.resolve') },
];

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

const probability = (row: IntelligenceRow): string =>
  row.shortfallProbability === null
    ? 'no forecast'
    : `${percent(row.shortfallProbability)} in ${String(row.shortfallWindowDays ?? row.horizonDays)}d`;

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

/**
 * A count the provider never reported, said in words.
 *
 * Never `0`: a reader who sees a zero believes a measurement was taken. "Not
 * reported" is the true statement, and it is the difference between a panel that
 * is evidence and one that is a plausible guess.
 */
const countOr = (value: number | null): string =>
  value === null ? 'not reported' : formatCount(value);

const millisOr = (value: number | null): string =>
  value === null ? 'no request yet' : `${formatCount(value)} ms`;

export default function IntelligencePage() {
  const [payload, setPayload] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [advisories, setAdvisories] = useState<AdvisoryPayload | null>(null);
  const [advisoryResult, setAdvisoryResult] = useState<string | null>(null);
  const [advisoryBusy, setAdvisoryBusy] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryPayload | null>(null);
  const [language, setLanguage] = useState<string>('en');

  const load = useCallback(async (): Promise<void> => {
    try {
      // The interface language rides along with the inbox read rather than being
      // polled: it changes when a person changes it, and that reloads the page.
      const [response, languageResponse] = await Promise.all([
        fetch('/api/intelligence'),
        fetch('/api/language'),
      ]);
      if (!response.ok) {
        setError(`the platform answered ${String(response.status)}`);
        return;
      }
      setPayload((await response.json()) as IntelligencePayload);
      if (languageResponse.ok) {
        const chosen = (await languageResponse.json()) as { language?: string };
        setLanguage(chosen.language ?? 'en');
      }
      setError(null);
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the read failed');
    }
  }, []);

  /**
   * Ask for the advisory set once, and answer from the process afterwards.
   *
   * Deliberately not in the poll below. A read of this set is what makes the
   * platform write the bodies, and a five-second poll would turn a batch step
   * into a repeated one; the point of writing ahead of the burst is that the
   * second reader — and the five-second refresh — cost nothing.
   */
  const loadAdvisories = useCallback(async (regenerate = false): Promise<void> => {
    setAdvisoryBusy(true);
    try {
      const response = await fetch('/api/advisories', {
        method: regenerate ? 'POST' : 'GET',
        ...(regenerate
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ regenerate: true }),
            }
          : {}),
      });
      if (!response.ok) {
        setAdvisoryResult(`the advisory read answered ${String(response.status)}`);
        return;
      }
      const payload = (await response.json()) as AdvisoryPayload;
      setAdvisories(payload);
      // A refusal is a result: in presentation mode the answer is the sentence
      // saying which promise the platform is keeping, not a silent no-op.
      setAdvisoryResult(advisoryResultFor(payload, regenerate));
    } finally {
      setAdvisoryBusy(false);
    }
  }, []);

  /**
   * What the reasoning layer has been asked to do.
   *
   * Polled with the inbox, unlike the advisory set beside it: this read makes no
   * model call and writes nothing, so a five-second refresh costs a reader
   * nothing — and it is how the counts move visibly when somebody asks the writer
   * again on this same page.
   */
  const loadTelemetry = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/telemetry');
      if (!response.ok) {
        return;
      }
      setTelemetry((await response.json()) as TelemetryPayload);
    } catch {
      // A panel of counts is not worth an error banner over the inbox: the next
      // refresh either answers or does not.
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAdvisories();
    void loadTelemetry();
    const timer = setInterval(() => {
      void load();
      void loadTelemetry();
    }, REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load, loadAdvisories, loadTelemetry]);

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
      <PageHeader spacing="roomy" title="Poorvadarshan · Chetavani">
        <p className="text-sm text-ink-muted">
          {error === null
            ? 'Scoring the demonstration dataset — forecast, surge lift, nine drivers, alerts…'
            : `The intelligence read failed: ${error}`}
        </p>
      </PageHeader>
    );
  }

  const inbox = payload.alerts.filter((alert) => alert.state !== 'resolved');

  return (
    <div className="flex flex-col gap-12">
      <PageHeader label="Risk and forecasting" spacing="roomy" title="Poorvadarshan · Chetavani">
        <p className="max-w-measure text-sm text-ink-muted">
          What the platform expects to happen to each facility&apos;s stock, and what it is asking
          somebody to do about it. Every pair is scored from one run at one day, so two readers
          looking at the same district see the same figures.
        </p>
        <p className="text-xs text-ink-subtle">
          Every figure is derived from the generated dataset (`{payload.store.seed}`, scenario{' '}
          {payload.store.scenarioId}). The band is chosen from what was measured about the shelf;
          the item&apos;s essentiality and the district&apos;s population are shown beside it as
          context and never raise an alarm on their own. Refreshes every 5 seconds (polling, because
          the local adapter has no change feed). Last read {updatedAt}.
        </p>
      </PageHeader>

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
        eyebrow="Distribution"
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
        eyebrow="Chetavani"
        id="inbox"
        title="Alert inbox"
        description="Conditions that justify somebody acting today, each carrying the quantity that put it there. Acknowledging, escalating, proposing an action, snoozing or resolving an alert appends to its history with who did it, when, and why — and a move the model does not allow is refused rather than clamped."
      >
        {inbox.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="inbox-empty">
            Nothing in the inbox at this scoring day.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {inbox.map((alert) => (
              <li
                key={alert.id}
                aria-label={`Alert for ${alert.itemId} at ${alert.facilityId}`}
                data-testid={`alert-${alert.id}`}
                className={`rounded-card border border-l-2 border-hairline bg-paper-raised p-4 ${SEVERITY_RAIL[alert.severity] ?? 'border-l-hairline'}`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-signal-critical/40 bg-signal-critical/10 px-2.5 py-0.5 font-mono text-eyebrow text-signal-critical uppercase">
                    {severityLabel(alert.severity, language)}
                  </span>
                  <span className="rounded-full border border-hairline px-2.5 py-0.5 font-mono text-eyebrow text-ink-muted uppercase">
                    {stateLabel(alert.state, language)}
                  </span>
                  <span className="text-ink-subtle">
                    {formatDate(alert.raisedOn, language)} · condition {alert.dedupeKey}
                  </span>
                </div>

                <p className="mt-2 text-sm text-ink">{alert.bodies.en}</p>

                {/*
                 * Reading it aloud, which is how an alert reaches a health
                 * worker with their hands full. The body that is read is the
                 * record's own, in the reader's language — and where the record
                 * holds none, the control refuses and says so rather than
                 * reading the English one in a Hindi voice.
                 */}
                <SpeakButton alertId={alert.id} bodies={alert.bodies} language={language} />

                {alert.history.length === 0 ? null : (
                  <ol className="mt-3 flex flex-col gap-1 text-xs text-ink-muted">
                    {alert.history.map((move, index) => (
                      <li key={`${alert.id}:${String(index)}`}>
                        {move.from} → {move.to} · {move.actor} ({move.actorRole}) · {move.at} —{' '}
                        {move.reason}
                      </li>
                    ))}
                  </ol>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-ink-muted">
                    {messageFor(language, 'alert.reason')}
                    <input
                      aria-label={`Reason for ${alert.itemId}`}
                      className="w-64 min-h-11 rounded-card border border-hairline bg-paper px-2 py-1 text-sm text-ink"
                      onChange={(event) => {
                        setReasons((current) => ({ ...current, [alert.id]: event.target.value }));
                      }}
                      value={reasons[alert.id] ?? ''}
                    />
                  </label>
                  {movesFor(language).map((move_) => (
                    <button
                      key={move_.to}
                      aria-label={`${move_.label} ${alert.itemId}`}
                      className="inline-flex min-h-11 items-center rounded-full border-2 border-accent/40 bg-accent/10 px-3 text-xs text-accent transition-colors duration-150 hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-40"
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
        eyebrow="Writing"
        id="advisories"
        title="Advisory bodies, written ahead of the burst"
        description="An alert says a shelf is going to run out; it does not explain it, in the language the officer reads. These are the bodies a writer produced for the whole alert set, once, before anybody opened a row — and every language the alert record carries is named, whether or not prose exists for it, because a blank space where a body should be is the one thing a reader would take for agreement."
      >
        {advisories === null ? (
          <p className="text-sm text-ink-muted" data-testid="advisory-pending">
            {advisoryBusy
              ? 'Asking the writer for a body per language for the whole alert set…'
              : 'No advisory read has happened yet.'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {advisories.presentationMode ? (
              <p data-testid="advisory-presentation" className="text-sm text-accent">
                Presentation mode: the set was prepared ahead of the demonstration, and a click here
                will not start a model call.
              </p>
            ) : null}
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
              data-testid="advisory-summary"
            >
              <span>
                Writer <span className="font-mono text-accent">{advisories.provider}</span>
              </span>
              <span>
                languages the record carries{' '}
                <span className="font-mono">{String(advisories.languages.length)}</span>
              </span>
              <span>
                attempted <span className="font-mono">{String(advisories.attempted)}</span>
              </span>
              <span className="text-signal-ok">
                written <span className="font-mono">{String(advisories.written)}</span>
              </span>
              <span className="text-signal-watch">
                refused <span className="font-mono">{String(advisories.refused)}</span>
              </span>
              <span className="text-xs text-ink-subtle">
                {advisories.regenerated
                  ? `written by this read in ${String(advisories.generatedInMs)} ms, at ${advisories.generatedAt}`
                  : `answered from this process; the set was written at ${advisories.generatedAt}`}
              </span>
            </div>

            {advisories.languages.some((code) =>
              advisories.offered.every((offered) => offered.code !== code),
            ) ? (
              <p className="text-xs text-ink-subtle">
                An alert carries a language this build does not offer:{' '}
                {advisories.languages
                  .filter((code) => advisories.offered.every((offered) => offered.code !== code))
                  .join(', ')}
                . It is written for and named by its tag rather than being relabelled as English.
              </p>
            ) : null}

            <p className="text-xs text-ink-subtle">
              Offered and not carried by any alert yet:{' '}
              {advisories.offered
                .filter((offered) => !advisories.languages.includes(offered.code))
                .map((offered) => offered.label)
                .join(', ') || 'none — every offered language has a body'}
              . A reader of those languages is shown nothing until the alert record carries one,
              which is what adding a language to the alert template means.
            </p>

            <ul className="flex flex-col gap-3">
              {advisories.alerts.map((alert) => (
                <li
                  key={alert.alertId}
                  className="rounded-card border border-hairline bg-paper-raised p-3"
                  data-testid="advisory-alert"
                >
                  <p className="text-sm text-ink">
                    {alert.facilityName} · {alert.itemName} ·{' '}
                    <span className="text-signal-critical">
                      {' '}
                      {severityLabel(alert.severity, language)}
                    </span>{' '}
                    · raised {formatDate(alert.raisedOn, language)}
                  </p>

                  <ul className="mt-2 flex flex-col gap-2">
                    {alert.languages.map((language) => (
                      <li
                        key={`${alert.alertId}:${language.language}`}
                        className="rounded-card border border-hairline bg-paper/60 px-3 py-2"
                        data-language={language.language}
                        data-status={language.status}
                        data-testid="advisory-language"
                      >
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-ink-muted">{language.label}</span>
                          <span
                            className={
                              language.status === 'written'
                                ? 'rounded-card border border-signal-ok/40 bg-signal-ok/10 px-2 py-0.5 text-signal-ok'
                                : 'rounded-card border border-signal-watch/40 bg-signal-watch/10 px-2 py-0.5 text-signal-watch'
                            }
                            data-testid="advisory-status"
                          >
                            {language.status}
                          </span>
                          {language.model === null ? null : (
                            <span className="text-ink-subtle">
                              {language.model}
                              {language.cacheHit ? ' · from cache' : ''}
                            </span>
                          )}
                        </div>

                        {language.generated === null ? null : (
                          <div className="mt-2 flex flex-col gap-1">
                            <p className="text-sm text-ink">{language.generated}</p>
                            {language.actions.length === 0 ? null : (
                              <ul className="list-inside list-disc text-xs text-ink-muted">
                                {language.actions.map((action) => (
                                  <li key={action}>{action}</li>
                                ))}
                              </ul>
                            )}
                            <p className="text-xs text-ink-subtle">
                              cites {language.citations.join(', ')}
                            </p>
                          </div>
                        )}

                        <p className="mt-2 text-xs text-ink-muted">
                          In the record for this language:{' '}
                          <span className="text-ink-muted">
                            {language.inRecord ?? 'nothing — no body exists in this language yet'}
                          </span>
                        </p>

                        {language.refusal === null ? null : (
                          <p
                            className="mt-1 text-xs text-signal-watch"
                            data-testid="advisory-refusal"
                          >
                            No prose was written: {language.refusal}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-3">
              <button
                className="inline-flex min-h-11 items-center rounded-full border-2 border-accent/40 bg-accent/10 px-4 text-sm text-accent transition-colors duration-150 hover:bg-accent/20 disabled:pointer-events-none disabled:opacity-40"
                data-testid="advisory-regenerate"
                disabled={advisoryBusy}
                onClick={() => {
                  void loadAdvisories(true);
                }}
                type="button"
              >
                Ask the writer again
              </button>
              <span className="text-xs text-ink-subtle">
                A refusal is a result, not a failure: with no reasoning provider configured every
                language above refuses, and the alert keeps the body it was raised with rather than
                losing it to a writer that could not improve it. No numeral in a generated body may
                come from anywhere but the alert's own facts.
              </span>
            </div>

            {advisoryResult === null ? null : (
              <p className="text-sm text-accent" data-testid="advisory-result">
                {advisoryResult}
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        eyebrow="Cost"
        id="telemetry"
        title="What the reasoning layer has been asked to do"
        description="Counted at the call by the adapter itself, for this process: requests, attempts against the model, answers served from cache, refusals, tokens and time spent waiting. The ceiling here is a free tier and a per-day rate limit, so the figures are the platform's own account of what it spent rather than an estimate from document counts. The adapter is named beside them, because the same panel under a replay adapter is not a measurement of a model."
      >
        {telemetry === null ? (
          <p className="text-sm text-ink-muted" data-testid="telemetry-pending">
            No telemetry read has happened yet.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
              data-testid="telemetry-provider"
              data-provider={telemetry.provider}
              data-reported={telemetry.reported ? 'yes' : 'no'}
            >
              <span>
                Adapter <span className="font-mono text-accent">{telemetry.provider}</span>
              </span>
              <span data-testid="telemetry-model">
                {telemetry.model === null
                  ? 'sends nowhere — it replays recorded answers'
                  : `model ${telemetry.model}`}
              </span>
              <span className="text-xs text-ink-subtle">
                snapshot taken {telemetry.readAt}, refreshed with the inbox every 5 seconds
              </span>
            </div>

            {telemetry.reported ? (
              <>
                <div
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted"
                  data-testid="telemetry-totals"
                >
                  <span>
                    calls <span className="font-mono">{formatCount(telemetry.calls)}</span>
                  </span>
                  <span>
                    attempts <span className="font-mono">{formatCount(telemetry.attempts)}</span>
                  </span>
                  <span>
                    from cache <span className="font-mono">{formatCount(telemetry.cacheHits)}</span>
                  </span>
                  <span className="text-signal-watch">
                    refused <span className="font-mono">{formatCount(telemetry.failures)}</span>
                  </span>
                  <span>
                    tokens in <span className="font-mono">{countOr(telemetry.inputTokens)}</span> ·
                    out <span className="font-mono">{countOr(telemetry.outputTokens)}</span>
                  </span>
                  <span>
                    mean per request{' '}
                    <span className="font-mono">{millisOr(telemetry.meanRequestMs)}</span>
                  </span>
                </div>

                {telemetry.perTask.length === 0 ? (
                  <p className="text-sm text-ink-muted" data-testid="telemetry-none">
                    Nothing has been asked of a model in this process yet, so there is nothing to
                    attribute. A panel of zeros here would be a claim; this is not one.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-card border border-hairline">
                    <table className="w-full border-collapse text-sm">
                      <caption className="sr-only">
                        Requests made, per task, with attempts, refusals and time
                      </caption>
                      <thead>
                        <tr className="border-b border-hairline bg-paper-raised text-left">
                          <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                            Task
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Calls
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Attempts
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Cache
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Refused
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Tokens in / out
                          </th>
                          <th
                            scope="col"
                            className="px-4 py-2 text-right font-medium text-ink-muted"
                          >
                            Mean
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-hairline/70">
                        {telemetry.perTask.map((task) => (
                          <tr key={task.task} data-task={task.task} data-testid="telemetry-task">
                            <td className="px-4 py-2 font-mono text-ink">{task.task}</td>
                            <td className="px-4 py-2 text-right font-mono text-ink-muted">
                              {formatCount(task.calls)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-ink-muted">
                              {formatCount(task.attempts)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-ink-muted">
                              {formatCount(task.cacheHits)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-signal-watch">
                              {formatCount(task.failures)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-ink-muted">
                              {countOr(task.inputTokens)} / {countOr(task.outputTokens)}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-ink-muted">
                              {millisOr(task.meanRequestMs)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-signal-watch" data-testid="telemetry-unavailable">
                This adapter keeps no count of what it has been asked, so there is nothing to show —
                which is not the same as nothing having happened, and is precisely why the panel
                says it rather than drawing a zero.
              </p>
            )}

            <div
              className="rounded-card border border-hairline bg-paper-raised px-3 py-2 text-sm text-ink-muted"
              data-testid="telemetry-projection"
            >
              <p>
                A full advisory pass for this inbox is{' '}
                <span className="font-mono text-accent">
                  {formatCount(telemetry.projection.advisoryPass)}
                </span>{' '}
                request(s) — {formatCount(telemetry.projection.alerts)} alert(s) in{' '}
                {formatCount(telemetry.projection.languages)} language(s), one request per body. It
                is paid once per process rather than once per reader, which is what writing the
                bodies ahead of the burst buys: one pass a day is{' '}
                {formatCount(telemetry.projection.advisoryPass)} requests a day for the
                demonstration profile.
              </p>
              <p className="mt-1 text-xs text-ink-subtle">
                A photograph and a recording are {formatCount(telemetry.projection.perCapture)}{' '}
                request each — a capture is one request, and a retry that actually happened is
                counted in the attempts above rather than estimated here. People take photographs
                and speak recordings, so no per-day figure for those could be honest; the advisory
                pass is the clock-driven one. This projection is arithmetic over the current inbox,
                not a measurement — the counters above are the measurement.
              </p>
            </div>

            {telemetry.provider === 'fixture' ? (
              <p className="text-xs text-signal-watch" data-testid="telemetry-caveat">
                These counters describe this process under a replay adapter: every request was
                answered from a recording, nothing was sent anywhere, so attempts stays at zero
                while calls climbs and no tokens are reported. They are true about this process and
                they are not a measurement of a model — which is exactly why the adapter is named
                beside them. Configure a live provider and the same panel becomes that
                provider&apos;s account of itself.
              </p>
            ) : (
              <p className="text-xs text-ink-subtle" data-testid="telemetry-caveat">
                A refusal is counted here as a failure, and a retry as an extra attempt against the
                model: neither is hidden, because a count that only rose on success would make a
                quota problem invisible until it became an outage. No numeral from this panel
                reaches a record.
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        eyebrow="Poorvadarshan"
        id="ranked"
        title="Risk-ranked list"
        description="Every scored pair, worst first, with the driver contributions behind the order. The index ranks and bands; it is not a probability, which is why the forecast's own measured probability and the window it was measured over are shown beside it."
      >
        <div className="overflow-x-auto rounded-card border border-hairline">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Facility-item pairs ranked by stock-out risk, with drivers
            </caption>
            <thead>
              <tr className="border-b border-hairline bg-paper-raised text-left">
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Band
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Facility · item
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium text-ink-muted">
                  Index
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Measured shortfall
                </th>
                <th scope="col" className="px-4 py-2 font-medium text-ink-muted">
                  Why
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline/70">
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
                  <td className="px-4 py-2 text-ink-muted">
                    <span className="block text-ink">{row.itemName}</span>
                    <span className="text-xs text-ink-subtle">
                      {row.facilityName} · {row.districtName} · {row.essentiality}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-ink">
                    {row.riskIndex.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 font-mono text-ink-muted">{probability(row)}</td>
                  <td className="px-4 py-2 text-ink-muted">
                    <details>
                      <summary className="cursor-pointer text-xs text-accent">
                        Nine drivers
                        <span className="ml-2 text-ink-subtle">
                          {row.drivers[0]?.driver ?? 'none'} first
                        </span>
                      </summary>
                      <ul className="mt-2 flex flex-col gap-1 text-xs">
                        {row.drivers.map((driver) => (
                          <li key={driver.driver} className="flex gap-2">
                            <span className="w-10 shrink-0 text-right font-mono text-ink-muted">
                              {signed(driver.contribution)}
                            </span>
                            <span className="text-ink-muted">
                              <span className="font-medium text-ink">{driver.driver}</span> —{' '}
                              {driver.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {row.missing.length === 0 ? null : (
                        <p className="mt-2 text-xs text-signal-watch">
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
        eyebrow="Signals"
        id="events"
        title="Epidemic signals"
        description="Syndromic series whose level moved beyond the facility's own seasonal and weekly pattern, with the growth rate a decision is made on. A signal lifts the forecast for every item that treats the syndrome."
      >
        {payload.events.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="events-empty">
            No epidemic signal was detected in this scoring run. A quiet year is a result.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {payload.events.map((event) => (
              <li
                key={event.id}
                className="rounded-card border border-hairline bg-paper-raised p-4 text-sm"
              >
                <p className="text-ink">
                  {event.syndrome} · {event.facilityName} · {event.districtName}
                </p>
                <p className="mt-1 text-xs text-ink-muted">
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
