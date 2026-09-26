import { getProviders } from '@/providers';

import { APP_VERSION } from './version';
import { COUNTER_NAMES, counterValue } from './counters';
import { readAuditEvents, verifyAuditChain } from './audit-service';
import { readImports } from './import-service';
import { getLiveStore } from './live-store';

/**
 * What an operator can see about this process from outside it.
 *
 * Two answers, and each is deliberately small enough to be true:
 *
 *  - **Readiness that can be wrong.** `/healthz` says the process is alive;
 *    `/readyz` says whether this platform should be given traffic, and it answers
 *    from mechanisms that can genuinely fail — the store, the projection and **the
 *    audit chain**, which is the one check a healthy-looking process can still
 *    fail. A trail that has been altered means the platform can no longer answer
 *    for its own decisions, so readiness reports it and names the entry.
 *  - **A metrics summary read through the mechanism that owns each figure** — the
 *    store's own counts, the ledger's revision, the chain, the import register and
 *    the reasoning adapter's counters — rather than recomputed here. That is the
 *    same rule the control tower follows, and for the same reason: a second
 *    reading of one fact is how two numbers about it end up on one screen.
 *
 * The log writer is `log.ts`, which is a leaf so that `middleware.ts` can use it
 * on every path without dragging the store into the edge bundle. What a log line
 * may carry is enforced there, and what the *schemas* may carry is enforced by
 * test — the half a log writer cannot check.
 */

export {
  CORRELATION_HEADER,
  LOG_LEVELS,
  LOG_SERVICE,
  PERSONAL_KEY_FRAGMENTS,
  correlationIdOf,
  logHandled,
  logLine,
  looksPersonal,
} from './log';
export type { LogLevel, LogRecord } from './log';

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  /** What was actually looked at, so a failure is diagnosable. */
  readonly detail: string;
}

export interface Readiness {
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly ReadinessCheck[];
  /**
   * What this process is *not* configured to do, reported separately from
   * readiness on purpose: a demonstration with no model key is ready to serve, and
   * folding a missing key into the readiness answer would make readiness a claim
   * about the deployment's ambitions rather than its capability.
   */
  readonly capabilities: Readonly<Record<string, string | boolean>>;
  readonly simulated: true;
}

/** Whether this process should be given traffic. See the module comment. */
export async function readinessOf(): Promise<Readiness> {
  const store = await getLiveStore();
  const health = await store.provider.health();
  const chain = verifyAuditChain(await readAuditEvents());

  const checks: ReadinessCheck[] = [
    {
      name: 'store',
      ok: health.ok,
      detail: `${health.kind} reports ${health.ok ? 'ok' : 'not ok'}${
        health.detail === undefined ? '' : ` — ${health.detail}`
      }`,
    },
    {
      name: 'dataset',
      ok: store.info.documents > 0,
      detail: `${String(store.info.documents)} document(s) from seed ${store.info.seed}, fingerprint ${store.info.fingerprint}`,
    },
    {
      name: 'projection',
      // Whether the seeded history is actually projected, rather than whether a
      // projection object exists: a ledger that replayed nothing would still
      // report a day, and this is the check that notices.
      ok: store.historyFacilities.some((facilityId) => store.ledger.stockFor(facilityId) !== null),
      detail: `the ledger projects to ${store.ledger.asOf()}, holding stock for ${String(
        store.historyFacilities.filter((facilityId) => store.ledger.stockFor(facilityId) !== null)
          .length,
      )} of ${String(store.historyFacilities.length)} facilities with history`,
    },
    {
      name: 'audit',
      ok: chain.valid,
      detail: `${chain.detail} — ${String(chain.events)} entry(s) walked`,
    },
  ];

  return {
    ready: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
    capabilities: {
      dataProvider: health.kind,
      dataProviderOk: health.ok,
      // Stated as a capability rather than as a limitation: every figure this
      // process serves is generated, and readiness would be the wrong place to
      // discover otherwise.
      simulated: store.info.seed === 'civora-demo-2026',
    },
    simulated: true,
  };
}

export interface MetricsSummary {
  readonly service: string;
  readonly version: string;
  readonly node: string;
  readonly pid: number;
  readonly uptimeSeconds: number;
  readonly store: {
    readonly kind: string;
    readonly ok: boolean;
    readonly seed: string;
    readonly fingerprint: string;
    readonly documents: number;
    readonly facilities: number;
    readonly districts: number;
    readonly items: number;
    readonly generatedInMs: number;
    readonly seededInMs: number;
  };
  readonly ledger: { readonly asOf: string; readonly revision: number };
  /**
   * The scans this process has served, and the share the memo answered.
   *
   * `cacheHitRate` is `null` rather than `0` when nothing has been read: the share
   * of no reads is unknown, and a zero would read as a memo that never works.
   */
  readonly reads: {
    readonly towerCold: number;
    readonly towerWarm: number;
    readonly cacheHitRate: number | null;
  };
  readonly audit: {
    readonly entries: number;
    readonly valid: boolean;
    readonly byAction: Readonly<Record<string, number>>;
  };
  readonly imports: { readonly files: number; readonly rowsWritten: number };
  /**
   * What the reasoning adapter reports about itself, or `null` where it keeps no
   * count. `null` is not zero — the same rule the telemetry panel follows, and the
   * same reason: a count nobody reported is not a small one.
   */
  readonly ai: {
    readonly provider: string;
    readonly model: string | null;
    readonly calls: number | null;
    readonly attempts: number | null;
    readonly cacheHits: number | null;
    readonly failures: number | null;
    readonly cacheHitRate: number | null;
  };
}

/** The summary an operator reads. */
export async function metricsSummaryOf(): Promise<MetricsSummary> {
  const store = await getLiveStore();
  const health = await store.provider.health();
  const events = await readAuditEvents();
  const chain = verifyAuditChain(events);

  const byAction: Record<string, number> = {};
  for (const event of events) {
    byAction[event.action] = (byAction[event.action] ?? 0) + 1;
  }

  const imports = await readImports();
  const cold = counterValue('tower.scan.cold');
  const warm = counterValue('tower.scan.warm');
  const reads = cold + warm;

  // The adapters, resolved once per process by `providers.ts`. This module is
  // reached from the two endpoints and from nothing on the request path, so a
  // static import here is a resolution that has already happened by the time a
  // probe asks — not work this endpoint causes.
  const reasoning = getProviders().reasoning;
  const telemetry = reasoning.telemetry?.() ?? null;

  return {
    service: 'civora-web',
    version: APP_VERSION,
    node: process.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    store: {
      kind: health.kind,
      ok: health.ok,
      seed: store.info.seed,
      fingerprint: store.info.fingerprint,
      documents: store.info.documents,
      facilities: store.info.facilities,
      districts: store.info.districts,
      items: store.info.items,
      generatedInMs: store.info.generatedInMs,
      seededInMs: store.info.seededInMs,
    },
    ledger: {
      // The ledger's own day and its own write counter: the memo the tower uses is
      // keyed on this revision, so the two figures a reader compares come from one
      // mechanism rather than from two readings of it.
      asOf: store.ledger.asOf(),
      revision: store.ledger.revision(),
    },
    reads: {
      towerCold: cold,
      towerWarm: warm,
      cacheHitRate: reads === 0 ? null : warm / reads,
    },
    audit: { entries: events.length, valid: chain.valid, byAction },
    imports: {
      files: imports.length,
      rowsWritten: imports.reduce((total, record) => total + record.rowsWritten, 0),
    },
    ai: {
      provider: reasoning.kind,
      model: telemetry?.model ?? null,
      calls: telemetry?.calls ?? null,
      attempts: telemetry?.attempts ?? null,
      cacheHits: telemetry?.cacheHits ?? null,
      failures: telemetry?.failures ?? null,
      cacheHitRate:
        telemetry === null || telemetry.attempts === 0
          ? null
          : telemetry.cacheHits / telemetry.attempts,
    },
  };
}

/** The counters this process reports, so a reader of the summary can name them. */
export const reportedCounters: readonly string[] = [...COUNTER_NAMES];
