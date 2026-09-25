import { expect, test } from '@playwright/test';

import {
  bedEnvelope,
  districtIdNamed,
  facilityOfTier,
  postIngest,
  readCatalogue,
  readVisibility,
  sessionCookie,
  stockEnvelope,
  today,
} from './support';

/**
 * The ingest boundary, asserted against a running platform.
 *
 * These are the claims the offline story rests on, and every one of them is
 * about a second delivery of something: the platform is required to survive
 * being told the same thing twice, because that is what an outbox on a bad
 * connection does, and a health platform that double-counts a receipt has
 * invented stock.
 *
 * The tests act on their own district and their own identifiers, so they can run
 * beside the other journeys against one shared server.
 */

const DISTRICT = 'Chennai';

test.describe('the ingest boundary', () => {
  test('answers a retry with the first answer and stores nothing twice', async ({ request }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'CHC');
    const [item] = await readCatalogue(request);
    expect(item).toBeDefined();

    const entryId = `e2e-retry-${String(Date.now())}`;
    const envelope = stockEnvelope({
      facilityId: facility.id,
      itemId: item!.id,
      entryId,
      key: `${entryId}-key`,
      quantity: 12,
      occurredOn: today(),
    });

    const first = await postIngest(request, envelope);
    expect(first.status).toBe(200);
    expect(first.body.outcome).toBe('accepted');

    // The same key, submitted again: the retry an outbox makes when it cannot
    // tell whether the first attempt landed.
    const retry = await postIngest(request, envelope);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('replayed');
    expect(retry.body.detail).toContain('already processed');

    // The same observation under a new key: agreeing twice is not disagreeing.
    const duplicate = await postIngest(request, {
      ...(envelope as Record<string, unknown>),
      idempotencyKey: `${entryId}-key-2`,
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.outcome).toBe('duplicate');

    // One delivery reached the ledger, however many times it was sent.
    const payload = await readVisibility(request, { districtId });
    const stored = payload.facilities.find((candidate) => candidate.id === facility.id);
    expect(stored?.reading.recentMovements.filter((each) => each.id === entryId)).toHaveLength(1);
  });

  test('refuses a submission that disagrees with the stored record, and says how', async ({
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'CHC');
    const [item] = await readCatalogue(request);

    const entryId = `e2e-conflict-${String(Date.now())}`;
    const first = await postIngest(
      request,
      stockEnvelope({
        facilityId: facility.id,
        itemId: item!.id,
        entryId,
        key: `${entryId}-key`,
        quantity: 20,
        occurredOn: today(),
      }),
    );
    expect(first.body.outcome).toBe('accepted');

    const divergent = await postIngest(
      request,
      stockEnvelope({
        facilityId: facility.id,
        itemId: item!.id,
        entryId,
        key: `${entryId}-key-2`,
        quantity: 55,
        occurredOn: today(),
      }),
    );

    expect(divergent.status).toBe(409);
    expect(divergent.body.outcome).toBe('conflict');
    expect(divergent.body.conflict?.differences).toEqual([
      { field: 'quantity', stored: '20', submitted: '55' },
    ]);

    // The stored record stood: a reported observation is evidence, and evidence
    // that changes silently is not evidence.
    const payload = await readVisibility(request, { districtId });
    const stored = payload.facilities.find((candidate) => candidate.id === facility.id);
    expect(stored?.reading.recentMovements.filter((each) => each.id === entryId)).toHaveLength(1);
  });

  test('refuses a capture from a device whose clock is ahead of the platform', async ({
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'CHC');
    const id = `e2e-clock-${String(Date.now())}`;

    const refused = await postIngest(
      request,
      stockEnvelope({
        facilityId: facility.id,
        itemId: (await readCatalogue(request))[0]!.id,
        entryId: id,
        key: `${id}-key`,
        quantity: 5,
        occurredOn: today(),
        capturedAt: '2099-01-01T00:00:00.000Z',
      }),
    );

    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe('implausible-capture-time');
    expect(refused.body.detail).toContain('device clock');
  });

  test('refuses a capture for a facility outside the session, and allows one inside it', async ({
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const own = await facilityOfTier(request, districtId, 'PHC');
    const elsewhere = await facilityOfTier(request, await districtIdNamed(request, 'Gaya'), 'PHC');

    const session = {
      role: 'phc_staff',
      scopeId: own.id,
      label: `Facility staff — ${own.name}`,
    };
    const id = `e2e-scope-${String(Date.now())}`;

    const outside = await postIngest(
      request,
      bedEnvelope({
        facilityId: elsewhere.id,
        key: `${id}-outside`,
        observedOn: today(),
        bedsTotal: 6,
        bedsOccupied: 4,
      }),
      session,
    );
    expect(outside.status).toBe(403);
    expect(outside.body.reason).toBe('out-of-scope');

    const inside = await postIngest(
      request,
      bedEnvelope({
        facilityId: own.id,
        key: `${id}-inside`,
        observedOn: today(),
        bedsTotal: 6,
        bedsOccupied: 3,
      }),
      session,
    );
    expect(inside.status).toBe(200);
    expect(inside.body.outcome).toBe('accepted');

    const payload = await readVisibility(request, { districtId, session });
    const stored = payload.facilities.find((candidate) => candidate.id === own.id);
    expect(stored?.reading.beds).toEqual({
      observedOn: today(),
      total: 6,
      occupied: 3,
      occupancy: 0.5,
    });
  });

  test('refuses a read of a district outside the session, and lists only the districts inside it', async ({
    request,
  }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const session = {
      role: 'district_officer',
      scopeId: districtId,
      label: 'District officer — Chennai',
    };

    const outside = await request.get('/api/visibility?districtId=SIM-BIHAR-GAYA', {
      headers: { cookie: sessionCookie(session) },
    });
    expect(outside.status()).toBe(403);

    const inside = await readVisibility(request, { session });
    expect(inside.district.id).toBe(districtId);
    // A list is disclosure, so the overview is scoped as well as the read.
    expect(inside.districts.map((district) => district.id)).toEqual([districtId]);
  });

  test('refuses a write from a session that may only read', async ({ request }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');

    const refused = await postIngest(
      request,
      bedEnvelope({
        facilityId: facility.id,
        key: `e2e-auditor-${String(Date.now())}`,
        observedOn: today(),
        bedsTotal: 6,
        bedsOccupied: 1,
      }),
      { role: 'auditor', scopeId: null, label: 'Auditor' },
    );

    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('does not write');
  });

  test('refuses a submission that does not match the contract it declared', async ({ request }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');

    const refused = await postIngest(request, {
      type: 'bed_status',
      idempotencyKey: `e2e-invalid-${String(Date.now())}`,
      captureSource: 'manual',
      capturedAt: new Date().toISOString(),
      // Occupied beds above the beds reported: the schema refuses it, and the
      // platform reports which field is wrong rather than that the payload is.
      observation: {
        facilityId: facility.id,
        observedOn: today(),
        bedsTotal: 4,
        bedsOccupied: 9,
      },
    });

    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe('invalid-observation');
  });

  test('refuses an upload that claims to be simulated', async ({ request }) => {
    const districtId = await districtIdNamed(request, DISTRICT);
    const facility = await facilityOfTier(request, districtId, 'PHC');

    // A client that could label its own records as generated could have them
    // discarded; one that could label them real could have them believed.
    const refused = await postIngest(request, {
      type: 'bed_status',
      idempotencyKey: `e2e-source-${String(Date.now())}`,
      captureSource: 'simulation',
      capturedAt: new Date().toISOString(),
      observation: {
        facilityId: facility.id,
        observedOn: today(),
        bedsTotal: 4,
        bedsOccupied: 2,
      },
    });

    expect(refused.status).toBe(400);
  });
});
