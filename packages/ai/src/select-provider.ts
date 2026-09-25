import { CivoraError, FixtureReasoningProvider } from '@civora/domain';
import type { ReasoningProvider } from '@civora/domain';

import { GeminiReasoningProvider } from './gemini-provider';
import { createGeminiClient } from './gemini-client';

/**
 * Which reasoning adapter runs, decided in one place.
 *
 * Two callers make this choice: the web process, from its validated environment,
 * and the batch jobs, from the environment they were started with. They must
 * arrive at the same adapter for the same configuration — a batch job that wrote
 * fixture prose while the surface talked to a model, or the reverse, would make
 * the platform's own evidence about itself unreliable — so the rule lives here
 * rather than once in each application.
 *
 * What stays with the caller is the *reading* of the environment: the web app
 * validates its variables at start-up and refuses to boot half-configured, and a
 * command-line job reports the same problem as a message and a non-zero exit. The
 * selection below is the part that must not differ.
 *
 * Two properties are deliberate and are what makes this safe to run in a demo:
 *
 *  - **The default needs no credentials.** Anything unrecognised, and the default
 *    when nothing is configured, is the fixture adapter.
 *  - **The fixture adapter refuses rather than pretends.** With no recorded
 *    responses it answers every request with a refusal naming the task, so a
 *    screen with no model behind it says so instead of appearing to work.
 */

export const REASONING_PROVIDER_KINDS = ['fixture', 'gemini'] as const;
export type ReasoningProviderKind = (typeof REASONING_PROVIDER_KINDS)[number];

/** Raised when configuration selects an adapter this build cannot construct. */
export class ReasoningSelectionError extends CivoraError {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = 'ReasoningSelectionError';
    this.variable = variable;
  }
}

export interface ReasoningSelection {
  /** `fixture` or `gemini`. Unset means the fixture adapter. */
  readonly provider: string | undefined;
  readonly apiKey?: string | undefined;
  readonly model?: string | undefined;
}

export function selectReasoningProvider(selection: ReasoningSelection): ReasoningProvider {
  switch (selection.provider) {
    case undefined:
    case '':
    case 'fixture':
      return new FixtureReasoningProvider();
    case 'gemini': {
      const apiKey = selection.apiKey;
      const model = selection.model;

      // Both are required together: a key with no model cannot be called, and a
      // model with no key cannot be authenticated. Named as the variable a person
      // has to set, because the failure they will read is this message.
      if (apiKey === undefined || apiKey.trim() === '') {
        throw new ReasoningSelectionError(
          'GEMINI_API_KEY',
          'GEMINI_API_KEY is required when CIVORA_REASONING_PROVIDER is "gemini"',
        );
      }
      if (model === undefined || model.trim() === '') {
        throw new ReasoningSelectionError(
          'GEMINI_MODEL',
          'GEMINI_MODEL is required when CIVORA_REASONING_PROVIDER is "gemini"',
        );
      }

      return new GeminiReasoningProvider({
        client: createGeminiClient({ apiKey: apiKey.trim(), model: model.trim() }),
      });
    }
    default:
      throw new ReasoningSelectionError(
        'CIVORA_REASONING_PROVIDER',
        `"${selection.provider}" is not a reasoning adapter this build ships; supported: ${REASONING_PROVIDER_KINDS.join(', ')}`,
      );
  }
}
