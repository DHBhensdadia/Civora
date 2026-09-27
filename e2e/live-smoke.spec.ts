import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { sessionCookie } from './support';
import type { Session } from './support';

/**
 * The deployed instance, smoke-tested from outside.
 *
 * Every other spec in this folder runs against the production build on this
 * machine. This one runs against a URL — the link a judge opens — and answers the
 * questions a local run cannot:
 *
 *  - **Does it answer?** `/healthz` and `/readyz` on the deployed host, and which
 *    adapters it is actually running against.
 *  - **Is it the same product?** The seeded world, its seed and its fingerprint:
 *    "every reviewer sees the same demonstration" is a claim about a hash.
 *  - **Does the golden path work there?** The dashboard, an alert the pipeline has
 *    raised, the redistribution workbench, a decision recorded through the API
 *    with its actor and reason, and an audit chain that still holds afterwards.
 *  - **Are the rules still the rules?** A decision with no reason, and a decision
 *    attempted by an identity that writes nothing, are both refused — on the
 *    deployed instance, not only on a laptop.
 *
 * **It is gated on `CIVORA_LIVE_URL` and skips with its reason printed when none
 * is set**, so `pnpm e2e` stays green and honest while there is no deployment
 * (currently the case: the project has no Google Cloud account — B1). Run it
 * explicitly:
 *
 *     CIVORA_LIVE_URL="https://civora-web-….run.app" pnpm e2e live-smoke.spec.ts
 *
 * **It may change the instance it points at**: the approval below is a real
 * decision, recorded in the deployed process with this test as its actor. That is
 * deliberate — an approval that was never taken is not evidence that approvals
 * work — and the refusals that follow it are asserted to change nothing.
 */

const LIVE_URL = process.env.CIVORA_LIVE_URL;

/**
 * The fingerprint of the demonstration world.
 *
 * History for 12 facilities, 90 facilities, one seed, 2,18,719 documents. Read
 * on 2026-09-27 from two independent processes — `pnpm db:seed` and the
 * production build's own `GET /api/visibility` — which agreed on this digest.
 * That agreement is the property the check below rests on: a deployed instance
 * whose fingerprint differs is serving a *different* world from the one this
 * repository produces, and the check exists to say so rather than to accept it.
 */
const DEMO_FINGERPRINT = 'sha256:4f620405fcc62cc5946c460950edb1d0';
const DEMO_SEED = 'civora-demo-2026';

test.describe.configure({ mode: 'serial' });
// A scaled-to-zero instance pays image pull and process start on the first
// request. Minutes, not milliseconds; the same patience the live-AI journeys take.
test.setTimeout(180_000);

if (LIVE_URL === undefined) {
  process.stdout.write(
    'live-smoke: skipped — CIVORA_LIVE_URL is not set, so there is no deployed instance to check\n',
  );
} else {
  process.stdout.write(`live-smoke: checking ${LIVE_URL}\n`);
}

const AUDITOR: Session = { role: 'auditor', scopeId: null, label: 'Auditor' };

interface HealthView {
  readonly status: string;
  readonly service: string;
  readonly version: string;
  readonly simulated: boolean;
  readonly adapters: {
    readonly data: { readonly kind: string; readonly ok: boolean };
    readonly auth: { readonly kind: string };
    readonly reasoning: { readonly kind: string };
  };
}

interface VisibilityView {
  readonly store: {
    readonly seed: string;
    readonly fingerprint: string;
    readonly facilitiesWithHistory: number;
    readonly window: { readonly from: string; readonly to: string };
  };
  readonly districts: readonly { readonly id: string; readonly name: string }[];
}

interface AlertView {
  readonly id: string;
  readonly itemId: string;
  readonly facilityId: string;
  readonly severity: string;
  readonly state: string;
  readonly bodies: Readonly<Record<string, string>>;
}

interface IntelligenceView {
  readonly asOf: string;
  readonly pairsScored: number;
  readonly alerts: readonly AlertView[];
}

interface DecisionView {
  readonly decision: 'approved' | 'rejected';
  readonly by: string;
  readonly actorRole: string;
  readonly at: string;
  readonly reason: string | null;
}

interface RedistributionView {
  readonly rows: readonly {
    readonly proposal: { readonly id: string; readonly quantity: number };
    readonly donor: { readonly name: string };
    readonly receiver: { readonly name: string };
    readonly item: { readonly name: string };
    readonly decision: DecisionView | null;
  }[];
  readonly verdict: { readonly valid: boolean; readonly unchecked: readonly unknown[] };
  readonly audit: { readonly valid: boolean; readonly events: number };
  readonly auditEvents: readonly {
    readonly action: string;
    readonly subjectId: string;
    readonly actorRole: string;
    readonly reason: string | null;
  }[];
}

/** A JSON read that fails loudly with the status rather than returning a shape. */
const readJson = async <T>(request: APIRequestContext, path: string): Promise<T> => {
  const response = await request.get(path);
  const body = (await response.json()) as unknown;
  expect(
    response.ok(),
    `GET ${path} answered ${String(response.status())}: ${JSON.stringify(body)}`,
  ).toBe(true);
  return body as T;
};

test.describe('the deployed instance', () => {
  test.skip(
    LIVE_URL === undefined,
    'CIVORA_LIVE_URL is not set: there is no deployed instance to smoke-test, and a local build is what the rest of e2e/ already covers',
  );

  // The whole file talks to the deployed host: the page fixture and the request
  // fixture both take their base URL from here.
  test.use(LIVE_URL === undefined ? {} : { baseURL: LIVE_URL });

  test('answers its health and readiness checks, and names the adapters it runs', async ({
    request,
  }) => {
    const health = await readJson<HealthView>(request, '/healthz');

    expect(health.status).toBe('ok');
    expect(health.service).toBe('civora-web');
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The demonstration data is generated, and the deployed instance says so.
    expect(health.simulated).toBe(true);
    expect(health.adapters.data.ok).toBe(true);

    // Which reasoning adapter is bound is a deployment decision, not a fact this
    // test may assume: `gemini` is what `infra/deploy.sh` binds by default and
    // what the judging link is meant to run, and `fixture` is an instance that
    // answers with refusals instead. Both are named, and which one this is is
    // printed — a skip here would be the claim this test exists to avoid.
    const reasoning = health.adapters.reasoning.kind;
    expect(['gemini', 'fixture']).toContain(reasoning);
    test.info().annotations.push({
      type: 'adapters',
      description: `data=${health.adapters.data.kind} auth=${health.adapters.auth.kind} reasoning=${reasoning}`,
    });

    // Readiness is a different question from liveness, and it can refuse: a store
    // that is not ok, a dataset that was never built, or a chain that does not
    // hold. A deployed instance that cannot answer for its own trail is not ready.
    const readiness = await request.get('/readyz');
    const readinessBody = (await readiness.json()) as {
      readonly ready: boolean;
      readonly checks?: readonly { readonly name: string; readonly ok: boolean }[];
    };
    expect(
      readiness.ok(),
      `/readyz answered ${String(readiness.status())}: ${JSON.stringify(readinessBody)}`,
    ).toBe(true);
    expect(readinessBody.ready).toBe(true);
  });

  test('serves the seeded world the evidence was recorded against', async ({ page, request }) => {
    const visibility = await readJson<VisibilityView>(request, '/api/visibility');

    expect(visibility.store.seed).toBe(DEMO_SEED);
    expect(
      visibility.store.fingerprint,
      'the deployed instance is serving a different dataset from the recorded one',
    ).toBe(DEMO_FINGERPRINT);
    expect(visibility.store.facilitiesWithHistory).toBe(12);
    expect(visibility.districts.length).toBeGreaterThan(0);

    // The same claim in the interface, which is where a judge reads it.
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Civora');
    await expect(page.getByText(/All data the platform shows is simulated/)).toBeVisible();

    await page.goto('/provenance');
    await expect(page.getByText(DEMO_SEED).first()).toBeVisible();
    await expect(page.getByText(DEMO_FINGERPRINT).first()).toBeVisible();
  });

  test('has raised alerts, and shows the body the record carries', async ({ page, request }) => {
    const intelligence = await readJson<IntelligenceView>(request, '/api/intelligence');

    expect(intelligence.pairsScored).toBeGreaterThan(0);
    expect(
      intelligence.alerts.length,
      'the pipeline is expected to raise alerts on this dataset',
    ).toBeGreaterThan(0);

    const alert = intelligence.alerts[0];
    expect(alert, 'at least one alert is expected').toBeDefined();
    if (alert === undefined) {
      return;
    }

    await page.goto('/intelligence');
    await expect(page.getByRole('heading', { name: 'Poorvadarshan · Chetavani' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Alert inbox' })).toBeVisible();

    const entry = page.getByTestId(`alert-${alert.id}`);
    await expect(entry).toBeVisible();
    // The body on the page is the record's own, not a fresh composition.
    const english = alert.bodies.en;
    if (english !== undefined && english !== '') {
      await expect(entry).toContainText(english);
    }
  });

  test('walks the golden path to a recorded decision, and refuses what is not one', async ({
    page,
    request,
  }) => {
    const before = await readJson<RedistributionView>(request, '/api/redistribution');

    expect(before.rows.length, 'the demonstration dataset proposes transfers').toBeGreaterThan(0);
    expect(before.verdict.valid).toBe(true);
    expect(before.audit.valid).toBe(true);

    const undecided = before.rows.find((row) => row.decision === null);
    const target = undecided ?? before.rows[0];
    expect(target, 'there is a proposal to act on').toBeDefined();
    if (target === undefined) {
      return;
    }

    let reason: string;
    let wroteDecision = false;
    if (undecided === undefined) {
      // A second run against an instance that is already decided: the recorded
      // decision is the thing to check, and the branch says so rather than
      // pretending a fresh approval happened.
      test.info().annotations.push({
        type: 'decision',
        description: 'every proposal was already decided; the recorded decision was read back',
      });
      expect(target.decision?.decision).toBe('approved');
      expect(target.decision?.by).toBe('National control room');
      expect(target.decision?.reason, 'a recorded decision carries its reason').toBeTruthy();
      reason = target.decision?.reason ?? '';
    } else {
      reason = `approved by the live smoke test for ${target.item.name}`;
      // The session is the national control room when no cookie is presented;
      // the actor on the record comes from the session, never from the body.
      const decided = await request.post('/api/redistribution/decision', {
        data: { proposalId: target.proposal.id, decision: 'approved', reason },
      });
      const decidedBody = (await decided.json()) as {
        readonly outcome?: string;
        readonly reason?: string;
      };
      expect(
        decided.ok(),
        `POST /api/redistribution/decision answered ${String(decided.status())}: ${JSON.stringify(decidedBody)}`,
      ).toBe(true);
      expect(decidedBody.outcome).toBe('decided');
      wroteDecision = true;
      test.info().annotations.push({
        type: 'decision',
        description: `approved proposal ${target.proposal.id} (${target.item.name})`,
      });
    }

    // Read back from the server rather than from the response that wrote it.
    const after = await readJson<RedistributionView>(request, '/api/redistribution');
    const moved = after.rows.find((row) => row.proposal.id === target.proposal.id);
    expect(moved?.decision?.decision).toBe('approved');
    expect(moved?.decision?.by).toBe('National control room');
    expect(moved?.decision?.actorRole).toBe('national');
    expect(moved?.decision?.at).toBeTruthy();
    expect(moved?.decision?.reason).toBe(reason);

    const event = after.auditEvents.find((candidate) => candidate.subjectId === target.proposal.id);
    expect(event?.action).toBe('transfer-proposal-approved');
    expect(event?.actorRole).toBe('national');
    // The chain the decision was written into still verifies, end to end.
    expect(after.audit.valid).toBe(true);
    if (wroteDecision) {
      // A write adds to the chain; a read-back of somebody else's decision does not.
      expect(after.audit.events).toBeGreaterThan(before.audit.events);
    }

    // --- the edge path: a refusal that changes nothing ----------------------

    const decidedRow = after.rows.find((row) => row.decision !== null);
    expect(decidedRow, 'there is a decided proposal to refuse against').toBeDefined();
    if (decidedRow === undefined) {
      return;
    }

    // An auditor reads the record and writes nothing.
    const auditor = await request.post('/api/redistribution/decision', {
      headers: { cookie: sessionCookie(AUDITOR) },
      data: {
        proposalId: decidedRow.proposal.id,
        decision: 'rejected',
        reason: 'looks fine to me',
      },
    });
    expect(auditor.status()).toBe(403);
    expect(await auditor.text()).toContain('an auditor reads the record but does not write to it');

    // A decision with no reason is refused as a request, not recorded. This rule
    // fires before any other, so it holds whatever the proposal's state is — and
    // an approval nobody can explain afterwards is not auditable.
    const noReason = await request.post('/api/redistribution/decision', {
      data: { proposalId: target.proposal.id, decision: 'approved', reason: '' },
    });
    expect(noReason.status()).toBe(400);
    expect(await noReason.text()).toContain('a decision has to say why it was made');

    // A decision is taken once: a proposal that has been decided cannot be
    // decided again, which is what makes the record a record rather than a state.
    const again = await request.post('/api/redistribution/decision', {
      data: {
        proposalId: decidedRow.proposal.id,
        decision: 'rejected',
        reason: 'changed my mind',
      },
    });
    expect(again.status()).toBe(409);
    expect(await again.text()).toContain('a decision is taken once');

    // Nothing was written by either refusal: the state is what the read said.
    const unchanged = await readJson<RedistributionView>(request, '/api/redistribution');
    expect(unchanged.rows.filter((row) => row.decision !== null).length).toBe(
      after.rows.filter((row) => row.decision !== null).length,
    );
    expect(unchanged.audit.valid).toBe(true);

    // --- the interface shows what the API recorded --------------------------

    await page.goto('/redistribution');
    await expect(
      page.getByRole('heading', { name: 'Setu — redistribution workbench' }),
    ).toBeVisible();
    await expect(page.getByTestId('ui-honesty')).toBeVisible();

    const entry = page.locator(`[data-proposal="${decidedRow.proposal.id}"]`);
    await expect(entry.getByTestId('proposal-decision')).toContainText('approved');
    await expect(page.getByTestId('audit-chain')).toContainText('The chain holds');
  });
});
