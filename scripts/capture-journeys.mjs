#!/usr/bin/env node

/**
 * Screenshot each of the ten named journeys, and say what each screenshot showed.
 *
 * The verification plan names ten end-to-end journeys and asks for each one to be
 * recorded with its spec and a screenshot. A screenshot is only evidence when a
 * script produces it and a record says what it showed, so this walks the ten
 * surfaces against the production build, reads the words that make each one the
 * journey's surface, and writes `journeys.md` beside the PNGs.
 *
 * **What a screenshot can and cannot show is stated per stop.** Idempotency, for
 * instance, is a duplicate *not* writing anything — a still image cannot show a
 * non-event, so the record names the spec that asserts it and the image shows the
 * surface it happens on. Where a journey's own action is cheap and honest to
 * perform — approving the proposal whose approval the audit view then carries —
 * the script performs it and says so.
 *
 * Usage: node scripts/capture-journeys.mjs <output-directory>
 *
 * One production server (`pnpm build` first), one port, one browser.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = join(repoRoot, 'scripts', 'serve-standalone.mjs');
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'journeys'));
mkdirSync(outDir, { recursive: true });

const PORT = 3215;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const waitForServer = async (url, deadlineMs) => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet; the loop is the retry.
    }
    if (Date.now() > until) {
      throw new Error(`the server at ${url} did not answer within ${String(deadlineMs)} ms`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
};

const server = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: '127.0.0.1',
    CIVORA_DATA_PROVIDER: 'in-memory',
    CIVORA_AUTH_PROVIDER: 'fixture',
    CIVORA_REASONING_PROVIDER: 'fixture',
  },
  stdio: 'inherit',
});

const textOf = async (page, testId) => {
  const locator = page.getByTestId(testId).first();
  if ((await locator.count()) === 0) {
    return null;
  }
  return (await locator.innerText()).replace(/\s+/g, ' ').trim();
};

const results = [];

const record = (journey, spec, path, image, shows) => {
  results.push({ journey, spec, path, image, shows });
};

try {
  await waitForServer(`${BASE}/healthz`, 60_000);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const shot = async (name) => {
      await page.screenshot({ path: join(outDir, name) });
      return name;
    };

    // 1 — a nurse records stock with no connection.
    await page.goto(`${BASE}/capture`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 60_000 });
    await context.setOffline(true);
    await page.getByTestId('sync-state').first().waitFor({ timeout: 30_000 });
    const offline = await textOf(page, 'sync-state');
    record(
      '1 — records stock on a tablet, offline',
      'e2e/capture.spec.ts',
      '/capture',
      await shot('journey-01-offline-capture.png'),
      `the capture screen with the browser genuinely offline: "sync-state" reads ${JSON.stringify(offline)}. The queue and the reconcile-back are asserted by the spec, which fills the form offline, queues three records, and watches the pending count fall to zero when the connection returns.`,
    );
    await context.setOffline(false);

    // 2 — a duplicate delivery is a replay, not a second movement.
    const ledger = await page.request.get(`${BASE}/api/visibility`);
    const ledgerState = ledger.ok() ? 'the visibility read answers' : 'the visibility read failed';
    record(
      '2 — duplicate sync is idempotent',
      'e2e/ingest.spec.ts',
      '/capture',
      'journey-01-offline-capture.png',
      `the surface a replayed delivery arrives at; ${ledgerState}. A still image cannot show a write that did not happen: the spec asserts it against the ledger, firing the same submission twice and reading the stored movement back once.`,
    );

    // 3 — a photograph of a register, and the queue a low-confidence line lands in.
    // The refusal is provoked rather than assumed: submitting a photograph with no
    // reader configured is the shipping state, and the sentence it produces is the
    // evidence that nothing was written from a picture nobody read.
    await page.goto(`${BASE}/vision`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Register photograph', { exact: true }).setInputFiles({
      name: 'register.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not really a register'),
    });
    await page.getByRole('button', { name: 'Read the photograph' }).click();
    await page.getByTestId('vision-refusal').waitFor({ timeout: 60_000 });
    const visionRefusal = await textOf(page, 'vision-refusal');
    record(
      '3 — a photograph becomes a reading, with low-confidence lines held',
      'e2e/vision-intake.spec.ts',
      '/vision',
      await shot('journey-03-photo-extraction.png'),
      `a photograph submitted on the screen that reads them. With no model configured this build shows the reader's own refusal rather than an empty space: ${JSON.stringify(visionRefusal)}. The queue path is asserted by the spec against a supplied reading — a poor line becomes a review entry and no ledger write.`,
    );

    // 4 — a spoken update, held until a person confirms it. Same shape as the
    // photograph: a recording is submitted, and with no reader configured the
    // platform refuses rather than parsing it from somewhere else.
    await page.goto(`${BASE}/voice`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Voice note', { exact: true }).setInputFiles({
      name: 'report.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from('not really a recording'),
    });
    await page.getByRole('button', { name: 'Listen and hold for confirmation' }).click();
    await page.getByTestId('voice-refusal').waitFor({ timeout: 60_000 });
    const voiceRefusal = await textOf(page, 'voice-refusal');
    record(
      '4 — a spoken update becomes a ledger entry, after confirmation',
      'e2e/voice-intake.spec.ts',
      '/voice',
      await shot('journey-04-spoken-update.png'),
      `a recording submitted on the listen-and-confirm screen; with no model configured the writer's refusal is shown verbatim: ${JSON.stringify(voiceRefusal)}. The spec drives the whole path — a parse held as a proposal, nothing written, the write following a person's confirmation.`,
    );

    // 5 — the district risk picture, with the drivers behind an alert.
    await page.goto(`${BASE}/intelligence`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Alert inbox' }).waitFor({ timeout: 60_000 });
    const intelligence = await (await page.request.get(`${BASE}/api/intelligence`)).json();
    const topRow = intelligence.rows?.[0];
    const topDrivers = Array.isArray(topRow?.drivers) ? topRow.drivers : [];
    record(
      '5 — a risk-ranked dashboard, and the drivers behind an alert',
      'e2e/risk-inbox.spec.ts',
      '/intelligence',
      await shot('journey-05-risk-inbox.png'),
      `the ranked inbox, scored over ${String(intelligence.pairsScored ?? 0)} facility-item pair(s) in ${String(intelligence.scoredInMs ?? 0)} ms, carrying ${String(intelligence.alerts?.length ?? 0)} alert(s). The top-ranked row is ${JSON.stringify(topRow?.itemName ?? 'none')} at ${JSON.stringify(topRow?.facilityName ?? 'none')} (${JSON.stringify(topRow?.districtName ?? '')}), band ${JSON.stringify(topRow?.band ?? 'none')}, with ${String(topDrivers.length)} named driver(s)${topDrivers.length > 0 ? `, led by ${JSON.stringify(topDrivers[0].driver)}` : ''}. Every driver carries its own sentence, all nine appear whatever the inputs, and the spec asserts the whole set rather than the top row.`,
    );

    // 6 — an alert explained in the officer's own language, with citations.
    const panel = page.getByRole('region', {
      name: 'Advisory bodies, written ahead of the burst',
    });
    const summary = await textOf(page, 'advisory-summary');
    await panel.first().scrollIntoViewIfNeeded();
    record(
      '6 — an alert explained in the officer’s language, from the record’s own facts',
      'e2e/advisories.spec.ts',
      '/intelligence (the advisory panel)',
      await shot('journey-06-advisory-panel.png'),
      `the advisory panel: ${JSON.stringify(summary)}. Each language shows either generated prose or the writer's refusal beside the body the record already holds — never an empty space — and the spec asserts the panel's record line equals the body the inbox reads, with the Hindi numerals rendered in Devanagari.`,
    );

    // 7 — a safe transfer proposed, with its constraint verdict on the row.
    await page.goto(`${BASE}/redistribution`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Proposals' }).waitFor({ timeout: 120_000 });
    const verdict = await textOf(page, 'plan-verdict');
    const proposalVerdict = await textOf(page, 'proposal-verdict');
    const redistribution = await (await page.request.get(`${BASE}/api/redistribution`)).json();
    record(
      '7 — a safe transfer proposed, an unsafe one refused',
      'e2e/redistribution.spec.ts',
      '/redistribution',
      await shot('journey-07-redistribution.png'),
      `the workbench: ${JSON.stringify(verdict)} — over ${String(redistribution.rows?.length ?? 0)} proposal(s), each carrying its own verdict on the row (${JSON.stringify(proposalVerdict)}). Nothing here moves stock, and the spec asserts the refusals (a donor below its floor, an arrival after the shelf empties) alongside the admitted plan.`,
    );

    // 8 — an approval, and the audit entry behind it.
    const undecided = (redistribution.rows ?? []).find((row) => row.decision === null);
    let approved = null;
    if (undecided !== undefined) {
      const decision = await page.request.post(`${BASE}/api/redistribution/decision`, {
        data: {
          proposalId: undecided.proposal.id,
          decision: 'approved',
          reason: 'recorded by the screenshot tool so the audit view has a decision to carry',
        },
      });
      approved = { id: undecided.proposal.id, status: decision.status() };
    }
    await page.goto(`${BASE}/audit`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('audit-rows').waitFor({ timeout: 120_000 });
    const auditReport = await textOf(page, 'audit-report');
    const auditCount = await textOf(page, 'audit-count');
    record(
      '8 — the approval is recorded in the audit trail',
      'e2e/audit-chain.spec.ts',
      '/audit',
      await shot('journey-08-audit-chain.png'),
      `${approved === null ? 'no undecided proposal was available on this instance' : `this script took one decision (${JSON.stringify(approved.id)}, HTTP ${String(approved.status)}) so the trail has an approval to carry`}. The viewer then reports ${JSON.stringify(auditReport)} and ${JSON.stringify(auditCount)} — the walk covers the whole chain rather than the rows on screen, which the spec asserts by comparing the entries walked against the entries held.`,
    );

    // 9 — a federated round, its privacy budget, and the payload assertion.
    await page.goto(`${BASE}/federation`, { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('heading', { name: 'Federated learning across state silos' })
      .waitFor({ timeout: 240_000 });
    const federation = await (
      await page.request.get(`${BASE}/api/federation`, { timeout: 240_000 })
    ).json();
    const run = federation.priced ?? {};
    const rounds = Array.isArray(run.rounds) ? run.rounds : [];
    const maskedRounds = rounds.filter((round) => round.masked === true).length;
    record(
      '9 — a federated round across state silos, with (ε, δ) and a payload assertion',
      'e2e/federation-console.spec.ts',
      '/federation',
      await shot('journey-09-federation.png'),
      `the console after the rounds are computed: ${String(rounds.length)} round(s) over ${String(run.participated?.length ?? 0)} silo(s), ε spent ${JSON.stringify(run.spend?.epsilon ?? null)} (RDP order ${String(run.spend?.bestOrder ?? '?')}, ${JSON.stringify(run.spend?.rdp ?? null)}) at δ ${JSON.stringify(run.delta ?? null)}, with ${String(maskedRounds)} of ${String(rounds.length)} round(s) reporting a masked payload. The spec asserts the payload carries no feature values, no record ids and no timestamps, by scanning for sentinels planted in the silo's own data.`,
    );

    // 10 — a facility that has gone quiet reads as unknown, not safe.
    await page.goto(`${BASE}/visibility`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 120_000 });
    const visibility = await (await page.request.get(`${BASE}/api/visibility`)).json();
    const silent = (visibility.facilities ?? []).find(
      (facility) => facility.reading?.status !== 'current',
    );
    record(
      '10 — a stale facility is unknown, never safe',
      'e2e/visibility.spec.ts',
      '/visibility',
      await shot('journey-10-stale-unknown.png'),
      `the district view. ${silent === undefined ? 'every facility in this read has reported' : `${JSON.stringify(silent.name)} reads ${JSON.stringify(silent.reading.status)} with its newest reading ${JSON.stringify(silent.reading.newestReadingOn)}`} — a facility the platform cannot hear is shown as unknown rather than as stocked, and the spec asserts both sides of that: the silent row carries the word and a current one does not.`,
    );

    console.log(`captured ${String(results.length)} journeys`);
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}

const pageRecord = [
  '# The ten named end-to-end journeys',
  '',
  'Generated by `node scripts/capture-journeys.mjs <directory>` against the production',
  'build (`pnpm build` first), with one in-memory server and the fixture reasoning',
  'adapter — the shipping configuration. The PNGs sit beside this file. Each row names',
  'the spec that asserts the journey and what the screenshot actually showed; where a',
  'still image cannot show the claim (a duplicate that wrote nothing), the row says so',
  'rather than implying the picture proves it.',
  '',
  '| Journey | Surface | Spec | Screenshot | What the screenshot showed |',
  '| --- | --- | --- | --- | --- |',
  ...results.map(
    (result) =>
      `| ${result.journey} | \`${result.path}\` | \`${result.spec}\` | \`${result.image}\` | ${result.shows.replaceAll('|', '\\|')} |`,
  ),
  '',
].join('\n');

writeFileSync(join(outDir, 'journeys.md'), pageRecord);
console.log(`wrote ${join(outDir, 'journeys.md')}`);
