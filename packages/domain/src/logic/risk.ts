import type {
  DateOnly,
  EssentialityTier,
  FacilityId,
  ItemId,
  Provenance,
  RiskBand,
  RiskDriver,
  RiskScore,
  Syndrome,
} from '../model';

/**
 * Nine drivers, added up, with the working shown.
 *
 * A stock-out risk score is the easiest place in a system like this to hide a
 * guess. Nine plausible inputs multiplied by nine undocumented weights produce a
 * number that looks like analysis, cannot be argued with, and is impossible to
 * improve because nobody can see which part of it was wrong. So the design here
 * is deliberately *unexciting*:
 *
 *  - Each driver is a small pure function of measured facts, in **log-odds**.
 *    Log-odds because the drivers are independent reasons for something to go
 *    wrong, and adding them is the only defensible way to combine them; adding
 *    probabilities would need an independence assumption that clearly fails
 *    here.
 *  - Every driver returns a **sentence naming the number** it used. If a driver
 *    cannot name a number, it is not a driver.
 *  - The weights are one exported constant. Anyone who disagrees with the score
 *    can read the weight, change it, re-run the batch job, and see what moved.
 *  - What could **not** be measured is returned too. A score assembled from half
 *    the inputs is not a low score, and the band says so.
 *
 * What this module is not: a learned model. Nothing here is fitted, so nothing
 * here can be a black box. The calibration that exists is that the total is a
 * log-odds and the offset below was chosen so that a facility with a month of
 * cover, no surge and current reporting lands low.
 *
 * The total produces an **index**, not a probability. The two are carried
 * separately on a score and must not be conflated: `riskIndex` is what the nine
 * weights add up to and is only ever used to order a list and pick a band, while
 * `shortfallProbability` is the forecast's own measured number, passed through
 * untouched and null when there was nothing to measure. Summing weighted
 * log-odds across reasons that are not independent gives a defensible ranking
 * and an indefensible probability, so the module refuses to present one.
 */

/**
 * How much each driver can move the log-odds, at full severity.
 *
 * Read as a stack of independent reasons. `reportingGap` is weighted high not
 * because a silent facility is likely to run out, but because the platform
 * cannot tell, and a decision-support tool that stays quiet when it is blind is
 * worse than one that says nothing at all.
 */
export const DRIVER_WEIGHTS: Readonly<Record<RiskDriver, number>> = {
  shortfallProbability: 4,
  daysOfStock: 3,
  leadTime: 1.6,
  criticality: 1.8,
  populationAtRisk: 1.2,
  surgeSignal: 2.6,
  expiryPressure: 1.4,
  reportingGap: 3.6,
  coldChain: 1,
};

/**
 * Shifts the summed log-odds so an unremarkable facility reads low rather than even.
 *
 * Needed because several drivers carry weight for reasons that are true of every
 * facility — an item is on the essential list, a delivery takes eight days. Left
 * unshifted, those add up to a mid-range score for a shelf nobody has any
 * reason to worry about, and a surface that calls everything a moderate risk has
 * told an officer nothing. The value is the total those unremarkable settings
 * accumulate (about 1.4) plus the 2.2 that puts an ordinary facility in the
 * lowest band, and it is one constant so that changing it is a one-line
 * experiment. It calibrates the **index**; it never touches the measured
 * probability, which comes from the forecast and is passed straight through.
 */
const LOG_ODDS_OFFSET = 3.6;

/** Index at or above which a band is critical however poor the data is. */
const CRITICAL_FLOOR = 0.7;

/**
 * Days without a reading after which the score stops being a measurement.
 *
 * Three, matching the visibility projection: a facility that has missed three
 * consecutive days is not having intermittent connectivity, and a risk figure
 * derived from a fortnight-old shelf count is a way of sounding certain about
 * something nobody has looked at.
 */
export const STALE_AFTER_DAYS = 3;

/** Index thresholds between bands. `unknown` is decided separately. */
const BAND_THRESHOLDS: readonly (readonly [number, RiskBand])[] = [
  [0.7, 'critical'],
  [0.4, 'high'],
  [0.2, 'watch'],
  [0, 'low'],
];

export interface SurgeFact {
  readonly syndrome: Syndrome;
  readonly growthRate: number;
  readonly multiplier: number;
  /** Days of the horizon the multiplier covers. */
  readonly daysApplied: number;
}

/**
 * What the platform measured about one facility-item pair at one moment.
 *
 * Every field that can be unknown is nullable rather than defaulted. A missing
 * lead time is not a lead time of zero, and encoding it as one would silently
 * make an unknown facility look like the best-supplied one in the district.
 */
export interface RiskFacts {
  readonly facilityId: FacilityId;
  readonly itemId: ItemId;
  readonly asOf: DateOnly;
  readonly horizonDays: number;
  /** Probability that forecast demand exceeds stock inside the horizon. */
  readonly shortfallProbability: number | null;
  /** Days of cover from the forecast, or null when no rate could be derived. */
  readonly daysOfStock: number | null;
  readonly onHand: number;
  readonly inTransit: number;
  readonly leadTimeDays: number;
  /** Spread of the observed lead time, in days. Zero when only one was seen. */
  readonly leadTimeSpreadDays: number;
  /** An order is already on its way, so the lead time is already running. */
  readonly orderInFlight: boolean;
  readonly essentiality: EssentialityTier;
  readonly catchmentPopulation: number;
  /** Recent footfall over the prior period. Above one means attendances are rising. */
  readonly footfallTrend: number | null;
  readonly surge: SurgeFact | null;
  /** Days until the nearest batch expires, and how much sits in it. */
  readonly daysToNearestExpiry: number | null;
  readonly nearExpiryUnits: number;
  /** Days since the platform last heard anything from this facility at all. */
  readonly daysSinceReading: number | null;
  /** Days of declared reporting gap over the recent window. */
  readonly reportingGapDays: number;
  readonly coldChain: boolean;
  /** Days since a recorded cold-chain breach, or null when none was seen. */
  readonly coldChainBreachDays: number | null;
  readonly synthetic: boolean;
  readonly provenance: Provenance;
}

interface DriverReading {
  readonly contribution: number;
  readonly detail: string;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const logistic = (value: number): number => 1 / (1 + Math.exp(-value));

/**
 * One reading per driver. Each returns a contribution and a sentence, and each
 * is written so that a reader can reconstruct the contribution from the
 * sentence without reading this file.
 */
const readingFor = (driver: RiskDriver, facts: RiskFacts): DriverReading => {
  switch (driver) {
    case 'shortfallProbability': {
      if (facts.shortfallProbability === null) {
        return {
          contribution: 0,
          detail:
            'no forecast was available, so the probability demand outruns stock could not be computed',
        };
      }
      const probability = clamp(facts.shortfallProbability, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.shortfallProbability * probability,
        detail: `the forecast puts the chance of demand outrunning stock inside ${String(
          facts.horizonDays,
        )} days at ${(probability * 100).toFixed(1)}%`,
      };
    }

    case 'daysOfStock': {
      // Measured against the longer of the lead time and the horizon: cover that
      // does not outlast the wait for a delivery is not cover.
      const need = Math.max(facts.leadTimeDays, facts.horizonDays);
      if (facts.daysOfStock === null) {
        return {
          contribution: 0,
          detail:
            'no demand rate could be derived from the history, so cover in days could not be computed',
        };
      }
      const cover = Math.max(0, facts.daysOfStock);
      const severity = clamp(1 - cover / need, 0, 1);
      const surplus = cover > need * 3 ? clamp((cover / need - 3) / 6, 0, 1) : 0;
      return {
        contribution: DRIVER_WEIGHTS.daysOfStock * (severity - surplus),
        detail: `${cover.toFixed(
          1,
        )} days of cover against the ${String(need)} days it takes to be resupplied`,
      };
    }

    case 'leadTime': {
      const total = facts.leadTimeDays + facts.leadTimeSpreadDays;
      const severity = clamp((total - 3) / 15, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.leadTime * severity,
        detail: `resupply takes ${facts.leadTimeDays.toFixed(0)} days${
          facts.leadTimeSpreadDays > 0
            ? ` and has varied by ${facts.leadTimeSpreadDays.toFixed(1)} days`
            : ' and has not varied in the history'
        }${facts.orderInFlight ? ', with an order already in flight' : ''}`,
      };
    }

    case 'criticality': {
      const severity =
        facts.essentiality === 'essential' ? 1 : facts.essentiality === 'programme' ? 0.6 : 0.25;
      return {
        contribution: DRIVER_WEIGHTS.criticality * severity,
        detail: `the item is on the ${facts.essentiality} list, so a stock-out is ${
          facts.essentiality === 'essential' ? 'not substitutable' : 'costly but not immediate'
        }`,
      };
    }

    case 'populationAtRisk': {
      const scale = 0.6 + clamp(facts.catchmentPopulation / 100000, 0, 1) * 0.4;
      const trend = facts.footfallTrend ?? 1;
      const severity = clamp(0.4 + (trend - 1) * 2, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.populationAtRisk * severity * scale,
        detail: `${facts.catchmentPopulation.toLocaleString('en-IN')} people are served here and attendances are ${
          facts.footfallTrend === null
            ? 'not measured'
            : `${trend >= 1 ? 'up' : 'down'} ${(Math.abs(trend - 1) * 100).toFixed(0)}%`
        }`,
      };
    }

    case 'surgeSignal': {
      if (facts.surge === null || facts.surge.multiplier <= 1) {
        return {
          contribution: 0,
          detail: 'no epidemic surge is affecting this item',
        };
      }
      const severity = clamp((facts.surge.multiplier - 1) / 1, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.surgeSignal * severity,
        detail: `a ${facts.surge.syndrome} surge growing ${(facts.surge.growthRate * 100).toFixed(
          1,
        )}% a day is expected to raise demand for this item by ${
          facts.surge.multiplier - 1 >= 0 ? ((facts.surge.multiplier - 1) * 100).toFixed(0) : '0'
        }% over ${String(facts.surge.daysApplied)} days`,
      };
    }

    case 'expiryPressure': {
      if (facts.nearExpiryUnits <= 0 || facts.daysToNearestExpiry === null) {
        return {
          contribution: 0,
          detail: 'no batch is close enough to expiry to matter inside the horizon',
        };
      }
      const severity = clamp(
        (facts.horizonDays - facts.daysToNearestExpiry) / facts.horizonDays,
        0,
        1,
      );
      return {
        contribution: DRIVER_WEIGHTS.expiryPressure * severity,
        detail: `${facts.nearExpiryUnits.toFixed(
          0,
        )} units expire in ${facts.daysToNearestExpiry.toFixed(0)} days, so they cannot be counted on to cover the ${
          facts.horizonDays
        }-day horizon`,
      };
    }

    case 'reportingGap': {
      if (facts.daysSinceReading === null) {
        return {
          contribution: DRIVER_WEIGHTS.reportingGap,
          detail: 'this facility has never reported, so nothing here is measured',
        };
      }
      const silence = clamp(facts.daysSinceReading / (STALE_AFTER_DAYS * 2), 0, 1);
      const gaps = clamp(facts.reportingGapDays / 30, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.reportingGap * clamp(silence * 0.7 + gaps * 0.3, 0, 1),
        detail: `nothing has arrived for ${facts.daysSinceReading.toFixed(0)} days${
          facts.reportingGapDays > 0
            ? `, and ${facts.reportingGapDays.toFixed(0)} days of gap were declared over the recent window`
            : ', and no gap was declared'
        }`,
      };
    }

    case 'coldChain': {
      if (!facts.coldChain) {
        return {
          contribution: 0,
          detail: 'the item does not need cold storage',
        };
      }
      if (facts.coldChainBreachDays === null) {
        return {
          contribution: DRIVER_WEIGHTS.coldChain * 0.4,
          detail: 'the item needs cold storage and no temperature breach has been recorded',
        };
      }
      const recency = clamp(1 - facts.coldChainBreachDays / 60, 0, 1);
      return {
        contribution: DRIVER_WEIGHTS.coldChain * (0.4 + 0.6 * recency),
        detail: `a cold-chain breach was recorded ${facts.coldChainBreachDays.toFixed(
          0,
        )} days ago, so stock here cannot be assumed usable`,
      };
    }
  }
};

/** The facts the drivers consumed, for a reader who wants the raw numbers. */
const factsOf = (facts: RiskFacts): { name: string; value: number }[] => {
  const entries: [string, number | null][] = [
    ['horizonDays', facts.horizonDays],
    ['shortfallProbability', facts.shortfallProbability],
    ['daysOfStock', facts.daysOfStock],
    ['onHand', facts.onHand],
    ['inTransit', facts.inTransit],
    ['leadTimeDays', facts.leadTimeDays],
    ['leadTimeSpreadDays', facts.leadTimeSpreadDays],
    ['orderInFlight', facts.orderInFlight ? 1 : 0],
    ['catchmentPopulation', facts.catchmentPopulation],
    ['footfallTrend', facts.footfallTrend],
    ['surgeMultiplier', facts.surge?.multiplier ?? null],
    ['surgeGrowthRate', facts.surge?.growthRate ?? null],
    ['daysToNearestExpiry', facts.daysToNearestExpiry],
    ['nearExpiryUnits', facts.nearExpiryUnits],
    ['daysSinceReading', facts.daysSinceReading],
    ['reportingGapDays', facts.reportingGapDays],
    ['coldChain', facts.coldChain ? 1 : 0],
    ['coldChainBreachDays', facts.coldChainBreachDays],
  ];

  return entries
    .filter((entry): entry is [string, number] => entry[1] !== null)
    .map(([name, value]) => ({ name, value }));
};

/** Everything the score wanted and did not get. */
const missingOf = (facts: RiskFacts): string[] => {
  const missing: string[] = [];
  if (facts.shortfallProbability === null) {
    missing.push('no forecast for this item at this facility');
  }
  if (facts.daysOfStock === null) {
    missing.push('no demand rate could be derived from the history');
  }
  if (facts.daysSinceReading === null) {
    missing.push('the facility has never reported');
  }
  if (facts.footfallTrend === null) {
    missing.push('no footfall trend was measurable');
  }
  if (facts.coldChain && facts.coldChainBreachDays === null) {
    missing.push('no cold-chain observation has been recorded');
  }
  return missing;
};

/**
 * Score one facility-item pair.
 *
 * The band is decided on two axes and the split between them is the point. The
 * index says how bad the combination of reasons is; the data's freshness and
 * completeness say whether the score rests on a measurement or an impression.
 * A stale facility whose last measurement was alarming stays critical, because a
 * caveat must not silence a real signal — but a stale facility that has never
 * looked bad moves to `unknown` rather than staying green, because "we last
 * looked, and it was fine" and "we have not looked" are different statements and
 * only one of them is safe to act on.
 */
export function scoreRisk(facts: RiskFacts): RiskScore {
  const drivers = (Object.keys(DRIVER_WEIGHTS) as RiskDriver[]).map((driver) => {
    const reading = readingFor(driver, facts);
    return {
      driver,
      contribution: round(reading.contribution, 4),
      detail: reading.detail,
    };
  });

  const total = drivers.reduce((sum, driver) => sum + driver.contribution, 0);
  const riskIndex = round(clamp(logistic(total - LOG_ODDS_OFFSET), 0, 1), 4);

  // Passed through, not derived: when the forecast measured a probability, that
  // is the number a reader acts on, and when it did not, the score says so
  // rather than substituting the index for it.
  const shortfallProbability =
    facts.shortfallProbability === null ? null : round(clamp(facts.shortfallProbability, 0, 1), 4);

  const stale = facts.daysSinceReading === null || facts.daysSinceReading > STALE_AFTER_DAYS;
  const measurable = facts.shortfallProbability !== null && facts.daysOfStock !== null;

  const band: RiskBand =
    (!measurable || stale) && riskIndex < CRITICAL_FLOOR ? 'unknown' : bandFor(riskIndex);

  return {
    facilityId: facts.facilityId,
    itemId: facts.itemId,
    asOf: facts.asOf,
    horizonDays: facts.horizonDays,
    shortfallProbability,
    riskIndex,
    band,
    drivers: [...drivers].sort((left, right) => right.contribution - left.contribution),
    facts: factsOf(facts),
    missing: missingOf(facts),
    synthetic: facts.synthetic,
    provenance: facts.provenance,
  };
}

/** The band a composite risk index falls in. */
export function bandFor(riskIndex: number): RiskBand {
  for (const [threshold, band] of BAND_THRESHOLDS) {
    if (riskIndex >= threshold) {
      return band;
    }
  }
  return 'low';
}

/**
 * Just enough of a score's facts to write an alert subject line.
 *
 * Quoting the measured probability when there is one, and the index and band
 * when there is not — deliberately never both in one sentence, because a reader
 * shown "70% chance" beside "index 0.81" has no way to know which number the
 * decision was made on.
 */
export const describeScore = (score: RiskScore): string => {
  const worst = score.drivers[0];
  const likelihood =
    score.shortfallProbability === null
      ? `risk index ${score.riskIndex.toFixed(2)} on the ${score.band} band over ${String(
          score.horizonDays,
        )} days`
      : `${(score.shortfallProbability * 100).toFixed(0)}% chance of running out within ${String(
          score.horizonDays,
        )} days`;
  return `${likelihood}${worst === undefined ? '' : ` — ${worst.detail}`}`;
};
