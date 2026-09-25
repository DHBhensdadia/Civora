import { describe, expect, it } from 'vitest';

import { advisoryDraftSchema, driverExplanationSchema, transferRationaleSchema } from './advisory';

/**
 * The shapes model-written prose has to satisfy.
 *
 * The numbers in these answers are checked by the grounding assertion, which
 * needs a fact set to check them against. What is tested here is everything the
 * shape can refuse on its own — above all a narrative with no citations, which
 * is the difference between an explanation a reader can audit and an assertion
 * they have to take on trust.
 */

const accepts = (result: { success: boolean }): boolean => result.success;

const rawAdvisory = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  language: 'hi',
  title: 'PHC Khed · ORS',
  body: 'इस शेल्फ पर 4 दिन का स्टॉक है।',
  actions: ['आज ऑर्डर करें'],
  reasoning: ['आपूर्ति में देरी के कारण शेल्फ अवधि कम है।'],
  citations: ['daysOfStock', 'leadTimeDays'],
  ...overrides,
});

describe('an advisory draft', () => {
  it('accepts a draft that states what it rests on', () => {
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory()))).toBe(true);
  });

  it('refuses a draft with no citations', () => {
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ citations: [] })))).toBe(false);
    // An empty tag is not a citation either.
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ citations: [' '] })))).toBe(false);
  });

  it('refuses a draft with no actions and no reasoning', () => {
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ actions: [] })))).toBe(false);
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ reasoning: [] })))).toBe(false);
  });

  it('refuses a draft written for no language, or one with no title or body', () => {
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ language: 'h' })))).toBe(false);
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ title: '' })))).toBe(false);
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ body: '   ' })))).toBe(false);
  });

  it('has nowhere to put a quantity of its own', () => {
    // The shape carries prose and citations only. Every figure a reader sees is
    // on the alert's own facts, which is what the grounding assertion compares.
    expect(accepts(advisoryDraftSchema.safeParse(rawAdvisory({ probability: 0.91 })))).toBe(false);
  });
});

describe('a driver explanation', () => {
  const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    headline: 'Shelf shorter than the wait',
    explanation: 'चार दिन का स्टॉक है और आपूर्ति में नौ दिन लगते हैं।',
    citations: ['daysOfStock', 'leadTimeDays'],
    ...overrides,
  });

  it('accepts an explanation that cites what it rests on', () => {
    expect(accepts(driverExplanationSchema.safeParse(raw()))).toBe(true);
  });

  it('refuses an explanation that cites nothing', () => {
    expect(accepts(driverExplanationSchema.safeParse(raw({ citations: [] })))).toBe(false);
  });

  it('refuses a restatement of the arithmetic as a field of its own', () => {
    // There is no contribution field: the contribution is the engine's, and a
    // model that wants to state it has to do so inside a citation-backed
    // sentence, where the grounding assertion can see it.
    expect(accepts(driverExplanationSchema.safeParse(raw({ contribution: 0.42 })))).toBe(false);
  });
});

describe('a transfer rationale', () => {
  const raw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    summary: 'Send 300 ORS sachets from CHC Shirur to PHC Khed.',
    conditions: ['if the receiving shelf cannot hold this quantity'],
    citations: ['transferQuantity', 'receivingShelfCapacity'],
    ...overrides,
  });

  it('accepts a rationale that names what would make it wrong', () => {
    expect(accepts(transferRationaleSchema.safeParse(raw()))).toBe(true);
  });

  it('allows an empty list of conditions, as a deliberate statement', () => {
    // The writer may conclude there is nothing to check; the field is a list
    // rather than an optional string so that the answer is explicit either way.
    expect(accepts(transferRationaleSchema.safeParse(raw({ conditions: [] })))).toBe(true);
  });

  it('still refuses a rationale with no citations', () => {
    expect(accepts(transferRationaleSchema.safeParse(raw({ citations: [] })))).toBe(false);
  });
});
