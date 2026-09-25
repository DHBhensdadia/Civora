import { FixtureReasoningProvider } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { GeminiReasoningProvider } from './gemini-provider';
import type { InteractionClient, ModelInteractionResult } from './gemini-provider';
import {
  generateRationale,
  generateRationales,
  rationaleFactsOf,
  rationaleSchemaFor,
} from './rationale';
import type { TransferRationaleInput } from './rationale';

/**
 * Explaining a proposed transfer without letting the explanation invent a number.
 *
 * Three properties are held here, and they are the ones that make the writer safe
 * to point at a proposal a person is deciding on. Every figure the writer may
 * mention travels as a fact and every other figure is refused; a citation has to
 * name a fact the proposal actually carries, because an explanation resting on a
 * measurement nobody took is the same failure as an invented number; and a
 * refusal is a result of its own — recorded with the provider's sentence, never
 * an empty space a reader could take for agreement.
 */

const anInput = (overrides: Partial<TransferRationaleInput> = {}): TransferRationaleInput => ({
  proposalId: 'transfer:facility-a:facility-b:item-furosemide:batch-7',
  donorFacility: 'CHC Gaya 1',
  donorDistrict: 'Gaya',
  receiverFacility: 'PHC Gaya 2',
  receiverDistrict: 'Gaya',
  item: 'Furosemide 40 mg',
  unit: 'tablet',
  quantity: 240,
  batchId: 'batch-7',
  expiresOn: '2027-03-31',
  distanceKm: 118.5,
  leadTimeDays: 1,
  shelfLifeOnArrivalDays: 514,
  coldChain: false,
  assessment: 'beneficial',
  unmetDemandAvoided: 64,
  stockOutDaysAverted: 3,
  transportCost: 56.88,
  netBenefit: 7.12,
  donorDaysOfStockAfter: 12,
  receiverDaysOfStockAfter: 12,
  assumptions: [
    'the receiving target is 12 days, the same floor the donor keeps',
    'the projection starts from stock on hand alone',
  ],
  ...overrides,
});

const aRationale = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  summary:
    'Move 240 tablet of Furosemide 40 mg from CHC Gaya 1 to PHC Gaya 2, 118.5 km away, arriving in 1 day.',
  conditions: [
    'If the receiving shelf cannot hold 240 tablet.',
    'If demand at CHC Gaya 1 rises above what was measured.',
  ],
  citations: ['quantity', 'unit', 'distanceKm', 'leadTimeDays'],
  ...overrides,
});

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
  stubClient([{ output_text: JSON.stringify(aRationale(overrides)) }]);

describe('writing one rationale, and reporting the answer', () => {
  it('records a refusal instead of throwing it, with the provider’s own sentence', async () => {
    // What this build does with no key configured, and the reason the workbench
    // can say why no explanation exists rather than showing a blank space.
    const attempt = await generateRationale(new FixtureReasoningProvider(), anInput());

    expect(attempt.status).toBe('refused');
    expect(attempt.rationale).toBeNull();
    expect(attempt.refusal).toContain('no recorded response');
    expect(attempt.proposalId).toBe(anInput().proposalId);
  });

  it('writes a rationale that rests on the proposal’s own figures', async () => {
    const provider = new GeminiReasoningProvider({ client: writingClient(), backoffMs: 0 });
    const attempt = await generateRationale(provider, anInput());

    expect(attempt.status).toBe('written');
    expect(attempt.rationale?.summary).toContain('240');
    expect(attempt.rationale?.conditions).toHaveLength(2);
    expect(attempt.rationale?.citations).toContain('quantity');
    expect(attempt.model).toBe('gemini-3.8-flash');
  });

  it('refuses a rationale containing a figure the proposal does not carry', async () => {
    // The failure the grounding rule exists for: a writer that says a quantity
    // the platform never computed. Retried with the complaint, then refused —
    // never published.
    const client = stubClient([
      {
        output_text: JSON.stringify(
          aRationale({ summary: 'Move 424242 tablet of Furosemide 40 mg.' }),
        ),
      },
    ]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 2, backoffMs: 0 });

    const attempt = await generateRationale(provider, anInput());

    expect(attempt.status).toBe('refused');
    expect(attempt.refusal).toContain('the number 424242 is not in the supplied facts');
    expect(client.seen).toHaveLength(2);
    // The second attempt is told what the first did wrong, in the rule's words.
    expect(client.seen[1]).toContain('the number 424242 is not in the supplied facts');
  });

  it('refuses a citation naming a fact the proposal does not carry', async () => {
    const client = stubClient([
      { output_text: JSON.stringify(aRationale({ citations: ['quantity', 'moonPhase'] })) },
    ]);
    const provider = new GeminiReasoningProvider({ client, maxAttempts: 1, backoffMs: 0 });

    const attempt = await generateRationale(provider, anInput());

    expect(attempt.status).toBe('refused');
    expect(attempt.refusal).toContain(
      'the citation "moonPhase" names no fact this proposal carries',
    );
  });

  it('supplies every figure the workbench shows, assumptions included', () => {
    const facts = rationaleFactsOf(anInput());
    const keys = new Set(facts.map((fact) => fact.key));

    for (const key of [
      'quantity',
      'distanceKm',
      'leadTimeDays',
      'shelfLifeOnArrivalDays',
      'assessment',
      'unmetDemandAvoided',
      'transportCost',
      'netBenefit',
      'donorDaysOfStockAfter',
      'receiverDaysOfStockAfter',
      'assumption:0',
      'assumption:1',
    ]) {
      expect(keys.has(key), `expected the fact set to carry ${key}`).toBe(true);
    }

    // No rounding on the way in: a rounded figure is one the record does not
    // contain, and the grounding rule refuses it on exactly that ground.
    expect(facts).toContainEqual({ key: 'distanceKm', value: 118.5 });
    expect(facts).toContainEqual({ key: 'netBenefit', value: 7.12 });
  });

  it('checks the same numbers in the schema it sends to a provider', () => {
    const schema = rationaleSchemaFor(rationaleFactsOf(anInput()));
    const parsed = schema.safeParse(
      aRationale({ summary: 'Move 999 tablet of Furosemide 40 mg, 118.5 km away.' }),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message).join('; ')).toContain(
        'the number 999 is not in the supplied facts',
      );
    }
  });
});

describe('writing the set for the proposals the workbench shows', () => {
  it('walks every proposal in order, one attempt each, refusals keyed by proposal', async () => {
    const first = anInput();
    const second = anInput({ proposalId: 'transfer:facility-b:facility-c:item-paracetamol' });

    const attempts = await generateRationales(new FixtureReasoningProvider(), [first, second]);

    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.proposalId)).toEqual([
      first.proposalId,
      second.proposalId,
    ]);
    expect(attempts.every((attempt) => attempt.status === 'refused')).toBe(true);
  });
});
