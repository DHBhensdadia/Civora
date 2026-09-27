import { FixtureReasoningProvider, alertSchema } from '@civora/domain';
import type { Alert } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { generateAdvisories, generateAdvisory, withAdvisoryBodies } from './advisory';
import { GeminiReasoningProvider } from './gemini-provider';
import type { InteractionClient, ModelInteractionResult } from './gemini-provider';

/**
 * Writing a body per language, ahead of anybody opening an alert.
 *
 * Two properties are being held here, and they are the ones that make a batch
 * writer safe to point at a record a person is reading. A refusal is a result of
 * its own — recorded with its reason, never an empty body filed as one — and a
 * refusal leaves the alert exactly as it was, because a writer that could not
 * improve a body must not blank the one somebody is already reading.
 *
 * The last case is the one that matters most: the grounding rule is enforced
 * *through* this path, not beside it, because the request the batch sends carries
 * the caller's schema and the adapter is what validates it.
 */

const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  language: 'en',
  title: 'PHC Khed · Paracetamol',
  body: 'Four days of stock remain and a delivery takes nine. The risk index is 0.91.',
  actions: ['Place the order today'],
  reasoning: ['Lead time 9 days against 4 days of stock'],
  citations: ['daysOfStock', 'leadTimeDays', 'riskIndex'],
  ...overrides,
});

const anAlert = (overrides: Record<string, unknown> = {}): Alert =>
  alertSchema.parse({
    id: 'alert-1',
    facilityId: 'facility-a',
    itemId: 'item-paracetamol',
    raisedOn: '2026-09-24',
    severity: 'high',
    state: 'raised',
    // The template the domain writes when it raises an alert, in the two
    // languages the record carries today.
    bodies: { en: 'PHC Khed · Paracetamol — template', hi: 'PHC Khed · Paracetamol — खाका' },
    riskScoreId: 'score-1',
    dedupeKey: 'facility-a::item-paracetamol::shelf',
    facts: [
      { name: 'daysOfStock', value: 4 },
      { name: 'leadTimeDays', value: 9 },
      { name: 'riskIndex', value: 0.91 },
    ],
    drivers: [
      { driver: 'daysOfStock', contribution: 0.42, detail: 'a 4-day shelf against a 9-day wait' },
    ],
    history: [],
    acknowledgedBy: null,
    acknowledgedByRole: null,
    acknowledgedAt: null,
    resolvedAt: null,
    synthetic: true,
    provenance: { kind: 'simulated', reference: 'simulator' },
    ...overrides,
  });

/** A stub client, so a written draft can be produced without a network. */
function stubClient(
  answers: readonly (ModelInteractionResult | Error)[],
): InteractionClient & { readonly seen: string[] } {
  const seen: string[] = [];
  let index = 0;

  return {
    model: 'gemini-3.8-flash',
    seen,
    async create(request): Promise<ModelInteractionResult> {
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

const writingClient = (overrides: Record<string, unknown> = {}): InteractionClient =>
  stubClient([{ output_text: JSON.stringify(draft(overrides)) }]);

/**
 * A client that answers in whichever language the request asks for.
 *
 * The language travels as a task parameter in the system instruction, which is
 * exactly what a real model would read, so a stub that reads it is standing in
 * for the behaviour the prompt asks for rather than for a fixed string.
 */
const speakingClient = (): InteractionClient => ({
  model: 'gemini-3.8-flash',
  async create(request): Promise<ModelInteractionResult> {
    const asked = /language: ([a-z]{2})/.exec(request.system_instruction)?.[1] ?? 'en';
    return { output_text: JSON.stringify(draft({ language: asked })) };
  },
});

describe('writing one body, and reporting the answer', () => {
  it('records a refusal instead of throwing it, with the provider’s own sentence', async () => {
    // What this build does with no key configured, and the reason the panel can
    // say why no prose exists rather than showing a blank space.
    const attempt = await generateAdvisory(new FixtureReasoningProvider(), anAlert(), 'en');

    expect(attempt.status).toBe('refused');
    expect(attempt.draft).toBeNull();
    expect(attempt.refusal).toContain('no recorded response');
    expect(attempt.alertId).toBe('alert-1');
    expect(attempt.language).toBe('en');
  });

  it('writes a draft that rests on the alert’s own facts', async () => {
    const provider = new GeminiReasoningProvider({ client: writingClient(), backoffMs: 0 });
    const attempt = await generateAdvisory(provider, anAlert(), 'en');

    expect(attempt.status).toBe('written');
    expect(attempt.draft?.body).toContain('0.91');
    expect(attempt.refusal).toBeNull();
    expect(attempt.model).toBe('gemini-3.8-flash');
  });

  it('refuses a draft written in a language nobody asked for', async () => {
    // A body filed under the wrong tag is not a worse body: it is a body shown
    // to a reader in a language they may not read, which is the failure the
    // language parameter exists to prevent.
    const provider = new GeminiReasoningProvider({
      client: writingClient({ language: 'bn' }),
      backoffMs: 0,
    });
    const attempt = await generateAdvisory(provider, anAlert(), 'hi');

    expect(attempt.status).toBe('refused');
    expect(attempt.refusal).toContain('"bn"');
    expect(attempt.refusal).toContain('"hi"');
  });
});

describe('putting the bodies onto the record', () => {
  it('replaces the language that was written and keeps every other one', async () => {
    const provider = new GeminiReasoningProvider({
      client: writingClient({ language: 'hi', body: 'चार दिन का स्टॉक बचा है।' }),
      backoffMs: 0,
    });
    const alert = anAlert();
    const attempt = await generateAdvisory(provider, alert, 'hi');

    const merged = withAdvisoryBodies(alert, [attempt]);

    expect(merged.bodies.hi).toBe('चार दिन का स्टॉक बचा है।');
    // The language nobody wrote for is untouched — including the template the
    // alert was raised with.
    expect(merged.bodies.en).toBe(alert.bodies.en);
    // The result is the alert's own record shape, parsed, not a loose object.
    expect(alertSchema.safeParse(merged).success).toBe(true);
  });

  it('leaves the record exactly as it was when every attempt was refused', () => {
    const alert = anAlert();
    const refused = {
      alertId: alert.id,
      language: 'hi',
      status: 'refused' as const,
      draft: null,
      refusal: 'no recorded response for task "advisory-generation@2"',
      provider: 'fixture',
      model: null,
      cacheHit: false,
    };

    // Identity, not merely equality: nothing was written, so nothing is rebuilt.
    expect(withAdvisoryBodies(alert, [refused])).toBe(alert);
    expect(alert.bodies.hi).toBe('PHC Khed · Paracetamol — खाका');
  });

  it('merges a partial batch honestly: the language that wrote lands, the one that refused does not', async () => {
    const provider = new GeminiReasoningProvider({
      client: writingClient({
        language: 'en',
        body: 'Four days of stock against a nine-day wait.',
      }),
      backoffMs: 0,
    });
    const alert = anAlert();
    const written = await generateAdvisory(provider, alert, 'en');
    const refused = await generateAdvisory(new FixtureReasoningProvider(), alert, 'hi');

    const merged = withAdvisoryBodies(alert, [written, refused]);

    expect(merged.bodies.en).toBe('Four days of stock against a nine-day wait.');
    expect(merged.bodies.hi).toBe(alert.bodies.hi);
  });
});

describe('writing the whole set ahead of the burst', () => {
  it('attempts every alert in every language, in order', async () => {
    const provider = new GeminiReasoningProvider({ client: speakingClient(), backoffMs: 0 });
    const alerts = [anAlert(), anAlert({ id: 'alert-2', facilityId: 'facility-b' })];

    const attempts = await generateAdvisories(provider, { alerts, languages: ['en', 'hi'] });

    expect(attempts).toHaveLength(4);
    expect(attempts.map((attempt) => `${attempt.alertId}:${attempt.language}`)).toEqual([
      'alert-1:en',
      'alert-1:hi',
      'alert-2:en',
      'alert-2:hi',
    ]);
    expect(attempts.every((attempt) => attempt.status === 'written')).toBe(true);
  });

  it('enforces the grounding rule through this path, not beside it', async () => {
    // The batch sends the same request the single writer does — the caller's
    // schema, carrying the grounding refinement — so a model that keeps inventing
    // a figure is refused here too, and the record keeps the body it had.
    const client = stubClient([
      { output_text: JSON.stringify(draft({ body: 'Roughly 6 days of cover are missing.' })) },
    ]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 2, backoffMs: 0 });
    const alert = anAlert();

    const [attempt] = await generateAdvisories(provider, { alerts: [alert], languages: ['en'] });

    expect(attempt?.status).toBe('refused');
    expect(attempt?.refusal).toContain('the number 6 is not in the supplied facts');
    expect(client.seen).toHaveLength(2);
    expect(withAdvisoryBodies(alert, attempt === undefined ? [] : [attempt]).bodies.en).toBe(
      alert.bodies.en,
    );
  });
});
