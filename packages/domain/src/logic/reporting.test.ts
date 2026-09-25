import { describe, expect, it } from 'vitest';

import { SIMULATED_PROVENANCE } from '../model/common';
import { FACILITY_A } from '../testing/factories';
import { eachDay } from './dates';
import { detectReportingGaps, lastReportedDay } from './reporting';

/**
 * A facility that has stopped reporting is not a facility with nothing to
 * report. These tests hold the platform to that distinction, because the
 * opposite reading is what turns silence into a falsely reassuring dashboard.
 */

const FROM = '2026-01-01';
const TO = '2026-01-10';

const allDays = eachDay(FROM, TO);

const options = (reportedDays: readonly string[], toleranceDays?: number) => ({
  from: FROM,
  to: TO,
  reportedDays,
  missing: ['stock'] as const,
  synthetic: true,
  provenance: SIMULATED_PROVENANCE,
  ...(toleranceDays === undefined ? {} : { toleranceDays }),
});

const without = (...silent: readonly string[]): string[] =>
  allDays.filter((day) => !silent.includes(day));

describe('detecting reporting gaps', () => {
  it('does not raise a gap for the occasional missed day', () => {
    // Intermittent connectivity is the normal condition, and a platform that
    // alarms on every missed day teaches its users to ignore it.
    expect(detectReportingGaps(FACILITY_A, options(without('2026-01-05')))).toEqual([]);
  });

  it('raises one gap for a run of silent days, with its length and its last day', () => {
    const gaps = detectReportingGaps(FACILITY_A, options(without('2026-01-05', '2026-01-06')));

    expect(gaps).toHaveLength(1);
    expect(gaps.at(0)?.from).toBe('2026-01-05');
    expect(gaps.at(0)?.to).toBe('2026-01-06');
    expect(gaps.at(0)?.days).toBe(2);
    expect(gaps.at(0)?.missing).toEqual(['stock']);
  });

  it('leaves a gap open when the silence runs to the end of the window', () => {
    // Saying otherwise would imply the facility came back.
    const gaps = detectReportingGaps(FACILITY_A, options(without('2026-01-09', '2026-01-10')));

    expect(gaps).toHaveLength(1);
    expect(gaps.at(0)?.from).toBe('2026-01-09');
    expect(gaps.at(0)?.to).toBeNull();
    expect(gaps.at(0)?.days).toBe(2);
  });

  it('raises a gap for a single silent day when no tolerance is allowed', () => {
    const gaps = detectReportingGaps(FACILITY_A, options(without('2026-01-05'), 0));

    expect(gaps).toHaveLength(1);
    expect(gaps.at(0)?.days).toBe(1);
  });

  it('tolerates a longer silence when the facility is known to be remote', () => {
    const silent = without('2026-01-04', '2026-01-05');

    expect(detectReportingGaps(FACILITY_A, options(silent, 2))).toEqual([]);
  });

  it('still raises a gap when the silence exceeds the tolerance', () => {
    const silent = without('2026-01-04', '2026-01-05', '2026-01-06');

    const gaps = detectReportingGaps(FACILITY_A, options(silent, 2));
    expect(gaps).toHaveLength(1);
    expect(gaps.at(0)?.days).toBe(3);
  });

  it('reports nothing for a facility that reported every day', () => {
    expect(detectReportingGaps(FACILITY_A, options([...allDays]))).toEqual([]);
  });
});

describe('the most recent day a facility reported', () => {
  it('ignores observations dated after the reference day', () => {
    // A position whose last evidence predates its snapshot is stale, and stale
    // is not the same as current.
    const reported = ['2026-01-03', '2026-01-08'];

    expect(lastReportedDay(reported, '2026-01-05')).toBe('2026-01-03');
    expect(lastReportedDay(reported, '2026-01-08')).toBe('2026-01-08');
  });

  it('reports an unknown last day rather than inventing one', () => {
    expect(lastReportedDay([], '2026-01-05')).toBeNull();
    expect(lastReportedDay(['2026-01-06'], '2026-01-05')).toBeNull();
  });
});
