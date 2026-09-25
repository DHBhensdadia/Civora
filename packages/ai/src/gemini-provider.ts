import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { ReasoningProviderError } from '@civora/domain';
import type {
  ReasoningProvider,
  ReasoningRequest,
  ReasoningResponse,
  ReasoningTaskTelemetry,
  ReasoningTelemetry,
} from '@civora/domain';

import { correctionTextOf, interactionRequestFor } from './request';
import type { ModelInteractionRequest, ModelUsage } from './request';

/**
 * The live reasoning adapter, behind the `ReasoningProvider` port.
 *
 * Four things happen here that a caller should not have to think about, and each
 * of them exists because the platform makes a promise about model output that
 * cannot be kept by asking nicely in a prompt:
 *
 * 1. **The answer is validated before it leaves the adapter.** A response that
 *    does not satisfy the caller's schema is not returned in a half-parsed form
 *    and is never repaired into one. This is the mechanism behind the rule that
 *    quantities originate in the platform's own engines.
 * 2. **A rejected answer is retried with the validator's complaint attached**, so
 *    a second attempt is informed rather than a re-roll.
 * 3. **Identical requests are answered from a cache.** The demo profile has
 *    hundreds of pairs, and a nightly advisory pass over them must not be
 *    hundreds of live calls against a free tier.
 * 4. **Every call is counted and timed**, including the attempts that failed,
 *    because the cost and rate-limit ceiling is a real constraint on this
 *    project rather than a footnote.
 */

/** What one model interaction returns, as far as this adapter depends on it. */
export interface ModelInteractionResult {
  readonly output_text?: string | undefined;
  readonly usage?: ModelUsage | undefined;
}

/**
 * The single call this adapter makes.
 *
 * A narrow interface of our own rather than the SDK's client type, for two
 * reasons: the tests drive it with a stub and no network, and a version bump of
 * the SDK changes the factory that implements this, not the thing every test is
 * held to.
 */
export interface InteractionClient {
  /** The model every request from this client is sent to. */
  readonly model: string;
  create(request: ModelInteractionRequest): Promise<ModelInteractionResult>;
}

/**
 * The running counts for one task.
 *
 * Kept per task rather than in one blob because the questions they answer are
 * per task: which capability is costing the free tier, which one is failing, and
 * whether a retry loop is quietly doubling a bill. The totals a surface shows are
 * **summed from these at snapshot time**, so a total cannot drift away from the
 * rows underneath it.
 */
interface TaskCounters {
  calls: number;
  attempts: number;
  cacheHits: number;
  failures: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalDurationMs: number;
}

export interface GeminiProviderOptions {
  readonly client: InteractionClient;
  /** Total attempts per request, including the first. */
  readonly maxAttempts?: number;
  /** Base wait between attempts; doubled each time. Tests pass 0. */
  readonly backoffMs?: number;
  /** Injected so a test can measure time without waiting for it. */
  readonly now?: () => number;
}

interface CachedAnswer {
  readonly value: unknown;
}

/**
 * The cache key.
 *
 * Everything a model would see goes in — the model itself, the instructions, the
 * facts, the schema it is constrained by and the bytes of any image — so two
 * requests can only share an answer if they would have produced the same one.
 * Hashing the built payload rather than the request is what guarantees that: the
 * key cannot miss a field the request would have sent.
 *
 * The task identifier is in the key as well as the payload. Two different tasks
 * can legitimately share their wording — the same register photographed for a
 * stock count and for an expiry sweep — and they are not the same question even
 * when they read the same, which is also why a fixture is filed under its task.
 */
function cacheKeyOf(task: string, payload: ModelInteractionRequest): string {
  return createHash('sha256')
    .update(task)
    .update('\u0000')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/** Describe why an answer was rejected, in the validator's own terms. */
function problemWith(
  text: string | undefined,
  schema: ReasoningRequest<unknown>['schema'],
): string {
  if (typeof text !== 'string' || text.trim() === '') {
    return 'the response carried no text';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `the response was not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return '';
  }

  return result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export class GeminiReasoningProvider implements ReasoningProvider {
  readonly kind = 'gemini';

  readonly #client: InteractionClient;
  readonly #maxAttempts: number;
  readonly #backoffMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedAnswer>();
  /** Insertion order is first-seen order, which is the order a surface lists them. */
  readonly #tasks = new Map<string, TaskCounters>();

  constructor(options: GeminiProviderOptions) {
    this.#client = options.client;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#backoffMs = Math.max(0, options.backoffMs ?? 250);
    this.#now = options.now ?? (() => Date.now());
  }

  async reason<T>(request: ReasoningRequest<T>): Promise<ReasoningResponse<T>> {
    const counters = this.#countersFor(request.task);
    counters.calls += 1;

    let payload: ModelInteractionRequest;
    try {
      payload = interactionRequestFor(request, this.#client.model);
    } catch (error) {
      // A schema zod cannot express as JSON schema is the caller's mistake, and
      // it is reported as such instead of becoming a request no model could obey.
      throw new ReasoningProviderError(
        `task "${request.task}" cannot be requested: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const key = cacheKeyOf(request.task, payload);
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      counters.cacheHits += 1;
      return {
        value: request.schema.parse(cached.value),
        provider: this.kind,
        model: this.#client.model,
        cacheHit: true,
      };
    }

    let problem = 'no attempt was made';
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const started = this.#now();
      counters.attempts += 1;

      let result: ModelInteractionResult;
      try {
        result = await this.#client.create(
          attempt === 1
            ? payload
            : // The retry carries the previous complaint so the second answer is a
              // correction rather than a re-roll.
              { ...payload, input: [...payload.input, correctionTextOf(problem)] },
        );
      } catch (error) {
        counters.totalDurationMs += this.#now() - started;
        counters.failures += 1;
        problem = `the provider failed: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt < this.#maxAttempts) {
          await delay(this.#backoffMs * 2 ** (attempt - 1));
        }
        continue;
      }

      counters.totalDurationMs += this.#now() - started;
      this.#recordUsage(counters, result.usage);

      problem = problemWith(result.output_text, request.schema);
      if (problem === '') {
        const value = request.schema.parse(JSON.parse(result.output_text ?? ''));
        this.#cache.set(key, { value });
        return { value, provider: this.kind, model: this.#client.model, cacheHit: false };
      }

      counters.failures += 1;
      if (attempt < this.#maxAttempts) {
        await delay(this.#backoffMs * 2 ** (attempt - 1));
      }
    }

    throw new ReasoningProviderError(
      `task "${request.task}" produced no schema-valid answer in ${this.#maxAttempts} attempt(s): ${problem}`,
    );
  }

  /**
   * A snapshot, not a live view: a caller reading it is not holding a moving number.
   *
   * The totals are summed here rather than kept alongside, so the number a surface
   * puts in its headline and the rows it lists underneath always add up.
   */
  telemetry(): ReasoningTelemetry {
    const perTask: ReasoningTaskTelemetry[] = [...this.#tasks].map(([task, counters]) => ({
      task,
      ...counters,
    }));

    return {
      model: this.#client.model,
      calls: sum(perTask, (task) => task.calls),
      attempts: sum(perTask, (task) => task.attempts),
      cacheHits: sum(perTask, (task) => task.cacheHits),
      failures: sum(perTask, (task) => task.failures),
      totalInputTokens: sumNullable(perTask, (task) => task.totalInputTokens),
      totalOutputTokens: sumNullable(perTask, (task) => task.totalOutputTokens),
      totalDurationMs: sum(perTask, (task) => task.totalDurationMs),
      perTask,
    };
  }

  #countersFor(task: string): TaskCounters {
    const existing = this.#tasks.get(task);
    if (existing !== undefined) {
      return existing;
    }

    const counters: TaskCounters = {
      calls: 0,
      attempts: 0,
      cacheHits: 0,
      failures: 0,
      totalInputTokens: null,
      totalOutputTokens: null,
      totalDurationMs: 0,
    };
    this.#tasks.set(task, counters);
    return counters;
  }

  #recordUsage(counters: TaskCounters, usage: ModelUsage | undefined): void {
    if (usage?.total_input_tokens !== undefined) {
      counters.totalInputTokens = (counters.totalInputTokens ?? 0) + usage.total_input_tokens;
    }
    if (usage?.total_output_tokens !== undefined) {
      counters.totalOutputTokens = (counters.totalOutputTokens ?? 0) + usage.total_output_tokens;
    }
  }
}

/** A total a reader can check against the rows it covers. */
function sum(
  tasks: readonly ReasoningTaskTelemetry[],
  of: (task: ReasoningTaskTelemetry) => number,
): number {
  return tasks.reduce((total, task) => total + of(task), 0);
}

/**
 * The same sum over a count a provider may not have reported.
 *
 * It stays `null` until something reports a number, and it stays `null` if any
 * task reported none: a partial total presented as a total is exactly the kind of
 * plausible-looking figure this platform refuses to publish. An adapter that has
 * been asked nothing has reported nothing either, which is why an empty set
 * answers `null` rather than `0`.
 */
function sumNullable(
  tasks: readonly ReasoningTaskTelemetry[],
  of: (task: ReasoningTaskTelemetry) => number | null,
): number | null {
  if (tasks.length === 0 || tasks.some((task) => of(task) === null)) {
    return null;
  }

  return tasks.reduce((total, task) => total + (of(task) ?? 0), 0);
}
