import { accountForRounds } from '@civora/federated';
import { describe, expect, it } from 'vitest';

import { buildDemoDataset } from './index';
import {
  compareFederation,
  federationConfigFor,
  partitionFederationSilos,
  runFederation,
  sweepFederation,
} from './federation';

/**
 * The wiring test for the federation over the generated world: the partition is
 * one silo per state, every silo trains, the privacy spend is the accountant's
 * own figure, a target out of reach is reported rather than approximated, and a
 * second country's code set addresses the same silos without a code change.
 *
 * The demonstration dataset is generated once here, at a reduced sample count per
 * series, because the cost that matters is the number of rows a round trains on
 * and not how many rows exist.
 */
const dataset = buildDemoDataset();
const partition = partitionFederationSilos(dataset, { maxSamplesPerSeries: 40 });

const quick = { rounds: 2, epochs: 1, batchSize: 32, epsilonTarget: 8 as number | null };

describe('the federation over the generated world', () => {
  it('partitions the world into one silo per state, and every silo has rows', () => {
    expect(partition.silos).toHaveLength(dataset.network.regions.length);
    expect(partition.countryId).toBe('SIM-IN');
    expect(partition.regionLevelName).toBe('state');
    expect(partition.regionsWithoutHistory).toBe(0);
    expect(partition.samples).toBeGreaterThan(0);
    expect(partition.seriesRead).toBeGreaterThan(0);

    // Addressed by the region ids the network was generated with, and non-empty
    // by assertion rather than by assumption: a silo that trained on nothing
    // would produce metrics that look calm.
    for (const [index, silo] of partition.silos.entries()) {
      expect(silo.siloId).toBe(dataset.network.regions[index]?.id);
      expect(silo.samples.length).toBeGreaterThan(0);
      expect(silo.featureNames).toEqual(partition.featureNames);
    }
  });

  it('reports local-only against federated for every silo, and learns across rounds', () => {
    const outcome = compareFederation(partition, quick);

    expect(outcome.perSilo).toHaveLength(partition.silos.length);
    expect(outcome.run.finalLoss).toBeLessThan(outcome.run.initialLoss);
    expect(outcome.run.ledger).toHaveLength(2);
    expect(outcome.totals.silosWhereFederationHelped + outcome.totals.silosWhereLocalWon).toBe(
      partition.silos.length,
    );

    for (const entry of outcome.perSilo) {
      expect(entry.sampleCount).toBeGreaterThan(0);
      expect(Number.isFinite(entry.localOnlyLoss)).toBe(true);
      expect(Number.isFinite(entry.federatedLoss)).toBe(true);
      expect(entry.difference).toBeCloseTo(entry.localOnlyLoss - entry.federatedLoss, 12);
      expect(entry.federatedBetter).toBe(entry.federatedLoss < entry.localOnlyLoss);
    }

    // FedAvg and FedProx are both run and both reported, whichever wins.
    expect(outcome.fedAvg).not.toBeNull();
    expect(outcome.fedAvg?.mu).toBe(0);
    expect(['fedavg', 'fedprox']).toContain(outcome.proximalWinner);
    expect(outcome.fedAvg?.finalLoss).not.toBe(outcome.run.finalLoss);
  });

  it('solves the noise multiplier for a target and records the accountant’s own spend', () => {
    const resolved = federationConfigFor(partition, { ...quick, epsilonTarget: 8 });
    expect(resolved.noiseMultiplier).toBeGreaterThan(0);
    expect(resolved.config.noiseMultiplier).toBe(resolved.noiseMultiplier);

    const run = runFederation(partition, { ...quick, epsilonTarget: 8 });
    expect(run.spend).not.toBeNull();
    expect(run.spend?.epsilon).toBeCloseTo(
      accountForRounds({
        rounds: 2,
        samplingRate: 1,
        noiseMultiplier: resolved.noiseMultiplier,
        delta: 1e-5,
      }).epsilon,
      12,
    );
    expect(run.ledger.at(-1)?.epsilonSpent).toBe(run.spend?.epsilon);
  });

  it('records no ε at all when no mechanism is run, rather than zero', () => {
    const run = runFederation(partition, { ...quick, epsilonTarget: null });
    expect(run.spend).toBeNull();
    expect(run.ledger.every((round) => round.epsilonSpent === null)).toBe(true);
    expect(run.ledger.every((round) => round.noiseStandardDeviation === 0)).toBe(true);
  });

  it('reports a target the accountant cannot reach as unreachable, with its own sentence', () => {
    const sweep = sweepFederation(partition, { ...quick, epsilons: [1e-9] });
    expect(sweep.points).toHaveLength(1);
    expect(sweep.points[0]?.reachable).toBe(false);
    expect(sweep.points[0]?.noiseMultiplier).toBeNull();
    expect(sweep.points[0]?.finalLoss).toBeNull();
    expect(sweep.points[0]?.note).toMatch(/spends more than/);
    expect(sweep.pointsOutOfReach).toBe(1);
    expect(sweep.pointsEvaluated).toBe(0);
  });

  it('addresses the same silos in a second country’s code set', () => {
    const kenyan = partitionFederationSilos(dataset, {
      countryId: 'SIM-KE',
      maxSamplesPerSeries: 40,
    });
    expect(kenyan.regionLevelName).toBe('county');
    expect(kenyan.silos.length).toBe(partition.silos.length);
    for (const silo of kenyan.silos) {
      expect(silo.siloId.startsWith('SIM-KE-')).toBe(true);
      expect(silo.samples.length).toBeGreaterThan(0);
    }

    // The same configuration as the Indian run: a single round moves the loss in
    // neither direction (the aggregate is still arriving), so the learning claim
    // is made over the same two rounds the first country is held to.
    const run = runFederation(kenyan, quick);
    expect(run.finalLoss).toBeLessThan(run.initialLoss);
    expect(run.ledger[0]?.participants.length).toBe(kenyan.silos.length);
  });
});
