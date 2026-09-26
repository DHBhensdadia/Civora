import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OBSERVATION_COLLECTIONS,
  RECEIPT_COLLECTION,
  ingestReceiptSchema,
  stockLedgerEntrySchema,
  subjectKeyOf,
} from '@civora/domain';
import { describe, expect, it } from 'vitest';

import { readAuditEvents } from './audit-service';
import {
  ImportRefused,
  acceptImport,
  previewImport,
  readAdministrativeCodes,
  readImports,
} from './import-service';
import { getLiveStore } from './live-store';
import { NATIONAL_SESSION, scopeRefusalFor } from './session';
import type { Session } from './session';

/**
 * Handing the platform a file, and what the platform then does with it.
 *
 * Each of the flow's promises is a test here, because every one of them is a
 * property a reviewer could otherwise only believe:
 *
 *  - an imported row is **a record like any other**: the ingest boundary decides
 *    it, the ledger projection takes it, and the only differences are the source
 *    it carries and the day a monthly return is dated on;
 *  - the **dry run is the same code as the import**, so a file the preview calls
 *    clean is a file the import writes and a file the preview refuses is refused
 *    before anything is written — including the rows a *scope* refuses, which are
 *    refused one row at a time and left for whoever may write them;
 *  - importing the same file twice is a **replay**: nothing written, nothing
 *    counted twice, nothing added to the chain;
 *  - the chain holds **one entry per row written** — the boundary's own entry,
 *    because an imported row is a capture — plus **one for the act of accepting
 *    the file**, naming the digest and the person.
 *
 * What each claim is asserted against is the store and the chain, not the
 * service's return value: a claim about a record that was written has to be read
 * back from where it was written.
 */

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const sampleText = (name: string): string =>
  readFileSync(resolve(WEB_ROOT, 'public', 'samples', name), 'utf8');

const HEADER = 'facility_code,month,item_code,movement,quantity,batch_no,expiry';

const statementOf = (rows: readonly (readonly string[])[]): string =>
  [HEADER, ...rows.map((row) => row.join(',')), ''].join('\n');

const issue = (
  facilityId: string,
  month: string,
  itemId: string,
  quantity: number,
): readonly string[] => [facilityId, month, itemId, 'I', String(quantity), '', ''];

const receipt = (
  facilityId: string,
  month: string,
  itemId: string,
  quantity: number,
  batchId: string,
  expiresOn: string,
): readonly string[] => [facilityId, month, itemId, 'R', String(quantity), batchId, expiresOn];

/** The refusal a call throws, asserted to be this flow's own refusal type. */
const refusalOf = async (call: Promise<unknown>): Promise<ImportRefused> => {
  const thrown = await call.then(
    () => null,
    (error: unknown) => error,
  );
  if (!(thrown instanceof ImportRefused)) {
    throw new Error(`expected an ImportRefused, read ${String(thrown)}`);
  }
  return thrown;
};

interface Fixtures {
  readonly store: Awaited<ReturnType<typeof getLiveStore>>;
  readonly inside: string;
  readonly outside: string;
  readonly itemId: string;
  readonly officer: Session;
}

/** A district officer, a facility they answer for, and one they do not. */
const fixtures = async (): Promise<Fixtures> => {
  const store = await getLiveStore();
  const itemId = store.catalogue[0]?.id;
  const officer = store.principals.find((principal) => principal.role === 'district_officer');
  if (itemId === undefined || officer?.scopeId == null) {
    throw new Error('the demonstration network has no catalogue or district officer to test with');
  }

  const facilities = store.dataset.network.facilities;
  const inside = facilities.find((facility) => facility.districtId === officer.scopeId);
  const outside = facilities.find(
    (facility) => store.scope.districtOfFacility(facility.id) !== officer.scopeId,
  );

  if (inside === undefined || outside === undefined) {
    throw new Error('the demonstration network has no facility outside a district officer’s scope');
  }

  return { store, inside: inside.id, outside: outside.id, itemId, officer };
};

describe('a statement the platform reads in full', () => {
  it('writes every row through the ingest boundary, with the source a reader can see', async () => {
    const store = await getLiveStore();
    const text = sampleText('hmis-monthly-sample.csv');
    const request = { format: 'hmis-csv', fileName: 'hmis-monthly-sample.csv', text } as const;
    const before = await readAuditEvents();

    const preview = await previewImport(NATIONAL_SESSION, request);
    expect(preview.rowsRead).toBe(6);
    expect(preview.counts).toEqual({ write: 6, alreadyHeld: 0, refused: 0 });
    // A month is written on the day by which the movement it totals had
    // certainly happened, and the preview says so rather than leaving a reader to
    // work out where the date came from.
    expect(preview.rows[0]?.detail).toBe('issue 412 on 2026-08-31');

    const accepted = await acceptImport(NATIONAL_SESSION, request);
    const digestPrefix = accepted.record.digest.slice(0, 12);
    expect(accepted.wrote).toBe(true);
    expect(accepted.record.rowsWritten).toBe(6);
    expect(accepted.record.rowsRead).toBe(6);
    expect(accepted.record.rowsRejected).toBe(0);

    // The record the platform stored: decided by the boundary, carrying the file
    // it arrived in, dated by the reader's rule rather than by the file's month.
    const observationCollection = store.provider.collection(
      OBSERVATION_COLLECTIONS.stock_ledger_entry,
      stockLedgerEntrySchema,
    );
    const facilityId = 'SIM-BIHAR-GAYA-B1-CHC-03';
    const issuedId = `import-${digestPrefix}-${facilityId}-nlem-2-1-5-paracetamol-2026-08-I`;
    // An observation is stored under its subject key — the thing two submissions
    // are about — while the identifier in the key is the row's own.
    const stored = await observationCollection.get(
      subjectKeyOf('stock_ledger_entry', { facilityId, id: issuedId }),
    );
    expect(stored?.kind).toBe('issue');
    expect(stored?.quantity).toBe(412);
    expect(stored?.captureSource).toBe('import');
    expect(stored?.occurredOn).toBe('2026-08-31');
    expect(stored?.provenance.reference).toBe(`hmis-csv:${digestPrefix}`);

    // And the receipt that makes a retry a replay rather than a second movement
    // of the same stock — the boundary's own answer, not this flow's.
    const answered = await store.provider
      .collection(RECEIPT_COLLECTION, ingestReceiptSchema)
      .get(`key-${issuedId}`); // the idempotency key the reader mints from the row
    expect(answered?.outcome).toBe('accepted');
    expect(answered?.captureSource).toBe('import');

    // Six rows written is six captures recorded, and accepting the file is one
    // entry more: the act a person performed, which no row names on its own.
    const after = await readAuditEvents();
    expect(after.length).toBe(before.length + 7);
    const appended = after.slice(before.length);
    expect(appended.slice(0, 6).map((event) => event.action)).toEqual(
      Array.from({ length: 6 }, () => 'capture-recorded'),
    );

    // The pair on the receipt row is the projection's own figure on both sides of
    // the write, so the entry says what the import moved rather than that it moved.
    const receivingId = `import-${digestPrefix}-${facilityId}-nlem-2-1-5-paracetamol-2026-08-R`;
    const receiving = appended.find(
      (event) =>
        event.subjectId === subjectKeyOf('stock_ledger_entry', { facilityId, id: receivingId }),
    );
    expect(receiving?.action).toBe('capture-recorded');
    expect(Number(receiving?.after ?? 'NaN') - Number(receiving?.before ?? 0)).toBe(900);

    const act = appended.at(-1);
    expect(act?.action).toBe('import-accepted');
    expect(act?.subjectType).toBe('import');
    expect(act?.subjectId).toBe(accepted.record.id);
    expect(act?.actorUid).toBe(NATIONAL_SESSION.label);
    expect(act?.actorRole).toBe('national');
    expect(act?.reason).toContain('hmis-monthly-sample.csv');
    expect(act?.reason).toContain(digestPrefix);
    expect(act?.before).toBeNull();
    expect(act?.after).toBe('6 entries written with source import');
  }, 120_000);

  it('imports the same file again as a replay, writing nothing and recording nothing', async () => {
    const store = await getLiveStore();
    const facilityId = store.historyFacilities[0];
    const itemId = store.catalogue[0]?.id;
    if (facilityId === undefined || itemId === undefined) {
      throw new Error('the demonstration network has no facility with history to import for');
    }

    const request = {
      format: 'hmis-csv',
      fileName: 'replay.csv',
      text: statementOf([
        issue(facilityId, '2026-07', itemId, 33),
        // A monthly return states its arrivals too, and a receipt carries the
        // batch the ledger will later draw down.
        receipt(facilityId, '2026-07', itemId, 40, 'B-REPLAY-07', '2027-05-31'),
      ]),
    } as const;

    const first = await acceptImport(NATIONAL_SESSION, request);
    expect(first.wrote).toBe(true);
    expect(first.record.rowsWritten).toBe(2);
    const chainAfterFirst = (await readAuditEvents()).length;

    const second = await acceptImport(NATIONAL_SESSION, request);
    expect(second.wrote).toBe(false);
    expect(second.auditId).toBeNull();
    expect(second.preview.counts).toEqual({ write: 0, alreadyHeld: 2, refused: 0 });

    // Nothing changed, so the chain gained nothing — and the register keeps the
    // figure the file actually wrote instead of replacing it with a zero.
    expect((await readAuditEvents()).length).toBe(chainAfterFirst);
    const registered = (await readImports()).filter(
      (record) => record.digest === first.record.digest,
    );
    expect(registered).toHaveLength(1);
    expect(registered[0]?.rowsWritten).toBe(2);
  }, 120_000);
});

describe('a file the platform will not read', () => {
  it('refuses the damaged sample at the line that cannot be read, and writes no part of it', async () => {
    const text = sampleText('hmis-monthly-broken.csv');
    const before = await readAuditEvents();
    const beforeIds = (await readImports()).map((record) => record.id);

    // The receipt on line 3 of the shipped sample names no batch and no expiry.
    // The reader stops there rather than completing the row on the facility's
    // behalf, and its sentence names the line, because the next question a
    // ministry asks is always which row.
    const checked = await refusalOf(
      previewImport(NATIONAL_SESSION, {
        format: 'hmis-csv',
        fileName: 'hmis-monthly-broken.csv',
        text,
      }),
    );
    expect(checked.status).toBe(400);
    expect(checked.message).toMatch(/line 3/);
    expect(checked.message).toMatch(/without a batch and an expiry/);

    // The same reader runs on the write path, so the file cannot be written by
    // skipping the check: what the preview refuses, the import refuses.
    const imported = await refusalOf(
      acceptImport(NATIONAL_SESSION, {
        format: 'hmis-csv',
        fileName: 'hmis-monthly-broken.csv',
        text,
      }),
    );
    expect(imported.status).toBe(400);
    expect(imported.message).toMatch(/line 3/);

    // Nothing was written and nothing was recorded: the row above the damaged
    // one was valid and readable, and it is not in the ledger either, because a
    // file this platform cannot read in full is a file whose missing rows nobody
    // could account for afterwards.
    expect((await readAuditEvents()).length).toBe(before.length);
    expect((await readImports()).map((record) => record.id)).toEqual(beforeIds);
  }, 120_000);

  it('refuses a format this surface does not read, and a session that may not import', async () => {
    const store = await getLiveStore();
    const text = statementOf([]);

    // The register's vocabulary is wider than this flow's: `nlem-json` is a
    // format a record may name and a reader this surface does not offer, so it is
    // refused by name rather than handed to the monthly statement reader.
    const format = await refusalOf(
      previewImport(NATIONAL_SESSION, { format: 'nlem-json', fileName: 'list.json', text }),
    );
    expect(format.status).toBe(415);
    expect(format.message).toContain('nlem-json');

    const staff = store.principals.find((principal) => principal.role === 'phc_staff');
    if (staff === undefined) {
      throw new Error('the demonstration network offers no facility staff to test with');
    }

    const session = await refusalOf(
      previewImport(staff, { format: 'hmis-csv', fileName: 'statement.csv', text }),
    );
    expect(session.status).toBe(403);
    expect(session.message).toContain(staff.label);
    expect(session.message).toContain('district officer and above');
  }, 120_000);
});

describe('a file whose rows a scope decides one at a time', () => {
  it('writes the rows a district officer may write, and leaves the rest for someone who may', async () => {
    const { store, inside, outside, itemId, officer } = await fixtures();

    const request = {
      format: 'hmis-csv',
      fileName: 'two-districts.csv',
      text: statementOf([
        issue(inside, '2026-06', itemId, 21),
        issue(outside, '2026-06', itemId, 22),
      ]),
    } as const;

    const preview = await previewImport(officer, request);
    expect(preview.counts).toEqual({ write: 1, alreadyHeld: 0, refused: 1 });
    expect(preview.rows.map((row) => row.outcome)).toEqual(['write', 'refused']);
    expect(preview.rows[1]?.facilityId).toBe(outside);
    // The refusal is the session's own sentence, the same one the capture surface
    // gives: an import is not a way around the tenancy model.
    expect(preview.rows[1]?.detail).toBe(scopeRefusalFor(officer, 'facility'));

    const accepted = await acceptImport(officer, request);
    expect(accepted.record.rowsWritten).toBe(1);
    expect(accepted.record.rowsRejected).toBe(1);

    const digestPrefix = accepted.record.digest.slice(0, 12);
    const observations = store.provider.collection(
      OBSERVATION_COLLECTIONS.stock_ledger_entry,
      stockLedgerEntrySchema,
    );
    const insideId = `import-${digestPrefix}-${inside}-${itemId}-2026-06-I`;
    expect(
      await observations.get(
        subjectKeyOf('stock_ledger_entry', { facilityId: inside, id: insideId }),
      ),
    ).not.toBeNull();

    // A refused row leaves nothing at all: no record and no receipt, so the file
    // can be taken by whoever does cover it, rather than being answered for ever
    // from a refusal.
    const refusedId = `import-${digestPrefix}-${outside}-${itemId}-2026-06-I`;
    const refusedKey = subjectKeyOf('stock_ledger_entry', {
      facilityId: outside,
      id: refusedId,
    });
    expect(await observations.get(refusedKey)).toBeNull();
    expect(
      await store.provider
        .collection(RECEIPT_COLLECTION, ingestReceiptSchema)
        .get(`key-${refusedId}`),
    ).toBeNull();

    // The same file read by a session that covers both districts: the row the
    // officer wrote is held, the row they could not write is written, and the
    // register's figure is the union rather than the last reader's share.
    const second = await acceptImport(NATIONAL_SESSION, request);
    expect(second.preview.counts).toEqual({ write: 1, alreadyHeld: 1, refused: 0 });
    expect(second.wrote).toBe(true);
    expect(second.record.id).toBe(accepted.record.id);
    expect(second.record.rowsWritten).toBe(2);
    expect(await observations.get(refusedKey)).not.toBeNull();
  }, 120_000);
});

describe('a file that is a directory rather than a statement', () => {
  it('joins the government’s units to the platform’s districts, and reports what did not join', async () => {
    const store = await getLiveStore();
    const districts = store.dataset.network.districts;
    const named =
      districts.find((district) => district.id === store.defaultDistrictId) ?? districts[0];
    if (named === undefined) {
      throw new Error('the demonstration network has no districts to crosswalk');
    }

    const missing = 'A district this platform does not have';
    const request = {
      format: 'lgd-json',
      fileName: 'lgd-districts-2026-09.json',
      text: JSON.stringify({
        sourceId: 'lgd-demo-2026-09',
        title: 'Local Government Directory — districts and sub-districts',
        retrievedOn: '2026-09-01',
        units: [
          {
            stateCode: '10',
            stateName: 'Bihar',
            districtCode: '201',
            districtName: named.name,
            subdistrictCode: '2011',
            subdistrictName: 'Block one',
          },
          {
            stateCode: '10',
            stateName: 'Bihar',
            districtCode: '299',
            districtName: missing,
            subdistrictCode: '2991',
            subdistrictName: 'Block two',
          },
        ],
      }),
    } as const;

    const before = await readAuditEvents();
    const preview = await previewImport(NATIONAL_SESSION, request);
    expect(preview.crosswalk?.matched).toBe(preview.rows.length);
    expect(preview.rows.map((row) => row.subjectId)).toContain(named.id);
    // Every district is either given a code or named as unmatched. A crosswalk
    // that covered some districts silently is one that gets discovered at a
    // reporting deadline, which is what the both-directions report prevents.
    expect(
      (preview.crosswalk?.matched ?? 0) + (preview.crosswalk?.unmatchedPlatform.length ?? 0),
    ).toBe(districts.length);
    expect(preview.crosswalk?.unmatchedGovernment).toEqual([`Bihar · ${missing}`]);
    expect(preview.notes.join(' ')).toContain('writes no ledger entries');

    const accepted = await acceptImport(NATIONAL_SESSION, request);
    expect(accepted.record.rowsWritten).toBe(0);

    const stored = (await readAdministrativeCodes()).find(
      (entry) => entry.id === `codes-${accepted.record.digest.slice(0, 12)}`,
    );
    expect(stored?.retrievedOn).toBe('2026-09-01');
    expect(stored?.codes.find((entry) => entry.districtId === named.id)?.districtCode).toBe('201');
    expect(stored?.unmatchedGovernment).toEqual([`Bihar · ${missing}`]);

    // One acceptance, one entry: the codes went nowhere near the ledger, so the
    // act is the only thing that changed.
    const after = await readAuditEvents();
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)?.action).toBe('import-accepted');
    expect(after.at(-1)?.subjectType).toBe('import');
    expect(after.at(-1)?.after).toContain('district(s) given a government code');

    const registered = (await readImports()).find((record) => record.id === accepted.record.id);
    expect(registered?.format).toBe('lgd-json');
    expect(registered?.sourceId).toBe('lgd-demo-2026-09');
    expect(registered?.retrievedOn).toBe('2026-09-01');
  }, 120_000);

  it('refuses a directory whose state code is not two digits, naming the field', async () => {
    const refusal = await refusalOf(
      previewImport(NATIONAL_SESSION, {
        format: 'lgd-json',
        fileName: 'lgd-one-digit.json',
        text: JSON.stringify({
          sourceId: 'lgd-demo',
          title: 'Directory',
          retrievedOn: '2026-09-01',
          units: [
            {
              stateCode: '9',
              stateName: 'Bihar',
              districtCode: '201',
              districtName: 'Gaya',
              subdistrictCode: '2011',
              subdistrictName: 'Block one',
            },
          ],
        }),
      }),
    );

    // A code kept as text is what keeps a leading zero alive, so the reader
    // insists on the width rather than coercing a number into one.
    expect(refusal.status).toBe(400);
    expect(refusal.message).toContain('units.0.stateCode');
    expect(refusal.message).toContain('two digits');
  }, 120_000);
});
