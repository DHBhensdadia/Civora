import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { sessionCookie, stockEnvelope, today } from './support';
import type { Session } from './support';

/**
 * The audit trail, asserted through the surface that shows it.
 *
 * Four claims are the point of this file. The chain **holds**, and the viewer says
 * so with a walk over the whole trail rather than over the rows on screen. A real
 * **decision reaches it** — a capture made through the ingest boundary, and the
 * federated rounds a session caused — so the trail is a consequence of the
 * platform's own work rather than a panel that only ever shows what a test wrote.
 * **Filtering narrows the entries and not the verification**, which is the
 * property that separates an audit surface from a log viewer. And a role the
 * chain is not shown to is **refused in a sentence**, in the interface and at the
 * route, because the rule is also enforced where the data lives.
 *
 * Two things about this file are deliberate, and both come from sharing one
 * server with every other journey:
 *
 *  - **It waits rather than fails.** The federated console's first build is
 *    seconds of arithmetic on the server's own thread, so a request that arrives
 *    while it runs is queued behind it. The reads here are given a minute instead
 *    of the default thirty seconds, and every journey is given two minutes — a
 *    journey that failed because another surface was thinking would be measuring
 *    the queue rather than the trail. The same reason makes the reads cheap: a
 *    facility and its item come from the session list and the catalogue rather
 *    than from the district-by-district visibility read.
 *  - **No journey asserts a total.** Counts are read from a single payload and
 *    compared with themselves — the entries walked against the entries held, the
 *    matched rows against the whole chain — which is the claim that survives a
 *    neighbouring spec having just appended an entry of its own.
 */

test.beforeEach(() => {
  test.setTimeout(120_000);
});

/** How long a request may wait while another surface holds the server's thread. */
const PATIENCE_MS = 60_000;

interface Principal {
  readonly role: string;
  readonly scopeId: string | null;
  readonly label: string;
}

interface TrailView {
  readonly report: {
    readonly events: number;
    readonly valid: boolean;
    readonly brokenAt: string | null;
    readonly detail: string;
  };
  readonly rows: readonly {
    readonly id: string;
    readonly action: string;
    readonly actorUid: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
  readonly matched: number;
  readonly total: number;
  readonly shown: number;
  readonly registered: readonly { readonly action: string; readonly recorded: number }[];
}

/**
 * Headers for one request: the session, and a connection of its own.
 *
 * `connection: close` is here because of what this file waits for. Node closes an
 * idle keep-alive socket after five seconds, and a journey that has just spent
 * fifteen waiting for the federated build will happily reuse the socket it used
 * before — which the server has already closed, so the request dies with
 * `ECONNRESET` rather than an answer. Asking for a fresh connection removes a
 * failure mode that has nothing to do with the audit trail.
 */
const headersFor = (session?: Session): Record<string, string> => ({
  connection: 'close',
  ...(session === undefined ? {} : { cookie: sessionCookie(session) }),
});

const principalsOf = async (request: APIRequestContext): Promise<readonly Principal[]> => {
  const response = await request.get('/api/session', {
    timeout: PATIENCE_MS,
    headers: headersFor(),
  });
  const body = (await response.json()) as { readonly principals: readonly Principal[] };
  return body.principals;
};

const readTrail = async (
  request: APIRequestContext,
  query = '',
  session?: Session,
): Promise<{
  readonly status: number;
  readonly trail: TrailView | null;
  readonly detail: string;
}> => {
  const response = await request.get(`/api/audit${query}`, {
    timeout: PATIENCE_MS,
    headers: headersFor(session),
  });
  const body = (await response.json()) as { readonly trail?: TrailView; readonly detail?: string };
  return { status: response.status(), trail: body.trail ?? null, detail: body.detail ?? '' };
};

interface IngestAnswer {
  readonly status: number;
  readonly body: {
    readonly outcome?: string;
    readonly subjectKey?: string;
    readonly detail?: string;
  };
}

const submit = async (
  request: APIRequestContext,
  envelope: unknown,
  session?: Session,
): Promise<IngestAnswer> => {
  const response = await request.post('/api/ingest', {
    timeout: PATIENCE_MS,
    data: envelope,
    headers: headersFor(session),
  });
  return { status: response.status(), body: (await response.json()) as IngestAnswer['body'] };
};

/**
 * A facility the demonstration offers, the item to write against, and the staff
 * identity anchored to it.
 *
 * Read from the session list rather than from the visibility read: the identity
 * fixtures are built from the same network, so the facility here is a real one,
 * and asking for it this way keeps a journey off the server's heaviest read.
 */
interface CaptureTarget {
  readonly facilityId: string;
  readonly itemId: string;
  readonly session: Session;
}

const captureTarget = async (request: APIRequestContext): Promise<CaptureTarget> => {
  const staff = (await principalsOf(request)).find(
    (principal) => principal.role === 'phc_staff' && principal.scopeId !== null,
  );
  const catalogue = await request.get('/api/catalogue', {
    timeout: PATIENCE_MS,
    headers: headersFor(),
  });
  const items = (await catalogue.json()) as { readonly items: readonly { id: string }[] };
  const item = items.items[0];

  expect(staff, 'the demonstration offers no facility identity').toBeDefined();
  expect(item, 'the catalogue is empty').toBeDefined();
  if (staff?.scopeId == null || item === undefined) {
    throw new Error('the demonstration offers nothing to capture against');
  }
  return {
    facilityId: staff.scopeId,
    itemId: item.id,
    session: { role: staff.role, scopeId: staff.scopeId, label: staff.label },
  };
};

/**
 * One movement of this journey's own.
 *
 * The chain starts empty in a fresh process — it is written by decisions, and a
 * journey that arrives before anybody has decided anything is looking at an empty
 * trail. Recording one movement makes the journey's own claim stand on something
 * and keeps it from depending on a neighbouring spec having run first.
 */
const recordOneMovement = async (
  request: APIRequestContext,
  target: CaptureTarget,
  quantity: number,
): Promise<void> => {
  const entryId = `e2e-audit-${String(Date.now())}-${String(quantity)}`;
  const submitted = await submit(
    request,
    stockEnvelope({
      facilityId: target.facilityId,
      itemId: target.itemId,
      entryId,
      key: `${entryId}-key`,
      quantity,
      occurredOn: today(),
    }),
  );
  expect(submitted.body.outcome).toBe('accepted');
};

const visit = async (page: Page, path: string, session?: Session): Promise<void> => {
  // Set by domain rather than by URL, so the journey does not repeat the port the
  // server happens to be running on.
  if (session !== undefined) {
    await page.context().addCookies([
      {
        name: 'civora-session',
        value: encodeURIComponent(JSON.stringify(session)),
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
  }
  await page.goto(path, { timeout: PATIENCE_MS });
};

/**
 * A count the viewer prints, read by the phrase it is printed in.
 *
 * The phrases matter. One sentence — "showing 5 entries of 5 matching entries in
 * a chain of 8 entries" — contains three numbers followed by the same word, so a
 * parser that matches the first is reading a different quantity than the
 * assertion thinks it is, and would pass on a coincidence.
 *
 * **The page pluralizes**, and a run can find the chain holding one entry: the
 * store starts empty, so the first journey of a run that records something is
 * looking at a chain of exactly one. "chain of 1 entry" is a correct reading of
 * the trail, so the phrases accept both forms rather than requiring the plural a
 * busier run happens to print.
 */
const countIn = (text: string, pattern: RegExp): number => {
  const match = pattern.exec(text.replaceAll(',', ''));
  expect(match, `the page prints no count matching ${String(pattern)}`).not.toBeNull();
  return Number(match?.[1] ?? '0');
};

/** "…is in a chain of 8 entries", or "…of 1 entry". */
const CHAIN_OF = /chain of (\d+) entr(?:y|ies)/;
/** "all 8 entries link to the one before them", the verification's own sentence. */
const WALKED = /all (\d+) entr(?:y|ies)/;
/** "of 5 matching entries", or "of 1 matching entry". */
const MATCHING = /of (\d+) matching entr(?:y|ies)/;

test.describe('the audit chain', () => {
  test('holds, and the walk the viewer reports covers the whole chain', async ({
    page,
    request,
  }) => {
    const target = await captureTarget(request);
    await recordOneMovement(request, target, 2);

    const read = await readTrail(request);
    expect(read.status).toBe(200);
    expect(read.trail?.report.valid).toBe(true);

    await visit(page, '/audit');

    // The surface's own first render is a read like any other — the trail is
    // fetched, then the walk is reported — so it is given the same patience as
    // the requests above rather than the default, for the reason stated at the
    // top of this file: a blank five seconds under a parallel run measures the
    // queue, not the chain.
    await expect(page.getByTestId('audit-report')).toHaveAttribute('data-valid', 'true', {
      timeout: PATIENCE_MS,
    });
    await expect(page.getByTestId('audit-rows')).toBeVisible({ timeout: PATIENCE_MS });
    // The count line arrives with the same payload, so it is read after the report
    // it belongs to rather than raced against it.
    await expect(page.getByTestId('audit-count')).toContainText('chain of', {
      timeout: PATIENCE_MS,
    });

    // Read off the page itself: the entries the report says it walked, and the
    // entries the chain is said to hold. They have to be the same number, because
    // a verification that walks fewer entries than the chain holds is a
    // verification that can be broken anywhere it did not look.
    const walked = countIn(await page.getByTestId('audit-report').innerText(), WALKED);
    const held = countIn(await page.getByTestId('audit-count').innerText(), CHAIN_OF);
    expect(walked).toBe(held);
    expect(held).toBeGreaterThan(0);

    // The registry is the boundary of the surface: every action the platform is
    // built to record is listed, whether or not it has fired in this process.
    const reread = await request.get('/api/audit', {
      timeout: PATIENCE_MS,
      headers: headersFor(),
    });
    const payload = (await reread.json()) as { readonly trail: TrailView };
    expect(payload.trail.registered.length).toBeGreaterThanOrEqual(8);
    for (const entry of payload.trail.registered) {
      await expect(
        page.getByRole('cell', { name: entry.action, exact: true }).first(),
      ).toBeVisible();
    }

    // And the walk can be asked for again, which is the action the phase names.
    await page.getByTestId('audit-verify').click();
    await expect(page.getByTestId('audit-report')).toHaveAttribute('data-valid', 'true', {
      timeout: PATIENCE_MS,
    });
  });

  test('records a capture a facility made, with the actor who made it', async ({
    page,
    request,
  }) => {
    const target = await captureTarget(request);
    const entryId = `e2e-audit-capture-${String(Date.now())}`;

    const submitted = await submit(
      request,
      stockEnvelope({
        facilityId: target.facilityId,
        itemId: target.itemId,
        entryId,
        key: `${entryId}-key`,
        quantity: 5,
        occurredOn: today(),
      }),
      target.session,
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body.outcome).toBe('accepted');

    const trail = await readTrail(request, '?action=capture-recorded&subject=stock_ledger_entry');
    expect(trail.trail).not.toBeNull();
    if (trail.trail === null) {
      return;
    }
    const recorded = trail.trail.rows.find((row) => row.subjectId === submitted.body.subjectKey);
    expect(recorded, 'the capture is not in the chain').toBeDefined();
    expect(recorded?.actorUid).toBe(target.session.label);
    // The pair is the projection's own on-hand figure on both sides of the write,
    // which is what makes an entry answer "from what, to what".
    expect(recorded?.before).not.toBeNull();
    expect(Number(recorded?.after)).toBe(Number(recorded?.before) + 5);

    // The clerk who recorded it is not shown the chain; the control room is.
    await visit(page, '/audit');
    await expect(page.getByTestId('audit-refusal')).toHaveCount(0);
    await expect(page.getByTestId('audit-rows')).toContainText(target.session.label, {
      timeout: PATIENCE_MS,
    });
    await expect(page.getByTestId('audit-rows')).toContainText('capture-recorded', {
      timeout: PATIENCE_MS,
    });
  });

  test('records the federated rounds a session caused, and what they spent', async ({
    page,
    request,
  }) => {
    // Opening the console is what causes the rounds, and the rounds are the one
    // consequential act no officer decides.
    const consoleRead = await request.get('/api/federation', {
      timeout: PATIENCE_MS,
      headers: headersFor(),
    });
    expect(consoleRead.ok()).toBe(true);

    const trail = await readTrail(request, '?action=federation-rounds-computed');
    expect(trail.trail).not.toBeNull();
    if (trail.trail === null) {
      return;
    }
    const round = trail.trail.rows[0];
    expect(round, 'the federated rounds are not in the chain').toBeDefined();
    expect(round?.subjectType).toBe('federation_round');
    // The rounds spend a budget, and the pair states what they left behind.
    expect(round?.before).toBeNull();
    expect(round?.after).toContain('ε');

    await visit(page, '/audit');
    await expect(page.getByTestId('audit-rows')).toContainText('federation-rounds-computed');
  });

  test('narrows the entries on request and never the verification', async ({ page, request }) => {
    const target = await captureTarget(request);
    // Two kinds of action, so "narrowed" means something. A stock correction is
    // the cheapest second kind: one write, no officer and no arithmetic, and it is
    // recorded under its own name precisely so that it can be found alone.
    await recordOneMovement(request, target, 3);
    const correctionId = `e2e-audit-correction-${String(Date.now())}`;
    const correction = await submit(request, {
      type: 'stock_ledger_entry',
      idempotencyKey: `${correctionId}-key`,
      captureSource: 'manual',
      capturedAt: new Date().toISOString(),
      observation: {
        id: correctionId,
        facilityId: target.facilityId,
        itemId: target.itemId,
        kind: 'adjust',
        quantity: 2,
        adjustmentDirection: 'decrease',
        occurredOn: today(),
        batchId: null,
        expiresOn: null,
        correctsEntryId: null,
        counterpartFacilityId: null,
        transferId: null,
      },
    });
    expect(correction.body.outcome).toBe('accepted');

    const narrowed = await readTrail(request, '?action=capture-recorded');
    expect(narrowed.trail).not.toBeNull();
    if (narrowed.trail === null) {
      return;
    }

    expect(narrowed.trail.matched).toBeGreaterThan(0);
    expect(narrowed.trail.matched).toBeLessThan(narrowed.trail.total);
    expect(narrowed.trail.rows.every((row) => row.action === 'capture-recorded')).toBe(true);
    // The claim this journey exists for, read from one payload: the walk covers
    // the whole chain even though the rows are one action. A verification over the
    // rows a reader asked for would be a chain that can be broken anywhere the
    // filter hides.
    expect(narrowed.trail.report.events).toBe(narrowed.trail.total);
    expect(narrowed.trail.report.valid).toBe(true);

    await visit(page, '/audit');
    await page.getByLabel('action', { exact: true }).selectOption('capture-recorded');
    await page.getByTestId('audit-apply').click();
    await expect(page.getByTestId('audit-count')).toContainText('matching entries');
    await expect(page.getByTestId('audit-count')).toContainText('chain of');
    await expect(page.getByTestId('audit-report')).toHaveAttribute('data-valid', 'true');

    // The page loads unfiltered and fetches again when the filter is applied, so a
    // count read straight after the click can be the *first* read's answer — where
    // `matching` and `chain of` are the same number because nothing was filtered
    // yet. Waiting for the two counts to disagree is waiting for the answer the
    // journey is about, and it is deterministic: the chain only grows, and the API
    // read above already saw an entry that is not a capture.
    await expect
      .poll(
        async () => {
          const text = await page.getByTestId('audit-count').innerText();
          return countIn(text, MATCHING) < countIn(text, CHAIN_OF);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  test('says a quiet week was quiet, rather than showing an empty page', async ({
    page,
    request,
  }) => {
    const target = await captureTarget(request);
    await recordOneMovement(request, target, 4);

    const quiet = await readTrail(request, '?from=2020-01-01&to=2020-01-02');
    expect(quiet.trail?.matched).toBe(0);
    expect(quiet.trail?.total).toBeGreaterThan(0);
    // Nothing matched, and the chain was still walked: an empty answer is not an
    // unverified one.
    expect(quiet.trail?.report.events).toBe(quiet.trail?.total);

    await visit(page, '/audit');
    await page.getByLabel('from', { exact: true }).fill('2020-01-01');
    await page.getByLabel('to', { exact: true }).fill('2020-01-02');
    await page.getByTestId('audit-apply').click();
    await expect(page.getByTestId('audit-empty')).toContainText(
      'rather than a trail that failed to load',
    );
    await expect(page.getByTestId('audit-report')).toHaveAttribute('data-valid', 'true');
  });

  test('refuses a role the chain is not shown to, in the interface and at the route', async ({
    page,
    request,
  }) => {
    const officer = (await principalsOf(request)).find(
      (principal) => principal.role === 'district_officer',
    );
    expect(officer).toBeDefined();
    if (officer === undefined) {
      return;
    }
    const session: Session = { role: officer.role, scopeId: officer.scopeId, label: officer.label };

    const refused = await readTrail(request, '', session);
    expect(refused.status).toBe(403);
    expect(refused.detail).toContain('auditor and the control room');

    await visit(page, '/audit', session);
    await expect(page.getByTestId('audit-refusal')).toBeVisible();
    await expect(page.getByTestId('audit-refusal-detail')).toContainText(officer.label);
    // A link a reader would be refused is worse than no link.
    await expect(page.getByRole('link', { name: 'Audit trail' })).toHaveCount(0);
  });
});
