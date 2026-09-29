'use client';

import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { CONTROL_PRIMARY, CONTROL_QUIET, FIELD, Notice, Panel, formatCount } from '@/components/ui';

/**
 * Read a paper register.
 *
 * The premise of the platform is that most facilities still record stock on
 * paper, and the people recording it are not going to be retrained. A camera is
 * the only input that changes that without changing them — so this screen turns a
 * photograph into ledger lines, and then says plainly which of those lines the
 * platform was willing to write on its own.
 *
 * Three things it refuses to hide:
 *
 *  - **Which reader is behind it.** The configured provider is named, and when
 *    none is configured the screen says so rather than appearing to work. A
 *    reading can also be supplied through the same endpoint, and the queue says
 *    when that is what happened: a surface that made a supplied reading look like
 *    a model's would be the exact confusion this project exists to avoid.
 *  - **What the threshold is.** It is on the screen, not in a document.
 *  - **Why a line is waiting.** Every held line carries its reasons, and the
 *    catalogue entries it could have meant, so the decision a person makes is an
 *    informed one rather than a click.
 *
 * Nothing here writes to the ledger by itself: the accept button is a decision
 * about a line, and the platform re-checks the line against its own rule before
 * the record exists.
 */

interface CandidateItem {
  readonly id: string;
  readonly name: string;
  readonly strength: string;
  readonly form: string;
}

interface VisionLine {
  readonly index: number;
  readonly line: {
    readonly itemName: string;
    readonly quantity: number;
    readonly unit: string | null;
    readonly batchId: string | null;
    readonly expiresOn: string | null;
    readonly confidence: number;
    readonly note: string | null;
  };
  readonly extracted: {
    readonly itemName: string;
    readonly quantity: number;
    readonly batchId: string | null;
    readonly expiresOn: string | null;
    readonly confidence: number;
  };
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly candidates: readonly CandidateItem[];
  readonly reasons: readonly string[];
  readonly decision: 'pending' | 'accepted' | 'discarded';
  readonly decidedBy: string | null;
  readonly receipt: { readonly idempotencyKey: string; readonly receivedAt: string } | null;
}

interface VisionBatch {
  readonly id: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly occurredOn: string;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: 'model' | 'supplied';
  readonly model: string;
  readonly cacheHit: boolean;
  readonly registerDate: string | null;
  readonly pageNotes: readonly string[];
  readonly lines: readonly VisionLine[];
}

interface QueuePayload {
  readonly batches: readonly VisionBatch[];
  readonly provider: string;
  readonly threshold: number;
}

interface SessionPayload {
  readonly session: {
    readonly role: string;
    readonly label: string;
    readonly scopeId: string | null;
  };
  readonly openingDistrictId: string;
}

interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly strength: string;
  readonly form: string;
}

interface VisibilityPayload {
  readonly facilities: readonly {
    readonly id: string;
    readonly name: string;
    readonly tier: string;
  }[];
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  'low-confidence': 'read at low confidence',
  'item-unmatched': 'no catalogue entry matches the written name',
  'item-ambiguous': 'the written name matches more than one entry',
  'batch-not-read': 'no batch number was read',
  'expiry-not-read': 'no expiry was read',
  'expiry-not-after-register': 'the batch expired on or before the register date',
};

const today = (): string => new Date().toISOString().slice(0, 10);

/** One held line, with the corrections a person can make before approving it. */
function HeldLine({
  batch,
  line,
  catalogue,
  onDecide,
}: {
  readonly batch: VisionBatch;
  readonly line: VisionLine;
  readonly catalogue: readonly CatalogueItem[];
  readonly onDecide: (
    line: VisionLine,
    decision: 'accept' | 'discard',
    corrections: Record<string, unknown>,
  ) => Promise<void>;
}) {
  // What the name could have meant when it matched more than one entry; the
  // whole catalogue when it matched none, because then the person has to tell
  // the platform which medicine the page was about and the platform has no
  // candidates to offer.
  const options: readonly { readonly id: string; readonly label: string }[] =
    line.candidates.length > 0
      ? line.candidates.map((candidate) => ({
          id: candidate.id,
          // The strength is what tells two entries apart, so it is in the label
          // rather than left to the reader to infer from the order.
          label: `${candidate.name} ${candidate.strength} (${candidate.form})`,
        }))
      : catalogue.map((item) => ({
          id: item.id,
          label: `${item.name} ${item.strength} (${item.form})`,
        }));

  const [itemId, setItemId] = useState<string>(options[0]?.id ?? '');
  const [quantity, setQuantity] = useState<string>(String(line.line.quantity));
  const [batchId, setBatchId] = useState<string>(line.line.batchId ?? '');
  const [expiresOn, setExpiresOn] = useState<string>(line.line.expiresOn ?? '');
  const [busy, setBusy] = useState(false);

  const corrections = {
    ...(itemId === '' ? {} : { itemId }),
    ...(quantity.trim() === '' ? {} : { quantity: Number(quantity) }),
    batchId: batchId.trim() === '' ? null : batchId.trim(),
    expiresOn: expiresOn.trim() === '' ? null : expiresOn.trim(),
  };

  return (
    <li
      className="flex flex-col gap-3 px-4 py-4"
      data-reasons={line.reasons.join(',')}
      data-testid="vision-held-line"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-ink-subtle">line {line.index}</span>
        <span className="text-sm text-ink">
          read “{line.extracted.itemName}” · {formatCount(line.extracted.quantity)}
          {line.line.unit === null ? '' : ` ${line.line.unit}`} · confidence{' '}
          {line.extracted.confidence.toFixed(2)}
        </span>
        {line.itemId === null ? null : (
          <span className="text-sm text-ink-muted">matches {line.itemName}</span>
        )}
      </div>

      <ul className="flex flex-wrap gap-2">
        {line.reasons.map((reason) => (
          <li key={reason} className="rounded-card bg-sun/50 px-2 py-1 text-xs text-ink">
            {REASON_TEXT[reason] ?? reason}
          </li>
        ))}
      </ul>

      {line.line.note === null ? null : (
        <p className="text-xs text-ink-muted">The reader noted: {line.line.note}</p>
      )}

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {options.length === 0 ? null : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Which medicine is it?</span>
            <select
              aria-label={`Catalogue entry for line ${String(line.index)}`}
              className={FIELD}
              onChange={(event) => {
                setItemId(event.target.value);
              }}
              value={itemId}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Quantity</span>
          <input
            aria-label={`Quantity for line ${String(line.index)}`}
            className={FIELD}
            onChange={(event) => {
              setQuantity(event.target.value);
            }}
            type="number"
            value={quantity}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Batch</span>
          <input
            aria-label={`Batch for line ${String(line.index)}`}
            className={FIELD}
            onChange={(event) => {
              setBatchId(event.target.value);
            }}
            type="text"
            value={batchId}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Expires</span>
          <input
            aria-label={`Expiry for line ${String(line.index)}`}
            className={FIELD}
            onChange={(event) => {
              setExpiresOn(event.target.value);
            }}
            type="date"
            value={expiresOn}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className={CONTROL_PRIMARY}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDecide(line, 'accept', corrections).finally(() => {
              setBusy(false);
            });
          }}
          type="button"
        >
          Accept into the ledger
        </button>
        <button
          className={CONTROL_QUIET}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDecide(line, 'discard', {}).finally(() => {
              setBusy(false);
            });
          }}
          type="button"
        >
          Discard
        </button>
        <span className="text-xs text-ink-subtle">
          {batch.facilityName} · register {batch.registerDate ?? 'undated'} · day {batch.occurredOn}
        </span>
      </div>
    </li>
  );
}

export default function VisionPage() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [catalogue, setCatalogue] = useState<readonly CatalogueItem[]>([]);
  const [facilities, setFacilities] = useState<VisibilityPayload['facilities']>([]);
  const [facilityId, setFacilityId] = useState('');
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/vision');
    setQueue((await response.json()) as QueuePayload);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const sessionResponse = await fetch('/api/session');
      const payload = (await sessionResponse.json()) as SessionPayload;
      const [visibility, catalogueBody] = await Promise.all([
        fetch(`/api/visibility?districtId=${encodeURIComponent(payload.openingDistrictId)}`).then(
          async (response) => (await response.json()) as VisibilityPayload,
        ),
        fetch('/api/catalogue').then(
          async (response) => (await response.json()) as { items: readonly CatalogueItem[] },
        ),
      ]);
      if (cancelled) {
        return;
      }
      setSession(payload);
      setCatalogue(catalogueBody.items);
      setFacilities(visibility.facilities);
      setFacilityId((current) => current || (visibility.facilities[0]?.id ?? ''));
      await reload();
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const readPhotograph = useCallback(async (): Promise<void> => {
    if (file === null || facilityId === '') {
      return;
    }

    setBusy(true);
    setMessage(null);
    setRefusal(null);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== 'string') {
            reject(new Error('the photograph could not be read as a data URL'));
            return;
          }
          // A data URL carries its payload after the comma; the platform wants
          // the bytes and the MIME type, not the wrapper.
          resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => {
          reject(new Error('the photograph could not be read off this device'));
        };
        reader.readAsDataURL(file);
      });

      const response = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          capturedAt: new Date().toISOString(),
          image: { mimeType: file.type === '' ? 'image/jpeg' : file.type, data },
        }),
      });
      const body = (await response.json()) as { outcome: string; detail?: string; held?: number };

      if (!response.ok) {
        setRefusal(body.detail ?? 'the reading was refused');
        return;
      }

      setMessage(
        body.held === undefined || body.held === 0
          ? 'The reading was written to the ledger.'
          : `The reading was written where the platform could stand behind it; ${String(body.held)} line(s) are waiting for you.`,
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }, [facilityId, file, reload]);

  const decide = useCallback(
    async (
      line: VisionLine,
      decision: 'accept' | 'discard',
      corrections: Record<string, unknown>,
    ): Promise<void> => {
      const batch = queue?.batches.find((entry) =>
        entry.lines.some((candidate) => candidate.index === line.index),
      );
      if (batch === undefined) {
        return;
      }

      setRefusal(null);
      const response = await fetch('/api/vision/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId: batch.id,
          index: line.index,
          decision,
          ...(decision === 'accept' ? { corrections } : {}),
        }),
      });
      const body = (await response.json()) as { detail?: string };

      if (!response.ok) {
        setRefusal(body.detail ?? 'the decision was refused');
      }
      await reload();
    },
    [queue, reload],
  );

  const batches = queue?.batches ?? [];
  const written = batches.flatMap((batch) =>
    batch.lines.filter((line) => line.decision === 'accepted').map((line) => ({ batch, line })),
  );
  const held = batches.flatMap((batch) =>
    batch.lines.filter((line) => line.decision === 'pending').map((line) => ({ batch, line })),
  );

  return (
    <div className="flex flex-col gap-20">
      <PageHeader layout="split" label="Vision intake" title="Read a paper stock register">
        <p className="text-lead text-ink-muted">
          Photograph a register and the platform reads it into ledger lines. The reader is a model;
          everything that decides whether a line may be written is not. A line the platform can
          stand behind goes to the ledger marked as read by vision, and a line it cannot goes to the
          queue below with the reasons it was held back.
        </p>
      </PageHeader>

      <Notice
        id="vision-reader"
        tone="warning"
        title="What is reading, and what happens if nothing is"
      >
        <p data-testid="provider-state">
          Reasoning provider: <span className="font-mono">{queue?.provider ?? 'reading'}</span> ·
          review threshold:{' '}
          <span className="font-mono">{queue === null ? '—' : queue.threshold.toFixed(2)}</span>
        </p>
        <p>
          With no Gemini key configured this build runs the fixture provider, which has no recorded
          responses and therefore refuses every request — so a photograph cannot be read here today,
          and the screen would rather say that than show a reader that is not there. A reading can
          still be recorded through the same endpoint, and the queue says when that is what
          happened. Every number written from a photograph comes from the photograph and from a
          person; no figure in this flow is composed by a model.
        </p>
      </Notice>

      <Panel
        id="read"
        title="Photograph"
        description="The reader transcribes the page: it does not tidy names, expand abbreviations or convert units, because a name it improved is a name the catalogue can no longer match."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Facility</span>
            <select
              aria-label="Facility"
              className={FIELD}
              onChange={(event) => {
                setFacilityId(event.target.value);
              }}
              value={facilityId}
            >
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name} ({facility.tier})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Photograph</span>
            <input
              accept="image/*"
              // Named for the act rather than the noun: the section around it is
              // called "Photograph" too, and a label that collides with its own
              // region is a name nothing can address.
              aria-label="Register photograph"
              className={FIELD}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
              }}
              type="file"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className={CONTROL_PRIMARY}
            disabled={busy || file === null || facilityId === ''}
            onClick={() => {
              void readPhotograph();
            }}
            type="button"
          >
            Read the photograph
          </button>
          <span className="text-xs text-ink-subtle">
            Acting as {session?.session.label ?? '—'} · register day defaults to the page’s own date
          </span>
        </div>
        {message === null ? null : (
          <p className="mt-4 rounded-control bg-accent/12 px-3 py-2 text-sm text-ink">{message}</p>
        )}
        {refusal === null ? null : (
          <p
            className="mt-4 rounded-card bg-coral/25 px-3 py-2 text-sm text-ink"
            data-testid="vision-refusal"
          >
            {refusal}
          </p>
        )}
      </Panel>

      <Panel
        id="written"
        title="Written from a photograph"
        description="Lines the platform could stand behind: read confidently, matched to the catalogue unambiguously, and complete enough to be a movement. They carry captureSource vision, which is how the ledger tells a photographed entry from a typed one."
      >
        {written.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing has been read yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline rounded-card">
            {written.map(({ batch, line }) => (
              <li
                key={`${batch.id}:${String(line.index)}`}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
                data-testid="vision-written-line"
                data-provenance="vision"
              >
                <span className="text-sm text-ink">
                  {batch.facilityName} · {line.itemName} · {formatCount(line.line.quantity)}
                  {line.line.unit === null ? '' : ` ${line.line.unit}`} · batch{' '}
                  {line.line.batchId ?? '—'} · expires {line.line.expiresOn ?? '—'} ·{' '}
                  {batch.occurredOn}
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-control bg-accent/12 px-2 py-1 text-xs text-ink">
                    AI-extracted ·{' '}
                    {batch.source === 'model' ? `vision · ${batch.model}` : 'reading supplied'}
                  </span>
                  <span className="font-mono text-xs text-ink-subtle">
                    {line.receipt?.idempotencyKey ?? '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        id="review"
        title="Waiting for a person"
        description="Nothing on this list has been written. Each line says why it was held back, and where the name could have meant more than one medicine the queue offers them; approving a line runs it back through the platform's own rule, so a line that is still incomplete is refused again rather than written."
      >
        {held.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="vision-empty-queue">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline rounded-card">
            {held.map(({ batch, line }) => (
              <HeldLine
                key={`${batch.id}:${String(line.index)}`}
                batch={batch}
                catalogue={catalogue}
                line={line}
                onDecide={decide}
              />
            ))}
          </ul>
        )}
        {batches.some((batch) => batch.pageNotes.length > 0) ? (
          <div className="mt-4 rounded-card bg-paper-raised px-3 py-2 text-sm text-ink-muted">
            <p className="font-medium text-ink">What the reader said about the page</p>
            <ul className="mt-1 list-inside list-disc text-ink-muted">
              {batches.flatMap((batch) =>
                batch.pageNotes.map((note) => <li key={`${batch.id}:${note}`}>{note}</li>),
              )}
            </ul>
          </div>
        ) : null}
        {batches.some((batch) => batch.lines.some((line) => line.decision === 'discarded')) ? (
          <p className="mt-3 text-xs text-ink-subtle">
            Discarded lines stay on the extraction as decisions; they are never written and never
            counted.
          </p>
        ) : null}
      </Panel>

      <p className="text-xs text-ink-subtle">
        The queue is held in this process, like the projection and the alert inbox: it is correct
        for the demonstration and it is not a store. Every record written from here is stamped
        simulated by the platform, because the dataset it is added to is generated. Today is{' '}
        {today()}.
      </p>
    </div>
  );
}
