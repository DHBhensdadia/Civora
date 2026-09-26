import { CivoraError } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv';

/**
 * The reader, held to the two halves of what it claims.
 *
 * What it reads: the RFC 4180 subset an extract is written in — quoted fields,
 * escaped quotes, both line endings, a byte-order mark, a trailing newline. What
 * it refuses: a file whose columns moved, a header that names a column twice or
 * names one nothing, and a quote that is never closed.
 *
 * The refusals are the half worth testing hardest. A reader that accepts a ragged
 * file does not fail; it produces rows missing their last column, and the import
 * that follows writes a ledger from them.
 */

describe('what the reader reads', () => {
  it('reads a plain table, trimming the values and keeping the header order', () => {
    const table = parseCsv('facility_code, month\nSIM-A, 2026-08\nSIM-B,2026-09\n');

    expect(table.header).toEqual(['facility_code', 'month']);
    expect(table.rows).toEqual([
      { facility_code: 'SIM-A', month: '2026-08' },
      { facility_code: 'SIM-B', month: '2026-09' },
    ]);
  });

  it('reads quoted fields, escaped quotes and a comma inside a value', () => {
    const table = parseCsv('district,name\n10,Gaya\n10,"Gaya ""Sadar"", north"\n');

    expect(table.rows[1]?.name).toBe('Gaya "Sadar", north');
  });

  it('reads CRLF, a byte-order mark and blank lines as one file', () => {
    const table = parseCsv('\uFEFFa,b\r\n1,2\r\n\r\n3,4\r\n');

    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual({ a: '3', b: '4' });
  });

  it('keeps a value that is empty distinct from a value that is absent', () => {
    const table = parseCsv('a,b,c\n1,,3\n');

    // An empty column is not a missing one: an extract that omits a value says so
    // with an empty field, and the row still has the field.
    expect(table.rows[0]).toEqual({ a: '1', b: '', c: '3' });
  });
});

describe('what the reader refuses', () => {
  it('refuses a ragged line, naming it', () => {
    expect(() => parseCsv('a,b,c\n1,2,3\n4,5\n')).toThrow(CivoraError);
    expect(() => parseCsv('a,b,c\n1,2,3\n4,5\n')).toThrow(
      /line 3 has 2 field\(s\) where the header has 3/,
    );
  });

  it('refuses a header with an unnamed column or a repeated name', () => {
    expect(() => parseCsv('a,,c\n1,2,3\n')).toThrow(/unnamed column/);
    expect(() => parseCsv('a,b,a\n1,2,3\n')).toThrow(/names a more than once/);
  });

  it('refuses a file with no header, and one whose quote is never closed', () => {
    expect(() => parseCsv('\n\n')).toThrow(/no header row/);
    expect(() => parseCsv('a,b\n1,"unterminated\n')).toThrow(/never closed/);
  });

  it('refuses a bare carriage return rather than reading it into a column name', () => {
    // A file using `\r` alone is a file this reader has not been shown. Read as
    // lines it is one line whose header is `a`, `b\r1`, `2\r` — a table with a
    // column nothing can address, and no complaint about it.
    expect(() => parseCsv('a,b\r1,2\r')).toThrow(/bare carriage return/);
  });
});
