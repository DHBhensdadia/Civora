'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { CONTROL_QUIET, DataTable, Notice, Panel, StatCard, formatCount } from '@/components/ui';

/**
 * The audit trail, and the walk that decides whether it holds.
 *
 * A chain is a claim about its own past, so this page is arranged around the one
 * question a reader has: *does it still hold?* The verification is printed first
 * and names the entry where it stops, if it stops anywhere — and it is printed
 * for the whole chain even when the rows below are filtered down to one actor,
 * because a trail that held only inside the rows a reader asked for would be a
 * trail that can be broken anywhere else.
 *
 * The rows are what a reader came for: who decided, in what capacity, at what
 * moment, on what grounds, and what changed. Two things are shown that turn a log
 * into evidence — `before → after`, so an adjustment says what the count was and
 * what it became rather than only that something moved; and the identifier of the
 * entry each one chains to, which is the artefact the digest commits to rather
 * than the row above it in a filtered list.
 *
 * The panel at the foot is the boundary of the surface. It lists every action the
 * platform is built to record, and which of them have entries here, so a reader
 * can see what the trail would hold rather than only what it happens to hold
 * today — and can tell a quiet day apart from an unplugged recorder.
 *
 * Today's chain is written by this process as decisions are taken, which is why
 * it can be short when a reader arrives first thing: the registry below is the
 * part that does not depend on who has clicked what.
 */

interface TrailRow {
  readonly id: string;
  readonly occurredAt: string;
  readonly day: string;
  readonly actorUid: string;
  readonly actorRole: string;
  readonly action: string;
  readonly meaning: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly hash: string;
  readonly linksTo: string | null;
}

interface Trail {
  readonly report: {
    readonly events: number;
    readonly valid: boolean;
    readonly brokenAt: string | null;
    readonly detail: string;
  };
  readonly checkedAt: string;
  readonly rows: readonly TrailRow[];
  readonly matched: number;
  readonly total: number;
  readonly shown: number;
  readonly filters: {
    readonly actor: string | null;
    readonly action: string | null;
    readonly subject: string | null;
    readonly from: string | null;
    readonly to: string | null;
  };
  readonly offers: {
    readonly actors: readonly string[];
    readonly actions: readonly string[];
    readonly subjects: readonly string[];
  };
  readonly registered: readonly {
    readonly action: string;
    readonly detail: string;
    readonly recorded: number;
  }[];
}

type Filters = Trail['filters'];

const NO_FILTERS: Filters = {
  actor: null,
  action: null,
  subject: null,
  from: null,
  to: null,
};

const queryOf = (filters: Filters): string => {
  const params = new URLSearchParams();
  for (const key of ['actor', 'action', 'subject', 'from', 'to'] as const) {
    const value = filters[key];
    if (value !== null && value !== '') {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
};

/** A count with the word it counts, because "1 entries" is a bug a reader sees. */
const counted = (count: number, singular: string, plural = `${singular}s`): string =>
  `${formatCount(count)} ${count === 1 ? singular : plural}`;

function FilterField({
  name,
  label,
  value,
  onChange,
  options,
}: {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-muted">
      <span>{label}</span>
      <select
        name={name}
        aria-label={label}
        className="min-h-11 rounded-card border border-hairline bg-paper-raised px-2 py-1 font-mono text-xs text-ink"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function AuditPage() {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [nonce, setNonce] = useState(0);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [walking, setWalking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setWalking(true);

    fetch(`/api/audit${queryOf(applied)}`)
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          const detail =
            typeof body === 'object' && body !== null && 'detail' in body
              ? String(body.detail)
              : `the audit read answered ${String(response.status)}`;
          throw new Error(detail);
        }
        return (body as { trail: Trail }).trail;
      })
      .then((body) => {
        if (!cancelled) {
          setTrail(body);
          setRefusal(null);
          setWalking(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          // A refusal and a failure are the same shape here, deliberately: the
          // route answers a session it will not serve with a sentence, and the
          // page shows that sentence rather than an empty table that would read
          // as a chain with nothing in it.
          setRefusal(reason instanceof Error ? reason.message : String(reason));
          setTrail(null);
          setWalking(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applied, nonce]);

  const verifiedAt = useMemo(
    () =>
      trail === null
        ? null
        : new Date(trail.checkedAt).toISOString().replace('T', ' ').slice(0, 19),
    [trail],
  );

  const apply = useCallback(() => {
    setApplied(draft);
  }, [draft]);

  if (refusal !== null) {
    return (
      <div className="flex flex-col gap-20">
        <Notice
          id="audit-refusal"
          testId="audit-refusal"
          tone="warning"
          title="This session is not shown the chain"
        >
          <p data-testid="audit-refusal-detail">{refusal}</p>
          <p>
            The same rule is enforced on the stored collection, so the refusal is not a matter of
            what the interface chose to draw.
          </p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-20">
      <PageHeader
        layout="split"
        label="Assurance · audit trail"
        title="What was decided, and whether it holds"
      >
        <p className="text-lead text-ink-muted">
          Every consequential act appends an entry carrying the digest of the entry before it.
          Altering one, removing one or reordering two breaks the chain at the point of the change —
          which is what makes this record evidence rather than a log of claims.
        </p>
      </PageHeader>

      <Panel
        id="verification"
        title="Verification"
        description="Recomputed from the entries themselves: every digest is re-derived and every link checked, over the whole chain rather than the rows below. The verification is an act, so it says when it was made."
      >
        {trail === null ? (
          <p className="text-sm text-ink-muted" data-testid="audit-walking">
            {walking ? 'Walking the chain…' : 'Reading the chain…'}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-5 sm:grid-cols-4">
              <StatCard
                label="result"
                value={trail.report.valid ? 'holds' : 'broken'}
                hint={
                  trail.report.valid ? 'no entry fails its own digest' : 'see the entry named below'
                }
              />
              <StatCard label="entries walked" value={formatCount(trail.report.events)} />
              <StatCard
                label="first break"
                value={trail.report.brokenAt ?? 'none'}
                hint={
                  trail.report.brokenAt === null
                    ? 'nothing to name'
                    : 'the trail stops holding here'
                }
              />
              <StatCard label="checked at" value={verifiedAt ?? '—'} hint="server clock, UTC" />
            </div>

            <p
              data-testid="audit-report"
              data-valid={trail.report.valid ? 'true' : 'false'}
              className={
                trail.report.valid
                  ? 'rounded-card bg-mint/40 px-4 py-3 text-sm text-ink'
                  : 'rounded-card bg-coral/45 px-4 py-3 text-sm text-ink'
              }
            >
              {trail.report.detail}
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="audit-verify"
                className={CONTROL_QUIET}
                onClick={() => {
                  setNonce((current) => current + 1);
                }}
              >
                Walk the chain again
              </button>
              <span className="text-xs text-ink-subtle">
                {walking ? 'walking…' : 'the walk is repeated on every read, filters or not'}
              </span>
            </div>
          </div>
        )}
      </Panel>

      <Panel
        id="filters"
        title="The question being asked"
        description="Actor, action, subject and a day range. The offers are read off the chain itself, so a filter cannot name a value that no entry holds — except the days, which are typed, because a reader asking about a quiet week should be told it was quiet rather than shown an empty list of options."
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <FilterField
            name="actor"
            label="actor"
            value={draft.actor ?? ''}
            options={trail?.offers.actors ?? []}
            onChange={(value) => {
              setDraft((current) => ({ ...current, actor: value === '' ? null : value }));
            }}
          />
          <FilterField
            name="action"
            label="action"
            value={draft.action ?? ''}
            options={trail?.offers.actions ?? []}
            onChange={(value) => {
              setDraft((current) => ({ ...current, action: value === '' ? null : value }));
            }}
          />
          <FilterField
            name="subject"
            label="subject"
            value={draft.subject ?? ''}
            options={trail?.offers.subjects ?? []}
            onChange={(value) => {
              setDraft((current) => ({ ...current, subject: value === '' ? null : value }));
            }}
          />
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            <span>from</span>
            <input
              type="date"
              name="from"
              aria-label="from"
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-2 py-1 font-mono text-xs text-ink"
              value={draft.from ?? ''}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  from: event.target.value === '' ? null : event.target.value,
                }));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-muted">
            <span>to</span>
            <input
              type="date"
              name="to"
              aria-label="to"
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-2 py-1 font-mono text-xs text-ink"
              value={draft.to ?? ''}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  to: event.target.value === '' ? null : event.target.value,
                }));
              }}
            />
          </label>
          <button type="submit" data-testid="audit-apply" className={CONTROL_QUIET}>
            Apply
          </button>
          <button
            type="button"
            data-testid="audit-clear"
            className={CONTROL_QUIET}
            onClick={() => {
              setDraft(NO_FILTERS);
              setApplied(NO_FILTERS);
            }}
          >
            Clear
          </button>
        </form>

        <p className="text-sm text-ink-muted" data-testid="audit-count">
          {trail === null
            ? 'reading…'
            : `showing ${counted(trail.shown, 'entry', 'entries')} of ${counted(
                trail.matched,
                'matching entry',
                'matching entries',
              )} in a chain of ${counted(trail.total, 'entry', 'entries')}`}
          {trail !== null && trail.matched > trail.shown
            ? ` — the newest ${String(trail.shown)} are shown`
            : ''}
        </p>
      </Panel>

      <Panel
        id="entries"
        title="The entries"
        description="Newest first. Each row names the entry it chains to, which is the link the digest covers — not the row above it in a filtered list."
      >
        {trail === null ? (
          <p className="text-sm text-ink-muted">Reading…</p>
        ) : trail.rows.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="audit-empty">
            {trail.total === 0
              ? 'Nothing consequential has been decided in this process yet. The chain is written as decisions are taken — a capture, an alert move, a transfer decision, the federated rounds — so an empty trail here is a platform nobody has acted on yet rather than a recorder that is switched off.'
              : `No entry matches that question. The chain holds ${counted(
                  trail.total,
                  'entry',
                  'entries',
                )} in this process, so this is a filter with nothing behind it rather than a trail that failed to load.`}
          </p>
        ) : (
          <div data-testid="audit-rows">
            <DataTable
              caption="Consequential entries, newest first"
              columns={[
                { header: 'when' },
                { header: 'who' },
                { header: 'what' },
                { header: 'subject' },
                { header: 'before → after' },
                { header: 'why' },
                { header: 'links to' },
              ]}
              rows={trail.rows.map((row) => [
                <span key={`${row.id}-when`} className="font-mono text-xs">
                  {row.day}
                  <br />
                  <span className="text-ink-subtle">{row.occurredAt.slice(11, 19)}</span>
                </span>,
                <span key={`${row.id}-who`} className="text-xs">
                  {row.actorUid}
                  <br />
                  <span className="text-ink-subtle">{row.actorRole}</span>
                </span>,
                <span key={`${row.id}-what`} className="text-xs">
                  <span className="font-mono">{row.action}</span>
                  {row.meaning === null ? null : (
                    <span className="block text-ink-subtle">{row.meaning}</span>
                  )}
                </span>,
                <span key={`${row.id}-subject`} className="text-xs">
                  <span className="font-mono">{row.subjectType}</span>
                  <br />
                  <span className="text-ink-subtle">{row.subjectId}</span>
                </span>,
                <span key={`${row.id}-pair`} className="font-mono text-xs">
                  {row.before === null && row.after === null
                    ? '—'
                    : `${row.before ?? '—'} → ${row.after ?? '—'}`}
                </span>,
                <span key={`${row.id}-why`} className="text-xs text-ink-muted">
                  {row.reason ?? '—'}
                </span>,
                <span key={`${row.id}-link`} className="font-mono text-xs">
                  {row.id}
                  <br />
                  <span className="text-ink-subtle">→ {row.linksTo ?? 'start of chain'}</span>
                </span>,
              ])}
            />
          </div>
        )}
      </Panel>

      <Panel
        id="registry"
        title="What this platform records"
        description="The actions the code is built to write into the chain, and how many entries each has here. An action with none is a path that has not been taken in this process — not a decision that was quietly skipped: the registry is asserted by test against the files that perform each one."
      >
        <DataTable
          caption="Registered actions and their entries"
          columns={[
            { header: 'action' },
            { header: 'what it means' },
            { header: 'entries', numeric: true },
          ]}
          rows={(trail?.registered ?? []).map((entry) => [
            <span key={entry.action} className="font-mono text-xs">
              {entry.action}
            </span>,
            entry.detail,
            formatCount(entry.recorded),
          ])}
        />
        <p className="text-xs text-ink-subtle">
          Not recorded, deliberately: a refused action (nothing changed), a replay or duplicate
          submission (nothing was written), a read of any surface, a conflict (it is written to its
          own collection and changes no observation), and the platform&rsquo;s own recomputations —
          scores, forecasts, advisories — which are arithmetic rather than a person&rsquo;s
          decision.
        </p>
      </Panel>
    </div>
  );
}
