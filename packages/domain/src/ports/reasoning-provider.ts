import type { ZodType } from 'zod';

/**
 * One verifiable fact supplied to the reasoning layer.
 *
 * Facts are the only admissible source of quantities. A response that states a
 * number which is not present here is rejected, so a language model can explain
 * a decision but never author the arithmetic behind it.
 */
export interface Fact {
  readonly key: string;
  readonly value: string | number;
}

/** An image supplied for extraction, base64-encoded. */
export interface ImageInput {
  readonly mimeType: string;
  readonly data: string;
}

/** A request for structured reasoning. */
export interface ReasoningRequest<T> {
  /**
   * Identifier of the task. Used as the cache key, the fixture key and the
   * evaluation selector, so it must be stable.
   */
  readonly task: string;
  /** Instructions sent to the provider. Versioned assets, not inline literals. */
  readonly instructions: string;
  /** The shape the response must satisfy. */
  readonly schema: ZodType<T>;
  /** The only admissible source of quantities in narrative output. */
  readonly facts: readonly Fact[];
  readonly images?: readonly ImageInput[];
}

/** A structured reasoning result. */
export interface ReasoningResponse<T> {
  readonly value: T;
  /** Identifier of the adapter that produced the response. */
  readonly provider: string;
  readonly model: string;
  /** Whether the response was served from cache rather than generated. */
  readonly cacheHit: boolean;
}

/**
 * The reasoning boundary.
 *
 * Implementations validate the response against the request's schema before it
 * leaves the adapter, and are expected to fail loudly rather than return
 * malformed output. The cloud adapter and the recorded-fixture adapter satisfy
 * the same contract, which is what allows tests and offline development to
 * exercise this path without credentials or quota.
 */
export interface ReasoningProvider {
  /** Stable identifier of the concrete adapter, reported by the health check. */
  readonly kind: string;
  reason<T>(request: ReasoningRequest<T>): Promise<ReasoningResponse<T>>;
}
