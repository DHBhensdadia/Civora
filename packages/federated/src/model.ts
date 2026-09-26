/**
 * The model that is federated, and the reason it has to be differentiable.
 *
 * Weighted federated averaging is an average of parameters, so it is only
 * meaningful for a model whose parameters are a point in a space where averaging
 * means something. A gradient-boosted ensemble is not such a model — averaging
 * two trees produces something that is not a tree and does not predict anything
 * either of them predicted — which is why this package ships a regularised
 * linear model and a small MLP instead. Differentiability is a requirement here,
 * not a preference, and the ADR records it.
 *
 * Every parameter vector is flat and element-wise: averaging, masking, clipping
 * and noising are all operations on the same list of numbers. Keeping one
 * representation is what lets the payload be a plain array of floats with no
 * structure in it that could carry anything about a record.
 *
 * The gradients are written by hand rather than pulled from a library, so each
 * one is checked against a finite difference in the tests.
 */

export type ModelKind = 'linear' | 'mlp';

/** Hidden units of the small MLP. One layer, because two would not be demoable. */
export const MLP_HIDDEN_UNITS = 8;

export interface ModelShape {
  readonly kind: ModelKind;
  readonly featureCount: number;
  /** Zero for the linear model. */
  readonly hiddenUnits: number;
}

export const linearShape = (featureCount: number): ModelShape => ({
  kind: 'linear',
  featureCount,
  hiddenUnits: 0,
});

export const mlpShape = (
  featureCount: number,
  hiddenUnits: number = MLP_HIDDEN_UNITS,
): ModelShape => ({ kind: 'mlp', featureCount, hiddenUnits });

/** How many numbers a parameter vector of this shape holds. */
export function parameterCount(shape: ModelShape): number {
  if (shape.kind === 'linear') {
    // One weight per feature, plus the bias.
    return shape.featureCount + 1;
  }
  // Input weights, hidden biases, output weights, output bias.
  return shape.hiddenUnits * (shape.featureCount + 1) + shape.hiddenUnits + 1;
}

/** The origin of the parameter space: an all-zero model with no opinion. */
export function zeroParameters(shape: ModelShape): readonly number[] {
  return new Array<number>(parameterCount(shape)).fill(0);
}

/** A scaled copy of a parameter vector, for weighing an update. */
export const scaled = (parameters: readonly number[], factor: number): readonly number[] =>
  parameters.map((value) => value * factor);

/** Element-wise sum, used for aggregation, masking and noise. */
export function addParameters(
  left: readonly number[],
  right: readonly number[],
): readonly number[] {
  return left.map((value, index) => value + (right[index] ?? 0));
}

/** Element-wise difference, used to turn two models into one update. */
export function subtractParameters(
  left: readonly number[],
  right: readonly number[],
): readonly number[] {
  return left.map((value, index) => value - (right[index] ?? 0));
}

/** Euclidean norm, the quantity clipping and the accountant speak in. */
export const vectorNorm = (values: readonly number[]): number =>
  Math.sqrt(values.reduce((total, value) => total + value * value, 0));

/**
 * Scale a vector down to `norm` when it is longer, and leave it alone otherwise.
 *
 * Clipping is the step that bounds one silo's influence on the aggregate, which
 * is what makes the Gaussian noise added later meaningful: noise calibrated to an
 * unbounded contribution is decoration.
 */
export function clipVector(values: readonly number[], norm: number): readonly number[] {
  if (!Number.isFinite(norm) || norm <= 0) {
    return values;
  }
  const length = vectorNorm(values);
  if (length <= norm || length === 0) {
    return values;
  }
  return scaled(values, norm / length);
}

/** The forward pass, returning both the output and whatever the fit needs. */
export interface ForwardResult {
  readonly output: number;
  /** Hidden activations, empty for the linear model. */
  readonly hidden: readonly number[];
}

export function forward(
  shape: ModelShape,
  parameters: readonly number[],
  features: readonly number[],
): ForwardResult {
  if (shape.kind === 'linear') {
    let output = parameters[shape.featureCount] ?? 0;
    for (let index = 0; index < shape.featureCount; index += 1) {
      output += (parameters[index] ?? 0) * (features[index] ?? 0);
    }
    return { output, hidden: [] };
  }

  const hidden: number[] = [];
  const inputCount = shape.featureCount + 1;
  for (let unit = 0; unit < shape.hiddenUnits; unit += 1) {
    const offset = unit * inputCount;
    let activation = parameters[offset + shape.featureCount] ?? 0;
    for (let index = 0; index < shape.featureCount; index += 1) {
      activation += (parameters[offset + index] ?? 0) * (features[index] ?? 0);
    }
    hidden.push(Math.tanh(activation));
  }

  const outputOffset = shape.hiddenUnits * inputCount;
  let output = parameters[outputOffset + shape.hiddenUnits] ?? 0;
  for (let unit = 0; unit < shape.hiddenUnits; unit += 1) {
    output += (parameters[outputOffset + unit] ?? 0) * (hidden[unit] ?? 0);
  }
  return { output, hidden };
}

export const predict = (
  shape: ModelShape,
  parameters: readonly number[],
  features: readonly number[],
): number => forward(shape, parameters, features).output;

/**
 * The squared error gradient for one sample.
 *
 * Written without the usual factor of one half, so the gradient is
 * `2 (prediction − target)` at the output — stated because a factor dropped
 * silently is a factor wrong.
 */
export function sampleGradient(
  shape: ModelShape,
  parameters: readonly number[],
  features: readonly number[],
  target: number,
): readonly number[] {
  const { output, hidden } = forward(shape, parameters, features);
  const delta = 2 * (output - target);

  if (shape.kind === 'linear') {
    const gradient = features.map((value) => delta * value);
    gradient.push(delta);
    return gradient;
  }

  const inputCount = shape.featureCount + 1;
  const gradient = new Array<number>(parameterCount(shape)).fill(0);
  const outputOffset = shape.hiddenUnits * inputCount;
  for (let unit = 0; unit < shape.hiddenUnits; unit += 1) {
    const activation = hidden[unit] ?? 0;
    gradient[outputOffset + unit] = delta * activation;
    const throughUnit =
      delta * (parameters[outputOffset + unit] ?? 0) * (1 - activation * activation);
    const offset = unit * inputCount;
    for (let index = 0; index < shape.featureCount; index += 1) {
      gradient[offset + index] = throughUnit * (features[index] ?? 0);
    }
    gradient[offset + shape.featureCount] = throughUnit;
  }
  gradient[outputOffset + shape.hiddenUnits] = delta;
  return gradient;
}

/** Mean squared error over the samples, which is the number a round reports. */
export function meanSquaredError(
  shape: ModelShape,
  parameters: readonly number[],
  samples: readonly { readonly features: readonly number[]; readonly target: number }[],
): number {
  if (samples.length === 0) {
    return 0;
  }
  const total = samples.reduce((sum, sample) => {
    const error = predict(shape, parameters, sample.features) - sample.target;
    return sum + error * error;
  }, 0);
  return total / samples.length;
}

/** L2 penalty, applied to weights but deliberately not to the bias. */
export function l2Penalty(shape: ModelShape, parameters: readonly number[]): number {
  if (shape.kind === 'linear') {
    let total = 0;
    for (let index = 0; index < shape.featureCount; index += 1) {
      total += (parameters[index] ?? 0) ** 2;
    }
    return total;
  }
  const inputCount = shape.featureCount + 1;
  let total = 0;
  for (let unit = 0; unit < shape.hiddenUnits; unit += 1) {
    const offset = unit * inputCount;
    for (let index = 0; index < shape.featureCount; index += 1) {
      total += (parameters[offset + index] ?? 0) ** 2;
    }
  }
  const outputOffset = shape.hiddenUnits * inputCount;
  for (let unit = 0; unit < shape.hiddenUnits; unit += 1) {
    total += (parameters[outputOffset + unit] ?? 0) ** 2;
  }
  return total;
}
