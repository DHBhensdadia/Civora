import { alertSchema } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { numeralsIn } from '../grounding';
import {
  adversarialAlert,
  evaluateGrounding,
  GROUNDING_CASES,
  renderGroundingReport,
  UNGROUNDED_DEMONSTRATION,
  VACUITY_PROBE,
} from './grounding-cases';

/**
 * The grounding evaluation, and the two ways it is required to be able to fail.
 *
 * An evaluation is worth what its failure modes are worth: a case set that passes
 * because it is empty, or because the check under it accepts everything, reads
 * exactly like a case set that passes because the rule works. So the tests below
 * assert the passes *and* demonstrate the two failures — an accepted case that
 * stops being accepted once a figure nobody measured is in it, and an evaluator
 * that reports failure when the injected draft is one the facts *do* support.
 */

/** The alert with extra facts, used to make the demonstration draft legitimate. */
const anAlertThatSupportsTheDemonstration = () =>
  alertSchema.parse({
    ...adversarialAlert(),
    facts: [
      ...adversarialAlert().facts,
      { name: 'daysToStockOut', value: 11 },
      { name: 'orderQuantity', value: 240 },
    ],
  });

describe('the grounding case set', () => {
  it('runs every case as stated and passes', () => {
    const report = evaluateGrounding();

    expect(report.cases.map((result) => result.id)).toEqual(
      GROUNDING_CASES.map((groundingCase) => groundingCase.id),
    );
    expect(report.cases.filter((result) => !result.held)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(renderGroundingReport(report)).toContain('PASS');
  });

  it('refuses each ungrounded draft by naming the figure with no source', () => {
    const refused = evaluateGrounding().cases.filter((result) => result.expectation === 'refused');

    // Four shapes, and every one of them is a *plausible* sentence: rounding, a
    // dropped sign, a converted percentage, a mis-grouped figure.
    expect(refused).toHaveLength(4);
    for (const result of refused) {
      expect(result.outcome).toBe('refused');
      expect(result.problems.join(' ')).toContain('not in the supplied facts');
    }
  });

  it('proves each acceptance is not vacuous, by inventing a number into it', () => {
    const accepted = evaluateGrounding().cases.filter(
      (result) => result.expectation === 'accepted',
    );

    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.every((result) => result.vacuityHeld === true)).toBe(true);
    // The probe is a numeral no fact in the injected alert carries, which is what
    // makes "accepted, then refused with it in" evidence about the rule.
    expect(
      adversarialAlert()
        .facts.map((fact) => String(fact.value))
        .join(' '),
    ).not.toContain(VACUITY_PROBE);
  });

  it('demonstrates the rule refusing a draft written without it', () => {
    const report = evaluateGrounding();

    expect(report.demonstration.refused).toBe(true);
    for (const numeral of numeralsIn(UNGROUNDED_DEMONSTRATION.body)) {
      expect(report.demonstration.problems.join(' ')).toContain(numeral);
    }
  });

  it('fails when the injected draft turns out to be grounded — the evaluator can fail', () => {
    // The same body, against an alert whose facts do carry 11 and 240. Nothing
    // about the harness changed; it must now report failure rather than pass,
    // which is what makes the run above evidence.
    const report = evaluateGrounding(anAlertThatSupportsTheDemonstration());

    expect(report.demonstration.refused).toBe(false);
    expect(report.passed).toBe(false);
    expect(renderGroundingReport(report)).toContain('FAIL');
  });
});
