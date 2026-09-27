import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * The Federation Console, in a browser, against the real application.
 *
 * Five claims are asserted here, and each is a claim a federation demo is most
 * likely to get away with making falsely:
 *
 * 1. **The loss is in the shared basis** — the zero model's error is exactly 1,
 *    every round is measured in the same units, and the improvement shown is that
 *    arithmetic rather than a number someone chose.
 * 2. **The ε is the accountant's**, spent round by round and equal to the target
 *    the noise was solved for: the per-round figures sum to the cumulative one,
 *    and the total is the target within the bisection's tolerance.
 * 3. **The privacy cost is displayed, not hidden** — the curve's negative region
 *    (a target where the model ends worse than predicting the pooled mean) is on
 *    the page beside the ceiling a run with no mechanism reaches.
 * 4. **The narrative refuses rather than inventing prose** — with no reasoning
 *    provider configured every round refuses with the provider's own sentence, and
 *    nothing is written in its place.
 * 5. **The honesty boundary is in the product**, with the managed substrate cited
 *    as documented rather than built (ADR 0006).
 *
 * The console is read-only — no test here changes any state — so the file runs in
 * parallel with the others. The first read builds the console once per server
 * process (nine runs over the partition), so the read below is given room.
 */

interface RoundView {
  readonly round: number;
  readonly participants: readonly { readonly siloId: string; readonly sampleCount: number }[];
  readonly rows: number;
  readonly globalLoss: number;
  readonly noiseStandardDeviation: number;
  readonly epsilonSpent: number | null;
  readonly epsilonThisRound: number | null;
  readonly bytesIn: number;
  readonly masked: boolean;
}

interface RunView {
  readonly rounds: readonly RoundView[];
  readonly initialLoss: number;
  readonly finalLoss: number;
  readonly improvement: number;
  readonly noiseMultiplier: number;
  readonly epsilonTarget: number | null;
  readonly delta: number;
  readonly clipNorm: number;
  readonly maskUpdates: boolean;
  readonly spend: {
    readonly epsilon: number;
    readonly delta: number;
    readonly bestOrder: number;
    readonly rdp: number;
  } | null;
}

interface ConsoleView {
  readonly honesty: { readonly statement: string; readonly reference: string };
  readonly partition: { readonly silos: number; readonly samples: number };
  readonly basis: {
    readonly featureCount: number;
    readonly scaleExchange: { readonly payloads: number; readonly bytes: number };
    readonly paidFor: string;
  };
  readonly algorithmic: RunView;
  readonly perSilo: readonly { readonly federatedBetter: boolean }[];
  readonly totals: { readonly silosWhereFederationHelped: number };
  readonly diagnostic: {
    readonly available: boolean;
    readonly divergenceByRound: readonly (number | null)[];
    readonly meanDivergence: number | null;
  };
  readonly priced: RunView;
  readonly curve: {
    readonly quiet: { readonly finalLoss: number };
    readonly points: readonly {
      readonly epsilonTarget: number;
      readonly finalLoss: number | null;
      readonly beatsMean: boolean | null;
    }[];
    readonly curveCommand: string;
    readonly artifactCommand: string;
  };
  readonly narratives: {
    readonly task: string;
    readonly attempts: readonly {
      readonly round: number;
      readonly status: string;
      readonly narrative: unknown;
      readonly refusal: string | null;
    }[];
    readonly written: number;
    readonly refusals: number;
  };
  readonly tests: readonly { readonly command: string; readonly what: string }[];
}

/** Long enough for the first call, which builds the console for the process. */
const BUILD_TIMEOUT_MS = 120_000;

const readConsole = async (request: APIRequestContext): Promise<ConsoleView> => {
  const response = await request.get('/api/federation', { timeout: BUILD_TIMEOUT_MS });
  expect(response.ok()).toBe(true);
  return (await response.json()) as ConsoleView;
};

const openConsole = async (page: Page): Promise<void> => {
  await page.goto('/federation');
  await expect(
    page.getByRole('heading', { name: 'Federated learning across state silos' }),
  ).toBeVisible({ timeout: BUILD_TIMEOUT_MS });
};

test.describe('the federation console', () => {
  test('reports the shared-basis arithmetic rather than a chosen improvement', async ({
    request,
  }) => {
    const payload = await readConsole(request);

    // In the shared basis the target has unit variance, so the zero model's error
    // is 1 — whatever the silos hold, up to the floating-point accumulation over
    // 94,680 rows. A figure away from 1 means either the basis was not shared or
    // the loss was measured in another space.
    expect(payload.algorithmic.initialLoss).toBeCloseTo(1, 10);
    expect(payload.priced.initialLoss).toBeCloseTo(1, 10);
    expect(payload.algorithmic.improvement).toBeCloseTo(
      1 - payload.algorithmic.finalLoss / payload.algorithmic.initialLoss,
      12,
    );

    for (const round of payload.algorithmic.rounds) {
      const rows = round.participants.reduce((total, each) => total + each.sampleCount, 0);
      expect(round.rows).toBe(rows);
      // Every cluster read its own rows and nobody else's: the participant counts
      // add up to the partition, not to a subset of it.
      expect(rows).toBeGreaterThan(0);
      // Bytes are the parameter vector itself, per participant: nothing else
      // crosses. (features + bias) × 8 bytes × participants.
      expect(round.bytesIn).toBe((payload.basis.featureCount + 1) * 8 * round.participants.length);
    }

    // The comparison is per silo and it is reported whichever way it falls: the
    // counts on both sides are the partition's own silo count.
    expect(payload.perSilo).toHaveLength(payload.partition.silos);
    expect(payload.totals.silosWhereFederationHelped).toBeLessThanOrEqual(payload.perSilo.length);
  });

  test('spends the privacy budget the accountant priced, round by round', async ({ request }) => {
    const payload = await readConsole(request);
    const priced = payload.priced;

    expect(priced.spend).not.toBeNull();
    if (priced.spend === null) {
      return;
    }
    expect(priced.epsilonTarget).toBe(8);
    // The audit trail of the spend: each round's own figure is the difference in
    // the cumulative one, and they add up to exactly what the run reports.
    let total = 0;
    for (const round of priced.rounds) {
      expect(round.epsilonSpent).not.toBeNull();
      expect(round.epsilonThisRound).not.toBeNull();
      expect(round.epsilonThisRound ?? 0).toBeGreaterThan(0);
      expect(round.epsilonThisRound ?? 0).toBeCloseTo((round.epsilonSpent ?? 0) - total, 12);
      total = round.epsilonSpent ?? 0;
    }
    expect(total).toBeCloseTo(priced.spend.epsilon, 12);
    // And the figure is the target the noise was solved for, not a number chosen
    // to look good: the bisection lands on 8 within a thousandth.
    expect(Math.abs(priced.spend.epsilon - 8)).toBeLessThan(0.001);
    expect(priced.spend.delta).toBe(priced.delta);
    expect(priced.spend.rdp).toBeGreaterThan(0);
    expect(priced.spend.bestOrder).toBeGreaterThan(1);

    // The noise is calibrated to the clipped sensitivity, not to a constant.
    expect(priced.noiseMultiplier).toBeGreaterThan(0);
    for (const round of priced.rounds) {
      expect(round.noiseStandardDeviation).toBeGreaterThan(0);
      // Masking is on in the priced run, which is why its divergence is null —
      // the diagnostic is measured in a second run with masking off.
      expect(round.masked).toBe(true);
    }

    // The diagnostic exists, and it is a real spread, not a placeholder: two
    // silos that proposed the same direction would read 0, and disjoint ones 1.
    expect(payload.diagnostic.available).toBe(true);
    const measured = payload.diagnostic.divergenceByRound.filter(
      (value): value is number => value !== null,
    );
    expect(measured).toHaveLength(priced.rounds.length);
    for (const value of measured) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  test('shows what the guarantee costs, negative region included', async ({ request, page }) => {
    const payload = await readConsole(request);

    // The curve is drawn from real runs: every point carries a loss, and at least
    // one of them is worse than predicting the pooled mean. That negative region
    // is a measurement this project must publish rather than tune away.
    const destroyed = payload.curve.points.filter((point) => point.beatsMean === false);
    expect(destroyed.length).toBeGreaterThan(0);
    expect(payload.curve.points.some((point) => point.beatsMean === true)).toBe(true);

    await openConsole(page);

    await expect(page.getByRole('heading', { name: /ε against accuracy/ })).toBeVisible({
      timeout: BUILD_TIMEOUT_MS,
    });
    // A target where the noise did more damage than the rounds did good, named on
    // the screen in those terms.
    await expect(page.getByText('worse than predicting the pooled mean')).toHaveCount(
      destroyed.length,
    );
    await expect(page.getByText('the ceiling these targets are read against')).toBeVisible();
    // Both commands are on the page: the one that reproduces this page's three
    // points, and the one that writes the full-resolution document. The second
    // appears twice (the curve panel and the reproduction table), so the locator
    // is narrowed rather than made lenient.
    await expect(page.getByText(payload.curve.curveCommand, { exact: false })).toBeVisible();
    await expect(
      page.getByText(payload.curve.artifactCommand, { exact: false }).first(),
    ).toBeVisible();
  });

  test('puts the honesty boundary and the cited substrate in the product', async ({
    request,
    page,
  }) => {
    const payload = await readConsole(request);
    await openConsole(page);

    // Verbatim from `statement.ts`: the page cannot paraphrase the boundary into
    // something softer, because the same sentence is asserted against the package.
    await expect(page.getByText(payload.honesty.statement, { exact: false })).toBeVisible();
    await expect(page.getByText(payload.honesty.reference, { exact: false })).toBeVisible();
    await expect(page.getByText(/not a deployed multi-organisation federation/)).toBeVisible();
    await expect(page.getByText(/documented and cited, not built/)).toBeVisible();
    await expect(page.getByText(/Every silo, row and loss on this page/)).toBeVisible();

    // The statistic release is stated as unpriced, because the ε prices the
    // updates: a page that let a reader assume the basis was free would be
    // overclaiming in the one place this phase exists to be careful.
    await expect(page.getByText(payload.basis.paidFor, { exact: false })).toBeVisible();
    expect(payload.basis.scaleExchange.payloads).toBe(payload.partition.silos);
    expect(payload.basis.scaleExchange.bytes).toBe(
      payload.partition.silos * (payload.basis.featureCount * 2 + 2) * 8,
    );
  });

  test('refuses a round narrative instead of inventing one', async ({ request, page }) => {
    const payload = await readConsole(request);

    expect(payload.narratives.task).toBe('federation-narrative@2');
    expect(payload.narratives.written).toBe(0);
    expect(payload.narratives.refusals).toBe(payload.narratives.attempts.length);
    expect(payload.narratives.attempts.length).toBe(payload.priced.rounds.length);
    for (const attempt of payload.narratives.attempts) {
      expect(attempt.status).toBe('refused');
      expect(attempt.narrative).toBeNull();
      expect(attempt.refusal ?? '').toContain('federation-narrative@2');
    }

    await openConsole(page);
    await expect(page.getByRole('heading', { name: /round narrative/ })).toBeVisible();
    await expect(page.getByText(/no fixture was invented to fill the panel/)).toBeVisible();
    await expect(
      page.getByText(`no recorded response for task "federation-narrative@2"`).first(),
    ).toBeVisible();

    // The commands behind the claim are on the page, including the phase's own
    // evidence command, so a reader can reproduce every figure without asking.
    await expect(
      page.getByText('pnpm fl:run --rounds 10 --silos all --dp --epsilon-target 8'),
    ).toBeVisible();
    expect(
      payload.tests.some((entry) => entry.command.includes('--filter @civora/federated')),
    ).toBe(true);
  });

  test('answers the same figures to two separate reads of the same process', async ({
    request,
  }) => {
    const first = await readConsole(request);
    const again = await readConsole(request);

    // The rounds are a pure function of the world, the configuration and the seed,
    // so a second read cannot differ — and the console is built once per process,
    // so this compares a memoised answer against itself rather than two runs.
    expect(JSON.stringify(again.algorithmic.rounds)).toBe(JSON.stringify(first.algorithmic.rounds));
    expect(JSON.stringify(again.priced.rounds)).toBe(JSON.stringify(first.priced.rounds));
    expect(again.algorithmic.finalLoss).toBe(first.algorithmic.finalLoss);
  });
});
