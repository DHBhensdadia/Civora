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
 * Not implemented yet. The interop adapters land as their source formats are
 * introduced.
 */
export {};
