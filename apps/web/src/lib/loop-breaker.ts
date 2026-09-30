/**
 * A budget for handing the event loop back while a long loop runs.
 *
 * This exists because of what the deployed instance measured. A read that assembles
 * the country — every facility's own reading, replayed from its ledger — is short
 * work per item and a long stretch of it in total, and a *synchronous* stretch of
 * that length is not a slow page: the process cannot answer the platform's own
 * health check while it runs, the host is taken out of rotation, and the requests
 * that arrive meanwhile are answered **502 by the proxy**, without the application
 * ever seeing them (`docs/DEPLOYMENT.md` §8.8).
 *
 * So the loop yields. The budget is measured in **time rather than iterations**,
 * which is the whole point: the iteration count that is safe on a development
 * machine is not safe on a tenth of a core, and this way the contention is bounded
 * at the budget plus one item's own work, on whatever host it runs.
 *
 * `setImmediate` is the yield that matters: it runs in the check phase, after the
 * poll phase, so pending I/O — a waiting health check, a socket with a request on it
 * — is served on the way through.
 */

/** How long the loop may hold the process before it has to give it back. */
export const DEFAULT_LOOP_BUDGET_MS = 50;

/**
 * Returns a `breathe()` that yields at most once per budget.
 *
 * The first calls are free — the budget starts spent-at-zero, so a loop that runs
 * quickly never pays for a yield it does not need.
 */
export function loopBreaker(budgetMs: number = DEFAULT_LOOP_BUDGET_MS): () => Promise<void> {
  let givenBackAt = Date.now();

  return async (): Promise<void> => {
    if (Date.now() - givenBackAt < budgetMs) {
      return;
    }
    givenBackAt = Date.now();
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
}
