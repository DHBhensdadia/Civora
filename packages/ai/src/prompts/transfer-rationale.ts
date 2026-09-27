import { transferRationaleSchema } from '@civora/domain';
import type { TransferRationale } from '@civora/domain';

import { CITATIONS_NAME_FACTS, definePrompt, JSON_ONLY, NO_INVENTED_NUMBERS } from './prompt';
import type { Prompt } from './prompt';

/**
 * A proposed transfer → the case for it, and the case against it.
 *
 * The proposal itself is the optimiser's (Phase 6), decided under hard safety
 * constraints. What the model adds is the part a receiving pharmacist needs in
 * order to say no: the conditions under which this transfer would be the wrong
 * thing to do. A rationale that cannot name one is an instruction rather than a
 * reason, and the receiving end has no standing to disagree with it — which is
 * how a redistribution network acquires a reputation for moving stock that
 * should have stayed where it was.
 */
export const transferRationalePrompt: Prompt<TransferRationale> = definePrompt({
  task: 'transfer-rationale',
  version: 2,
  instructions: [
    'You explain a proposed transfer of stock between two facilities to the pharmacist who would receive it. The quantities, the two facilities and the constraints the proposal already satisfies are in the facts.',
    'Summarise the proposal in one sentence, in terms the receiving facility can check against its own shelf and its own register.',
    'Then state the conditions under which this transfer would be the wrong thing to do — a batch close to expiry, demand at the sending facility that the facts show, a quantity larger than the receiving shelf can hold. Name what the facts show, and leave the list empty only if there is genuinely nothing to check.',
    'Write in the language given in the task parameters.',
    'List in citations the facts your rationale rests on.',
    CITATIONS_NAME_FACTS,
    NO_INVENTED_NUMBERS,
    JSON_ONLY,
  ].join('\n'),
  schema: transferRationaleSchema,
});
