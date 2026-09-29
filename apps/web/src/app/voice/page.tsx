'use client';

import { useCallback, useEffect, useState } from 'react';

import { PageHeader } from '@/components/page-header';
import { Notice, Panel, formatCount } from '@/components/ui';

/**
 * Say it, see it, confirm it.
 *
 * The people who record stock are comfortable speaking and less comfortable
 * typing, and speech is the one input the platform cannot check against the
 * evidence it came from — there is no page to compare a transcript to. So this
 * screen exists to be the check: it shows the person what was heard, verbatim,
 * says what the update would become, and asks the questions the platform's own
 * rule raised. Nothing is written until somebody presses confirm.
 *
 * Three things it refuses to hide:
 *
 *  - **Which reader is behind it.** With no Gemini key configured this build runs
 *    the fixture provider, which has no recorded responses and therefore refuses
 *    every recording. The screen says so rather than showing a microphone that is
 *    not there, and the queue states when a parse was supplied rather than heard.
 *  - **What was heard, exactly.** The transcript is shown as it arrived, filler
 *    words and all, because a tidied transcript is a confirmation of something
 *    nobody said.
 *  - **What is still open.** Every outstanding question is on the proposal, and
 *    the confirm button refuses rather than writes when one remains.
 */

interface VoiceCandidate {
  readonly id: string;
  readonly name: string;
  readonly strength: string;
  readonly form: string;
}

interface VoiceCommand {
  readonly intent: string;
  readonly language: string;
  readonly transcript: string;
  readonly itemName: string | null;
  readonly quantity: number | null;
  readonly batchId: string | null;
  readonly expiresOn: string | null;
  readonly adjustmentDirection: string | null;
  readonly cadre: string | null;
  readonly bedsTotal: number | null;
  readonly bedsOccupied: number | null;
  readonly postsSanctioned: number | null;
  readonly postsFilled: number | null;
  readonly presentToday: number | null;
  readonly confidence: number;
  readonly ambiguities: readonly string[];
}

interface VoiceProposal {
  readonly id: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly observedOn: string;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly source: 'model' | 'supplied';
  readonly model: string;
  readonly cacheHit: boolean;
  readonly spokenBy: string;
  readonly command: VoiceCommand;
  readonly problems: readonly string[];
  readonly observation: string | null;
  readonly item: { readonly id: string; readonly name: string; readonly strength: string } | null;
  readonly candidates: readonly VoiceCandidate[];
  readonly confirmedBy: string | null;
  readonly discardedBy: string | null;
  readonly receipt: { readonly idempotencyKey: string; readonly receivedAt: string } | null;
}

interface QueuePayload {
  readonly proposals: readonly VoiceProposal[];
  readonly provider: string;
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

const PROBLEM_TEXT: Readonly<Record<string, string>> = {
  'intent-not-understood': 'the update was not understood as a stock, bed or attendance report',
  'item-unmatched': 'no catalogue entry matches the name that was spoken',
  'item-ambiguous': 'the name that was spoken matches more than one catalogue entry',
  'batch-not-heard': 'the batch number was not said',
  'expiry-not-heard': 'the expiry was not said',
  'expiry-not-after-observation': 'that batch expired on or before the day the update is about',
  'present-not-heard': 'how many of the filled posts turned up was not said',
};

const INTENT_TEXT: Readonly<Record<string, string>> = {
  stock_receipt: 'stock arriving',
  stock_issue: 'stock issued out',
  stock_adjustment: 'a stock correction',
  bed_status: 'a bed report',
  staff_attendance: 'an attendance report',
  unknown: 'nothing the platform recognises',
};

const today = (): string => new Date().toISOString().slice(0, 10);

/** One proposal, with the questions the platform asked and the answers a person can give. */
function PendingProposal({
  proposal,
  catalogue,
  onConfirm,
  onDiscard,
}: {
  readonly proposal: VoiceProposal;
  readonly catalogue: readonly CatalogueItem[];
  readonly onConfirm: (
    proposal: VoiceProposal,
    corrections: Record<string, unknown>,
  ) => Promise<void>;
  readonly onDiscard: (proposal: VoiceProposal) => Promise<void>;
}) {
  // What the spoken name could have meant when it matched more than one entry;
  // the whole catalogue when it matched none, because then a person has to tell
  // the platform which medicine was meant and there are no candidates to offer.
  const options: readonly { readonly id: string; readonly label: string }[] =
    proposal.candidates.length > 0
      ? proposal.candidates.map((candidate) => ({
          id: candidate.id,
          label: `${candidate.name} ${candidate.strength} (${candidate.form})`,
        }))
      : proposal.problems.includes('item-unmatched')
        ? catalogue.map((item) => ({
            id: item.id,
            label: `${item.name} ${item.strength} (${item.form})`,
          }))
        : [];

  const [itemId, setItemId] = useState<string>('');
  const [batchId, setBatchId] = useState<string>(proposal.command.batchId ?? '');
  const [expiresOn, setExpiresOn] = useState<string>(proposal.command.expiresOn ?? '');
  const [present, setPresent] = useState<string>(
    proposal.command.presentToday === null ? '' : String(proposal.command.presentToday),
  );
  const [busy, setBusy] = useState(false);

  const corrections: Record<string, unknown> = {
    ...(itemId === '' ? {} : { itemId }),
    ...(proposal.command.intent === 'stock_receipt'
      ? {
          batchId: batchId.trim() === '' ? null : batchId.trim(),
          expiresOn: expiresOn.trim() === '' ? null : expiresOn.trim(),
        }
      : {}),
    ...(proposal.command.intent === 'staff_attendance'
      ? { presentToday: present.trim() === '' ? null : Number(present) }
      : {}),
  };

  return (
    <li
      className="flex flex-col gap-4 px-4 py-4"
      data-problems={proposal.problems.join(',')}
      data-testid="voice-pending"
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs text-ink-subtle">
          {proposal.id} · spoken by {proposal.spokenBy} · about {proposal.observedOn}
        </span>
        <p className="text-sm text-ink">
          Heard “{proposal.command.transcript}” ({proposal.command.language})
        </p>
        <p className="text-sm text-ink-muted">
          That would be {INTENT_TEXT[proposal.command.intent] ?? proposal.command.intent}
          {proposal.command.quantity === null
            ? ''
            : ` · ${formatCount(proposal.command.quantity)} ${proposal.item?.name ?? proposal.command.itemName ?? 'units'}`}
          {proposal.command.adjustmentDirection === null
            ? ''
            : ` (${proposal.command.adjustmentDirection})`}
          {proposal.command.bedsTotal === null
            ? ''
            : ` · ${String(proposal.command.bedsOccupied ?? 0)} of ${String(proposal.command.bedsTotal)} beds occupied`}
          {proposal.command.cadre === null
            ? ''
            : ` · ${proposal.command.cadre}: ${String(proposal.command.presentToday ?? '?')} of ${String(proposal.command.postsFilled ?? 0)} staff present`}
        </p>
      </div>

      {proposal.problems.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {proposal.item === null
            ? 'Nothing is outstanding: this can be written.'
            : `Nothing is outstanding: this would be written against ${proposal.item.name} ${proposal.item.strength}.`}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">Before this is written, the platform needs:</p>
          <ul className="flex flex-wrap gap-2">
            {proposal.problems.map((problem) => (
              <li key={problem} className="rounded-card bg-sun/50 px-2 py-1 text-xs text-ink">
                {PROBLEM_TEXT[problem] ?? problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposal.command.ambiguities.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-xs text-ink-muted">
          {proposal.command.ambiguities.map((note) => (
            <li key={note}>The reader was unsure: {note}</li>
          ))}
        </ul>
      )}

      {options.length === 0 ? null : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Which medicine was meant?</span>
          <select
            aria-label={`Catalogue entry for ${proposal.id}`}
            className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
            onChange={(event) => {
              setItemId(event.target.value);
            }}
            value={itemId}
          >
            <option value="">— choose an entry —</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {proposal.command.intent === 'stock_receipt' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Batch</span>
            <input
              aria-label={`Batch for ${proposal.id}`}
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
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
              aria-label={`Expiry for ${proposal.id}`}
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
              onChange={(event) => {
                setExpiresOn(event.target.value);
              }}
              type="date"
              value={expiresOn}
            />
          </label>
        </div>
      ) : null}

      {proposal.command.intent === 'staff_attendance' ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-muted">Present today</span>
          <input
            aria-label={`Present for ${proposal.id}`}
            className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
            onChange={(event) => {
              setPresent(event.target.value);
            }}
            type="number"
            value={present}
          />
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="rounded-control bg-accent px-3 py-2 text-sm font-medium text-paper disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onConfirm(proposal, corrections).finally(() => {
              setBusy(false);
            });
          }}
          type="button"
        >
          That is what I said — write it
        </button>
        <button
          className="min-h-11 rounded-card bg-paper-raised px-3 py-2 text-sm text-ink disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDiscard(proposal).finally(() => {
              setBusy(false);
            });
          }}
          type="button"
        >
          That is not what I said
        </button>
        <span className="text-xs text-ink-subtle">
          {proposal.source === 'model'
            ? `parsed by ${proposal.model}`
            : 'parse supplied rather than heard'}
          {proposal.cacheHit ? ' · served from cache' : ''}
        </span>
      </div>
    </li>
  );
}

export default function VoicePage() {
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [catalogue, setCatalogue] = useState<readonly CatalogueItem[]>([]);
  const [facilities, setFacilities] = useState<
    readonly { readonly id: string; readonly name: string; readonly tier: string }[]
  >([]);
  const [facilityId, setFacilityId] = useState('');
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const response = await fetch('/api/voice');
    setQueue((await response.json()) as QueuePayload);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      const sessionResponse = await fetch('/api/session');
      const payload = (await sessionResponse.json()) as SessionPayload;
      const [visibility, catalogueBody] = await Promise.all([
        fetch(`/api/visibility?districtId=${encodeURIComponent(payload.openingDistrictId)}`).then(
          async (response) =>
            (await response.json()) as {
              facilities: readonly { id: string; name: string; tier: string }[];
            },
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

  const listen = useCallback(async (): Promise<void> => {
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
            reject(new Error('the recording could not be read as a data URL'));
            return;
          }
          resolve(result.slice(result.indexOf(',') + 1));
        };
        reader.onerror = () => {
          reject(new Error('the recording could not be read off this device'));
        };
        reader.readAsDataURL(file);
      });

      const response = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          capturedAt: new Date().toISOString(),
          audio: { mimeType: file.type === '' ? 'audio/ogg' : file.type, data },
        }),
      });
      const body = (await response.json()) as { detail?: string; proposal?: { id: string } };

      if (!response.ok) {
        setRefusal(body.detail ?? 'the recording was refused');
        return;
      }

      setMessage(
        `Heard and held for confirmation as ${body.proposal?.id ?? 'a new proposal'}. Nothing has been written.`,
      );
      await reload();
    } finally {
      setBusy(false);
    }
  }, [facilityId, file, reload]);

  const confirm = useCallback(
    async (proposal: VoiceProposal, corrections: Record<string, unknown>): Promise<void> => {
      setRefusal(null);
      const response = await fetch('/api/voice/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: proposal.id, confirm: true, corrections }),
      });
      const body = (await response.json()) as { detail?: string; outcome?: string };

      if (!response.ok) {
        setRefusal(body.detail ?? 'the confirmation was refused');
      } else if (body.outcome === 'written') {
        setMessage(`${proposal.id} was written to the ledger as a spoken update.`);
      }
      await reload();
    },
    [reload],
  );

  const discard = useCallback(
    async (proposal: VoiceProposal): Promise<void> => {
      setRefusal(null);
      const response = await fetch('/api/voice/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: proposal.id, discard: true }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { detail?: string };
        setRefusal(body.detail ?? 'the correction was refused');
      }
      await reload();
    },
    [reload],
  );

  const proposals = queue?.proposals ?? [];
  const pending = proposals.filter(
    (proposal) => proposal.receipt === null && proposal.discardedBy === null,
  );
  const written = proposals.filter((proposal) => proposal.receipt !== null);
  const rejected = proposals.filter(
    (proposal) => proposal.receipt === null && proposal.discardedBy !== null,
  );

  return (
    <div className="flex flex-col gap-12">
      <PageHeader label="Voice intake" title="Say it, then confirm it">
        <p className="max-w-measure text-ink-muted">
          Speak a stock, bed or attendance update and the platform parses it into a record it holds
          back. The transcript is shown back to you word for word, the update is named, and every
          question the platform still has is listed — and nothing reaches the ledger until somebody
          says that is what was said. Speech is the one input with no page to check it against, so
          the confirmation is the check.
        </p>
      </PageHeader>

      <Notice
        id="voice-reader"
        tone="warning"
        title="What is listening, and what happens if nothing is"
      >
        <p data-testid="voice-provider-state">
          Reasoning provider: <span className="font-mono">{queue?.provider ?? 'starting'}</span> ·
          updates waiting: <span className="font-mono">{String(pending.length)}</span>
        </p>
        <p>
          With no Gemini key configured this build runs the fixture provider, which has no recorded
          responses and therefore refuses every recording — so a voice note cannot be parsed here
          today, and the screen would rather say that than show a microphone that is not there. A
          parse can still be recorded through the same endpoint, and every proposal says when that
          is what happened rather than letting a supplied parse pass for a model&rsquo;s reading.
        </p>
      </Notice>

      <Panel
        id="speak"
        title="Speak an update"
        description="The recording goes to the reader as it is: the platform does not transcribe first, because how a drug name was said is often what tells two of them apart."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-ink-muted">Facility</span>
            <select
              aria-label="Facility"
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
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
            <span className="text-ink-muted">Recording</span>
            <input
              accept="audio/*"
              // Named for the act rather than the noun: the label matcher is a
              // substring match, and this page is mostly about what was said.
              aria-label="Voice note"
              className="min-h-11 rounded-card border border-hairline bg-paper-raised px-3 py-2"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
              }}
              type="file"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            className="rounded-card bg-accent px-4 py-2 text-sm font-medium text-paper disabled:opacity-50"
            disabled={busy || file === null || facilityId === ''}
            onClick={() => {
              void listen();
            }}
            type="button"
          >
            Listen and hold for confirmation
          </button>
          <span className="text-xs text-ink-subtle">
            Acting as {session?.session.label ?? '—'} · the day defaults to today, {today()}
          </span>
        </div>
        {message === null ? null : (
          <p className="mt-4 rounded-control bg-accent/12 px-3 py-2 text-sm text-ink">{message}</p>
        )}
        {refusal === null ? null : (
          <p
            className="mt-4 rounded-card bg-coral/25 px-3 py-2 text-sm text-ink"
            data-testid="voice-refusal"
          >
            {refusal}
          </p>
        )}
      </Panel>

      <Panel
        id="pending"
        title="Waiting for a person to confirm"
        description="Nothing on this list has been written. What was heard is repeated word for word, and the questions below it are the platform's own rule — a proposal that is still incomplete is refused again after the button is pressed rather than written because it was pressed."
      >
        {pending.length === 0 ? (
          <p className="text-sm text-ink-muted" data-testid="voice-empty-queue">
            Nothing is waiting to be confirmed.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline rounded-card">
            {pending.map((proposal) => (
              <PendingProposal
                key={proposal.id}
                catalogue={catalogue}
                onConfirm={confirm}
                onDiscard={discard}
                proposal={proposal}
              />
            ))}
          </ul>
        )}
        {rejected.length === 0 ? null : (
          <p className="mt-3 text-xs text-ink-subtle">
            {String(rejected.length)} proposal(s) were rejected by the person who spoke:{' '}
            {rejected.map((proposal) => proposal.id).join(', ')}. They are kept as evidence about
            the reader and were never written.
          </p>
        )}
      </Panel>

      <Panel
        id="written"
        title="Written from a spoken update"
        description="Confirmed proposals that reached the ledger. They carry captureSource voice, which is how the ledger tells a spoken entry from a typed or photographed one."
      >
        {written.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing has been confirmed yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline rounded-card">
            {written.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
                data-provenance="voice"
                data-testid="voice-written-line"
              >
                <span className="text-sm text-ink">
                  {proposal.facilityName} · {proposal.item?.name ?? 'report'} ·{' '}
                  {proposal.command.quantity === null
                    ? (INTENT_TEXT[proposal.command.intent] ?? proposal.command.intent)
                    : formatCount(proposal.command.quantity)}
                  {proposal.command.batchId === null ? '' : ` · batch ${proposal.command.batchId}`}
                  {proposal.command.expiresOn === null
                    ? ''
                    : ` · expires ${proposal.command.expiresOn}`}{' '}
                  · {proposal.observedOn} · confirmed by {proposal.confirmedBy ?? '—'}
                </span>
                <span className="flex items-center gap-2">
                  <span className="rounded-control bg-accent/12 px-2 py-1 text-xs text-ink">
                    Heard ·{' '}
                    {proposal.source === 'model' ? `voice · ${proposal.model}` : 'parse supplied'}
                  </span>
                  <span className="font-mono text-xs text-ink-subtle">
                    {proposal.receipt?.idempotencyKey ?? '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
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
