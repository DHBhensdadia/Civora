/**
 * Start-up work, run by Next before it serves anything.
 *
 * One job: build the demonstration environment up front. The world is generated
 * once per process and shared, and on a small host that generation is forty-odd
 * seconds of CPU. Paid by the *first request* it is paid twice over — the request
 * is slow, the platform's health check stops being answered while the event loop
 * is busy, and the instance is restarted with nothing cached, which is a loop
 * rather than a slow start. Paid here it is paid once, before anything is served.
 *
 * Two deliberate refusals:
 *
 *  - **The edge runtime does not get a store.** `register()` is called for it too,
 *    and it has no business holding four hundred megabytes of generated world.
 *  - **A failure to warm is not a failure to start.** The request path still builds
 *    the store itself; that is slower, and it is what happened before this file
 *    existed. A warm-up that cannot complete says so in one line and gets out of
 *    the way.
 *
 * The reasoning surfaces are *not* warmed here, and that is on purpose: they cost
 * model calls, and a deployment that spent the day's quota on every restart would
 * be unable to record anything on the day it mattered.
 */

import { logLine } from './lib/log';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.CIVORA_WARM_STORE === 'off') return;

  const startedAt = Date.now();
  try {
    const { warmLiveStore } = await import('./lib/live-store');
    const store = await warmLiveStore();
    logLine({
      level: 'info',
      event: 'store.warmed',
      correlationId: 'startup',
      fields: {
        tookMs: Date.now() - startedAt,
        documents: store.info.documents,
        facilitiesWithHistory: store.info.facilitiesWithHistory,
        seed: store.info.seed,
        fingerprint: store.info.fingerprint,
      },
    });
  } catch (error) {
    logLine({
      level: 'error',
      event: 'store.warm_failed',
      correlationId: 'startup',
      fields: {
        tookMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
