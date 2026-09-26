import { describe, expect, it } from 'vitest';

import { runFederatedTraining } from './coordinator';
import {
  COUNTRY_IDENTIFIER_SETS,
  INDIA_IDENTIFIER_SET,
  KENYA_IDENTIFIER_SET,
  countryIdentifiersFor,
  siloIdentifiersFor,
} from './identifiers';
import { linearShape } from './model';
import type { SiloDataset } from './types';

const regions = [
  { id: 'SIM-ODI', name: 'Odisha' },
  { id: 'SIM-BIH', name: 'Bihar' },
  { id: 'SIM-KER', name: 'Kerala' },
];

/**
 * This is the phase's cross-border requirement, and it is deliberately about the
 * code path rather than about a map: a second country's identifier set loads,
 * its silos are addressed in its own vocabulary, and the round that trains over
 * them is the same code and the same numbers. A federation over Indian states
 * that could only ever address Indian states is the failure mode rule 4 names.
 */
describe('the country identifier registry', () => {
  it('reads a set by country, and refuses one it does not hold by name', () => {
    expect(countryIdentifiersFor('SIM-IN')).toBe(INDIA_IDENTIFIER_SET);
    expect(countryIdentifiersFor('SIM-KE').regionLevelName).toBe('county');
    expect(COUNTRY_IDENTIFIER_SETS.map((set) => set.countryId)).toEqual(['SIM-IN', 'SIM-KE']);
    expect(countryIdentifiersFor('SIM-KE').currency).toBe('KES');
    expect(() => countryIdentifiersFor('SIM-NZ')).toThrow(/no identifier set is registered/);
  });

  it('writes a second country’s codes in its own vocabulary, not the first’s', () => {
    const indian = siloIdentifiersFor(INDIA_IDENTIFIER_SET, regions);
    const kenyan = siloIdentifiersFor(KENYA_IDENTIFIER_SET, regions);

    // The first set returns the network's own ids, so the demonstration's silo
    // ids are exactly the region ids the dataset was generated with.
    expect(indian.map((entry) => entry.siloId)).toEqual(regions.map((region) => region.id));
    expect(indian[0]?.label).toBe('Odisha (state)');

    // The second numbers its counties and carries none of the first's prefix.
    expect(kenyan.map((entry) => entry.siloId)).toEqual([
      'SIM-KE-C01-ODISHA',
      'SIM-KE-C02-BIHAR',
      'SIM-KE-C03-KERALA',
    ]);
    expect(kenyan[0]?.label).toBe('Odisha (county)');
    for (const entry of kenyan) {
      expect(entry.siloId.startsWith('SIM-KE-')).toBe(true);
      expect(entry.siloId).not.toMatch(/^SIM-(ODI|BIH|KER)/);
    }
    expect(new Set(kenyan.map((entry) => entry.siloId)).size).toBe(kenyan.length);
  });

  it('trains the same round under either code set', () => {
    const samples = Array.from({ length: 32 }, (_unused, index) => {
      const value = (index % 8) / 4 - 1;
      return { features: [value], target: 2 * value + 1 };
    });
    const silosFor = (ids: readonly string[]): readonly SiloDataset[] =>
      ids.map((siloId) => ({
        siloId,
        label: siloId,
        featureNames: ['x1'],
        seriesCount: 1,
        censoredDaysFound: 0,
        censoredDaysImputed: 0,
        imputation: 'none',
        samples,
      }));

    const config = {
      rounds: 3,
      samplingRate: 1,
      // The accountant is on, so its figure is one of the things that must not
      // depend on the country.
      noiseMultiplier: 1,
      clipNorm: 2,
      delta: 1e-5,
      shape: linearShape(1),
      standardisation: null,
      local: {
        epochs: 2,
        batchSize: 16,
        learningRate: 0.05,
        optimizer: 'sgd' as const,
        mu: 0,
        l2: 0,
      },
      maskUpdates: false,
      seed: 'cross-border',
    };

    const indian = runFederatedTraining({
      silos: silosFor(
        siloIdentifiersFor(INDIA_IDENTIFIER_SET, regions).map((entry) => entry.siloId),
      ),
      config,
    });
    const kenyan = runFederatedTraining({
      silos: silosFor(
        siloIdentifiersFor(KENYA_IDENTIFIER_SET, regions).map((entry) => entry.siloId),
      ),
      config,
    });

    // Everything the country does not name is identical: the same partition, the
    // same rows evaluated, the same rounds, and the same privacy spend. The
    // batch order is not, and that is deliberate — each silo's local stream is
    // seeded with its own identifier, so re-addressing a silo re-draws its
    // mini-batches. Two silos must not shuffle alike, which is exactly why this
    // pair is compared on what is invariant rather than on an equality of
    // numbers that would require the identifiers to be equal too.
    expect(kenyan.initialLoss).toBe(indian.initialLoss);
    expect(kenyan.ledger).toHaveLength(indian.ledger.length);
    expect(kenyan.ledger.map((round) => round.participants.length)).toEqual(
      indian.ledger.map((round) => round.participants.length),
    );
    expect(kenyan.ledger[0]?.participants.map((participant) => participant.sampleCount)).toEqual(
      indian.ledger[0]?.participants.map((participant) => participant.sampleCount),
    );
    expect(kenyan.spend?.epsilon).toBe(indian.spend?.epsilon);
    expect(kenyan.spend?.epsilon).toBeGreaterThan(0);
    expect(kenyan.finalLoss).toBeLessThan(kenyan.initialLoss);
    expect(indian.finalLoss).toBeLessThan(indian.initialLoss);
    // Same data, same rounds, same code; the batch order is the only difference,
    // so the two land close without being required to land identically.
    expect(Math.abs(kenyan.finalLoss - indian.finalLoss) / indian.finalLoss).toBeLessThan(0.1);

    // And the ledger carries the country's own vocabulary. Sorted here because
    // the sampler draws the participants in a seeded order, which is the round's
    // business and not the registry's.
    expect(kenyan.ledger[0]?.participants.map((participant) => participant.siloId).sort()).toEqual([
      'SIM-KE-C01-ODISHA',
      'SIM-KE-C02-BIHAR',
      'SIM-KE-C03-KERALA',
    ]);
    expect(kenyan.participated).toEqual([
      'SIM-KE-C01-ODISHA',
      'SIM-KE-C02-BIHAR',
      'SIM-KE-C03-KERALA',
    ]);
  });
});
