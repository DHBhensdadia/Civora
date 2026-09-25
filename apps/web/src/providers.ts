import { selectReasoningProvider } from '@civora/ai';
import { CivoraError, FixtureAuthProvider, InMemoryDataProvider } from '@civora/domain';
import type { AuthProvider, DataProvider, ReasoningProvider } from '@civora/domain';

import { getEnv } from './env';
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

/**
 * The reasoning adapter, selected by `@civora/ai` rather than here.
 *
 * The rule lives in the package because the batch jobs make the same choice from
 * the same variables, and a job that wrote fixture prose while the surface talked
 * to a model would make the platform's evidence about itself unreliable. What
 * stays here is the environment: this application validates it at start-up and
 * refuses to boot half-configured, so the selection below is handed values that
 * have already been checked and exists to keep the two callers identical.
 */
function createReasoningProvider(env: Env): ReasoningProvider {
  return selectReasoningProvider({
    provider: env.reasoningProvider,
    apiKey: env.geminiApiKey,
    model: env.geminiModel,
  });
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
