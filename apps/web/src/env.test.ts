import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env';

describe('loadEnv', () => {
  it('runs on local adapters with no credentials at all', () => {
    const env = loadEnv({});

    expect(env).toEqual({
      appName: 'Civora',
      dataProvider: 'in-memory',
      authProvider: 'fixture',
      reasoningProvider: 'fixture',
      firebaseProjectId: undefined,
      geminiApiKey: undefined,
      geminiModel: undefined,
    });
  });

  it('treats a copied .env.example as unconfigured rather than misconfigured', () => {
    const env = loadEnv({
      NEXT_PUBLIC_APP_NAME: 'Civora',
      CIVORA_REASONING_PROVIDER: 'fixture',
      GEMINI_API_KEY: '',
      GEMINI_MODEL: '   ',
      NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: '',
    });

    expect(env.reasoningProvider).toBe('fixture');
    expect(env.geminiApiKey).toBeUndefined();
    expect(env.geminiModel).toBeUndefined();
  });

  it('requires the reasoning credentials once the cloud adapter is selected', () => {
    expect(() => loadEnv({ CIVORA_REASONING_PROVIDER: 'gemini' })).toThrow(EnvValidationError);

    try {
      loadEnv({ CIVORA_REASONING_PROVIDER: 'gemini' });
      expect.unreachable('expected configuration to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(issues).toContain('GEMINI_API_KEY');
      expect(issues).toContain('GEMINI_MODEL');
    }
  });

  it('accepts the cloud adapter once its credentials are present', () => {
    const env = loadEnv({
      CIVORA_REASONING_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key-not-a-real-credential',
      GEMINI_MODEL: 'gemini-test-model',
    });

    expect(env.reasoningProvider).toBe('gemini');
    expect(env.geminiModel).toBe('gemini-test-model');
  });

  it('requires a project id before a hosted adapter can be selected', () => {
    try {
      loadEnv({ CIVORA_DATA_PROVIDER: 'firestore' });
      expect.unreachable('expected configuration to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const issues = (error as EnvValidationError).issues.map((issue) => issue.variable);
      expect(issues).toContain('NEXT_PUBLIC_FIREBASE_PROJECT_ID');
    }
  });

  it('names the offending variable when a value is not recognised', () => {
    try {
      loadEnv({ CIVORA_DATA_PROVIDER: 'sqlite' });
      expect.unreachable('expected configuration to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const [first] = (error as EnvValidationError).issues;
      expect(first?.variable).toBe('CIVORA_DATA_PROVIDER');
    }
  });

  it('reports every problem in one message', () => {
    try {
      loadEnv({ CIVORA_DATA_PROVIDER: 'sqlite', CIVORA_AUTH_PROVIDER: 'ldap' });
      expect.unreachable('expected configuration to be rejected');
    } catch (error) {
      const message = (error as EnvValidationError).message;
      expect(message).toContain('CIVORA_DATA_PROVIDER');
      expect(message).toContain('CIVORA_AUTH_PROVIDER');
    }
  });
});
