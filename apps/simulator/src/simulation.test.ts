import { describe, expect, it } from 'vitest';

import {
  REPORTING_DOMAINS,
  SIMULATED_PROVENANCE,
  deriveStockSnapshot,
  detectReportingGaps,
  eachDay,
  replayStockLedger,
} from '@civora/domain';
import type {
  DateOnly,
  Facility,
  FacilityId,
  ItemId,
  StockLedgerEntry,
  Syndrome,
} from '@civora/domain';

import { ITEM_BY_ID } from './anchors/catalogue';
import { DEMO_SEED } from './index';
import { buildNetwork } from './network';
import type { Network } from './network';
import { HISTORY_FROM, SIMULATION_END } from './scenarios';
import { simulateNetwork } from './simulation';
import type { Simulation } from './simulation';

/**
 * Whether the simulated world behaves the way the scenarios claim.
 *
 * A scenario's expectation is only worth anything if something checks it, so
 * every assertion here is about an effect emerging from the model rather than
 * being written into the data. Two negative controls carry as much weight as
 * the scenarios: a platform that finds outbreaks in a quiet year, or transfers
 * in a fully stocked one, is worse than one that finds nothing.
 *
 * The comparisons lean on a property of the generator that is worth stating:
 * every scenario shares the same seed and the same per-item random streams, so
 * two runs differ only in the perturbation. Where the perturbation does not
 * apply, two runs produce identical numbers — which is a much sharper test than
 * a threshold on one run.
 */

const NETWORK: Network = buildNetwork({
  seed: DEMO_SEED,
  coverage: 'demo',
  districtsPerState: 5,
  blocksPerDistrict: 1,
  facilityTiersPerBlock: ['PHC', 'CHC'],
  countryName: 'India',
  currency: 'INR',
  languages: ['en', 'hi'],
});

const facilitiesIn = (stateName: string, districtName?: string): readonly FacilityId[] => {
  const region = NETWORK.regions.find((entry) => entry.name === stateName);
  if (region === undefined) {
    throw new Error(`no region named ${stateName} in the test network`);
  }

  const districtIds = new Set(
    NETWORK.districts
      .filter(
        (district) =>
          district.regionId === region.id &&
          (districtName === undefined || district.name === districtName),
      )
      .map((district) => district.id as string),
  );

  return NETWORK.facilities
    .filter((facility) => districtIds.has(facility.districtId))
    .map((facility) => facility.id);
};

const firstFacilityIn = (
  stateName: string,
  districtName?: string,
  matches: (facility: Facility) => boolean = () => true,
): FacilityId => {
  const facility = NETWORK.facilities.find(
    (candidate) =>
      facilitiesIn(stateName, districtName).includes(candidate.id) && matches(candidate),
  );
  if (facility === undefined) {
    throw new Error(`no matching facility in ${districtName ?? stateName}`);
  }
  return facility.id;
};

const simulate = (scenarioId: string, facilityIds: readonly FacilityId[]): Simulation =>
  simulateNetwork(NETWORK, {
    seed: DEMO_SEED,
    scenarioId,
    from: HISTORY_FROM,
    to: SIMULATION_END,
    facilityIds,
  });

const caseSeries = (simulation: Simulation): ReadonlyMap<string, number> =>
  new Map(
    simulation.syndromicSignals.map((signal) => [
      `${signal.facilityId}::${signal.syndrome}::${signal.observedOn}`,
      signal.caseCount,
    ]),
  );

const meanCases = (
  series: ReadonlyMap<string, number>,
  facilityId: FacilityId,
  syndrome: Syndrome,
  from: DateOnly,
  to: DateOnly,
): number => {
  let total = 0;
  const days = eachDay(from, to);
  for (const day of days) {
    total += series.get(`${facilityId}::${syndrome}::${day}`) ?? 0;
  }
  return days.length === 0 ? 0 : total / days.length;
};

const responseRatio = (
  perturbed: Simulation,
  control: Simulation,
  facilityId: FacilityId,
  syndrome: Syndrome,
  from: DateOnly,
  to: DateOnly,
): number => {
  const baseline = meanCases(caseSeries(control), facilityId, syndrome, from, to);
  const surged = meanCases(caseSeries(perturbed), facilityId, syndrome, from, to);
  return baseline === 0 ? 0 : surged / baseline;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * The largest rise a facility has seen over its own trailing month.
 *
 * A deliberately sensitivity-first rule: a mean, a median and a ratio rather
 * than a proper detector, chosen so that the negative control is tested by
 * something that would certainly fire on a real surge. Series whose baseline is
 * too small for a median to mean anything are skipped, because a facility
 * seeing one case a week cannot support a claim about a change in its rate.
 */
const maxTrailingRise = (simulation: Simulation, minimumBaseline: number): number => {
  const grouped = new Map<string, { day: DateOnly; count: number }[]>();

  for (const facility of new Set(simulation.syndromicSignals.map((signal) => signal.facilityId))) {
    for (const syndrome of new Set(
      simulation.syndromicSignals
        .filter((signal) => signal.facilityId === facility)
        .map((signal) => signal.syndrome),
    )) {
      grouped.set(
        `${facility}::${syndrome}`,
        simulation.syndromicSignals
          .filter((signal) => signal.facilityId === facility && signal.syndrome === syndrome)
          .map((signal) => ({ day: signal.observedOn, count: signal.caseCount }))
          .sort((left, right) => (left.day < right.day ? -1 : 1)),
      );
    }
  }

  let worst = 0;
  for (const series of grouped.values()) {
    for (let index = 28; index < series.length; index += 1) {
      const trailing = series.slice(index - 28, index).map((entry) => entry.count);
      const base = median(trailing);
      const today = series[index];
      if (base < minimumBaseline || today === undefined) {
        continue;
      }
      worst = Math.max(worst, today.count / base);
    }
  }
  return worst;
};

const pairsIn = (
  entries: readonly StockLedgerEntry[],
): readonly { facilityId: FacilityId; itemId: ItemId }[] => {
  const seen = new Map<string, { facilityId: FacilityId; itemId: ItemId }>();
  for (const entry of entries) {
    seen.set(`${entry.facilityId}::${entry.itemId}`, {
      facilityId: entry.facilityId,
      itemId: entry.itemId,
    });
  }
  return [...seen.values()];
};

const within = (day: DateOnly, from: DateOnly, to: DateOnly): boolean => day >= from && day <= to;

/** Days between two dates, for lead-time arithmetic. */
const daysBetween = (from: DateOnly, to: DateOnly): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );

describe('a scenario is an experiment', () => {
  const odisha = firstFacilityIn('Odisha');
  const tamilNadu = firstFacilityIn('Tamil Nadu');
  const sample = [odisha, tamilNadu];

  it('lifts fever only where the fever surge applies', () => {
    const surged = simulate('monsoon-fever-surge', sample);
    const baseline = simulate('stable-baseline', sample);

    // A ramp rather than a step, so the mean over the window lands well below
    // the peak multiplier of 3.2 and still far above one.
    expect(
      responseRatio(surged, baseline, odisha, 'fever', '2026-07-15', '2026-09-15'),
    ).toBeGreaterThan(2);

    // The control state, and a syndrome the surge does not name, must be
    // untouched — not merely similar.
    expect(responseRatio(surged, baseline, tamilNadu, 'fever', '2026-07-15', '2026-09-15')).toBe(1);
    expect(responseRatio(surged, baseline, odisha, 'cough', '2026-07-15', '2026-09-15')).toBe(1);
  }, 30_000);

  it('confines the diarrhoeal outbreak to the district it names', () => {
    const outbreak = simulate('diarrhoeal-outbreak', sample);
    const baseline = simulate('stable-baseline', sample);
    const patna = firstFacilityIn('Bihar', 'Patna');

    const confined = simulate('diarrhoeal-outbreak', [patna, odisha]);
    const quiet = simulate('stable-baseline', [patna, odisha]);

    expect(
      responseRatio(confined, quiet, patna, 'diarrhoea', '2026-05-01', '2026-06-15'),
    ).toBeGreaterThan(2);
    expect(responseRatio(confined, quiet, odisha, 'diarrhoea', '2026-05-01', '2026-06-15')).toBe(1);

    // The scenario is a real run, not just a ratio: it produces a history.
    expect(outbreak.counts.ledgerEntries).toBeGreaterThan(0);
    expect(baseline.counts.syndromicSignals).toBe(outbreak.counts.syndromicSignals);
  }, 30_000);

  it('starves facilities of stock only when a supply disruption is in force', () => {
    const disrupted = simulate('state-warehouse-disruption', sample);
    const disruptedOrders = disrupted.orders.filter(
      (order) =>
        order.facilityId === odisha &&
        order.receivedOn !== null &&
        within(order.placedOn, '2026-07-01', '2026-08-15'),
    );
    const ordinaryOrders = disrupted.orders.filter(
      (order) =>
        order.facilityId === odisha &&
        order.receivedOn !== null &&
        !within(order.placedOn, '2026-07-01', '2026-08-15'),
    );

    expect(disruptedOrders.length).toBeGreaterThan(0);
    expect(ordinaryOrders.length).toBeGreaterThan(0);

    // Tripled lead times, and untouched ones either side of the window: the
    // stock-out that follows is therefore a consequence of the delay and not of
    // a facility that was short to begin with.
    for (const order of disruptedOrders) {
      expect(
        daysBetween(order.placedOn, order.receivedOn ?? order.expectedOn),
      ).toBeGreaterThanOrEqual(24);
    }
    for (const order of ordinaryOrders) {
      expect(daysBetween(order.placedOn, order.receivedOn ?? order.expectedOn)).toBe(8);
    }
  }, 30_000);

  it('makes stock-outs emerge from the disruption rather than asserting them', () => {
    const disrupted = simulate('state-warehouse-disruption', [odisha]);
    const baseline = simulate('stable-baseline', [odisha]);

    const unmetDays = (simulation: Simulation): number =>
      simulation.shortfalls.reduce((total, shortfall) => total + shortfall.days, 0);

    expect(unmetDays(disrupted)).toBeGreaterThan(0);
    expect(unmetDays(disrupted)).toBeGreaterThan(unmetDays(baseline));
  }, 30_000);

  it('records a cold-chain failure as a loss, and stops taking deliveries', () => {
    // A facility with no refrigerator holds no cold-chain items at all, so the
    // failure has to be tested where there was something to fail.
    const ernakulam = firstFacilityIn(
      'Kerala',
      'Ernakulam',
      (facility) => facility.coldChain.available,
    );
    const control = firstFacilityIn(
      'Kerala',
      'Thiruvananthapuram',
      (facility) => facility.coldChain.available,
    );
    const simulation = simulate('cold-chain-failure', [ernakulam, control]);

    const written = simulation.ledgerEntries.filter(
      (entry) =>
        entry.facilityId === ernakulam &&
        entry.kind === 'adjust' &&
        entry.adjustmentDirection === 'decrease' &&
        within(entry.occurredOn, '2026-04-01', '2026-04-21'),
    );
    const coldDeliveries = simulation.ledgerEntries.filter(
      (entry) =>
        entry.facilityId === ernakulam &&
        entry.kind === 'receipt' &&
        ITEM_BY_ID.get(entry.itemId)?.coldChain === true &&
        within(entry.occurredOn, '2026-04-01', '2026-04-21'),
    );
    const controlLoss = simulation.ledgerEntries.filter(
      (entry) => entry.facilityId === control && entry.kind === 'adjust',
    );

    expect(written.length).toBeGreaterThan(0);
    expect(written.every((entry) => entry.quantity > 0)).toBe(true);
    expect(controlLoss).toHaveLength(0);

    // The store does not send a facility a vaccine it has nowhere to keep, so
    // nothing cold arrives while the refrigeration is down.
    expect(coldDeliveries).toHaveLength(0);
  }, 30_000);

  it('delivers a district expiry cliff, and the waste lands in that district', () => {
    const pune = firstFacilityIn('Maharashtra', 'Pune');
    const nagpur = firstFacilityIn('Maharashtra', 'Nagpur');
    const simulation = simulate('district-expiry-cliff', [pune, nagpur]);

    const expiredUnits = (facilityId: FacilityId): number =>
      simulation.ledgerEntries
        .filter((entry) => entry.facilityId === facilityId && entry.kind === 'expiry')
        .reduce((total, entry) => total + entry.quantity, 0);

    expect(expiredUnits(pune)).toBeGreaterThan(0);
    expect(expiredUnits(pune)).toBeGreaterThan(expiredUnits(nagpur));

    // Reported before it becomes waste: the receipt is short-dated from the day
    // it arrives, so a platform has the warning window rather than the aftermath.
    const shortDated = simulation.ledgerEntries.filter(
      (entry) =>
        entry.facilityId === pune &&
        entry.kind === 'receipt' &&
        entry.expiresOn !== null &&
        daysBetween(entry.occurredOn, entry.expiresOn) <= 45,
    );
    expect(shortDated.length).toBeGreaterThan(0);
  }, 30_000);

  it('raises a reporting gap where a facility goes quiet, without losing the record', () => {
    const khordha = facilitiesIn('Odisha', 'Khordha');
    const simulation = simulate('facility-offline', khordha);

    for (const facilityId of khordha) {
      const reporting = simulation.reporting.get(facilityId);
      expect(reporting).toBeDefined();

      const reportedDays = reporting?.reportedDays ?? [];
      expect(reportedDays.filter((day) => within(day, '2026-06-01', '2026-06-14'))).toHaveLength(0);

      const spanning = (reporting?.offlineSpans ?? []).filter(
        (span) => span.from <= '2026-06-01' && span.to >= '2026-06-14',
      );
      expect(spanning).toHaveLength(1);
      expect(spanning[0]?.days).toBeGreaterThanOrEqual(14);
      expect(spanning[0]?.resumedOn).not.toBeNull();
      expect(spanning[0]?.backfilledDays).toBe(spanning[0]?.days);

      const gaps = detectReportingGaps(facilityId, {
        from: '2026-06-01',
        to: '2026-06-14',
        reportedDays,
        missing: [...REPORTING_DOMAINS],
        synthetic: true,
        provenance: SIMULATED_PROVENANCE,
      });
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.days).toBe(14);

      // The facility kept working: the fortnight is missing from the network,
      // not from the facility, and an officer must not read it as an empty
      // fortnight.
      expect(
        simulation.footfall.some(
          (observation) =>
            observation.facilityId === facilityId && observation.observedOn === '2026-06-05',
        ),
      ).toBe(true);
      expect(
        simulation.ledgerEntries.some(
          (entry) =>
            entry.facilityId === facilityId &&
            entry.kind === 'issue' &&
            within(entry.occurredOn, '2026-06-01', '2026-06-14'),
        ),
      ).toBe(true);
    }
  }, 30_000);
});

describe('the negative controls', () => {
  it('finds no surge in a stable baseline', () => {
    const quiet = simulate('stable-baseline', [
      firstFacilityIn('Odisha'),
      firstFacilityIn('Tamil Nadu'),
    ]);

    expect(maxTrailingRise(quiet, 8)).toBeLessThan(2.2);
  }, 30_000);

  it('warrants no transfer when every facility is comfortably stocked', () => {
    const stocked = simulate('no-transfer-warranted', facilitiesIn('Tamil Nadu'));

    expect(stocked.counts.facilities).toBe(facilitiesIn('Tamil Nadu').length);
    expect(stocked.shortfalls).toEqual([]);
  }, 30_000);
});

describe('the generated ledger', () => {
  const sample = [firstFacilityIn('Odisha'), firstFacilityIn('Tamil Nadu')];

  it('replays without ever going below zero, for every series it contains', () => {
    const simulation = simulate('monsoon-fever-surge', sample);

    for (const pair of pairsIn(simulation.ledgerEntries)) {
      const replay = replayStockLedger(simulation.ledgerEntries, pair.facilityId, pair.itemId, {
        from: HISTORY_FROM,
        to: SIMULATION_END,
      });

      expect(replay.entriesExceedingStock).toBe(0);
      expect(replay.duplicatesIgnored).toBe(0);
      expect(replay.days.length).toBe(simulation.counts.days);
    }
  }, 30_000);

  it('carries censoring the platform can detect, and a demand basis that admits it', () => {
    const simulation = simulate('monsoon-fever-surge', [firstFacilityIn('Odisha')]);
    const facilityId = firstFacilityIn('Odisha');

    const censored = pairsIn(simulation.ledgerEntries)
      .filter((pair) => pair.facilityId === facilityId)
      .map((pair) => ({
        pair,
        snapshot: deriveStockSnapshot(simulation.ledgerEntries, pair.facilityId, pair.itemId, {
          asOf: SIMULATION_END,
          windowDays: 90,
          synthetic: true,
          provenance: SIMULATED_PROVENANCE,
        }),
      }))
      .filter((entry) => entry.snapshot.censoredDays > 0);

    expect(censored.length).toBeGreaterThan(0);
    expect(censored.some((entry) => entry.snapshot.demandBasis === 'censoring-corrected')).toBe(
      true,
    );
  }, 30_000);

  it('never emits a record the platform cannot see came from a simulator', () => {
    const simulation = simulate('monsoon-fever-surge', [firstFacilityIn('Odisha')]);

    const records = [
      ...simulation.ledgerEntries,
      ...simulation.syndromicSignals,
      ...simulation.bedStatuses,
      ...simulation.staffAttendance,
      ...simulation.footfall,
    ];

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.synthetic)).toBe(true);
    expect(records.every((record) => record.provenance.kind === 'simulated')).toBe(true);
  }, 30_000);
});

describe('determinism', () => {
  const sample = [firstFacilityIn('Odisha')];

  const checksum = (entries: readonly StockLedgerEntry[]): number =>
    entries.reduce((total, entry) => {
      const text = `${entry.id}:${entry.occurredOn}:${entry.quantity}`;
      let hash = total;
      for (let index = 0; index < text.length; index += 1) {
        hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
      }
      return hash;
    }, 7);

  it('produces the same history for the same seed, and a different one otherwise', () => {
    const first = simulate('monsoon-fever-surge', sample);
    const again = simulateNetwork(NETWORK, {
      seed: DEMO_SEED,
      scenarioId: 'monsoon-fever-surge',
      from: HISTORY_FROM,
      to: SIMULATION_END,
      facilityIds: sample,
    });
    const reseeded = simulateNetwork(NETWORK, {
      seed: 'another-seed',
      scenarioId: 'monsoon-fever-surge',
      from: HISTORY_FROM,
      to: SIMULATION_END,
      facilityIds: sample,
    });

    expect(checksum(again.ledgerEntries)).toBe(checksum(first.ledgerEntries));
    expect(again.counts).toEqual(first.counts);
    expect(checksum(reseeded.ledgerEntries)).not.toBe(checksum(first.ledgerEntries));
  }, 30_000);

  it('refuses to simulate a facility that is not in the network', () => {
    expect(() =>
      simulateNetwork(NETWORK, {
        seed: DEMO_SEED,
        facilityIds: ['nowhere-phc-01' as FacilityId],
      }),
    ).toThrow(/not in this network/);
  });
});
