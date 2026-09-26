import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PLAN_DIGEST_FORMAT, digestOf } from './plan-digest';
import type { PlanDigestFacts, PlanDigestProposal } from './plan-digest';

/**
 * The digest is the phase's cross-restart determinism evidence, so the tests
 * here are about what makes it evidence: it is a function of the plan, it
 * catches a change in any covered field, it never hides a real difference behind
 * rounding, and the hash can be recomputed from the printed lines by a reader.
 *
 * The fixture is a plan of two proposals rather than a real one, because the
 * question is what the digest does with a plan and not how a plan is built —
 * `apps/simulator`'s and `packages/optimizer`'s own tests cover the pipeline,
 * and `pnpm worker:propose` is run twice over the demonstration dataset as the
 * end-to-end check.
 */

const aProposal = (overrides: Partial<PlanDigestProposal> = {}): PlanDigestProposal => ({
  id: 'transfer:facility-chc-gaya-1-3:facility-phc-gaya-1-2:item-furosemide-40:batch-gaya-2291',
  itemId: 'item-furosemide-40',
  fromFacilityId: 'facility-chc-gaya-1-3',
  toFacilityId: 'facility-phc-gaya-1-2',
  batchId: 'batch-gaya-2291',
  quantity: 240,
  distanceKm: 12.3,
  leadTimeDays: 1,
  shelfLifeOnArrivalDays: 344,
  expiresOn: '2027-11-30',
  coldChain: false,
  verdict: 'proposed',
  expectedImpact: {
    unmetDemandAvoided: 180,
    donorDaysOfStockAfter: 21.4,
    receiverDaysOfStockAfter: 17.9,
  },
  impact: 'beneficial',
  ...overrides,
});

const facts = (overrides: Partial<PlanDigestFacts> = {}): PlanDigestFacts => ({
  asOf: '2026-09-24',
  seed: 'civora-demo-2026',
  scenarioId: 'demo-negative-control',
  dataset: {
    facilities: 90,
    districts: 30,
    withHistory: 12,
    items: 70,
    ledgerEntries: 173_564,
    from: '2026-03-01',
    to: '2026-09-24',
    days: 208,
  },
  objective: {
    unmetDemandPenalty: 1_234.5,
    transportCost: 9.4276,
    expiryPenalty: 0,
    total: 3_382.4,
  },
  baseline: { unmetDemandPenalty: 1_300, transportCost: 0, expiryPenalty: 0, total: 3_473.6 },
  strategy: {
    name: 'cost-minimising',
    decidedBy: 'fallback',
    benefitPerUnitKm: 0.204,
    reason: 'cost-minimising avoids the most unmet demand per unit-kilometre at 0.204',
    iterations: 3,
    budgetReached: false,
  },
  outcome: {
    admitted: true,
    violations: 0,
    unchecked: 0,
    measured: { transfers: 2, units: 962, unitKm: 4_713.8 },
  },
  graph: {
    candidates: 523_320,
    edges: 145_556,
    removedByRule: { 'lead-time': 329_029, 'cold-chain-capability': 0 },
  },
  proposals: [aProposal()],
  refusals: [],
  unserved: [],
  ...overrides,
});

describe('the plan digest', () => {
  it('writes the same plan down the same way every time', () => {
    const first = digestOf(facts());
    const second = digestOf(facts());

    expect(second.hash).toBe(first.hash);
    expect(second.text).toBe(first.text);
  });

  it('takes its hash over the printed lines, so a reader can recompute it', () => {
    const digest = digestOf(facts());
    const recomputed = createHash('sha256')
      .update(`${digest.lines.join('\n')}\n`)
      .digest('hex');

    expect(digest.hash).toBe(`sha256:${recomputed}`);
    expect(digest.lines[0]).toBe(`format ${PLAN_DIGEST_FORMAT}`);
    expect(digest.text.split('\n')[0]).toBe(`digest ${digest.hash}`);
  });

  it('changes when any covered quantity changes, and does not round one away', () => {
    const base = digestOf(facts());
    // A drift of five thousandths of a unit: small enough that a digest rounded
    // to a tenth of a unit would call the two plans the same plan.
    const drifted = digestOf(
      facts({
        proposals: [
          aProposal({ quantity: 240 }),
          aProposal({ id: 'transfer:x:y:z:b', quantity: 722.005 }),
        ],
      }),
    );

    expect(drifted.hash).not.toBe(base.hash);
  });

  it('changes with the world it was taken over, not only with the numbers in the plan', () => {
    const base = digestOf(facts());

    expect(digestOf(facts({ seed: 'not-the-demo-seed' })).hash).not.toBe(base.hash);
    expect(digestOf(facts({ asOf: '2026-09-23' })).hash).not.toBe(base.hash);
    expect(
      digestOf(facts({ dataset: { ...facts().dataset, ledgerEntries: 173_563 } })).hash,
    ).not.toBe(base.hash);
  });

  it('sorts the removals, so two graphs built in a different order hash alike', () => {
    const ordered = digestOf(facts());
    const reordered = digestOf(
      facts({
        graph: {
          ...facts().graph,
          removedByRule: { 'cold-chain-capability': 0, 'lead-time': 329_029 },
        },
      }),
    );

    expect(reordered.hash).toBe(ordered.hash);
  });

  it('reports an unmeasured impact as unmeasured, never as a zero', () => {
    const line = digestOf(facts({ proposals: [aProposal({ impact: null })] })).lines.find((each) =>
      each.startsWith('transfer '),
    );

    expect(line).toContain('impact=unquantified');
  });

  it('keeps prose on one line, so a newline cannot pass for a new field', () => {
    const digest = digestOf(
      facts({
        strategy: { ...facts().strategy, reason: 'two lines\nwere written' },
      }),
    );

    expect(digest.lines).toContain('strategy-reason two lines were written');
  });

  it('covers the unserved needs by a hash, so the block stays comparable in size', () => {
    const need = { facilityId: 'facility-a', itemId: 'item-paracetamol', units: 120 };
    const base = digestOf(facts({ unserved: [need] }));
    const more = digestOf(facts({ unserved: [need, { ...need, units: 121 }] }));
    const changed = digestOf(facts({ unserved: [{ ...need, units: 121 }] }));

    expect(base.lines.find((line) => line.startsWith('unserved '))).toContain(
      'unserved 1 of sha256:',
    );
    // Both a longer list and a changed one move the plan's hash.
    expect(more.hash).not.toBe(base.hash);
    expect(changed.hash).not.toBe(base.hash);
    // A digest long enough to scroll past is a digest nobody compares.
    expect(more.lines).toHaveLength(base.lines.length);
  });

  it('carries the count of each list, so a truncated block cannot read as complete', () => {
    const digest = digestOf(
      facts({
        proposals: [aProposal(), aProposal({ id: 'transfer:x:y:z:b' })],
        refusals: [
          {
            rule: 'donor-floor',
            code: 'donor-left-below-floor',
            detail: 'donor a would fall below its floor',
          },
        ],
        unserved: [{ facilityId: 'facility-a', itemId: 'item-paracetamol', units: 120 }],
      }),
    );

    expect(digest.lines).toContain('proposals 2');
    expect(digest.lines).toContain('refusals 1');
    expect(digest.lines.some((line) => line.startsWith('unserved 1 of sha256:'))).toBe(true);
    expect(digest.lines.filter((line) => line.startsWith('transfer '))).toHaveLength(2);
  });
});
