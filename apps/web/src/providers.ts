import {
  CivoraError,
  FixtureAuthProvider,
  FixtureReasoningProvider,
  InMemoryDataProvider,
} from '@civora/domain';
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

function createReasoningProvider(env: Env): ReasoningProvider {
  switch (env.reasoningProvider) {
    case 'fixture':
      return new FixtureReasoningProvider();
    case 'gemini':
      throw new ProviderNotAvailableError(
        'the cloud reasoning adapter is not part of this build; select CIVORA_REASONING_PROVIDER=fixture',
      );
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
