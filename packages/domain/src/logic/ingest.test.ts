import { describe, expect, it } from 'vitest';

import { CAPTURE_SOURCES, CLIENT_CAPTURE_SOURCES } from '../model/common';
import { ingestRequestSchema } from '../model/ingest';
import type { IngestReceipt, IngestRequest, Observation } from '../model/ingest';
import { aBedIngestRequest, aBedReport, aLedgerEntry } from '../testing/factories';
import { assertCaptureTimePlausible, decideIngest, fieldDifferences, subjectKeyOf } from './ingest';
import type { IngestDecision, IngestStamp } from './ingest';

/**
 * The offline contract, tested as rules.
 *
 * Every assertion here is about a case that actually happens in the field: a
 * device retrying a write it is not sure landed, two devices reporting the same
 * day, a device whose clock is wrong, and a facility that contradicts itself. If
 * any of these are handled by luck rather than by rule, the first week of real
 * use finds out.
 */

/** What this build stamps on what it stores. */
const STAMP: IngestStamp = {
  synthetic: true,
  provenance: { kind: 'simulated', reference: 'capture-surface' },
};

const RECEIVED_AT = '2026-01-01T10:00:00.000Z';

interface DecideInput {
  readonly request: IngestRequest;
  readonly existingReceipt?: IngestReceipt | null;
  readonly existingRecord?: Observation | null;
}

const decide = (input: DecideInput): IngestDecision =>
  decideIngest({
    request: input.request,
    receivedAt: RECEIVED_AT,
    existingReceipt: input.existingReceipt ?? null,
    existingRecord: input.existingRecord ?? null,
    stamp: STAMP,
    conflictId: 'conflict-1',
  });

describe('the identity of an observation', () => {
  it('is the type, the facility and whatever else identifies it', () => {
    expect(subjectKeyOf('bed_status', aBedReport())).toBe('bed_status|facility-a|2026-01-01');
    expect(subjectKeyOf('stock_ledger_entry', aLedgerEntry())).toBe(
      'stock_ledger_entry|facility-a|entry-1',
    );
    // Two staff records on one day differ by cadre, and two syndromic counts by
    // syndrome, so the key has to carry the dimension rather than just the day.
    expect(
      subjectKeyOf('staff_attendance', {
        facilityId: 'facility-a',
        observedOn: '2026-01-01',
        cadre: 'staff_nurse',
      }),
    ).toBe('staff_attendance|facility-a|2026-01-01|staff_nurse');
    expect(
      subjectKeyOf('syndromic_signal', {
        facilityId: 'facility-a',
        observedOn: '2026-01-01',
        syndrome: 'fever',
      }),
    ).toBe('syndromic_signal|facility-a|2026-01-01|fever');
  });

  it('refuses to invent a key from a record that is missing one', () => {
    // A missing identity field would otherwise produce a key that quietly
    // collides with every other incomplete record.
    expect(() => subjectKeyOf('bed_status', { facilityId: 'facility-a' })).toThrow(/observedOn/);
  });

  it('refuses an identifier that could be made to look like another record', () => {
    // Keys are built by joining parts, so a facility identifier containing the
    // separator could be crafted to produce a different facility's key.
    expect(() =>
      subjectKeyOf('bed_status', {
        facilityId: 'facility-a|2026-01-01',
        observedOn: '2026-01-01',
      }),
    ).toThrow(/facilityId/);
  });
});

describe('what two versions of a report disagree about', () => {
  it('reports nothing when the observed world is the same, whatever the bookkeeping says', () => {
    const stored = aBedReport({
      idempotencyKey: 'key-beds-1',
      recordedAt: '2026-01-01T09:00:00.000Z',
    });
    const resubmitted = aBedReport({
      idempotencyKey: 'key-beds-2',
      recordedAt: '2026-01-01T11:00:00.000Z',
      captureSource: 'vision',
    });

    expect(fieldDifferences(stored, resubmitted)).toEqual([]);
  });

  it('names every field that differs, with both values', () => {
    const stored = aBedReport({ bedsTotal: 6, bedsOccupied: 4 });
    const submitted = aBedReport({ bedsTotal: 8, bedsOccupied: 5 });

    expect(fieldDifferences(stored, submitted)).toEqual([
      { field: 'bedsOccupied', stored: '4', submitted: '5' },
      { field: 'bedsTotal', stored: '6', submitted: '8' },
    ]);
  });
});

describe('deciding what to do with a submission', () => {
  it('stores a new observation, stamped by the platform rather than by the client', () => {
    const decision = decide({ request: aBedIngestRequest() });

    expect(decision.outcome).toBe('accepted');
    expect(decision.conflict).toBeNull();
    expect(decision.receipt.outcome).toBe('accepted');
    expect(decision.receipt.receivedAt).toBe(RECEIVED_AT);

    // The device's capture time becomes the record time; the server's time is
    // kept on the receipt, which is what a conflict is ordered by.
    expect(decision.record?.recordedAt).toBe('2026-01-01T09:00:00.000Z');
    expect(decision.record?.captureSource).toBe('manual');
    expect(decision.record?.synthetic).toBe(true);
  });

  it('lets the platform, not the submitter, decide whether a record is simulated', () => {
    // A client that could label its own data as generated could have it treated
    // as unusable; one that could label it real could have it believed.
    const decision = decideIngest({
      request: aBedIngestRequest({
        observation: aBedReport({
          synthetic: true,
          provenance: { kind: 'source', reference: 'clinical-register' },
        }),
      }),
      receivedAt: RECEIVED_AT,
      existingReceipt: null,
      existingRecord: null,
      stamp: { synthetic: false, provenance: { kind: 'source', reference: 'facility-capture' } },
      conflictId: 'conflict-1',
    });

    expect(decision.record?.synthetic).toBe(false);
    expect(decision.record?.provenance).toEqual({
      kind: 'source',
      reference: 'facility-capture',
    });
  });

  it('answers a retry from the receipt instead of processing it again', () => {
    const first = decide({ request: aBedIngestRequest() });
    const retry = decide({ request: aBedIngestRequest(), existingReceipt: first.receipt });

    expect(retry.outcome).toBe('replayed');
    expect(retry.record).toBeNull();
    expect(retry.conflict).toBeNull();
    // The first attempt's answer, not a new one: a response that changed on
    // retry would itself be non-idempotent.
    expect(retry.receipt).toBe(first.receipt);
  });

  it('replays rather than conflicts when the same key carries different contents', () => {
    // The client reused its key, so it is asking to be treated as a retry. The
    // alternative — deciding by content — would let a retry mutate the record.
    const first = decide({ request: aBedIngestRequest() });
    const retry = decide({
      request: aBedIngestRequest({
        observation: aBedReport({ bedsOccupied: 5 }),
      }),
      existingReceipt: first.receipt,
    });

    expect(retry.outcome).toBe('replayed');
    expect(retry.conflict).toBeNull();
  });

  it('treats a second delivery of the same observation as a duplicate, not a conflict', () => {
    const decision = decide({
      request: aBedIngestRequest({
        idempotencyKey: 'key-beds-2',
        observation: aBedReport({ idempotencyKey: 'key-beds-2' }),
      }),
      existingRecord: aBedReport({ idempotencyKey: 'key-beds-1' }),
    });

    expect(decision.outcome).toBe('duplicate');
    expect(decision.record).toBeNull();
    expect(decision.conflict).toBeNull();
    expect(decision.receipt.outcome).toBe('duplicate');
  });

  it('records a disagreement per field and leaves the stored record standing', () => {
    const decision = decide({
      request: aBedIngestRequest({
        idempotencyKey: 'key-beds-2',
        observation: aBedReport({ idempotencyKey: 'key-beds-2', bedsOccupied: 6 }),
      }),
      existingRecord: aBedReport({ idempotencyKey: 'key-beds-1' }),
    });

    expect(decision.outcome).toBe('conflict');
    expect(decision.record).toBeNull();
    expect(decision.receipt.outcome).toBe('conflict');

    const conflict = decision.conflict!;
    expect(conflict.resolution).toBe('stored-record-wins');
    expect(conflict.differences).toEqual([{ field: 'bedsOccupied', stored: '4', submitted: '6' }]);
    // Both keys are kept: the one that won and the one that was refused, so a
    // reviewer can find what each device actually sent.
    expect(conflict.storedIdempotencyKey).toBe('key-beds-1');
    expect(conflict.submittedIdempotencyKey).toBe('key-beds-2');
    expect(conflict.reason).toMatch(/evidence/);
  });
});

describe('a device clock that cannot be believed', () => {
  it('tolerates the skew every device has', () => {
    expect(() => {
      assertCaptureTimePlausible('2026-01-01T10:01:00.000Z', RECEIVED_AT);
    }).not.toThrow();
    expect(() => {
      assertCaptureTimePlausible('2025-12-24T08:00:00.000Z', RECEIVED_AT);
    }).not.toThrow();
  });

  it('refuses a record captured in the future, because it cannot be ordered against anything', () => {
    expect(() => {
      assertCaptureTimePlausible('2026-01-02T10:00:00.000Z', RECEIVED_AT);
    }).toThrow(/device clock/);
  });
});

describe('the sources a client may claim', () => {
  it('excludes simulation, and excludes nothing else', () => {
    // Written as two lists rather than derived, so this is the assertion that
    // keeps them from drifting apart.
    expect(CAPTURE_SOURCES.filter((source) => source !== 'simulation')).toEqual([
      ...CLIENT_CAPTURE_SOURCES,
    ]);
  });

  it('refuses an upload that claims to be simulated', () => {
    const result = ingestRequestSchema.safeParse({
      ...aBedIngestRequest(),
      captureSource: 'simulation',
    });

    expect(result.success).toBe(false);
  });
});
