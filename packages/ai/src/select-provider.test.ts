import { describe, expect, it } from 'vitest';

import { ReasoningSelectionError, selectReasoningProvider } from './select-provider';

/**
 * Which adapter runs, from which configuration.
 *
 * Three properties, and each of them is something a person would notice: the
 * default needs no credentials, asking for the cloud adapter without credentials
 * names the variable that is missing rather than failing at the first call, and a
 * provider this build does not ship is refused by name instead of silently
 * falling back to the fixture.
 */

describe('selecting the reasoning adapter', () => {
  it('falls back to the fixture adapter when nothing is configured', () => {
    expect(selectReasoningProvider({ provider: undefined }).kind).toBe('fixture');
    expect(selectReasoningProvider({ provider: '' }).kind).toBe('fixture');
    expect(selectReasoningProvider({ provider: 'fixture' }).kind).toBe('fixture');
  });

  it('builds the cloud adapter once both its variables are present', () => {
    const provider = selectReasoningProvider({
      provider: 'gemini',
      apiKey: 'test-key-not-a-real-credential',
      model: 'gemini-test-model',
    });

    expect(provider.kind).toBe('gemini');
  });

  it('names the missing variable rather than building a client that cannot authenticate', () => {
    // A keyless client would fail at the first call instead of at start-up, which
    // is the failure mode this check exists to remove.
    expect(() =>
      selectReasoningProvider({ provider: 'gemini', model: 'gemini-test-model' }),
    ).toThrow(ReasoningSelectionError);
    expect(() => selectReasoningProvider({ provider: 'gemini', model: 'm' })).toThrow(
      /GEMINI_API_KEY is required/,
    );
    expect(() =>
      selectReasoningProvider({ provider: 'gemini', apiKey: 'test-key', model: '  ' }),
    ).toThrow(/GEMINI_MODEL is required/);
  });

  it('refuses an adapter this build does not ship instead of quietly using the fixture', () => {
    expect(() => selectReasoningProvider({ provider: 'genkit' })).toThrow(
      /is not a reasoning adapter this build ships/,
    );
  });
});
