import { alertSchema } from '@civora/domain';
import type { AdvisoryDraft, Alert, Fact } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { advisoryFactsOf, advisoryRequestFor, advisorySchemaFor } from './advisory';
import { GeminiReasoningProvider } from './gemini-provider';
import type { InteractionClient, ModelInteractionResult } from './gemini-provider';
import { allowedNumeralsOf, grounded, groundingProblems, numeralsIn } from './grounding';
import { advisoryPrompt } from './prompts/advisory';

/**
 * The rule that lets the platform claim AI depth without accepting hallucination
 * risk in what a reader is shown.
 *
 * The phase requires this test to be able to fail, so the first case below shows
 * the *same* ungrounded draft being accepted by the plain schema and rejected by
 * the grounded one. A check that could never fail would pass every test in this
 * file and prove nothing.
 */

const facts: readonly Fact[] = [
  { key: 'daysOfStock', value: 4 },
  { key: 'leadTimeDays', value: 9 },
  { key: 'riskIndex', value: 0.91 },
  { key: 'ledgerEntries', value: 1042492 },
];

const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  language: 'en',
  title: 'PHC Khed · Paracetamol',
  body: 'Four days of stock remain and a delivery takes nine. The risk index is 0.91.',
  actions: ['Place the order today'],
  reasoning: ['Lead time 9 days against 4 days of stock'],
  citations: ['daysOfStock', 'leadTimeDays', 'riskIndex'],
  ...overrides,
});

describe('reading numerals out of prose', () => {
  it('finds every numeral, however it is written', () => {
    expect(numeralsIn('4 days, 0.91 index, 1,042,492 entries')).toEqual(['4', '0.91', '1042492']);
    expect(numeralsIn('no numerals here')).toEqual([]);
  });

  it('keeps a quantity’s sign, because a fall and a rise share every digit', () => {
    expect(numeralsIn('rose by 12.5 per cent')).toEqual(['12.5']);
    expect(numeralsIn('moved -12.5 per cent')).toEqual(['-12.5']);
    // A model may write a minus as any of three characters, and a typographic
    // minus is not an invention to be refused.
    expect(numeralsIn('−12.5 per cent')).toEqual(['-12.5']);
  });

  it('does not mistake punctuation for a sign', () => {
    // A hyphen inside a word and a dash between two numbers are not direction.
    // Reading them as one would refuse correct prose, which is the failure that
    // gets a check switched off in production.
    expect(numeralsIn('Tab. Paracetamol 500-mg')).toEqual(['500']);
    expect(numeralsIn('between 4 - 9 days')).toEqual(['4', '9']);
    expect(numeralsIn('2026-09-24')).toEqual(['2026', '09', '24']);
  });

  it('refuses a fall reported as a rise, which is the error a magnitude check cannot see', () => {
    const signed: readonly Fact[] = [{ key: 'changeSinceLastWeek', value: -12.5 }];

    expect(groundingProblems('demand moved -12.5 per cent', signed)).toEqual([]);
    expect(groundingProblems('demand rose 12.5 per cent', signed)).toEqual([
      expect.stringContaining('the number 12.5 is not in the supplied facts'),
    ]);
  });

  it('treats one quantity written by two conventions as the same quantity', () => {
    // "1,042,492" and "1042492" are the same measurement; only an invention is a
    // grounding failure.
    expect(allowedNumeralsOf(facts).has('1042492')).toBe(true);
    expect(groundingProblems('the ledger holds 1,042,492 entries', facts)).toEqual([]);
  });

  it('rejects a numeral the facts do not carry', () => {
    const problems = groundingProblems('stock covers 6 days', facts);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('the number 6 is not in the supplied facts');
  });

  it('rejects arithmetic, not only invention', () => {
    // 91% is a probability the facts state as 0.91. Converting it is a
    // computation, and a platform that allowed it could no longer say every
    // figure a reader sees came from its own engines.
    expect(groundingProblems('the chance of a stock-out is 91%', facts)).toEqual([
      expect.stringContaining('the number 91 is not in the supplied facts'),
    ]);
  });
});

describe('the grounded schema', () => {
  const textsOf = (value: AdvisoryDraft): readonly (readonly [string, string])[] => [
    ['body', value.body],
    ...value.reasoning.map((line, index) => [`reasoning.${String(index)}`, line] as const),
  ];

  const plain = advisoryPrompt.schema;
  const checked = grounded(advisoryPrompt.schema, facts, textsOf);

  it('accepts a draft that rests entirely on the facts it was given', () => {
    expect(checked.safeParse(draft()).success).toBe(true);
  });

  it('rejects a draft that invents a number — and the same draft passes the plain schema', () => {
    const invented = draft({ body: 'Four days of stock remain, so 6 days of cover are missing.' });

    // The failure this test exists to demonstrate: without the grounding rule the
    // draft is a perfectly valid advisory.
    expect(plain.safeParse(invented).success).toBe(true);
    const result = checked.safeParse(invented);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join('; ')).toContain(
      'the number 6 is not in the supplied facts',
    );
  });
});

/** A stub client, so the retry can be observed without a network. */
function stubClient(answers: readonly (ModelInteractionResult | Error)[]): InteractionClient & {
  readonly seen: string[];
} {
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

const anAlert = (): Alert =>
  alertSchema.parse({
    id: 'alert-1',
    facilityId: 'facility-a',
    itemId: 'item-paracetamol',
    raisedOn: '2026-09-24',
    severity: 'high',
    state: 'raised',
    bodies: { en: 'PHC Khed · Paracetamol' },
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
  });

describe('an advisory request built from an alert', () => {
  it('carries the alert’s own facts and nothing else', () => {
    const request = advisoryRequestFor(anAlert(), 'hi');

    expect(request.task).toBe('advisory-generation@1');
    expect(request.facts).toEqual(
      expect.arrayContaining([
        { key: 'daysOfStock', value: 4 },
        { key: 'riskIndex', value: 0.91 },
        { key: 'severity', value: 'high' },
      ]),
    );
    // The language is a parameter, not a fact, so it cannot be cited as a
    // quantity's source.
    expect(request.instructions).toContain('language: hi');
    expect(request.facts.map((fact) => fact.key)).not.toContain('language');
  });

  it('takes the drivers’ own sentences as facts, because the engine wrote them', () => {
    const keys = advisoryFactsOf(anAlert()).map((fact) => fact.key);

    expect(keys).toContain('driver:daysOfStock:reason');
    expect(keys).toContain('driver:daysOfStock:contribution');
  });

  it('rejects a citation naming a fact the alert does not carry', () => {
    const schema = advisorySchemaFor(advisoryFactsOf(anAlert()));
    const result = schema.safeParse(draft({ citations: ['daysOfStock', 'inventedMetric'] }));

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join('; ')).toContain(
      'names no fact the alert carries',
    );
  });
});

describe('the grounding rule inside the adapter', () => {
  it('sends an ungrounded answer back naming the figure, and takes the corrected one', async () => {
    const client = stubClient([
      {
        output_text: JSON.stringify(
          draft({ body: 'Four days of stock remain, so 6 days of cover are missing.' }),
        ),
      },
      { output_text: JSON.stringify(draft()) },
    ]);
    const provider = new GeminiReasoningProvider({ client, backoffMs: 0 });
    const alert = anAlert();

    const response = await provider.reason(advisoryRequestFor(alert, 'en'));

    expect(response.value.body).toContain('0.91');
    expect(client.seen).toHaveLength(2);
    // The second attempt is told what the first one did wrong, in the rule's own
    // words — a correction rather than a re-roll.
    expect(client.seen[1]).toContain('the number 6 is not in the supplied facts');
  });

  it('refuses rather than publishing when the model keeps inventing a number', async () => {
    const client = stubClient([
      { output_text: JSON.stringify(draft({ body: 'Roughly 6 days of cover are missing.' })) },
    ]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 2, backoffMs: 0 });

    await expect(provider.reason(advisoryRequestFor(anAlert(), 'en'))).rejects.toThrow(
      /the number 6 is not in the supplied facts/,
    );
    // Two attempts, and nothing returned: a figure with no source never reaches
    // a reader.
    expect(client.seen).toHaveLength(2);
  });
});
