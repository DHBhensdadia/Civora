import { driverExplanationSchema } from '@civora/domain';
import type { DriverExplanation } from '@civora/domain';

import { definePrompt, JSON_ONLY, NO_INVENTED_NUMBERS } from './prompt';
import type { Prompt } from './prompt';

/**
 * One risk driver → one plain-language explanation.
 *
 * Each of the nine drivers already produces a detail sentence in `logic/risk`,
 * and that sentence is the fact this task rewrites. Rewriting is not padding: it
 * is the step that turns "lead time 9 d against shelf 4 d" into something a
 * pharmacist can act on, in their language, without the risk of the model
 * restating the arithmetic as its own. The shape has no contribution field for
 * exactly that reason — the number is the engine's and stays on the record.
 */
export const driverExplanationPrompt: Prompt<DriverExplanation> = definePrompt({
  task: 'driver-explanation',
  version: 1,
  instructions: [
    'You explain one risk driver to the pharmacist who holds the shelf. The driver, what it contributed and the sentence the engine wrote about it are all in the facts.',
    'Put it in plain words: what was measured here, why it matters for this item at this facility, and what would have to change for the driver to stop contributing.',
    'Do not restate the driver’s contribution as though you had computed it, and do not compare this facility with another — you were given one.',
    'Write in the language given in the task parameters. Keep it to a headline and two or three sentences: this sits beside a shelf, not in a report.',
    'List in citations the names of the facts your explanation rests on.',
    NO_INVENTED_NUMBERS,
    JSON_ONLY,
  ].join('\n'),
  schema: driverExplanationSchema,
});
