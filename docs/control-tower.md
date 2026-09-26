# The control tower

The national picture Phase 8 adds: stock-out risk, bed pressure and reporting
gaps by region, district or facility, with a drill-down that ends at the record
behind a figure.

The page is `/command`; the same read is served as JSON at `/api/command`.

## It assembles; it does not create

Every figure on the tower is read from a computation an earlier phase already
owns, and this document exists so that claim can be checked rather than believed.

| Figure on the tower                                                                                                                | Where it was computed                                                                       | Why it is not recomputed here                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Facility status (`current`, `stale`, `never-heard`), items out of stock, items below critical cover, bed occupancy, reporting gaps | `LedgerService` — the projection Phase 3 replays from the ledger                            | A second reading of the ledger would make two answers to "what does this facility look like"              |
| Risk bands, drivers, shortfall windows, alert thresholds                                                                           | `scoredPopulationFor` — Phase 4's risk engine, through `readScoredPopulation`               | A pair's band on the map and its band on the intelligence surface are the same number or the map is wrong |
| Open alerts and their severities                                                                                                   | Phase 4's alert set, held by `intelligence-service`                                         | —                                                                                                         |
| Districts, facilities, coordinates, tiers                                                                                          | The seeded network (Phase 2's generator)                                                    | —                                                                                                         |
| The movements behind an item                                                                                                       | `LedgerService.evidenceFor` — the ledger entries themselves, with batch and expiry          | Evidence is the point of the last drill-down step; a summary would not be evidence                        |
| Map classes and placement                                                                                                          | `@civora/geo` — equal-interval classes over the values, projected from facility coordinates | One class list feeds the fills and the legend, so they cannot disagree                                    |

Nothing on the page calls a model, and nothing calls an external service. The
map is drawn from the platform's own coordinates because no Maps key is
configured, which is what `@civora/geo` returns and what the page says on it.

## The aggregation strategy, and what it measured

The tower needs every facility in the country, and a facility's reading is a
replay of ninety days of its own ledger. Measured on the production standalone
server (`node scripts/serve-standalone.mjs`, one process, `curl` from the same
machine), before the memo was added and after:

| Request                                 | Before | After   |
| --------------------------------------- | ------ | ------- |
| `/command` first read of a process      | 4.14 s | 2.34 s  |
| `/command` second read                  | —      | 0.017 s |
| `/api/command` first read of that route | 4.24 s | 2.34 s  |
| `/api/command` second read              | —      | 0.015 s |

Two changes produced the difference, and they are different kinds of change:

1. **The projection groups its ledger by item before replaying it.** `stockFor`
   computed each item's position by handing `replayStockLedger` the facility's
   whole ledger, which filters and then sorts — so fourteen items sorted the same
   entries fourteen times. Grouping first is the same replay over a fourteenth of
   the input, and `LedgerService`'s tests hold the resulting positions unchanged.
   This is an optimisation of the definition, not of the answer.
2. **A whole-country scan is memoised per session scope and per ledger
   revision.** `LedgerService.revision()` counts writes, so a capture invalidates
   the memo instead of leaving a stale country on the screen. This is a cache,
   and it is stated as one.

The remaining cost is not the tower's: **each route bundle in the standalone
build holds its own in-memory projections**, so the first read of _any_ surface
pays for building the demonstration world. Measured on the same server:
`/provenance` (which only builds the store) 1.82 s cold and 0.008 s warm;
`/api/visibility` (which builds the store and one district's readings) 2.00 s
cold and 0.003 s warm. The tower's own scan therefore costs roughly half a
second on top of what any surface's first request costs.

Earlier notes in `Workspace/state` describe this state as "per server process and
in memory". Precisely, it is **per route bundle**, which matters for the same
reason: two surfaces can hold two copies, and a write seen by one is seen by the
other only through the store they share, not through a shared projection. That is
correct for a demonstration and is exactly what Phase 9/10 replace with a
managed database and materialised views. The number above is what the demo
costs, and it is recorded rather than described as fast.

## The map, and what happens without a key

`@civora/geo` prefers Google Maps when `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is set,
and otherwise returns the schematic renderer with a sentence naming that
variable. Every environment in this repository is the second case, so the page
shows:

- `renderer: schematic` beside the map's heading, and the refusal sentence
  beneath it;
- one square per region, placed from the mean of its facilities' coordinates,
  shaded by the equal-interval classes the legend names, with the value and the
  class in each square's title so the figure does not depend on colour;
- the sentence that the placement is schematic — good enough to put a marker in
  the right region and not good enough to navigate by — which is what the
  provenance table says about the coordinates themselves.

`e2e/map-fallback.spec.ts` (browser) asserts the fallback renders the values and
says which renderer is in use. The Maps path is exercised at the port level
(`packages/geo/src/provider.test.ts`) rather than in a browser, because there is
no key to load a real map with; `docs/` records that gap instead of a screenshot
of a map we cannot draw.

## What the tower does not do

- **No execution of anything.** It reads; the redistribution workbench is where a
  person approves or rejects, and even there nothing is executed.
- **No live change feed.** The strip says what moved on the platform's latest
  day and states that the local adapter has no push, rather than implying one.
- **No second store.** The memo described above is a derived scan of the store's
  own projections, keyed by the store's own write counter, and is dropped the
  moment a record arrives.
