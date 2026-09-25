import type { DateOnly, Syndrome } from '@civora/domain';

/**
 * The scripted scenarios, and the two negative controls that matter as much.
 *
 * Each preset is a reproducible perturbation with a named expectation. The
 * expectation is what makes it a test rather than a story: a scenario that
 * says a fever surge should be visible is only useful if something later
 * checks that a fever surge is visible, and a stable baseline is only useful
 * if something checks that the platform stays quiet.
 */

export interface DistrictTarget {
  /** State names to include. All districts of those states are affected. */
  readonly states: readonly string[];
  /** District names to restrict to within those states. Omitted means all. */
  readonly districts?: readonly string[];
}

export interface SurgeSpec {
  readonly syndrome: Syndrome;
  readonly target: DistrictTarget;
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Peak demand multiplier over the affected period. */
  readonly multiplier: number;
}

export interface SupplyDisruptionSpec {
  readonly target: DistrictTarget;
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Lead time multiplier: how much longer replenishment takes. */
  readonly leadTimeMultiplier: number;
}

export interface ColdChainFailureSpec {
  readonly target: DistrictTarget;
  readonly from: DateOnly;
  readonly to: DateOnly;
}

export interface OfflineSpec {
  readonly target: DistrictTarget;
  readonly from: DateOnly;
  readonly to: DateOnly;
}

export interface ExpiryCliffSpec {
  readonly target: DistrictTarget;
  readonly from: DateOnly;
  readonly to: DateOnly;
  /** Share of a facility's opening batch that expires inside the window. */
  readonly nearExpiryShare: number;
}

export interface ScenarioSpec {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  /** What a working platform must show when this scenario runs. */
  readonly expectation: string;
  /** True when the correct outcome is *no* signal, which is a result too. */
  readonly negativeControl: boolean;
  readonly surge?: SurgeSpec;
  readonly supplyDisruption?: SupplyDisruptionSpec;
  readonly coldChainFailure?: ColdChainFailureSpec;
  readonly offline?: OfflineSpec;
  readonly expiryCliff?: ExpiryCliffSpec;
  /**
   * Days of demand every facility opens the window with.
   *
   * Set only where a scenario needs a constructed starting point rather than an
   * observed one. The no-transfer control has to begin from a fully stocked
   * network for its assertion — that the optimiser proposes nothing — to be a
   * statement about the optimiser rather than about the stock it was given.
   */
  readonly openingCoverDays?: number;
  /** Days of demand the facility's own reordering rule aims to restore. */
  readonly orderingTargetDays?: number;
  /**
   * Cover at or below which the facility's own rule reorders.
   *
   * Set together with the two above where a scenario needs a facility that is
   * stocked by its own rule and not merely at the start. A control that ran out
   * for a day because its reorder point was tight would be testing the reorder
   * point rather than the thing it was written to test.
   */
  readonly reorderCoverDays?: number;
}

/**
 * The window every scenario is written against.
 *
 * Fixed rather than relative to today, so a dataset generated today and one
 * generated next month are byte-identical for the same seed. The platform's
 * notion of "now" is a parameter, not a clock reading.
 */
export const SIMULATION_END: DateOnly = '2026-09-24';

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: 'monsoon-fever-surge',
    label: 'Monsoon vector-borne surge',
    purpose:
      'Seasonal rise in fever presentations across two eastern states, steepened beyond the seasonal norm.',
    expectation:
      'A fever surge is visible in the syndromic series, and fever-driven items show raised demand and depleted cover.',
    negativeControl: false,
    surge: {
      syndrome: 'fever',
      target: { states: ['Odisha', 'Bihar'] },
      from: '2026-07-15',
      to: '2026-09-15',
      multiplier: 3.2,
    },
  },
  {
    id: 'diarrhoeal-outbreak',
    label: 'Diarrhoeal outbreak after contamination',
    purpose:
      'A sharp localised rise in diarrhoea presentations in one district, on top of the monsoon baseline.',
    expectation:
      'A diarrhoea surge is detected in the affected district only, and rehydration items are flagged for replenishment.',
    negativeControl: false,
    surge: {
      syndrome: 'diarrhoea',
      target: { states: ['Bihar'], districts: ['Patna'] },
      from: '2026-05-01',
      to: '2026-06-15',
      multiplier: 4,
    },
  },
  {
    id: 'facility-offline',
    label: 'Facility offline for two weeks',
    purpose: 'A district where reporting stops for a fortnight while the facilities keep working.',
    expectation:
      'Reporting gaps are raised for the affected facilities, and their positions are shown as stale rather than as current.',
    negativeControl: false,
    offline: {
      target: { states: ['Odisha'], districts: ['Khordha'] },
      from: '2026-06-01',
      to: '2026-06-14',
    },
  },
  {
    id: 'state-warehouse-disruption',
    label: 'State warehouse supply disruption',
    purpose:
      'Replenishment lead times triple for six weeks, so facilities draw down to zero while orders are in flight.',
    expectation:
      'Stock-outs appear at facilities that were comfortably stocked, and stock in transit is visible before it arrives.',
    negativeControl: false,
    supplyDisruption: {
      target: { states: ['Odisha'] },
      from: '2026-07-01',
      to: '2026-08-15',
      leadTimeMultiplier: 3,
    },
  },
  {
    id: 'cold-chain-failure',
    label: 'Cold-chain failure at a cluster of facilities',
    purpose:
      'Refrigeration fails for three weeks across a southern district, while stock continues to arrive.',
    expectation:
      'Cold-chain items at the affected facilities are flagged as at risk, and are excluded as donors in redistribution.',
    negativeControl: false,
    coldChainFailure: {
      target: { states: ['Kerala'], districts: ['Ernakulam'] },
      from: '2026-04-01',
      to: '2026-04-21',
    },
  },
  {
    id: 'district-expiry-cliff',
    label: 'District expiry cliff',
    purpose: 'A bulk receipt close to its expiry date arrives at every facility in one district.',
    expectation:
      'Near-expiry stock is reported before it becomes waste, and the district is offered as a donor while it still can be.',
    negativeControl: false,
    expiryCliff: {
      target: { states: ['Maharashtra'], districts: ['Pune'] },
      from: '2026-03-01',
      to: '2026-09-15',
      nearExpiryShare: 0.5,
    },
  },
  {
    id: 'stable-baseline',
    label: 'Stable baseline (negative control)',
    purpose: 'Ordinary seasonal behaviour with no shocks and no disruptions anywhere.',
    expectation:
      'No surge signals at all. A platform that finds outbreaks in a quiet year will not be trusted in a busy one — this is the test that keeps it honest.',
    negativeControl: true,
  },
  {
    id: 'no-transfer-warranted',
    label: 'No beneficial transfer (negative control)',
    purpose:
      'Every facility comfortably stocked against its own demand, so no redistribution can do any good.',
    expectation:
      'The optimiser finds no transfers worth making. Recommending a move here would mean moving stock to create activity, not to prevent a shortage.',
    negativeControl: true,
    expiryCliff: {
      target: { states: ['Tamil Nadu'] },
      from: '2026-03-01',
      to: '2026-09-24',
      nearExpiryShare: 0,
    },
    openingCoverDays: 120,
    orderingTargetDays: 120,
    reorderCoverDays: 90,
  },
];

/**
 * The first day a generated history must cover.
 *
 * Derived from the scenarios rather than typed in, so that moving a scenario
 * window earlier cannot leave the dataset it is meant to exercise starting
 * after it does.
 */
export const HISTORY_FROM: DateOnly = SCENARIOS.reduce<DateOnly>((earliest, scenario) => {
  let result = earliest;
  for (const window of [
    scenario.surge,
    scenario.supplyDisruption,
    scenario.coldChainFailure,
    scenario.offline,
    scenario.expiryCliff,
  ]) {
    if (window !== undefined && window.from < result) {
      result = window.from;
    }
  }
  return result;
}, SIMULATION_END);

export const SCENARIO_BY_ID: ReadonlyMap<string, ScenarioSpec> = new Map(
  SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

export const DEFAULT_SCENARIO_ID = 'monsoon-fever-surge';

export const requireScenario = (id: string): ScenarioSpec => {
  const scenario = SCENARIO_BY_ID.get(id);
  if (scenario === undefined) {
    throw new Error(
      `unknown scenario: ${id}. Known scenarios: ${SCENARIOS.map((entry) => entry.id).join(', ')}`,
    );
  }
  return scenario;
};

/** How far into a surge window a given day sits, as a multiplier. */
export const surgeFactorOn = (surge: SurgeSpec | undefined, day: DateOnly): number => {
  if (surge === undefined || day < surge.from || day > surge.to) {
    return 1;
  }

  // A ramp rather than a step: real outbreaks build and recede, and a step
  // change would make detection a trivial problem that no real signal solves.
  const total = dayCount(surge.from, surge.to);
  const position = dayCount(surge.from, day);
  const shape = Math.sin((Math.PI * position) / Math.max(total, 1));
  return 1 + (surge.multiplier - 1) * Math.max(shape, 0.15);
};

const dayCount = (from: DateOnly, to: DateOnly): number =>
  Math.max(
    0,
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ),
  );

/** Whether a day falls inside a scenario window. */
export const within = (
  window: { readonly from: DateOnly; readonly to: DateOnly } | undefined,
  day: DateOnly,
): boolean => window !== undefined && day >= window.from && day <= window.to;

/** Whether a facility is targeted by a scenario's district selection. */
export const targets = (
  target: DistrictTarget | undefined,
  stateName: string,
  districtName: string,
): boolean => {
  if (!target?.states.includes(stateName)) {
    return false;
  }
  return target.districts === undefined || target.districts.includes(districtName);
};
