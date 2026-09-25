import { advisoryLanguagesOf, generateAdvisory, withAdvisoryBodies } from '@civora/ai';
import type { AdvisoryAttempt } from '@civora/ai';
import type { Alert, AlertSeverity, AlertState } from '@civora/domain';
import { LANGUAGES, languageLabelOf, languageOf } from '@civora/i18n';

import { getProviders } from '@/providers';
import { readIntelligence, storeAlert } from './intelligence-service';
import { getLiveStore } from './live-store';
import type { Session } from './session';

/**
 * The advisories for the active alert set, written ahead of the burst.
 *
 * An alert tells an officer that a shelf is going to run out. What it does not do
 * is explain it, in language they read, with the reasoning visible — and that is
 * the part a model is genuinely good at and the part the platform must not let it
 * invent. So this file walks **the whole alert set, in every language the record
 * carries**, once, and stores what comes back on the alert itself.
 *
 * Three decisions are load-bearing:
 *
 *  - **Once, for the set, not per row.** Nothing here is called because somebody
 *    opened an alert. A demo, or a district, that depends on a live burst of model
 *    calls at the moment a screen is opened is a demo that fails when the quota
 *    does, so the bodies exist before the first reader arrives — and a second read
 *    is answered from the process's own record of what was attempted.
 *  - **A refusal is a result.** With no key configured every attempt refuses, and
 *    the panel says so per language, naming the writer's own sentence. What it
 *    must never do is show an empty body and let a reader assume there was nothing
 *    to say.
 *  - **A body that was not written leaves the record alone.** `withAdvisoryBodies`
 *    replaces only the languages that produced a draft, so an alert keeps the body
 *    it was raised with for every language the writer could not improve — and the
 *    grounding rule means nothing that reached the record invented a number.
 *
 * The languages come from the record, not from a constant here: whatever
 * `Object.keys(alert.bodies)` holds is what is written for and what a reader can
 * be shown. Adding a language to the alert template is therefore what adds one
 * here, and the panel names the languages that are offered but carry no body yet
 * rather than leaving that gap invisible.
 */

/** One language, as this run found it. */
export interface AdvisoryLanguageView {
  readonly language: string;
  /** `हिन्दी · Hindi`, or the raw tag when this build does not offer that language. */
  readonly label: string;
  readonly offered: boolean;
  readonly status: 'written' | 'refused';
  /** What the alert record holds for this language now, or null when it holds nothing. */
  readonly inRecord: string | null;
  /** The generated paragraph, present only when the writer produced one. */
  readonly generated: string | null;
  readonly title: string | null;
  readonly actions: readonly string[];
  readonly reasoning: readonly string[];
  readonly citations: readonly string[];
  /** Why no body was written, in the writer's own words. */
  readonly refusal: string | null;
  readonly model: string | null;
  readonly cacheHit: boolean;
  readonly attemptedAt: string;
}

export interface AlertAdvisoryView {
  readonly alertId: string;
  readonly facilityId: string;
  readonly facilityName: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly severity: AlertSeverity;
  readonly state: AlertState;
  readonly raisedOn: string;
  readonly languages: readonly AdvisoryLanguageView[];
}

export interface AdvisorySet {
  readonly provider: string;
  /** Every language this build offers, whether or not the record carries one. */
  readonly offered: readonly { readonly code: string; readonly label: string }[];
  /** The languages the alert record carries, which are the ones attempted. */
  readonly languages: readonly string[];
  readonly alerts: readonly AlertAdvisoryView[];
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
  /** Whether this read did the writing, or answered from what the process holds. */
  readonly regenerated: boolean;
  readonly generatedAt: string;
  readonly generatedInMs: number;
}

interface Attempted {
  readonly attempt: AdvisoryAttempt;
  readonly at: string;
}

const attempted = new Map<string, Attempted>();
let generatedAt = '';
let generationMs = 0;

const keyOf = (alertId: string, language: string): string => `${alertId}|${language}`;

function viewOfLanguage(
  alert: Alert,
  language: string,
  entry: Attempted | undefined,
): AdvisoryLanguageView {
  const draft = entry?.attempt.status === 'written' ? entry.attempt.draft : null;

  return {
    language,
    label: languageLabelOf(language),
    offered: languageOf(language) !== null,
    status: entry?.attempt.status ?? 'refused',
    inRecord: alert.bodies[language] ?? null,
    generated: draft?.body ?? null,
    title: draft?.title ?? null,
    actions: draft?.actions ?? [],
    reasoning: draft?.reasoning ?? [],
    citations: draft?.citations ?? [],
    refusal: entry?.attempt.refusal ?? 'this language has not been attempted in this process yet',
    model: entry?.attempt.model ?? null,
    cacheHit: entry?.attempt.cacheHit ?? false,
    attemptedAt: entry?.at ?? '',
  };
}

/**
 * Write the bodies for the active alert set, or answer from what this process
 * already holds.
 *
 * Sequentially and in one pass, because this is the batch step: a set of alerts
 * times a set of languages is a handful of calls, and firing them concurrently
 * would turn a rate limit into a wave of refusals that all say the same thing.
 */
export async function readAdvisorySet(
  session: Session,
  options: { readonly regenerate?: boolean | undefined } = {},
): Promise<AdvisorySet> {
  const startedAt = Date.now();
  const intelligence = await readIntelligence(session);
  const store = await getLiveStore();
  // Which languages, and in which order, is `@civora/ai`'s answer — the batch job
  // asks the same question of the same records, and two orderings of one set
  // would be two languages to a reader comparing them.
  const languages = advisoryLanguagesOf(intelligence.alerts);
  const provider = getProviders().reasoning;
  const regenerate = options.regenerate === true;
  let didWork = false;

  const facilityName = (facilityId: string): string =>
    store.dataset.network.facilities.find((facility) => facility.id === facilityId)?.name ??
    facilityId;
  const itemName = (itemId: string): string =>
    store.catalogue.find((item) => item.id === itemId)?.genericName ?? itemId;

  for (const alert of intelligence.alerts) {
    const fresh: AdvisoryAttempt[] = [];

    for (const language of languages) {
      const key = keyOf(alert.id, language);
      if (!regenerate && attempted.has(key)) {
        continue;
      }

      const attempt = await generateAdvisory(provider, alert, language);
      const at = new Date().toISOString();
      attempted.set(key, { attempt, at });
      fresh.push(attempt);
      didWork = true;
    }

    if (fresh.length === 0) {
      continue;
    }

    // Only the written bodies go on — `withAdvisoryBodies` leaves every other
    // language exactly as it was — and the record is stored back so the alert a
    // surface reads next is the alert with its bodies on it.
    const merged = withAdvisoryBodies(alert, fresh);
    if (merged !== alert) {
      await storeAlert(merged);
    }
  }

  if (didWork) {
    generatedAt = new Date().toISOString();
    generationMs = Date.now() - startedAt;
  }

  const alerts: AlertAdvisoryView[] = intelligence.alerts.map((alert) => ({
    alertId: alert.id,
    facilityId: alert.facilityId,
    facilityName: facilityName(alert.facilityId),
    itemId: alert.itemId,
    itemName: itemName(alert.itemId),
    severity: alert.severity,
    state: alert.state,
    raisedOn: alert.raisedOn,
    languages: languages.map((language) =>
      viewOfLanguage(alert, language, attempted.get(keyOf(alert.id, language))),
    ),
  }));

  const entries = alerts
    .flatMap((alert) => alert.languages)
    .filter((language) => language.attemptedAt !== '');

  return {
    provider: provider.kind,
    offered: LANGUAGES.map((language) => ({
      code: language.code,
      label: languageLabelOf(language.code),
    })),
    languages,
    alerts,
    attempted: entries.length,
    written: entries.filter((language) => language.status === 'written').length,
    refused: entries.filter((language) => language.status === 'refused').length,
    regenerated: didWork,
    generatedAt,
    generatedInMs: generationMs,
  };
}
