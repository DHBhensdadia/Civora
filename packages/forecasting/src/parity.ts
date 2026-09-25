import type { DateOnly, FacilityId, ItemId } from '@civora/domain';

import { forecastDemand } from './engine';
import type { EngineOptions } from './engine';
import type { BacktestSeries } from './backtest';
import type { ForecastBackend } from './bqml';

/**
 * Running two backends over the same days and reporting where they disagree.
 *
 * The phase asks for backend parity, and the honest version of that request is
 * not "do they agree" — two forecasting systems never agree exactly, and a
 * harness that reported a single average would hide the cases that matter. What
 * is reported here instead:
 *
 *  - **How many origins disagreed, and by how much**, with the distribution
 *    rather than the mean, because a handful of wild disagreements and a
 *    uniform small offset are different problems with different fixes.
 *  - **Where the two point in different directions** — one forecasting a rise
 *    where the other forecasts a fall — because those are the origins where an
 *    officer's decision would actually change.
 *  - **What was compared.** A parity figure computed over recorded fixture rows
 *    is evidence that the adapter works and no evidence at all about BigQuery's
 *    forecasts. The report carries which it is in a field of its own, so a
 *    reader cannot merge the two.
 *
 * Nothing here reconciles the two backends. Picking the average of two models
 * because they disagree is how a system acquires a number neither model
 * supports and nobody can reproduce.
 */

export interface BackendDisagreement {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly asOf: DateOnly;
  readonly other: number;
  readonly stat: number;
  /** One minus the smaller over the larger, so zero is perfect agreement. */
  readonly relativeGap: number;
  /** True when the two disagree about the direction of demand. */
  readonly signConflict: boolean;
}

export interface BackendParity {
  readonly backend: string;
  /** False when the second backend could not be run at all. */
  readonly executed: boolean;
  /** Why not, when it was not. Empty when it ran. */
  readonly reason: string;
  /** What the numbers below were computed on. Never silently assumed. */
  readonly basis: string;
  readonly origins: number;
  readonly meanRelativeGap: number;
  readonly medianRelativeGap: number;
  /** Share of origins where the two medians agreed within ten percent. */
  readonly agreeWithinTenPercent: number;
  /** Share of the horizon on which one backend forecasts a rise and the other a fall. */
  readonly signConflicts: number;
  /** The widest disagreements, so the report can name them rather than average them. */
  readonly worst: readonly BackendDisagreement[];
}

export interface ParityInput {
  readonly entries: readonly BacktestSeries[];
  readonly options: {
    readonly horizonDays: number;
    readonly strideDays: number;
    readonly minimumHistoryDays: number;
    readonly maxOriginsPerSeries: number;
    readonly bootstrapReplications: number;
    readonly seasonLength: number;
  };
  /** The backend being compared with the local engine. */
  readonly backend: ForecastBackend;
  /** What the second backend's numbers came from. Stated, never inferred. */
  readonly basis: string;
  /** Origins to compare over. Comparing thousands of them proves nothing extra. */
  readonly maxOrigins?: number;
  readonly engineOptions?: EngineOptions;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return Number.isInteger(middle)
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[Math.floor(middle)] ?? 0);
};

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

/** Relative gap between two non-negative forecasts, bounded at one. */
const gapBetween = (left: number, right: number): number => {
  const largest = Math.max(left, right);
  if (largest <= 0) {
    return 0;
  }
  return 1 - Math.min(left, right) / largest;
};

/** Whether a series of values is rising, falling or flat. */
const directionOf = (values: readonly number[]): number => {
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  if (Math.abs(last - first) < 1e-9) {
    return 0;
  }
  return last > first ? 1 : -1;
};

export async function compareBackends(input: ParityInput): Promise<BackendParity> {
  const { backend } = input;
  const maxOrigins = input.maxOrigins ?? 60;

  if (!backend.available) {
    return {
      backend: backend.name,
      executed: false,
      reason: backend.unavailableReason,
      basis: input.basis,
      origins: 0,
      meanRelativeGap: 0,
      medianRelativeGap: 0,
      agreeWithinTenPercent: 0,
      signConflicts: 0,
      worst: [],
    };
  }

  const gaps: number[] = [];
  const disagreements: BackendDisagreement[] = [];
  let signConflicts = 0;

  for (const entry of input.entries) {
    if (gaps.length >= maxOrigins) {
      break;
    }

    const { series } = entry;
    const lastUsable = series.points.length - input.options.horizonDays - 1;
    if (lastUsable < input.options.minimumHistoryDays) {
      continue;
    }

    const origin = lastUsable;
    const asOf = series.points[origin]?.on;
    if (asOf === undefined) {
      continue;
    }

    const history = { ...series, points: series.points.slice(0, origin + 1) };
    const request = {
      facilityId: series.facilityId,
      itemId: series.itemId,
      asOf,
      horizonDays: input.options.horizonDays,
      seed: `parity:${series.facilityId}:${series.itemId}`,
      synthetic: true,
      provenance: { kind: 'derived', reference: 'backend-parity' } as const,
    };

    const stat = forecastDemand(history, request, {
      bootstrapReplications: input.options.bootstrapReplications,
      seasonLength: input.options.seasonLength,
      ...input.engineOptions,
    });
    const other = await backend.forecast(history, request, input.engineOptions);

    const statMedian = stat.forecast.p50[0] ?? 0;
    const otherMedian = other.forecast.p50[0] ?? 0;
    const relativeGap = gapBetween(statMedian, otherMedian);
    gaps.push(relativeGap);

    // A direction conflict is about the shape of the horizon, not its level: a
    // model that forecasts a rise into a shortage where the other forecasts a
    // slide is the case where a decision would differ.
    if (directionOf(stat.forecast.p50) * directionOf(other.forecast.p50) < 0) {
      signConflicts += 1;
    }

    disagreements.push({
      facilityId: series.facilityId,
      itemId: series.itemId,
      asOf,
      stat: statMedian,
      other: otherMedian,
      relativeGap,
      signConflict: directionOf(stat.forecast.p50) * directionOf(other.forecast.p50) < 0,
    });
  }

  return {
    backend: backend.name,
    executed: true,
    reason: '',
    basis: input.basis,
    origins: gaps.length,
    meanRelativeGap: mean(gaps),
    medianRelativeGap: median(gaps),
    agreeWithinTenPercent:
      gaps.length === 0 ? 0 : gaps.filter((gap) => gap <= 0.1).length / gaps.length,
    signConflicts,
    worst: [...disagreements]
      .sort((left, right) => right.relativeGap - left.relativeGap)
      .slice(0, 5),
  };
}
