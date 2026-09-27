import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * Advisory bodies, and the honesty of a refusal.
 *
 * The phase requires that an advisory exists **before** anybody opens a screen,
 * so this suite asserts the shape of the set — one body per alert per language
 * the record carries, written for the whole set rather than per row — and then
 * asserts what happens when the writer cannot write: every language is reported
 * as refused, with the writer's own sentence, while the alert keeps the body it
 * was raised with.
 *
 * That last part is the one worth being careful about. With no key configured the
 * fixture provider refuses every request, so the correct behaviour is *not* an
 * empty body: it is a named refusal beside the body the record already holds, so
 * a reader can tell "nothing was said" from "the writer was not available". No
 * fixture is invented to make this suite show generated prose, and it says so.
 */

interface LanguageView {
  readonly language: string;
  readonly label: string;
  readonly status: 'written' | 'refused';
  readonly inRecord: string | null;
  readonly generated: string | null;
  readonly refusal: string | null;
}

interface AdvisoryView {
  readonly provider: string;
  readonly offered: readonly { readonly code: string; readonly label: string }[];
  readonly languages: readonly string[];
  readonly attempted: number;
  readonly written: number;
  readonly refused: number;
  readonly regenerated: boolean;
  readonly generatedAt: string;
  readonly alerts: readonly {
    readonly alertId: string;
    readonly facilityName: string;
    readonly itemName: string;
    readonly languages: readonly LanguageView[];
  }[];
}

/**
 * How long the surface may take to answer while another journey holds the
 * server's thread.
 *
 * The result panel appears when a whole pass over the set has finished — every
 * alert, in every language it carries — and the pass is the platform's own work
 * on one thread. Asserting the panel's wording is the point of this suite;
 * failing because a neighbouring spec was mid-arithmetic would be measuring the
 * queue instead, so the waiting is made explicit rather than left to the default.
 */
const PATIENCE_MS = 60_000;

/** The same patience, for the surface's own first render. */
const PATIENT = { timeout: PATIENCE_MS } as const;

const readAdvisories = async (request: APIRequestContext): Promise<AdvisoryView> => {
  const response = await request.get('/api/advisories');
  expect(response.ok()).toBe(true);
  return (await response.json()) as AdvisoryView;
};

/** The alert bodies the platform is actually holding, which the set must not disturb. */
const readAlertBodies = async (
  request: APIRequestContext,
): Promise<
  readonly { readonly id: string; readonly bodies: Readonly<Record<string, string>> }[]
> => {
  const response = await request.get('/api/intelligence');
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    readonly alerts: readonly {
      readonly id: string;
      readonly bodies: Readonly<Record<string, string>>;
    }[];
  };
  return payload.alerts;
};

test.describe('the advisory set', () => {
  test('covers every alert in every language its record carries, before anybody opens a row', async ({
    request,
  }) => {
    const advisories = await readAdvisories(request);

    expect(advisories.provider).toBe('fixture');
    // The languages come off the records, not from a constant: whatever the alert
    // template carries is what is written for.
    expect(advisories.languages.length).toBeGreaterThan(0);
    expect(advisories.alerts.length).toBeGreaterThan(0);

    const expected = advisories.alerts.length * advisories.languages.length;
    expect(advisories.attempted).toBe(expected);
    // The whole set was attempted, so the count is a statement about the set
    // rather than about whichever row somebody happened to open.
    expect(advisories.written + advisories.refused).toBe(advisories.attempted);

    // No key, so nothing was written — and every language says so, in the
    // writer's own words, instead of arriving as an empty body.
    expect(advisories.written).toBe(0);
    expect(advisories.refused).toBe(advisories.attempted);
    for (const alert of advisories.alerts) {
      expect(alert.languages).toHaveLength(advisories.languages.length);
      for (const language of alert.languages) {
        expect(language.status).toBe('refused');
        expect(language.generated).toBeNull();
        expect(language.refusal).toContain('no recorded response');
        // And the body the record already holds is still there: a writer that
        // could not improve a body must not blank the one a reader may be
        // looking at.
        expect(language.inRecord).not.toBeNull();
      }
    }
  });

  test('leaves the alert record exactly as the inbox reads it', async ({ request }) => {
    const advisories = await readAdvisories(request);
    const alerts = await readAlertBodies(request);

    for (const advisory of advisories.alerts) {
      const record = alerts.find((alert) => alert.id === advisory.alertId);
      expect(record, `the inbox holds ${advisory.alertId}`).toBeDefined();

      for (const language of advisory.languages) {
        // The panel's "in the record" line is read from the same record the inbox
        // shows, so a body that appeared from nowhere could not pass this.
        expect(language.inRecord).toBe(record?.bodies[language.language]);
      }
    }
  });

  test('says on the surface which writer is behind it, and what it got', async ({
    page,
    request,
  }) => {
    const advisories = await readAdvisories(request);
    const expected = advisories.attempted;

    await page.goto('/intelligence');

    const summary = page.getByTestId('advisory-summary');
    await expect(summary).toContainText('fixture', PATIENT);
    await expect(summary).toContainText(String(advisories.languages.length));
    await expect(summary).toContainText(String(expected));

    // One entry per language per alert, every one of them refused and reason
    // given, so a reader of any language knows the difference between an empty
    // body and a writer that was not there.
    await expect(page.getByTestId('advisory-language')).toHaveCount(expected, PATIENT);
    await expect(page.getByTestId('advisory-refusal')).toHaveCount(expected);
    await expect(page.getByTestId('advisory-language').first()).toHaveAttribute(
      'data-status',
      'refused',
    );

    // What the record holds is shown beside the refusal, including for the
    // language the alert was raised in. Read off the API rather than hard-coded,
    // so the assertion is that the panel shows *the record* and not a draft.
    const english = advisories.alerts[0]?.languages.find((language) => language.language === 'en');
    expect(english?.inRecord).not.toBeNull();
    await expect(
      page.locator('[data-testid="advisory-language"][data-language="en"]').first(),
    ).toContainText(english?.inRecord ?? '');

    // And the languages the platform offers but no record carries yet are named
    // rather than left invisible: that gap is Phase 8's work, not a silent one.
    const absent = advisories.offered.filter(
      (offered) => !advisories.languages.includes(offered.code),
    );
    // Scoped to the panel: the language picker in the header offers the same
    // labels, so a page-wide text locator would match the picker's own option
    // first and assert the wrong surface.
    const panel = page.getByRole('region', {
      name: 'Advisory bodies, written ahead of the burst',
    });
    for (const language of absent) {
      await expect(panel.getByText(language.label).first()).toBeVisible();
    }
  });

  test('re-asks only when it is told to, and reports the result', async ({ page, request }) => {
    const response = await request.post('/api/advisories', { data: { regenerate: true } });
    expect(response.status()).toBe(200);
    const asked = (await response.json()) as AdvisoryView;
    expect(asked.regenerated).toBe(true);
    expect(asked.attempted).toBeGreaterThan(0);
    expect(asked.written).toBe(0);

    // A route that re-asks on a bare POST would turn a refresh into a burst of
    // model calls, which is the failure the whole design is arranged to avoid.
    const refused = await request.post('/api/advisories', { data: { refresh: true } });
    expect(refused.status()).toBe(400);

    await page.goto('/intelligence');
    await page.getByTestId('advisory-regenerate').click();
    await expect(page.getByTestId('advisory-result')).toContainText('0 written', PATIENT);
    await expect(page.getByTestId('advisory-result')).toContainText('refused');
  });
});
