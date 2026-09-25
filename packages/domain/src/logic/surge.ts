import type { DateOnly, DistrictId, FacilityId, RegionId } from '../model/common';
import type { EpidemicEvent, SurgeMethod, Syndrome } from '../model';
import { addDays, daysBetween } from './dates';

/**
 * Turning syndromic counts into a demand signal.
 *
 * A district's fever counts rise every August, every Sunday, and every time a
 * clinic has a good week of reporting. Only one of those is an outbreak. This
 * module removes the two that are not — the seasonal and the weekly — before it
 * asks whether the third is real, and it asks with an accumulating test rather
 * than a single-day threshold, because a single bad day is not an epidemic.
 *
 * Three statistical ideas, each chosen for a reason that matters operationally:
 *
 *  - **De-noising by seasonal and day-of-week factors**, estimated from the
 *    facility's own history. A district that reports 40% more fever in the
 *    monsoon is not surging in August; it is August.
 *  - **CUSUM**, which accumulates small persistent deviations instead of waiting
 *    for one large one. An outbreak that adds three cases a day for a fortnight
 *    is more dangerous than a data entry of three hundred once, and a
 *    threshold-on-the-day rule cannot tell the two apart.
 *  - **EARS-style residuals**, reported beside it, because they are what a
 *    district surveillance officer already reads and an unfamiliar alarm is an
 *    unactioned alarm.
 *
 * The growth rate is the number the platform acts on, and it is estimated by
 * least squares on log counts so that it is literally an exponential rate per
 * day. Nothing here estimates a reproduction number: that needs assumptions
 * about contact rates this platform cannot verify, and a number nobody can check
 * is worse than no number.
 */

/** One facility's count of one syndrome on one day. */
export interface SyndromeDay {
  readonly on: DateOnly;
  readonly caseCount: number;
}

export interface SurgeOptions {
  /** Days of history used to estimate the seasonal and weekly pattern. */
  readonly patternWindowDays?: number;
  /** Days of history used to set the responsive level and its spread. */
  readonly baselineWindowDays?: number;
  /**
   * Half-life of the exponentially weighted level, in days.
   *
   * Seven, so the level tracks a two-week change in reporting while a single
   * stray day moves it by about a tenth. A shorter half-life makes the detector
   * chase noise and raise alerts nobody acts on; a longer one misses an outbreak
   * that builds over a fortnight, which is the shape most of these have.
   */
  readonly ewmaHalfLifeDays?: number;
  /** CUSUM slack, in standard deviations. How much drift is ignored per day. */
  readonly cusumSlack?: number;
  /** CUSUM decision threshold, in standard deviations. */
  readonly cusumThreshold?: number;
  /** EARS baseline length and the guard band between it and today. */
  readonly earsWindowDays?: number;
  readonly earsGuardDays?: number;
  /** EARS decision threshold, in standard deviations of the baseline window. */
  readonly earsThreshold?: number;
  /** Days of history below which nothing is tested at all. */
  readonly minimumHistoryDays?: number;
  /**
   * Days from the crossing the growth rate is estimated over.
   *
   * A fortnight, and the reason is that "growth rate" has a meaning in an
   * outbreak and it is the rate of the *rising phase*. Estimated over a whole
   * eight-week outbreak it would be near zero — an epidemic that trebled in its
   * first week and then plateaued has not been growing slowly, it has finished
   * growing — and the gate below would then reject a surge that is plainly there.
   * So the rate is measured where the growth is.
   */
  readonly initialPhaseDays?: number;
  /**
   * Smallest number of days a run must have lasted before it counts.
   *
   * A week, so that a crossing in the last few days of a history is not treated
   * as an outbreak. A run that has barely begun cannot be measured, and "a change
   * started yesterday" is not a finding.
   */
  readonly minimumRunDays?: number;
  /**
   * Smallest excess over the expected count worth waking anybody for.
   *
   * Growth rate alone is meaningless on small numbers: one case becoming two is
   * a 100% rise and nothing at all. Both conditions must hold.
   */
  readonly minimumExcessCases?: number;
}

const DEFAULTS: Required<SurgeOptions> = {
  patternWindowDays: 84,
  baselineWindowDays: 56,
  ewmaHalfLifeDays: 7,
  cusumSlack: 0.5,
  cusumThreshold: 4,
  earsWindowDays: 7,
  earsGuardDays: 2,
  earsThreshold: 3,
  minimumHistoryDays: 28,
  minimumRunDays: 7,
  minimumExcessCases: 3,
  initialPhaseDays: 14,
};

/** One day's verdict, kept per day so a detection can be read as a trajectory. */
export interface SurgeDayDiagnostic {
  readonly on: DateOnly;
  readonly caseCount: number;
  /** Count with the seasonal and weekly pattern divided out. */
  readonly adjusted: number;
  /** Exponentially weighted level of the adjusted series, as at this day. */
  readonly level: number;
  /** Positive CUSUM in standard deviations; zero when nothing has accumulated. */
  readonly cusum: number;
  /** EARS residual in standard deviations against its own window. */
  readonly ears: number;
  readonly expected: number;
}

export interface SurgeDetection {
  readonly syndrome: Syndrome;
  readonly detected: boolean;
  readonly method: SurgeMethod;
  /** The day the accumulating test crossed, or the last day when it did not. */
  readonly detectedOn: DateOnly;
  /** Exponential growth rate of case counts per day, from log-linear regression. */
  readonly growthRate: number;
  /** Cases per day the pattern alone would have produced. */
  readonly baselineCaseCount: number;
  /** Cases per day actually seen over the surge window. */
  readonly observedCaseCount: number;
  /** Observed minus expected, per day. Always positive on a detection. */
  readonly excessCasesPerDay: number;
  /** Days either side of the crossing the growth rate was estimated over. */
  readonly windowDays: number;
  readonly diagnostics: readonly SurgeDayDiagnostic[];
  /** Why nothing was raised, when nothing was. Never empty on a non-detection. */
  readonly reasons: readonly string[];
}

const sum = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0);

const mean = (values: readonly number[]): number => sum(values) / Math.max(1, values.length);

/** The middle observation, averaged over the two middles when the count is even. */
const median = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  if (!Number.isInteger(middle)) {
    return sorted[Math.floor(middle)] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const weekdayOf = (day: DateOnly): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();

const monthOf = (day: DateOnly): number => Number(day.slice(5, 7));

/** One series of counts, ascending by day and gapless. */
export interface SyndromeSeries {
  readonly syndrome: Syndrome;
  readonly days: readonly SyndromeDay[];
}

/**
 * The weekly and seasonal shape of a facility's own reporting.
 *
 * Estimated from the facility's history rather than taken from a national
 * table, because reporting rhythms differ by district — a clinic open six days
 * is not a clinic open seven — and a factor fitted from a thousand other
 * facilities would flatten exactly the local pattern the de-noising is for.
 *
 * Both factors are multiplicative and normalised to one, so applying them and
 * inverting them leaves the average count untouched. That matters: a correction
 * that shifts the level would move the expected count the CUSUM test is measured
 * against, and the test would detect its own adjustment.
 *
 * Every statistic here is a **median**, and that is not a stylistic choice. The
 * window includes the outbreak being looked for, and an outbreak of a hundredfold
 * magnitude would drag a mean so far that the fitted "normal" week would be the
 * epidemic itself, the adjusted series would look flat, and the detector would
 * find nothing at exactly the moment it was needed. A median is unmoved by up to
 * half the window being contaminated, which is the property being bought.
 */
export interface ReportingPattern {
  /** Multiplier by weekday, Sunday first. */
  readonly weekday: readonly number[];
  /** Multiplier by month, January first. */
  readonly month: readonly number[];
  /** Days the pattern was fitted from. */
  readonly fittedOnDays: number;
  /** The grand mean of the raw counts over the fitting window. */
  readonly overallMean: number;
}

export function fitReportingPattern(
  days: readonly SyndromeDay[],
  options: SurgeOptions = {},
): ReportingPattern {
  const { patternWindowDays } = { ...DEFAULTS, ...options };
  const window = days.slice(-patternWindowDays);
  const overallMean = median(window.map((day) => day.caseCount));
  if (overallMean <= 0) {
    return {
      weekday: new Array<number>(7).fill(1),
      month: new Array<number>(12).fill(1),
      fittedOnDays: window.length,
      overallMean: 0,
    };
  }

  const factorOf = (groups: number, indexOf: (day: DateOnly) => number): readonly number[] => {
    const perGroup: number[][] = Array.from({ length: groups }, () => []);
    for (const day of window) {
      perGroup[indexOf(day.on)]?.push(day.caseCount);
    }

    return perGroup.map((counts) => {
      if (counts.length === 0) {
        return 1;
      }
      // Shrunk toward one by the number of observations, so a weekday seen once
      // does not get a factor fitted to a single day of reporting.
      const observed = median(counts) / overallMean;
      const weight = counts.length / (counts.length + 3);
      // Bounded so that a factor fitted from very little cannot invert the
      // series and turn a real surge into a decline on paper.
      return Math.min(3, Math.max(0.2, 1 + (observed - 1) * weight));
    });
  };

  return {
    weekday: factorOf(7, weekdayOf),
    month: factorOf(12, monthOf),
    fittedOnDays: window.length,
    overallMean,
  };
}

/** Divide the pattern out of a count. */
export const adjustedCount = (day: SyndromeDay, pattern: ReportingPattern): number => {
  const factor =
    (pattern.weekday[weekdayOf(day.on)] ?? 1) * (pattern.month[monthOf(day.on) - 1] ?? 1);
  return factor <= 0 ? day.caseCount : day.caseCount / factor;
};

/**
 * Least-squares slope of log counts against time.
 *
 * Ordinary least squares on `log(count + 1)`, so a zero day is representable and
 * the slope is the exponential rate per day. The smoothing constant is not a
 * fudge: it is stated here, applied to every series identically, and documented,
 * because an outbreak reaching zero cases on a Sunday would otherwise make the
 * logarithm undefined and the whole estimate undefined with it.
 */
export function exponentialGrowthRate(days: readonly SyndromeDay[]): number {
  const points = days
    .map((day, index) => ({ x: index, y: Math.log(day.caseCount + 1) }))
    .filter((point) => Number.isFinite(point.y));

  const n = points.length;
  if (n < 2) {
    return 0;
  }

  const meanX = mean(points.map((point) => point.x));
  const meanY = mean(points.map((point) => point.y));
  const covariance = sum(points.map((point) => (point.x - meanX) * (point.y - meanY)));
  const variance = sum(points.map((point) => (point.x - meanX) ** 2));

  return variance === 0 ? 0 : covariance / variance;
}

/**
 * Run the detector over one syndrome's history at one facility.
 *
 * The whole history is walked rather than only the last day, because the
 * question a district officer asks is "when did this start", and a detector that
 * only reports today cannot answer it. The result carries the per-day
 * diagnostics so the trajectory can be plotted without re-running the test.
 */
export function detectSurge(series: SyndromeSeries, options: SurgeOptions = {}): SurgeDetection {
  const config = { ...DEFAULTS, ...options };
  const { syndrome, days } = series;
  const reasons: string[] = [];
  const last = days[days.length - 1]?.on ?? '1970-01-01';

  if (days.length < config.minimumHistoryDays) {
    return {
      syndrome,
      detected: false,
      method: 'cusum',
      detectedOn: last,
      growthRate: 0,
      baselineCaseCount: 0,
      observedCaseCount: 0,
      excessCasesPerDay: 0,
      windowDays: 0,
      diagnostics: [],
      reasons: [
        `${String(days.length)} days of history, and ${String(
          config.minimumHistoryDays,
        )} are needed before a pattern can be judged`,
      ],
    };
  }

  const pattern = fitReportingPattern(days, config);
  const adjusted = days.map((day) => adjustedCount(day, pattern));

  const decay = Math.log(2) / config.ewmaHalfLifeDays;
  const diagnostics: SurgeDayDiagnostic[] = [];

  /**
   * What the pattern alone predicted for each day, de-noised.
   *
   * This, and not a trailing average of what actually happened, is what the
   * detector measures against — and the distinction is the whole detector. A
   * trailing average chases an outbreak upward, so the gap between the count and
   * its own smoothed past stays small and accumulates to nothing; the test would
   * cross only once the epidemic had already levelled off, reporting both the
   * wrong day and a growth rate near zero.
   */
  const expectedOf = (day: DateOnly): number =>
    pattern.overallMean *
    (pattern.weekday[weekdayOf(day)] ?? 1) *
    (pattern.month[monthOf(day) - 1] ?? 1);

  const excesses = days.map((day) => day.caseCount - expectedOf(day.on));

  let level = 0;
  let cusum = 0;
  /** Index of the most recent crossing: when the run now in progress began. */
  let crossingIndex = -1;
  /**
   * Whether the test may signal again.
   *
   * A reset-on-signal CUSUM that re-signals freely on a large excess would walk
   * its crossing date forward every day of the outbreak, so the recorded start
   * of the run would be its most recent day and the growth rate estimated over a
   * single point would be zero. The test is therefore re-armed only once it has
   * returned to zero, which happens when the excess stops being sustained — and
   * that is the honest statement of what "a new run" means.
   */
  let armed = true;

  for (const [index, day] of days.entries()) {
    const excess = excesses[index] ?? 0;
    // The responsive level: an exponentially weighted view of how far ahead of
    // the pattern the facility now is. Short-lived by construction, because a
    // half-life is what makes it react to a change within a week.
    level = level * (1 - decay) + excess * decay;

    // The spread is measured on the baseline window only, and it is a *robust*
    // spread: a mean square deviation over a window that includes the surge
    // grows with the surge, which shrinks every standardised value the test is
    // measured against and lets the outbreak hide inside its own variance. The
    // median absolute deviation is unmoved by up to half the window being
    // contaminated, and the 1.4826 makes it comparable with a standard deviation
    // on a normal series.
    const baselineStart = Math.max(0, index - config.baselineWindowDays);
    const baseline = excesses.slice(baselineStart, index);
    const baselineLevel = median(baseline);
    const deviation = 1.4826 * median(baseline.map((point) => Math.abs(point - baselineLevel)));
    // A floor on the spread: a perfectly steady series would divide by zero and
    // every subsequent counting error would read as infinite.
    const scale = Math.max(1, deviation);

    cusum = Math.max(0, cusum + excess / scale - config.cusumSlack);

    // Reset on a signal rather than latching, so the test reports when the run
    // *now* in progress began instead of the first one it ever saw. An outbreak
    // that starts after a false alarm is a different outbreak, and a detector
    // that latched would report the wrong date for it. This is the standard
    // reset-on-signal form of the test.
    if (cusum === 0) {
      armed = true;
    } else if (armed && cusum > config.cusumThreshold && index >= config.minimumHistoryDays) {
      crossingIndex = index;
      cusum = 0;
      armed = false;
    }

    const earsStart = Math.max(0, index - config.earsGuardDays - config.earsWindowDays);
    const earsWindow = excesses.slice(earsStart, Math.max(0, index - config.earsGuardDays));
    const earsMean = mean(earsWindow);
    const earsDeviation = Math.max(
      1,
      Math.sqrt(mean(earsWindow.map((point) => (point - earsMean) ** 2))),
    );

    diagnostics.push({
      on: day.on,
      caseCount: day.caseCount,
      adjusted: adjusted[index] ?? 0,
      level,
      // The value reported is the accumulated evidence before the reset, so a
      // reader sees the crossing rather than the zero it was set to after it.
      cusum: crossingIndex === index ? config.cusumThreshold : cusum,
      ears: (excess - earsMean) / earsDeviation,
      expected: expectedOf(day.on),
    });
  }

  if (crossingIndex < 0) {
    return {
      syndrome,
      detected: false,
      method: 'cusum',
      detectedOn: last,
      growthRate: 0,
      baselineCaseCount: pattern.overallMean,
      observedCaseCount: mean(days.slice(-config.earsWindowDays).map((day) => day.caseCount)),
      excessCasesPerDay: 0,
      windowDays: 0,
      diagnostics,
      reasons: [
        `the accumulating test never crossed ${String(config.cusumThreshold)} standard deviations`,
      ],
    };
  }

  const crossedOn = days[crossingIndex]?.on ?? last;

  // The run that is in progress, from its crossing to the end of the history.
  const run = days.slice(crossingIndex);
  // The growth rate is measured over the rising phase of that run, not over all
  // of it: a surge that trebled in a week and then held steady has grown fast,
  // and averaging over eight flat weeks would call it slow.
  const growthWindow = run.slice(0, Math.max(2, Math.min(run.length, config.initialPhaseDays)));
  const growthRate = exponentialGrowthRate(growthWindow);

  // The excess is measured over the whole run, because "how much more than usual"
  // is a property of the surge rather than of its first fortnight.
  const observedCaseCount = mean(run.map((day) => day.caseCount));
  // Measured day by day against what the pattern predicted, so a run that spans
  // a quiet weekend is not credited with a fall it did not have.
  const baselineCaseCount = mean(run.map((day) => expectedOf(day.on)));
  const excess = mean(run.map((day) => day.caseCount - expectedOf(day.on)));

  if (run.length < config.minimumRunDays) {
    reasons.push(
      `the change was detected ${String(run.length)} days ago, and ${String(
        config.minimumRunDays,
      )} days of it are needed before it can be measured`,
    );
  }
  if (excess < config.minimumExcessCases) {
    reasons.push(
      `the excess is ${excess.toFixed(1)} cases a day, below the ${String(
        config.minimumExcessCases,
      )} worth raising`,
    );
  }

  // The growth rate is **reported, not gated**, and that distinction is
  // deliberate. A district's epidemic may treble over two months or double every
  // week, and the platform has no business deciding that a trebling is not worth
  // an alert because it happened slowly — slow and large is the ordinary shape of
  // a seasonal outbreak, and it is exactly what a district store needs warning
  // about. What is gated is the *evidence*: a run long enough to measure, and an
  // excess over the pattern large enough to act on. Both numbers are returned
  // either way, so a reader can apply a stricter test than this one.
  const detected = reasons.length === 0;

  return {
    syndrome,
    detected,
    method: 'cusum',
    detectedOn: crossedOn,
    growthRate,
    baselineCaseCount,
    observedCaseCount,
    excessCasesPerDay: Math.max(0, excess),
    windowDays: run.length,
    diagnostics,
    reasons: detected ? [] : reasons,
  };
}

export interface EpidemicEventInput {
  readonly facilityId: FacilityId;
  readonly regionId: RegionId;
  readonly districtId: DistrictId | null;
  readonly detection: SurgeDetection;
  readonly synthetic: boolean;
  readonly provenance: EpidemicEvent['provenance'];
  readonly windowDays: number;
}

/**
 * The stored form of a detection, or null when nothing was detected.
 *
 * Null rather than a record with `detected: false`: a non-detection is the
 * absence of an event, and storing one per facility-day would bury the real
 * ones. What *is* recorded is why nothing was raised, on the detection itself,
 * so a reader can tell a quiet district from an unwatched one.
 */
export const epidemicEventOf = (input: EpidemicEventInput): EpidemicEvent | null => {
  const { detection } = input;
  if (!detection.detected) {
    return null;
  }

  return {
    id: `epi:${input.facilityId}:${detection.syndrome}:${detection.detectedOn}`,
    regionId: input.regionId,
    districtId: input.districtId,
    syndrome: detection.syndrome,
    growthRate: detection.growthRate,
    detectedOn: detection.detectedOn,
    windowDays: input.windowDays,
    baselineCaseCount: detection.baselineCaseCount,
    observedCaseCount: detection.observedCaseCount,
    method: detection.method,
    synthetic: input.synthetic,
    provenance: input.provenance,
  };
};

/** Days between two days, for callers that want the horizon expressed in days. */
export const horizonDaysBetween = (from: DateOnly, to: DateOnly): number =>
  Math.max(0, daysBetween(from, to));

/** The day the platform should treat a detection as covering, inclusive. */
export const surgeWindowFrom = (detection: SurgeDetection, days: number): DateOnly =>
  addDays(detection.detectedOn, -(days - 1));
