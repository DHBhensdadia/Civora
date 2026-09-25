import { daysBetween } from '@civora/domain';
import { describe, expect, it } from 'vitest';

import {
  DEMO_NETWORK_OPTIONS,
  DEMO_SEED,
  buildNetwork,
  historySample,
  scorePopulation,
  simulateNetwork,
} from './index';
import type { Simulation } from './simulation';

/**
 * The pipeline against the world's own negative controls.
 *
 * The generated dataset ships scenarios with nothing wrong in them, and their
 * stated expectation is that a platform finds nothing in a quiet year. Pointing
 * the whole pipeline — surge detection, the demand lift, the nine-driver score,
 * the alert rules — at that world is the cheapest honest test of this phase, and
 * it has already earned its keep twice: it is what showed that stock already in
 * transit was being ignored, and that the forecast was being asked whether a
 * facility would survive a fortnight without ever reordering.
 *
 * The counts below are asserted rather than described because a test that says
 * "no alerts" passes just as well when the pipeline is broken and raises nothing.
 * The measurements the assertions rest on are in `docs/EVALUATION.md` and in the
 * commit that introduced them.
 */

/** One facility per region, so the whole test runs in a couple of seconds. */
const sample = (network = buildNetwork(DEMO_NETWORK_OPTIONS)) => historySample(network, 1);

/** Fewer replications than the batch job: the point here is the alarms, not the quantile. */
const OPTIONS = { horizonDays: 14, bootstrapReplications: 40 } as const;

const network = buildNetwork(DEMO_NETWORK_OPTIONS);

describe('a world with nothing wrong in it', () => {
  const simulation = simulateNetwork(network, {
    seed: DEMO_SEED,
    scenarioId: 'stable-baseline',
    facilityIds: sample(network),
  });
  const scored = scorePopulation(simulation, network, OPTIONS);

  it('is a scenario the platform is meant to find nothing in', () => {
    expect(simulation.scenario.id).toBe('stable-baseline');
    expect(simulation.scenario.negativeControl).toBe(true);
  });

  it('raises no epidemic event, and lifts no forecast for one', () => {
    expect(scored.assessments.length).toBeGreaterThan(0);
    expect(scored.epidemicEvents).toEqual([]);
    expect(scored.liftedForecasts).toBe(0);
    expect(scored.assessments.every((assessment) => assessment.lift.multiplier === 1)).toBe(true);
  });

  it('puts almost every pair in the low band, and alerts on almost none of them', () => {
    const bands = new Map<string, number>();
    for (const assessment of scored.assessments) {
      bands.set(assessment.risk.band, (bands.get(assessment.risk.band) ?? 0) + 1);
    }

    const pairs = scored.assessments.length;
    const alerted = scored.alerts.length;

    // Measured 2026-09-25 on this profile: 692 of 789 low, 91 watch, 4 high and
    // 2 critical, with six alerts. The bands are not zero, because a quiet year
    // still has pairs holding less than the wait for a delivery, and the
    // assertion is that they are a handful rather than a third of the catalogue.
    expect((bands.get('low') ?? 0) / pairs).toBeGreaterThan(0.8);
    expect(alerted).toBeLessThanOrEqual(10);
    expect(alerted).toBeLessThan(pairs * 0.02);
  });
});

describe('a world with a monsoon surge in it', () => {
  const simulation = simulateNetwork(network, {
    seed: DEMO_SEED,
    facilityIds: sample(network),
  });
  const scored = scorePopulation(simulation, network, OPTIONS);

  it('detects the surge, lifts demand for it and raises alerts', () => {
    expect(simulation.scenario.id).toBe('monsoon-fever-surge');
    expect(scored.epidemicEvents.length).toBeGreaterThan(0);
    expect(scored.liftedForecasts).toBeGreaterThan(0);
    expect(scored.alerts.length).toBeGreaterThan(0);
    expect(scored.alerts.every((alert) => alert.state === 'raised')).toBe(true);
  });

  it('gives every alert the evidence behind it, ordered by what moved the number', () => {
    const alert = scored.alerts[0];

    expect(alert).toBeDefined();
    if (alert === undefined) {
      return;
    }

    expect(alert.drivers.length).toBeGreaterThanOrEqual(9);
    expect(alert.facts.length).toBeGreaterThan(0);
    // The narrative Phase 5 writes is grounded on `facts`, so the index the band
    // was chosen from, the window the probability was measured over and the
    // batch position all have to be there.
    for (const name of ['riskIndex', 'daysOfStock', 'shortfallWindowDays']) {
      expect(alert.facts.map((fact) => fact.name)).toContain(name);
    }

    for (let index = 1; index < alert.drivers.length; index += 1) {
      expect(alert.drivers[index]?.contribution ?? 0).toBeLessThanOrEqual(
        alert.drivers[index - 1]?.contribution ?? 0,
      );
    }
    // A driver that cannot name the number it used is not a driver.
    expect(alert.drivers.every((driver) => driver.detail.trim().length > 20)).toBe(true);
    // The reason in the body is a measured quantity rather than "this is
    // critical", which is what an officer opening the row needs to read.
    expect(alert.bodies.en?.length ?? 0).toBeGreaterThan(40);
  });

  it('raises one alert per condition, so a re-run cannot multiply them', () => {
    const keys = scored.alerts.map((alert) => alert.dedupeKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.includes('|'))).toBe(true);
  });

  it('keeps the probability the forecast measured and the index the band came from apart', () => {
    const measured = scored.assessments.filter(
      (assessment) => assessment.risk.shortfallProbability !== null,
    );

    expect(measured.length).toBeGreaterThan(0);
    expect(
      measured.every(
        (assessment) =>
          assessment.risk.shortfallProbability !== null &&
          Math.abs(assessment.risk.shortfallProbability - assessment.risk.riskIndex) > 1e-6,
      ),
    ).toBe(true);
  });

  it('bands on the shelf and not on what the item is like everywhere', () => {
    // Two pairs whose shelf state is identical and whose context is not must land
    // in the same band: the essentiality of an item and the size of the district
    // are true of thousands of pairs at once and cannot be a reason to alarm.
    const byItem = new Map<string, number>();
    for (const assessment of scored.assessments) {
      byItem.set(assessment.itemId, (byItem.get(assessment.itemId) ?? 0) + 1);
    }

    const contextsOnly = scored.assessments.filter(
      (assessment) =>
        assessment.risk.band === 'high' &&
        (assessment.risk.facts.find((fact) => fact.name === 'daysOfStock')?.value ?? 0) > 30,
    );

    expect(contextsOnly).toEqual([]);
  });
});

describe('a facility the platform has stopped hearing from', () => {
  it('bands unknown and alerts, rather than staying green', () => {
    // The same world with one facility's last deliveries removed: not one line of
    // the score changes, and the pair moves from the list to the inbox because
    // the platform can no longer see it.
    const facilityIds = sample(network);
    const simulation = simulateNetwork(network, {
      seed: DEMO_SEED,
      scenarioId: 'stable-baseline',
      facilityIds,
    });

    const silent = facilityIds[0];
    expect(silent).toBeDefined();
    if (silent === undefined) {
      return;
    }

    const reporting = simulation.reporting.get(silent);
    const keptFrom = '2026-09-10';
    const muted: Simulation = {
      ...simulation,
      reporting: new Map(simulation.reporting).set(silent, {
        ...simulation.reporting.get(silent),
        reportedDays: (reporting?.reportedDays ?? []).filter((day) => day < keptFrom),
        offlineSpans: reporting?.offlineSpans ?? [],
      }),
    };

    const scored = scorePopulation(muted, network, OPTIONS);
    const pair = scored.assessments.find((assessment) => assessment.facilityId === silent);
    const days = daysBetween(keptFrom, simulation.to);

    expect(days).toBeGreaterThan(3);
    expect(pair?.risk.band).toBe('unknown');
    expect(pair?.risk.missing.join(' ')).not.toBe('');
    expect(pair?.risk.drivers.some((driver) => driver.detail.includes('nothing has arrived'))).toBe(
      true,
    );

    const alert = scored.alerts.find((candidate) => candidate.facilityId === silent);
    expect(alert).toBeDefined();
  });
});
