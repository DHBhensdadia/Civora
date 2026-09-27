#!/usr/bin/env node

/**
 * Render the sample stock register the live vision check and a person can both use.
 *
 *     pnpm samples:register
 *
 * The file this writes — `apps/web/public/samples/register-sample.png` — is a
 * **rendered page, not a photograph of one**: the journeys that use it say so,
 * because a clean rendering is an easier read than a phone photograph of a
 * folded page and claiming otherwise would overstate what the live check proves.
 *
 * The date on this copy is fixed, so the committed image is the same page every
 * time it is regenerated. The live spec does not use this file's date: it renders
 * the same page dated *today* (`scripts/register-page.mjs`) so the line the model
 * reads lands in the facility's visible record window. This one is the sample a
 * person downloads and tries.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { registerPageHtml } from './register-page';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(repoRoot, 'apps', 'web', 'public', 'samples', 'register-sample.png');

const html = registerPageHtml({
  heading: 'Stock Register — Monthly Statement',
  date: '2026-09-27',
});

const browser = await chromium.launch();

try {
  const page = await browser.newPage({
    viewport: { width: 800, height: 1000 },
    // A register read from a slightly larger rendering is a fairer test of the
    // reader than one read at screen resolution.
    deviceScaleFactor: 2,
  });

  await page.setContent(html, { waitUntil: 'load' });
  const png = await page.screenshot({ fullPage: true });

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, png);
  process.stdout.write(`wrote ${output} (${String(png.length)} bytes)\n`);
} finally {
  await browser.close();
}
