import { advisoryDraftSchema } from '@civora/domain';
import type {
  AdvisoryDraft,
  Alert,
  Fact,
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
} from '@civora/domain';
import type { ZodType } from 'zod';

import { grounded } from './grounding';
import { advisoryPrompt } from './prompts/advisory';

/**
 * Writing an advisory from an alert, without letting the writer introduce a
 * number.
 *
 * The alert already carries everything a body may say: the measured facts it was
 * raised on, the composite index it was banded from, and one sentence per risk
 * driver from the engine that computed it. This file flattens that into the fact
 * set, asks the versioned advisory prompt, and validates the answer against a
 * schema that carries the grounding rule — so an advisory containing a figure the
 * alert does not carry is rejected before anybody reads it, retried with the
 * figure named, and finally refused.
 *
 * The citations are checked too, and not only the numerals. A citation naming a
 * fact that does not exist is the same failure as an invented number with better
 * manners: it tells a reader that something was measured that never was.
 */

/** The pieces of an advisory a person reads, and the field each came from. */
export function advisoryTextsOf(draft: AdvisoryDraft): readonly (readonly [string, string])[] {
  return [
    ['title', draft.title],
    ['body', draft.body],
    ...draft.actions.map((action, index) => [`actions.${String(index)}`, action] as const),
    ...draft.reasoning.map((line, index) => [`reasoning.${String(index)}`, line] as const),
  ];
}

/**
 * Every quantity and every named reason the advisory may rest on.
 *
 * The drivers' own sentences travel as facts, which is deliberate: they were
 * written by the risk engine from measured inputs, so a body that repeats a lead
 * time from them is quoting the platform rather than inventing anything — and the
 * numerals inside them become admissible for exactly that reason.
 */
export function advisoryFactsOf(alert: Alert): readonly Fact[] {
  return [
    ...alert.facts.map((fact): Fact => ({ key: fact.name, value: fact.value })),
    { key: 'severity', value: alert.severity },
    { key: 'raisedOn', value: alert.raisedOn },
    { key: 'facilityId', value: alert.facilityId },
    { key: 'itemId', value: alert.itemId },
    ...alert.drivers.flatMap((driver): readonly Fact[] => [
      { key: `driver:${driver.driver}:contribution`, value: driver.contribution },
      { key: `driver:${driver.driver}:reason`, value: driver.detail },
    ]),
  ];
}

/** The advisory schema, with the grounding and citation rules built in. */
export function advisorySchemaFor(facts: readonly Fact[]): ZodType<AdvisoryDraft> {
  const names = new Set(facts.map((fact) => fact.key));

  return grounded(advisoryDraftSchema, facts, advisoryTextsOf).superRefine((draft, context) => {
    for (const citation of draft.citations) {
      if (!names.has(citation)) {
        context.addIssue({
          code: 'custom',
          message: `the citation "${citation}" names no fact the alert carries`,
          path: ['citations'],
        });
      }
    }
  });
}

/**
 * The request for one advisory, in one language.
 *
 * The language travels as a task parameter rather than as a fact, so it cannot be
 * cited as the source of a quantity.
 */
export function advisoryRequestFor(
  alert: Alert,
  language: string,
): ReasoningRequest<AdvisoryDraft> {
  const facts = advisoryFactsOf(alert);
  const request = advisoryPrompt.request({
    facts,
    context: [
      { key: 'language', value: language },
      { key: 'facilityId', value: alert.facilityId },
      { key: 'itemId', value: alert.itemId },
    ],
  });

  return { ...request, schema: advisorySchemaFor(facts) };
}

/**
 * Write one advisory through whichever provider is configured.
 *
 * The response's own value is validated against the grounded schema inside the
 * adapter, so what comes back from here is a draft that can be persisted and read
 * out later — which is what the phase requires: bodies are generated ahead of the
 * alert burst and stored per language, not produced at the moment somebody opens
 * a screen.
 */
export async function writeAdvisory(
  provider: ReasoningProvider,
  alert: Alert,
  language: string,
): Promise<ReasoningResponse<AdvisoryDraft>> {
  return await provider.reason(advisoryRequestFor(alert, language));
}
