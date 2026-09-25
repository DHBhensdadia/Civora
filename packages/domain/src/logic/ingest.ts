import type { ZodType } from 'zod';

import { CivoraError } from '../errors';
import type { Instant, Provenance } from '../model/common';
import { ingestReceiptSchema, ingestRequestSchema, syncConflictSchema } from '../model/ingest';
import type {
  FieldDifference,
  IngestReceipt,
  IngestRequest,
  Observation,
  ObservationType,
  SyncConflict,
} from '../model/ingest';
import {
  bedStatusSchema,
  footfallObservationSchema,
  staffAttendanceSchema,
  stockLedgerEntrySchema,
  syndromicSignalSchema,
} from '../model/sensing';

/**
 * What the platform does with a submission, decided without touching a store.
 *
 * Everything here is a pure function of the submission and what is already
 * stored, so the rules the whole offline story rests on can be tested as rules
 * rather than through a database. Three of them matter:
 *
 *  1. **Same key, seen before → replay.** The stored answer is returned and
 *     nothing is written. A retry is the normal case, not the exceptional one:
 *     an outbox retries on any network error, and a client that cannot tell
 *     whether its write landed will send it again.
 *  2. **New key, same observation, same contents → duplicate.** Nothing is
 *     written, and no conflict is raised, because agreeing twice is not
 *     disagreeing.
 *  3. **New key, same observation, different contents → conflict.** The stored
 *     record stands, the disagreement is recorded per field, and the submission
 *     is refused. An observation is never overwritten: what a facility reported
 *     is evidence, and evidence that silently changes is not evidence.
 */

/** How the platform decided a submission should be treated. */
export const INGEST_OUTCOMES = ['accepted', 'replayed', 'duplicate', 'conflict'] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

/**
 * Where each observation type is stored.
 *
 * A storage address in a domain module, which is unusual and deliberate: two
 * writers exist — the seeder that generates the demonstration dataset and the
 * ingest boundary that accepts a real one — and if they disagree about where a
 * bed report lives, the platform has two half-empty collections and no error.
 * One table, one place to change.
 */
export const OBSERVATION_COLLECTIONS = {
  stock_ledger_entry: 'stockLedgerEntries',
  bed_status: 'bedStatuses',
  staff_attendance: 'staffAttendance',
  footfall_observation: 'footfallObservations',
  syndromic_signal: 'syndromicSignals',
} as const satisfies Record<ObservationType, string>;

/** Every collection an observation can be stored in. */
export type ObservationCollection = (typeof OBSERVATION_COLLECTIONS)[ObservationType];

/**
 * How each observation type is validated on the way out of storage.
 *
 * The third column of the same table. A reader of a stored observation has to
 * know its shape as well as its address, and looking both up from the type the
 * client declared is what stops a route handler from carrying its own copy of
 * the mapping.
 *
 * Annotated with the union rather than left inferred so that a caller holding a
 * type as a *value* can use the lookup at all: inferred, the table is a union of
 * five schemas and indexing it gives a union back, which no store can be asked
 * to validate against. Widened, it says what is true — every member validates
 * some member of the union — and the store still validates on the way in, so a
 * record filed under the wrong type is a rejected write rather than a corrupt
 * document.
 */
export const OBSERVATION_SCHEMAS: Readonly<Record<ObservationType, ZodType<Observation>>> = {
  stock_ledger_entry: stockLedgerEntrySchema,
  bed_status: bedStatusSchema,
  staff_attendance: staffAttendanceSchema,
  footfall_observation: footfallObservationSchema,
  syndromic_signal: syndromicSignalSchema,
};

/** The keys the ingest receipt and the conflict record are filed under. */
export const RECEIPT_COLLECTION = 'ingestReceipts';
export const CONFLICT_COLLECTION = 'syncConflicts';

/**
 * The fields that identify an observation, beyond the facility it belongs to.
 *
 * Read as data rather than written as five near-identical functions, so the key
 * scheme is one table a reader can check against the schemas.
 */
const IDENTITY_FIELDS: Readonly<Record<ObservationType, readonly string[]>> = {
  stock_ledger_entry: ['id'],
  bed_status: ['observedOn'],
  footfall_observation: ['observedOn'],
  staff_attendance: ['observedOn', 'cadre'],
  syndromic_signal: ['observedOn', 'syndrome'],
};

/**
 * The separator between the parts of a subject key.
 *
 * A pipe, because no identifier this platform generates contains one — and a
 * part that did contain one could be made to produce another record's key by
 * concatenation. The guard in `readField` is the second half of that defence:
 * the boundary refuses such an identifier rather than escaping it and hoping the
 * escaping round-trips.
 */
const SEPARATOR = '|';

/**
 * Reads a named property from a record of any shape.
 *
 * `Reflect.get` rather than a cast: the identity fields differ per type, and one
 * guarded read is easier to trust than five assertions.
 */
const readField = (record: object, field: string): string => {
  const value: unknown = Reflect.get(record, field);
  if (typeof value !== 'string') {
    throw new CivoraError(`an observation's identity field "${field}" is missing or not a string`);
  }
  if (value.includes(SEPARATOR)) {
    throw new CivoraError(
      `an observation's ${field} may not contain "${SEPARATOR}", because a subject key is built by joining these parts`,
    );
  }
  return value;
};

/**
 * The identity of an observation: what makes two submissions about the same
 * thing rather than two different things.
 *
 * Not the idempotency key, which is per *submission*. This is the key that lets
 * a second submission find the record the first one stored.
 */
export const subjectKeyOf = (type: ObservationType, observation: object): string =>
  [
    type,
    readField(observation, 'facilityId'),
    ...IDENTITY_FIELDS[type].map((field) => readField(observation, field)),
  ].join(SEPARATOR);

export const subjectKeyOfRequest = (request: IngestRequest): string =>
  subjectKeyOf(request.type, request.observation);

/**
 * Fields that describe how a record arrived rather than what was observed.
 *
 * Two submissions of the same bed count from two devices will differ in all of
 * these and disagree about nothing.
 */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'recordedAt',
  'captureSource',
  'synthetic',
  'provenance',
]);

const describeValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);

/**
 * The fields two versions of an observation disagree about.
 *
 * Returned as differences rather than a boolean so that a conflict can say what
 * changed. A platform that reports "these two contradict each other" without
 * saying how leaves the officer to compare two forms by eye.
 */
export const fieldDifferences = (stored: object, submitted: object): readonly FieldDifference[] => {
  const fields = [...new Set([...Object.keys(stored), ...Object.keys(submitted)])]
    .filter((field) => !BOOKKEEPING_FIELDS.has(field))
    .sort();

  const differences: FieldDifference[] = [];
  for (const field of fields) {
    const before = describeValue(Reflect.get(stored, field));
    const after = describeValue(Reflect.get(submitted, field));
    if (before !== after) {
      differences.push({ field, stored: before, submitted: after });
    }
  }
  return differences;
};

/**
 * How this build labels what it stores.
 *
 * Passed in rather than read from a clock or a global, and applied to the record
 * *after* the client's payload, so a client cannot state whether its own data is
 * real. In this build everything is generated by the simulator, including what
 * arrives through the capture surface; a deployment with real facilities flips
 * one configuration value and the same code path stores real observations.
 */
export interface IngestStamp {
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

/**
 * What the decision is made against.
 *
 * Generic in the request so that the decision carries the record type the
 * submission declared: a caller that has already narrowed a submission to a bed
 * report gets a bed report back, and storing it is a call the compiler checks
 * rather than an assertion the caller has to be trusted about.
 */
export interface IngestContext<T extends IngestRequest = IngestRequest> {
  readonly request: T;
  /** The server's clock, which is authoritative over every device's. */
  readonly receivedAt: Instant;
  /** The receipt already recorded for this idempotency key, if any. */
  readonly existingReceipt: IngestReceipt | null;
  /** The record already stored at this submission's subject key, if any. */
  readonly existingRecord: T['observation'] | null;
  readonly stamp: IngestStamp;
  /** Allocated by the caller so that this function stays pure. */
  readonly conflictId: string;
}

export interface IngestDecision<T extends IngestRequest = IngestRequest> {
  readonly outcome: IngestOutcome;
  /** The record to store. Present only when the outcome is `accepted`. */
  readonly record: T['observation'] | null;
  readonly receipt: IngestReceipt;
  /** Present only when the outcome is `conflict`. */
  readonly conflict: SyncConflict | null;
  /** Why, in a sentence a caller can log or show. */
  readonly detail: string;
}

/**
 * The stored form of a submission.
 *
 * Re-validated through the envelope rather than assembled with a cast, so a
 * record written by this path is schema-valid by construction: if stamping could
 * produce something the schema rejects, that is a bug here and not a corrupt
 * document discovered later.
 */
const stamped = <T extends IngestRequest>(request: T, stamp: IngestStamp): T['observation'] =>
  ingestRequestSchema.parse({
    ...request,
    observation: {
      ...request.observation,
      captureSource: request.captureSource,
      recordedAt: request.capturedAt,
      synthetic: stamp.synthetic,
      provenance: stamp.provenance,
    },
  }).observation as T['observation'];

export function decideIngest<T extends IngestRequest = IngestRequest>(
  context: IngestContext<T>,
): IngestDecision<T> {
  const { request, receivedAt, existingReceipt, existingRecord, stamp } = context;
  const subjectKey = subjectKeyOfRequest(request);
  const facilityId = request.observation.facilityId;

  const receiptFor = (outcome: IngestReceipt['outcome']): IngestReceipt =>
    ingestReceiptSchema.parse({
      idempotencyKey: request.idempotencyKey,
      type: request.type,
      facilityId,
      subjectKey,
      outcome,
      receivedAt,
      captureSource: request.captureSource,
      synthetic: stamp.synthetic,
      provenance: stamp.provenance,
    });

  // A retry is answered with what the first attempt produced, including the
  // moment it was processed and whether it was refused. Answering differently
  // the second time would make the response itself non-idempotent.
  if (existingReceipt !== null) {
    return {
      outcome: 'replayed',
      record: null,
      receipt: existingReceipt,
      conflict: null,
      detail: `this submission was already processed at ${existingReceipt.receivedAt} and decided as "${existingReceipt.outcome}"`,
    };
  }

  if (existingRecord === null) {
    return {
      outcome: 'accepted',
      record: stamped(request, stamp),
      receipt: receiptFor('accepted'),
      conflict: null,
      detail: 'stored',
    };
  }

  const differences = fieldDifferences(existingRecord, request.observation);

  if (differences.length === 0) {
    return {
      outcome: 'duplicate',
      record: null,
      receipt: receiptFor('duplicate'),
      conflict: null,
      detail: 'the same observation is already stored, so this delivery added nothing',
    };
  }

  const conflict = syncConflictSchema.parse({
    id: context.conflictId,
    type: request.type,
    facilityId,
    subjectKey,
    storedIdempotencyKey: existingRecord.idempotencyKey,
    submittedIdempotencyKey: request.idempotencyKey,
    differences,
    resolution: 'stored-record-wins',
    reason:
      'the stored record was accepted first, and a reported observation is evidence: overwriting it would leave a supervisor unable to see what the facility actually sent',
    detectedAt: receivedAt,
    synthetic: stamp.synthetic,
    provenance: stamp.provenance,
  });

  return {
    outcome: 'conflict',
    record: null,
    receipt: receiptFor('conflict'),
    conflict,
    detail: `this submission disagrees with the stored record about ${differences
      .map((difference) => difference.field)
      .join(', ')}; the stored record stands and the disagreement has been recorded`,
  };
}

/**
 * How far a device's clock may run ahead of the server's before a record is
 * refused.
 *
 * A capture stamped in the future cannot be ordered against anything, and in a
 * ledger it would let a facility's stock move on a day that has not happened. A
 * few minutes of skew is ordinary; a day is a wrong clock, and the difference
 * matters because a plausible-looking wrong timestamp is worse than a rejection.
 */
export const CAPTURE_CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export function assertCaptureTimePlausible(capturedAt: Instant, receivedAt: Instant): void {
  const skewMs = Date.parse(capturedAt) - Date.parse(receivedAt);
  if (skewMs > CAPTURE_CLOCK_TOLERANCE_MS) {
    throw new CivoraError(
      `a record cannot be captured ${String(Math.round(skewMs / 1000))}s after it was received; check the device clock`,
    );
  }
}
