import {
  CivoraError,
  PLATFORM_STAMP,
  completeSubmission,
  dateSchema,
  facilityIdSchema,
  ingestRequestSchema,
  itemIdSchema,
} from '@civora/domain';
import type { IngestRequest, IngestStamp } from '@civora/domain';
import { z } from 'zod';

import { parseCsv } from './csv';
import type { CsvTable } from './csv';

/**
 * The importer for a monthly HMIS stock statement.
 *
 * Health Management Information System returns are the monthly rhythm of the
 * Indian public health system: every facility sends counts up the administrative
 * chain, and the stock columns of that return are the only national picture of
 * consumption that exists outside a facility's own register. A platform that
 * cannot read one is a platform that asks a ministry to retype a decade of
 * returns, which is why this adapter exists.
 *
 * What arrives is a CSV with one row per facility, item and movement:
 *
 * ```
 * facility_code,month,item_code,movement,quantity,batch_no,expiry
 * SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,I,412,,
 * ```
 *
 * Five decisions are stated here rather than buried in the code, because each is
 * one a ministry would have an opinion about:
 *
 *  - **A month is not a day.** The return states a month and the ledger's
 *    granularity is a day, so a row dated `2026-08` is written on the **last day
 *    of that month** — the day by which the movement it totals had certainly
 *    happened. A deployment with daily extracts gets daily movements and does not
 *    need the rule; one with monthly returns gets an honest approximation that is
 *    visible in every date it writes.
 *  - **`I` is an issue and `R` is a receipt**, which is the vocabulary the returns
 *    use. Anything else is refused rather than mapped to the nearest guess.
 *  - **The facility and item codes are the platform's own identifiers.** The
 *    crosswalk from a government's codes to these is the directory adapter's job
 *    (`lgd.ts`) and the item catalogue's (`nlem.ts`), and doing it here as well
 *    would make two places answer the same question.
 *  - **A receipt names its batch and expiry or it is refused.** The ledger schema
 *    requires them for stock arriving at a facility, and inventing them would put
 *    an expiry the ministry never stated onto a batch somebody will later have to
 *    destroy.
 *  - **The month must be well formed**, because `2026-8` and `08/2026` both appear
 *    in real extracts and both mean something a reader would have to guess.
 *
 * The adapter produces ingest-shaped submissions — exactly the envelope a capture
 * surface sends — so the import goes through the same boundary, the same
 * idempotency keys and the same audit chain as a nurse's phone. Nothing about
 * being a government file makes a row more trustworthy.
 */

/** Months the extract may state. */
const monthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is stated as YYYY-MM');

const movementSchema = z.enum(['I', 'R']);
export type HmisMovement = z.infer<typeof movementSchema>;

export const HMIS_COLUMNS = [
  'facility_code',
  'month',
  'item_code',
  'movement',
  'quantity',
  'batch_no',
  'expiry',
] as const;

/**
 * Field-by-field correspondence between the published extract and this platform.
 *
 * Held as a value: a test asserts every column the reader requires appears here,
 * and `docs/INTEROP.md` prints the table rather than describing it.
 */
export const HMIS_FIELD_MAPPING: readonly {
  readonly source: string;
  readonly target: string;
  readonly note: string;
}[] = [
  {
    source: 'facility_code',
    target: 'submission.observation.facilityId',
    note: 'the platform’s facility identifier; the LGD crosswalk is how a deployment gets it',
  },
  {
    source: 'month',
    target: 'submission.observation.occurredOn',
    note: 'the last day of the month, because the return totals a month and the ledger holds days',
  },
  {
    source: 'item_code',
    target: 'submission.observation.itemId',
    note: 'the platform’s item identifier, as the NLEM importer builds it',
  },
  {
    source: 'movement',
    target: 'submission.observation.kind',
    note: 'I becomes issue and R becomes receipt; any other marker is refused',
  },
  {
    source: 'quantity',
    target: 'submission.observation.quantity',
    note: 'a positive whole number of dispensing units',
  },
  {
    source: 'batch_no',
    target: 'submission.observation.batchId',
    note: 'required on a receipt: stock arriving must name the batch it arrived in',
  },
  {
    source: 'expiry',
    target: 'submission.observation.expiresOn',
    note: 'required on a receipt, and must be after the day the movement belongs to',
  },
];

/** One row of the extract, validated. */
export const hmisRowSchema = z.strictObject({
  facilityId: facilityIdSchema,
  month: monthSchema,
  itemId: itemIdSchema,
  movement: movementSchema,
  quantity: z.coerce.number().int().positive(),
  batchId: z.string().trim().min(1).nullable(),
  expiresOn: dateSchema.nullable(),
});

export type HmisRow = z.infer<typeof hmisRowSchema>;

/** The movement a row states, in the platform's vocabulary. */
const KIND_BY_MOVEMENT = { I: 'issue', R: 'receipt' } as const;

/** The last day of `YYYY-MM`, which is the day a monthly total is written on. */
export const lastDayOfMonth = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number);
  if (year === undefined || monthNumber === undefined) {
    throw new CivoraError(`"${month}" is not a month`);
  }
  // Day zero of the next month is the last day of this one, which is how a
  // month's length falls out of the calendar rather than out of a table.
  const end = new Date(Date.UTC(year, monthNumber, 0));
  return end.toISOString().slice(0, 10);
};

export interface HmisExtract {
  /** The file's own header, so a caller can report what it read. */
  readonly header: readonly string[];
  readonly rows: readonly HmisRow[];
}

/**
 * Read the extract's rows.
 *
 * The parse is per row and it collects nothing: the first row that cannot be read
 * ends the import, naming the line. A partial import is the failure mode a
 * ministry cannot audit — half a month's returns in the ledger and no record of
 * which half — so there is no option to continue past a bad row.
 */
export function parseHmisExtract(text: string): HmisExtract {
  const table: CsvTable = parseCsv(text);

  const missing = HMIS_COLUMNS.filter((column) => !table.header.includes(column));
  if (missing.length > 0) {
    throw new CivoraError(
      `the extract is missing ${missing.join(', ')}; its header is ${table.header.join(', ')}`,
    );
  }

  const rows = table.rows.map((row, index) => {
    const line = index + 2;
    const parsed = hmisRowSchema.safeParse({
      facilityId: row.facility_code,
      month: row.month,
      itemId: row.item_code,
      movement: row.movement,
      quantity: row.quantity,
      batchId: row.batch_no === '' ? null : row.batch_no,
      expiresOn: row.expiry === '' ? null : row.expiry,
    });

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(row)'}: ${issue.message}`)
        .join('; ');
      throw new CivoraError(`line ${String(line)} of the extract cannot be read — ${detail}`);
    }

    const named = parsed.data;
    if (named.movement === 'R' && (named.batchId === null || named.expiresOn === null)) {
      throw new CivoraError(
        `line ${String(line)} records stock arriving without a batch and an expiry; the ledger requires both, and inventing them would put an expiry on a batch that has to be destroyed one day`,
      );
    }

    return named;
  });

  return { header: table.header, rows };
}

/**
 * One row as the envelope the ingest boundary accepts.
 *
 * The type is the boundary's own, read off its schema rather than written out
 * here: an adapter that declared its own copy of the contract would be a second
 * answer to what a submission is, and the copy is the one that would drift out of
 * agreement with the validator. The identifiers are derived from the row's own
 * content rather than generated, so importing the same file twice is the same
 * submissions twice — the boundary answers the second with the first's receipt,
 * and nothing is counted twice. That is the property the phase's "import
 * idempotency" asks for, and it comes from the same mechanism a flaky phone
 * connection uses.
 */
export type HmisSubmission = Extract<IngestRequest, { type: 'stock_ledger_entry' }>;

/** How one row is named in the ledger and in the receipt that answers a retry. */
export const hmisEntryId = (row: HmisRow, sourceId: string): string =>
  `import-${sourceId}-${row.facilityId}-${row.itemId}-${row.month}-${row.movement}`;

/**
 * Every row as the submission the boundary will decide.
 *
 * `completeSubmission` adds the platform's bookkeeping — the moment recorded, the
 * source, the stamp — the same way it completes a photograph's reading, and the
 * result is parsed through `ingestRequestSchema` before it leaves this function.
 * That ordering is the point: a row that cannot be written is refused **here**,
 * where its line number is still known, and not at the boundary, where it would
 * be a document nobody can trace back to a file. The stamp a caller passes is the
 * same one the write stamps its record with, so the submission and the record it
 * becomes agree about where the row came from.
 */
export function submissionsFor(
  extract: HmisExtract,
  context: {
    readonly sourceId: string;
    readonly receivedAt: string;
    readonly stamp?: IngestStamp | undefined;
  },
): readonly HmisSubmission[] {
  const stamp = context.stamp ?? PLATFORM_STAMP;

  return extract.rows.map((row) => {
    const entryId = hmisEntryId(row, context.sourceId);
    const submission = ingestRequestSchema.parse(
      completeSubmission(
        {
          type: 'stock_ledger_entry',
          idempotencyKey: `key-${entryId}`,
          captureSource: 'import',
          capturedAt: context.receivedAt,
          observation: {
            id: entryId,
            facilityId: row.facilityId,
            itemId: row.itemId,
            kind: KIND_BY_MOVEMENT[row.movement],
            quantity: row.quantity,
            adjustmentDirection: null,
            occurredOn: lastDayOfMonth(row.month),
            batchId: row.batchId,
            expiresOn: row.expiresOn,
            correctsEntryId: null,
            counterpartFacilityId: null,
            transferId: null,
          },
        },
        stamp,
      ),
    );

    // The literal written above is the only type this builder produces, so this
    // is the union's shape and not the file's. Stated rather than cast, so that
    // changing the literal becomes a refusal naming what it produced instead of a
    // record of the wrong kind.
    if (submission.type !== 'stock_ledger_entry') {
      throw new CivoraError(`a monthly return produced a ${submission.type} submission`);
    }

    return submission;
  });
}
