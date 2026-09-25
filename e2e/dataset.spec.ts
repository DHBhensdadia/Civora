import { expect, test } from '@playwright/test';

/**
 * The dataset inspector journey.
 *
 * This phase's work is a library — schemas, a ledger derivation and a generator
 * — with no user-facing surface until this page exists. These tests are
 * therefore the only evidence that a person can see what the phase produced,
 * and they are written to check the claim rather than the layout: that the
 * page reports the network it actually built, and that it says plainly which
 * parts of the dataset are read, assumed and generated.
 */

test.describe('the dataset inspector', () => {
  test('is reachable from the overview and states what the dataset is', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Dataset inspector' }).first().click();

    await expect(page).toHaveURL(/\/dataset$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'What this platform is running on',
    );

    // The honesty statement a reader must meet before any number on the page.
    await expect(
      page.getByRole('heading', { name: 'Everything the platform observes is simulated' }),
    ).toBeVisible();
    await expect(page.getByText('synthetic: true').first()).toBeVisible();

    // The dataset is identified by the seed it can be regenerated from.
    await expect(page.getByText('civora-demo-2026').first()).toBeVisible();
  });

  test('reports the network it generated, by state and by tier', async ({ page }) => {
    await page.goto('/dataset');

    // Every anchored state is named, so the page proves its own breadth rather
    // than asserting a total.
    for (const state of [
      'Odisha',
      'Bihar',
      'Maharashtra',
      'Tamil Nadu',
      'Kerala',
      'Uttar Pradesh',
    ]) {
      await expect(page.getByRole('cell', { name: state, exact: true }).first()).toBeVisible();
    }

    // Every tier the model knows about is listed, including the one this
    // profile does not site.
    for (const tier of ['SHC', 'AAM', 'PHC', 'CHC']) {
      await expect(page.getByText(tier, { exact: true }).first()).toBeVisible();
    }
  });

  test('states the window and the scenario the history was observed under', async ({ page }) => {
    await page.goto('/dataset');

    await expect(page.getByText('2026-03-01 → 2026-09-24')).toBeVisible();
    await expect(page.getByText('monsoon-fever-surge')).toBeVisible();
  });

  test('separates what the network heard from what it cannot observe', async ({ page }) => {
    await page.goto('/dataset');

    await expect(
      page.getByRole('heading', { name: 'What the network heard, against what happened' }),
    ).toBeVisible();
    await expect(page.getByText('Stock ledger entries').first()).toBeVisible();
    await expect(page.getByText('Units wanted and not dispensed')).toBeVisible();
  });

  test('lays the whole inspector out without overflowing the viewport', async ({ page }) => {
    await page.goto('/dataset');

    // Every panel is present, so a section silently dropping out of the page is
    // caught here rather than by a reader who cannot find it.
    const sections = await page.getByRole('heading', { level: 2 }).count();
    expect(sections).toBeGreaterThanOrEqual(9);

    // A table wider than its column scrolls inside its own wrapper. If one
    // escapes, the document itself starts scrolling sideways, which on a page
    // this dense is how a reader loses a column without noticing.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('records a source it could not retrieve instead of substituting one', async ({ page }) => {
    await page.goto('/dataset');

    await expect(
      page.getByRole('heading', { name: 'What the dataset is anchored on' }),
    ).toBeVisible();

    // The registry is honest in both directions, and the failures are the
    // informative half: they are why the dataset's own administrative codes
    // carry a SIM- prefix rather than an official-looking one.
    const directory = page.locator('tr', { hasText: 'Local Government Directory' });
    await expect(directory.getByText('not retrieved')).toBeVisible();

    await directory.getByText('what was obtained').click();
    await expect(directory.getByText(/NOT present anywhere in this dataset/)).toBeVisible();
  });
});
