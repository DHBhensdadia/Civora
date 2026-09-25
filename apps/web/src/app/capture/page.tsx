'use client';

import {
  CADRES,
  PLATFORM_STAMP,
  SYNDROMES,
  completeSubmission,
  ingestRequestSchema,
} from '@civora/domain';
import type { AdjustmentDirection, Cadre, LedgerEntryKind, Syndrome } from '@civora/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Notice, Panel, formatCount } from '@/components/ui';
import { enqueue } from '@/lib/outbox';
import type { OutboxItem } from '@/lib/outbox';
import { warmOfflineShell } from '@/lib/shell-cache';
import type { ShellStatus } from '@/lib/shell-cache';
import { useOutbox } from '@/lib/use-outbox';

/**
 * What a facility records.
 *
 * The front-line surface, and the one that has to work with no connection. Three
 * things shape it:
 *
 *  - **Everything is queued, always.** A capture is written to this device and
 *    delivered afterwards, whether or not there is a connection now. There is no
 *    separate offline mode, because a separate mode is the one that is never
 *    tested and is broken on the day it is needed.
 *  - **Validation is the domain's.** The form builds an ingest envelope and
 *    checks it against the same schema the platform validates against, so the
 *    rules cannot differ between the two and a new rule needs no client change.
 *  - **The queue is visible.** How many changes are waiting, which ones the
 *    platform refused and why — a sync indicator that only says "synced" teaches
 *    staff to distrust it.
 *
 * Capture here writes simulated records: the platform stamps what it stores, and
 * in this build that stamp says simulated. The interface says so rather than
 * leaving a reader to discover it from the record.
 */

type RecordKind =
  | 'stock_ledger_entry'
  | 'bed_status'
  | 'staff_attendance'
  | 'footfall_observation'
  | 'syndromic_signal';

const RECORD_KINDS: readonly {
  readonly id: RecordKind;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    id: 'stock_ledger_entry',
    label: 'Medicine movement',
    hint: 'a receipt, an issue, an adjustment or an expiry',
  },
  { id: 'bed_status', label: 'Beds', hint: 'occupied out of the beds the facility reports' },
  { id: 'staff_attendance', label: 'Attendance', hint: 'posts filled and present, by cadre' },
  { id: 'footfall_observation', label: 'Footfall', hint: 'outpatient and inpatient attendances' },
  { id: 'syndromic_signal', label: 'Syndromic counts', hint: 'cases by syndrome for the day' },
];

const LEDGER_KINDS: readonly LedgerEntryKind[] = ['receipt', 'issue', 'adjust', 'expiry'];

/**
 * What the interface says about the stored screen.
 *
 * Stated as three separate facts rather than one badge, because "offline ready"
 * would be true of the queue and false of the screen in exactly the situation
 * that matters.
 */
const SHELL_STATUS_TEXT: Readonly<Record<ShellStatus, string>> = {
  unsupported: 'This browser will not keep the screen offline; the queue still holds captures',
  cached: 'Screen saved on this device — it opens with no connection',
  unavailable: 'Screen not saved for offline use — opening it will need a connection',
};

/**
 * Whether the platform's own lists have been read.
 *
 * The screen can be stored on the device; the facility list cannot, because a
 * list of facilities is a statement about the world and the platform is the only
 * thing entitled to make it. So a reopening with no connection can show the
 * queue and the form but cannot offer a facility to record against, and it says
 * exactly that instead of offering a stale choice.
 */
type ContextStatus = 'reading' | 'ready' | 'unreachable';

const CONTEXT_STATUS_TEXT: Readonly<Record<ContextStatus, string>> = {
  reading: "Reading the platform's facility list",
  ready: 'Facility list read from the platform',
  unreachable:
    'The platform could not be reached, so its facility list is unavailable and nothing can be queued until it is',
};

/**
 * The form's own state.
 *
 * Every field is a string because that is what an input holds, and every field
 * is required because a missing one would silently become `undefined` at the
 * point it is turned into a number. The platform's schema is what decides
 * whether the values are usable; this shape only decides what can be typed.
 */
interface FormFields {
  readonly occurredOn: string;
  readonly ledgerKind: LedgerEntryKind;
  readonly quantity: string;
  readonly batchId: string;
  readonly expiresOn: string;
  readonly adjustmentDirection: AdjustmentDirection;
  readonly bedsTotal: string;
  readonly bedsOccupied: string;
  readonly cadre: Cadre;
  readonly postsSanctioned: string;
  readonly postsFilled: string;
  readonly presentToday: string;
  readonly opdCount: string;
  readonly ipdCount: string;
  readonly syndrome: Syndrome;
  readonly caseCount: string;
  readonly itemId: string;
}

interface SessionPayload {
  readonly session: {
    readonly role: string;
    readonly label: string;
    readonly scopeId: string | null;
  };
  readonly principals: readonly {
    readonly id: string;
    readonly label: string;
    readonly role: string;
  }[];
  readonly openingDistrictId: string;
}

interface FacilityOption {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly reading: { readonly status: string };
}

interface VisibilityPayload {
  readonly district: { readonly id: string; readonly name: string; readonly regionName: string };
  readonly districts: readonly {
    readonly id: string;
    readonly name: string;
    readonly regionName: string;
  }[];
  readonly facilities: readonly FacilityOption[];
}

interface CatalogueItem {
  readonly id: string;
  readonly name: string;
  readonly strength: string;
  readonly form: string;
  readonly unit: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const newIdentifier = (prefix: string): string =>
  `${prefix}-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now())}`;

/** The numbers a form field holds, parsed the way the platform will read them. */
const asNumber = (value: string): number => (value.trim() === '' ? 0 : Number(value));

const STATUS_WORDS: Readonly<Record<OutboxItem['status'], string>> = {
  pending: 'Waiting to sync',
  delivered: 'Recorded',
  refused: 'Refused by the platform',
  rejected: 'Not accepted',
};

export default function CapturePage() {
  const [identity, setIdentity] = useState<SessionPayload | null>(null);
  const [districtId, setDistrictId] = useState<string>('');
  const [visibility, setVisibility] = useState<VisibilityPayload | null>(null);
  const [facilityId, setFacilityId] = useState<string>('');
  const [catalogue, setCatalogue] = useState<readonly CatalogueItem[]>([]);
  const [kind, setKind] = useState<RecordKind>('stock_ledger_entry');
  const [fields, setFields] = useState<FormFields>({
    occurredOn: today(),
    ledgerKind: 'issue',
    quantity: '10',
    batchId: '',
    expiresOn: '',
    adjustmentDirection: 'decrease',
    bedsTotal: '',
    bedsOccupied: '',
    cadre: 'staff_nurse',
    postsSanctioned: '',
    postsFilled: '',
    presentToday: '',
    opdCount: '',
    ipdCount: '',
    syndrome: 'fever',
    caseCount: '',
    itemId: '',
  });
  const [issues, setIssues] = useState<readonly { path: string; message: string }[]>([]);
  const [queued, setQueued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const outbox = useOutbox();
  const [shell, setShell] = useState<ShellStatus>('unsupported');
  const [contextStatus, setContextStatus] = useState<ContextStatus>('reading');

  // Keeping the screen itself is a separate promise from keeping the queue: see
  // `lib/shell-cache.ts`. Its outcome is reported rather than assumed, because a
  // facility that is told it can work offline and then cannot is worse served
  // than one that was told the truth.
  useEffect(() => {
    let cancelled = false;
    void warmOfflineShell().then((status) => {
      if (!cancelled) {
        setShell(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = useCallback(<K extends keyof FormFields>(name: K, value: FormFields[K]) => {
    setFields((current) => ({ ...current, [name]: value }));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const [sessionResponse, catalogueResponse] = await Promise.all([
          fetch('/api/session'),
          fetch('/api/catalogue'),
        ]);
        const session = (await sessionResponse.json()) as SessionPayload;
        const catalogueBody = (await catalogueResponse.json()) as {
          items: readonly CatalogueItem[];
        };
        if (cancelled) {
          return;
        }
        setIdentity(session);
        setDistrictId(session.openingDistrictId);
        setCatalogue(catalogueBody.items);
        setContextStatus('ready');
      } catch {
        // A screen read off the device with the platform unreachable is the
        // normal state of affairs at the end of a bad line, not a crash.
        if (!cancelled) {
          setContextStatus('unreachable');
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (districtId === '') {
      return;
    }

    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/visibility?districtId=${encodeURIComponent(districtId)}`,
        );
        const body = (await response.json()) as VisibilityPayload;
        if (cancelled) {
          return;
        }
        setVisibility(body);
        setFacilityId((current) =>
          current !== '' && body.facilities.some((facility) => facility.id === current)
            ? current
            : (body.facilities[0]?.id ?? ''),
        );
        setContextStatus('ready');
      } catch {
        if (!cancelled) {
          setContextStatus('unreachable');
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [districtId]);

  const selectedItem = useMemo(
    () => catalogue.find((item) => item.id === fields.itemId) ?? catalogue[0],
    [catalogue, fields.itemId],
  );

  /** The envelope this form would submit, built from the fields as they stand. */
  const submission = useMemo((): { request: unknown; label: string } | null => {
    if (facilityId === '' || identity === null) {
      return null;
    }

    const envelope = {
      idempotencyKey: newIdentifier('capture'),
      captureSource: 'manual' as const,
      capturedAt: new Date().toISOString(),
    };

    switch (kind) {
      case 'stock_ledger_entry': {
        const ledgerKind = fields.ledgerKind;
        const item = selectedItem;
        return {
          label: `${fields.ledgerKind} · ${item?.name ?? 'item'} · ${fields.quantity} ${item?.unit ?? 'units'}`,
          request: {
            ...envelope,
            type: kind,
            observation: {
              id: newIdentifier('entry'),
              facilityId,
              itemId: item?.id ?? '',
              kind: ledgerKind,
              quantity: asNumber(fields.quantity),
              adjustmentDirection: ledgerKind === 'adjust' ? fields.adjustmentDirection : null,
              occurredOn: fields.occurredOn,
              batchId: ledgerKind === 'receipt' ? fields.batchId : null,
              expiresOn: ledgerKind === 'receipt' ? fields.expiresOn : null,
              correctsEntryId: null,
              counterpartFacilityId: null,
              transferId: null,
            },
          },
        };
      }
      case 'bed_status':
        return {
          label: `beds ${fields.bedsOccupied}/${fields.bedsTotal} on ${fields.occurredOn}`,
          request: {
            ...envelope,
            type: kind,
            observation: {
              facilityId,
              observedOn: fields.occurredOn,
              bedsTotal: asNumber(fields.bedsTotal),
              bedsOccupied: asNumber(fields.bedsOccupied),
            },
          },
        };
      case 'staff_attendance':
        return {
          label: `${fields.cadre} ${fields.presentToday}/${fields.postsFilled} present on ${fields.occurredOn}`,
          request: {
            ...envelope,
            type: kind,
            observation: {
              facilityId,
              observedOn: fields.occurredOn,
              cadre: fields.cadre,
              postsSanctioned: asNumber(fields.postsSanctioned),
              postsFilled: asNumber(fields.postsFilled),
              presentToday: asNumber(fields.presentToday),
            },
          },
        };
      case 'footfall_observation':
        return {
          label: `footfall OPD ${fields.opdCount} on ${fields.occurredOn}`,
          request: {
            ...envelope,
            type: kind,
            observation: {
              facilityId,
              observedOn: fields.occurredOn,
              opdCount: asNumber(fields.opdCount),
              ipdCount: asNumber(fields.ipdCount),
            },
          },
        };
      case 'syndromic_signal':
        return {
          label: `${fields.syndrome} ${fields.caseCount} cases on ${fields.occurredOn}`,
          request: {
            ...envelope,
            type: kind,
            observation: {
              facilityId,
              observedOn: fields.occurredOn,
              syndrome: fields.syndrome,
              caseCount: asNumber(fields.caseCount),
            },
          },
        };
    }
  }, [facilityId, fields, identity, kind, selectedItem]);

  const submit = useCallback(async (): Promise<void> => {
    if (submission === null) {
      return;
    }

    // The same schema and the same completion the platform validates against: the
    // platform fills in the fields it owns, and this checks the result before
    // anything is queued. A rule that changes in the domain changes here, and a
    // message the platform would give is the message the person sees before they
    // queue anything.
    const parsed = ingestRequestSchema.safeParse(
      completeSubmission(submission.request, PLATFORM_STAMP),
    );
    if (!parsed.success) {
      setIssues(
        parsed.error.issues.map((issue) => ({
          path: issue.path.map((part) => String(part)).join('.'),
          message: issue.message,
        })),
      );
      setQueued(null);
      return;
    }

    setIssues([]);
    setBusy(true);
    try {
      const item = await enqueue(submission.request, submission.label);
      setQueued(item.label);
    } finally {
      setBusy(false);
    }
  }, [submission]);

  const facility = visibility?.facilities.find((candidate) => candidate.id === facilityId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-3">
        <p className="text-sm font-medium tracking-widest text-sky-400 uppercase">
          Facility capture
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Capture what the facility counted</h1>
        <p className="max-w-3xl text-slate-300">
          Every entry is written to this device first and delivered when the platform can be
          reached, so a weak connection delays the sync rather than the record. Nothing is discarded
          on failure and nothing is counted twice: each capture carries a key that survives every
          retry.
        </p>
      </header>

      <Notice
        id="capture-simulation"
        tone="warning"
        title="Captures made here are simulated records"
      >
        <p>
          The platform is running on generated data, so what a capture adds to it is generated too
          and is stamped as such by the platform rather than by this form. The mechanism is the one
          a real deployment uses; only the stamp on the stored record changes.
        </p>
      </Notice>

      <Panel
        id="identity"
        title="Acting as"
        description="Fixture identities for the demonstration. The platform authorises every submission against the scope below, and refuses anything outside it."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">Identity</span>
            {/*
              The field is named here rather than by the label's text, because
              a select's own text content is part of the name a wrapping label
              contributes: without this, the control is called "Identity"
              followed by every option in the list.
            */}
            <select
              aria-label="Identity"
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
              onChange={(event) => {
                void fetch('/api/session', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ principalId: event.target.value }),
                }).then(() => {
                  window.location.reload();
                });
              }}
              value={
                identity?.principals.find(
                  (principal) =>
                    principal.role === identity.session.role &&
                    principal.id.endsWith(identity.session.scopeId ?? 'national'),
                )?.id ??
                identity?.principals[0]?.id ??
                ''
              }
            >
              {(identity?.principals ?? []).map((principal) => (
                <option key={principal.id} value={principal.id}>
                  {principal.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">Facility</span>
            <select
              aria-label="Facility"
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
              onChange={(event) => {
                setFacilityId(event.target.value);
              }}
              value={facilityId}
            >
              {(visibility?.facilities ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({option.tier})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-slate-300">District</span>
            <select
              aria-label="District"
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
              onChange={(event) => {
                setDistrictId(event.target.value);
              }}
              value={districtId}
            >
              {(visibility?.districts ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} · {option.regionName}
                </option>
              ))}
            </select>
          </label>
          <p className="self-end text-sm text-slate-400" data-testid="sync-state">
            {outbox.online ? 'Connection available' : 'No connection'} ·{' '}
            {outbox.ready
              ? `${formatCount(outbox.pending)} ${outbox.pending === 1 ? 'change' : 'changes'} pending`
              : 'reading the queue'}
          </p>
          <p className="self-end text-sm text-slate-500" data-testid="shell-state">
            {SHELL_STATUS_TEXT[shell]}
          </p>
          <p className="self-end text-sm text-slate-500" data-testid="context-state">
            {CONTEXT_STATUS_TEXT[contextStatus]}
          </p>
        </div>
      </Panel>

      <Panel
        id="record"
        title="What are you recording?"
        description="The form validates against the platform's own schema, so a capture the platform would refuse is refused here first, with the same message."
      >
        <fieldset className="flex flex-wrap gap-3">
          <legend className="sr-only">Record kind</legend>
          {RECORD_KINDS.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer flex-col gap-1 rounded border border-slate-700 px-3 py-2 text-sm has-checked:border-sky-500 has-checked:bg-sky-500/10"
            >
              <span className="flex items-center gap-2">
                <input
                  checked={kind === option.id}
                  name="record-kind"
                  onChange={() => {
                    setKind(option.id);
                    setIssues([]);
                    setQueued(null);
                  }}
                  type="radio"
                  value={option.id}
                />
                <span className="text-slate-200">{option.label}</span>
              </span>
              <span className="text-xs text-slate-400">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kind !== 'bed_status' &&
          kind !== 'staff_attendance' &&
          kind !== 'footfall_observation' ? (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-slate-300">Day</span>
              <input
                className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                onChange={(event) => {
                  setField('occurredOn', event.target.value);
                }}
                type="date"
                value={fields.occurredOn}
              />
            </label>
          ) : null}

          {kind === 'stock_ledger_entry' ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Item</span>
                <select
                  aria-label="Item"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('itemId', event.target.value);
                  }}
                  value={selectedItem?.id ?? ''}
                >
                  {catalogue.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} {item.strength} ({item.form})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Movement</span>
                <select
                  aria-label="Movement"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('ledgerKind', event.target.value as LedgerEntryKind);
                  }}
                  value={fields.ledgerKind}
                >
                  {LEDGER_KINDS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Quantity ({selectedItem?.unit ?? 'units'})</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('quantity', event.target.value);
                  }}
                  type="number"
                  value={fields.quantity}
                />
              </label>
              {fields.ledgerKind === 'receipt' ? (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Batch</span>
                    <input
                      className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                      onChange={(event) => {
                        setField('batchId', event.target.value);
                      }}
                      placeholder="Lot number on the pack"
                      type="text"
                      value={fields.batchId}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-slate-300">Expires</span>
                    <input
                      className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                      onChange={(event) => {
                        setField('expiresOn', event.target.value);
                      }}
                      type="date"
                      value={fields.expiresOn}
                    />
                  </label>
                </>
              ) : null}
              {fields.ledgerKind === 'adjust' ? (
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-300">Direction</span>
                  <select
                    aria-label="Direction"
                    className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                    onChange={(event) => {
                      setField('adjustmentDirection', event.target.value as AdjustmentDirection);
                    }}
                    value={fields.adjustmentDirection}
                  >
                    <option value="decrease">decrease</option>
                    <option value="increase">increase</option>
                  </select>
                </label>
              ) : null}
            </>
          ) : null}

          {kind === 'bed_status' ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Beds</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('bedsTotal', event.target.value);
                  }}
                  placeholder={String(facility?.tier === 'CHC' ? 30 : 6)}
                  type="number"
                  value={fields.bedsTotal}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Occupied</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('bedsOccupied', event.target.value);
                  }}
                  type="number"
                  value={fields.bedsOccupied}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Day</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('occurredOn', event.target.value);
                  }}
                  type="date"
                  value={fields.occurredOn}
                />
              </label>
            </>
          ) : null}

          {kind === 'staff_attendance' ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Cadre</span>
                <select
                  aria-label="Cadre"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('cadre', event.target.value as Cadre);
                  }}
                  value={fields.cadre}
                >
                  {CADRES.map((cadre) => (
                    <option key={cadre} value={cadre}>
                      {cadre}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Sanctioned posts</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('postsSanctioned', event.target.value);
                  }}
                  type="number"
                  value={fields.postsSanctioned}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Posts filled</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('postsFilled', event.target.value);
                  }}
                  type="number"
                  value={fields.postsFilled}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Present today</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('presentToday', event.target.value);
                  }}
                  type="number"
                  value={fields.presentToday}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Day</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('occurredOn', event.target.value);
                  }}
                  type="date"
                  value={fields.occurredOn}
                />
              </label>
            </>
          ) : null}

          {kind === 'footfall_observation' ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Outpatients</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('opdCount', event.target.value);
                  }}
                  type="number"
                  value={fields.opdCount}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Inpatients</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('ipdCount', event.target.value);
                  }}
                  type="number"
                  value={fields.ipdCount}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Day</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('occurredOn', event.target.value);
                  }}
                  type="date"
                  value={fields.occurredOn}
                />
              </label>
            </>
          ) : null}

          {kind === 'syndromic_signal' ? (
            <>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Syndrome</span>
                <select
                  aria-label="Syndrome"
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('syndrome', event.target.value as Syndrome);
                  }}
                  value={fields.syndrome}
                >
                  {SYNDROMES.map((syndrome) => (
                    <option key={syndrome} value={syndrome}>
                      {syndrome}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Cases</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  inputMode="numeric"
                  onChange={(event) => {
                    setField('caseCount', event.target.value);
                  }}
                  type="number"
                  value={fields.caseCount}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-slate-300">Day</span>
                <input
                  className="rounded border border-slate-700 bg-slate-900 px-3 py-2"
                  onChange={(event) => {
                    setField('occurredOn', event.target.value);
                  }}
                  type="date"
                  value={fields.occurredOn}
                />
              </label>
            </>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            className="rounded bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50"
            disabled={busy || submission === null}
            onClick={() => {
              void submit();
            }}
            type="button"
          >
            Queue capture
          </button>
          <button
            className="rounded border border-slate-700 px-4 py-2 text-sm text-slate-200"
            onClick={outbox.retryNow}
            type="button"
          >
            Retry now
          </button>
          <span className="text-sm text-slate-400">
            {outbox.pending === 0
              ? 'Nothing waiting to sync'
              : `${formatCount(outbox.pending)} waiting to sync`}
          </span>
        </div>

        {queued !== null ? (
          <p className="mt-4 rounded border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-sky-100">
            Queued on this device: {queued}
          </p>
        ) : null}

        {issues.length > 0 ? (
          <div className="mt-4 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            <p className="font-medium">The platform would refuse this capture:</p>
            <ul className="mt-1 list-inside list-disc">
              {issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <span className="font-mono text-xs">{issue.path}</span> — {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel
        id="outbox"
        title="Changes on this device"
        description="The queue as it stands. A capture that the platform refuses stays here with the reason rather than being retried forever, because a disagreement with a stored record needs a person."
      >
        {outbox.items.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing has been captured on this device yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-800 rounded-lg border border-slate-800">
            {outbox.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-1 px-4 py-3"
                data-status={item.status}
                data-testid="outbox-item"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm text-slate-200">{item.label}</span>
                  <span
                    className={
                      item.status === 'delivered'
                        ? 'font-mono text-xs text-emerald-300'
                        : item.status === 'pending'
                          ? 'font-mono text-xs text-amber-300'
                          : 'font-mono text-xs text-rose-300'
                    }
                  >
                    {STATUS_WORDS[item.status]}
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  captured {item.createdAt} · {formatCount(item.attempts)} attempt
                  {item.attempts === 1 ? '' : 's'}
                  {item.lastError === null ? '' : ` · ${item.lastError}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {outbox.lastSummary === null ? null : (
          <p className="text-sm text-slate-400">
            Last sync: {formatCount(outbox.lastSummary.delivered)} recorded,{' '}
            {formatCount(outbox.lastSummary.refused)} refused,{' '}
            {formatCount(outbox.lastSummary.rejected)} not accepted,{' '}
            {formatCount(outbox.lastSummary.pending)} still waiting.
          </p>
        )}
      </Panel>
    </main>
  );
}
