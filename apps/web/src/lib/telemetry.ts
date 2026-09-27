import type { ReasoningTelemetry } from '@civora/domain';

/**
 * What the reasoning layer has been asked to do, as a reader should see it.
 *
 * The numbers here are **counted at the call** by the adapter itself — nothing
 * on this page is estimated from document counts or inferred from a pricing
 * page. That distinction is the whole point of the panel: the ceiling on this
 * project is a free tier plus a per-day rate limit, and a platform that cannot
 * say what it spent cannot tell a user whether the next burst will fit.
 *
 * Three claims are kept apart here, because a panel that blurs them is worse
 * than no panel:
 *
 *  - **Reported.** An adapter may keep no count at all. That is not zero calls;
 *    it is an adapter that cannot answer, and it is rendered as exactly that.
 *  - **Null.** A token count the provider did not return stays `null` — never a
 *    `0` standing in for an unknown quantity. A reader who sees `0 tokens`
 *    believes a measurement was taken and came out empty.
 *  - **Measured versus projected.** The counters are measurements of this
 *    process. The volume figures are arithmetic over the current inbox, labelled
 *    as a projection: what a pass *would* cost, not what one did.
 *
 * The projection is derived rather than stated as a constant because the inbox
 * is not a constant: the alert set moves as alerts are acknowledged and resolved,
 * and a hardcoded "6 requests per day" would be right only until somebody moved
 * an alert.
 */

/** One task's counts, named the way a person reads them. */
export interface TaskTelemetryView {
  /** The task identifier: `stock-extraction@1`, `advisory-generation@2`, … */
  readonly task: string;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
  /** Time spent waiting on the provider per request, or `null` if nothing ran. */
  readonly meanRequestMs: number | null;
}

/** What one burst would cost, derived from what is in the inbox right now. */
export interface VolumeProjection {
  /** Alerts whose bodies would be written — the set the batch step walks. */
  readonly alerts: number;
  /** Languages the alert records carry, which are the ones written for. */
  readonly languages: number;
  /**
   * Requests one full advisory pass costs: every alert, in every language the
   * record carries. Paid once per pass, not once per reader, which is the whole
   * reason the bodies are written ahead of the burst.
   */
  readonly advisoryPass: number;
  /**
   * Requests one capture costs — a photograph and a recording are one request
   * each. Retries are not estimated here: a retry happened or it did not, and
   * when it did it is in `attempts` above.
   */
  readonly perCapture: number;
}

export interface TelemetryView {
  /** The configured adapter. Beside the numbers, because they are its numbers. */
  readonly provider: string;
  /** The model it sends to, or `null` when it sends nowhere. */
  readonly model: string | null;
  /** Whether this adapter keeps a count at all. */
  readonly reported: boolean;
  readonly calls: number;
  readonly attempts: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
  readonly meanRequestMs: number | null;
  /** Per task, in the order each task was first seen. */
  readonly perTask: readonly TaskTelemetryView[];
  readonly projection: VolumeProjection;
  /** When this snapshot was taken. The counters keep moving; this did not. */
  readonly readAt: string;
}

/** The empty view: an adapter that keeps no count rather than one that did nothing. */
const NOTHING_REPORTED = {
  calls: 0,
  attempts: 0,
  cacheHits: 0,
  failures: 0,
  inputTokens: null,
  outputTokens: null,
  durationMs: 0,
  meanRequestMs: null,
} as const;

/**
 * Mean time per request, or `null` when there were no requests.
 *
 * Dividing by zero would produce `NaN`, which reaches a surface as "NaN ms" — a
 * number-shaped thing that is not a number. `null` says what is true: no request
 * has been made, so there is no mean.
 */
function meanRequestMsOf(durationMs: number, calls: number): number | null {
  return calls === 0 ? null : Math.round(durationMs / calls);
}

export function volumeProjectionOf(alerts: number, languages: readonly string[]): VolumeProjection {
  return {
    alerts,
    languages: languages.length,
    advisoryPass: alerts * languages.length,
    perCapture: 1,
  };
}

export function telemetryViewOf(input: {
  readonly provider: string;
  /** `null` when the adapter keeps no count. */
  readonly telemetry: ReasoningTelemetry | null;
  readonly alerts: number;
  readonly languages: readonly string[];
  readonly readAt: string;
}): TelemetryView {
  const projection = volumeProjectionOf(input.alerts, input.languages);

  if (input.telemetry === null) {
    return {
      provider: input.provider,
      model: null,
      reported: false,
      ...NOTHING_REPORTED,
      perTask: [],
      projection,
      readAt: input.readAt,
    };
  }

  const telemetry = input.telemetry;

  return {
    provider: input.provider,
    model: telemetry.model,
    reported: true,
    calls: telemetry.calls,
    attempts: telemetry.attempts,
    cacheHits: telemetry.cacheHits,
    failures: telemetry.failures,
    inputTokens: telemetry.totalInputTokens,
    outputTokens: telemetry.totalOutputTokens,
    durationMs: telemetry.totalDurationMs,
    meanRequestMs: meanRequestMsOf(telemetry.totalDurationMs, telemetry.calls),
    perTask: telemetry.perTask.map((task) => ({
      task: task.task,
      calls: task.calls,
      attempts: task.attempts,
      cacheHits: task.cacheHits,
      failures: task.failures,
      inputTokens: task.totalInputTokens,
      outputTokens: task.totalOutputTokens,
      durationMs: task.totalDurationMs,
      meanRequestMs: meanRequestMsOf(task.totalDurationMs, task.calls),
    })),
    projection,
    readAt: input.readAt,
  };
}
