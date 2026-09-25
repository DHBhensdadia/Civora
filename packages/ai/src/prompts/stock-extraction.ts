import { stockExtractionSchema } from '@civora/domain';
import type { StockExtraction } from '@civora/domain';

import { definePrompt, JSON_ONLY } from './prompt';
import type { Prompt } from './prompt';

/**
 * Photograph of a paper register → structured lines.
 *
 * This is the one prompt whose quantities are not grounded in a fact set, and
 * the distinction is worth being precise about rather than leaving to a comment:
 * the numbers here are **read off an image the person supplied**, so they are a
 * transcription of evidence rather than a composition by a model. The platform's
 * answer to the obvious risk is not a promise but a mechanism — every line
 * carries a confidence, and a line below the review threshold cannot reach the
 * ledger until a person has looked at it.
 *
 * The instruction that does most of the work is the one forbidding improvement:
 * a register read into a cleaner name is a name the platform's catalogue cannot
 * match, which turns a small reading error into a new item.
 */
export const stockExtractionPrompt: Prompt<StockExtraction> = definePrompt({
  task: 'stock-extraction',
  version: 1,
  instructions: [
    'You read photographs of paper stock registers kept at primary health centres and sub-centres in India. The photograph is the evidence: transcribe it, do not interpret it.',
    'For every row you can make out, report the item name exactly as it is written on the page, the quantity in that row, the unit if there is a unit column, the batch number and the expiry date if they are legible.',
    'Do not expand abbreviations, correct spellings, translate names, convert units or reorder the columns. The platform matches the written name against its own catalogue afterwards, and a name you improved is a name it can no longer match.',
    'Give each line a confidence between 0 and 1 for how sure you are of what is written — not for whether the stock is correct. A digit that could be a 6 or an 8 is the one you read as most likely, at low confidence, with a note saying what is doubtful. Never guess, and never carry a value across from another row.',
    'A cell that is empty is null. A column that is not on the page is null. A field you cannot read is null with a note, never a plausible default.',
    'If the page cannot be read at all — too dark, cut off, folded, or not a register — return no lines and say in the notes what you saw.',
    'Do not report a facility identifier, an item identifier, a price or a computed total. None of those are in the photograph, so any that appeared in your answer would be one you invented.',
    JSON_ONLY,
  ].join('\n'),
  schema: stockExtractionSchema,
});
