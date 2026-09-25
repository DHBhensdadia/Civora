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

/**
 * A recording supplied for transcription, base64-encoded.
 *
 * Audio is a first-class input rather than something the platform transcribes
 * first: the people who record stock are ANMs and ASHA workers speaking one of
 * twenty-two scheduled languages, and a speech-to-text step in front of the model
 * would throw away the acoustic evidence the model can use — a drug name is often
 * clearer in how it was said than in a transcript of it.
 */
export interface AudioInput {
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
  readonly audio?: readonly AudioInput[];
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
 * What one task has cost the adapter, as the adapter itself counted it.
 *
 * `null` for a token count means the surface did not report one. It is never a
 * zero standing in for an unknown quantity: a panel that showed `0` where a
 * provider said nothing would be presenting an estimate as a measurement.
 */
export interface ReasoningTaskTelemetry {
  /** The request's task identifier — the cache key, the fixture key, the selector. */
  readonly task: string;
  /** Requests answered or refused, from cache or from the model. */
  readonly calls: number;
  /** Attempts made against the model, including the ones the schema rejected. */
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly totalDurationMs: number;
}

/**
 * An adapter's own account of what it has been asked to do.
 *
 * This exists because the ceiling on this project is a real constraint rather
 * than a footnote: the reasoning layer runs against a free tier, so "what does a
 * burst cost" has to be answerable from the platform rather than from a pricing
 * page. Every field is counted at the call, not estimated from document counts.
 */
export interface ReasoningTelemetry {
  /**
   * The model every request from this adapter is sent to, or `null` when it
   * sends nowhere — the recorded-replay adapter has no model, and naming a
   * stand-in one here would attribute a recording to a model that never ran.
   */
  readonly model: string | null;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly totalDurationMs: number;
  /** Per task, in the order each task was first seen. */
  readonly perTask: readonly ReasoningTaskTelemetry[];
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
  /**
   * What this adapter has done since it was constructed, or `undefined` when it
   * keeps no count.
   *
   * Optional on purpose, and for the same reason a token count is nullable: an
   * adapter built on a provider that reports no usage genuinely cannot answer
   * this, and a required method would make every such adapter invent a zero. A
   * caller that finds no report must say so rather than render empty numbers —
   * "this adapter cannot tell you" and "nothing happened" are different claims.
   */
  telemetry?(): ReasoningTelemetry;
}
