import { CivoraError } from '@civora/domain';

/**
 * A CSV reader strict enough to be worth trusting with an extract.
 *
 * A government extract is not a spreadsheet somebody typed; it is a file a
 * department produced, and the failure that matters is the quiet one — a column
 * that moved, a row that lost a field, a quoted value that swallowed the comma
 * after it. So this reader accepts the RFC 4180 subset those files are written in
 * and **refuses** the shapes it cannot read without guessing:
 *
 *  - comma-separated, `CRLF` or `LF`, an optional byte-order mark, a trailing
 *    newline allowed;
 *  - quoted fields, with `""` as an escaped quote, which a district named
 *    `Gaya "Sadar"` needs;
 *  - a header row of distinct, non-empty column names;
 *  - every data line carrying exactly as many fields as the header. A ragged line
 *    is an error naming the line, not a row silently short of its last column —
 *    a short row is how a file whose columns shifted gets read as data that is
 *    merely odd.
 *
 * Blank lines are not records, and they are still counted when an error reports a
 * line number, so the number is the one the reader can find in their own editor.
 *
 * It is a function rather than a dependency on purpose: the formats this package
 * consumes are the ones a department publishes, and owning the twenty rules that
 * decide what those files mean is cheaper than owning a parser's opinions about
 * the ones they do not.
 */

export interface CsvTable {
  /** The header, in the order the file has it. */
  readonly header: readonly string[];
  /** One record per data line, keyed by column name; every value is text. */
  readonly rows: readonly Readonly<Record<string, string>>[];
}

/** Split one line into fields, honouring quotes. */
const splitLine = (line: string): readonly string[] => {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  while (index < line.length) {
    // `charAt` rather than an index: the loop's bound already says the character
    // is there, and reading it this way keeps the arithmetic below on strings
    // rather than on a value the compiler has to be told about.
    const character = line.charAt(index);
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }

    if (character === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ',') {
      fields.push(field);
      field = '';
      index += 1;
      continue;
    }
    field += character;
    index += 1;
  }

  if (quoted) {
    throw new CivoraError(`a quoted value is never closed on the line "${line}"`);
  }

  fields.push(field);
  return fields;
};

/**
 * Split a file into lines.
 *
 * The split is on `\n` after normalising `\r\n`, which is the pair of line
 * endings these extracts use. A lone `\r` is left inside a field rather than
 * treated as a break, because a file that uses it is a file this reader has not
 * been shown, and reading it as lines would be the guess this module exists to
 * avoid.
 */
const linesOf = (text: string): readonly string[] => {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const normalised = withoutBom.replace(/\r\n/g, '\n');

  if (normalised.includes('\r')) {
    throw new CivoraError(
      'the file contains a bare carriage return, which is a line ending this reader has not been shown; reading it as data would put it inside a column name',
    );
  }

  return normalised.split('\n');
};

export function parseCsv(text: string): CsvTable {
  const lines = linesOf(text);
  const rows: Record<string, string>[] = [];
  let columns: readonly string[] | null = null;

  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }

    const lineNumber = index + 1;
    const fields = splitLine(line);

    if (columns === null) {
      const names = fields.map((field) => field.trim());
      if (names.some((name) => name === '')) {
        throw new CivoraError(
          `the header on line ${String(lineNumber)} has an unnamed column, so a value in it could not be addressed`,
        );
      }
      const repeated = names.filter((name, position) => names.indexOf(name) !== position);
      if (repeated.length > 0) {
        throw new CivoraError(
          `the header on line ${String(lineNumber)} names ${repeated.join(', ')} more than once`,
        );
      }
      columns = names;
      continue;
    }

    if (fields.length !== columns.length) {
      throw new CivoraError(
        `line ${String(lineNumber)} has ${String(fields.length)} field(s) where the header has ${String(
          columns.length,
        )}; a ragged line is a file whose columns moved`,
      );
    }

    const row: Record<string, string> = {};
    for (const [position, name] of columns.entries()) {
      row[name] = (fields[position] ?? '').trim();
    }
    rows.push(row);
  }

  if (columns === null) {
    throw new CivoraError('the file has no header row, so its columns cannot be named');
  }

  return { header: columns, rows };
}
