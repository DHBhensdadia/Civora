import { advisoryDraftSchema, alertSchema } from '@civora/domain';
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

/**
 * What one attempt at one advisory produced.
 *
 * A refusal is a result, not an absence. The platform has to be able to say "no
 * body was written for Marathi, and here is why" — a null body with no reason is
 * the shape that lets a screen look like it is working while nothing is behind
 * it, which is the failure this project has already paid to avoid once.
 */
export interface AdvisoryAttempt {
  readonly alertId: string;
  readonly language: string;
  readonly status: 'written' | 'refused';
  readonly draft: AdvisoryDraft | null;
  /** The provider's own sentence when it refused. Null when a draft was written. */
  readonly refusal: string | null;
  readonly provider: string;
  readonly model: string | null;
  readonly cacheHit: boolean;
}

/**
 * Write one advisory, and report the refusal rather than throwing it.
 *
 * The extra check this adds to `writeAdvisory` is the language. The writer is
 * asked for one language and answers with the tag it wrote in, and a draft that
 * came back in a different language is refused rather than filed under the one
 * that was requested: a body stored under the wrong tag is not a worse body, it
 * is a body a reader is shown in a language they may not read.
 */
export async function generateAdvisory(
  provider: ReasoningProvider,
  alert: Alert,
  language: string,
): Promise<AdvisoryAttempt> {
  try {
    const response = await writeAdvisory(provider, alert, language);
    if (response.value.language !== language) {
      return {
        alertId: alert.id,
        language,
        status: 'refused',
        draft: null,
        refusal: `the writer answered in "${response.value.language}" where "${language}" was asked for`,
        provider: response.provider,
        model: response.model,
        cacheHit: response.cacheHit,
      };
    }

    return {
      alertId: alert.id,
      language,
      status: 'written',
      draft: response.value,
      refusal: null,
      provider: response.provider,
      model: response.model,
      cacheHit: response.cacheHit,
    };
  } catch (error) {
    return {
      alertId: alert.id,
      language,
      status: 'refused',
      draft: null,
      refusal: error instanceof Error ? error.message : String(error),
      provider: provider.kind,
      model: null,
      cacheHit: false,
    };
  }
}

/**
 * The languages an alert set is written in: the ones its own records carry.
 *
 * Derived from the records rather than declared, and derived in one place, so the
 * surface and the batch job cannot disagree about which languages a set is
 * written for: whatever `Object.keys(alert.bodies)` holds is what gets attempted
 * and what a reader can be shown. The caller's registry is only ever used for
 * labels, so a tag this build does not offer is still written for and named by
 * its own tag rather than being silently dropped or relabelled.
 */
export function advisoryLanguagesOf(alerts: readonly Alert[]): readonly string[] {
  const carried = new Set<string>();
  for (const alert of alerts) {
    for (const language of Object.keys(alert.bodies)) {
      carried.add(language);
    }
  }

  return [...carried].sort();
}

/**
 * Write every body for a set of alerts, one attempt per alert and language.
 *
 * Sequential on purpose. This is the batch step the phase asks for — bodies
 * generated **ahead of the burst** so that nothing depends on a live call at the
 * moment somebody opens a screen — and a batch that fired every request at once
 * would turn a rate limit into a wave of refusals. Slower and complete beats
 * fast and partially failed; the caller is told how many of each it got.
 */
export async function generateAdvisories(
  provider: ReasoningProvider,
  input: { readonly alerts: readonly Alert[]; readonly languages: readonly string[] },
): Promise<readonly AdvisoryAttempt[]> {
  const attempts: AdvisoryAttempt[] = [];

  for (const alert of input.alerts) {
    for (const language of input.languages) {
      attempts.push(await generateAdvisory(provider, alert, language));
    }
  }

  return attempts;
}

/**
 * Put the written bodies onto the alert record, and nothing else.
 *
 * Written bodies replace what the record holds for that language; refused
 * languages keep exactly what they had. That asymmetry is the point: an alert is
 * showing somebody a body today, and a writer that could not improve it must not
 * blank it — nor may prose that failed validation reach the record at all. The
 * result is parsed by the alert's own schema, so a body that would make the
 * record invalid is a programming error here rather than a corrupt alert in a
 * store.
 *
 * What travels onto the record is the paragraph a reader sees. The rest of the
 * draft — the title, the actions, the reasoning, the citations — is reported by
 * the run that produced it; the record's contract is one body per language, and
 * widening it is a change to the alert model rather than to this function.
 */
export function withAdvisoryBodies(alert: Alert, attempts: readonly AdvisoryAttempt[]): Alert {
  const written = attempts.filter(
    (attempt): attempt is AdvisoryAttempt & { readonly draft: AdvisoryDraft } =>
      attempt.alertId === alert.id && attempt.status === 'written' && attempt.draft !== null,
  );

  if (written.length === 0) {
    return alert;
  }

  const bodies: Record<string, string> = { ...alert.bodies };
  for (const attempt of written) {
    bodies[attempt.language] = attempt.draft.body;
  }

  return alertSchema.parse({ ...alert, bodies });
}
