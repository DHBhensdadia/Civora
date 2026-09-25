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
 */

export { GeminiReasoningProvider } from './gemini-provider';
export type {
  GeminiProviderOptions,
  InteractionClient,
  ModelInteractionResult,
  ReasoningTelemetry,
} from './gemini-provider';

export { createGeminiClient } from './gemini-client';
export type { GeminiClientOptions } from './gemini-client';

export { correctionTextOf, factsTextOf, interactionRequestFor } from './request';
export type { ModelContent, ModelInteractionRequest, ModelUsage } from './request';

export {
  advisoryPrompt,
  contextTextOf,
  definePrompt,
  driverExplanationPrompt,
  JSON_ONLY,
  NO_INVENTED_NUMBERS,
  PROMPTS,
  promptById,
  stockExtractionPrompt,
  transferRationalePrompt,
  voiceCommandPrompt,
} from './prompts';
export type { Prompt, PromptInput, PromptParameter, PromptSpec, RegisteredPrompt } from './prompts';
