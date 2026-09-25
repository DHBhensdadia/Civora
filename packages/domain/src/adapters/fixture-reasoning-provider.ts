import type { ZodType } from 'zod';

import { ReasoningProviderError } from '../errors';
import type {
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningTaskTelemetry,
  ReasoningTelemetry,
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
 *
 * It also counts what it was asked, in the same shape the live adapter does. That
 * is not decoration: the demonstration profile runs against this adapter, so a
 * telemetry panel that could only be filled by the cloud adapter would show a
 * blank exactly when a reader is looking. What it must not do is let those
 * counters be mistaken for a model's — it sends nowhere, it has no model to name,
 * it reports no tokens, and `attempts` stays at zero while `calls` climbs, which
 * is the honest shape of "every answer came off a disk".
 */
export class FixtureReasoningProvider implements ReasoningProvider {
  readonly kind = 'fixture';
  readonly #fixtures: ReadonlyMap<string, ReasoningFixture>;
  readonly #model: string;
  readonly #tasks = new Map<string, { calls: number; failures: number; durationMs: number }>();

  constructor(fixtures: readonly ReasoningFixture[] = [], model = 'recorded-fixture') {
    this.#fixtures = new Map(fixtures.map((fixture) => [fixture.task, fixture]));
    this.#model = model;
  }

  /** Task identifiers this adapter can answer, for diagnostics and health output. */
  get tasks(): readonly string[] {
    return [...this.#fixtures.keys()].sort();
  }

  async reason<T>(request: ReasoningRequest<T>): Promise<ReasoningResponse<T>> {
    const started = Date.now();
    const counters = this.#countersFor(request.task);
    counters.calls += 1;

    const fixture = this.#fixtures.get(request.task);
    if (fixture === undefined) {
      counters.durationMs += Date.now() - started;
      counters.failures += 1;
      throw new ReasoningProviderError(
        `no recorded response for task "${request.task}"; record one or select a live provider`,
      );
    }

    try {
      return {
        value: parseOrThrow(request.schema, fixture.value, request.task),
        provider: this.kind,
        model: fixture.model ?? this.#model,
        cacheHit: true,
      };
    } catch (error) {
      counters.failures += 1;
      throw error;
    } finally {
      counters.durationMs += Date.now() - started;
    }
  }

  /**
   * What this adapter has been asked, counted the same way the live one counts.
   *
   * `model` is `null` rather than the recorded-fixture label: a recording is not
   * attributable to a running model, and the panel must be able to say so.
   */
  telemetry(): ReasoningTelemetry {
    const perTask: ReasoningTaskTelemetry[] = [...this.#tasks].map(([task, counters]) => ({
      task,
      calls: counters.calls,
      // Nothing is sent anywhere, so nothing is attempted. A replay that failed
      // is a missing or stale recording, and it is counted as a failure rather
      // than as an attempt against a provider.
      attempts: 0,
      cacheHits: counters.calls - counters.failures,
      failures: counters.failures,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalDurationMs: counters.durationMs,
    }));

    return {
      model: null,
      calls: perTask.reduce((total, task) => total + task.calls, 0),
      attempts: 0,
      cacheHits: perTask.reduce((total, task) => total + task.cacheHits, 0),
      failures: perTask.reduce((total, task) => total + task.failures, 0),
      totalInputTokens: null,
      totalOutputTokens: null,
      totalDurationMs: perTask.reduce((total, task) => total + task.totalDurationMs, 0),
      perTask,
    };
  }

  #countersFor(task: string): { calls: number; failures: number; durationMs: number } {
    const existing = this.#tasks.get(task);
    if (existing !== undefined) {
      return existing;
    }

    const counters = { calls: 0, failures: 0, durationMs: 0 };
    this.#tasks.set(task, counters);
    return counters;
  }
}
