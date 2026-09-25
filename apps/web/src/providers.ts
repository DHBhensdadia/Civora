import { GeminiReasoningProvider, createGeminiClient } from '@civora/ai';
import {
  CivoraError,
  FixtureAuthProvider,
  FixtureReasoningProvider,
  InMemoryDataProvider,
} from '@civora/domain';
import type { AuthProvider, DataProvider, ReasoningProvider } from '@civora/domain';

import { EnvValidationError, getEnv } from './env';
import type { Env } from './env';

/** The adapters this process is running against. */
export interface Providers {
  readonly data: DataProvider;
  readonly auth: AuthProvider;
  readonly reasoning: ReasoningProvider;
}

/** Raised when configuration selects an adapter this build does not ship. */
export class ProviderNotAvailableError extends CivoraError {}

function assertNever(value: never): never {
  throw new CivoraError(`unhandled adapter selection: ${String(value)}`);
}

function createDataProvider(env: Env): DataProvider {
  switch (env.dataProvider) {
    case 'in-memory':
      return new InMemoryDataProvider();
    case 'firestore':
      throw new ProviderNotAvailableError(
        'the firestore data adapter is not part of this build; select CIVORA_DATA_PROVIDER=in-memory',
      );
    default:
      return assertNever(env.dataProvider);
  }
}

function createAuthProvider(env: Env): AuthProvider {
  switch (env.authProvider) {
    case 'fixture':
      return new FixtureAuthProvider();
    case 'firebase':
      throw new ProviderNotAvailableError(
        'the firebase identity adapter is not part of this build; select CIVORA_AUTH_PROVIDER=fixture',
      );
    default:
      return assertNever(env.authProvider);
  }
}

function createReasoningProvider(env: Env): ReasoningProvider {
  switch (env.reasoningProvider) {
    case 'fixture':
      // Replays recorded responses. With no recordings in this build it refuses
      // every request rather than inventing an answer, which is what keeps a
      // surface from appearing to work while no model is behind it.
      return new FixtureReasoningProvider();
    case 'gemini': {
      const { geminiApiKey, geminiModel } = env;
      // Environment validation already refuses to start without both of these
      // when this adapter is selected; the check is here because the type does
      // not carry that guarantee and a keyless client would fail at the first
      // call instead of at start-up.
      if (geminiApiKey === undefined || geminiModel === undefined) {
        throw new EnvValidationError([
          {
            variable: 'GEMINI_API_KEY',
            message: 'required when CIVORA_REASONING_PROVIDER is "gemini"',
          },
        ]);
      }
      return new GeminiReasoningProvider({
        client: createGeminiClient({ apiKey: geminiApiKey, model: geminiModel }),
      });
    }
    default:
      return assertNever(env.reasoningProvider);
  }
}

let cached: Providers | undefined;

/**
 * Resolve the process's adapters once.
 *
 * Adapters are constructed behind their ports, so a later phase swaps an
 * implementation here and no calling code changes.
 */
export function getProviders(): Providers {
  if (cached !== undefined) {
    return cached;
  }

  const env = getEnv();
  cached = {
    data: createDataProvider(env),
    auth: createAuthProvider(env),
    reasoning: createReasoningProvider(env),
  };
  return cached;
}
