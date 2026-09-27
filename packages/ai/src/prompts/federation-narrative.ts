import { roundNarrativeSchema } from '@civora/domain';
import type { RoundNarrative } from '@civora/domain';

import { CITATIONS_NAME_FACTS, definePrompt, JSON_ONLY, NO_INVENTED_NUMBERS } from './prompt';
import type { Prompt } from './prompt';

/**
 * One federated round's ledger → a summary of it, and of what it does not show.
 *
 * The round already happened: the participants, the row counts, the losses, the
 * noise the accountant priced and the ε it spent are all in the facts, computed
 * by the coordinator and the accountant. The writer's only job is to say what
 * those numbers mean together — and, because a federation demo is the easiest
 * place in this project to overclaim, to say what the round does not establish:
 * that the silos are simulated regions on one machine, that the ε is spent
 * against record-level differential privacy and not against an inference attack,
 * that a lower loss here is not a clinical outcome.
 */
export const federationNarrativePrompt: Prompt<RoundNarrative> = definePrompt({
  task: 'federation-narrative',
  version: 2,
  instructions: [
    'You summarise one round of federated training between administrative silos for an engineer reading the federation console. Every participant, count, loss, noise figure and privacy budget in the facts is a measurement already taken; state them and what they mean together.',
    'Say whether the round reduced the shared model’s error, using the global loss before and after this round. If the facts do not show a reduction, say that instead of implying progress.',
    'Explain the noise and the privacy budget in the facts in plain terms: the standard deviation is the Gaussian noise added to the clipped aggregate, and the ε is the cumulative budget spent at the stated δ. If no ε is present, say that this run added no noise and therefore has no privacy bound.',
    'State what this round cannot support. The silos are simulated administrative partitions running on one machine, so nothing here is a deployed multi-organisation federation; the ε bounds what a record can contribute to what is sent, not what an observer could infer; and a lower squared error is a fit to recorded demand, not a clinical or operational outcome.',
    'Do not name a facility, an item, a patient or a date: none exists in the facts, and their absence is the point of the boundary.',
    'List in citations the facts your narrative rests on.',
    CITATIONS_NAME_FACTS,
    NO_INVENTED_NUMBERS,
    JSON_ONLY,
  ].join('\n'),
  schema: roundNarrativeSchema,
});
