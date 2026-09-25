import type { ZodType } from 'zod';

/** Bounds applied to a collection listing. */
export interface ListOptions {
  /** Maximum number of documents to return. */
  readonly limit?: number;
  /** Identifier of the last document of the previous page. */
  readonly cursor?: string;
}

/**
 * A typed handle on one named collection.
 *
 * Documents are validated against the collection's schema on the way in and
 * again on the way out, so a malformed or drifting document is rejected at the
 * boundary instead of propagating into domain code.
 */
export interface CollectionRef<T> {
  readonly name: string;
  get(id: string): Promise<T | null>;
  list(options?: ListOptions): Promise<readonly T[]>;
  set(id: string, value: T): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Liveness and capability report, surfaced by the health endpoint. */
export interface ProviderHealth {
  readonly ok: boolean;
  /** Stable identifier of the concrete adapter. */
  readonly kind: string;
  readonly detail?: string;
}

/**
 * The persistence boundary.
 *
 * Nothing in the platform reads or writes a stored document except through this
 * port. That is what lets the same domain code run against in-memory storage, a
 * local emulator, or a managed database without modification — and it is why
 * the project builds, tests and demos with no cloud credentials at all.
 */
export interface DataProvider {
  /** Stable identifier of the concrete adapter, reported by the health check. */
  readonly kind: string;
  collection<T>(name: string, schema: ZodType<T>): CollectionRef<T>;
  health(): Promise<ProviderHealth>;
  close(): Promise<void>;
}
