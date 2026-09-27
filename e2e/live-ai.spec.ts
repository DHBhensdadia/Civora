import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator } from '@playwright/test';

import { registerPageHtml } from '../scripts/register-page';
import { facilityOfTier, readVisibility, today } from './support';
import type { FacilityView } from './support';

/**
 * The live reasoning layer, in a browser.
 *
 * Every other suite in this folder runs against the **fixture** adapter, and says
 * so: the journeys supply a reading or a parse rather than pretending one came
 * from a model. This file is the exception, and it is gated so it cannot run by
 * accident — with `CIVORA_LIVE_AI` unset it skips with its reason printed, which
 * is what keeps CI green and honest while nothing is configured.
 *
 * What it proves when it does run, with a real key:
 *
 *  - **A model reads a page.** The upload is a *rendered* register page, dated
 *    the day the journey runs, not a photograph of one — an easier read, and the
 *    journey says so rather than implying more than it tested. The page's own
 *    date is why the movement the model read is visible in the facility's
 *    record window afterwards.
 *  - **A model hears a recording.** The upload is the system's own speech
 *    synthesis speaking Indian English (`pnpm samples:voice`), not a person.
 *  - **The line it read reaches the ledger** through the ordinary ingest
 *    boundary, marked as vision — and a spoken update is written only after a
 *    person confirms what was heard.
 *  - **The advisory set is written ahead of the burst**, per language, by the
 *    model — including at least one Indian language — and the telemetry panel
 *    reports the calls and the tokens the model actually returned.
 *
 * What it is not: a substitute for the fixture suites, which are the ones that
 * prove the platform's *own* rules (thresholds, routers, queues, refusals) hold
 * without a model in the loop. Both are needed and they answer different
 * questions.
 *
 * **It spends real quota when it runs.** The free tier observed for the flash
 * tier is twenty requests a day per model, so this file is run deliberately —
 * not as part of `pnpm e2e`. A 429 is reported per attempt by the runs that hit
 * it rather than swallowed here.
 */

const LIVE = process.env.CIVORA_LIVE_AI === '1';

/** The model call is slow; these journeys wait for it rather than for a wall. */
const MODEL_PATIENCE_MS = 270_000;

const samplePath = (name: string): string =>
  fileURLToPath(new URL(`../apps/web/public/samples/${name}`, import.meta.url));

/**
 * A person settles whatever the reader could not hear, before agreeing.
 *
 * Kept as one helper because the point of the journey is the *confirmation*, not
 * the errands: what the platform does with an incomplete parse is the fixture
 * suites' subject, and here it is enough that a person can complete it.
 */
const settle = async (pending: Locator, problems: readonly string[]): Promise<void> => {
  if (problems.includes('item-unmatched')) {
    await pending.getByLabel(/^Catalogue entry for voice-/).selectOption({ index: 0 });
  }
  if (problems.includes('batch-not-heard')) {
    await pending.getByLabel(/^Batch for voice-/).fill('B-77');
  }
  if (problems.includes('expiry-not-heard')) {
    await pending.getByLabel(/^Expiry for voice-/).fill('2027-12-31');
  }
};

test.describe.configure({ mode: 'serial' });
test.setTimeout(MODEL_PATIENCE_MS + 30_000);

// A skipped suite that says nothing in the log is a suite somebody will read as
// passing. The reason is on every journey as well; this line puts it where a
// person scanning a test run will see it.
if (!LIVE) {
  process.stdout.write(
    'live-ai: skipped — CIVORA_LIVE_AI is not 1, so no live key is configured and these journeys would test the fixture adapter\n',
  );
}

test.describe('live reasoning — a real model behind the interface', () => {
  // The register page is rendered inside a page whose device scale decides how
  // legible the screenshot is. A phone photograph is the real input; a doubled
  // rendering is the closest a browser can get to one, and it is what the
  // committed sample is produced at too.
  test.use({ viewport: { width: 960, height: 1280 }, deviceScaleFactor: 2 });

  test.skip(
    !LIVE,
    'CIVORA_LIVE_AI is not 1: no live key is configured, so these journeys would test the fixture adapter instead of a model',
  );

  let districtId: string;
  let facility: FacilityView;

  test.beforeAll(async ({ request }) => {
    // The district the capture surfaces open on, read from the platform's own
    // session rather than named here: the forms offer the session's opening
    // district, and a journey that acted on a district the screen does not list
    // would be testing a selection nobody can make.
    const sessionResponse = await request.get('/api/session');
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as { readonly openingDistrictId: string };
    districtId = session.openingDistrictId;
    facility = await facilityOfTier(request, districtId, 'PHC');
  });

  /** What a read route says is behind it. A fixture answer here is a setup error. */
  const assertLiveProvider = async (request: APIRequestContext, path: string): Promise<void> => {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    const payload = (await response.json()) as { provider: string };
    expect(
      payload.provider,
      `${path} is served by "${payload.provider}", not a model: start the server with CIVORA_REASONING_PROVIDER=gemini`,
    ).toBe('gemini');
  };

  const facilityMovements = async (
    request: APIRequestContext,
    of: (line: FacilityView['reading']['recentMovements'][number]) => boolean,
  ): Promise<FacilityView['reading']['recentMovements']> => {
    const payload = await readVisibility(request, { districtId });
    const found = payload.facilities.find((candidate) => candidate.id === facility.id);
    expect(found, 'the district read the journey signed in for holds its facility').toBeDefined();
    return found === undefined ? [] : found.reading.recentMovements.filter(of);
  };

  test('a model reads a register page, and the line it read reaches the ledger', async ({
    page,
    request,
  }) => {
    await assertLiveProvider(request, '/api/vision');

    // The register page is rendered here, dated today. The day on the page is the
    // day the movement is recorded against, and a movement dated to the start of
    // the month would sit outside a facility's newest-five window — a property of
    // the read model, not of the write, but one this journey would then be
    // asserting against instead of the thing it means to check.
    const date = today();
    await page.setContent(registerPageHtml({ heading: 'Stock Register — Daily Page', date }));
    const register = await page.screenshot({ fullPage: true });

    await page.goto('/vision');
    await expect(page.getByTestId('provider-state')).toContainText('gemini');
    await page.getByLabel('Facility', { exact: true }).selectOption(facility.id);
    await page.getByLabel('Register photograph', { exact: true }).setInputFiles({
      name: `${date}-register.png`,
      mimeType: 'image/png',
      buffer: register,
    });

    const read = page.waitForResponse(
      (response) =>
        response.url().includes('/api/vision') && response.request().method() === 'POST',
      { timeout: MODEL_PATIENCE_MS },
    );
    await page.getByRole('button', { name: 'Read the photograph' }).click();

    const response = await read;
    const reading = (await response.json()) as {
      source: string;
      model: string;
      written: number;
      held: number;
    };
    expect(response.status(), JSON.stringify(reading)).toBe(200);
    expect(reading.source, 'the reading came from a model, not from a supplied extraction').toBe(
      'model',
    );
    expect(reading.model).toContain('gemini');
    expect(
      reading.written,
      `the register page carries lines the platform can write; the read was ${JSON.stringify(reading)}`,
    ).toBeGreaterThan(0);

    // The register's own Paracetamol row, as the page states it. The quantity is
    // the assertion that matters: it is a digit the model had to read, and no
    // platform figure could have produced it.
    const written = await facilityMovements(
      request,
      (line) => line.captureSource === 'vision' && line.itemName === 'Paracetamol',
    );
    const rows = written.map((line) => `${line.itemName}@${String(line.quantity)}`);
    expect(
      rows,
      'the ledger read for this facility holds the Paracetamol line the model read at 137 units (a register date outside the visible window would hide it here)',
    ).toContain('Paracetamol@137');
    expect(written.find((line) => line.quantity === 137)?.kind).toBe('receipt');

    // And the surface shows it, marked as read from a photograph.
    const shown = page.getByTestId('vision-written-line').first();
    await expect(shown).toBeVisible();
    await expect(shown).toHaveAttribute('data-provenance', 'vision');
  });

  test('a model hears a recording, nothing is written until a person confirms, and the confirmation writes it', async ({
    page,
    request,
  }) => {
    await assertLiveProvider(request, '/api/voice');

    const before = await facilityMovements(request, (line) => line.captureSource === 'voice');

    await page.goto('/voice');
    await expect(page.getByTestId('voice-provider-state')).toContainText('gemini');
    await page.getByLabel('Facility', { exact: true }).selectOption(facility.id);
    await page.getByLabel('Voice note', { exact: true }).setInputFiles({
      name: 'voice-sample.wav',
      mimeType: 'audio/wav',
      buffer: readFileSync(samplePath('voice-sample.wav')),
    });

    const listened = page.waitForResponse(
      (response) => response.url().includes('/api/voice') && response.request().method() === 'POST',
      { timeout: MODEL_PATIENCE_MS },
    );
    await page.getByRole('button', { name: 'Listen and hold for confirmation' }).click();

    const response = await listened;
    const body = (await response.json()) as {
      outcome: string;
      source: string;
      detail?: string;
      proposal: {
        readonly problems: readonly string[];
        readonly command: { readonly transcript: string; readonly quantity: number | null };
      };
    };
    expect(response.status(), JSON.stringify(body)).toBe(200);
    expect(body.source, 'the parse came from a model, not from a supplied command').toBe('model');
    expect(
      body.proposal.command.transcript.trim().length,
      'the transcript is what the speaker will be shown back, so it cannot be empty',
    ).toBeGreaterThan(0);
    expect(
      body.proposal.command.quantity,
      'the spoken quantity is transcribed as a number — "twenty" is 20',
    ).toBe(20);

    // Held means held: the ledger has nothing new until a person agrees.
    expect(await facilityMovements(request, (line) => line.captureSource === 'voice')).toEqual(
      before,
    );

    const pending = page
      .getByTestId('voice-pending')
      .filter({ hasText: body.proposal.command.transcript });
    await expect(pending).toHaveCount(1);

    // A person settles whatever the reader could not, then agrees to the update.
    await settle(pending, body.proposal.problems);
    await pending.getByRole('button', { name: 'That is what I said — write it' }).click();

    const written = await facilityMovements(
      request,
      (line) => line.captureSource === 'voice' && line.quantity === 20,
    );
    expect(
      written.length,
      'the confirmed update is in the ledger, written for the facility the journey spoke for',
    ).toBeGreaterThan(0);
  });

  test('the workbench’s explanations are written by the model, and a written one reports no refusal', async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/rationales', {
      data: { regenerate: true },
      timeout: MODEL_PATIENCE_MS,
    });
    expect(response.status()).toBe(200);

    const set = (await response.json()) as {
      readonly provider: string;
      readonly proposals: number;
      readonly attempted: number;
      readonly written: number;
      readonly refused: number;
      readonly rationales: readonly {
        readonly status: 'written' | 'refused';
        readonly summary: string | null;
        readonly conditions: readonly string[];
        readonly citations: readonly string[];
        readonly refusal: string | null;
        readonly model: string | null;
      }[];
    };

    test.info().annotations.push({
      type: 'rationale pass',
      description: `${String(set.written)} written, ${String(set.refused)} refused`,
    });

    expect(set.provider).toBe('gemini');
    expect(set.attempted, 'the whole set is attempted in one pass').toBe(set.proposals);
    expect(set.written, 'at least one proposal was explained by the model').toBeGreaterThan(0);

    for (const rationale of set.rationales.filter((row) => row.status === 'written')) {
      expect(rationale.summary ?? '').not.toBe('');
      expect(
        rationale.citations.length,
        'an answer with no citations is not an answer',
      ).toBeGreaterThan(0);
      expect(rationale.model ?? '').toContain('gemini');
      // The live check is what found this: a written rationale reported a refusal
      // sentence in the API, left over from the field's "never asked" default.
      expect(rationale.refusal, 'a written rationale reports no refusal').toBeNull();
    }

    // And the workbench renders at least one written summary beside its proposal
    // (a proposal whose explanation was refused shows the writer's sentence, so
    // the assertion is that a written one is present, not that all of them are).
    await page.goto('/redistribution');
    await expect(
      page.getByTestId('proposal-rationale').filter({ hasText: 'cites' }).first(),
    ).toBeVisible();
  });

  test('the advisory set is written ahead of the burst, per language, by the model', async ({
    page,
    request,
  }) => {
    await assertLiveProvider(request, '/api/advisories');

    const response = await request.post('/api/advisories', {
      data: { regenerate: true },
      timeout: MODEL_PATIENCE_MS,
    });
    expect(response.status()).toBe(200);

    const payload = (await response.json()) as {
      readonly provider: string;
      readonly written: number;
      readonly refused: number;
      readonly alerts: readonly {
        readonly languages: readonly {
          readonly language: string;
          readonly status: 'written' | 'refused';
          readonly model: string | null;
          readonly refusal: string | null;
        }[];
      }[];
    };

    test.info().annotations.push({
      type: 'advisory pass',
      description: `${String(payload.written)} written, ${String(payload.refused)} refused`,
    });

    expect(payload.provider).toBe('gemini');
    expect(payload.written, 'at least one body was written by the model').toBeGreaterThan(0);

    const rows = payload.alerts.flatMap((alert) => alert.languages);
    const written = rows.filter((row) => row.status === 'written');
    expect(written.length, 'the per-language rows add up to the headline').toBe(payload.written);
    expect(written.every((row) => (row.model ?? '').includes('gemini'))).toBe(true);
    // The other defect the live check found: a written row reported the
    // "not attempted yet" sentence in the API, left over from the field's
    // default, so a client reading `refusal` saw a refusal that never happened.
    expect(written.every((row) => row.refusal === null)).toBe(true);
    // The half the fixture suites cannot show: a model writing in an Indian
    // language, not only in English.
    expect(
      written.some((row) => row.language !== 'en'),
      'at least one body is in a language the alert records carry other than English',
    ).toBe(true);

    // And the surface shows a written body with the model that wrote it.
    await page.goto('/intelligence');
    const hindi = page.locator('[data-testid="advisory-language"][data-language="hi"]').first();
    await expect(hindi).toHaveAttribute('data-status', 'written');
    await expect(hindi).toContainText('gemini');
  });

  test('the telemetry panel reports the calls that were made, with the tokens the model returned', async ({
    page,
    request,
  }) => {
    const response = await request.get('/api/telemetry');
    expect(response.ok()).toBe(true);
    const telemetry = (await response.json()) as {
      readonly provider: string;
      readonly model: string | null;
      readonly reported: boolean;
      readonly calls: number;
      readonly attempts: number;
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly perTask: readonly { readonly task: string }[];
    };

    expect(telemetry.provider).toBe('gemini');
    expect(telemetry.model).toContain('gemini');
    expect(telemetry.attempts, 'the model was actually asked').toBeGreaterThan(0);
    // A real response carries token counts; the fixture adapter reports neither.
    expect(telemetry.inputTokens, 'the model reported its input tokens').toBeGreaterThan(0);
    expect(telemetry.outputTokens, 'the model reported its output tokens').toBeGreaterThan(0);

    await page.goto('/intelligence');
    const provider = page.getByTestId('telemetry-provider');
    await expect(provider).toContainText('gemini');
    await expect(provider).toHaveAttribute('data-reported', 'yes');
    await expect(page.getByTestId('telemetry-totals')).toContainText('attempts');

    // Which capability spent the quota is named, not summarised away.
    for (const task of telemetry.perTask) {
      await expect(
        page.locator(`[data-testid="telemetry-task"][data-task="${task.task}"]`),
      ).toHaveCount(1);
    }
  });
});
