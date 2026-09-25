import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Item } from '@civora/domain';
import type { Network, Simulation } from '@civora/simulator';

import type { SeedReport } from './seeding';

/**
 * Writing a generated dataset to disk.
 *
 * The port is how the platform stores data; this is how a person inspects it
 * without a database. Two shapes, because they answer different questions:
 * JSON keeps the records exactly as the model defines them, and CSV flattens
 * them so a spreadsheet or a `cut` can answer questions the platform has not
 * thought to ask yet.
 *
 * The manifest carries no timestamp. An export of a published seed is therefore
 * byte-identical on every machine and can be diffed against another to prove two
 * people generated the same nation — which a timestamp would make impossible to
 * establish without ignoring the one field that differs.
 */

export type ExportFormat = 'json' | 'csv';

export interface ExportRequest {
  readonly directory: string;
  readonly format: ExportFormat;
  readonly seed: string;
  readonly scenarioId: string;
  readonly report: SeedReport;
  readonly network: Network;
  readonly items: readonly Item[];
  readonly simulation: Simulation;
}

interface Exportable {
  /** File name stem: kebab-case, so it survives a case-insensitive filesystem. */
  readonly name: string;
  readonly records: readonly unknown[];
}

const fieldsOf = (record: unknown): readonly (readonly [string, unknown])[] =>
  typeof record === 'object' && record !== null ? Object.entries(record) : [];

/** One CSV cell. Nested values are kept as JSON rather than dropped or stringified to `[object]`. */
const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  // Written as an exhaustive switch rather than a `String(...)` fallback: a
  // value that is neither a scalar nor serialisable would otherwise stringify to
  // `[object Object]` and be written into the export as though it were data.
  const text = ((): string => {
    switch (typeof value) {
      case 'string':
        return value;
      case 'number':
      case 'bigint':
      case 'boolean':
        return value.toString();
      case 'symbol':
      case 'function':
        // Nothing in a generated dataset has either. Refusing is better than
        // writing a placeholder that reads like a value.
        return '';
      default:
        return JSON.stringify(value);
    }
  })();

  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const toCsv = (records: readonly unknown[]): string => {
  const headers = [...new Set(records.flatMap((record) => fieldsOf(record).map(([key]) => key)))];
  const lines = records.map((record) => {
    const fields = new Map(fieldsOf(record));
    return headers.map((header) => csvCell(fields.get(header))).join(',');
  });
  return `${headers.map((header) => csvCell(header)).join(',')}\n${lines.join('\n')}\n`;
};

/** The dataset, split the way the export writes it. */
const exportables = (request: ExportRequest): readonly Exportable[] => [
  { name: 'countries', records: [request.network.country] },
  { name: 'regions', records: request.network.regions },
  { name: 'districts', records: request.network.districts },
  { name: 'blocks', records: request.network.blocks },
  { name: 'facilities', records: request.network.facilities },
  { name: 'items', records: request.items },
  { name: 'stock-ledger-entries', records: request.simulation.ledgerEntries },
  { name: 'bed-statuses', records: request.simulation.bedStatuses },
  { name: 'staff-attendance', records: request.simulation.staffAttendance },
  { name: 'footfall-observations', records: request.simulation.footfall },
  { name: 'syndromic-signals', records: request.simulation.syndromicSignals },
];

/** The reference collections, which are small enough to read in one file. */
const REFERENCE = new Set(['countries', 'regions', 'districts', 'blocks', 'facilities', 'items']);

const manifest = (request: ExportRequest): Record<string, unknown> => ({
  tool: 'civora db:seed',
  seed: request.seed,
  scenarioId: request.scenarioId,
  window: {
    from: request.simulation.from,
    to: request.simulation.to,
    days: request.simulation.counts.days,
  },
  coverage: {
    states: request.network.regions.length,
    districts: request.network.districts.length,
    blocks: request.network.blocks.length,
    facilities: request.network.facilities.length,
    facilitiesWithHistory: request.simulation.counts.facilities,
  },
  collections: request.report.collections,
  documents: request.report.documents,
  fingerprint: request.report.fingerprint,
  // Every record in this dataset is generated. A reader of the export must not
  // have to infer that from the field names.
  simulated: true,
});

/**
 * Write the dataset to `directory`, returning the paths written.
 *
 * Both formats always write the manifest, because a directory of CSV files with
 * no statement of the seed that produced them is the same as no provenance at
 * all.
 */
export async function exportDataset(request: ExportRequest): Promise<readonly string[]> {
  await mkdir(request.directory, { recursive: true });

  const written: string[] = [];
  const write = async (name: string, contents: string): Promise<void> => {
    const path = join(request.directory, name);
    await writeFile(path, contents, 'utf8');
    written.push(path);
  };

  await write('manifest.json', `${JSON.stringify(manifest(request), null, 2)}\n`);

  if (request.format === 'csv') {
    for (const collection of exportables(request)) {
      await write(`${collection.name}.csv`, toCsv(collection.records));
    }
    return written;
  }

  // JSON keeps each collection as the model defines it, grouped so that the
  // reference data can be read without loading a hundred thousand observations
  // beside it.
  const grouped = new Map<string, Record<string, unknown>>();
  for (const collection of exportables(request)) {
    const file = REFERENCE.has(collection.name) ? 'reference-data.json' : 'observations.json';
    grouped.set(file, { ...(grouped.get(file) ?? {}), [collection.name]: collection.records });
  }
  for (const [file, contents] of grouped) {
    await write(file, `${JSON.stringify(contents, null, 2)}\n`);
  }

  return written;
}
