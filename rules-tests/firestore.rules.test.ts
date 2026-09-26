import { readFileSync } from 'node:fs';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The tenancy model, tested against the rules the way a deployment runs them.
 *
 * The rules in `infra/firestore.rules` are the second enforcement of the role
 * model, and the reason this file exists is the sentence a reviewer should be
 * able to check: **a rule with no negative test is a comment.** So every case
 * below appears twice — once as the access a role is meant to have, once as the
 * neighbouring access it must not. A suite that only tested the positive cases
 * would pass against `allow read, write: if true`, which is why the matrix is
 * built from both directions.
 *
 * It runs against the Firestore emulator (`pnpm test:rules` starts it), so it
 * needs no credentials and no network. `initializeTestEnvironment` reads
 * `FIRESTORE_EMULATOR_HOST`; running this file under a bare `vitest` without the
 * emulator is refused by name rather than attempted against a real project.
 */

const rules = readFileSync(new URL('../infra/firestore.rules', import.meta.url), 'utf8');

/**
 * The world the matrix is read through.
 *
 * Two regions, four districts, four facilities: enough that "own district",
 * "own region" and "neither" are three different answers for the same read.
 *
 *   R1 ─ D1 ─ F1   (the district officer's and the facility worker's own)
 *      └ D2 ─ F2
 *   R2 ─ D3 ─ F3
 *      └ D4 ─ F4
 */
const FACILITIES: Readonly<Record<string, string>> = {
  F1: 'D1',
  F2: 'D2',
  F3: 'D3',
  F4: 'D4',
};

const REGIONS: Readonly<Record<string, string>> = {
  D1: 'R1',
  D2: 'R1',
  D3: 'R2',
  D4: 'R2',
};

const facilityDoc = (id: string): Record<string, unknown> => ({
  id,
  districtId: FACILITIES[id],
  regionId: REGIONS[FACILITIES[id] ?? ''],
});

const observationDoc = (facilityId: string): Record<string, unknown> => ({
  id: `ledger-${facilityId}`,
  facilityId,
});

const alertDoc = (facilityId: string): Record<string, unknown> => ({
  id: `alert-${facilityId}`,
  facilityId,
  itemId: 'item-1',
  state: 'raised',
});

const proposalDoc = (from: string, to: string): Record<string, unknown> => ({
  id: `proposal-${from}-${to}`,
  fromFacilityId: from,
  toFacilityId: to,
  state: 'proposed',
});

let environment: RulesTestEnvironment;

beforeAll(async () => {
  if (
    process.env.FIRESTORE_EMULATOR_HOST === undefined ||
    process.env.FIRESTORE_EMULATOR_HOST === ''
  ) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is not set: run this suite through `pnpm test:rules`, which starts the emulator, rather than against a real project',
    );
  }
  environment = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? 'demo-civora-rules',
    firestore: { rules },
  });
});

afterAll(async () => {
  await environment.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const id of Object.keys(FACILITIES)) {
      await setDoc(doc(db, `facilities/${id}`), facilityDoc(id));
    }
    for (const id of Object.keys(FACILITIES)) {
      await setDoc(doc(db, `stockLedgerEntries/ledger-${id}`), observationDoc(id));
      await setDoc(doc(db, `forecasts/forecast-${id}`), observationDoc(id));
      await setDoc(doc(db, `alerts/alert-${id}`), alertDoc(id));
    }
    await setDoc(doc(db, 'transferProposals/proposal-F1-F2'), proposalDoc('F1', 'F2'));
    await setDoc(doc(db, 'transferProposals/proposal-F3-F4'), proposalDoc('F3', 'F4'));
    await setDoc(doc(db, 'auditEvents/audit-000001'), {
      id: 'audit-000001',
      action: 'transfer.approved',
    });
  });
});

type Claims = Record<string, string>;

const as = (claims: Claims) =>
  environment.authenticatedContext(`uid-${JSON.stringify(claims)}`, claims).firestore();

const staff = () => as({ role: 'phc_staff', scopeId: 'F1' });
const district = () => as({ role: 'district_officer', scopeId: 'D1' });
const state = () => as({ role: 'state_officer', scopeId: 'R1' });
const national = () => as({ role: 'national' });
const auditor = () => as({ role: 'auditor' });
const anonymous = () => environment.unauthenticatedContext().firestore();

describe('unauthenticated', () => {
  it('is refused even the reference data the platform renders from', async () => {
    await assertFails(getDoc(doc(anonymous(), 'facilities/F1')));
  });

  it('is refused a write anywhere', async () => {
    await assertFails(setDoc(doc(anonymous(), 'alerts/alert-F1'), alertDoc('F1')));
  });
});

describe('phc_staff — its own facility, and nothing beside it', () => {
  it('reads what its own facility recorded', async () => {
    const snapshot = await assertSucceeds(getDoc(doc(staff(), 'stockLedgerEntries/ledger-F1')));
    expect(snapshot.data()?.facilityId).toBe('F1');
  });

  it('is refused the facility next door', async () => {
    await assertFails(getDoc(doc(staff(), 'stockLedgerEntries/ledger-F2')));
  });

  it('is refused a facility in another region', async () => {
    await assertFails(getDoc(doc(staff(), 'stockLedgerEntries/ledger-F3')));
  });

  it('moves its own facility’s alert', async () => {
    await assertSucceeds(
      setDoc(doc(staff(), 'alerts/alert-F1'), { ...alertDoc('F1'), state: 'acknowledged' }),
    );
  });

  it('is refused the neighbouring facility’s alert — the write this model exists to stop', async () => {
    await assertFails(
      setDoc(doc(staff(), 'alerts/alert-F2'), { ...alertDoc('F2'), state: 'acknowledged' }),
    );
  });

  it('is refused the redistribution workbench entirely', async () => {
    await assertFails(getDoc(doc(staff(), 'transferProposals/proposal-F1-F2')));
  });
});

describe('district_officer — one district', () => {
  it('reads its district and is refused the next one', async () => {
    await assertSucceeds(getDoc(doc(district(), 'stockLedgerEntries/ledger-F1')));
    await assertFails(getDoc(doc(district(), 'stockLedgerEntries/ledger-F2')));
  });

  it('reads the conclusions about its own district, and not another’s', async () => {
    await assertSucceeds(getDoc(doc(district(), 'forecasts/forecast-F1')));
    await assertFails(getDoc(doc(district(), 'forecasts/forecast-F3')));
  });

  it('writes an alert at its own facility and is refused one outside', async () => {
    await assertSucceeds(
      setDoc(doc(district(), 'alerts/alert-F1'), { ...alertDoc('F1'), state: 'escalated' }),
    );
    await assertFails(
      setDoc(doc(district(), 'alerts/alert-F2'), { ...alertDoc('F2'), state: 'escalated' }),
    );
  });

  it('sees a transfer that touches its district', async () => {
    await assertSucceeds(getDoc(doc(district(), 'transferProposals/proposal-F1-F2')));
  });

  it('is refused a transfer between two other districts', async () => {
    await assertFails(getDoc(doc(district(), 'transferProposals/proposal-F3-F4')));
  });

  it('is refused a decision on a transfer outside its district', async () => {
    await assertFails(
      setDoc(doc(district(), 'transferProposals/proposal-F3-F4'), {
        ...proposalDoc('F3', 'F4'),
        state: 'approved',
      }),
    );
  });

  it('is refused the audit chain — it spans every district', async () => {
    await assertFails(getDoc(doc(district(), 'auditEvents/audit-000001')));
  });
});

describe('state_officer — one state', () => {
  it('reads both its districts and is refused the neighbouring state', async () => {
    await assertSucceeds(getDoc(doc(state(), 'stockLedgerEntries/ledger-F1')));
    await assertSucceeds(getDoc(doc(state(), 'stockLedgerEntries/ledger-F2')));
    await assertFails(getDoc(doc(state(), 'stockLedgerEntries/ledger-F3')));
  });

  it('writes inside its state and is refused outside it', async () => {
    await assertSucceeds(
      setDoc(doc(state(), 'alerts/alert-F2'), { ...alertDoc('F2'), state: 'acknowledged' }),
    );
    await assertFails(
      setDoc(doc(state(), 'alerts/alert-F3'), { ...alertDoc('F3'), state: 'acknowledged' }),
    );
  });

  it('sees a transfer with an endpoint in its state and is refused one without', async () => {
    await assertSucceeds(getDoc(doc(state(), 'transferProposals/proposal-F1-F2')));
    await assertFails(getDoc(doc(state(), 'transferProposals/proposal-F3-F4')));
  });
});

describe('national — the control room', () => {
  it('reads and writes across the country', async () => {
    await assertSucceeds(getDoc(doc(national(), 'stockLedgerEntries/ledger-F3')));
    await assertSucceeds(
      setDoc(doc(national(), 'alerts/alert-F3'), { ...alertDoc('F3'), state: 'resolved' }),
    );
    await assertSucceeds(
      setDoc(doc(national(), 'transferProposals/proposal-F3-F4'), {
        ...proposalDoc('F3', 'F4'),
        state: 'approved',
      }),
    );
  });

  it('reads the audit chain', async () => {
    await assertSucceeds(getDoc(doc(national(), 'auditEvents/audit-000001')));
  });

  it('cannot append to the chain from a client — the server is the only writer', async () => {
    await assertFails(setDoc(doc(national(), 'auditEvents/audit-000002'), { id: 'audit-000002' }));
  });

  it('cannot write what the platform records — captures are not a client write', async () => {
    await assertFails(
      setDoc(doc(national(), 'stockLedgerEntries/ledger-F1'), observationDoc('F1')),
    );
  });
});

describe('auditor — reads everything, writes nothing', () => {
  it('reads the chain and the country', async () => {
    await assertSucceeds(getDoc(doc(auditor(), 'auditEvents/audit-000001')));
    await assertSucceeds(getDoc(doc(auditor(), 'stockLedgerEntries/ledger-F3')));
  });

  it('is refused every write a person could attempt', async () => {
    await assertFails(
      setDoc(doc(auditor(), 'alerts/alert-F1'), { ...alertDoc('F1'), state: 'acknowledged' }),
    );
    await assertFails(
      setDoc(doc(auditor(), 'transferProposals/proposal-F1-F2'), {
        ...proposalDoc('F1', 'F2'),
        state: 'approved',
      }),
    );
  });
});

describe('a document whose facility cannot be verified', () => {
  it('is closed rather than open', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'stockLedgerEntries/ledger-unknown'), observationDoc('F-MISSING'));
    });

    // The scope cannot be resolved, so the read is denied. A rule that failed open
    // on a missing lookup would hand out every document whose scope was deleted.
    await assertFails(getDoc(doc(district(), 'stockLedgerEntries/ledger-unknown')));
  });
});
