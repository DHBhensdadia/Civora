import { FixtureReasoningProvider, ReasoningProviderError } from '@civora/domain';
import type { Fact, ImageInput, ReasoningProvider, ReasoningRequest } from '@civora/domain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { GeminiReasoningProvider } from './gemini-provider';
import type { InteractionClient, ModelInteractionResult } from './gemini-provider';
import { factsTextOf, interactionRequestFor } from './request';

/**
 * The reasoning boundary, held to its promises with a stub in place of the model.
 *
 * Every test here is about something the platform claims to a reader: that the
 * model is constrained by the caller's own schema, that a rejected answer is
 * corrected rather than accepted, that the same question is not paid for twice,
 * and that what was called is counted rather than estimated.
 */

const extraction = z.object({
  item: z.string(),
  quantity: z.number().int().nonnegative(),
});

type ModelRequest = Parameters<InteractionClient['create']>[0];

interface StubClient extends InteractionClient {
  readonly calls: ModelRequest[];
  /** Every request is kept as text, so a test can assert what the model saw. */
  readonly seen: string[];
}

function stubClient(answers: readonly (ModelInteractionResult | Error)[]): StubClient {
  const calls: ModelRequest[] = [];
  const seen: string[] = [];
  let index = 0;

  return {
    model: 'gemini-3.8-flash',
    calls,
    seen,
    async create(request) {
      calls.push(request);
      seen.push(JSON.stringify(request.input));
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer ?? {};
    },
  };
}

interface RequestOverrides {
  readonly task?: string;
  readonly facts?: readonly Fact[];
  readonly schema?: ReasoningRequest<unknown>['schema'];
  readonly images?: readonly ImageInput[];
}

function requestFor(overrides: RequestOverrides = {}): ReasoningRequest<unknown> {
  return {
    task: overrides.task ?? 'stock-extraction',
    instructions: 'Read the register in the photograph.',
    schema: overrides.schema ?? extraction,
    facts: overrides.facts ?? [],
    images: overrides.images ?? [],
  };
}

/** The text block at the head of a request, which is where the facts go. */
function textOf(payload: ModelRequest): string {
  const first = payload.input[0];
  return first?.type === 'text' ? first.text : '';
}

describe('the request the adapter sends', () => {
  it('bridges the caller’s schema into the request rather than describing it in prose', () => {
    const payload = interactionRequestFor(requestFor(), 'gemini-3.8-flash');

    expect(payload.model).toBe('gemini-3.8-flash');
    expect(payload.system_instruction).toBe('Read the register in the photograph.');
    expect(payload.response_format.mime_type).toBe('application/json');
    // Not a hand-written approximation of the schema: the same one the answer
    // will be validated against, in the form the model is constrained by.
    expect(payload.response_format.schema).toMatchObject({
      type: 'object',
      required: ['item', 'quantity'],
    });
    expect(payload.response_format.schema.additionalProperties).toBe(false);
  });

  it('sends the facts in full, and says plainly when there are none', () => {
    const payload = interactionRequestFor(
      requestFor({
        facts: [
          { key: 'daysOfStock', value: 4 },
          { key: 'shortfallProbability', value: 0.7 },
        ],
      }),
      'gemini-3.8-flash',
    );

    expect(textOf(payload)).toContain('daysOfStock: 4');
    expect(textOf(payload)).toContain('shortfallProbability: 0.7');
    expect(factsTextOf([])).toContain('none supplied');
  });

  it('sends an image as its own block, with the bytes and the MIME type together', () => {
    const payload = interactionRequestFor(
      requestFor({ images: [{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }] }),
      'gemini-3.8-flash',
    );

    expect(payload.input).toEqual([
      { type: 'text', text: factsTextOf([]) },
      { type: 'image', data: 'ZmFrZQ==', mime_type: 'image/jpeg' },
    ]);
  });

  it('never asks the provider to retain the request', () => {
    expect(interactionRequestFor(requestFor(), 'gemini-3.8-flash').store).toBe(false);
  });

  it('refuses a schema with no JSON form instead of sending an unsatisfiable request', async () => {
    const provider = new GeminiReasoningProvider({
      client: stubClient([{ output_text: '{}' }]),
    });

    await expect(
      provider.reason(requestFor({ task: 'impossible', schema: z.date() })),
    ).rejects.toThrow(ReasoningProviderError);
  });
});

describe('a validated answer', () => {
  it('returns the parsed value and says which model produced it', async () => {
    const client = stubClient([{ output_text: '{"item":"Paracetamol","quantity":12}' }]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    const response = await provider.reason(requestFor());

    expect(response.value).toEqual({ item: 'Paracetamol', quantity: 12 });
    expect(response.provider).toBe('gemini');
    expect(response.model).toBe('gemini-3.8-flash');
    expect(response.cacheHit).toBe(false);
    expect(client.calls).toHaveLength(1);
  });

  it('answers an identical request from the cache and does not pay for it twice', async () => {
    const client = stubClient([{ output_text: '{"item":"Paracetamol","quantity":12}' }]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    const first = await provider.reason(requestFor());
    const second = await provider.reason(requestFor());

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(client.calls).toHaveLength(1);
    expect(provider.telemetry().cacheHits).toBe(1);
  });

  it('does not serve one request’s answer to a request that differs only in its facts', async () => {
    const client = stubClient([
      { output_text: '{"item":"Paracetamol","quantity":12}' },
      { output_text: '{"item":"Paracetamol","quantity":12}' },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    await provider.reason(requestFor({ facts: [{ key: 'daysOfStock', value: 4 }] }));
    await provider.reason(requestFor({ facts: [{ key: 'daysOfStock', value: 9 }] }));

    expect(client.calls).toHaveLength(2);
  });

  it('does not treat two tasks that read the same as one question', async () => {
    const client = stubClient([
      { output_text: '{"item":"Paracetamol","quantity":12}' },
      { output_text: '{"item":"Paracetamol","quantity":12}' },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    // Identical wording, different tasks: a stock count and an expiry sweep of
    // the same register are not the same request, and must not share an answer.
    await provider.reason(requestFor({ task: 'stock-extraction' }));
    await provider.reason(requestFor({ task: 'expiry-sweep' }));

    expect(client.calls).toHaveLength(2);
    expect(provider.telemetry().cacheHits).toBe(0);
  });
});

describe('an answer the schema rejects', () => {
  it('retries with the validator’s complaint attached, and takes the corrected answer', async () => {
    const client = stubClient([
      { output_text: '{"item":"Paracetamol","quantity":"twelve"}' },
      { output_text: '{"item":"Paracetamol","quantity":12}' },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    const response = await provider.reason(requestFor());

    expect(response.value).toEqual({ item: 'Paracetamol', quantity: 12 });
    expect(client.seen).toHaveLength(2);
    // The second attempt is a correction, not a re-roll: it carries what was wrong.
    expect(client.seen[1]).toContain('did not satisfy the required schema');
    expect(client.seen[1]).toContain('quantity');
    expect(provider.telemetry()).toMatchObject({ attempts: 2, failures: 1 });
  });

  it('gives up after the bounded number of attempts and says what was wrong', async () => {
    const client = stubClient([{ output_text: 'not json at all' }]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 2, backoffMs: 0 });

    await expect(provider.reason(requestFor())).rejects.toThrow(/not JSON/);
    expect(client.calls).toHaveLength(2);
    expect(provider.telemetry()).toMatchObject({ calls: 1, attempts: 2, failures: 2 });
  });

  it('treats an empty answer as a failure rather than as an empty record', async () => {
    const client = stubClient([{ output_text: '   ' }]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 1, backoffMs: 0 });

    await expect(provider.reason(requestFor())).rejects.toThrow(/carried no text/);
  });

  it('retries a provider failure, and reports no tokens it was not given', async () => {
    const client = stubClient([
      new Error('RESOURCE_EXHAUSTED'),
      { output_text: '{"item":"ORS","quantity":3}' },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });

    const response = await provider.reason(requestFor());

    expect(response.value).toEqual({ item: 'ORS', quantity: 3 });
    expect(provider.telemetry()).toMatchObject({
      attempts: 2,
      failures: 1,
      totalInputTokens: null,
      totalOutputTokens: null,
    });
  });
});

describe('the telemetry', () => {
  it('counts calls, attempts, cache hits, failures and the tokens it was told about', async () => {
    let elapsed = 0;
    const now = (): number => (elapsed += 20);

    // One rejected attempt and then a good one, followed by the same question
    // asked again: the retry and the cache hit are both visible in the counts.
    const client = stubClient([
      { output_text: '{"item":"ORS","quantity":"three"}' },
      {
        output_text: '{"item":"ORS","quantity":3}',
        usage: { total_input_tokens: 900, total_output_tokens: 40 },
      },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0, now });

    await provider.reason(requestFor());
    const second = await provider.reason(requestFor());

    expect(second.cacheHit).toBe(true);
    expect(provider.telemetry()).toEqual({
      // A model is named here because this adapter sends somewhere.
      model: 'gemini-3.8-flash',
      calls: 2,
      attempts: 2,
      cacheHits: 1,
      failures: 1,
      totalInputTokens: 900,
      totalOutputTokens: 40,
      totalDurationMs: 40,
      perTask: [
        {
          task: 'stock-extraction',
          calls: 2,
          attempts: 2,
          cacheHits: 1,
          failures: 1,
          totalInputTokens: 900,
          totalOutputTokens: 40,
          totalDurationMs: 40,
        },
      ],
    });
    // Two attempts to get one answer, and the second request cost nothing.
    expect(client.calls).toHaveLength(2);
  });

  it('reports no tokens at all rather than a zero when usage is not returned', async () => {
    const provider = new GeminiReasoningProvider({
      client: stubClient([{ output_text: '{"item":"ORS","quantity":3}' }]),
      backoffMs: 0,
    });

    await provider.reason(requestFor());

    expect(provider.telemetry().totalInputTokens).toBeNull();
    expect(provider.telemetry().totalOutputTokens).toBeNull();
  });

  it('has counted nothing at all before it is asked anything', () => {
    const provider = new GeminiReasoningProvider({
      client: stubClient([]),
      backoffMs: 0,
    });

    // An empty panel and a panel of zeros are different claims, and this is the
    // first one: nothing has been asked, so nothing has been reported.
    expect(provider.telemetry()).toEqual({
      model: 'gemini-3.8-flash',
      calls: 0,
      attempts: 0,
      cacheHits: 0,
      failures: 0,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalDurationMs: 0,
      perTask: [],
    });
  });

  it('attributes each task separately, and sums the totals from those rows', async () => {
    // Two tasks: one answered on the first attempt with usage reported, one that
    // fails. Which capability is costing quota is a per-task question, so the
    // breakdown is where the answer has to be.
    const client = stubClient([
      {
        output_text: '{"item":"ORS","quantity":3}',
        usage: { total_input_tokens: 100, total_output_tokens: 10 },
      },
      new Error('the model is unavailable'),
    ]);
    // A clock that does not move, so the assertion is about attribution and not
    // about how long a stub took to resolve.
    const provider = new GeminiReasoningProvider({
      client,
      maxAttempts: 1,
      backoffMs: 0,
      now: () => 0,
    });

    await provider.reason(requestFor({ task: 'stock-extraction' }));
    await expect(provider.reason(requestFor({ task: 'advisory-generation' }))).rejects.toThrow(
      ReasoningProviderError,
    );

    const telemetry = provider.telemetry();
    expect(telemetry.perTask).toEqual([
      {
        task: 'stock-extraction',
        calls: 1,
        attempts: 1,
        cacheHits: 0,
        failures: 0,
        totalInputTokens: 100,
        totalOutputTokens: 10,
        totalDurationMs: 0,
      },
      {
        task: 'advisory-generation',
        calls: 1,
        attempts: 1,
        cacheHits: 0,
        failures: 1,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalDurationMs: 0,
      },
    ]);
    expect(telemetry.calls).toBe(2);
    expect(telemetry.failures).toBe(1);
    // One task reported no usage, so the total is unknown rather than partial:
    // 100 would be a plausible number that is wrong about the model's cost.
    expect(telemetry.totalInputTokens).toBeNull();
    expect(telemetry.totalOutputTokens).toBeNull();
  });
});

describe('both adapters satisfy the port', () => {
  const answer = (provider: ReasoningProvider): Promise<unknown> => provider.reason(requestFor());

  it('answers through the same interface, whichever one is selected', async () => {
    const live = new GeminiReasoningProvider({
      client: stubClient([{ output_text: '{"item":"Paracetamol","quantity":12}' }]),
      backoffMs: 0,
    });
    const recorded = new FixtureReasoningProvider([
      { task: 'stock-extraction', value: { item: 'Paracetamol', quantity: 12 } },
    ]);

    expect(live.kind).toBe('gemini');
    expect(recorded.kind).toBe('fixture');
    await expect(answer(live)).resolves.toMatchObject({ provider: 'gemini', cacheHit: false });
    await expect(answer(recorded)).resolves.toMatchObject({ provider: 'fixture', cacheHit: true });
  });

  it('records a replayed fixture, and refuses a missing one rather than inventing an answer', async () => {
    const empty = new FixtureReasoningProvider([]);

    await expect(answer(empty)).rejects.toThrow(/no recorded response/);
  });
});
