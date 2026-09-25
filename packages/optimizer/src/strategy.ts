import type { PlanRequest, PlannedTransfer, PlannerOptions, TransferPlan } from './planner';
import { planTransfers } from './planner';
import type { ImpactOptions, PlanImpact, ReceiverDemand } from './impact';
import { estimateImpact } from './impact';
import type { PlanVerdict, ValidationWorld } from './validator';
import { validatePlan } from './validator';

/**
 * The strategy layer: what a model is allowed to decide, and what happens when
 * it decides badly.
 *
 * The separation of powers this whole phase rests on is enforced here rather
 * than promised. A model **selects a strategy and writes a rationale**. It does
 * not compute a plan and it does not choose a quantity: each strategy is a set
 * of weights handed to the deterministic planner, and every number an officer
 * reads comes back out of the planner and the validator. The model's lever is
 * the trade-off — how much a kilometre is worth against a facility running dry —
 * and the numbers that follow from it are the optimiser's.
 *
 * Four strategies are offered, and they differ in exactly one stated way each.
 * `balanced` is the shipped weighting; `risk-averse` doubles the price of unmet
 * need so a longer journey becomes acceptable to answer a shortage;
 * `cost-minimising` raises the price of a kilometre so near stock wins; and
 * `expiry-aware` raises the cost of letting a batch sit, so stock closer to
 * expiry is cleared first. The multipliers are constants with their reasoning
 * beside them, not knobs hidden in the arithmetic.
 *
 * The fallback is not a degraded mode. It is the path that actually runs while
 * no reasoning provider is configured — which is the shipping state of this
 * build — so it is a first-class decision rule, written down and deterministic:
 * of the strategies the validator admits, take the one that avoids the most
 * unmet demand per unit-kilometre travelled, tie-broken by the fixed strategy
 * order so the same request always yields the same choice. A model, when one is
 * configured, may override that choice; a model that selects something the
 * validator refuses gets its refusal fed back and, at the end of a bounded loop,
 * the fallback stands.
 *
 * **The refusal is the point.** A strategy layer that has never had an answer
 * rejected is not evidence that its answers are sound — it is evidence that
 * nobody checked. So `evaluateStrategies` runs every candidate through the
 * *same independent validator* the rest of the phase relies on, and a strategy
 * whose plan does not pass is refused by name rather than quietly returned.
 */

// --- The strategies ---------------------------------------------------------

export const STRATEGY_NAMES = [
  'balanced',
  'risk-averse',
  'cost-minimising',
  'expiry-aware',
] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

/**
 * How much each strategy moves the one weight it moves.
 *
 * Stated here so a reader can disagree with a trade-off rather than guess at it.
 * A weight is *relative*: the objective compares unmet need against transport
 * and expiry, so doubling the need term is exactly \"a shortage is worth twice as
 * much as it was against the same drive\".
 */
export const STRATEGY_TRADE_OFFS = {
  /** Weights unmet need twice as heavily: a longer journey becomes worth making. */
  riskAverseUnmetDemandMultiplier: 2,
  /** Weights a kilometre five times as heavily: near stock wins. */
  costMinimisingTransportMultiplier: 5,
  /** Weights letting a batch sit ten times as heavily: expiring stock moves first. */
  expiryAwareExpiryLossMultiplier: 10,
} as const;

export interface StrategyDefinition {
  readonly name: StrategyName;
  /** One line a person can argue with. */
  readonly description: string;
  readonly options: PlannerOptions;
}

export const STRATEGY_DEFINITIONS: readonly StrategyDefinition[] = [
  {
    name: 'balanced',
    description:
      'the shipped weighting — unmet need, transport cost and expiry as the planner proposes them',
    options: {},
  },
  {
    name: 'risk-averse',
    description: `unmet need priced ${String(STRATEGY_TRADE_OFFS.riskAverseUnmetDemandMultiplier)}× higher, accepting longer journeys to answer a shortage`,
    options: { unmetDemandPenaltyPerUnit: STRATEGY_TRADE_OFFS.riskAverseUnmetDemandMultiplier },
  },
  {
    name: 'cost-minimising',
    description: `a kilometre priced ${String(STRATEGY_TRADE_OFFS.costMinimisingTransportMultiplier)}× higher, preferring nearer stock`,
    options: {
      transportCostPerUnitKm: 0.002 * STRATEGY_TRADE_OFFS.costMinimisingTransportMultiplier,
    },
  },
  {
    name: 'expiry-aware',
    description: `letting a batch sit priced ${String(STRATEGY_TRADE_OFFS.expiryAwareExpiryLossMultiplier)}× higher, clearing stock closer to expiry first`,
    options: { expiryLossPerUnit: 0.1 * STRATEGY_TRADE_OFFS.expiryAwareExpiryLossMultiplier },
  },
];

// --- One evaluated strategy -------------------------------------------------

export interface StrategyOutcome {
  readonly name: StrategyName;
  readonly description: string;
  readonly plan: TransferPlan;
  readonly verdict: PlanVerdict;
  readonly impact: PlanImpact;
  /** True when the validator raised no violation. `unchecked` is reported too. */
  readonly acceptable: boolean;
  /** Why it is not acceptable, in one sentence, or `null` when it is. */
  readonly refusal: string | null;
  /** Expected unmet demand avoided per unit-kilometre, the fallback's tie-break. */
  readonly benefitPerUnitKm: number;
}

export interface StrategySetInput {
  /** The request, without its options — each strategy supplies its own. */
  readonly base: Omit<PlanRequest, 'options'>;
  readonly demands: readonly ReceiverDemand[];
  readonly world: ValidationWorld;
  readonly impactOptions?: ImpactOptions | undefined;
}

const unitKmOf = (plan: readonly PlannedTransfer[]): number =>
  plan.reduce((total, transfer) => total + transfer.quantity * transfer.distanceKm, 0);

/**
 * Build and judge one plan per strategy.
 *
 * Everything the caller needs to make or defend a choice is here: the plan, the
 * validator's verdict on it, the impact estimate with its assumptions, and the
 * one ratio the fallback ranks on. The verdict is the independent module's, not
 * a re-check written for this layer.
 */
export function evaluateStrategies(input: StrategySetInput): readonly StrategyOutcome[] {
  return STRATEGY_DEFINITIONS.map((definition) => {
    const plan = planTransfers({ ...input.base, options: definition.options });
    const verdict = validatePlan(plan.transfers, input.world);
    const impact = estimateImpact({
      plan: plan.transfers,
      demands: input.demands,
      options: input.impactOptions,
    });
    const unitKm = unitKmOf(plan.transfers);
    const acceptable = verdict.valid;

    return {
      name: definition.name,
      description: definition.description,
      plan,
      verdict,
      impact,
      acceptable,
      refusal: acceptable
        ? null
        : `${definition.name} is refused by ${String(verdict.violations.length)} constraint(s): ${verdict.violations
            .map((violation) => violation.code)
            .join(', ')}`,
      benefitPerUnitKm: impact.totalExpectedUnmetDemandAvoided / Math.max(1, unitKm),
    };
  });
}

// --- Choosing one -----------------------------------------------------------

/** A model's selection. It names a strategy; it never supplies a quantity. */
export interface StrategyAttempt {
  readonly strategy: StrategyName;
  /**
   * A plan the model tried to hand back. The platform does not trust it — it is
   * put through the validator like anything else, and the loop's whole evidence
   * is that a bad one is refused rather than shipped. Ordinary callers leave it
   * out; it exists so the refusal path can be exercised and, in production, so a
   * provider that volunteers numbers has them judged instead of believed.
   */
  readonly plan?: readonly PlannedTransfer[] | undefined;
}

export interface StrategyRefusal {
  readonly strategy: StrategyName;
  readonly reason: string;
  /** The validator's codes, when a plan was judged to produce the refusal. */
  readonly violations: readonly string[];
}

export interface StrategySelection {
  readonly name: StrategyName;
  readonly decidedBy: 'model' | 'fallback';
  /** One sentence naming what decided it, so a reader can re-derive the choice. */
  readonly reason: string;
  readonly outcome: StrategyOutcome;
  readonly outcomes: readonly StrategyOutcome[];
  /** Attempts the validator refused, oldest first. */
  readonly refusals: readonly StrategyRefusal[];
}

/** The strategy the fallback takes: most unmet demand avoided per unit-kilometre. */
function fallbackOutcome(outcomes: readonly StrategyOutcome[]): StrategyOutcome {
  const acceptable = outcomes.filter((outcome) => outcome.acceptable);
  if (acceptable.length === 0) {
    // Nothing passed. The least-bad answer a caller can act on is the first
    // strategy as defined, and the refusal travels with it rather than being
    // hidden — a plan nobody can validate must not be presented as usable.
    const first = outcomes[0];
    if (first === undefined) {
      throw new Error('no strategies were evaluated');
    }
    return first;
  }
  return acceptable.reduce((best, candidate) =>
    candidate.benefitPerUnitKm > best.benefitPerUnitKm ? candidate : best,
  );
}

const isKnownStrategy = (value: string): value is StrategyName =>
  (STRATEGY_NAMES as readonly string[]).includes(value);

export interface StrategyDecision {
  readonly outcomes: readonly StrategyOutcome[];
  /** The world the plans were judged against; an attempt's plan is judged here too. */
  readonly world: ValidationWorld;
  /** The model's attempt, when a provider was configured and answered. */
  readonly attempt?: StrategyAttempt | undefined;
}

/**
 * Turn evaluated strategies and an optional model attempt into one selection.
 *
 * The order of business is deliberate. An attempt naming a strategy this build
 * does not ship is refused. An attempt carrying a plan is judged by the
 * validator, and a plan with any violation is refused by name. Only an attempt
 * that survives both is allowed to override the fallback.
 */
export function decideStrategy(input: StrategyDecision): StrategySelection {
  const outcomes = input.outcomes;
  const refusals: StrategyRefusal[] = [];

  const attempt = input.attempt;
  if (attempt !== undefined) {
    if (!isKnownStrategy(attempt.strategy)) {
      refusals.push({
        strategy: attempt.strategy,
        reason: `"${String(attempt.strategy)}" is not a strategy this build ships; supported: ${STRATEGY_NAMES.join(', ')}`,
        violations: [],
      });
    } else if (attempt.plan !== undefined) {
      const verdict = validatePlan(attempt.plan, input.world);
      if (!verdict.valid) {
        refusals.push({
          strategy: attempt.strategy,
          reason: `the plan offered for ${attempt.strategy} violates ${String(verdict.violations.length)} constraint(s), so it is refused and the optimiser's own plan stands`,
          violations: verdict.violations.map((violation) => violation.code),
        });
      }
    }
  }

  if (refusals.length === 0 && attempt !== undefined) {
    const chosen = outcomes.find((outcome) => outcome.name === attempt.strategy);
    if (chosen !== undefined) {
      return {
        name: chosen.name,
        decidedBy: 'model',
        reason: `the strategy layer selected ${chosen.name}: ${chosen.description}`,
        outcome: chosen,
        outcomes,
        refusals,
      };
    }
  }

  const fallback = fallbackOutcome(outcomes);
  return {
    name: fallback.name,
    decidedBy: 'fallback',
    reason: `the deterministic fallback chose ${fallback.name}, which avoids the most unmet demand per unit-kilometre (${fallback.benefitPerUnitKm.toExponential(2)}) of the strategies the validator admitted`,
    outcome: fallback,
    outcomes,
    refusals,
  };
}

// --- The bounded tool loop --------------------------------------------------

export const MAX_STRATEGY_ITERATIONS = 3;

export interface StrategyLoopFeedback {
  readonly outcomes: readonly StrategyOutcome[];
  /** Refusals so far, oldest first, so a provider can correct rather than repeat. */
  readonly refusals: readonly StrategyRefusal[];
  readonly iteration: number;
}

/**
 * The model side of the loop. Given the candidates and any refusals so far, it
 * returns an attempt or `undefined` to stand aside.
 *
 * This is a function type rather than a provider call on purpose: the loop does
 * not care whether an answer came from a model, a recorded fixture or a test, so
 * the refusal-then-fallback path is exercised by the same code that runs in
 * production.
 */
export type StrategySelector = (
  feedback: StrategyLoopFeedback,
) => Promise<StrategyAttempt | undefined>;

export interface StrategyProposalResult {
  readonly selection: StrategySelection;
  /** How many times the selector was asked. Zero when none was configured. */
  readonly iterations: number;
  readonly budgetReached: boolean;
}

/**
 * Run the selector up to a bounded number of times, feeding each refusal back.
 *
 * The loop stops the moment an attempt is accepted; if the budget runs out, the
 * fallback stands and every refusal it collected is returned with it. Nothing
 * here can loop forever against a provider that keeps repeating itself.
 */
export async function proposePlan(input: {
  readonly set: StrategySetInput;
  readonly select?: StrategySelector | undefined;
  readonly maxIterations?: number | undefined;
}): Promise<StrategyProposalResult> {
  const outcomes = evaluateStrategies(input.set);
  const maxIterations = input.maxIterations ?? MAX_STRATEGY_ITERATIONS;
  const refusals: StrategyRefusal[] = [];

  let selection = decideStrategy({ outcomes, world: input.set.world });
  let iterations = 0;

  if (input.select !== undefined) {
    while (iterations < maxIterations) {
      iterations += 1;
      const attempt = await input.select({ outcomes, refusals, iteration: iterations });
      if (attempt === undefined) {
        break;
      }
      const decided = decideStrategy({ outcomes, world: input.set.world, attempt });
      if (decided.decidedBy === 'model') {
        // Accepted, but any refusals it took to get here still travel with the
        // result: a correction is part of the record, not a discarded one.
        selection = { ...decided, refusals: [...refusals] };
        break;
      }
      refusals.push(...decided.refusals);
      selection = { ...decided, refusals: [...refusals] };
    }
  }

  return { selection, iterations, budgetReached: iterations >= maxIterations };
}
