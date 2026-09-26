import { describe, expect, it } from 'vitest';

import { accountForRounds } from './accountant';
import { runFederatedTraining } from './coordinator';
import type { FederatedConfig } from './coordinator';
import { linearShape } from './model';
import { featureScaleOf, poolFeatureScale } from './scaling';
import type { SiloDataset } from './types';

const FEATURES = 2;

const siloOf = (siloId: string, offset: number): SiloDataset => ({
  siloId,
  label: siloId,
  featureNames: ['x1', 'x2'],
  seriesCount: 1,
  censoredDaysFound: 0,
  censoredDaysImputed: 0,
  imputation: 'none',
  samples: Array.from({ length: 48 }, (_unused, index) => {
    const first = ((index + offset) % 8) / 4 - 1;
    const second = (Math.floor((index + offset) / 8) % 6) / 3 - 0.5;
    return { features: [first, second], target: 3 * first + 2 * second };
  }),
});

const configOf = (overrides: Partial<FederatedConfig> = {}): FederatedConfig => ({
  rounds: 4,
  samplingRate: 1,
  noiseMultiplier: 1,
  clipNorm: 2,
  delta: 1e-5,
  shape: linearShape(FEATURES),
  standardisation: null,
  local: { epochs: 2, batchSize: 16, learningRate: 0.1, optimizer: 'sgd', mu: 0.05, l2: 0 },
  maskUpdates: false,
  seed: 'run',
  ...overrides,
});

const silos = [siloOf('SIM-A', 0), siloOf('SIM-B', 3), siloOf('SIM-C', 5), siloOf('SIM-D', 7)];

describe('the round coordinator', () => {
  it('is a pure function of the silos, the configuration and the seed', () => {
    const first = runFederatedTraining({ silos, config: configOf() });
    const again = runFederatedTraining({ silos, config: configOf() });
    expect(again.parameters).toEqual(first.parameters);
    expect(JSON.stringify(again.ledger)).toBe(JSON.stringify(first.ledger));
    expect(again.initialLoss).toBe(first.initialLoss);
    expect(again.finalLoss).toBe(first.finalLoss);
  });

  it('learns across rounds and says how much', () => {
    const run = runFederatedTraining({ silos, config: configOf({ rounds: 8 }) });
    expect(run.finalLoss).toBeLessThan(run.initialLoss);
    expect(run.ledger).toHaveLength(8);
    expect(run.ledger.at(-1)?.meanLocalLoss ?? 0).toBeLessThan(run.initialLoss);
    expect(run.participated).toEqual(['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D']);

    // The global column is measured on every silo after each round, so the last
    // entry is the run's own final figure — the two cannot disagree.
    expect(run.ledger.at(-1)?.globalLoss).toBe(run.finalLoss);
    expect(run.ledger.every((round) => Number.isFinite(round.globalLoss))).toBe(true);
  });

  it('samples exactly the share of silos the rate names', () => {
    const half = runFederatedTraining({ silos, config: configOf({ samplingRate: 0.5 }) });
    expect(half.ledger.every((round) => round.participants.length === 2)).toBe(true);
    const all = runFederatedTraining({ silos, config: configOf({ samplingRate: 1 }) });
    expect(all.ledger.every((round) => round.participants.length === 4)).toBe(true);
    // A different seed samples a different subset, which is why the seed is in
    // the configuration rather than in the air.
    const other = runFederatedTraining({
      silos,
      config: configOf({ samplingRate: 0.5, seed: 'other' }),
    });
    expect(other.ledger[0]?.participants.map((p) => p.siloId)).not.toEqual(
      half.ledger[0]?.participants.map((p) => p.siloId),
    );
  });

  it('adds noise standardised to the clipped sensitivity, and only when asked', () => {
    const quiet = runFederatedTraining({ silos, config: configOf({ noiseMultiplier: 0 }) });
    const noised = runFederatedTraining({ silos, config: configOf({ noiseMultiplier: 3 }) });
    expect(noised.parameters).not.toEqual(quiet.parameters);

    // σ · C · w_max, with w_max the largest sample weight. All four silos hold
    // equal samples here, so w_max = 1/4.
    const expected = 3 * 2 * 0.25;
    expect(noised.ledger[0]?.noiseStandardDeviation).toBeCloseTo(expected, 12);
    expect(quiet.ledger[0]?.noiseStandardDeviation).toBe(0);

    // No noise is no mechanism, so there is no ε to report: `null`, never 0.
    expect(quiet.ledger.every((round) => round.epsilonSpent === null)).toBe(true);
    expect(quiet.spend).toBeNull();
    expect(noised.ledger[0]?.epsilonSpent).toBeGreaterThan(0);
    expect(noised.spend?.epsilon).toBeGreaterThan(0);
  });

  it('records what the privacy budget spent, at the accountant’s own figure', () => {
    const run = runFederatedTraining({
      silos,
      config: configOf({ samplingRate: 0.5, noiseMultiplier: 2 }),
    });
    const expected = accountForRounds({
      rounds: 4,
      samplingRate: 0.5,
      noiseMultiplier: 2,
      delta: 1e-5,
    });
    expect(run.ledger.at(-1)?.epsilonSpent).toBeCloseTo(expected.epsilon, 12);
    expect(run.spend).not.toBeNull();
    expect(run.spend?.epsilon).toBe(expected.epsilon);
    expect(run.spend?.samplingRate).toBe(0.5);
  });

  it('hides individual updates when masking is on, and reports the diagnostic it cannot compute', () => {
    const visible = runFederatedTraining({ silos, config: configOf({ noiseMultiplier: 0 }) });
    expect(visible.ledger[0]?.divergence).not.toBeNull();
    expect(visible.ledger[0]?.masked).toBe(false);

    const masked = runFederatedTraining({
      silos,
      config: configOf({ noiseMultiplier: 0, maskUpdates: true }),
    });
    expect(masked.ledger.every((round) => round.masked)).toBe(true);
    expect(masked.ledger.every((round) => round.divergence === null)).toBe(true);
    expect(masked.finalLoss).toBeLessThan(masked.initialLoss);
    // With no noise, masking changes nothing about where training lands: the
    // masks cancel, which is the whole property. Compared to a tolerance rather
    // than exactly, because adding then removing a mask is floating-point
    // arithmetic and the last bits are allowed to differ.
    for (let index = 0; index < visible.parameters.length; index += 1) {
      expect(masked.parameters[index]).toBeCloseTo(visible.parameters[index] ?? 0, 6);
    }
  });

  it('reports the bytes that actually crossed each round', () => {
    const run = runFederatedTraining({ silos, config: configOf({ rounds: 1 }) });
    const parameters = FEATURES + 1;
    expect(run.ledger[0]?.bytesIn).toBe(parameters * 8 * 4);
    expect(run.ledger[0]?.participants[0]?.updateNorm).toBeGreaterThanOrEqual(0);
  });

  it('starts a run in the shared basis at the zero model’s own error: 1', () => {
    // The invariant that makes every figure on the console and in the report
    // readable. The basis standardises the target across the federation's rows, so
    // a run that has learned nothing scores exactly 1, and `1 − loss` is the share
    // of the demand's variance explained. It is asserted here because a basis that
    // disagreed between the silos would make the first round look like progress.
    const rows = silos.flatMap((silo) => silo.samples);
    const basis = poolFeatureScale(silos.map((silo) => featureScaleOf(silo.samples)));
    expect(basis.targetScale).toBeGreaterThan(0);

    const run = runFederatedTraining({
      silos,
      config: configOf({ standardisation: basis, rounds: 2, noiseMultiplier: 0 }),
    });

    // Not exactly 1: the mean of 192 ratios carries a floating-point remainder,
    // and a test that demanded bit equality would be testing IEEE 754 rather than
    // the basis.
    expect(run.initialLoss).toBeCloseTo(1, 12);
    expect(run.finalLoss).toBeLessThan(run.initialLoss);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses to start with no silos', () => {
    expect(() => runFederatedTraining({ silos: [], config: configOf() })).toThrow(/no silos/);
  });

  it('stops a non-finite update at the payload check rather than aggregating it', () => {
    const broken: SiloDataset = {
      ...siloOf('SIM-BROKEN', 0),
      samples: siloOf('SIM-BROKEN', 0).samples.map((sample) => ({ ...sample, target: Number.NaN })),
    };
    expect(() => runFederatedTraining({ silos: [broken], config: configOf() })).toThrow(
      /payload allow-list/,
    );
  });
});
