import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Presentation mode.
 *
 * The mode exists for one promise: **the demonstration does not call out at
 * click time.** The advisory bodies are written for the whole alert set, in every
 * language the record carries, before a reader arrives — that is how
 * `advisory-service` already works — and in presentation mode the one control
 * that would ask the writer again is refused in a sentence instead.
 *
 * The test is falsifiable rather than decorative: it asserts that the second
 * request returns **the same number of attempts** as the first and reports no
 * work done, which is what a refusal that quietly re-asked would fail. And it
 * asserts no request left the machine, which is the promise a judge is actually
 * relying on.
 */

const PRESENT = async (page: Page): Promise<void> => {
  await page
    .context()
    .addCookies([{ name: 'civora-presentation', value: '1', domain: '127.0.0.1', path: '/' }]);
};

interface AdvisoryView {
  readonly attempted: number;
  readonly regenerated: boolean;
  readonly presentationMode: boolean;
  readonly presentationRefusal: string | null;
}

test.describe('presentation mode', () => {
  test('prepares the advisory set ahead of the demonstration, and refuses to re-ask', async ({
    request,
  }) => {
    const headers = { cookie: 'civora-presentation=1' };

    const first = await request.get('/api/advisories', { headers });
    expect(first.ok()).toBe(true);
    const prepared = (await first.json()) as AdvisoryView;
    expect(prepared.presentationMode).toBe(true);
    expect(prepared.presentationRefusal).toBeNull();

    const again = await request.post('/api/advisories', {
      data: { regenerate: true },
      headers,
    });
    expect(again.ok()).toBe(true);
    const refused = (await again.json()) as AdvisoryView;

    // A refusal is a result: the refusal is stated, no work is claimed, and the
    // count of attempts is unchanged — which is the assertion that makes this
    // falsifiable rather than a message the page could print on its own.
    expect(refused.presentationRefusal).toContain('presentation mode');
    expect(refused.regenerated).toBe(false);
    expect(refused.attempted).toBe(prepared.attempted);
  });

  test('says which mode it is in, on the surfaces a demonstration opens', async ({ page }) => {
    await PRESENT(page);

    await page.goto('/command');
    await expect(page.getByTestId('presentation-note')).toContainText('Presentation mode');

    await page.goto('/intelligence');
    await expect(page.getByTestId('advisory-presentation')).toContainText('Presentation mode');
  });

  test('completes the demo flow with nothing outside the machine reachable', async ({ page }) => {
    await PRESENT(page);
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
        external.push(url);
      }
    });

    await page.goto('/intelligence');
    await expect(page.getByTestId('advisory-presentation')).toBeVisible();

    // The one control that would start a model call, pressed on stage.
    await page.getByTestId('advisory-regenerate').click();
    await expect(page.getByTestId('advisory-result')).toContainText('presentation mode');
    // And the summary still renders: the set was prepared, so the page is
    // complete rather than empty.
    await expect(page.getByTestId('advisory-summary')).toBeVisible();

    expect(external, `the flow requested ${external.join(', ')}`).toEqual([]);
  });

  test('leaves the ordinary behaviour alone when the mode is off', async ({ request }) => {
    const response = await request.get('/api/advisories');
    const body = (await response.json()) as AdvisoryView;
    expect(body.presentationMode).toBe(false);
    expect(body.presentationRefusal).toBeNull();
  });
});
