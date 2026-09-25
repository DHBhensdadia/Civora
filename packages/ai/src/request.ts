import type { Fact, ReasoningRequest } from '@civora/domain';
import { z } from 'zod';

/**
 * The Gemini `interactions` request this adapter sends.
 *
 * Fields are snake_case because this type is the wire shape, not one of the
 * platform's own contracts: the platform speaks `ReasoningRequest` and this is
 * the translation of that into a question a model can answer. Keeping the
 * translation in one pure function is what makes it testable without a network
 * and reviewable without a live key.
 *
 * The shape is evidence, not assumption. The installed SDK accepts
 * `model`, `input`, `system_instruction`, `response_format` and `store` at the
 * top level of `interactions.create`, and its media blocks are typed per
 * modality — an image arrives as base64 in `data` beside its MIME type, which is
 * what a photograph taken on a phone already is by the time it reaches a server.
 */

/** One content block, in the shape the `interactions` surface accepts. */
export type ModelContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mime_type: string };

/**
 * Token counts, as the surface reports them.
 *
 * Both fields are optional and the adapter records what it was given rather than
 * a zero: a missing count is *not reported*, and a zero that reads as a
 * measurement would be a fabricated number in a telemetry panel.
 */
export interface ModelUsage {
  readonly total_input_tokens?: number | undefined;
  readonly total_output_tokens?: number | undefined;
}

/** A request for one model interaction. */
export interface ModelInteractionRequest {
  readonly model: string;
  readonly input: ModelContent[];
  readonly system_instruction: string;
  readonly response_format: {
    readonly type: 'text';
    readonly mime_type: 'application/json';
    readonly schema: Record<string, unknown>;
  };
  /**
   * Never retained on the vendor's side.
   *
   * The facts in this request describe what a named facility holds and how many
   * cases a named district is seeing. Letting a provider store them would create
   * a second copy of the platform's most sensitive data with none of its own
   * tenancy, retention or audit around it.
   */
  readonly store: false;
}

/**
 * The fact block: the only admissible source of quantities.
 *
 * It is written out in full for every call rather than summarised, because the
 * guarantee the platform makes to a reader of generated prose is that every
 * number in it was supplied. A fact that was not sent cannot have been grounded.
 */
export function factsTextOf(facts: readonly Fact[]): string {
  if (facts.length === 0) {
    return 'Facts: none supplied. State no quantities.';
  }

  const lines = facts.map((fact) => `- ${fact.key}: ${String(fact.value)}`);
  return ['Facts (the only admissible source of quantities):', ...lines].join('\n');
}

/**
 * Build the request for one reasoning task.
 *
 * The schema is bridged rather than described in prose. `z.toJSONSchema` turns
 * the same zod object the caller will validate the answer with into the JSON
 * schema the model is constrained by, so there is one source of truth for the
 * output shape and no chance of the instruction and the validation drifting
 * apart.
 *
 * A schema zod cannot express as JSON schema is a programming error made by the
 * caller, and it is raised as a `ReasoningProviderError` by the provider rather
 * than becoming a request that cannot be satisfied.
 */
export function interactionRequestFor<T>(
  request: ReasoningRequest<T>,
  model: string,
): ModelInteractionRequest {
  const schema: unknown = z.toJSONSchema(request.schema, { io: 'output' });

  const input: ModelContent[] = [{ type: 'text', text: factsTextOf(request.facts) }];
  for (const image of request.images ?? []) {
    input.push({ type: 'image', data: image.data, mime_type: image.mimeType });
  }

  return {
    model,
    input,
    system_instruction: request.instructions,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema as Record<string, unknown>,
    },
    store: false,
  };
}

/**
 * The block appended after an answer the schema rejected.
 *
 * Feeding the validation error back is the difference between a retry and a
 * re-roll: the second attempt is told what was wrong with the first, in the
 * validator's own words, so a model that is merely formatting badly has a chance
 * to correct itself before the call is abandoned.
 */
export function correctionTextOf(problem: string): ModelContent {
  return {
    type: 'text',
    text: [
      'Your previous answer did not satisfy the required schema.',
      `It failed with: ${problem}`,
      'Answer again. Reply with JSON only, conforming to the schema, and use no quantity that is not in the facts above.',
    ].join('\n'),
  };
}
