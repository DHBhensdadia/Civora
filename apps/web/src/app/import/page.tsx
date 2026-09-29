'use client';

import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { DataTable, Notice, Panel, StatCard, formatCount } from '@/components/ui';

/**
 * Handing the platform a file a ministry already produces.
 *
 * The page is a two-step, and the order is the point: **check the file**, read
 * what the platform would do with it — row by row, including the rows it refuses
 * and the sentence it refuses them with — and only then accept it. A flow that
 * imported first and reported afterwards would make the check decorative, and the
 * phase's own requirement is the opposite one.
 *
 * The demonstration samples are files in the repository rather than text pasted
 * into this page, because the thing being demonstrated is that a *file* a
 * department produces can be read: `samples/hmis-monthly-sample.csv` is a monthly
 * stock statement in the shape the returns take, and
 * `samples/hmis-monthly-broken.csv` is the same statement with a receipt that
 * names no batch — the ordinary way one of these files arrives damaged, and one
 * this platform refuses rather than completing on the facility's behalf.
 *
 * Nothing here claims the file is real. The register records what the file states
 * about itself, and every row it writes carries the source it arrived from, so a
 * reader of the ledger can tell an import from a nurse's capture without asking.
 */

interface ImportRow {
  readonly index: number;
  readonly subjectId: string;
  readonly facilityId: string | null;
  readonly outcome: 'write' | 'already-held' | 'refused';
  readonly detail: string;
}

interface Preview {
  readonly format: string;
  readonly fileName: string;
  readonly digest: string;
  readonly sourceId: string | null;
  readonly title: string | null;
  readonly retrievedOn: string | null;
  readonly rowsRead: number;
  readonly counts: {
    readonly write: number;
    readonly alreadyHeld: number;
    readonly refused: number;
  };
  readonly rows: readonly ImportRow[];
  readonly crosswalk: {
    readonly matched: number;
    readonly unmatchedGovernment: readonly string[];
    readonly unmatchedPlatform: readonly string[];
  } | null;
  readonly notes: readonly string[];
}

interface ImportRecordView {
  readonly id: string;
  readonly format: string;
  readonly fileName: string;
  readonly digest: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsAlreadyHeld: number;
  readonly rowsRejected: number;
  readonly actorUid: string;
  readonly acceptedAt: string;
}

interface Outcome {
  readonly wrote: boolean;
  readonly auditId: string | null;
  readonly record: ImportRecordView;
}

const FORMATS = [
  {
    format: 'hmis-csv',
    label: 'HMIS monthly stock statement (CSV)',
    sample: '/samples/hmis-monthly-sample.csv',
    broken: '/samples/hmis-monthly-broken.csv',
  },
  {
    format: 'lgd-json',
    label: 'Local Government Directory extract (JSON)',
    sample: null,
    broken: null,
  },
] as const;

const OUTCOME_LABEL: Readonly<Record<ImportRow['outcome'], string>> = {
  write: 'would be written',
  'already-held': 'already held',
  refused: 'refused',
};

export default function ImportPage() {
  const [format, setFormat] = useState<string>('hmis-csv');
  const [fileName, setFileName] = useState('hmis-monthly-sample.csv');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [imports, setImports] = useState<readonly ImportRecordView[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshImports = useCallback(async () => {
    const response = await fetch('/api/import');
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { readonly imports: readonly ImportRecordView[] };
    setImports(body.imports);
  }, []);

  useEffect(() => {
    void refreshImports();
  }, [refreshImports]);

  const loadSample = useCallback(async (path: string) => {
    const response = await fetch(path);
    const body = await response.text();
    setText(body);
    setFileName(path.split('/').at(-1) ?? 'extract.csv');
    setPreview(null);
    setOutcome(null);
    setRefusal(null);
  }, []);

  const submit = useCallback(
    async (method: 'POST' | 'PUT') => {
      setBusy(true);
      try {
        const response = await fetch('/api/import', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format, fileName, text }),
        });
        const body = (await response.json()) as {
          readonly outcome?: string;
          readonly detail?: string;
          readonly preview?: Preview;
          readonly record?: ImportRecordView;
          readonly wrote?: boolean;
          readonly auditId?: string | null;
        };

        if (!response.ok) {
          setRefusal(body.detail ?? `the import read answered ${String(response.status)}`);
          setPreview(null);
          setOutcome(null);
          return;
        }

        setRefusal(null);
        setPreview(body.preview ?? null);
        if (method === 'PUT' && body.record !== undefined) {
          setOutcome({
            wrote: body.wrote === true,
            auditId: body.auditId ?? null,
            record: body.record,
          });
          await refreshImports();
        } else {
          setOutcome(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [format, fileName, text, refreshImports],
  );

  const chosen = FORMATS.find((entry) => entry.format === format) ?? FORMATS[0];

  return (
    <div className="flex flex-col gap-12">
      <PageHeader label="Interoperability · import" title="Bring a file the ministry already has">
        <p className="max-w-measure text-lg text-fg-muted">
          A department does not adopt a platform by retyping its returns. This surface reads an
          extract of a system the ministry already runs, shows exactly what it would write before
          anything is written, and then writes it — through the same ingest boundary and the same
          audit chain a nurse&rsquo;s phone uses.
        </p>
      </PageHeader>

      <Panel
        id="file"
        title="The file"
        description="A demonstration sample, or a file of your own pasted in. The digest is what identifies the file: the same bytes imported again is the same import, and the rows are answered rather than written twice."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              <span>format</span>
              <select
                className="min-h-11 rounded-instrument border border-ink-600 bg-ink-900 px-2 py-1 text-sm text-fg"
                value={format}
                onChange={(event) => {
                  setFormat(event.target.value);
                  setPreview(null);
                  setOutcome(null);
                  setRefusal(null);
                }}
              >
                {FORMATS.map((entry) => (
                  <option key={entry.format} value={entry.format}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            {chosen.sample === null ? null : (
              <button
                type="button"
                data-testid="import-sample"
                className="min-h-11 rounded-instrument border border-ink-600 bg-ink-900 px-3 py-1 text-sm text-fg hover:border-accent/40"
                onClick={() => {
                  void loadSample(chosen.sample);
                }}
              >
                Use the sample statement
              </button>
            )}
            {chosen.broken === null ? null : (
              <button
                type="button"
                data-testid="import-broken"
                className="rounded px-3 py-1 text-sm text-fg-muted hover:text-fg"
                onClick={() => {
                  void loadSample(chosen.broken);
                }}
              >
                Use the damaged one
              </button>
            )}
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              <span>file name</span>
              <input
                className="min-h-11 rounded-instrument border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-xs text-fg"
                value={fileName}
                onChange={(event) => {
                  setFileName(event.target.value);
                }}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            <span>the file&rsquo;s text</span>
            <textarea
              data-testid="import-text"
              className="h-48 w-full min-h-11 rounded-instrument border border-ink-600 bg-ink-950 p-3 font-mono text-xs text-fg"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setPreview(null);
                setOutcome(null);
              }}
            />
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="import-check"
              disabled={text.trim() === '' || busy}
              className="inline-flex min-h-11 items-center rounded-full border-2 border-accent/40 bg-accent/10 px-4 text-sm text-accent transition-colors duration-150 hover:bg-accent/25 disabled:pointer-events-none disabled:opacity-40"
              onClick={() => {
                void submit('POST');
              }}
            >
              Check the file
            </button>
            <button
              type="button"
              data-testid="import-accept"
              disabled={text.trim() === '' || busy || preview === null}
              className="rounded-instrument border border-signal-ok/40 bg-signal-ok/10 px-3 py-1 text-sm text-signal-ok hover:bg-signal-ok/20 disabled:opacity-40"
              onClick={() => {
                void submit('PUT');
              }}
            >
              Accept the file
            </button>
            <span className="text-xs text-fg-subtle">
              {busy ? 'working…' : 'checking writes nothing; accepting is a separate act'}
            </span>
          </div>
        </div>
      </Panel>

      {refusal === null ? null : (
        <Notice id="refusal" testId="import-refusal" tone="warning" title="The file was not read">
          <p data-testid="import-refusal-detail">{refusal}</p>
          <p>
            No partial import follows: a file this platform cannot read in full is a file whose
            missing rows nobody could account for afterwards.
          </p>
        </Notice>
      )}

      {preview === null ? null : (
        <Panel
          id="check"
          title="What the file would do"
          description="Read from the file's own rows, decided against what the ledger already holds. The counts are what a reader can check; the table names the rows and the platform’s sentence for each."
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="rows in the file" value={formatCount(preview.rowsRead)} />
              <StatCard
                label={outcome === null ? 'would be written' : 'written'}
                value={formatCount(preview.counts.write)}
                hint="each carries the source `import`"
              />
              <StatCard
                label="already held"
                value={formatCount(preview.counts.alreadyHeld)}
                hint="answered, not written twice"
              />
              <StatCard
                label="refused"
                value={formatCount(preview.counts.refused)}
                hint="named below"
              />
            </div>

            <p className="font-mono text-xs text-fg-subtle">
              {preview.fileName} · {preview.format} · sha256 {preview.digest.slice(0, 16)}…
              {preview.title === null ? '' : ` · ${preview.title}`}
              {preview.retrievedOn === null ? '' : ` · retrieved ${preview.retrievedOn}`}
            </p>

            {preview.crosswalk === null ? null : (
              <div className="rounded-instrument border border-ink-700 bg-ink-900 p-4 text-sm text-fg-muted">
                <p>
                  {formatCount(preview.crosswalk.matched)} of this platform&rsquo;s districts were
                  given a government code.
                </p>
                {preview.crosswalk.unmatchedPlatform.length === 0 ? null : (
                  <p className="mt-2 text-fg-muted">
                    No government unit matched {preview.crosswalk.unmatchedPlatform.join(', ')} — a
                    renamed district is reported rather than guessed at.
                  </p>
                )}
                {preview.crosswalk.unmatchedGovernment.length === 0 ? null : (
                  <p className="mt-2 text-fg-muted">
                    The directory names {preview.crosswalk.unmatchedGovernment.join(', ')}, which
                    this platform has no district for.
                  </p>
                )}
              </div>
            )}

            <div data-testid="import-rows">
              <DataTable
                caption="What the file's rows would do, in file order"
                columns={[
                  { header: 'line' },
                  { header: 'row' },
                  { header: 'facility' },
                  { header: 'outcome' },
                  { header: 'what the platform says' },
                ]}
                rows={preview.rows.slice(0, 50).map((row) => [
                  String(row.index + 2),
                  <span key={`${row.subjectId}-id`} className="font-mono text-xs">
                    {row.subjectId}
                  </span>,
                  <span key={`${row.subjectId}-facility`} className="font-mono text-xs">
                    {row.facilityId ?? '—'}
                  </span>,
                  <span
                    key={`${row.subjectId}-outcome`}
                    className={row.outcome === 'refused' ? 'text-signal-critical' : 'text-fg'}
                  >
                    {OUTCOME_LABEL[row.outcome]}
                  </span>,
                  <span key={`${row.subjectId}-detail`} className="text-xs text-fg-muted">
                    {row.detail}
                  </span>,
                ])}
              />
            </div>
            {preview.rows.length > 50 ? (
              <p className="text-xs text-fg-subtle">
                Showing the first fifty of {formatCount(preview.rows.length)} rows.
              </p>
            ) : null}

            {preview.notes.length === 0 ? null : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-xs text-fg-muted">
                {preview.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}

      {outcome === null ? null : (
        <Notice
          id="accepted"
          testId="import-accepted"
          tone="info"
          title={outcome.wrote ? 'The file was accepted' : 'Nothing changed'}
        >
          <p data-testid="import-accepted-detail">
            {outcome.record.fileName} · {formatCount(outcome.record.rowsWritten)} written ·{' '}
            {formatCount(outcome.record.rowsAlreadyHeld)} already held ·{' '}
            {formatCount(outcome.record.rowsRejected)} refused
          </p>
          <p>
            {outcome.wrote
              ? `The chain recorded it as ${outcome.auditId ?? 'an import'} — the ledger says where each row came from, and the trail says who accepted the file.`
              : 'Every row in this file was already in the ledger, so nothing was written and the chain recorded nothing: it keeps what changed.'}
          </p>
        </Notice>
      )}

      <Panel
        id="register"
        title="Files accepted"
        description="Every file the platform has taken, with what it wrote. The register exists so a ledger row can be traced to the file it arrived in without keeping the file itself."
      >
        {imports.length === 0 ? (
          <p className="text-sm text-fg-muted" data-testid="import-register-empty">
            No file has been accepted in this process yet.
          </p>
        ) : (
          <div data-testid="import-register">
            <DataTable
              caption="Accepted imports"
              columns={[
                { header: 'accepted at' },
                { header: 'file' },
                { header: 'format' },
                { header: 'read', numeric: true },
                { header: 'written', numeric: true },
                { header: 'held', numeric: true },
                { header: 'refused', numeric: true },
                { header: 'by' },
              ]}
              rows={imports.map((record) => [
                <span key={`${record.id}-at`} className="font-mono text-xs">
                  {record.acceptedAt.replace('T', ' ').slice(0, 19)}
                </span>,
                <span key={`${record.id}-name`} className="text-xs">
                  {record.fileName}
                  <br />
                  <span className="font-mono text-fg-subtle">{record.digest.slice(0, 12)}</span>
                </span>,
                <span key={`${record.id}-format`} className="font-mono text-xs">
                  {record.format}
                </span>,
                formatCount(record.rowsRead),
                formatCount(record.rowsWritten),
                formatCount(record.rowsAlreadyHeld),
                formatCount(record.rowsRejected),
                <span key={`${record.id}-by`} className="text-xs">
                  {record.actorUid}
                </span>,
              ])}
            />
          </div>
        )}
      </Panel>
    </div>
  );
}
