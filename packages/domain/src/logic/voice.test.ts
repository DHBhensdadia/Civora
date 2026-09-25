import { describe, expect, it } from 'vitest';

import { itemIdSchema } from '../model/common';
import type { Item } from '../model/catalogue';
import { voiceCaptureCommandSchema } from '../model/extraction';
import type { VoiceCaptureCommand } from '../model/extraction';
import { ingestRequestSchema } from '../model/ingest';
import { anItem, FACILITY_A } from '../testing/factories';
import { completeSubmission, decideIngest, PLATFORM_STAMP } from './ingest';
import { decideVoiceCommand, voiceIngestRequestFor } from './voice';

/**
 * What a spoken update may become, and what it must settle first.
 *
 * The two claims worth testing are that nothing is written from a reading nobody
 * has confirmed, and that the platform does not invent the details speech left
 * out — a batch number, a direction, a cadre. The confirmation screen renders the
 * list this rule produces, so the list is the rule.
 */

const CATALOGUE: readonly Item[] = [
  anItem(),
  anItem({
    id: itemIdSchema.parse('item-amoxicillin-500'),
    genericName: 'Amoxicillin',
    strength: '500 mg',
  }),
];

const aCommand = (overrides: Record<string, unknown> = {}): VoiceCaptureCommand =>
  voiceCaptureCommandSchema.parse({
    intent: 'stock_receipt',
    language: 'mr',
    transcript: 'paracetamol cheshees gobe aale, batch do-do-nine-one',
    itemName: 'Paracetamol 500 mg',
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
    confidence: 0.92,
    ambiguities: [],
    ...overrides,
  });

const decide = (command: VoiceCaptureCommand, chosenItemId?: string) =>
  decideVoiceCommand({
    command,
    catalogue: CATALOGUE,
    observedOn: '2026-09-25',
    ...(chosenItemId === undefined ? {} : { chosenItemId }),
  });

describe('deciding what a spoken update would write', () => {
  it('accepts a complete receipt, and says which record it would become', () => {
    const decision = decide(aCommand());

    expect(decision.problems).toEqual([]);
    expect(decision.observation).toBe('stock_ledger_entry');
    expect(decision.item?.genericName).toBe('Paracetamol');
  });

  it('refuses to write a receipt with no batch, because arriving stock names its lot', () => {
    const decision = decide(aCommand({ batchId: null }));

    expect(decision.problems).toEqual(['batch-not-heard']);
  });

  it('refuses a batch that expired before the day the update is about', () => {
    expect(decide(aCommand({ expiresOn: '2026-09-24' })).problems).toEqual([
      'expiry-not-after-observation',
    ]);
  });

  it('is refused by the command itself when an adjustment states no direction', () => {
    // A direction is not one of the questions the confirmation screen asks. The
    // speaker knows which way the stock moved; if the parse lost it, the right
    // answer is to re-ask the model, not to invite a person to fill a gap in the
    // evidence. So the command schema refuses it before this rule is reached.
    expect(() =>
      aCommand({
        intent: 'stock_adjustment',
        batchId: null,
        expiresOn: null,
        adjustmentDirection: null,
      }),
    ).toThrow(/which way the stock moved/);

    const decided = decide(
      aCommand({
        intent: 'stock_adjustment',
        batchId: null,
        expiresOn: null,
        adjustmentDirection: 'decrease',
      }),
    );
    expect(decided.problems).toEqual([]);
    expect(decided.observation).toBe('stock_ledger_entry');
  });

  it('does not require a batch for an issue', () => {
    const decision = decide(aCommand({ intent: 'stock_issue', batchId: null, expiresOn: null }));

    expect(decision.problems).toEqual([]);
  });

  it('says a name matched nothing, and offers the catalogue when a person chooses', () => {
    expect(decide(aCommand({ itemName: 'Zinc sulphate' })).problems).toEqual(['item-unmatched']);

    const chosen = decide(aCommand({ itemName: 'Zinc sulphate' }), 'item-paracetamol');
    expect(chosen.problems).toEqual([]);
    expect(chosen.item?.genericName).toBe('Paracetamol');
  });

  it('reports every question a person has to answer, not the first one', () => {
    // The boundary of this list is worth stating: an intent, a quantity, a cadre
    // and the bed counts are all required by the command schema, so a parse that
    // lost one never reaches this rule. What can be outstanding is an
    // unresolvable name and, for arriving stock, the batch and the expiry.
    const decision = decide(
      aCommand({ itemName: 'Zinc sulphate', batchId: null, expiresOn: null }),
    );

    expect(decision.problems).toEqual(['item-unmatched', 'batch-not-heard', 'expiry-not-heard']);
  });

  it('writes nothing for an utterance nobody understood', () => {
    const decision = decide(
      aCommand({
        intent: 'unknown',
        itemName: null,
        quantity: null,
        batchId: null,
        expiresOn: null,
      }),
    );

    expect(decision.observation).toBeNull();
    expect(decision.problems).toEqual(['intent-not-understood']);
  });

  it('routes a bed update and an attendance update to their own records', () => {
    const beds = decide(
      aCommand({
        intent: 'bed_status',
        itemName: null,
        quantity: null,
        batchId: null,
        expiresOn: null,
        bedsTotal: 6,
        bedsOccupied: 5,
      }),
    );
    expect(beds.observation).toBe('bed_status');
    expect(beds.problems).toEqual([]);

    const attendance = decide(
      aCommand({
        intent: 'staff_attendance',
        itemName: null,
        quantity: null,
        batchId: null,
        expiresOn: null,
        cadre: 'anm',
        postsSanctioned: 3,
        postsFilled: 2,
      }),
    );
    expect(attendance.observation).toBe('staff_attendance');
    expect(attendance.problems).toEqual(['present-not-heard']);
  });
});

describe('a confirmed command entering the ledger', () => {
  const request = () =>
    voiceIngestRequestFor({
      facilityId: FACILITY_A,
      command: aCommand(),
      itemId: itemIdSchema.parse('item-paracetamol'),
      observedOn: '2026-09-25',
      capturedAt: '2026-09-25T09:00:00.000Z',
      recordId: 'entry-voice-1',
      idempotencyKey: 'key-voice-1',
    });

  it('satisfies the ingest contract, so a confirmed update cannot fail later', () => {
    expect(() => request()).not.toThrow();
    expect(ingestRequestSchema.safeParse(completeSubmission(request())).success).toBe(true);
  });

  it('says it was spoken, so the ledger can tell it from a typed entry', () => {
    expect(request()).toMatchObject({
      type: 'stock_ledger_entry',
      captureSource: 'voice',
      observation: { kind: 'receipt', quantity: 60, batchId: 'B-2291', expiresOn: '2027-06-30' },
    });
  });

  it('is accepted by the same boundary rules a typed capture goes through', () => {
    const decision = decideIngest({
      request: request(),
      receivedAt: '2026-09-25T09:00:01.000Z',
      existingReceipt: null,
      existingRecord: null,
      stamp: PLATFORM_STAMP,
      conflictId: 'conflict-voice-1',
    });

    expect(decision.outcome).toBe('accepted');
    expect(decision.record?.captureSource).toBe('voice');
  });

  it('builds a bed report and an attendance record from the same flow', () => {
    const beds = voiceIngestRequestFor({
      facilityId: FACILITY_A,
      command: aCommand({
        intent: 'bed_status',
        itemName: null,
        quantity: null,
        batchId: null,
        expiresOn: null,
        bedsTotal: 6,
        bedsOccupied: 5,
      }),
      itemId: null,
      observedOn: '2026-09-25',
      capturedAt: '2026-09-25T09:00:00.000Z',
      recordId: 'bed-voice-1',
      idempotencyKey: 'key-bed-voice-1',
    });

    expect(beds).toMatchObject({
      type: 'bed_status',
      observation: { bedsTotal: 6, bedsOccupied: 5 },
    });
    expect(beds.captureSource).toBe('voice');
  });

  it('refuses to build a record for an utterance nobody understood', () => {
    expect(() =>
      voiceIngestRequestFor({
        facilityId: FACILITY_A,
        command: aCommand({
          intent: 'unknown',
          itemName: null,
          quantity: null,
          batchId: null,
          expiresOn: null,
        }),
        itemId: null,
        observedOn: '2026-09-25',
        capturedAt: '2026-09-25T09:00:00.000Z',
        recordId: 'entry-voice-2',
        idempotencyKey: 'key-voice-2',
      }),
    ).toThrow(/cannot become a record/);
  });
});
