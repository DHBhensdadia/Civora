import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * What the reasoning layer has been asked to do.
 *
 * The phase wants this panel for two reasons it states plainly: it is evidence in
 * the demo, and it is the answer to "what does a live burst cost" against a free
 * tier. A panel that is decoration would satisfy neither, so these journeys assert
 * the thing that makes it evidence: **the numbers move by exactly the work that
 * was done.** Ask the writer for a whole alert set, and the call count rises by
 * the size of that set — not by a figure the panel computed for itself.
 *
 * The other half is honesty. With no key configured the adapter is the recorded
 * replay, which sends nothing anywhere: attempts must stay at zero while calls
 * climbs, no model may be named, and a token count nobody reported must read as
 * *not reported* rather than as `0`. A zero there would be a measurement-shaped
 * claim about a model that was never called.
 *
 * Every assertion is a delta or an invariant, so this suite is order-independent:
 * the advisory set is written once per process, and which journey wrote it first
 * is not something a test should depend on.
 *
 * It runs `serial`, like the intake suites, because one of its claims is a delta
 * of zero — that polling this panel makes no calls — and two journeys running
 * beside each other against the same server would break it by legitimately making
 * calls of their own.
 */

test.describe.configure({ mode: 'serial' });

interface TaskTelemetry {
  readonly task: string;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

interface Telemetry {
  readonly provider: string;
  readonly model: string | null;
  readonly reported: boolean;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly meanRequestMs: number | null;
  readonly perTask: readonly TaskTelemetry[];
  readonly projection: {
    readonly alerts: number;
    readonly languages: number;
    readonly advisoryPass: number;
    readonly perCapture: number;
  };
  readonly readAt: string;
}

const readTelemetry = async (request: APIRequestContext): Promise<Telemetry> => {
  const response = await request.get('/api/telemetry');
  expect(response.ok()).toBe(true);
  return (await response.json()) as Telemetry;
};

/** The advisory pass, which is the one burst this platform can trigger on demand. */
const askForTheWholeSet = async (
  request: APIRequestContext,
): Promise<{ readonly attempted: number; readonly alerts: number; readonly languages: number }> => {
  const response = await request.post('/api/advisories', { data: { regenerate: true } });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    readonly attempted: number;
    readonly alerts: readonly unknown[];
    readonly languages: readonly string[];
  };
  expect(payload.attempted).toBeGreaterThan(0);
  return {
    attempted: payload.attempted,
    alerts: payload.alerts.length,
    languages: payload.languages.length,
  };
};

test.describe('the telemetry panel', () => {
  test('counts the work by exactly the work: one request per body, per language', async ({
    request,
  }) => {
    const before = await readTelemetry(request);
    const pass = await askForTheWholeSet(request);
    const after = await readTelemetry(request);

    expect(before.provider).toBe('fixture');
    expect(after.attempts - before.attempts).toBe(0);

    // The row this work belongs to is named, and it carries the pass: a per-task
    // breakdown is what says which capability is spending the quota.
    const taskCalls = (snapshot: Telemetry): number =>
      snapshot.perTask.find((task) => task.task === 'advisory-generation@2')?.calls ?? 0;
    expect(
      after.perTask.some((task) => task.task === 'advisory-generation@2'),
      'the advisory task is named in the breakdown',
    ).toBe(true);

    // The panel is evidence because of this arithmetic. A pass is one request per
    // alert per language, and it is *all* of them: the advisory counter moves in
    // whole passes and never in fragments, which is what says the number came
    // from the requests that were made rather than from a surface's estimate.
    const moved = taskCalls(after) - taskCalls(before);
    expect(moved).toBeGreaterThanOrEqual(pass.attempted);
    expect(moved % pass.attempted, 'the advisory counter moves in whole passes').toBe(0);

    // With no key every request is refused, and a refusal is a result: it is
    // counted, not swallowed, and the failure count rises with the calls.
    expect(after.failures).toBeGreaterThan(before.failures);
  });

  test('keeps the counters of a replay adapter honest about what they measure', async ({
    request,
  }) => {
    const telemetry = await readTelemetry(request);

    // A recording has no model to name, sends nowhere, and reports no tokens —
    // never a zero standing in for a count nobody took.
    expect(telemetry.provider).toBe('fixture');
    expect(telemetry.model).toBeNull();
    expect(telemetry.inputTokens).toBeNull();
    expect(telemetry.outputTokens).toBeNull();
    expect(telemetry.attempts).toBe(0);

    // Every request either came off a recording or was refused; nothing was sent
    // to a model, so those two account for all of them.
    expect(telemetry.cacheHits + telemetry.failures).toBe(telemetry.calls);
    expect(
      telemetry.perTask.reduce((total, task) => total + task.calls, 0),
      'the rows add up to the headline',
    ).toBe(telemetry.calls);
    expect(telemetry.perTask.every((task) => task.attempts === 0)).toBe(true);
  });

  test('is a read that costs nothing: polling it makes no calls', async ({ request }) => {
    const before = await readTelemetry(request);

    // Six reads of the panel, which is more than a minute of its refresh interval.
    for (let read = 0; read < 5; read += 1) {
      await readTelemetry(request);
    }

    const after = await readTelemetry(request);
    // Identical apart from when the snapshot was taken. This is what allows the
    // panel to sit in a five-second poll while the advisory read beside it is
    // deliberately kept out of one — a step that counts calls must not make them.
    expect({ ...after, readAt: '' }).toEqual({ ...before, readAt: '' });
  });

  test('projects what a burst would cost from the inbox it is looking at', async ({ request }) => {
    const telemetry = await readTelemetry(request);
    const pass = await askForTheWholeSet(request);
    const after = await readTelemetry(request);

    // Arithmetic over the current inbox rather than a constant: the alert set
    // moves as alerts are acknowledged and resolved, and a hardcoded figure would
    // be right only until somebody moved one.
    expect(after.projection.alerts).toBeGreaterThan(0);
    expect(after.projection.languages).toBeGreaterThan(0);
    expect(after.projection.advisoryPass).toBe(
      after.projection.alerts * after.projection.languages,
    );
    // And the pass that was just paid is the pass the projection describes.
    expect(pass.attempted).toBe(pass.alerts * pass.languages);
    expect(after.projection.advisoryPass).toBe(pass.attempted);
    expect(after.projection.perCapture).toBe(1);

    // The read is a snapshot, and it says when it was taken.
    expect(telemetry.readAt).not.toBe('');
    expect(Number.isNaN(Date.parse(telemetry.readAt))).toBe(false);
  });

  test('shows the adapter beside its numbers, and refuses to draw a zero it was not given', async ({
    page,
    request,
  }) => {
    await page.goto('/intelligence');
    // Read after the page has loaded: the page's own first read is what writes the
    // advisory set, so the numbers it renders include work the earlier snapshot
    // would not have seen.
    const telemetry = await readTelemetry(request);

    const provider = page.getByTestId('telemetry-provider');
    await expect(provider).toBeVisible();
    // The adapter is named beside the counts, because the same panel under a
    // replay adapter means something entirely different from a model's account.
    await expect(provider).toContainText('fixture');
    await expect(provider).toHaveAttribute('data-reported', 'yes');
    await expect(page.getByTestId('telemetry-model')).toContainText('sends nowhere');

    const totals = page.getByTestId('telemetry-totals');
    await expect(totals).toContainText('calls');
    await expect(totals).toContainText('refused');
    // A token count the provider never returned is said in words. This is the
    // assertion that stops a plausible `0` from being shown as a measurement.
    await expect(totals).toContainText('not reported');
    // Under a replay adapter nothing is attempted against a model, whatever the
    // call count happens to be while other journeys are running.
    await expect(totals).toContainText('attempts 0');

    // The caveat is on the surface, not only in a source comment: a panel of
    // counters under the replay adapter is not a measurement of a model.
    const caveat = page.getByTestId('telemetry-caveat');
    await expect(caveat).toContainText('not a measurement');
    await expect(caveat).toContainText('nothing was sent anywhere');

    // The projection is stated as what it is, with the figures a reader needs to
    // assess the free tier against.
    const projection = page.getByTestId('telemetry-projection');
    await expect(projection).toContainText(String(telemetry.projection.advisoryPass));
    await expect(projection).toContainText('once per process');
    await expect(projection).toContainText('requests a day');
  });

  test('attributes the requests to named tasks in the surface, one row each', async ({
    page,
    request,
  }) => {
    // Make sure there is something to attribute, whoever ran first in this suite.
    await askForTheWholeSet(request);
    const telemetry = await readTelemetry(request);
    expect(telemetry.perTask.length).toBeGreaterThan(0);

    await page.goto('/intelligence');

    const advisoryRow = page.locator(
      '[data-testid="telemetry-task"][data-task="advisory-generation@2"]',
    );
    await expect(advisoryRow).toHaveCount(1);
    await expect(advisoryRow).toContainText('advisory-generation@2');

    // Every task the adapter had reported keeps its row, so a capability cannot
    // spend quota invisibly — which is the thing a per-task breakdown exists to
    // prevent. The rows are a growing set: another journey running beside this one
    // can add a task but cannot take one away.
    expect(await page.getByTestId('telemetry-task').count()).toBeGreaterThanOrEqual(
      telemetry.perTask.length,
    );
    for (const task of telemetry.perTask) {
      await expect(
        page.locator(`[data-testid="telemetry-task"][data-task="${task.task}"]`),
      ).toHaveCount(1);
    }
  });
});
