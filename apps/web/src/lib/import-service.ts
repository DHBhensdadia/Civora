import { createHash } from 'node:crypto';

import { importRecordSchema, provenanceSchema, syntheticSchema } from '@civora/domain';
import type { ImportFormat, ImportRecord } from '@civora/domain';
import { crosswalk, parseHmisExtract, parseLgdExtract, submissionsFor } from '@civora/interop';
import type { HmisSubmission, LgdImport } from '@civora/interop';
import { z } from 'zod';

import { actorOf, recordAuditEvent } from './audit-service';
import { applySubmission } from './ingest-boundary';
import { getLiveStore } from './live-store';
import { canImport, canSubmitForFacility, scopeRefusalFor } from './session';
import type { Session } from './session';

/**
 * Reading a file from a system that already exists.
 *
 * A ministry does not adopt a platform by retyping a decade of returns. It adopts
 * one by pointing it at the exports it already produces, which is why this flow is
 * a first-class surface rather than a script: choose the format, check the file,
 * accept it.
 *
 * Four properties are deliberate, and each is one a reviewer can check rather
 * than believe:
 *
 *  - **The dry run is the same code as the import.** A preview that computed its
 *    own answers could disagree with what the import then did, which is precisely
 *    the disagreement that makes a preview worthless. `applySubmission` takes a
 *    `dryRun` flag, so the decision a preview shows is the decision the write
 *    makes — including the rows the boundary *refuses*, which the preview names
 *    instead of counting as accepted.
 *  - **Scope is checked per row.** An import is not a way around the tenancy
 *    model: a district officer's file may name another district's facility, and
 *    that row is refused with the same sentence the capture surface gives.
 *  - **The file is identified by its bytes.** The digest is what a second upload
 *    of the same file matches, and the rows' identifiers are derived from their
 *    content, so re-importing is a replay rather than a second movement of the
 *    same stock. A file that changed by one character is a different file, and
 *    its rows are then decided on their merits.
 *  - **Nothing is recorded unless something changed.** An import whose rows are
 *    all already held appends no chain entry, because the trail is for what
 *    changed.
 */

/** Where accepted files are registered, and where an administrative crosswalk lands. */
export const IMPORT_COLLECTION = 'imports';
export const CODE_COLLECTION = 'administrativeCodes';

/**
 * The formats this surface reads.
 *
 * Narrower than the register's own vocabulary on purpose: `IMPORT_FORMATS` names
 * every format a record may carry, while this flow reads two of them. A route that
 * accepted a third would hand it to whichever reader the service falls through to,
 * which is the class of bug that looks like a working import until somebody opens
 * the ledger. The adapters this build does not ship are named as deferred in
 * `docs/INTEROP.md` rather than half-accepted here.
 */
export const IMPORT_FORMATS_OFFERED = [
  'hmis-csv',
  'lgd-json',
] as const satisfies readonly ImportFormat[];

/** A refusal the interface can show, with the status the route answers with. */
export class ImportRefused extends Error {
  readonly status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

export interface ImportRequest {
  readonly format: ImportFormat;
  /** The name the uploader's file carries. Evidence for the register, not identity. */
  readonly fileName: string;
  readonly text: string;
}

/** What became of one row, without writing anything. */
export type RowOutcome = 'write' | 'already-held' | 'refused';

export interface ImportRow {
  readonly index: number;
  readonly subjectId: string;
  readonly facilityId: string | null;
  readonly outcome: RowOutcome;
  /** The platform's own sentence: what it did, or why it would not. */
  readonly detail: string;
}

export interface ImportPreview {
  readonly format: ImportFormat;
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
  /** For an administrative extract: what joined, and what did not. */
  readonly crosswalk: {
    readonly matched: number;
    readonly unmatchedGovernment: readonly string[];
    readonly unmatchedPlatform: readonly string[];
  } | null;
  /** What the file states, and what the platform decided about it. */
  readonly notes: readonly string[];
}

/** The crosswalk as it is stored, one record per accepted directory extract. */
export const administrativeCodesSchema = z.strictObject({
  id: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  retrievedOn: z.iso.date(),
  codes: z.array(
    z.strictObject({
      districtId: z.string().trim().min(1),
      districtCode: z.string().trim().min(1),
      subdistricts: z.array(z.string().trim().min(1)),
    }),
  ),
  unmatchedGovernment: z.array(z.string()),
  unmatchedPlatform: z.array(z.string()),
  synthetic: syntheticSchema,
  provenance: provenanceSchema,
});

export type AdministrativeCodes = z.infer<typeof administrativeCodesSchema>;

const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The stamp an imported observation is stored with.
 *
 * Not the capture surface's: a row that arrived in a file says so, and names the
 * format it arrived in, so a reader of the record can tell a nurse's capture from
 * a ministry extract without opening the import register. `synthetic` stays true
 * because this build's world is generated — an extract of a real facility's
 * returns would carry the deployment's own stamp, and this is the one place that
 * decision is made.
 */
const stampFor = (format: ImportFormat, sourceId: string) =>
  ({
    synthetic: true,
    provenance: { kind: 'source', reference: `${format}:${sourceId}` },
  }) as const;

const importCollection = async () => {
  const store = await getLiveStore();
  return store.provider.collection(IMPORT_COLLECTION, importRecordSchema);
};

/** Every file the platform has accepted, oldest first. */
export async function readImports(): Promise<readonly ImportRecord[]> {
  return await (await importCollection()).list();
}

/** The crosswalk the platform stores for a district, when it has one. */
export async function readAdministrativeCodes(): Promise<readonly AdministrativeCodes[]> {
  const store = await getLiveStore();
  return await store.provider.collection(CODE_COLLECTION, administrativeCodesSchema).list();
}

const districtsOf = async () => {
  const store = await getLiveStore();
  return store.dataset.network.districts.map((district) => ({
    id: district.id,
    name: district.name,
    regionId: district.regionId,
  }));
};

/**
 * Run a parser that refuses documents by throwing, and turn its refusal into the
 * one shape this flow shows: a sentence naming what could not be read.
 */
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new ImportRefused(
      `the file cannot be read — ${error instanceof Error ? error.message : String(error)}`,
      400,
    );
  }
}

interface Decision {
  readonly preview: ImportPreview;
  /** Where the file's records go, if it is accepted. */
  readonly writes: readonly HmisSubmission[];
  readonly codeRecord: AdministrativeCodes | null;
}

/**
 * Decide one file, once.
 *
 * Both the preview and the import call this. The preview throws away the writes
 * it decided and the import performs them, which is what keeps the two from
 * disagreeing.
 */
async function decide(
  session: Session,
  request: ImportRequest,
  options: { readonly dryRun: boolean },
): Promise<Decision> {
  if (!canImport(session)) {
    throw new ImportRefused(
      `${session.label} is scoped to a place, and an import writes rows the platform did not hear from that place; a file is imported by a district officer and above`,
    );
  }

  if (!(IMPORT_FORMATS_OFFERED as readonly string[]).includes(request.format)) {
    throw new ImportRefused(
      `this surface reads the HMIS monthly statement and the directory extract; a \`${request.format}\` file is not one of them`,
      415,
    );
  }

  const store = await getLiveStore();
  const digest = digestOf(request.text);
  const receivedAt = new Date().toISOString();

  if (request.format === 'lgd-json') {
    const directory: LgdImport = parsed(() => parseLgdExtract(JSON.parse(request.text) as unknown));
    const walked = crosswalk(directory, await districtsOf());
    const id = `codes-${digest.slice(0, 12)}`;

    const codeRecord: AdministrativeCodes = administrativeCodesSchema.parse({
      id,
      sourceId: directory.sourceId,
      retrievedOn: directory.retrievedOn,
      codes: walked.codes.map((entry) => ({
        districtId: entry.districtId,
        districtCode: entry.districtCode,
        subdistricts: entry.subdistricts.map((subdistrict) => subdistrict.code),
      })),
      unmatchedGovernment: walked.unmatchedGovernment,
      unmatchedPlatform: walked.unmatchedPlatform,
      synthetic: true,
      provenance: { kind: 'source', reference: `lgd-json:${directory.sourceId}` },
    });

    return {
      preview: {
        format: request.format,
        fileName: request.fileName,
        digest,
        sourceId: directory.sourceId,
        title: directory.title,
        retrievedOn: directory.retrievedOn,
        rowsRead: directory.units.length,
        counts: { write: walked.codes.length, alreadyHeld: 0, refused: 0 },
        rows: walked.codes.map((entry, index) => ({
          index,
          subjectId: entry.districtId,
          facilityId: null,
          outcome: 'write' as const,
          detail: `files under district code ${entry.districtCode}, ${String(entry.subdistricts.length)} sub-district(s)`,
        })),
        crosswalk: {
          matched: walked.codes.length,
          unmatchedGovernment: walked.unmatchedGovernment,
          unmatchedPlatform: walked.unmatchedPlatform,
        },
        notes: [
          `the directory states ${String(directory.units.length)} unit(s), retrieved ${directory.retrievedOn}`,
          'an administrative extract writes no ledger entries: it records which government code each of this platform’s districts files under, and names what did not join either way',
        ],
      },
      writes: [],
      codeRecord,
    };
  }

  const extract = parsed(() => parseHmisExtract(request.text));
  const sourceId = digest.slice(0, 12);
  const stamp = stampFor(request.format, sourceId);
  // The submission and the record it becomes are stamped by the same value, so
  // the row's own provenance and the stored record's cannot disagree.
  const submissions = submissionsFor(extract, { sourceId, receivedAt, stamp });

  const rows: ImportRow[] = [];
  const writes: HmisSubmission[] = [];
  const counts = { write: 0, alreadyHeld: 0, refused: 0 };

  for (const [index, submission] of submissions.entries()) {
    const facilityId = submission.observation.facilityId;

    if (!canSubmitForFacility(session, facilityId, store.scope)) {
      counts.refused += 1;
      rows.push({
        index,
        subjectId: submission.observation.id,
        facilityId,
        outcome: 'refused',
        detail: scopeRefusalFor(session, 'facility'),
      });
      continue;
    }

    const applied = await applySubmission(store, submission, receivedAt, actorOf(session), {
      stamp,
      dryRun: options.dryRun,
    });
    const decision = applied.decision;

    if (decision.record !== null) {
      counts.write += 1;
      writes.push(submission);
      rows.push({
        index,
        subjectId: submission.observation.id,
        facilityId,
        outcome: 'write',
        detail: `${submission.observation.kind} ${String(submission.observation.quantity)} on ${submission.observation.occurredOn}`,
      });
      continue;
    }

    if (decision.outcome === 'conflict') {
      counts.refused += 1;
      rows.push({
        index,
        subjectId: submission.observation.id,
        facilityId,
        outcome: 'refused',
        detail: decision.detail,
      });
      continue;
    }

    counts.alreadyHeld += 1;
    rows.push({
      index,
      subjectId: submission.observation.id,
      facilityId,
      outcome: 'already-held',
      detail: decision.detail,
    });
  }

  return {
    preview: {
      format: request.format,
      fileName: request.fileName,
      digest,
      sourceId: digest.slice(0, 12),
      title: 'HMIS monthly stock statement',
      retrievedOn: null,
      rowsRead: submissions.length,
      counts,
      rows,
      crosswalk: null,
      notes: [
        'a monthly return states a month, so each row is written on the last day of that month — the day by which the movement it totals had certainly happened',
        'the rows go through the same boundary a capture surface uses, so a row the ledger already holds is answered rather than written twice',
        'a receipt must name its batch and expiry, and a file that omits them is refused rather than completed by the platform',
      ],
    },
    writes,
    codeRecord: null,
  };
}

/** Decide a file without writing it: what a reader checks before accepting. */
export async function previewImport(
  session: Session,
  request: ImportRequest,
): Promise<ImportPreview> {
  return (await decide(session, request, { dryRun: true })).preview;
}

export interface ImportOutcome {
  readonly record: ImportRecord;
  readonly preview: ImportPreview;
  /** Whether anything changed, which is whether the chain gained an entry. */
  readonly wrote: boolean;
  /** The chain entry, when there was something to record. */
  readonly auditId: string | null;
}

/**
 * Accept a file: write its records, register the file, record the act.
 *
 * The register entry is written before the chain entry, so a reader of the chain
 * can always open the register record it names — and a failure between the two
 * leaves a file whose rows are visible and whose acceptance is visibly
 * unrecorded, rather than the reverse.
 */
export async function acceptImport(
  session: Session,
  request: ImportRequest,
): Promise<ImportOutcome> {
  const decision = await decide(session, request, { dryRun: false });
  const { preview } = decision;
  const store = await getLiveStore();

  if (decision.codeRecord !== null) {
    await store.provider
      .collection(CODE_COLLECTION, administrativeCodesSchema)
      .set(decision.codeRecord.id, decision.codeRecord);
  }

  const already = (await readImports()).find((record) => record.digest === preview.digest);
  const writtenNow = decision.codeRecord === null ? decision.writes.length : 0;
  const changed = decision.codeRecord !== null || writtenNow > 0;

  const record: ImportRecord = importRecordSchema.parse({
    id: already?.id ?? `import-${preview.digest.slice(0, 12)}`,
    format: preview.format,
    fileName: preview.fileName,
    digest: preview.digest,
    sourceId: preview.sourceId,
    title: preview.title,
    retrievedOn: preview.retrievedOn,
    rowsRead: preview.rowsRead,
    // Accumulated rather than replaced: a file may be accepted more than once —
    // a district officer's rows first, the rest by someone whose scope covers
    // them — and the register answers "what has this file written here", which
    // is the union of the acceptances rather than the last one's share.
    rowsWritten: (already?.rowsWritten ?? 0) + writtenNow,
    rowsAlreadyHeld: preview.counts.alreadyHeld,
    rowsRejected: preview.counts.refused,
    actorUid: session.label,
    actorRole: session.role,
    acceptedAt: new Date().toISOString(),
    synthetic: true,
    provenance: {
      kind: 'source',
      reference: `${preview.format}:${preview.sourceId ?? 'unnamed'}`,
    },
  });
  await (await importCollection()).set(record.id, record);

  if (!changed) {
    return { record, preview, wrote: false, auditId: null };
  }

  const event = await recordAuditEvent({
    actor: actorOf(session),
    action: 'import-accepted',
    subjectType: 'import',
    subjectId: record.id,
    reason: `${record.fileName} · ${record.format} · digest ${record.digest.slice(0, 12)}`,
    before:
      already === undefined
        ? null
        : `${String(already.rowsWritten)} entry(s) already accepted from this file`,
    after:
      decision.codeRecord === null
        ? `${String(writtenNow)} entr${writtenNow === 1 ? 'y' : 'ies'} written with source import`
        : `${String(preview.crosswalk?.matched ?? 0)} district(s) given a government code`,
  });

  return { record, preview, wrote: true, auditId: event.id };
}
