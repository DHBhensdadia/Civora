import type { ZodType } from 'zod';

import { ReasoningProviderError } from '../errors';
import type {
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
} from '../ports/reasoning-provider';

/**
 * A single recorded response, keyed by the task that produced it.
 *
 * Fixtures are captured from real calls once, committed, and replayed. That is
 * what makes the reasoning path testable in CI without spending quota, and it
 * is why a fixture records the model that produced it.
 */
export interface ReasoningFixture {
  readonly task: string;
  readonly value: unknown;
  readonly model?: string;
}

function parseOrThrow<T>(schema: ZodType<T>, value: unknown, task: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new ReasoningProviderError(
    `recorded response for task "${task}" no longer satisfies its schema: ${detail}`,
  );
}

/**
 * A `ReasoningProvider` that replays recorded responses.
 *
 * It never invents an answer. A request with no recorded fixture fails loudly,
 * and a fixture that no longer satisfies the request's schema fails too, so a
 * stale recording cannot pass silently as a fresh result.
 */
export class FixtureReasoningProvider implements ReasoningProvider {
  readonly kind = 'fixture';
  readonly #fixtures: ReadonlyMap<string, ReasoningFixture>;
  readonly #model: string;

  constructor(fixtures: readonly ReasoningFixture[] = [], model = 'recorded-fixture') {
    this.#fixtures = new Map(fixtures.map((fixture) => [fixture.task, fixture]));
    this.#model = model;
  }

  /** Task identifiers this adapter can answer, for diagnostics and health output. */
  get tasks(): readonly string[] {
    return [...this.#fixtures.keys()].sort();
  }

  async reason<T>(request: ReasoningRequest<T>): Promise<ReasoningResponse<T>> {
    const fixture = this.#fixtures.get(request.task);
    if (fixture === undefined) {
      throw new ReasoningProviderError(
        `no recorded response for task "${request.task}"; record one or select a live provider`,
      );
    }

    return {
      value: parseOrThrow(request.schema, fixture.value, request.task),
      provider: this.kind,
      model: fixture.model ?? this.#model,
      cacheHit: true,
    };
  }
}
