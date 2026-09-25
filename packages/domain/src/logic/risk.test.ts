import { describe, expect, it } from 'vitest';

import { RISK_DRIVERS } from '../model';
import type { RiskDriver } from '../model';
import { DRIVER_WEIGHTS, STALE_AFTER_DAYS, scoreRisk } from './risk';
import type { RiskFacts } from './risk';
import { FACILITY_A, ITEM_PARACETAMOL } from '../testing';

/**
 * Scoring risk.
 *
 * Two properties are asserted harder than the numbers themselves, because they
 * are the ones the phase treats as blocking: every one of the nine drivers must
 * appear and must move with its input, and a facility the platform cannot see
 * must not come out green.
 */

const SIMULATED = { kind: 'simulated', reference: 'fixture' } as const;

/** A well-supplied facility with current reporting and no surge. */
const healthy = (overrides: Partial<RiskFacts> = {}): RiskFacts => ({
  facilityId: FACILITY_A,
  itemId: ITEM_PARACETAMOL,
  asOf: '2026-06-30',
  horizonDays: 14,
  shortfallProbability: 0.04,
  // A month of cover against an eight-day wait: nothing to worry about.
  shortfallWindowDays: 8,
  daysOfStock: 45,
  onHand: 900,
  inTransit: 0,
  leadTimeDays: 8,
  leadTimeSpreadDays: 0,
  orderInFlight: false,
  essentiality: 'supplementary',
  catchmentPopulation: 25000,
  footfallTrend: 1,
  surge: null,
  daysToNearestExpiry: 300,
  nearExpiryUnits: 0,
  daysSinceReading: 0,
  reportingGapDays: 0,
  coldChain: false,
  coldChainBreachDays: null,
  synthetic: true,
  provenance: SIMULATED,
  ...overrides,
});

const detailFor = (facts: RiskFacts, driver: RiskDriver): string =>
  scoreRisk(facts).drivers.find((entry) => entry.driver === driver)?.detail ?? '';

const contributionFor = (facts: RiskFacts, driver: RiskDriver): number =>
  scoreRisk(facts).drivers.find((entry) => entry.driver === driver)?.contribution ?? 0;

describe('scoring a facility’s risk', () => {
  it('scores every one of the nine named drivers, whatever the inputs', () => {
    const score = scoreRisk(healthy());

    expect(score.drivers.map((entry) => entry.driver).sort()).toEqual([...RISK_DRIVERS].sort());
    expect(new Set(score.drivers.map((entry) => entry.driver)).size).toBe(RISK_DRIVERS.length);
  });

  it('never leaves a driver as an unexplained constant', () => {
    // Each driver is run at two settings that clearly differ, and both the
    // contribution and the sentence it prints must move. A driver that printed
    // the same text either way is a constant wearing a name.
    const cases: readonly (readonly [RiskDriver, RiskFacts, RiskFacts])[] = [
      ['daysOfStock', healthy({ daysOfStock: 40 }), healthy({ daysOfStock: 1.5 })],
      [
        'leadTime',
        healthy({ leadTimeDays: 5 }),
        healthy({ leadTimeDays: 18, leadTimeSpreadDays: 6 }),
      ],
      [
        'criticality',
        healthy({ essentiality: 'supplementary' }),
        healthy({ essentiality: 'essential' }),
      ],
      [
        'populationAtRisk',
        healthy({ catchmentPopulation: 3000, footfallTrend: 0.8 }),
        healthy({ catchmentPopulation: 400000, footfallTrend: 1.6 }),
      ],
      [
        'surgeSignal',
        healthy(),
        healthy({
          surge: { syndrome: 'fever', growthRate: 0.12, multiplier: 1.9, daysApplied: 14 },
        }),
      ],
      ['expiryPressure', healthy(), healthy({ daysToNearestExpiry: 5, nearExpiryUnits: 400 })],
      [
        'reportingGap',
        healthy({ daysSinceReading: 0 }),
        healthy({ daysSinceReading: 30, reportingGapDays: 20 }),
      ],
      ['coldChain', healthy(), healthy({ coldChain: true, coldChainBreachDays: 2 })],
      [
        'shortfallProbability',
        healthy({ shortfallProbability: 0.02 }),
        healthy({ shortfallProbability: 0.85 }),
      ],
    ];

    for (const [driver, low, high] of cases) {
      expect(contributionFor(high, driver)).toBeGreaterThan(contributionFor(low, driver));
      expect(detailFor(high, driver)).not.toEqual(detailFor(low, driver));
      expect(detailFor(high, driver).length).toBeGreaterThan(0);
    }
  });

  it('puts a well-supplied facility in the low band, and a forecast shortfall in a higher one', () => {
    expect(scoreRisk(healthy()).band).toBe('low');

    const atRisk = scoreRisk(
      healthy({
        shortfallProbability: 0.8,
        daysOfStock: 3,
        essentiality: 'essential',
        leadTimeDays: 14,
        leadTimeSpreadDays: 4,
        surge: { syndrome: 'fever', growthRate: 0.12, multiplier: 2.2, daysApplied: 14 },
      }),
    );

    expect(atRisk.riskIndex).toBeGreaterThan(scoreRisk(healthy()).riskIndex);
    expect(atRisk.band).toBe('critical');
  });

  it('keeps the measured probability and the composite index apart', () => {
    // The failure this exists to prevent: a composite of nine weights wearing the
    // label of a probability. The measured number is the forecast's and is passed
    // through untouched; the index is the sum, and it is never quoted as a chance.
    const measured = scoreRisk(healthy({ shortfallProbability: 0.31 }));

    expect(measured.shortfallProbability).toBe(0.31);
    expect(measured.riskIndex).not.toBeCloseTo(0.31, 2);

    // No forecast, no probability — and an index that still ranks and bands.
    const unmeasured = scoreRisk(healthy({ shortfallProbability: null }));

    expect(unmeasured.shortfallProbability).toBeNull();
    expect(unmeasured.riskIndex).toBeGreaterThan(0);
    expect(unmeasured.missing.join(' ')).toContain('no forecast');
  });

  it('raises a facility that has stopped reporting to unknown, not to green', () => {
    // The failure this exists to prevent: a shelf count from a fortnight ago
    // rendered as a clean bill of health.
    const silentFacts = healthy({ daysSinceReading: STALE_AFTER_DAYS + 10, reportingGapDays: 12 });
    const silent = scoreRisk(silentFacts);

    expect(silent.band).toBe('unknown');
    expect(silent.drivers[0]?.detail).toContain('nothing has arrived');
    expect(silent.missing).toEqual([]);

    // The gap raises what the score says about the silence, and deliberately does
    // not move the index: the index describes a shelf, and nobody has seen this
    // one. Blindness is carried by the band, which is what a list sorts on and
    // what puts this pair at the top beside the critical ones.
    expect(contributionFor(silentFacts, 'reportingGap')).toBeGreaterThan(
      contributionFor(healthy(), 'reportingGap'),
    );
    expect(silent.riskIndex).toBe(scoreRisk(healthy()).riskIndex);
  });

  it('still says unknown when cover could not be measured at all', () => {
    const unmeasured = scoreRisk(
      healthy({ daysOfStock: null, shortfallProbability: null, footfallTrend: null }),
    );

    expect(unmeasured.band).toBe('unknown');
    expect(unmeasured.missing.join(' ')).toContain('no forecast');
    expect(unmeasured.missing.join(' ')).toContain('demand rate');
  });

  it('lets a measured critical probability outrank a data-quality caveat', () => {
    // A caveat must not silence a real signal: a stale facility whose last
    // measurement was alarming is still critical.
    const staleAndCritical = scoreRisk(
      healthy({
        daysSinceReading: STALE_AFTER_DAYS + 2,
        shortfallProbability: 0.95,
        daysOfStock: 0.5,
        onHand: 0,
        essentiality: 'essential',
        leadTimeDays: 14,
      }),
    );

    expect(staleAndCritical.band).toBe('critical');
  });

  it('bands on the shelf and not on what the item and the district are like', () => {
    // The generated world measured this directly: across a quiet year, a monsoon
    // surge and an expiry cliff, the context drivers were identical to two decimal
    // places. A band that moved with them would be reporting the catalogue and the
    // network rather than the state of anybody's shelf.
    const plain = scoreRisk(healthy({ shortfallProbability: 0.7, daysOfStock: 2 }));
    const elaborate = scoreRisk(
      healthy({
        shortfallProbability: 0.7,
        daysOfStock: 2,
        essentiality: 'essential',
        catchmentPopulation: 400000,
        footfallTrend: 1.5,
        leadTimeDays: 18,
        coldChain: true,
        coldChainBreachDays: 1,
      }),
    );

    expect(elaborate.riskIndex).toBe(plain.riskIndex);
    expect(elaborate.band).toBe(plain.band);
    // Still on the score, for the officer deciding whether to move stock.
    expect(elaborate.drivers).not.toEqual(plain.drivers);
  });

  it('lets a shelf driver decide the band', () => {
    expect(scoreRisk(healthy({ shortfallProbability: 0.9, daysOfStock: 1 })).band).toBe('critical');
    expect(scoreRisk(healthy({ shortfallProbability: 0.01, daysOfStock: 90 })).band).toBe('low');
  });

  it('records the inputs it used and the ones it could not get', () => {
    const score = scoreRisk(healthy({ daysOfStock: 12, onHand: 240 }));

    expect(score.facts.find((fact) => fact.name === 'daysOfStock')?.value).toBe(12);
    expect(score.facts.find((fact) => fact.name === 'onHand')?.value).toBe(240);
    // Nothing is missing here, and an empty list is a statement rather than an
    // omission: every input the score wanted, it got.
    expect(score.missing).toEqual([]);
  });

  it('weighs a facility with no history at all at the top of the reporting driver', () => {
    const facts = healthy({
      daysSinceReading: null,
      daysOfStock: null,
      shortfallProbability: null,
    });

    expect(contributionFor(facts, 'reportingGap')).toBe(DRIVER_WEIGHTS.reportingGap);
    expect(scoreRisk(facts).missing.join(' ')).toContain('never reported');
  });
});
