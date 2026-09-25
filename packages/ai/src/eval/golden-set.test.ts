import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Item } from '@civora/domain';
import { anItem } from '@civora/domain/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GOLDEN_EXIT_CODES,
  goldenSetExitCode,
  loadGoldenSet,
  renderGoldenSetReport,
  scoreGoldenSet,
} from './golden-set';

/**
 * The corpus harness, exercised on synthetic corpora.
 *
 * The corpora here are written by the test, which is the one place a hand-made
 * case is legitimate: this is checking the *scorer*, not producing a measurement.
 * The command over the real corpus refuses to score anything a person wrote, and
 * says `NOT MEASURED` while the corpus is empty.
 */

const CATALOGUE: readonly Item[] = [
  anItem(),
  anItem({ id: 'item-zinc-20', genericName: 'Zinc Sulphate', strength: '20 mg' }),
];

const directories: string[] = [];

function corpusDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'civora-golden-set-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Write a media file and return the digest a case has to record for it. */
function media(directory: string, name = 'register.jpg', bytes = 'a page of a register'): string {
  mkdirSync(join(directory, 'media'), { recursive: true });
  writeFileSync(join(directory, 'media', name), bytes);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeCase(
  directory: string,
  file: Record<string, unknown>,
  name = 'case.case.json',
): void {
  writeFileSync(join(directory, name), JSON.stringify(file, null, 2));
}

const aRecordedLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemName: 'Tab. Paracetamol 500mg',
  quantity: 40,
  unit: 'tab',
  batchId: 'B-2291',
  expiresOn: '2027-06-30',
  confidence: 0.93,
  note: null,
  ...overrides,
});

const aRecordedExtraction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  facilityName: 'PHC Khed',
  registerDate: '2026-09-24',
  lines: [aRecordedLine()],
  notes: [],
  ...overrides,
});

const aLabelledLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemId: 'item-paracetamol',
  itemName: 'Tab. Paracetamol 500mg',
  quantity: 40,
  batchId: 'B-2291',
  expiresOn: '2027-06-30',
  routing: 'write',
  ...overrides,
});

function anExtractionCase(
  digest: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'khed-2026-09-24',
    task: 'stock-extraction@1',
    provenance: {
      command: 'the command that obtained this response',
      capturedOn: '2026-09-24',
      model: 'gemini-from-the-record',
      mediaDigest: digest,
    },
    media: 'media/register.jpg',
    recorded: aRecordedExtraction(),
    expected: { registerDate: '2026-09-24', lines: [aLabelledLine()] },
    ...overrides,
  };
}

function scoreDirectory(directory: string) {
  const load = loadGoldenSet(directory, CATALOGUE);
  return { load, report: scoreGoldenSet({ load, catalogue: CATALOGUE }) };
}

const aRecordedVoiceCommand = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  intent: 'stock_receipt',
  language: 'hi',
  transcript: 'दो सौ पैरासिटामोल मिले हैं',
  itemName: 'Paracetamol 500 mg',
  quantity: 200,
  batchId: 'B-2291',
  expiresOn: '2027-06-30',
  adjustmentDirection: null,
  cadre: null,
  bedsTotal: null,
  bedsOccupied: null,
  postsSanctioned: null,
  postsFilled: null,
  presentToday: null,
  confidence: 0.9,
  ambiguities: [],
  ...overrides,
});

function aVoiceCase(
  digest: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'khed-spoken-2026-09-24',
    task: 'voice-command-parsing@1',
    provenance: {
      command: 'the command that obtained this parse',
      capturedOn: '2026-09-24',
      model: 'gemini-from-the-record',
      mediaDigest: digest,
    },
    media: 'media/register.jpg',
    recorded: aRecordedVoiceCommand(),
    expected: {
      observedOn: '2026-09-24',
      intent: 'stock_receipt',
      itemId: 'item-paracetamol',
      quantity: 200,
      batchId: 'B-2291',
      expiresOn: '2027-06-30',
      language: 'hi',
      openQuestions: [],
    },
    ...overrides,
  };
}

describe('an empty corpus', () => {
  it('is NOT MEASURED, with the reason and no accuracy at all', () => {
    const { report } = scoreDirectory(corpusDirectory());
    const rendered = renderGoldenSetReport(report);

    expect(report.verdict).toBe('not-measured');
    expect(report.fieldAccuracy).toBeNull();
    expect(goldenSetExitCode(report)).toBe(GOLDEN_EXIT_CODES.notMeasured);
    expect(rendered).toContain('NOT MEASURED');
    expect(rendered).toContain('the corpus is empty');
    // No percentage anywhere: a rate over nothing is the one output that would
    // make a green run mean nothing was checked.
    expect(rendered).not.toContain('%');
    expect(rendered).not.toContain('PASS');
  });

  it('is not a pass even when the directory is missing entirely', () => {
    const { report } = scoreDirectory(join(corpusDirectory(), 'not-created'));

    expect(report.verdict).toBe('corpus-unreadable');
    expect(goldenSetExitCode(report)).toBe(GOLDEN_EXIT_CODES.failing);
  });
});

describe('provenance', () => {
  it('refuses a case with no provenance, by name', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    const withoutProvenance = anExtractionCase(digest);
    delete withoutProvenance.provenance;
    writeCase(directory, withoutProvenance);

    const { load, report } = scoreDirectory(directory);

    expect(load.cases).toEqual([]);
    expect(load.refused).toHaveLength(1);
    expect(load.refused[0]?.reason).toContain('provenance');
    // A corpus file that cannot be scored is a person's problem, not a smaller
    // corpus, so this is a failure rather than "not measured".
    expect(report.verdict).toBe('corpus-unreadable');
    expect(goldenSetExitCode(report)).toBe(GOLDEN_EXIT_CODES.failing);
  });

  it('refuses a case whose capture date is not a date', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        provenance: {
          command: 'a command',
          capturedOn: 'the day before the deadline',
          model: 'a model',
          mediaDigest: digest,
        },
      }),
    );

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain('capturedOn');
  });

  it('refuses a case whose media is not in the corpus', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(directory, anExtractionCase(digest, { media: 'media/missing.jpg' }));

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain('not in the corpus');
  });

  it('refuses a recording that does not belong to the media it cites', () => {
    const directory = corpusDirectory();
    media(directory, 'register.jpg', 'the photograph this answers');
    const other = media(directory, 'other.jpg', 'a different photograph');
    writeCase(directory, anExtractionCase(other));

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain(
      'does not belong to this media',
    );
  });

  it('refuses a task this harness cannot score, rather than skipping it', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(directory, anExtractionCase(digest, { task: 'transfer-rationale@1' }));

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain(
      'is not one this harness scores',
    );
  });
});

describe('labelling', () => {
  it('refuses a label naming an entry the platform does not stock', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        expected: {
          registerDate: '2026-09-24',
          lines: [aLabelledLine({ itemId: 'item-invented' })],
        },
      }),
    );

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain('is not in the catalogue');
  });

  it('refuses a label whose name resolves to a different entry', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        expected: {
          registerDate: '2026-09-24',
          lines: [aLabelledLine({ itemName: 'Zinc sulphate 20 mg' })],
        },
      }),
    );

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain(
      'resolves to "item-zinc-20"',
    );
  });

  it('refuses a tolerance nobody argued for', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        expected: {
          registerDate: '2026-09-24',
          lines: [aLabelledLine({ tolerance: { by: 5 } })],
        },
      }),
    );

    expect(scoreDirectory(directory).load.refused[0]?.reason).toContain('tolerance');
  });
});

describe('scoring a reading', () => {
  it('passes a case whose reading matches every label', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(directory, anExtractionCase(digest));

    const { report } = scoreDirectory(directory);

    expect(report.scores).toHaveLength(1);
    expect(report.failures).toEqual([]);
    expect(report.fieldAccuracy).toBe(1);
    expect(report.falseAccepts).toBe(0);
    expect(report.verdict).toBe('measured-and-passing');
    expect(goldenSetExitCode(report)).toBe(GOLDEN_EXIT_CODES.passing);
    expect(renderGoldenSetReport(report)).toContain('PASS');
  });

  it('reports a misread quantity with both numbers', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        recorded: aRecordedExtraction({ lines: [aRecordedLine({ quantity: 4 })] }),
      }),
    );

    const { report } = scoreDirectory(directory);

    expect(report.verdict).toBe('measured-and-below-threshold');
    expect(report.failures[0]?.detail).toContain('labelled 40');
    expect(report.failures[0]?.detail).toContain('read as 4');
    expect(renderGoldenSetReport(report)).toContain('BELOW THRESHOLD');
  });

  it('counts a line written that a person should have decided as a false accept', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    // The label says the page is smudged enough that a person has to decide; the
    // reading came back confident and complete, so the platform would have written
    // it. That is the failure this whole harness exists to catch.
    writeCase(
      directory,
      anExtractionCase(digest, {
        expected: { registerDate: '2026-09-24', lines: [aLabelledLine({ routing: 'review' })] },
      }),
    );

    const { report } = scoreDirectory(directory);

    expect(report.falseAccepts).toBe(1);
    expect(report.verdict).toBe('measured-and-below-threshold');
    expect(goldenSetExitCode(report)).toBe(GOLDEN_EXIT_CODES.failing);
    expect(report.failures.map((failure) => failure.detail).join(' ')).toContain('routing');
  });

  it('reports a line the reader did not return, field by field', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        recorded: aRecordedExtraction({ lines: [], notes: ['the page was too dark to read'] }),
      }),
    );

    const { report } = scoreDirectory(directory);

    expect(report.failures[0]?.detail).toContain('did not return');
    // A line nobody saw is a miss on every field it should have carried, not one
    // missing row: it leaves a shelf invisible rather than wrong.
    expect(report.fields.item.correct).toBe(0);
    expect(report.fields.quantity.total).toBe(1);
    expect(report.fields.routing.total).toBe(1);
  });

  it('accepts a tolerance the case justifies, and nothing wider', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      anExtractionCase(digest, {
        recorded: aRecordedExtraction({ lines: [aRecordedLine({ quantity: 38 })] }),
        expected: {
          registerDate: '2026-09-24',
          lines: [
            aLabelledLine({
              tolerance: { by: 2, reason: 'the register is a running balance, not a count' },
            }),
          ],
        },
      }),
    );

    const { report } = scoreDirectory(directory);

    expect(report.failures).toEqual([]);
    expect(report.fields.quantity.correct).toBe(1);
  });

  it('scores a spoken parse against the labels, and misses an unasked question', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(directory, aVoiceCase(digest), 'voice.case.json');

    const aligned = scoreDirectory(directory).report;
    expect(aligned.failures).toEqual([]);
    expect(aligned.verdict).toBe('measured-and-passing');
    // A dimension no task in the corpus can carry a label for reads *not
    // measured*, which is not the same as zero.
    expect(aligned.fields['register-date'].total).toBe(0);
    expect(renderGoldenSetReport(aligned)).toContain('not measured (nothing to compare)');

    rmSync(join(directory, 'voice.case.json'));
    writeCase(
      directory,
      aVoiceCase(digest, {
        expected: {
          observedOn: '2026-09-24',
          intent: 'stock_receipt',
          itemId: 'item-paracetamol',
          quantity: 200,
          batchId: 'B-2291',
          expiresOn: '2027-06-30',
          language: 'hi',
          // The question the platform should have asked about arriving stock, and
          // did not: a person is never asked about something it believes it knows.
          openQuestions: ['batch-not-heard'],
        },
      }),
      'voice.case.json',
    );

    const missed = scoreDirectory(directory).report;
    expect(missed.falseAccepts).toBe(1);
    expect(missed.verdict).toBe('measured-and-below-threshold');
    expect(missed.failures.map((failure) => failure.detail).join(' ')).toContain('batch-not-heard');
  });

  it('reports a parse that heard a different item', () => {
    const directory = corpusDirectory();
    const digest = media(directory);
    writeCase(
      directory,
      aVoiceCase(digest, { recorded: aRecordedVoiceCommand({ itemName: 'Zinc sulphate' }) }),
      'voice.case.json',
    );

    const { report } = scoreDirectory(directory);

    expect(report.verdict).toBe('measured-and-below-threshold');
    expect(report.failures.map((failure) => failure.detail).join(' ')).toContain('item-zinc-20');
  });
});
