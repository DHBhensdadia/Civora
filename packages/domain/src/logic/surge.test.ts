import { describe, expect, it } from 'vitest';

import { addDays } from './dates';
import { demandLiftFor } from './case-demand';
import { detectSurge, exponentialGrowthRate, fitReportingPattern } from './surge';
import type { SyndromeDay } from './surge';
import { anItem } from '../testing';

/**
 * The surge pipeline.
 *
 * The cases that matter are the two the phase names: a scripted outbreak must be
 * found, and a district having an ordinary week must not be. Both are written as
 * whole series rather than as calls to the parts, because a detector is only as
 * good as its false-alarm rate and no individual statistic carries that.
 */

const FROM = '2026-06-01';

/** A series of counts, one a day from `FROM`. */
const seriesOf = (counts: readonly number[]): SyndromeDay[] =>
  counts.map((caseCount, index) => ({ on: addDays(FROM, index), caseCount }));

/**
 * Seventy days of a normal week, then a fever outbreak.
 *
 * The baseline carries the two things the de-noising exists for: Sundays are
 * quiet, and the counts drift up slowly through the monsoon. The outbreak grows
 * at twelve percent a day for three weeks, which is the shape of a real one and
 * roughly a hundredfold over the window.
 */
const baseline = (days: number): number[] =>
  Array.from({ length: days }, (_, index) => {
    const weekday = (index + 1) % 7;
    const weekend = weekday === 0 || weekday === 6 ? 0.55 : 1.05;
    return Math.round(9 * weekend * (1 + index * 0.004));
  });

const outbreak = (days: number, from: number): number[] =>
  Array.from({ length: days }, (_, index) =>
    Math.round(from * Math.pow(1.12, index) * (index % 7 === 0 ? 0.6 : 1.05)),
  );

describe('de-noising a facility’s own reporting pattern', () => {
  it('finds the weekly shape it was fitted on, and leaves the mean where it was', () => {
    const pattern = fitReportingPattern(seriesOf(baseline(84)));

    // Sunday is index zero of the weekday factor, and the baseline makes it the
    // quiet day. The correction must not move the overall level: the CUSUM test
    // measures against that level, so a correction that shifted it would detect
    // its own adjustment.
    expect(pattern.weekday[0]).toBeLessThan(pattern.weekday[3] ?? 0);
    // The settled level of the baseline, which is the number the excess is
    // measured against — not the level the outbreak dragged the mean to.
    expect(pattern.overallMean).toBeGreaterThan(8);
    expect(pattern.overallMean).toBeLessThan(12);
  });
});

describe('detecting an epidemic surge', () => {
  const calm = seriesOf(baseline(90));
  const surging = seriesOf([...baseline(70), ...outbreak(20, 12)]);

  it('finds the scripted outbreak, dates the run, and estimates its growth', () => {
    const detection = detectSurge({ syndrome: 'fever', days: surging });

    expect(detection.detected).toBe(true);
    expect(detection.method).toBe('cusum');
    // The run began when the counts left the pattern, which is in the last
    // twenty days — not at the start of the history.
    expect(detection.detectedOn > addDays(FROM, 60)).toBe(true);
    expect(detection.growthRate).toBeGreaterThan(0.05);
    expect(detection.excessCasesPerDay).toBeGreaterThan(3);
    expect(detection.observedCaseCount).toBeGreaterThan(detection.baselineCaseCount);
    expect(detection.reasons).toEqual([]);
  });

  it('says nothing at all about a district having an ordinary season', () => {
    const detection = detectSurge({ syndrome: 'fever', days: calm });

    expect(detection.detected).toBe(false);
    // A non-detection has to be able to explain itself, or a quiet district and
    // an unwatched one look identical.
    expect(detection.reasons.length).toBeGreaterThan(0);
    expect(detection.reasons.join(' ')).toMatch(/crossed|growing|excess/);
  });

  it('refuses to judge a history too short to have a pattern', () => {
    const detection = detectSurge({ syndrome: 'fever', days: seriesOf(outbreak(14, 12)) });

    expect(detection.detected).toBe(false);
    expect(detection.reasons.join(' ')).toContain('28');
    expect(detection.diagnostics).toEqual([]);
  });

  it('does not call a single bad day an outbreak', () => {
    // One clinic double-counting its register, on top of an ordinary season.
    const counts = baseline(90);
    counts[88] = 60;

    const detection = detectSurge({ syndrome: 'fever', days: seriesOf(counts) });

    expect(detection.detected).toBe(false);
  });

  it('keeps the per-day diagnostics, so the trajectory can be read', () => {
    const detection = detectSurge({ syndrome: 'fever', days: surging });

    expect(detection.diagnostics).toHaveLength(surging.length);
    const crossing = detection.diagnostics.find((day) => day.on === detection.detectedOn);
    expect(crossing?.cusum).toBeGreaterThan(0);
    expect(detection.diagnostics.every((day) => day.cusum >= 0)).toBe(true);
  });
});

describe('estimating growth on case counts', () => {
  it('recovers a known exponential rate', () => {
    const counts = Array.from({ length: 20 }, (_, index) => Math.round(10 * Math.pow(1.1, index)));
    expect(exponentialGrowthRate(seriesOf(counts))).toBeCloseTo(0.1, 1);
  });

  it('reports a flat series as flat, and a series of zeros as flat rather than undefined', () => {
    expect(exponentialGrowthRate(seriesOf(Array.from({ length: 30 }, () => 12)))).toBeCloseTo(0, 3);
    expect(exponentialGrowthRate(seriesOf(Array.from({ length: 30 }, () => 0)))).toBe(0);
  });
});

describe('turning a surge into a demand lift', () => {
  const detection = detectSurge({
    syndrome: 'fever',
    days: seriesOf([...baseline(70), ...outbreak(20, 12)]),
  });

  it('adds units at the item’s documented rate per case, and shows the working', () => {
    const item = anItem({ syndromes: ['fever'], unitsPerCase: 3.5 });
    const routine = 200;
    const lift = demandLiftFor({
      item,
      syndrome: 'fever',
      detection,
      routineDailyDemand: routine,
      horizonFrom: FROM,
      horizonDays: 7,
    });

    expect(lift.surgeSensitive).toBe(true);
    expect(lift.capped).toBe(false);
    expect(lift.addedUnitsPerDay).toBeCloseTo(detection.excessCasesPerDay * 3.5, 6);
    expect(lift.multiplier).toBeGreaterThan(1);
    expect(lift.multiplier).toBeCloseTo((routine + detection.excessCasesPerDay * 3.5) / routine, 6);
    expect(lift.daysApplied).toBe(7);
    expect(lift.reason).toContain('units a case');
  });

  it('leaves an item that does not treat the syndrome alone', () => {
    // A fever surge is not a reason to order insulin, and a pipeline that lifts
    // every item would spread a real signal across the whole catalogue.
    const item = anItem({ syndromes: ['diarrhoea'], unitsPerCase: 2.4 });
    const lift = demandLiftFor({
      item,
      syndrome: 'fever',
      detection,
      routineDailyDemand: 40,
      horizonFrom: FROM,
      horizonDays: 7,
    });

    expect(lift.multiplier).toBe(1);
    expect(lift.addedUnitsPerDay).toBe(0);
    expect(lift.daysApplied).toBe(0);
    expect(lift.surgeSensitive).toBe(false);
  });

  it('caps the multiplier and says that it did', () => {
    const item = anItem({ syndromes: ['fever'], unitsPerCase: 3.5 });
    const lift = demandLiftFor({
      item,
      syndrome: 'fever',
      detection,
      // A base so small that the surplus is many times it.
      routineDailyDemand: 20,
      horizonFrom: FROM,
      horizonDays: 7,
    });

    expect(lift.capped).toBe(true);
    expect(lift.multiplier).toBe(3);
    expect(lift.reason).toContain('capped');
    // The surplus is still reported in units, so the cap understates the ratio
    // without hiding the quantity.
    expect(lift.addedUnitsPerDay).toBeGreaterThan(0);
  });

  it('applies no lift when nothing was detected', () => {
    const calm = detectSurge({ syndrome: 'fever', days: seriesOf(baseline(90)) });
    const lift = demandLiftFor({
      item: anItem({ syndromes: ['fever'], unitsPerCase: 3.5 }),
      syndrome: 'fever',
      detection: calm,
      routineDailyDemand: 40,
      horizonFrom: FROM,
      horizonDays: 7,
    });

    expect(lift.multiplier).toBe(1);
    expect(lift.reason).toContain('no surge');
  });
});
