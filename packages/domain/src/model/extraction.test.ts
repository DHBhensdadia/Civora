import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_REVIEW_THRESHOLD,
  stockExtractionSchema,
  voiceCaptureCommandSchema,
} from './extraction';

/**
 * The two shapes in which a model is allowed to move information *into* the
 * platform.
 *
 * They are tested here for the same reason every other schema is: the shape is
 * what stops a plausible-looking answer becoming a record. What these cases
 * cover in particular is the refusal of invention — a name where an identifier
 * belongs, a quantity nobody spoke, a stock movement with no item.
 */

const accepts = (result: { success: boolean }): boolean => result.success;

const rawLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemName: 'Paracetamol 500 mg Tab',
  quantity: 240,
  unit: 'Tabs',
  batchId: 'B-2291',
  expiresOn: '2027-06-30',
  confidence: 0.94,
  note: null,
  ...overrides,
});

const rawExtraction = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  facilityName: 'PHC Khed',
  registerDate: '2026-09-24',
  lines: [rawLine()],
  notes: [],
  ...overrides,
});

const rawVoice = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  intent: 'stock_receipt',
  language: 'mr',
  transcript: 'paracetamol cheshees gobe aale',
  itemName: 'Paracetamol',
  quantity: 60,
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

describe('a stock extraction', () => {
  it('carries the item as the page writes it, and no identifier', () => {
    const parsed = stockExtractionSchema.safeParse(rawExtraction());

    expect(accepts(parsed)).toBe(true);
    expect(parsed.success && parsed.data.lines[0]?.itemName).toBe('Paracetamol 500 mg Tab');
    // And nowhere to put an identifier: matching a written name to the catalogue
    // is the platform's job, so a model cannot create an identity — a line that
    // tries is refused rather than silently accepted.
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [rawLine({ itemId: 'item-x' })] })),
      ),
    ).toBe(false);
  });

  it('refuses a line whose confidence is outside [0, 1]', () => {
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [rawLine({ confidence: 1.4 })] })),
      ),
    ).toBe(false);
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [rawLine({ confidence: -0.1 })] })),
      ),
    ).toBe(false);
  });

  it('refuses a fractional or negative quantity, which no register holds', () => {
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [rawLine({ quantity: 12.5 })] })),
      ),
    ).toBe(false);
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [rawLine({ quantity: -3 })] })),
      ),
    ).toBe(false);
  });

  it('accepts an unreadable page as an answer, as long as it says what it saw', () => {
    expect(accepts(stockExtractionSchema.safeParse(rawExtraction({ lines: [], notes: [] })))).toBe(
      false,
    );
    expect(
      accepts(
        stockExtractionSchema.safeParse(rawExtraction({ lines: [], notes: ['page is blank'] })),
      ),
    ).toBe(true);
  });

  it('states the threshold that separates a ledger line from a reviewed one', () => {
    // A number a reader can find, not a comparison buried in the intake code.
    expect(EXTRACTION_REVIEW_THRESHOLD).toBeGreaterThan(0);
    expect(EXTRACTION_REVIEW_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('a voice capture command', () => {
  it('accepts a stock update that carries what was spoken', () => {
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice()))).toBe(true);
  });

  it('refuses a stock update with no item or no quantity', () => {
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice({ quantity: null })))).toBe(false);
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice({ itemName: null })))).toBe(false);
  });

  it('lets only a receipt name a batch, because only arriving stock has one', () => {
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice({ batchId: null })))).toBe(true);
    expect(
      accepts(
        voiceCaptureCommandSchema.safeParse({
          ...rawVoice({ intent: 'stock_issue' }),
          batchId: 'B-2291',
        }),
      ),
    ).toBe(false);
  });

  it('requires an adjustment to say which way the stock moved', () => {
    const adjustment = rawVoice({ intent: 'stock_adjustment', batchId: null, expiresOn: null });
    expect(accepts(voiceCaptureCommandSchema.safeParse(adjustment))).toBe(false);
    expect(
      accepts(
        voiceCaptureCommandSchema.safeParse({ ...adjustment, adjustmentDirection: 'decrease' }),
      ),
    ).toBe(true);
  });

  it('requires a bed update to carry both counts', () => {
    const bedUpdate = rawVoice({
      intent: 'bed_status',
      itemName: null,
      quantity: null,
      batchId: null,
      expiresOn: null,
    });
    expect(accepts(voiceCaptureCommandSchema.safeParse(bedUpdate))).toBe(false);
    expect(
      accepts(voiceCaptureCommandSchema.safeParse({ ...bedUpdate, bedsTotal: 6, bedsOccupied: 5 })),
    ).toBe(true);
    expect(
      accepts(voiceCaptureCommandSchema.safeParse({ ...bedUpdate, bedsTotal: 6, bedsOccupied: 7 })),
    ).toBe(false);
  });

  it('requires an attendance update to name its cadre and its posts', () => {
    const attendance = rawVoice({
      intent: 'staff_attendance',
      itemName: null,
      quantity: null,
      batchId: null,
      expiresOn: null,
    });
    expect(accepts(voiceCaptureCommandSchema.safeParse(attendance))).toBe(false);
    expect(
      accepts(
        voiceCaptureCommandSchema.safeParse({
          ...attendance,
          cadre: 'anm',
          postsSanctioned: 3,
          postsFilled: 2,
          presentToday: 2,
        }),
      ),
    ).toBe(true);
    expect(
      accepts(
        voiceCaptureCommandSchema.safeParse({
          ...attendance,
          cadre: 'anm',
          postsSanctioned: 2,
          postsFilled: 2,
          presentToday: 3,
        }),
      ),
    ).toBe(false);
  });

  it('carries no quantity at all when the utterance was not understood', () => {
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice({ intent: 'unknown' })))).toBe(
      false,
    );
    expect(
      accepts(
        voiceCaptureCommandSchema.safeParse(
          rawVoice({
            intent: 'unknown',
            itemName: null,
            quantity: null,
            batchId: null,
            expiresOn: null,
            ambiguities: ['not a stock update'],
          }),
        ),
      ),
    ).toBe(true);
  });

  it('keeps the transcript, so the confirmation can show what was heard', () => {
    const parsed = voiceCaptureCommandSchema.safeParse(rawVoice());

    expect(parsed.success && parsed.data.transcript).toBe('paracetamol cheshees gobe aale');
    expect(parsed.success && parsed.data.language).toBe('mr');
    expect(accepts(voiceCaptureCommandSchema.safeParse(rawVoice({ transcript: '   ' })))).toBe(
      false,
    );
  });
});
