import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

import { readVisibility, sessionCookie } from './support';
import type { FacilityView, Session } from './support';

/**
 * Reading a file a ministry already has, asserted through the surface that
 * reads it.
 *
 * The claims are the phase's own, and each is asserted where a person can check
 * it rather than against the flow's return value:
 *
 *  - a file that cannot be read is **refused in the dry run**, with the line it
 *    stopped at, and **nothing is accepted** — no register entry, no ledger row;
 *  - a real-shaped monthly statement goes **through the interface**, and its rows
 *    arrive carrying `source: import`, visible on the record surface beside the
 *    movements a nurse typed;
 *  - the **chain records the act**: one entry for accepting the file, naming the
 *    digest and the officer, on top of the one entry per row the boundary writes;
 *  - importing the same file again is a **replay** — every row already held, and
 *    the register still says what the file wrote the first time;
 *  - a role that may not import is **refused in a sentence**, in the interface and
 *    at the route, and is offered no link to the surface.
 *
 * Two things about this file are deliberate, and both come from sharing one
 * server with every other journey:
 *
 *  - **It writes into a district of its own.** The import dates a monthly total on
 *    the last day of the month it states, so its rows sit at the top of a record
 *    surface — and a journey that did that to a facility another spec asserts on
 *    would be moving that spec's figures. The district officer it signs in as is
 *    therefore one whose district the other journeys do not read.
 *  - **Its quantities are its own**, minted per execution, and no assertion is an
 *    absolute count: the `captureSource: import` movements it reads back are
 *    filtered to the three rows it wrote, which is the claim that survives a
 *    neighbouring spec having written something of its own.
 */

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  test.setTimeout(120_000);
});

/** How long a request may wait while another surface holds the server's thread. */
const PATIENCE_MS = 60_000;

/** The district another journey's figures are read from, left alone here. */
const OTHER_SPEC_DISTRICT = 'Gaya';

/** Months the reader accepts; the last day of this one is after the seeded history. */
const MONTH = '2026-09';

interface Principal extends Session {
  readonly id: string;
  readonly place: string;
}

interface ImportRecordView {
  readonly id: string;
  readonly format: string;
  readonly fileName: string;
  readonly digest: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly rowsAlreadyHeld: number;
  readonly rowsRejected: number;
  readonly actorUid: string;
}

const headersFor = (session?: Session): Record<string, string> => ({
  // A fresh connection per request: Node closes an idle keep-alive socket, and a
  // journey that has waited on another surface will reuse a socket the server has
  // already closed.
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

const officerIn = async (request: APIRequestContext, skip: string): Promise<Principal> => {
  const officers = (await principalsOf(request)).filter(
    (principal) => principal.role === 'district_officer' && !principal.label.includes(skip),
  );
  const officer = officers[0];
  expect(
    officer,
    'the demonstration offers no district officer outside the other spec’s district',
  ).toBeDefined();
  if (officer === undefined) {
    throw new Error('no district officer to import as');
  }
  return officer;
};

const asSession = (principal: Principal): Session => ({
  role: principal.role,
  scopeId: principal.scopeId,
  label: principal.label,
});

interface ImportAnswer {
  readonly status: number;
  readonly body: {
    readonly outcome?: string;
    readonly detail?: string;
    readonly preview?: {
      readonly digest: string;
      readonly rowsRead: number;
      readonly counts: {
        readonly write: number;
        readonly alreadyHeld: number;
        readonly refused: number;
      };
      readonly crosswalk: { readonly matched: number } | null;
    };
    readonly record?: ImportRecordView;
    readonly wrote?: boolean;
    readonly auditId?: string | null;
    readonly imports?: readonly ImportRecordView[];
  };
}

const postFile = async (
  request: APIRequestContext,
  method: 'POST' | 'PUT',
  file: { readonly fileName: string; readonly text: string; readonly format?: string },
  session?: Session,
): Promise<ImportAnswer> => {
  const response = await request.fetch('/api/import', {
    method,
    timeout: PATIENCE_MS,
    data: { format: file.format ?? 'hmis-csv', fileName: file.fileName, text: file.text },
    headers: headersFor(session),
  });
  return { status: response.status(), body: (await response.json()) as ImportAnswer['body'] };
};

const readImports = async (
  request: APIRequestContext,
  session?: Session,
): Promise<ImportAnswer> => {
  const response = await request.get('/api/import', {
    timeout: PATIENCE_MS,
    headers: headersFor(session),
  });
  return { status: response.status(), body: (await response.json()) as ImportAnswer['body'] };
};

interface TrailRow {
  readonly action: string;
  readonly actorUid: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly reason: string | null;
  readonly before: string | null;
  readonly after: string | null;
}

const readTrail = async (
  request: APIRequestContext,
  query: string,
): Promise<readonly TrailRow[]> => {
  const response = await request.get(`/api/audit${query}`, {
    timeout: PATIENCE_MS,
    headers: headersFor(),
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    readonly trail: { readonly rows: readonly TrailRow[] };
  };
  return body.trail.rows;
};

const facilityReading = async (
  request: APIRequestContext,
  districtId: string,
  facilityId: string,
): Promise<FacilityView['reading']> => {
  const payload = await readVisibility(request, { districtId });
  const facility = payload.facilities.find((candidate) => candidate.id === facilityId);
  expect(facility, 'the district officer’s district sites no such facility').toBeDefined();
  if (facility === undefined) {
    throw new Error('no facility to read back');
  }
  return facility.reading;
};

const visit = async (page: Page, path: string, session: Session): Promise<void> => {
  // Set by domain rather than by URL, so the journey does not repeat the port the
  // server happens to be running on.
  await page.context().addCookies([
    {
      name: 'civora-session',
      value: encodeURIComponent(JSON.stringify(session)),
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto(path, { timeout: PATIENCE_MS });
};

/** One line of a monthly return, in the shape a ministry's extract takes. */
const statementRow = (
  facilityId: string,
  itemId: string,
  movement: 'I' | 'R',
  quantity: number,
  batchId = '',
  expiresOn = '',
): string => [facilityId, MONTH, itemId, movement, String(quantity), batchId, expiresOn].join(',');

let officer: Principal;
let districtId: string;
let facilityId: string;
let fileText: string;
let fileName: string;
let quantities: readonly number[];

test.describe('a file from a system the ministry already runs', () => {
  test('refuses the damaged statement in the check, naming the line, and accepts nothing', async ({
    page,
    request,
  }) => {
    officer = await officerIn(request, OTHER_SPEC_DISTRICT);
    await visit(page, '/import', asSession(officer));

    // The shipped damaged sample: the same monthly statement with a receipt that
    // names no batch and no expiry, which is the ordinary way one of these files
    // arrives broken.
    await page.getByTestId('import-broken').click();
    await expect(page.getByTestId('import-text')).toHaveValue(/SIM-BIHAR-GAYA-B1-CHC-03/);
    await page.getByTestId('import-check').click();

    await expect(page.getByTestId('import-refusal')).toBeVisible();
    await expect(page.getByTestId('import-refusal-detail')).toContainText('line 3');
    await expect(page.getByTestId('import-refusal-detail')).toContainText(
      'without a batch and an expiry',
    );

    // A refused file is not a file the platform half-took: nothing is in the
    // register, and the route refuses the same text rather than reading it again.
    await expect(page.getByTestId('import-register-empty')).toBeVisible();
    const refused = await postFile(
      request,
      'PUT',
      {
        fileName: 'hmis-monthly-broken.csv',
        text: await page.getByTestId('import-text').inputValue(),
      },
      asSession(officer),
    );
    expect(refused.status).toBe(400);
    expect(refused.body.detail).toContain('line 3');
    expect((await readImports(request, asSession(officer))).body.imports ?? []).toHaveLength(0);
  });

  test('checks a monthly statement, accepts it, and the rows arrive carrying the import source', async ({
    page,
    request,
  }) => {
    const session = asSession(officer);
    districtId = officer.scopeId ?? '';
    expect(districtId).not.toBe('');

    const catalogue = await request.get('/api/catalogue', {
      timeout: PATIENCE_MS,
      headers: headersFor(),
    });
    const items = (await catalogue.json()) as { readonly items: readonly { id: string }[] };
    expect(items.items.length).toBeGreaterThan(1);
    const [first, second] = items.items;
    if (first === undefined || second === undefined) {
      throw new Error('the catalogue is too small to import against');
    }

    // The facility the file is about: the district's community health centre, read
    // from the platform's own visibility read rather than named here.
    const payload = await readVisibility(request, { districtId });
    const facility =
      payload.facilities.find((candidate) => candidate.tier === 'CHC') ?? payload.facilities[0];
    expect(facility, 'the district officer’s district sites no facility').toBeDefined();
    if (facility === undefined) {
      throw new Error('no facility to import into');
    }
    facilityId = facility.id;

    // This execution's own quantities, so a neighbouring journey's movements are
    // not read as this one's.
    const stamp = Date.now();
    quantities = [(stamp % 900) + 100, ((stamp + 7) % 900) + 50, ((stamp + 13) % 900) + 20];
    const [issued, received, issuedB] = quantities as [number, number, number];
    fileName = `hmis-2026-09-${String(stamp)}.csv`;
    fileText = [
      'facility_code,month,item_code,movement,quantity,batch_no,expiry',
      statementRow(facilityId, first.id, 'I', issued),
      statementRow(
        facilityId,
        first.id,
        'R',
        received,
        `e2e-import-${String(stamp)}`,
        '2027-12-31',
      ),
      statementRow(facilityId, second.id, 'I', issuedB),
      '',
    ].join('\n');

    await visit(page, '/import', session);
    await page.getByTestId('import-text').fill(fileText);
    await page.getByLabel('file name').fill(fileName);
    await page.getByTestId('import-check').click();

    // The check names every row and what the platform would do with it — and it
    // wrote nothing: the register is empty and no movement of this file is in the
    // ledger.
    await expect(page.getByTestId('import-rows')).toBeVisible();
    await expect(page.getByTestId('import-rows')).toContainText('would be written');
    const afterCheck = await facilityReading(request, districtId, facilityId);
    expect(
      afterCheck.recentMovements.filter((movement) => movement.captureSource === 'import'),
    ).toHaveLength(0);

    await page.getByTestId('import-accept').click();
    await expect(page.getByTestId('import-accepted')).toBeVisible();
    await expect(page.getByTestId('import-accepted-detail')).toContainText('3 written');
    await expect(page.getByTestId('import-register')).toContainText(fileName);

    // The register, read from the same route the panel read: the file, its digest
    // and what it wrote, which is what lets a ledger row be traced to its file.
    const registered = await readImports(request, session);
    expect(registered.status).toBe(200);
    const record = (registered.body.imports ?? []).find((entry) => entry.fileName === fileName);
    expect(record, 'the accepted file is not in the register').toBeDefined();
    if (record === undefined) {
      return;
    }
    expect(record.format).toBe('hmis-csv');
    expect(record.rowsRead).toBe(3);
    expect(record.rowsWritten).toBe(3);
    expect(record.actorUid).toBe(officer.label);

    // The records themselves: three movements carrying `import`, newest first
    // because a monthly total is dated on the last day of its month.
    const reading = await facilityReading(request, districtId, facilityId);
    const mine = reading.recentMovements.filter((movement) => movement.captureSource === 'import');
    expect(mine.map((movement) => movement.quantity).sort((left, right) => left - right)).toEqual(
      [...quantities].sort((left, right) => left - right),
    );
    expect(
      reading.recentMovements.slice(0, 3).every((movement) => movement.captureSource === 'import'),
    ).toBe(true);
    // An imported record is not a second class of record: the ledger's own
    // projection took it, so the facility's on-hand figure moved by the receipt.
    expect(reading.stock?.itemsTracked ?? 0).toBeGreaterThan(0);

    // The act is on the chain, beside the one entry the boundary writes per row.
    const acts = await readTrail(request, '?action=import-accepted');
    const act = acts.find((row) => row.subjectId === record.id);
    expect(act, 'the accepted file is not in the chain').toBeDefined();
    expect(act?.subjectType).toBe('import');
    expect(act?.actorUid).toBe(officer.label);
    expect(act?.reason).toContain(fileName);
    expect(act?.reason).toContain(record.digest.slice(0, 12));
    expect(act?.before).toBeNull();
    expect(act?.after).toContain('written with source import');

    const captured = await readTrail(request, '?action=capture-recorded');
    expect(captured.filter((row) => row.actorUid === officer.label).length).toBeGreaterThanOrEqual(
      3,
    );

    // And the badge a person sees, on the record surface: the movement list of the
    // officer's own district, where these rows are the newest.
    await visit(page, '/visibility', session);
    await expect(page.getByTestId('movement-list')).toContainText('Imported · import');
  });

  test('imports the same file again as a replay, and the register keeps what it wrote', async ({
    page,
    request,
  }) => {
    const session = asSession(officer);
    await visit(page, '/import', session);
    await page.getByTestId('import-text').fill(fileText);
    await page.getByLabel('file name').fill(fileName);
    await page.getByTestId('import-check').click();

    // Every row is answered rather than written twice, and the check says which.
    await expect(page.getByTestId('import-rows')).toContainText('already held');
    await expect(page.getByTestId('import-rows')).not.toContainText('would be written');

    await page.getByTestId('import-accept').click();
    await expect(page.getByTestId('import-accepted')).toContainText('Nothing changed');

    // One register entry for the file, still carrying what the first acceptance
    // wrote — a replay is not evidence that the file wrote nothing.
    const registered = await readImports(request, session);
    const matching = (registered.body.imports ?? []).filter((entry) => entry.fileName === fileName);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.rowsWritten).toBe(3);

    const reading = await facilityReading(request, districtId, facilityId);
    expect(
      reading.recentMovements.filter((movement) => movement.captureSource === 'import'),
    ).toHaveLength(3);
  });

  test('refuses a role that may not import, in the interface and at the route', async ({
    page,
    request,
  }) => {
    const staff = (await principalsOf(request)).find(
      (principal) => principal.role === 'phc_staff' && principal.scopeId !== null,
    );
    expect(staff).toBeDefined();
    if (staff === undefined) {
      return;
    }
    const session = asSession(staff);

    const listed = await readImports(request, session);
    expect(listed.status).toBe(403);
    expect(listed.body.detail).toContain(staff.label);
    expect(listed.body.detail).toContain('district officer and above');

    const refused = await postFile(
      request,
      'POST',
      { fileName: 'statement.csv', text: fileText },
      session,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('district officer and above');

    await visit(page, '/import', session);
    await page.getByTestId('import-text').fill(fileText);
    await page.getByTestId('import-check').click();
    await expect(page.getByTestId('import-refusal-detail')).toContainText(staff.label);
    // A surface a reader would be refused is worse than no surface.
    const navigation = page.getByRole('navigation', { name: 'Platform sections' });
    await expect(navigation.getByRole('link', { name: 'Import' })).toHaveCount(0);
  });
});
