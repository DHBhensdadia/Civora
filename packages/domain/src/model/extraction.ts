import { z } from 'zod';

import { batchIdSchema, dateSchema } from './common';
import { cadreSchema, adjustmentDirectionSchema } from './sensing';
import type { LedgerEntryKind } from './sensing';

/**
 * What the reasoning layer produces from an image or an utterance.
 *
 * These are the two shapes in which a model is allowed to move information
 * *into* the platform, and they are deliberately narrow. An extraction is a
 * transcription of evidence a person supplied — a photograph of a register —
 * and a voice command is a proposal that the speaker confirms before anything is
 * written. Neither is a record: the records they become are built from them by
 * `logic/ingest`, under the ordinary ingest contract, with `captureSource` set
 * to `vision` or `voice`.
 *
 * Three rules are enforced by the shape rather than by asking the model nicely.
 *
 *  - **No identifiers.** An extraction names an item the way the page names it
 *    and carries no `itemId`. The platform matches that name against its own
 *    catalogue afterwards, so a model cannot create a catalogue identity, and a
 *    misread name fails to match instead of silently becoming a new item.
 *  - **Confidence is per line and it is a number the review queue reads.** A
 *    line below `EXTRACTION_REVIEW_THRESHOLD` cannot reach the ledger without a
 *    person having looked at it.
 *  - **Nothing is written on the strength of an utterance alone.** A voice
 *    command is confirmed back to the speaker first, and what the parse was
 *    unsure about is listed on the command rather than resolved by it.
 */

/**
 * The confidence below which a line must be reviewed by a person.
 *
 * A single stated number rather than a scattering of comparisons, because it is
 * a policy choice with an operational consequence: raising it sends more lines
 * to a human and lowers the risk of a wrong number in the ledger, lowering it
 * does the reverse. Extraction accuracy is reported against it (the phase file
 * requires the threshold to be stated with the accuracy, and the failures
 * listed).
 */
export const EXTRACTION_REVIEW_THRESHOLD = 0.8;

/**
 * One line read off a register.
 *
 * Every field but `itemName` is nullable, and that is the point: a column that
 * is not there is `null`, a value that cannot be read is `null` with a note.
 * The alternative — a plausible default — is a fabricated record, which is the
 * one failure mode a stock ledger cannot absorb.
 */
export const stockExtractionLineSchema = z.strictObject({
  /**
   * The item exactly as written on the page.
   *
   * Not expanded, not corrected and not translated: the platform's own matcher
   * decides what it names, and a name the model "improved" is a name that no
   * longer matches the catalogue.
   */
  itemName: z.string().trim().min(1),
  /** Counted units. Zero is a real reading; a blank cell is not. */
  quantity: z.int().nonnegative(),
  /** The unit column as written, when there is one. */
  unit: z.string().trim().min(1).nullable(),
  batchId: batchIdSchema.nullable(),
  expiresOn: dateSchema.nullable(),
  /** How sure the reader is of what is written, in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** What is illegible about the line, or null when nothing is. */
  note: z.string().trim().min(1).nullable(),
});

export type StockExtractionLine = z.infer<typeof stockExtractionLineSchema>;

/**
 * One photograph, read.
 *
 * `lines` may be empty: a photograph that is too dark, cut off or simply not a
 * register is an answer, and the honest one is to report nothing found and say
 * why. What is not allowed is an empty extraction with no explanation, which is
 * what the refinement refuses.
 */
export const stockExtractionSchema = z
  .strictObject({
    /** The facility name as written on the page, when the page carries one. */
    facilityName: z.string().trim().min(1).nullable(),
    /** The date the register itself claims, which is not the date of capture. */
    registerDate: dateSchema.nullable(),
    lines: z.array(stockExtractionLineSchema),
    /** What a reader must know: a cut-off page, an unreadable column, a doubt. */
    notes: z.array(z.string().trim().min(1)),
  })
  .refine((extraction) => extraction.lines.length > 0 || extraction.notes.length > 0, {
    message: 'an extraction that found no lines must say why it found none',
    path: ['notes'],
  });

export type StockExtraction = z.infer<typeof stockExtractionSchema>;

/**
 * The kinds of update somebody can speak.
 *
 * Named after the intent in the sentence rather than after the record it
 * becomes, because the same utterance can be a stock movement or an attendance
 * count and the parse has to choose. `unknown` is a first-class value: an
 * utterance that is none of these is answered with "I did not understand that",
 * which is a better outcome than a guess filed as a stock movement.
 */
export const VOICE_INTENTS = [
  'stock_receipt',
  'stock_issue',
  'stock_adjustment',
  'bed_status',
  'staff_attendance',
  'unknown',
] as const;

export const voiceIntentSchema = z.enum(VOICE_INTENTS);
export type VoiceIntent = z.infer<typeof voiceIntentSchema>;

/** The ledger kind a stock intent becomes once the speaker has confirmed it. */
export const VOICE_STOCK_KINDS: Readonly<Record<string, LedgerEntryKind>> = {
  stock_receipt: 'receipt',
  stock_issue: 'issue',
  stock_adjustment: 'adjust',
};

/**
 * A spoken update, parsed and awaiting confirmation.
 *
 * This is a proposal, not a record. It is shown back to the speaker — what was
 * heard, what was understood, and what was not — and only the confirmed version
 * is ingested. That ordering is the whole safety argument for voice input: the
 * platform never writes a stock movement on the strength of a transcript it has
 * not shown to the person who spoke.
 */
export const voiceCaptureCommandSchema = z
  .strictObject({
    intent: voiceIntentSchema,
    /**
     * BCP-47 tag of the language the update was spoken in.
     *
     * Recorded because the confirmation is shown back in that language, and
     * because the transcript is evidence in a specific language rather than in
     * whichever one the model prefers.
     */
    language: z.string().trim().min(2),
    /** What was heard, verbatim, in the language it was spoken. */
    transcript: z.string().trim().min(1),
    /** The item as the speaker named it; matched to the catalogue afterwards. */
    itemName: z.string().trim().min(1).nullable(),
    quantity: z.int().positive().nullable(),
    /**
     * The batch and expiry, when the speaker read them off the pack.
     *
     * A receipt states the lot it arrived in — the ledger demands it — so a
     * goods-received update that omits them is held for a person rather than
     * written. Both are null for every other intent.
     */
    batchId: batchIdSchema.nullable(),
    expiresOn: dateSchema.nullable(),
    /** Only meaningful for an adjustment, where its direction cannot be inferred. */
    adjustmentDirection: adjustmentDirectionSchema.nullable(),
    cadre: cadreSchema.nullable(),
    bedsTotal: z.int().nonnegative().nullable(),
    bedsOccupied: z.int().nonnegative().nullable(),
    postsSanctioned: z.int().nonnegative().nullable(),
    postsFilled: z.int().nonnegative().nullable(),
    presentToday: z.int().nonnegative().nullable(),
    /** How sure the parse is of the intent and the fields, in [0, 1]. */
    confidence: z.number().min(0).max(1),
    /**
     * Everything the speaker must settle before the record is written.
     *
     * A list rather than a single flag, because the confirmation is only useful
     * if it asks about the actual uncertainty — an unknown item, a unit that was
     * not stated, a date the speaker did not give.
     */
    ambiguities: z.array(z.string().trim().min(1)),
  })
  .refine(
    (command) =>
      VOICE_STOCK_KINDS[command.intent] === undefined ||
      (command.itemName !== null && command.quantity !== null),
    {
      message: 'a stock update must carry the item and the quantity that were spoken',
      path: ['quantity'],
    },
  )
  .refine(
    (command) =>
      command.intent === 'stock_receipt' ||
      (command.batchId === null && command.expiresOn === null),
    {
      message: 'only a receipt names a batch, because only arriving stock has one',
      path: ['batchId'],
    },
  )
  .refine((command) => command.intent !== 'unknown' || command.quantity === null, {
    message: 'an utterance that was not understood carries no quantity',
    path: ['intent'],
  })
  .refine(
    (command) => command.intent !== 'stock_adjustment' || command.adjustmentDirection !== null,
    { message: 'an adjustment must say which way the stock moved', path: ['adjustmentDirection'] },
  )
  .refine(
    (command) =>
      command.intent !== 'bed_status' ||
      (command.bedsTotal !== null && command.bedsOccupied !== null),
    {
      message: 'a bed update must carry both the occupied and the total count',
      path: ['bedsOccupied'],
    },
  )
  .refine(
    (command) =>
      command.intent !== 'staff_attendance' ||
      (command.cadre !== null && command.postsSanctioned !== null && command.postsFilled !== null),
    {
      message: 'an attendance update must name the cadre and the posts it is about',
      path: ['postsFilled'],
    },
  )
  .refine(
    (command) =>
      (command.bedsOccupied === null || command.bedsTotal === null
        ? true
        : command.bedsOccupied <= command.bedsTotal) &&
      (command.postsFilled === null || command.postsSanctioned === null
        ? true
        : command.postsFilled <= command.postsSanctioned) &&
      (command.presentToday === null || command.postsFilled === null
        ? true
        : command.presentToday <= command.postsFilled),
    { message: 'a spoken count cannot contradict itself', path: ['bedsOccupied'] },
  );

export type VoiceCaptureCommand = z.infer<typeof voiceCaptureCommandSchema>;
