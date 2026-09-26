import type { Imputation } from '@civora/domain';

/** One training example, already reduced to numbers by the silo that holds it. */
export interface FederatedSample {
  readonly features: readonly number[];
  readonly target: number;
}

/**
 * What one silo holds, and what it is willing to say about it.
 *
 * The samples never leave the silo: the coordinator receives a `SiloUpdate`,
 * whose only numbers are a parameter vector and a loss. The feature names travel
 * with the dataset because they are the schema both sides agreed on, not because
 * the coordinator reads them from the data.
 */
export interface SiloDataset {
  /** The administrative unit: a state, in this build. */
  readonly siloId: string;
  readonly label: string;
  readonly featureNames: readonly string[];
  readonly samples: readonly FederatedSample[];
  /** Series read to build the samples, and what censoring was found in them. */
  readonly seriesCount: number;
  readonly censoredDaysFound: number;
  readonly censoredDaysImputed: number;
  readonly imputation: Imputation;
}

/**
 * What crosses the boundary.
 *
 * Deliberately three numbers and a list of floats. There is no place in this
 * shape for a record identifier, a date, a facility or a feature value — and the
 * payload assertion test serialises the real object and proves it.
 */
export interface SiloUpdate {
  readonly siloId: string;
  readonly sampleCount: number;
  /** The change the silo proposes to the shared model. */
  readonly update: readonly number[];
  /** Mean squared error on the silo's own samples, before the update was applied. */
  readonly localLoss: number;
}

/**
 * The basis every silo trains in, pooled from the silos' own sums and counts.
 *
 * Features are centred and scaled per column, and the **target is standardised
 * too** — both from the pooled sums, and both shared for the same reason. A
 * clipped update may move any parameter by at most `clipNorm · weight` in a
 * round, so the parameters have to live at the scale of the thing being
 * predicted: with the target left in units of demand (a spread of a few hundred
 * here) an optimal weight is of order `spread`, and a run bounded to about one
 * unit a round cannot reach it in any number of rounds. Standardising the target
 * puts the optimal parameters at order one, which is what makes both the step
 * and the noise meaningful, and it makes the loss dimensionless: `1` is the
 * error of predicting the pooled mean.
 */
export interface SiloStandardisation {
  readonly mean: readonly number[];
  readonly scale: readonly number[];
  readonly targetMean: number;
  readonly targetScale: number;
}
