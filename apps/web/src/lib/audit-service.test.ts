import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLATFORM_STAMP,
  auditEventSchema,
  completeSubmission,
  ingestRequestSchema,
} from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_COLLECTION,
  CONSEQUENTIAL_ACTIONS,
  actorOf,
  readAuditEvents,
  recordAuditEvent,
  verifyAuditChain,
} from './audit-service';
import { applySubmission } from './ingest-boundary';
import { AlertRefused, moveAlert, readIntelligence } from './intelligence-service';
import { getLiveStore } from './live-store';
import { NATIONAL_SESSION } from './session';

/**
 * The audit trail held to the set of actions it claims to cover.
 *
 * A chain proves that what is *in* it was not altered. It proves nothing about
 * what never entered it, and a consequential action nobody recorded is exactly
 * the failure an audit trail is bought to prevent — so the coverage is asserted
 * rather than asserted-about:
 *
 *  - the registry and the type are one list, checked against each other;
 *  - every action names a file, that file exists, and that file appends to the
 *    chain and names the action;
 *  - the converse, which is the half that catches a *new* writer: every file in
 *    the application that appends to the chain is named by some registered
 *    action, so an unregistered write is a failing test rather than a second
 *    code path nobody reviewed;
 *  - and the write paths that can be driven cheaply are driven, so the strings
 *    the scan reads are known to be reached rather than merely present.
 *
 * What this cannot do is decide whether an action *should* have been
 * consequential. The registry is a list a reviewer can argue with, and the
 * exclusions are written down beside it.
 */

const LIB = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(LIB, '../../../..');
const WEB_SRC = resolve(LIB, '..');

/** A path as the registry writes it: relative to `Source/`, with forward slashes. */
const asRepositoryPath = (absolute: string): string =>
  relative(SOURCE_ROOT, absolute).split('\\').join('/');

/** Every hand-written source file under a directory, tests excluded. */
function sourceFilesUnder(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(path);
  }
  return found;
}

const APPENDS_TO_CHAIN = 'recordAuditEvent(';

describe('the registry of consequential actions', () => {
  it('lists every action the type allows, exactly once, in the same order', () => {
    expect(CONSEQUENTIAL_ACTIONS.map((entry) => entry.action)).toEqual([...AUDIT_ACTIONS]);
  });

  it('registers each action in one place and says what it means', () => {
    const ids = CONSEQUENTIAL_ACTIONS.map((entry) => entry.action);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CONSEQUENTIAL_ACTIONS) {
      expect(entry.detail.trim().length).toBeGreaterThan(20);
      expect(entry.writers.length).toBeGreaterThan(0);
    }
  });

  it('names a writer that appends to the chain and names the action', () => {
    for (const entry of CONSEQUENTIAL_ACTIONS) {
      const sources = entry.writers.map((writer) =>
        readFileSync(resolve(SOURCE_ROOT, writer), 'utf8'),
      );

      // The file the registry points at is where the action happens: it has to
      // reach the chain, and it has to name this action. Either one missing means
      // the registry has drifted from the code, which is the failure this asserts.
      for (const source of sources) {
        expect(source).toContain(APPENDS_TO_CHAIN);
      }
      expect(sources.some((source) => source.includes(`'${entry.action}'`))).toBe(true);
    }
  });

  it('accounts for every file that appends to the chain', () => {
    const registered = new Set(
      CONSEQUENTIAL_ACTIONS.flatMap((entry) => entry.writers.map((writer) => writer)),
    );
    const appenders = sourceFilesUnder(WEB_SRC).filter((path) =>
      readFileSync(path, 'utf8').includes(APPENDS_TO_CHAIN),
    );

    // `audit-service.ts` is the chain itself; the rest have to be registered.
    const unaccounted = appenders
      .map(asRepositoryPath)
      .filter((path) => path !== 'apps/web/src/lib/audit-service.ts' && !registered.has(path));

    expect(appenders.length).toBeGreaterThan(0);
    expect(unaccounted).toEqual([]);
  });
});

describe('what a stored observation adds to the chain', () => {
  it('records a capture and a correction as their own actions, with the actor', async () => {
    const store = await getLiveStore();
    const facilityId = store.historyFacilities[0];
    const itemId = store.catalogue[0]?.id;
    expect(facilityId).toBeDefined();
    expect(itemId).toBeDefined();
    if (facilityId === undefined || itemId === undefined) {
      return;
    }

    const submission = (overrides: {
      readonly key: string;
      readonly kind: 'receipt' | 'adjust';
      readonly direction: 'increase' | 'decrease' | null;
      readonly on: string;
    }): unknown => ({
      type: 'stock_ledger_entry',
      idempotencyKey: overrides.key,
      captureSource: 'manual',
      capturedAt: `${overrides.on}T09:00:00.000Z`,
      observation: {
        id: `entry-${overrides.key}`,
        facilityId,
        itemId,
        kind: overrides.kind,
        quantity: 7,
        adjustmentDirection: overrides.direction,
        occurredOn: overrides.on,
        // A receipt has to name the batch it arrived in; a correction is not a
        // movement of stock into the facility and carries neither.
        batchId: overrides.kind === 'receipt' ? 'batch-audit-1' : null,
        expiresOn: overrides.kind === 'receipt' ? '2027-06-30' : null,
        correctsEntryId: null,
        counterpartFacilityId: null,
        transferId: null,
      },
    });

    const before = await readAuditEvents();
    const actor = actorOf(NATIONAL_SESSION);

    const capture = ingestRequestSchema.parse(
      completeSubmission(
        submission({
          key: 'key-audit-capture',
          kind: 'receipt',
          direction: null,
          on: '2026-09-19',
        }),
        PLATFORM_STAMP,
      ),
    );
    const correction = ingestRequestSchema.parse(
      completeSubmission(
        submission({
          key: 'key-audit-correction',
          kind: 'adjust',
          direction: 'decrease',
          on: '2026-09-20',
        }),
        PLATFORM_STAMP,
      ),
    );

    const applied = await applySubmission(store, capture, '2026-09-19T10:00:00.000Z', actor);
    const adjusted = await applySubmission(store, correction, '2026-09-20T10:00:00.000Z', actor);

    expect(applied.decision.outcome).toBe('accepted');
    expect(adjusted.decision.outcome).toBe('accepted');

    const after = await readAuditEvents();
    expect(after.length).toBe(before.length + 2);

    const captured = after[before.length];
    const corrected = after[before.length + 1];

    expect(captured?.action).toBe('capture-recorded');
    expect(captured?.subjectType).toBe('stock_ledger_entry');
    expect(captured?.subjectId).toBe(applied.subjectKey);
    expect(captured?.actorUid).toBe(NATIONAL_SESSION.label);
    expect(captured?.actorRole).toBe('national');
    // The pair is the projection's own on-hand figure on both sides of the write,
    // which is what makes an entry answer "from what, to what". The prior figure
    // is null only when the facility had never stocked the item, and the receipt
    // is what changes that.
    expect(captured?.after).not.toBeNull();
    expect(Number(captured?.after)).toBe(
      (captured?.before === null ? 0 : Number(captured?.before)) + 7,
    );

    // The correction carries what the platform can state about the movement,
    // because the observation itself has nowhere to put a reason.
    expect(corrected?.action).toBe('adjustment-recorded');
    expect(Number(corrected?.after)).toBe(Number(corrected?.before) - 7);
    expect(corrected?.reason).toContain(itemId);
    expect(corrected?.reason).toContain('down');
    expect(corrected?.reason).toContain('2026-09-20');

    // And a replay is not a second movement: nothing changed, so nothing is
    // recorded, which is what keeps the chain's length equal to the number of
    // changes the platform made.
    const replayed = await applySubmission(store, capture, '2026-09-19T11:00:00.000Z', actor);
    expect(replayed.decision.outcome).toBe('replayed');
    expect((await readAuditEvents()).length).toBe(after.length);
  }, 60_000);
});

describe('what a person does to an alert', () => {
  it('records the action the move’s destination state means, and nothing when it is refused', async () => {
    const intelligence = await readIntelligence(NATIONAL_SESSION);
    const raised = intelligence.alerts.find((alert) => alert.state === 'raised');
    expect(raised).toBeDefined();
    if (raised === undefined) {
      return;
    }

    const before = await readAuditEvents();

    // A move with no reason is not a decision, so it is refused and the chain is
    // left alone: the trail records what changed, not what was attempted.
    await expect(
      moveAlert(NATIONAL_SESSION, { alertId: raised.id, to: 'acknowledged', reason: '  ' }),
    ).rejects.toThrow(AlertRefused);
    expect((await readAuditEvents()).length).toBe(before.length);

    const moved = await moveAlert(NATIONAL_SESSION, {
      alertId: raised.id,
      to: 'acknowledged',
      reason: 'the district pharmacist has taken this on',
    });

    const after = await readAuditEvents();
    expect(after.length).toBe(before.length + 1);

    const entry = after[before.length];
    // `acknowledged` and `alert-acknowledged` are the same fact told to two
    // readers, which is the mapping this asserts.
    expect(moved.state).toBe('acknowledged');
    expect(entry?.action).toBe('alert-acknowledged');
    expect(entry?.subjectType).toBe('alert');
    expect(entry?.subjectId).toBe(raised.id);
    expect(entry?.reason).toBe('the district pharmacist has taken this on');
    expect(entry?.actorUid).toBe(NATIONAL_SESSION.label);
    expect(verifyAuditChain(after).valid).toBe(true);
  }, 60_000);
});

describe('appends under concurrency', () => {
  it('gives five simultaneous decisions five entries, and loses none of them', async () => {
    const before = await readAuditEvents();
    const actor = { uid: 'Concurrency fixture', role: 'auditor' } as const;

    // Five decisions taken at the same moment, which is what a server does when
    // five requests arrive together. Each append reads the tail of the chain to
    // learn its own identifier and its link, so without serialisation they claim
    // one identifier between them and four decisions disappear.
    const written = await Promise.all(
      [1, 2, 3, 4, 5].map((each) =>
        recordAuditEvent({
          actor,
          action: 'alert-acknowledged',
          subjectType: 'alert',
          subjectId: `alert-concurrent-${String(each)}`,
          reason: null,
          before: 'raised',
          after: 'acknowledged',
        }),
      ),
    );

    const after = await readAuditEvents();
    expect(after.length).toBe(before.length + written.length);
    expect(new Set(written.map((event) => event.id)).size).toBe(written.length);

    // And the chain the concurrent writers produced still holds: every link is to
    // the entry the writer actually read, in the order the appends were taken.
    const report = verifyAuditChain(after);
    expect(report.valid).toBe(true);
    for (const event of after.slice(-5)) {
      expect(event.actorUid).toBe('Concurrency fixture');
    }
  });
});

describe('tamper detection over the stored chain', () => {
  it('fails at the entry an alteration touched, and holds again once it is restored', async () => {
    const events = await readAuditEvents();
    expect(events.length).toBeGreaterThan(1);

    const target = events[1];
    expect(target).toBeDefined();
    if (target === undefined) {
      return;
    }

    // The alteration is written through the same port the platform writes
    // through, because that is the only way to change a stored record: the
    // chain's claim is about the store, not about an in-memory array.
    const store = await getLiveStore();
    const stored = store.provider.collection(AUDIT_COLLECTION, auditEventSchema);
    await stored.set(target.id, { ...target, reason: 'an approval nobody made' });

    const readBack = await readAuditEvents();
    const broken = verifyAuditChain(readBack);
    expect(broken.valid).toBe(false);
    expect(broken.brokenAt).toBe(target.id);
    expect(broken.detail).toContain('altered');

    // Restoring the record restores the chain, which is what tells a reader the
    // failure was the alteration rather than the arithmetic.
    await stored.set(target.id, target);
    const restored = verifyAuditChain(await readAuditEvents());
    expect(restored.valid).toBe(true);
    expect(restored.brokenAt).toBeNull();
  });
});
