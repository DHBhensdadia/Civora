import { voiceCaptureCommandSchema } from '@civora/domain';
import type { VoiceCaptureCommand } from '@civora/domain';

import { definePrompt, JSON_ONLY } from './prompt';
import type { Prompt } from './prompt';

/**
 * One spoken update → one capture command, awaiting confirmation.
 *
 * The output is a proposal. Nothing is ingested from it until the speaker has
 * been shown what was heard and has agreed to it, which is why the transcript is
 * carried verbatim and the uncertainty is carried as questions rather than
 * resolved — a model that silently chose between two drug names would make the
 * confirmation screen a rubber stamp instead of a check.
 *
 * Numbers spoken aloud are transcribed, not computed: "twelve" is 12, and a
 * fractional spoken quantity belongs in the ambiguities because the platform's
 * records are whole units. That line is in the instruction because it is the
 * boundary between transcribing and inventing.
 */
export const voiceCommandPrompt: Prompt<VoiceCaptureCommand> = definePrompt({
  task: 'voice-command-parsing',
  version: 1,
  instructions: [
    'You turn one spoken update from a health worker into one capture command. The update is about stock, beds or attendance at a facility, spoken in an Indian language, by someone who may be speaking rather than typing on purpose.',
    'First decide the intent, then extract only what was actually said: the item as the speaker named it, the quantity, the cadre, the bed counts, the posts.',
    'A number spoken as a word is still a number: "twelve" is 12. A fractional or rounded spoken amount — "about ten", "one and a half" — is not a whole-unit count: leave the quantity null and put the question in the ambiguities instead.',
    'Write the transcript verbatim, in the language it was spoken, keeping the filler words. It is what the speaker will be shown back and asked to confirm, so do not tidy it, translate it, or summarise it. Report the language as its BCP-47 tag, for example hi, mr, bn, ta or en.',
    'If you are not certain which item was meant, leave the item name null and add the question to the ambiguities. Never pick the closest catalogue name: no catalogue was given to you, and the platform matches names itself.',
    'Confidence is how sure you are of the intent and of every field, not of the arithmetic. Every assumption you had to make goes into the ambiguities as a question the speaker can answer, because that list is the confirmation the platform shows before it writes anything.',
    'If the utterance is not a stock, bed or attendance update, set the intent to unknown, carry no quantity, and say in the ambiguities what was missing.',
    'Do not invent a speaker, a facility, a date, a batch or an item that was not said.',
    JSON_ONLY,
  ].join('\n'),
  schema: voiceCaptureCommandSchema,
});
