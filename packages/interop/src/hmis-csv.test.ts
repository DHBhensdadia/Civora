import { CivoraError, ingestRequestSchema } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  HMIS_COLUMNS,
  HMIS_FIELD_MAPPING,
  hmisEntryId,
  lastDayOfMonth,
  parseHmisExtract,
  submissionsFor,
} from './hmis-csv';

/**
 * The monthly extract, read the way a ministry's file arrives.
 *
 * A CSV as text, not a typed value, because that is the only shape this importer
 * will ever be handed. Four things are asserted: the rows come out with the
 * movement the extract's own markers mean; a month becomes a day by a stated rule
 * rather than by whatever `Date` does; a row that cannot be read stops the import
 * and says which line; and importing the same file twice produces the same
 * submissions, which is what makes a second import a replay rather than a second
 * movement of the same stock.
 */

const EXTRACT = [
  'facility_code,month,item_code,movement,quantity,batch_no,expiry',
  'SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,I,412,,',
  'SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,R,900,B-77,2027-06-30',
  'SIM-BIHAR-GAYA-B1-SHC-01,2026-02,nlem-19-4-1-rabies-vaccine,I,12,,',
  '',
].join('\n');

describe('reading the extract', () => {
  it('reads every row, with the movement the extract states', () => {
    const extract = parseHmisExtract(EXTRACT);

    expect(extract.rows).toHaveLength(3);
    expect(extract.rows[0]?.movement).toBe('I');
    expect(extract.rows[1]?.movement).toBe('R');
    expect(extract.rows[1]?.quantity).toBe(900);
    expect(extract.rows[1]?.batchId).toBe('B-77');
  });

  it('dates a monthly total on the last day the movement had certainly happened by', () => {
    const extract = parseHmisExtract(EXTRACT);
    const submissions = submissionsFor(extract, {
      sourceId: 'hmis-demo',
      receivedAt: '2026-09-01T04:00:00.000Z',
    });

    // August is the 31st, February in a non-leap year is the 28th, and neither is
    // a table of month lengths: the rule is the calendar's.
    expect(submissions[0]?.observation.occurredOn).toBe('2026-08-31');
    expect(submissions[2]?.observation.occurredOn).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
  });

  it('maps the markers to the ledger’s own kinds, and carries the import source', () => {
    const submissions = submissionsFor(parseHmisExtract(EXTRACT), {
      sourceId: 'hmis-demo',
      receivedAt: '2026-09-01T04:00:00.000Z',
    });

    expect(submissions[0]?.observation.kind).toBe('issue');
    expect(submissions[1]?.observation.kind).toBe('receipt');
    expect(submissions.every((submission) => submission.captureSource === 'import')).toBe(true);
  });

  it('names a row from its own content, so importing a file twice is a replay', () => {
    const extract = parseHmisExtract(EXTRACT);
    const context = { sourceId: 'hmis-demo', receivedAt: '2026-09-01T04:00:00.000Z' } as const;

    const first = submissionsFor(extract, context);
    const second = submissionsFor(extract, context);

    expect(second.map((each) => each.observation.id)).toEqual(
      first.map((each) => each.observation.id),
    );
    expect(hmisEntryId(extract.rows[0]!, 'hmis-demo')).toContain('hmis-demo');
    // Nothing about the moment of the import is in the identifier: the same file
    // imported tomorrow is the same movements, not two months of them.
    expect(second.map((each) => each.idempotencyKey)).toEqual(
      first.map((each) => each.idempotencyKey),
    );
  });
});

describe('what the extract refuses', () => {
  it('refuses a header missing a column it needs, naming what is absent', () => {
    expect(() => parseHmisExtract('facility_code,month,item_code,movement,quantity\n')).toThrow(
      /missing batch_no, expiry/,
    );
  });

  it('refuses a row it cannot read, naming the line and the field', () => {
    const lines = EXTRACT.split('\n');
    lines[1] = 'SIM-BIHAR-GAYA-B1-CHC-03,2026-8,nlem-2-1-5-paracetamol,I,412,,';
    expect(() => parseHmisExtract(lines.join('\n'))).toThrow(
      /line 2 .*month: a month is stated as/,
    );
  });

  it('refuses a movement it does not know rather than guessing the nearest one', () => {
    const lines = EXTRACT.split('\n');
    lines[1] = 'SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,X,412,,';
    expect(() => parseHmisExtract(lines.join('\n'))).toThrow(CivoraError);
    expect(() => parseHmisExtract(lines.join('\n'))).toThrow(/movement:/);
  });

  it('refuses stock arriving without the batch and expiry the ledger requires', () => {
    const lines = EXTRACT.split('\n');
    lines[2] = 'SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,R,900,,';
    expect(() => parseHmisExtract(lines.join('\n'))).toThrow(/without a batch and an expiry/);
  });

  it('refuses a quantity that is not a positive whole number', () => {
    const lines = EXTRACT.split('\n');
    lines[1] = 'SIM-BIHAR-GAYA-B1-CHC-03,2026-08,nlem-2-1-5-paracetamol,I,0,,';
    expect(() => parseHmisExtract(lines.join('\n'))).toThrow(/quantity:/);
  });
});

describe('the boundary\u2019s own contract', () => {
  it('produces submissions the ingest boundary accepts, stamped as an import', () => {
    const submissions = submissionsFor(parseHmisExtract(EXTRACT), {
      sourceId: 'hmis-demo',
      receivedAt: '2026-09-01T04:00:00.000Z',
    });

    // The reader builds the boundary's own envelope rather than a shape of its
    // own, and this is what says so: every row is a submission the validator
    // admits, carrying the source a reader of the ledger will see.
    for (const submission of submissions) {
      expect(ingestRequestSchema.safeParse(submission).success).toBe(true);
      expect(submission.observation.captureSource).toBe('import');
      expect(submission.observation.recordedAt).toBe('2026-09-01T04:00:00.000Z');
    }
  });
});

describe('the documented correspondence', () => {
  it('names every column the reader requires', () => {
    const mapped = new Set(HMIS_FIELD_MAPPING.map((entry) => entry.source));

    // The mapping is printed in `docs/INTEROP.md`, and this is what keeps it true:
    // a column the reader needs but the table does not name is an undocumented
    // requirement, which is the thing a ministry cannot discover until it fails.
    for (const column of HMIS_COLUMNS) {
      expect(mapped.has(column), `${column} is required but not documented`).toBe(true);
    }
    expect(HMIS_FIELD_MAPPING.length).toBe(HMIS_COLUMNS.length);
  });
});
