import { describe, expect, it } from 'vitest';

import { itemIdSchema } from '../model/common';
import type { Item } from '../model/catalogue';
import { EXTRACTION_REVIEW_THRESHOLD, stockExtractionSchema } from '../model/extraction';
import type { StockExtraction, StockExtractionLine } from '../model/extraction';
import { ingestReceiptSchema, ingestRequestSchema } from '../model/ingest';
import { completeSubmission, decideIngest, PLATFORM_STAMP } from './ingest';
import { partitionExtraction, visionIngestRequestFor } from './extraction';
import { anItem, FACILITY_A } from '../testing/factories';

/**
 * The platform's half of vision intake: what a photograph's reading becomes.
 *
 * The phase's blocking requirement for this flow is that a poor image produces
 * review-queue entries rather than ledger writes, so the cases below are mostly
 * about the *refusals* — an unsure line, a name nobody can resolve, a line that
 * is a count rather than a movement. The last case is the opposite direction:
 * an accepted line must actually satisfy the ingest contract, or the review
 * queue would be protecting a ledger that cannot accept what it approves.
 */

const CATALOGUE: readonly Item[] = [
  anItem(),
  anItem({
    id: itemIdSchema.parse('item-amoxicillin-500'),
    genericName: 'Amoxicillin',
    strength: '500 mg',
  }),
  anItem({
    id: itemIdSchema.parse('item-amoxicillin-250'),
    genericName: 'Amoxicillin',
    strength: '250 mg',
  }),
];

const aLine = (overrides: Record<string, unknown> = {}): StockExtractionLine =>
  stockExtractionSchema.parse({
    facilityName: 'PHC Khed',
    registerDate: '2026-09-24',
    lines: [
      {
        itemName: 'Paracetamol 500 mg Tab',
        quantity: 240,
        unit: 'Tabs',
        batchId: 'B-2291',
        expiresOn: '2027-06-30',
        confidence: 0.94,
        note: null,
        ...overrides,
      },
    ],
    notes: [],
  }).lines[0]!;

const anExtraction = (lines: readonly Record<string, unknown>[]): StockExtraction =>
  stockExtractionSchema.parse({
    facilityName: 'PHC Khed',
    registerDate: '2026-09-24',
    lines,
    notes: [],
  });

const partition = (
  lines: readonly Record<string, unknown>[],
  overrides: { readonly threshold?: number; readonly occurredOn?: string } = {},
) =>
  partitionExtraction({
    extraction: anExtraction(lines),
    catalogue: CATALOGUE,
    occurredOn: overrides.occurredOn ?? '2026-09-24',
    ...(overrides.threshold === undefined ? {} : { threshold: overrides.threshold }),
  });

const good = {
  itemName: 'Paracetamol 500 mg Tab',
  quantity: 240,
  unit: 'Tabs',
  batchId: 'B-2291',
  expiresOn: '2027-06-30',
  confidence: 0.94,
  note: null,
};

describe('routing a reading to the ledger or to review', () => {
  it('accepts a confident, complete line and says which item it is', () => {
    const { accepted, review } = partition([good]);

    expect(review).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.item.genericName).toBe('Paracetamol');
    expect(accepted[0]?.occurredOn).toBe('2026-09-24');
  });

  it('sends a line below the stated threshold to review, and not to the ledger', () => {
    const { accepted, review } = partition([
      { ...good, confidence: EXTRACTION_REVIEW_THRESHOLD - 0.01 },
    ]);

    expect(accepted).toEqual([]);
    expect(review[0]?.reasons).toEqual(['low-confidence']);
  });

  it('accepts a line exactly at the threshold, so the boundary is stated rather than guessed', () => {
    const { accepted } = partition([{ ...good, confidence: EXTRACTION_REVIEW_THRESHOLD }]);

    expect(accepted).toHaveLength(1);
  });

  it('routes a name the catalogue cannot resolve to review, with no candidate', () => {
    const { accepted, review } = partition([{ ...good, itemName: 'Zinc sulphate' }]);

    expect(accepted).toEqual([]);
    expect(review[0]?.reasons).toEqual(['item-unmatched']);
    expect(review[0]?.candidates).toEqual([]);
  });

  it('routes an ambiguous name to review and offers the entries it could mean', () => {
    const { accepted, review } = partition([{ ...good, itemName: 'Amoxicillin' }]);

    expect(accepted).toEqual([]);
    expect(review[0]?.reasons).toEqual(['item-ambiguous']);
    expect(review[0]?.candidates.map((item) => item.id).sort()).toEqual([
      'item-amoxicillin-250',
      'item-amoxicillin-500',
    ]);
  });

  it('will not turn a count into a movement: no batch, no ledger entry', () => {
    const { accepted, review } = partition([
      { ...good, batchId: null },
      { ...good, expiresOn: null },
    ]);

    expect(accepted).toEqual([]);
    expect(review[0]?.reasons).toEqual(['batch-not-read']);
    expect(review[1]?.reasons).toEqual(['expiry-not-read']);
  });

  it('collects every reason a line has, so it is not fixed twice', () => {
    const { review } = partition([
      { ...good, itemName: 'Zinc sulphate', batchId: null, confidence: 0.4 },
    ]);

    expect(review[0]?.reasons).toEqual(['low-confidence', 'item-unmatched', 'batch-not-read']);
  });

  it('refuses a batch that expired on or before the day the register claims', () => {
    // The ledger requires a batch's expiry to be after the day it moved. A
    // register that recorded an expired batch is a real thing to find and not
    // something this code decides on its own.
    const { accepted, review } = partition([{ ...good, expiresOn: '2026-09-24' }]);

    expect(accepted).toEqual([]);
    expect(review[0]?.reasons).toEqual(['expiry-not-after-register']);
  });

  it('routes every line of a poor image, and leaves the ledger untouched', () => {
    const { accepted, review } = partition([
      { ...good, confidence: 0.35 },
      { ...good, itemName: 'Amoxicillin', confidence: 0.9 },
      { ...good, itemName: 'Zinc sulphate', confidence: 0.5 },
    ]);

    expect(accepted).toEqual([]);
    expect(review).toHaveLength(3);
  });

  it('can be asked where the line would land at a stricter threshold', () => {
    const { accepted } = partition([good], { threshold: 0.99 });

    expect(accepted).toEqual([]);
  });
});

describe('an accepted line entering the ledger', () => {
  const request = () =>
    visionIngestRequestFor({
      facilityId: FACILITY_A,
      itemId: itemIdSchema.parse('item-paracetamol'),
      line: aLine(),
      occurredOn: '2026-09-24',
      capturedAt: '2026-09-25T09:00:00.000Z',
      entryId: 'entry-vision-1',
      idempotencyKey: 'key-vision-1',
    });

  it('satisfies the ingest contract, so an approved line cannot fail later', () => {
    // It is built by parsing rather than assembling, so this asserts the
    // behaviour that matters: nothing is thrown between an approval and a store.
    expect(() => request()).not.toThrow();
    expect(ingestRequestSchema.safeParse(completeSubmission(request())).success).toBe(true);
  });

  it('says it was captured by vision, so the ledger can tell it from a typed entry', () => {
    expect(request()).toMatchObject({
      type: 'stock_ledger_entry',
      captureSource: 'vision',
      observation: { kind: 'receipt', quantity: 240, batchId: 'B-2291', expiresOn: '2027-06-30' },
    });
  });

  it('is accepted by the same boundary rules a typed capture goes through', () => {
    const decision = decideIngest({
      request: request(),
      receivedAt: '2026-09-25T09:00:01.000Z',
      existingReceipt: null,
      existingRecord: null,
      stamp: PLATFORM_STAMP,
      conflictId: 'conflict-vision-1',
    });

    expect(decision.outcome).toBe('accepted');
    expect(decision.record?.captureSource).toBe('vision');
    expect(ingestReceiptSchema.safeParse(decision.receipt).success).toBe(true);
  });
});
