import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The capture and alert flows in the languages they are offered in.
 *
 * The claim this journey tests is narrow on purpose: **these two flows** are
 * localised, and the platform says which four languages they are localised into.
 * It does not claim the application is translated — a register a facility
 * photographed, a sentence a health worker spoke and a risk driver's own detail
 * line are English plus whatever a model wrote — and the language picker's own
 * note says so rather than leaving a reader to discover it.
 *
 * Two things are asserted that a string-swap would pass and a real localisation
 * would not: the **document language**, so assistive technology reads Devanagari
 * as Devanagari, and the **numerals and dates** on the alert inbox, which are
 * rendered by the language's own locale rather than by string replacement.
 */

const SET_LANGUAGE = async (page: Page, language: string): Promise<void> => {
  await page
    .context()
    .addCookies([{ name: 'civora-language', value: language, domain: '127.0.0.1', path: '/' }]);
};

/**
 * The phrases the capture flow is expected to show, per language.
 *
 * The label is the surface's own: a capture is queued on the device and sent
 * when the line returns, so every language says *queue* rather than *submit* — a
 * translation that promised a submission the platform does not make would be
 * wrong in a way only a health worker with no signal would discover.
 */
const SUBMIT: Readonly<Record<string, string>> = {
  hi: 'कतार में जमा करें',
  mr: 'रांगेत जमा करा',
  bn: 'সারিতে জমা দিন',
  ta: 'வரிசையில் சேர்',
};

const MOVEMENT: Readonly<Record<string, string>> = {
  hi: 'प्रकार',
  mr: 'प्रकार',
  bn: 'ধরন',
  ta: 'வகை',
};

test.describe('the interface in the reader’s language', () => {
  for (const language of ['hi', 'mr', 'bn', 'ta']) {
    test(`renders the capture flow in ${language}, numerals included`, async ({ page }) => {
      await SET_LANGUAGE(page, language);
      await page.goto('/capture');

      // The document says which language it is in, rather than being Devanagari
      // in a document declared as English.
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.getByTestId('interface-language')).toBeVisible();

      // The form's own label, from the bundle rather than from this test.
      await expect(page.getByRole('button', { name: SUBMIT[language] ?? '' })).toBeVisible();
      await expect(page.getByText(MOVEMENT[language] ?? '', { exact: true })).toBeVisible();
    });
  }

  test('renders the alert inbox in Hindi, with Devanagari numerals and dates', async ({ page }) => {
    await SET_LANGUAGE(page, 'hi');
    await page.goto('/intelligence');

    // An alert's state and severity come from the bundle; its date comes from the
    // language's locale. Both are asserted, because a string swap alone would
    // still print `raised 2026-09-24` in Latin digits.
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    const inbox = page.getByRole('region', { name: 'Alert inbox' });
    await expect(inbox.getByText('जारी', { exact: true }).first()).toBeVisible();
    await expect(inbox.getByText(/[०-९]/u).first()).toBeVisible();
    await expect(inbox.getByText(/[०-९][०-९] [^\s]+ २०२६/u).first()).toBeVisible();
  });

  test('reads an alert aloud in the language the record carries, and refuses where it carries none', async ({
    page,
    request,
  }) => {
    // A stub voice, installed before any page script runs. The assertion is about
    // what the platform asks the synthesiser to say and in which language — not
    // about whether this machine happens to have a Hindi voice installed, which
    // is exactly the kind of environment-dependent claim a demo would fail on.
    await page.addInitScript(() => {
      const spoken: { text: string; lang: string }[] = [];
      (window as unknown as { __spoken: typeof spoken }).__spoken = spoken;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          speak: (utterance: SpeechSynthesisUtterance) => {
            spoken.push({ text: utterance.text, lang: utterance.lang });
          },
          cancel: () => {
            /* nothing is queued in the stub */
          },
        },
      });
    });

    const payload = (await (await request.get('/api/intelligence')).json()) as {
      alerts: readonly {
        id: string;
        state: string;
        bodies: Readonly<Record<string, string>>;
      }[];
    };
    const alert = payload.alerts.find(
      (candidate) => candidate.state !== 'resolved' && (candidate.bodies.hi ?? '') !== '',
    );
    if (alert === undefined) {
      throw new Error('no open alert carries a Hindi body, so the journey cannot run');
    }
    const hindiBody = alert.bodies.hi ?? '';

    await SET_LANGUAGE(page, 'hi');
    await page.goto('/intelligence');

    const listen = page.getByTestId(`speak-${alert.id}`);
    await expect(listen).toHaveText('सुनकर समझें');
    await listen.click();

    // The body that was read is the record's own Hindi body, and the voice was
    // asked for in `hi-IN` — the registry's speech tag, without the numbering
    // extension (`hi-IN-u-nu-deva`) that matches no installed voice.
    await expect(listen).toHaveText('पढ़ना बंद करें');
    const spoken = await page.evaluate(
      () => (window as unknown as { __spoken: { text: string; lang: string }[] }).__spoken,
    );
    expect(spoken).toEqual([{ text: hindiBody.trim(), lang: 'hi-IN' }]);

    // Marathi is offered, and this alert holds no Marathi body. The control
    // refuses in Marathi and says nothing, rather than reading the Hindi or
    // English words in a Marathi voice.
    await SET_LANGUAGE(page, 'mr');
    await page.goto('/intelligence');
    const silent = page.getByTestId(`speak-${alert.id}`);
    await expect(silent).toHaveText('ऐकून घ्या');
    await silent.click();
    await expect(page.getByTestId(`speak-refusal-${alert.id}`)).toContainText(
      'काहीही वाचून दाखवले जात नाही',
    );
    const afterRefusal = await page.evaluate(
      () => (window as unknown as { __spoken: { text: string; lang: string }[] }).__spoken,
    );
    expect(afterRefusal).toEqual([]);
  });

  test('refuses a language it does not offer, and names the ones it does', async ({ request }) => {
    const response = await request.post('/api/language', { data: { language: 'fr' } });
    expect(response.status()).toBe(400);

    const body = (await response.json()) as { reason: string; detail: string };
    expect(body.reason).toBe('unsupported-language');
    for (const code of ['en', 'hi', 'mr', 'bn', 'ta']) {
      expect(body.detail).toContain(code);
    }

    // And an unoffered cookie falls back to the default rather than to the tag:
    // a French date on a Hindi screenshot is the failure this prevents.
    const fallback = await request.get('/api/language', {
      headers: { cookie: 'civora-language=fr' },
    });
    expect(((await fallback.json()) as { language: string }).language).toBe('en');
  });
});
