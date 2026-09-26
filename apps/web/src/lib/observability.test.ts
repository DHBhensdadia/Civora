import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditEventSchema } from '@civora/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_COLLECTION, readAuditEvents, recordAuditEvent } from './audit-service';
import { CORRELATION_HEADER, correlationIdOf, logHandled, logLine, looksPersonal } from './log';
import { getLiveStore } from './live-store';
import { metricsSummaryOf, readinessOf } from './observability';

/**
 * What this process says about itself, held to what it can actually see.
 *
 * Three things are asserted here, and each is a mechanism rather than a claim:
 *
 *  - **a log line is one JSON object**, carrying the correlation id of the request
 *    it belongs to, and **a field that looks personal is withheld and named**
 *    rather than written or silently dropped;
 *  - **readiness can fail**, proven by altering a stored audit record through the
 *    port the platform writes through — the same alteration the chain's own test
 *    makes — and then holding again once the record is restored;
 *  - and every figure the metrics summary prints is **read through the mechanism
 *    that owns it**, which is checked by comparing the summary with a direct read
 *    of the same store rather than with a number written down here.
 *
 * The last block is the half a log writer cannot check: the *schemas* and the
 * adapters are scanned for anything that would hold a person's identity, with a
 * positive control, because a scan that finds nothing is only evidence if it would
 * have found something.
 */

const LIB = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(LIB, '../../../..');

/** One captured line, parsed. */
const captured = async (write: () => void): Promise<Record<string, unknown>> => {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });

  try {
    write();
  } finally {
    spy.mockRestore();
  }

  expect(lines).toHaveLength(1);
  const line = lines[0] ?? '';
  // One line, and a newline ends it: two events must never share a line, because
  // a log store reads a line as a record.
  expect(line.endsWith('\n')).toBe(true);
  expect(line.trimEnd().includes('\n')).toBe(false);
  return JSON.parse(line) as Record<string, unknown>;
};

describe('the structured log line', () => {
  it('is one JSON object carrying the request it belongs to', async () => {
    const line = await captured(() => {
      logHandled({
        correlationId: 'e2e-correlation-1',
        method: 'GET',
        path: '/api/metrics',
        status: 200,
        durationMs: 7,
      });
    });

    expect(line.event).toBe('request.handled');
    expect(line.level).toBe('info');
    expect(line.correlationId).toBe('e2e-correlation-1');
    expect(line.service).toBe('civora-web');
    expect(line.method).toBe('GET');
    expect(line.path).toBe('/api/metrics');
    expect(line.status).toBe(200);
    expect(line.durationMs).toBe(7);
    expect(typeof line.at).toBe('string');

    // A refusal is a warning and a crash is an error, because that is the line an
    // operator filters for when something is wrong.
    const refused = await captured(() => {
      logHandled({
        correlationId: 'e2e-correlation-2',
        method: 'GET',
        path: '/api/metrics',
        status: 403,
        durationMs: 3,
      });
    });
    expect(refused.level).toBe('warn');
  });

  it('withholds a field that looks personal and names it, rather than writing it', async () => {
    const line = await captured(() => {
      logLine({
        level: 'info',
        event: 'import.checked',
        correlationId: 'e2e-correlation-3',
        fields: {
          rowsRead: 3,
          fileName: 'hmis-2026-08.csv',
          patientName: 'a name that must never be written',
          guardianContact: '+91-00000-00000',
        },
      });
    });

    expect(line.rowsRead).toBe(3);
    expect(line.fileName).toBe('hmis-2026-08.csv');
    expect(line.withheld).toEqual(['patientName', 'guardianContact']);
    // Not anywhere in the line, including inside the withheld list.
    expect(JSON.stringify(line)).not.toContain('must never be written');
    expect(JSON.stringify(line)).not.toContain('00000');

    // The rule is about the key's shape. A person's own spellings are withheld;
    // the platform's field names are not, because a rule that hid `fileName`
    // would make every log line useless and nobody would keep it.
    expect(looksPersonal('patientName')).toBe(true);
    expect(looksPersonal('date_of_birth')).toBe(true);
    expect(looksPersonal('guardianContact')).toBe(true);
    expect(looksPersonal('rowsRead')).toBe(false);
    expect(looksPersonal('facilityName')).toBe(false);
    expect(looksPersonal('fileName')).toBe(false);
  });

  it('keeps a caller’s own correlation id, and mints one when it is not an identifier', () => {
    expect(correlationIdOf('gateway-4f8c1a2b')).toBe('gateway-4f8c1a2b');
    expect(correlationIdOf('short')).toMatch(/^[0-9a-f-]{36}$/);
    // A newline in a supplied id would let a caller write lines of its own into a
    // file that is read as structured.
    expect(correlationIdOf('bad\n{"level":"info"}')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdOf(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdOf(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(CORRELATION_HEADER).toBe('x-correlation-id');
  });
});

describe('readiness', () => {
  it('answers from the store, the projection and the chain, and reports what it read', async () => {
    const readiness = await readinessOf();

    expect(readiness.ready).toBe(true);
    expect(readiness.simulated).toBe(true);
    expect(readiness.checks.map((check) => check.name)).toEqual([
      'store',
      'dataset',
      'projection',
      'audit',
    ]);
    for (const check of readiness.checks) {
      expect(check.ok, `${check.name}: ${check.detail}`).toBe(true);
      expect(check.detail.length).toBeGreaterThan(10);
    }
    expect(readiness.capabilities.dataProviderOk).toBe(true);
    expect(readiness.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 120_000);

  it('refuses to be given traffic when the audit chain does not hold', async () => {
    const store = await getLiveStore();

    // A chain with nothing in it cannot be broken, and a fresh process starts with
    // one — the trail is written by decisions, and nobody has decided yet. So this
    // journey records one of its own, the same way the other journeys make their
    // own evidence rather than depending on a neighbour having run.
    await recordAuditEvent({
      actor: { uid: 'Readiness fixture', role: 'auditor' },
      action: 'alert-acknowledged',
      subjectType: 'alert',
      subjectId: 'alert-readiness-fixture',
      reason: null,
      before: 'raised',
      after: 'acknowledged',
    });

    const events = await readAuditEvents();
    const target = events[0];
    if (target === undefined) {
      throw new Error('the chain is empty, so this test would prove nothing');
    }

    const stored = store.provider.collection(AUDIT_COLLECTION, auditEventSchema);
    await stored.set(target.id, { ...target, after: 'a change nobody made' });

    const broken = await readinessOf();
    const audit = broken.checks.find((check) => check.name === 'audit');
    expect(broken.ready).toBe(false);
    expect(audit?.ok).toBe(false);
    // The entry is named, because "not ready" without saying where is not
    // something an operator can act on.
    expect(audit?.detail).toContain(target.id);

    await stored.set(target.id, target);
    const restored = await readinessOf();
    expect(restored.ready).toBe(true);
    expect(restored.checks.every((check) => check.ok)).toBe(true);
  }, 120_000);
});

describe('the metrics summary', () => {
  it('reads every figure through the mechanism that owns it', async () => {
    const store = await getLiveStore();
    const summary = await metricsSummaryOf();
    const events = await readAuditEvents();

    expect(summary.service).toBe('civora-web');
    expect(summary.store.kind).toBe((await store.provider.health()).kind);
    // The store's own counts and fingerprint, not a second reading of them.
    expect(summary.store.documents).toBe(store.info.documents);
    expect(summary.store.fingerprint).toBe(store.info.fingerprint);
    expect(summary.ledger.asOf).toBe(store.ledger.asOf());
    expect(summary.audit.entries).toBe(events.length);
    expect(summary.audit.valid).toBe(true);
    // The tally is of the same events, so it adds up to them: a summary that
    // counted a different reading would be a second answer to one question.
    const tally = Object.values(summary.audit.byAction).reduce((total, count) => total + count, 0);
    expect(tally).toBe(events.length);

    // The memo's own counters: whatever they are, they add up, and the share is
    // unknown rather than zero when nothing has been read.
    const reads = summary.reads.towerCold + summary.reads.towerWarm;
    expect(summary.reads.cacheHitRate).toBe(reads === 0 ? null : summary.reads.towerWarm / reads);

    // A demonstration with no model key reports the adapter that serves it, and
    // `null` for a count nobody keeps rather than a zero.
    expect(summary.ai.provider.length).toBeGreaterThan(0);
    expect(
      summary.ai.cacheHitRate === null ||
        (summary.ai.cacheHitRate >= 0 && summary.ai.cacheHitRate <= 1),
    ).toBe(true);
    expect(summary.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(summary.node).toContain('v');
  }, 120_000);
});

/**
 * The no-PII scan.
 *
 * The phase asks for a test asserting that no patient-identifiable field exists in
 * any schema, and this is the honest form of it: read the source that declares the
 * schemas and the adapters, and refuse to find a name in a **field position**.
 * Prose cannot match, because the pattern requires the identifier to be followed by
 * the punctuation a field declaration uses and a sentence does not — which matters,
 * since this repository's comments discuss exactly this risk at length.
 */
const SCHEMA_SOURCES = [
  resolve(SOURCE_ROOT, 'packages/domain/src/model'),
  resolve(SOURCE_ROOT, 'packages/domain/src/ports'),
  resolve(SOURCE_ROOT, 'packages/interop/src'),
  resolve(SOURCE_ROOT, 'apps/web/src/lib'),
];

const PERSONAL_FIELD =
  /\b(patient|person|aadhaar|abha|phone|mobile|contact|guardian|relative|address|dateOfBirth|dob|fullName|guardianName)\w*\s*[?:]/;

function sourceFilesUnder(root: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
      continue;
    }
    // Tests are excluded: a test *names* the fields it is checking for, and a scan
    // that read its own assertions as findings would report nothing but itself.
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
      continue;
    }
    found.push(path);
  }
  return found;
}

describe('the schemas carry no patient identity', () => {
  it('holds no field that would name a person, with a control that proves the scan scans', () => {
    const scanned = SCHEMA_SOURCES.flatMap(sourceFilesUnder);
    // A scan of nothing finds nothing, so the scope is asserted rather than
    // assumed: the schemas, the ports, the adapters and the services are read.
    expect(scanned.length).toBeGreaterThanOrEqual(50);

    const offenders: string[] = [];
    for (const path of scanned) {
      // The scan looks at declarations, not at prose: comments are stripped first,
      // so a sentence about patients cannot be mistaken for a field holding one.
      const source = readFileSync(path, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
      for (const line of source.split('\n')) {
        const code = line.split('//')[0] ?? '';
        if (PERSONAL_FIELD.test(code)) {
          offenders.push(`${path.slice(SOURCE_ROOT.length + 1)}: ${code.trim()}`);
        }
      }
    }

    // The positive control: the pattern must find the thing it exists to find.
    expect(PERSONAL_FIELD.test('patientName: z.string().min(1),')).toBe(true);
    expect(PERSONAL_FIELD.test('aadhaar: z.string(),')).toBe(true);
    // And must not fire on the platform's own field names, which is the other half
    // of a useful control — a scan that flags everything is not a scan.
    expect(PERSONAL_FIELD.test('facilityId: facilityIdSchema,')).toBe(false);
    expect(PERSONAL_FIELD.test('rowsRead: z.int().nonnegative(),')).toBe(false);
    expect(PERSONAL_FIELD.test('capturedAt: instantSchema,')).toBe(false);

    expect(offenders).toEqual([]);
  }, 60_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});
