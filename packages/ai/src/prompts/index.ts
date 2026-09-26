import type {
  AdvisoryDraft,
  DriverExplanation,
  RoundNarrative,
  StockExtraction,
  TransferRationale,
  VoiceCaptureCommand,
} from '@civora/domain';

import { advisoryPrompt } from './advisory';
import { driverExplanationPrompt } from './driver-explanation';
import { federationNarrativePrompt } from './federation-narrative';
import { stockExtractionPrompt } from './stock-extraction';
import { transferRationalePrompt } from './transfer-rationale';
import { voiceCommandPrompt } from './voice-command';
import type { Prompt } from './prompt';

/**
 * The prompt corpus.
 *
 * Six tasks, each a file with a system instruction and an explicit output
 * schema. They are gathered here so that the set is inspectable in one place —
 * what the platform asks a model to do should be a short list readable at a
 * glance, not something discovered by searching for string literals.
 */

export { definePrompt, contextTextOf, JSON_ONLY, NO_INVENTED_NUMBERS } from './prompt';
export type { Prompt, PromptInput, PromptParameter, PromptSpec } from './prompt';

export { advisoryPrompt } from './advisory';
export { driverExplanationPrompt } from './driver-explanation';
export { federationNarrativePrompt } from './federation-narrative';
export { stockExtractionPrompt } from './stock-extraction';
export { transferRationalePrompt } from './transfer-rationale';
export { voiceCommandPrompt } from './voice-command';

/**
 * Any prompt asset, with its own output type intact.
 *
 * A union of the concrete types rather than `Prompt<unknown>`: a prompt's schema
 * is in both an output and an input position on `ZodType`, so the five are not
 * interchangeable, and pretending otherwise would lose the type of every
 * answer a caller receives.
 */
export type RegisteredPrompt =
  | Prompt<StockExtraction>
  | Prompt<VoiceCaptureCommand>
  | Prompt<AdvisoryDraft>
  | Prompt<DriverExplanation>
  | Prompt<TransferRationale>
  | Prompt<RoundNarrative>;

/** Every prompt asset, in the order the phase file lists them. */
export const PROMPTS: readonly RegisteredPrompt[] = [
  stockExtractionPrompt,
  voiceCommandPrompt,
  advisoryPrompt,
  driverExplanationPrompt,
  transferRationalePrompt,
  federationNarrativePrompt,
];

/** The prompt registered under a composed `task@version` identifier, if any. */
export function promptById(id: string): RegisteredPrompt | undefined {
  return PROMPTS.find((prompt) => prompt.id === id);
}
