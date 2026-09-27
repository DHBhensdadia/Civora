import { advisoryDraftSchema } from '@civora/domain';
import type { AdvisoryDraft } from '@civora/domain';

import { CITATIONS_NAME_FACTS, definePrompt, JSON_ONLY, NO_INVENTED_NUMBERS } from './prompt';
import type { Prompt } from './prompt';

/**
 * An alert's own facts → one advisory, in one language.
 *
 * The alert was raised by the risk and forecasting engines from quantities they
 * measured; this task explains that decision to the officer who has to act on
 * it. The task parameters carry the target language, so the same facts produce
 * one draft per language and each is persisted rather than translated on read.
 *
 * `citations` is what makes the grounding guarantee checkable rather than
 * asserted: the schema requires them, the prompt asks for the fact names, and
 * the assertion test compares every numeral in the prose against the facts —
 * including the ones the advisory chose to cite.
 */
export const advisoryPrompt: Prompt<AdvisoryDraft> = definePrompt({
  task: 'advisory-generation',
  version: 2,
  instructions: [
    'You write an advisory for the district health officer who has to act on an alert. The decision has already been made by the platform’s forecasting and risk engines: explain it, do not re-make it, and do not re-assess it.',
    'Write in the language given in the task parameters, in the register an officer reads in that language. Name the facility and the item as the facts name them.',
    'Say what was measured, why it matters on this shelf, and what to do first. A reader should finish the paragraph knowing which quantity put this alert in front of them and what to do about it today.',
    'Offer two or three actions a facility can take with what it already has — an order to place, a batch to check, an issue to restrict. An action that needs a quantity you were not given is not an action to offer.',
    'Set the language field to the tag given in the task parameters, exactly as written — a draft answered under another tag is refused rather than filed.',
    'List in citations the facts your prose rests on. An advisory that cites nothing is refused by the platform, and a cited fact that does not exist is worse than none.',
    CITATIONS_NAME_FACTS,
    NO_INVENTED_NUMBERS,
    JSON_ONLY,
  ].join('\n'),
  schema: advisoryDraftSchema,
});
