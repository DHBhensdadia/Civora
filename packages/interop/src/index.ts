/**
 * `@civora/interop` — talking to systems that already exist.
 *
 * Scope: parsers and importers for the formats a state health department
 * already produces — HMIS reports, e-Aushadhi stock records, IHIP facility
 * registries, LGD administrative codes and the NLEM essential-medicines list —
 * each behind an adapter with a fixture proving the parse.
 *
 * Every importer must be strict about provenance: the source, its licence, the
 * retrieval date and the transformation applied are recorded, and a record
 * whose origin cannot be established is rejected rather than guessed at.
 *
 * Three importers exist: `nlem.ts` for the national essential medicines list,
 * `lgd.ts` for the administrative directory and `hmis-csv.ts` for a monthly HMIS
 * stock statement. The first is used by the generator rather than merely tested,
 * so the catalogue the demonstration runs on is produced by the same code a real
 * extract would go through, and the second and third are on the import flow's
 * path, so the rows they produce reach the ledger through the same boundary a
 * capture surface uses.
 *
 * Deferred, and named rather than implied: `eaushadhi-csv` (warehouse
 * receipt/issue extracts) and `ihip-json` (the syndromic feed). Both are listed
 * as deferred in `state/RUN_STATE.md` with what implementing them would take.
 */
export * from './csv';
export * from './hmis-csv';
export * from './lgd';
export * from './nlem';
