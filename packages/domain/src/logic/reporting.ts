import type { DateOnly, FacilityId, Provenance } from '../model/common';
import { reportingGapSchema } from '../model/derived';
import type { ReportingDomain, ReportingGap } from '../model/derived';
import { compareDateOnly, eachDay } from './dates';

export interface ReportingGapOptions {
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Days on which at least one observation arrived from the facility. */
  readonly reportedDays: readonly DateOnly[];
  /** Which observations are expected to arrive. */
  readonly missing: readonly ReportingDomain[];
  /**
   * Consecutive silent days tolerated before a gap is raised. Defaults to one,
   * because a facility with intermittent connectivity misses the occasional
   * day without anything being wrong.
   */
  readonly toleranceDays?: number;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

/**
 * Periods for which the platform received nothing.
 *
 * This is the record that stops an absence of data being read as good news. A
 * facility that stopped reporting does not have empty beds and full shelves;
 * it has unknown beds and unknown shelves, and an officer needs to see the
 * difference before deciding whether to send stock or a supervisor.
 */
export function detectReportingGaps(
  facilityId: FacilityId,
  options: ReportingGapOptions,
): readonly ReportingGap[] {
  const toleranceDays = options.toleranceDays ?? 1;
  const reported = new Set(options.reportedDays);
  const expected = eachDay(options.from, options.to);
  const gaps: ReportingGap[] = [];

  let runStartIndex = -1;
  let runEndIndex = -1;

  const consider = (startIndex: number, endIndex: number): void => {
    const length = endIndex - startIndex + 1;
    if (length <= toleranceDays) {
      return;
    }

    const first = expected[startIndex];
    const last = expected[endIndex];
    if (first === undefined || last === undefined) {
      return;
    }

    // A gap that reaches the end of the observed window has not ended, and
    // saying otherwise would imply the facility came back.
    const stillOpen = endIndex === expected.length - 1;

    gaps.push(
      reportingGapSchema.parse({
        facilityId,
        from: first,
        to: stillOpen ? null : last,
        days: length,
        missing: options.missing,
        synthetic: options.synthetic,
        provenance: options.provenance,
      }),
    );
  };

  for (let index = 0; index < expected.length; index += 1) {
    const day = expected[index];
    if (day === undefined) {
      continue;
    }

    if (!reported.has(day)) {
      if (runStartIndex === -1) {
        runStartIndex = index;
      }
      runEndIndex = index;
      continue;
    }

    if (runStartIndex !== -1) {
      consider(runStartIndex, runEndIndex);
      runStartIndex = -1;
      runEndIndex = -1;
    }
  }

  if (runStartIndex !== -1) {
    consider(runStartIndex, runEndIndex);
  }

  return gaps;
}

/**
 * The most recent day the facility reported anything, as of a given date.
 *
 * Used to decide whether a snapshot may be shown as current. A position whose
 * last evidence predates the snapshot date is stale, and a stale position must
 * be rendered as stale rather than as the latest known value.
 */
export function lastReportedDay(
  reportedDays: readonly DateOnly[],
  asOf: DateOnly,
): DateOnly | null {
  let latest: DateOnly | null = null;
  for (const day of reportedDays) {
    if (compareDateOnly(day, asOf) > 0) {
      continue;
    }
    if (latest === null || compareDateOnly(day, latest) > 0) {
      latest = day;
    }
  }
  return latest;
}
