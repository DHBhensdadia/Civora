import { expect, test } from '@playwright/test';

test.describe('the foundation build', () => {
  test('serves the application shell that states what it is', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Civora');
    await expect(page.getByRole('heading', { name: /sensing plane exists/ })).toBeVisible();
    await expect(page.getByText(/All data the platform shows is simulated/)).toBeVisible();

    // The five modules are named, each with a status, and the four that do not
    // exist say so rather than being implied to work by their proximity to the
    // one that does.
    for (const module of ['Drishti', 'Poorvadarshan', 'Chetavani', 'Setu', 'Samvad']) {
      await expect(page.getByText(module, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('not implemented').first()).toBeVisible();
    await expect(page.getByText(/sensing plane implemented/)).toBeVisible();
  });

  test('reports the adapters it is running against', async ({ page }) => {
    await page.goto('/');

    const adapters = page.getByRole('heading', { name: 'Active adapters' });
    await expect(adapters).toBeVisible();
    await expect(page.getByText('in-memory', { exact: true })).toBeVisible();
  });

  test('serves compiled styles rather than an unstyled document', async ({ page }) => {
    await page.goto('/');

    // If the stylesheet fails to build or fails to load, the browser falls back
    // to a transparent background and a serif default. Asserting on the computed
    // result catches a broken asset pipeline that text assertions cannot.
    const styles = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      return { background: body.backgroundColor, fontFamily: body.fontFamily };
    });

    expect(styles.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.fontFamily).not.toContain('Times');
  });

  test('answers a health check with no cloud credentials configured', async ({ request }) => {
    const response = await request.get('/healthz');
    expect(response.ok()).toBe(true);

    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      service: 'civora-web',
      simulated: true,
      adapters: {
        data: { kind: 'in-memory', ok: true },
        auth: { kind: 'fixture' },
        reasoning: { kind: 'fixture' },
      },
    });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
