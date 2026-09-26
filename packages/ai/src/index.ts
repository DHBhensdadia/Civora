/**
 * `@civora/ai` — the reasoning layer.
 *
 * Scope: implementations of the `ReasoningProvider` port defined in
 * `@civora/domain`. The cloud adapter produces structured, schema-locked output
 * and the fixture adapter replays responses recorded from real calls, so tests
 * and offline development exercise the same code path without spending quota.
 *
 * Two rules bind everything in this package. Responses are validated against a
 * caller-supplied schema before they leave the adapter, and a narrative that
 * contains a numeral absent from the supplied facts is rejected — quantities
 * originate in the deterministic engines, never in a model.
 *
 * The first rule is enforced here, on every call. The second is enforced by the
 * governance layer the advisories are written through, which is where a
 * narrative — as opposed to a validated record — first exists.
 *
 * Advisories are written **ahead of the burst**: `generateAdvisories` walks a
 * whole alert set for every language the record carries, `generateAdvisory`
 * reports a refusal as a result rather than throwing it, and
 * `withAdvisoryBodies` puts only the written bodies onto the record — so a
 * language that could not be written keeps the body somebody may be reading.
 */

export { GeminiReasoningProvider } from './gemini-provider';
export type {
  GeminiProviderOptions,
  InteractionClient,
  ModelInteractionResult,
} from './gemini-provider';
// The telemetry shape belongs to the port, not to an adapter, because both
// adapters report in it and a surface reads whichever one is configured.
export type { ReasoningTaskTelemetry, ReasoningTelemetry } from '@civora/domain';

export { createGeminiClient } from './gemini-client';
export type { GeminiClientOptions } from './gemini-client';

export {
  REASONING_PROVIDER_KINDS,
  ReasoningSelectionError,
  selectReasoningProvider,
} from './select-provider';
export type { ReasoningProviderKind, ReasoningSelection } from './select-provider';

export {
  advisoryFactsOf,
  advisoryLanguagesOf,
  advisoryRequestFor,
  advisorySchemaFor,
  advisoryTextsOf,
  generateAdvisories,
  generateAdvisory,
  withAdvisoryBodies,
  writeAdvisory,
} from './advisory';
export type { AdvisoryAttempt } from './advisory';

export { allowedNumeralsOf, grounded, groundingProblems, numeralsIn } from './grounding';

export {
  generateRationale,
  generateRationales,
  rationaleFactsOf,
  rationaleRequestFor,
  rationaleSchemaFor,
  rationaleTextsOf,
  writeRationale,
} from './rationale';
export type { RationaleAttempt, TransferRationaleInput } from './rationale';

export {
  generateRoundNarrative,
  generateRoundNarratives,
  narrativeFactsOf,
  narrativeRequestFor,
  narrativeSchemaFor,
  narrativeTextsOf,
  writeRoundNarrative,
} from './federation-narrative';
export type { NarrativeAttempt, RoundNarrativeInput } from './federation-narrative';

export { correctionTextOf, factsTextOf, interactionRequestFor } from './request';
export type { ModelContent, ModelInteractionRequest, ModelUsage } from './request';

export {
  advisoryPrompt,
  contextTextOf,
  definePrompt,
  driverExplanationPrompt,
  federationNarrativePrompt,
  JSON_ONLY,
  NO_INVENTED_NUMBERS,
  PROMPTS,
  promptById,
  stockExtractionPrompt,
  transferRationalePrompt,
  voiceCommandPrompt,
} from './prompts';
export type { Prompt, PromptInput, PromptParameter, PromptSpec, RegisteredPrompt } from './prompts';
