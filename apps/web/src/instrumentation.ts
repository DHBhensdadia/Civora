/**
 * Start-up work, run by Next before it serves anything.
 *
 * Two jobs, in this order, and the order is the design.
 *
 * **The world.** The demonstration environment is generated once per process and
 * shared, and on a small host that generation is forty-odd seconds of CPU. Paid by
 * the *first request* it is paid twice over — the request is slow, the platform's
 * health check stops being answered while the event loop is busy, and the instance
 * is restarted with nothing cached, which is a loop rather than a slow start. Paid
 * here it is paid once, before anything is served.
 *
 * **The views assembled from it.** The control tower's country scan and the scored
 * population behind it are the other expensive reads, and they are memoised per
 * process — so the first *visitor* to open the tower pays for them. On the deployed
 * instance that was measured at **51.33 s**, and while it ran the host could not
 * answer its own health check, so the requests arriving behind it were answered
 * **502 by the proxy** (`docs/DEPLOYMENT.md` §8.8). Warming them here moves that
 * cost to start-up, where nobody is watching.
 *
 * That second warm is deliberately **not awaited**, and the delay before it is not
 * decoration: this function returns before the server finishes coming up, and a
 * warm that ran first would hold the port closed for its whole duration. It begins
 * a moment later instead, while the port is open and answering.
 *
 * Three deliberate refusals:
 *
 *  - **The edge runtime does not get a store.** `register()` is called for it too,
 *    and it has no business holding four hundred megabytes of generated world.
 *  - **A failure to warm is not a failure to start.** The request path still builds
 *    the world itself; that is slower, and it is what happened before this file
 *    existed. A warm-up that cannot complete says so in one line and gets out of
 *    the way.
 *  - **The reasoning surfaces are not warmed.** They cost model calls, and a
 *    deployment that spent the day's quota on every restart would be unable to
 *    record anything on the day it mattered.
 *
 * `CIVORA_WARM_STORE=off` turns both warms off: the platform then behaves exactly as
 * it did before this file existed. That is the switch to reach for if a host ever
 * shows this work taking the instance down, rather than a code change.
 */

import { logLine } from './lib/log';

/**
 * How long to leave the process alone before the second warm starts.
 *
 * The world warm is roughly forty seconds of CPU on the deployed host, and the
 * views warm is another fifty in a single stretch (see `warmAssembledViews`). The
 * platform restarts an instance that fails consecutive health checks for sixty
 * seconds, and it *resets* that count the moment one succeeds — so the gap between
 * the two is not a courtesy, it is what stops two survivable fifty-second stretches
 * from being added up into one fatal one. Ten seconds of idle is several check
 * intervals, and nothing waits on it.
 */
const ASSEMBLY_DELAY_MS = 10_000;

/** How long to wait for the port to answer before warming anyway. */
const SERVING_PROBE_TIMEOUT_MS = 30_000;

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
    // Nothing to build the assembled views from, and the request path will report
    // the same failure with a stack when it is asked for something.
    return;
  }

  // Deliberately not awaited: this function returning is what lets the server finish
  // coming up, and a warm that held the port closed for its own duration would be the
  // outage it exists to prevent. Whether that matters is not assumed — the probe below
  // observes the port rather than trusting the order.
  void warmAfterServing();
}

/**
 * Wait until this process is answering on its own port, then warm what it serves.
 *
 * The probe is this process asking itself for `/healthz`. It is the smallest honest
 * answer to "is the server up?" available from inside the server, and it is
 * best-effort by design: if the port never answers — a host that assigns one
 * differently from `PORT`, a development server on another — the warm still runs,
 * because warming late is a cost and not warming at all is the behaviour this file
 * exists to change.
 */
async function warmAfterServing(): Promise<void> {
  const port = process.env.PORT ?? '3000';
  const deadline = Date.now() + SERVING_PROBE_TIMEOUT_MS;
  let serving = false;

  while (!serving && Date.now() < deadline) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
        headers: { accept: 'application/json' },
      });
      // Consumed rather than dropped: an unread body holds the socket it arrived on.
      await answer.arrayBuffer();
      serving = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  if (!serving) {
    logLine({
      level: 'warn',
      event: 'views.warm_unprobed',
      correlationId: 'startup',
      fields: { port, waitedMs: SERVING_PROBE_TIMEOUT_MS },
    });
  }

  await new Promise((resolve) => setTimeout(resolve, ASSEMBLY_DELAY_MS));
  await warmAssembledViews();
}

/**
 * The reads that assemble the country, warmed for the first visitor rather than by
 * them.
 *
 * Each step is timed separately and reported in one line, because the split is the
 * interesting part, and it was measured before this line existed: of the deployed
 * host's 51.33 s, building the demand histories was **1.44 s** here and assessing
 * them **0.39 s**, while the tower's own scan — the loop that hands the event loop
 * back between facilities, `loop-breaker.ts` — is about 130 ms once the population is
 * scored. So the first number is the one to watch on a slow host: it is a single
 * synchronous pass that no await can break up, and it is the reason this warm exists.
 * Making *it* interruptible is the next change, not this one: the pass is shared with
 * the batch worker, and a signature that becomes asynchronous ripples there.
 *
 * The session is the national one — the scope the interface opens on, and the
 * largest read it can make. A district officer's scan is a different entry in the
 * memo table and a smaller one, so it stays on the request path, where it is
 * cheaper than the country.
 */
async function warmAssembledViews(): Promise<void> {
  const startedAt = Date.now();
  try {
    const { readCommandTower } = await import('./lib/command-service');
    const { getDemoDataset } = await import('./lib/dataset');
    const { readScoredPopulation } = await import('./lib/intelligence-service');
    const { NATIONAL_SESSION } = await import('./lib/session');

    const populationAt = Date.now();
    await readScoredPopulation();
    const towerAt = Date.now();
    const tower = await readCommandTower(NATIONAL_SESSION, { tier: 'state' });
    const datasetAt = Date.now();
    getDemoDataset();
    const finishedAt = Date.now();

    logLine({
      level: 'info',
      event: 'views.warmed',
      correlationId: 'startup',
      fields: {
        tookMs: finishedAt - startedAt,
        scoredPopulationMs: towerAt - populationAt,
        commandTowerMs: datasetAt - towerAt,
        datasetMs: finishedAt - datasetAt,
        districts: tower.districts.length,
        facilities: tower.facilities.length,
      },
    });
  } catch (error) {
    logLine({
      level: 'error',
      event: 'views.warm_failed',
      correlationId: 'startup',
      fields: {
        tookMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
